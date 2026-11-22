// --- START OF FILE src/services/mediaCache.js ---
import * as FileSystem from 'expo-file-system/legacy'; // ⚡ 核心修复：直接使用官方稳定的 legacy API，消灭警告且 100% 稳定下载！
import AsyncStorage from '@react-native-async-storage/async-storage';

const MEDIA_ROOT = `${FileSystem.documentDirectory}chat_media/`;
const INDEX_KEY = '@media_file_index';

const KIND_DIRS = {
  audio: 'audio',
  image: 'image',
  video: 'video',
  thumb: 'thumb',
};

const DEFAULT_EXT = {
  audio: 'm4a',
  image: 'jpg',
  video: 'mp4',
  thumb: 'jpg',
};

// ============================================================================
// 🔐 B2 · 媒体缓存身份归属与异步生命周期（统一契约 · 第 2 轮）
//
// 设计原则（务必与 useSignedMediaUrl 的 owner/epoch 语义对齐，但用途不同）：
//
//  1) 「账号归属」与「请求代际」严格分离
//     - ownership（ownerId）：决定「这份缓存属于谁、谁能读」。
//     - generation（epoch）：只用于「拒绝迟到的异步写回」，**绝不**进入持久化
//       文件路径或索引键。否则同账号重新登录后合法离线缓存会全部失效。
//
//  2) 【核心】物理存储按 owner 分区：`chat_media/<ownerId>/<kind>/<msgId>.<ext>`
//     - 归属下沉到物理路径，不再依赖「旁注 + 索引」这类可缺失的旁路证据。
//     - 不同账号物理路径不同 → 不可能互相覆盖、不可能错误共享。
//     - owner 是稳定账号标识（非 epoch）→ 同账号重登路径不变，离线缓存天然复用。
//     - 未登录（ownerId === null）→ 无分区目录，**拒绝一切写入**（fail-closed）。
//
//  3) 索引条目格式：`kind:msgId` -> `{ uri, ownerId }`，ownerId 必须非空。
//     - 旧格式纯字符串条目（归属未知）→ **不返回给任何人**，标记 legacy 隔离保留。
//     - 无旁注 / 无分区目录的历史文件（归属未知）→ **不认领**，保留在磁盘待重新获取。
//     - 诚实记录：归属未知的历史缓存无法同时满足「任意账号可读」与「严格隔离」，
//       本实现优先保证隔离，历史缓存需重新验证或重新下载。
//
//  4) 所有读写路径统一在**最后一次 await 之后**复检身份（owner + epoch），
//     避免「校验通过 → await 期间切号 → 仍返回/写入」的竞态。
//
//  5) 【第 3 轮】「过期请求的最终提交与结果返回」统一收口：
//     - 下载先落临时文件（含 epoch），**提交前**复检身份；
//     - 身份失效 → 不写最终文件、不写索引、**返回 null**（绝不把旧账号私有
//       URI 交给新会话）；
//     - 同账号同目标（同 owner + 同 kind:msgId）的最终提交**串行化**，
//       旧代际即使迟到完成，也不得覆盖新代际已写入的最终文件；
//     - persistMedia 走同一原则：身份失效返回 null，不返回旧 URI。
// ============================================================================

let mediaIndex = {};
let indexLoaded = false;
const ensuredDirs = new Set();

let currentOwnerId = null;
let currentEpoch = 0;

/**
 * 登记当前媒体缓存身份（由 AuthProvider 在身份变化时调用）。
 * 语义与 setSignedUrlOwner 对齐：owner 变化或 forceBump 时自增 epoch。
 * @param {string|null} ownerId
 * @param {boolean} [forceBump=false]
 * @returns {number} 新的 epoch
 */
export function setMediaCacheOwner(ownerId, forceBump = false) {
  const next = ownerId ?? null;
  if (next !== currentOwnerId || forceBump) {
    currentOwnerId = next;
    currentEpoch += 1;
  }
  return currentEpoch;
}

/** 读取当前媒体缓存身份快照（供写入发起时捕获） */
export function getMediaCacheIdentity() {
  return { ownerId: currentOwnerId, epoch: currentEpoch };
}

/** 判断某次写入发起时的身份是否仍然有效（owner + epoch 双校验） */
function isMediaIdentityValid(ownerId, epoch) {
  return currentOwnerId === ownerId && currentEpoch === epoch;
}

/**
 * 读取授权：某索引条目是否可被「当前身份」使用。
 * - 未登录：一律拒绝（fail-closed）。
 * - 旧格式纯字符串条目（归属未知）：**一律拒绝**，不认领（优先保证隔离）。
 * - 条目 ownerId 为空（归属未知）：**一律拒绝**，不认领。
 * - 条目有主：必须与当前 owner 一致。
 * 注意：**不比对 epoch**，保证同账号重新登录后合法离线缓存仍可复用。
 */
