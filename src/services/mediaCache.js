// --- START OF FILE src/services/mediaCache.js ---
import { Directory, File, Paths } from 'expo-file-system';

/**
 * 🗄️ 媒体沙盒（Local-First 物理落盘层）
 *
 * 目标：让照片 / 视频 / 语音条在**完全断网**时也能 100% 从本地 `file://` 读取，
 *      绝不依赖网络、绝不黑屏、绝不卡死。
 *
 * 目录结构（全部位于 documentDirectory 下，系统不会自动清理）：
 *   ${documentDirectory}chat_media/
 *     ├── audio/  <msgId>.m4a
 *     ├── image/  <msgId>.jpg
 *     ├── video/  <msgId>.mp4
 *     └── thumb/  <msgId>.jpg
 *
 * ⚠️ 铁律：
 *   1. 本文件只做文件系统 IO，绝不发起任何 Supabase / 网络业务请求。
 *   2. **不设任何自动清理上限**：媒体永久落盘，保证用户离线时可回看任意历史媒体。
 *      仅导出 clearMediaCache() 供【设置 → 存储空间】手动清理时调用。
 *   3. 所有函数都自带 try/catch，失败返回 null / false，绝不向调用方抛错，
 *      避免因为磁盘异常导致聊天界面崩溃。
 *
 * 📌 expo-file-system SDK 58 标准 API：
 *   - `new File(Paths.document, 'chat_media', 'audio', 'x.m4a')`
 *   - `file.exists` / `file.size` / `file.uri`（同步属性）
 *   - `file.copy(dest, { overwrite })` / `file.delete()` / `file.create({ intermediates })`
 *   - `new Directory(...).create({ intermediates: true })`
 *   - `File.downloadFileAsync(url, dest, { idempotent: true })`
 */

/** 沙盒根目录名 */
const SANDBOX_DIR_NAME = 'chat_media';

/** 支持的媒体种类 → 子目录名 */
const KIND_DIRS = {
  audio: 'audio',
  image: 'image',
  video: 'video',
  thumb: 'thumb',
};

/** 各类型默认扩展名（无法从 uri 推断时兜底） */
const DEFAULT_EXT = {
  audio: 'm4a',
  image: 'jpg',
  video: 'mp4',
  thumb: 'jpg',
};

/** 内存索引：msgId -> { kind -> file:// uri }，用于同步读取（第 0 帧渲染） */
const memoryIndex = new Map();

/** 目录创建标记，避免重复 create 抛错 */
const ensuredDirs = new Set();

/** 归一化 kind，非法值回落到 image */
const normalizeKind = (kind) => (KIND_DIRS[kind] ? kind : 'image');

/**
 * 🔧 双端本地 URI 判定（iOS + Android 通用）。
 *
 * 覆盖：
 *   - `file:///...`（iOS 沙盒 / Android 沙盒）
 *   - `content://...`（Android 相册选图 / MediaStore）
 *   - `data:...`（base64 内联）
 *   - `ph://...` / `assets-library://...`（iOS 相册原生句柄）
 *
 * @param {*} uri
 * @returns {boolean}
 */
export const isLocalUri = (uri) =>
  typeof uri === 'string' && /^(file|content|data|ph|assets-library):/i.test(uri);

/**
 * 🔧 路径规范化（Android 全屏空白的关键修复）。
 *
 * 问题：Android 上 `Paths.document` / `FileSystem.documentDirectory` 本身已带
 *      `file:///` 前缀。若业务代码再拼一次 `file://${dir}`，就会得到
 *      `file://file:///data/user/0/...` 这种**重复前缀**。
 *      iOS 的加载器能容忍，但 Android 原生 Glide / ExpoImage 会直接报错返回空白。
 *
 * 处理规则：
 *   1. 非字符串 / 空 → null
 *   2. 网络协议（http/https/blob）→ 原样返回，绝不改写
 *   3. `content://` / `data:` / `ph://` / `assets-library://` → 原样返回（Android/iOS 原生可直接加载）
 *   4. 其余（file:// 或裸绝对路径）→ 擦除所有重复 `file:` 前缀，收敛为单重 `file:///...`
 *
 * ⚠️ iOS 兼容性保证：iOS 正常路径 `file:///var/mobile/...` 经本函数处理后
 *    输出**完全一致**（`file://` + `/var/mobile/...`），不会产生任何行为变化。
 *
 * @param {*} path
 * @returns {string|null}
 */
export const normalizeFileUri = (path) => {
  if (!path || typeof path !== 'string') return null;

  const trimmed = path.trim();
  if (!trimmed) return null;

  // 网络 / blob / Android content / base64 / iOS 相册句柄 → 原样返回
  if (/^(https?|blob|content|data|ph|assets-library):/i.test(trimmed)) {
    return trimmed;
  }

  // 擦除任意层级的重复 file: 前缀（file://file:///x → /x）
  const cleanPath = trimmed.replace(/^(file:\/*)+/i, '/');

  // 收敛多余斜杠：仅处理路径起始处的 `//`（保留 `file://` 语义）
  const collapsed = cleanPath.replace(/^\/{2,}/, '/');

  // 保证绝对路径以单斜杠开头
  const absolute = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;

  return `file://${absolute}`;
};

/** 内存索引 key */
const indexKey = (msgId, kind) => `${normalizeKind(kind)}:${msgId}`;

/**
 * 从 uri 中推断扩展名（剥离 query / hash）。
 * @param {string} uri
 * @param {string} fallback
 * @returns {string}
 */
const inferExt = (uri, fallback) => {
  if (typeof uri !== 'string') return fallback;
  const clean = uri.split('?')[0].split('#')[0];
  const last = clean.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return fallback;
  const ext = last.slice(dot + 1).toLowerCase();
  if (!ext || ext.length > 5 || !/^[a-z0-9]+$/.test(ext)) return fallback;
  return ext;
};

/**
 * 确保沙盒子目录存在（幂等，失败静默）。
 *
 * 🚨 iOS 关键修复：`File.copy()` 在目标父目录不存在时会直接抛错
 *    （"The folder doesn't exist"），导致发送时媒体根本没有落盘，
 *    表现为「有网能看（走网络重下）、断网全屏空白」。
 *    因此这里必须**显式逐级创建** `chat_media/` 与 `chat_media/<kind>/`，
 *    并在创建后**二次校验** `exists`，只有确认存在才返回目录对象。
 *
 * @param {string} kind
 * @returns {Directory|null} 确认存在的目录；创建失败返回 null
 */
const ensureDir = (kind) => {
  const safeKind = normalizeKind(kind);

  // 已确认创建过 → 直接返回（但仍做一次轻量 exists 校验，防止被系统清理）
  if (ensuredDirs.has(safeKind)) {
    const cached = new Directory(Paths.document, SANDBOX_DIR_NAME, KIND_DIRS[safeKind]);
    if (cached.exists) return cached;
    ensuredDirs.delete(safeKind);
  }

  try {
    // ① 先确保根目录 chat_media/ 存在（intermediates 会一并创建 documentDirectory 下的层级）
    const root = new Directory(Paths.document, SANDBOX_DIR_NAME);
    if (!root.exists) {
      root.create({ intermediates: true, idempotent: true });
    }

    // ② 再确保子目录 chat_media/<kind>/ 存在
    const dir = new Directory(Paths.document, SANDBOX_DIR_NAME, KIND_DIRS[safeKind]);
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }

    // ③ 创建后二次校验：只有真的存在才认为成功（iOS 上 create 可能静默失败）
    if (!dir.exists) {
      console.warn('⚠️ 媒体沙盒目录创建后仍不存在:', dir.uri);
      return null;
    }

    ensuredDirs.add(safeKind);
    return dir;
  } catch (e) {
    // ④ 兜底重试一次（部分 iOS 机型首次 create 会因沙盒初始化竞态失败）
    try {
      const retryDir = new Directory(Paths.document, SANDBOX_DIR_NAME, KIND_DIRS[safeKind]);
      retryDir.create({ intermediates: true, idempotent: true });
      if (retryDir.exists) {
        ensuredDirs.add(safeKind);
        return retryDir;
      }
    } catch (retryErr) {
      console.warn('⚠️ 创建媒体沙盒目录失败(重试亦失败):', safeKind, retryErr?.message ?? retryErr);
    }
    console.warn('⚠️ 创建媒体沙盒目录失败:', safeKind, e?.message ?? e);
    return null;
  }
};

/**
 * 构造某条消息在沙盒中的目标文件（不保证存在）。
 * @param {string} msgId
 * @param {string} kind
 * @param {string} [ext] 指定扩展名；不传则用默认扩展名
 * @returns {File|null}
 */
const buildTargetFile = (msgId, kind, ext) => {
  const safeKind = normalizeKind(kind);
  const dir = ensureDir(safeKind);
  if (!dir) return null;
  const safeExt = ext || DEFAULT_EXT[safeKind];
  return new File(dir, `${msgId}.${safeExt}`);
};

/**
 * 把本地文件（录音临时文件 / 相册临时文件）永久复制进沙盒。
 *
 * 🚨 iOS 关键修复（断网全屏空白的根因）：
 *    `File.copy()` 在目标父目录不存在时会抛错，导致发送时媒体**根本没有落盘**。
 *    有网时全屏能看是因为走网络重新下载了云端文件；断网时本地无文件 → 全屏空白。
 *    因此这里在 copy 之前**强制**调用 ensureDir 显式创建 `chat_media/<kind>/`，
 *    并在 copy 之后**校验目标文件真实存在且 size > 0**，只有确认成功才返回路径。
 *
 * @param {string} uri 源文件 uri（file:// / content:// / ph:// 等）
 * @param {string} msgId 消息 ID（作为沙盒文件名）
 * @param {'audio'|'image'|'video'|'thumb'} kind 媒体种类
 * @returns {Promise<string|null>} 沙盒内永久 `file://` 路径；失败返回 null
 */
export async function persistMedia(uri, msgId, kind) {
  if (!uri || !msgId) return null;
  const safeKind = normalizeKind(kind);

  // 🔧 双端路径规范化：擦除重复 file:// 前缀（Android Glide 遇重复前缀直接空白）
  const fromUri = normalizeFileUri(uri);
  if (!fromUri) return null;

  try {
    const ext = inferExt(fromUri, DEFAULT_EXT[safeKind]);

    // ① 强制确保目标子目录存在（copy 的前置硬条件，iOS 上缺目录必抛错）
    const dir = ensureDir(safeKind);
    if (!dir) {
      console.warn('⚠️ 媒体落盘中止：沙盒目录不可用', safeKind);
      return null;
    }

    const target = new File(dir, `${msgId}.${ext}`);

    // ② 已存在且非空（重复调用 / 重发）→ 直接复用，避免重复拷贝
    if (target.exists && target.size > 0) {
      const reused = normalizeFileUri(target.uri);
      memoryIndex.set(indexKey(msgId, safeKind), reused);
      return reused;
    }

    // ③ 校验源文件（Android content:// 亦可被 new File() 直接寻址）
    let source = null;
    try {
      source = new File(fromUri);
    } catch (srcErr) {
      console.warn('⚠️ 媒体源路径无法寻址，回退原始路径:', fromUri, srcErr?.message ?? srcErr);
      return fromUri;
    }

    if (!source.exists) {
      // 源文件不存在（ph:// 原生句柄 / 部分 content:// 无法直接寻址）
      // → 回退返回原始路径：content:// 在 Android 上本身就是有效可加载路径
      console.warn('⚠️ 媒体源文件不存在，回退原始路径:', fromUri);
      return fromUri;
    }

    // ④ 执行拷贝（overwrite 允许覆盖之前可能残留的 0 字节文件）
    await source.copy(target, { overwrite: true });

    // ⑤ 拷贝后二次校验：文件必须真实存在且 size > 0
    if (!target.exists) {
      console.warn('⚠️ 媒体落盘失败：拷贝后目标文件不存在，回退原始路径', target.uri);
      return fromUri;
    }
    if (!(target.size > 0)) {
      console.warn('⚠️ 媒体落盘失败：拷贝后目标文件为空，回退原始路径', target.uri, 'size=', target.size);
      return fromUri;
    }

    const finalUri = normalizeFileUri(target.uri);
    memoryIndex.set(indexKey(msgId, safeKind), finalUri);
    return finalUri;
  } catch (e) {
    // 🚨 拷贝失败降级：content:// 在 Android 上本身有效，直接回退原始路径保证可显示
    console.warn('⚠️ 媒体落盘失败，回退原始路径:', safeKind, 'uri=', fromUri, 'err=', e?.message ?? e);
    return fromUri;
  }
}

/**
 * 探测沙盒中是否已存在该消息的本地物理文件。
 *
 * @param {string} msgId
 * @param {'audio'|'image'|'video'|'thumb'} kind
 * @returns {Promise<string|null>} 存在则返回 `file://` 路径，否则 null
 */
export async function resolveLocalMedia(msgId, kind) {
  if (!msgId) return null;
  const safeKind = normalizeKind(kind);

  // 1️⃣ 内存索引优先（0 毫秒）
  const cached = memoryIndex.get(indexKey(msgId, safeKind));
  if (cached) {
    const normalizedCached = normalizeFileUri(cached);
    try {
      if (normalizedCached && new File(normalizedCached).exists) return normalizedCached;
    } catch (_) {}
    memoryIndex.delete(indexKey(msgId, safeKind));
  }

  // 2️⃣ 磁盘探测（遍历该类型目录下所有扩展名）
  try {
    const dir = ensureDir(safeKind);
    if (!dir || !dir.exists) return null;
    const entries = dir.list();
    const prefix = `${msgId}.`;
    for (const entry of entries) {
      if (entry instanceof File && entry.name && entry.name.startsWith(prefix)) {
        if (entry.exists) {
          // 🔧 统一规范化：确保返回单重 file:/// 前缀（Android Glide 必需）
          const normalized = normalizeFileUri(entry.uri);
          if (!normalized) continue;
          memoryIndex.set(indexKey(msgId, safeKind), normalized);
          return normalized;
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ 探测本地媒体失败:', safeKind, e?.message ?? e);
  }
  return null;
}

/**
 * ⚡ 同步读取内存索引中的本地媒体路径（供第 0 帧渲染使用）。
 * 只查内存，不碰磁盘，绝不阻塞渲染。
 *
 * @param {string} msgId
 * @param {'audio'|'image'|'video'|'thumb'} kind
 * @returns {string|null}
 */
export function getMemoryLocalMedia(msgId, kind) {
  if (!msgId) return null;
  const raw = memoryIndex.get(indexKey(msgId, kind));
  if (!raw) return null;
  // 🔧 统一规范化：保证第 0 帧拿到的也是单重 file:/// 路径
  return normalizeFileUri(raw);
}

/**
 * 静默把云端媒体下载到沙盒（后台运行，供下次离线使用）。
 *
 * 行为：
 *   - 沙盒已有该消息文件 → 直接返回，不重复下载
 *   - 网络失败 / 超时 → 返回 null，绝不抛错、绝不影响 UI
 *
 * @param {string} remoteUrl 可下载的远程地址（签名 URL / 公开 URL）
 * @param {string} msgId 消息 ID
 * @param {'audio'|'image'|'video'|'thumb'} kind 媒体种类
 * @returns {Promise<string|null>} 沙盒内 `file://` 路径；失败返回 null
 */
export async function downloadToSandbox(remoteUrl, msgId, kind) {
  if (!remoteUrl || !msgId) return null;
  const safeKind = normalizeKind(kind);

  // 已是本地文件（file:// / content:// / ph:// / assets-library://）→ 直接落盘复用
  if (isLocalUri(remoteUrl)) {
    return persistMedia(remoteUrl, msgId, safeKind);
  }
  if (!/^https?:\/\//i.test(remoteUrl)) return null;

  try {
    const existing = await resolveLocalMedia(msgId, safeKind);
    if (existing) return existing;

    const ext = inferExt(remoteUrl, DEFAULT_EXT[safeKind]);
    const target = buildTargetFile(msgId, safeKind, ext);
    if (!target) return null;

    const downloaded = await File.downloadFileAsync(remoteUrl, target, { idempotent: true });
    // 🔧 统一规范化：下载完成后的路径也必须是单重 file:/// 前缀
    const finalUri = normalizeFileUri(downloaded?.uri || target.uri);
    if (!finalUri) return null;

    memoryIndex.set(indexKey(msgId, safeKind), finalUri);
    return finalUri;
  } catch (e) {
    // 🚨 离线降级：下载失败只记录日志，绝不抛错、绝不清空已有本地文件
    console.warn('⚠️ 媒体静默下载失败(可能处于离线):', safeKind, e?.message ?? e);
    return null;
  }
}

/**
 * 统计沙盒占用（供【设置 → 存储空间】展示）。
 *
 * @returns {Promise<{ totalBytes: number, fileCount: number }>}
 */
export async function getMediaCacheSize() {
  let totalBytes = 0;
  let fileCount = 0;
  try {
    const root = new Directory(Paths.document, SANDBOX_DIR_NAME);
    if (!root.exists) return { totalBytes: 0, fileCount: 0 };
    const walk = (dir) => {
      let entries = [];
      try {
        entries = dir.list();
      } catch (_) {
        return;
      }
      for (const entry of entries) {
        if (entry instanceof Directory) {
          walk(entry);
        } else if (entry instanceof File) {
          fileCount += 1;
          totalBytes += typeof entry.size === 'number' ? entry.size : 0;
        }
      }
    };
    walk(root);
  } catch (e) {
    console.warn('⚠️ 统计媒体沙盒占用失败:', e?.message ?? e);
  }
  return { totalBytes, fileCount };
}

/**
 * 🧹 手动清理沙盒（**仅供用户在设置页主动点击时调用**）。
 *
 * ⚠️ 绝不在后台自动触发！媒体默认永久落盘，保证离线可回看任意历史媒体。
 *
 * @returns {Promise<{ ok: boolean, removedBytes: number, removedFiles: number }>}
 */
export async function clearMediaCache() {
  const before = await getMediaCacheSize();
  try {
    const root = new Directory(Paths.document, SANDBOX_DIR_NAME);
    if (root.exists) {
      root.delete();
    }
    memoryIndex.clear();
    ensuredDirs.clear();
    return { ok: true, removedBytes: before.totalBytes, removedFiles: before.fileCount };
  } catch (e) {
    console.warn('⚠️ 清理媒体沙盒失败:', e?.message ?? e);
    return { ok: false, removedBytes: 0, removedFiles: 0 };
  }
}

export default {
  isLocalUri,
  normalizeFileUri,
  persistMedia,
  resolveLocalMedia,
  getMemoryLocalMedia,
  downloadToSandbox,
  getMediaCacheSize,
  clearMediaCache,
};
// --- END OF FILE src/services/mediaCache.js ---