function canAccess(entry) {
  if (!currentOwnerId) return false;
  if (!entry || typeof entry === 'string') return false; // 归属未知 → 拒绝
  const entryOwner = entry.ownerId ?? null;
  if (!entryOwner) return false; // 归属未知 → 拒绝
  return entryOwner === currentOwnerId;
}

/** 从索引条目中取出 uri（仅接受带 owner 的对象条目） */
function entryUri(entry) {
  if (!entry || typeof entry === 'string') return null;
  return entry.uri || null;
}

// ---------------------------------------------------------------------------
// 🗂️ 按 owner 分区的物理路径（第 2 轮核心）
//
// 归属下沉到物理路径：`chat_media/<ownerId>/<kind>/<msgId>.<ext>`
//   - 不同账号路径不同 → 不可能覆盖、不可能错误共享。
//   - owner 是稳定账号标识（非 epoch）→ 同账号重登路径不变，离线缓存复用。
//   - 未登录 → 无分区目录，拒绝写入。
//
// 历史遗留的旧布局 `chat_media/<kind>/<msgId>.<ext>`（无 owner 分区）归属未知，
// 本实现**不认领、不删除**，保留在磁盘待重新获取；仅在扫描时跳过。
// ---------------------------------------------------------------------------
const ownerRoot = (ownerId) => `${MEDIA_ROOT}${ownerId}/`;

/** 校验某 uri 是否位于指定 owner 的分区目录内（防越权写入/读取） */
const isUriOwnedBy = (uri, ownerId) => {
  if (!uri || !ownerId) return false;
  const normalized = normalizeFileUri(uri);
  if (!normalized) return false;
  return normalized.startsWith(ownerRoot(ownerId));
};

const normalizeKind = (kind) => (KIND_DIRS[kind] ? kind : 'image');
const indexKey = (msgId, kind) => `${normalizeKind(kind)}:${msgId}`;

/**
 * 下载去重键：必须包含 owner + epoch。
 * 不同 owner/epoch 的下载**不得**共享旧会话 Promise（否则 B 会继承 A 的在途请求）。
 */
const inflightKeyOf = (msgId, kind, ownerId, epoch) =>
  `${indexKey(msgId, kind)}::${ownerId ?? 'anon'}::${epoch}`;

/** 下载去重：inflightKey -> Promise */
const downloadInflight = new Map();

// ---------------------------------------------------------------------------
// 🔒 最终提交串行化锁（第 3 轮）
//
// 场景：同账号（同 owner）跨 authEpoch 的两次下载指向**同一最终路径**
//       `chat_media/<owner>/<kind>/<msgId>.<ext>`（最终路径不含 epoch，以保证
//       同账号重登后离线缓存可复用）。若旧代际下载迟到完成，直接 copy 到最终
//       路径会覆盖新代际已写入的正确内容。
//
// 方案：以「最终路径」为键串行化「身份复检 + copy + 索引提交」这一临界区。
//       - 旧代际进入临界区时复检身份失败 → 直接放弃，不触碰最终文件；
//       - 新代际先完成则写入正确内容，旧代际随后被身份闸门拦下，不会覆盖。
// 注意：锁只覆盖最终提交，不覆盖网络下载，避免阻塞正常并发。
// ---------------------------------------------------------------------------
const commitLocks = new Map(); // finalPath -> Promise（队尾）

const withCommitLock = async (finalPath, fn) => {
  const prev = commitLocks.get(finalPath) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const tail = prev.then(() => gate);
  commitLocks.set(finalPath, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // 队尾仍是自己时才清理，避免误删后续排队的锁
    if (commitLocks.get(finalPath) === tail) commitLocks.delete(finalPath);
  }
};

const initIndex = async () => {
  if (indexLoaded) return;
  try {
    const str = await AsyncStorage.getItem(INDEX_KEY);
    if (str) mediaIndex = JSON.parse(str);
    indexLoaded = true;
  } catch (e) {
    indexLoaded = true;
  }
};

const saveIndex = async () => {
  try {
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(mediaIndex));
  } catch (e) {}
};

/**
 * 统一写索引入口（B2 核心）。
 * 在**最后一次 await 之后**复检身份，确保 await 期间切号不会写入无主条目。
 * @param {string} key 索引键
 * @param {string} uri 文件 uri
 * @param {{ownerId: string|null, epoch: number}} snapshot 发起时捕获的身份快照
 * @returns {Promise<boolean>} 是否真正写入
 */
async function commitIndex(key, uri, snapshot) {
  // 未登录 fail-closed：禁止新建私有媒体索引
  if (!snapshot.ownerId) return false;
  await initIndex();
  // ⚠️ 关键：initIndex 内部有 await，此处必须复检身份
  if (!isMediaIdentityValid(snapshot.ownerId, snapshot.epoch)) return false;
  mediaIndex[key] = { uri, ownerId: snapshot.ownerId };
  await saveIndex();
  return true;
}

export const isLocalUri = (uri) => typeof uri === 'string' && /^(file|content|data|ph|assets-library):/i.test(uri);

export const normalizeFileUri = (path) => {
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^(https?|blob|content|data|ph|assets-library):/i.test(trimmed)) return trimmed;
  
  const cleanPath = trimmed.replace(/^(file:\/*)+/i, '/');
  const collapsed = cleanPath.replace(/^\/{2,}/, '/');
  const absolute = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
  return `file://${absolute}`;
}

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

// ⚡ 按 owner 分区的目录创建：`chat_media/<ownerId>/<kind>/`
//    未登录（ownerId 为空）返回 null，调用方必须 fail-closed。
const ensureDir = async (kind, ownerId) => {
  if (!ownerId) return null;
  const safeKind = normalizeKind(kind);
  const dirPath = `${ownerRoot(ownerId)}${KIND_DIRS[safeKind]}/`;
  const cacheKey = `${ownerId}::${safeKind}`;

  if (ensuredDirs.has(cacheKey)) return dirPath;

  try {
    const rootInfo = await FileSystem.getInfoAsync(MEDIA_ROOT);
    if (!rootInfo.exists) {
      await FileSystem.makeDirectoryAsync(MEDIA_ROOT, { intermediates: true });
    }

    const ownerInfo = await FileSystem.getInfoAsync(ownerRoot(ownerId));
    if (!ownerInfo.exists) {
      await FileSystem.makeDirectoryAsync(ownerRoot(ownerId), { intermediates: true });
    }

    const dirInfo = await FileSystem.getInfoAsync(dirPath);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
    }

    ensuredDirs.add(cacheKey);
    return dirPath;
  } catch (e) {
    console.warn('创建沙盒目录失败:', e);
    return dirPath;
  }
};

export async function persistMedia(uri, msgId, kind) {
  if (!uri || !msgId) return null;
  const safeKind = normalizeKind(kind);
  const fromUri = normalizeFileUri(uri);
  if (!fromUri) return null;

  // 📸 捕获发起时的身份快照（B2：迟到写回闸门）
  const snapshot = getMediaCacheIdentity();
  // 🔐 未登录 fail-closed：不创建任何私有媒体文件/索引
  if (!snapshot.ownerId) return null;

  try {
    const ext = inferExt(fromUri, DEFAULT_EXT[safeKind]);
    const targetDir = await ensureDir(safeKind, snapshot.ownerId);
    if (!targetDir) return null;
    const targetPath = `${targetDir}${msgId}.${ext}`;
    const finalUri = normalizeFileUri(targetPath);
    const key = indexKey(msgId, safeKind);

    // 🔒 最终提交串行化：同 owner 同目标并发写入互不覆盖
    return await withCommitLock(targetPath, async () => {
      // ⚠️ 进入临界区后（可能已排队等待）必须复检身份：
      //    身份失效 → 不写最终文件、不写索引、返回 null（绝不交出旧账号 URI）
      if (!isMediaIdentityValid(snapshot.ownerId, snapshot.epoch)) return null;

      const targetInfo = await FileSystem.getInfoAsync(targetPath);
      if (targetInfo.exists && targetInfo.size > 0) {
        // 已有合法文件：复用（仍走统一写索引入口做末次身份复检）
        const committed = await commitIndex(key, finalUri, snapshot);
        return committed ? finalUri : null;
      }

      // ⚡ 绝对可靠的原生 Copy
      await FileSystem.copyAsync({ from: fromUri, to: targetPath });

      const verifyInfo = await FileSystem.getInfoAsync(targetPath);
      if (!verifyInfo.exists || verifyInfo.size === 0) {
        // 落盘失败：仅当身份仍有效时才回退到源 uri，否则 fail-closed
        return isMediaIdentityValid(snapshot.ownerId, snapshot.epoch) ? fromUri : null;
      }

      // 🛡️ 统一写索引入口（含末次 await 后身份复检）
      const committed = await commitIndex(key, finalUri, snapshot);
      // 身份失效 → 不返回任何 URI（避免旧账号路径泄漏到新会话）
      return committed ? finalUri : null;
    });
  } catch (e) {
    console.warn('持久化媒体异常:', e);
    // 异常路径同样 fail-closed：身份失效不得回退返回旧 uri
    return isMediaIdentityValid(snapshot.ownerId, snapshot.epoch) ? fromUri : null;
  }
}

export async function resolveLocalMedia(msgId, kind) {
  if (!msgId) return null;
  const safeKind = normalizeKind(kind);
  const key = indexKey(msgId, safeKind);

  // 📸 捕获发起时的身份快照（读取同样需要末次 await 后复检）
  const snapshot = getMediaCacheIdentity();
  if (!snapshot.ownerId) return null;

  await initIndex();
  const cached = mediaIndex[key];
  // 🔐 读取授权：条目必须属于当前身份（未登录 / 归属未知一律拒绝）
  if (cached && canAccess(cached)) {
    const uri = entryUri(cached);
    // 🔐 物理路径必须位于当前 owner 分区内（防索引被篡改后越权读取）
    if (uri && isUriOwnedBy(uri, snapshot.ownerId)) {
      try {
        const info = await FileSystem.getInfoAsync(uri);
        // ⚠️ 关键：getInfoAsync 期间可能切号，返回前必须复检身份
        if (!isMediaIdentityValid(snapshot.ownerId, snapshot.epoch)) return null;
        if (info.exists) return uri;
      } catch (_) {
        if (!isMediaIdentityValid(snapshot.ownerId, snapshot.epoch)) return null;
      }
    }
    // 条目失效：仅当仍属当前身份时才清理，避免误删他人条目
    if (isMediaIdentityValid(snapshot.ownerId, snapshot.epoch)) {
      delete mediaIndex[key];
      await saveIndex();
    }
  }

  // 🔐 目录扫描回退：仅在已登录时进行，且只扫描当前 owner 的分区目录。
  //    旧布局（无 owner 分区）归属未知，**不扫描、不认领、不删除**。
  if (!currentOwnerId) return null;

  try {
    const targetDir = await ensureDir(safeKind, snapshot.ownerId);
    if (!targetDir) return null;
    const dirInfo = await FileSystem.getInfoAsync(targetDir);
    if (!dirInfo.exists) return null;

    const entries = await FileSystem.readDirectoryAsync(targetDir);
    const prefix = `${msgId}.`;
    for (const file of entries) {
      // 跳过临时下载文件（`.tmp-`）与旁注文件（`.owner`）
      if (file.startsWith('.tmp-') || file.endsWith('.owner')) continue;
      if (file.startsWith(prefix)) {
        const fullPath = `${targetDir}${file}`;
        const normalized = normalizeFileUri(fullPath);
        if (!normalized) continue;
        // 🔐 物理路径必须位于当前 owner 分区内
        if (!isUriOwnedBy(normalized, snapshot.ownerId)) continue;
        // 扫描回退同样走统一写索引入口（带发起时身份快照，内部末次 await 后复检）
        const committed = await commitIndex(key, normalized, snapshot);
        if (!committed) return null;
        return normalized;
      }
    }
  } catch (e) {}
  return null;
}

export function getMemoryLocalMedia(msgId, kind) {
  if (!msgId) return null;
  const entry = mediaIndex[indexKey(msgId, kind)];
  // 🔐 读取授权：不得凭 msgId 直接取到他人私有缓存
  if (!canAccess(entry)) return null;
  const uri = entryUri(entry);
  // 🔐 物理路径必须位于当前 owner 分区内
  if (!isUriOwnedBy(uri, currentOwnerId)) return null;
  return normalizeFileUri(uri);
}

// ⚡ 离线秒开抽水机的命脉：用回最原始的稳定下载方法
export async function downloadToSandbox(remoteUrl, msgId, kind) {
  if (!remoteUrl || typeof remoteUrl !== 'string' || !remoteUrl.startsWith('http')) return null;
  const safeKind = normalizeKind(kind);

  // 📸 捕获发起时的身份快照（B2：迟到写回闸门 + inflight 隔离）
  const snapshot = getMediaCacheIdentity();
  // 🔐 未登录 fail-closed：不下载、不落盘、不写索引
  if (!snapshot.ownerId) return null;
  const inflightKey = inflightKeyOf(msgId, safeKind, snapshot.ownerId, snapshot.epoch);

  // 🔁 并发去重：仅同一 owner+epoch 的并发下载复用同一 Promise
  if (downloadInflight.has(inflightKey)) return downloadInflight.get(inflightKey);

  const task = (async () => {
    let tempPath = null;
    try {
      const existing = await resolveLocalMedia(msgId, safeKind);
      if (existing) return existing;

      const ext = inferExt(remoteUrl, DEFAULT_EXT[safeKind]);
      const targetDir = await ensureDir(safeKind, snapshot.ownerId);
      if (!targetDir) return null;
      const targetPath = `${targetDir}${msgId}.${ext}`;
      // 🧪 临时文件含 epoch：不同代际的下载互不覆盖，提交前再校验身份
      tempPath = `${targetDir}.tmp-${snapshot.epoch}-${msgId}.${ext}`;

      // ⚡ 先下到临时文件，避免迟到下载直接覆盖他人已缓存文件
      const downloaded = await FileSystem.downloadAsync(remoteUrl, tempPath);
      const downloadedUri = normalizeFileUri(downloaded?.uri || tempPath);
      if (!downloadedUri) return null;

      const finalUri = normalizeFileUri(targetPath);
      const key = indexKey(msgId, safeKind);

      // 🔒 最终提交串行化：同 owner 同目标（最终路径不含 epoch）的并发提交互斥，
      //    保证旧代际迟到完成时不会覆盖新代际已写入的最终文件。
      return await withCommitLock(targetPath, async () => {
        // ⚠️ 进入临界区后（可能已排队等待）必须复检身份：
        //    身份失效 → 不写最终文件、不写索引、返回 null
        //    （绝不把旧账号私有 URI 交给新会话）
        if (!isMediaIdentityValid(snapshot.ownerId, snapshot.epoch)) return null;

        // 提交：临时文件 → 最终路径（同 owner 分区内，不会覆盖他人文件）
        await FileSystem.copyAsync({ from: downloadedUri, to: targetPath });
        const verifyInfo = await FileSystem.getInfoAsync(targetPath);
        if (!verifyInfo.exists || verifyInfo.size === 0) return null;

        // 🛡️ 统一写索引入口（内部末次 await 后复检身份；身份失效/未登录则不写索引）
        const committed = await commitIndex(key, finalUri, snapshot);
        // 身份失效 → 不返回任何 URI
        return committed ? finalUri : null;
      });
    } catch (e) {
      console.warn('下载到沙盒失败:', e);
      return null;
    } finally {
      // 🧹 清理临时文件（失败或成功都清理，避免残留）
      if (tempPath) {
        try {
          await FileSystem.deleteAsync(tempPath, { idempotent: true });
        } catch (_) {}
      }
      // 🛡️ 只删除仍属于本 Promise 的 inflight 条目
      if (downloadInflight.get(inflightKey) === task) downloadInflight.delete(inflightKey);
    }
  })();

  downloadInflight.set(inflightKey, task);
  return task;
}

/** 递归统计目录下的文件数与字节数（失败时静默返回 0） */
const measureDir = async (dirPath) => {
  let totalBytes = 0;
  let fileCount = 0;
  const base = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  try {
    const entries = await FileSystem.readDirectoryAsync(base);
    for (const name of entries) {
      const fullPath = `${base}${name}`;
      try {
        // 目录探测需要尾斜杠（不同平台/实现要求不一致，这里两种形式都尝试）
        let info = await FileSystem.getInfoAsync(fullPath, { size: true });
        if (!info?.exists) {
          info = await FileSystem.getInfoAsync(`${fullPath}/`, { size: true });
        }
        if (info?.isDirectory) {
          const sub = await measureDir(`${fullPath}/`);
          totalBytes += sub.totalBytes;
          fileCount += sub.fileCount;
        } else if (info?.exists) {
          totalBytes += Number(info.size) || 0;
          fileCount += 1;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { totalBytes, fileCount };
};

export async function getMediaCacheSize() {
  try {
    const info = await FileSystem.getInfoAsync(MEDIA_ROOT);
    if (!info.exists) return { totalBytes: 0, fileCount: 0 };
    return await measureDir(MEDIA_ROOT);
  } catch (e) {
    return { totalBytes: 0, fileCount: 0 };
  }
}

export async function clearMediaCache() {
  try {
    const info = await FileSystem.getInfoAsync(MEDIA_ROOT);
    if (info.exists) {
      await FileSystem.deleteAsync(MEDIA_ROOT, { idempotent: true });
    }
    mediaIndex = {};
    downloadInflight.clear();
    await AsyncStorage.removeItem(INDEX_KEY);
    ensuredDirs.clear();
    return { ok: true, removedBytes: 0, removedFiles: 0 };
  } catch (e) {
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
  setMediaCacheOwner,
  getMediaCacheIdentity,
};
// --- END OF FILE src/services/mediaCache.js ---
