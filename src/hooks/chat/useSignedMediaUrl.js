// --- START OF FILE src/hooks/chat/useSignedMediaUrl.js ---
import { useEffect, useState } from 'react';
import { supabase } from '../../services/supabase';

/**
 * 🔐 私有媒体签名 URL Hook（P0-2 / P0-3）
 *
 * 背景：
 *   chat_media 桶已私有化，数据库 messages.media_url / thumbnail_url 现在只存
 *   「相对对象路径」（形如 `${user.id}/img_1699999999_123.jpg`），不再存带 7 天
 *   有效期的签名 URL。渲染时按需换取临时签名 URL，因此历史照片永不失效。
 *
 * 职责：
 *   1. toStoragePath(value)  把「相对路径」或「历史签名 URL」统一归一化为对象路径
 *   2. 模块级 LRU 缓存（上限 500 条），跨组件共享，避免重复请求
 *   3. 并发去重：同一路径同时多次请求只发一次 createSignedUrl
 *   4. 提前刷新：缓存有效期 = TTL - 1 天，避免临界过期
 *   5. useSignedMediaUrl(value) 返回 { url, loading }
 *
 * ⚠️ 兼容策略：
 *   历史数据里可能残留完整签名 URL（https://.../object/sign/chat_media/xxx.jpg?token=...）。
 *   这类值直接透传渲染（虽然 7 天后仍会失效，但至少不会崩溃），
 *   同时 toStoragePath 也能从中提取对象路径，供迁移后的新逻辑复用。
 */

const STORAGE_BUCKET = 'chat_media';

/** 签名有效期（秒）：7 天，与 useMediaUpload.SIGNED_URL_TTL 保持一致 */
export const SIGNED_URL_TTL = 60 * 60 * 24 * 7;

/** 缓存提前刷新窗口（毫秒）：提前 1 天刷新，避免临界过期 */
const REFRESH_AHEAD_MS = 60 * 60 * 24 * 1000;

/** LRU 缓存上限 */
const MAX_CACHE_ENTRIES = 500;

/** path -> { url, expiresAt } */
const cache = new Map();

/** path -> Promise<string|null>（并发去重） */
const inflight = new Map();

/**
 * 把「相对路径」或「历史签名 URL」归一化为桶内对象路径。
 *
 * 支持输入：
 *   - `user_id/img_123.jpg`                                     → 原样返回
 *   - `https://xxx.supabase.co/storage/v1/object/sign/chat_media/user_id/img_123.jpg?token=...`
 *                                                               → `user_id/img_123.jpg`
 *   - `https://xxx.supabase.co/storage/v1/object/public/chat_media/user_id/img_123.jpg`
 *                                                               → `user_id/img_123.jpg`
 *   - 空值 / 非法值                                              → null
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function toStoragePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // 🚫 本地文件 URI（file:// / content:// / ph:// / assets-library://）不是桶内对象路径。
  //    乐观发送阶段 mediaUrl 仍是本地 URI，若原样当作 path 去 createSignedUrl，
  //    必然失败并返回 null —— 表现为「刚发出去的图片不显示 / 语音点不动」。
  //    这里显式返回 null，让调用方走「本地直读」分支。
  if (/^(file|content|ph|assets-library|data|blob):/i.test(trimmed)) {
    return null;
  }

  // 已是相对路径（不含协议头）
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // 从签名 / 公开 URL 中提取 chat_media 之后的对象路径（剥离 query / hash）
  const match = trimmed.match(/\/chat_media\/([^?#]+)/i);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return match[1];
  }
}

/** 判断是否为「历史完整 URL」（需要直接透传渲染） */
function isAbsoluteUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * 🌐 公共存储 URL 安全构建（兜底通道）
 *
 * 背景：
 *   私有桶 chat_media 的签名 URL 需要联网 createSignedUrl 才能拿到。
 *   当「签名请求失败 / 尚未回调 / 离线但 CDN 有缓存」时，若直接返回 null，
 *   对方发来的视频与语音就会表现为「点不开 / 播不出」。
 *
 * 策略：
 *   用 EXPO_PUBLIC_SUPABASE_URL 拼出 public 对象地址作为最后兜底。
 *   该地址在桶为 public 时可直接播放；桶为 private 时会被 400/403 拒绝，
 *   但调用方仍会优先使用签名 URL，因此不会造成回归。
 *
 * @param {string|null|undefined} value 相对对象路径或历史完整 URL
 * @returns {string|null}
 */
export function buildPublicStorageUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // 已是完整 URL / 本地 URI：无需构建
  if (/^(https?|file|content|data|blob|ph|assets-library):/i.test(trimmed)) return null;

  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) return null;

  const objectPath = toStoragePath(trimmed);
  if (!objectPath) return null;

  const cleanBase = base.replace(/\/+$/, '');
  const encodedPath = objectPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  return `${cleanBase}/storage/v1/object/public/${STORAGE_BUCKET}/${encodedPath}`;
}

/**
 * 判断是否为「本地文件 URI」（需要直接透传渲染，不能拿去签名）。
 *
 * 乐观发送阶段 mediaUrl 是本地 URI（iOS: file:///...，Android: content:// 或 file://），
 * 这些值必须原样交给 <Image> / 音频播放器读取，而不是当作桶内对象路径。
 */
function isLocalUri(value) {
  return typeof value === 'string'
    && /^(file|content|ph|assets-library|data|blob):/i.test(value.trim());
}

/** LRU 写入：命中则刷新顺序，超限则淘汰最旧 */
function cacheSet(path, url, ttlSeconds) {
  if (cache.has(path)) cache.delete(path);
  cache.set(path, {
    url,
    expiresAt: Date.now() + Math.max(0, ttlSeconds * 1000 - REFRESH_AHEAD_MS),
  });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** 读取缓存（命中则刷新 LRU 顺序），过期返回 null */
function cacheGet(path) {
  const entry = cache.get(path);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(path);
    return null;
  }
  // 刷新 LRU 顺序
  cache.delete(path);
  cache.set(path, entry);
  return entry.url;
}

/**
 * 为对象路径生成签名 URL（带缓存 + 并发去重）。
 *
 * @param {string} path 桶内对象路径
 * @param {number} [ttlSeconds] 有效期（秒）
 * @returns {Promise<string|null>}
 */
export async function getSignedUrl(path, ttlSeconds = SIGNED_URL_TTL) {
  if (!path) return null;

  // 🔧 兜底归一化：调用方若误传「完整 URL」或「chat_media/ 前缀路径」，
  //    createSignedUrl 会因对象不存在抛 `Object not found`。
  //    toStoragePath 对已是相对路径的输入是幂等的，不会改变正常行为。
  const objectPath = toStoragePath(path);
  if (!objectPath) return null;

  const cached = cacheGet(objectPath);
  if (cached) return cached;

  // 并发去重：同一路径只发一次请求
  if (inflight.has(objectPath)) return inflight.get(objectPath);

  const task = (async () => {
    try {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(objectPath, ttlSeconds);
      if (error) throw error;
      const url = data?.signedUrl || null;
      if (url) cacheSet(objectPath, url, ttlSeconds);
      return url;
    } catch (e) {
      // 🚨 离线降级：网络失败 / 超时时绝不返回「空」覆盖调用方已有状态。
      //    优先回退到缓存里可能仍存在的旧签名 URL（即使已过期，也比黑屏好），
      //    让调用方继续渲染旧缓存 / 本地地址，而不是把图片清空。
      console.warn('网络请求签名失败(可能处于离线)，继续保留旧缓存/本地地址', e);
      return cacheGet(path) ?? null;
    } finally {
      inflight.delete(path);
    }
  })();

  inflight.set(path, task);
  return task;
}

/** 清空缓存（登出 / 切换账号时调用，避免跨账号串号） */
export function clearSignedUrlCache() {
  cache.clear();
  inflight.clear();
}

/**
 * ⚡ 同步读取内存缓存中的签名 URL（0.0 秒秒开专用）
 *
 * 用途：
 *   全屏预览 / 聊天气泡在「首帧渲染」时，需要立刻拿到可渲染的 URL，
 *   不能等 useEffect 里的异步 createSignedUrl 返回（那会造成 0.3~3 秒黑屏）。
 *   本函数同步返回模块级 LRU 缓存里已有的签名 URL，命中即 0 毫秒出图。
 *
 * 行为：
 *   - 空值 / 非法值            → null
 *   - 已是完整 URL（http(s) / file / content / data）→ 原样返回（无需签名）
 *   - 相对对象路径             → 查 LRU 缓存，命中且未过期返回签名 URL，否则 null
 *   - ph:// / assets-library:// → null（iOS 原生句柄，expo-image 无法直接加载）
 *
 * @param {string|null|undefined} path 相对对象路径或完整 URL
 * @returns {string|null}
 */
export const getMemoryCachedSignedUrl = (path) => {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  // 已是完整 URL：直接返回（本地 URI 也原样透传，交给 Image / Video 读取）
  if (/^(https?|file|content|data):/i.test(trimmed)) return trimmed;

  // iOS 相册原生句柄：expo-image 无法加载，必须返回 null 让调用方走占位图
  if (/^(ph|assets-library|blob):/i.test(trimmed)) return null;

  // 相对对象路径：同步读 LRU 缓存（cacheGet 内部会处理过期与 LRU 顺序刷新）
  const objectPath = toStoragePath(trimmed);
  if (!objectPath) return null;
  return cacheGet(objectPath);
};

/**
 * React Hook：根据「相对路径」或「历史签名 URL」返回可渲染的 URL。
 *
 * @param {string|null|undefined} value 相对路径或历史完整 URL
 * @param {number} [ttlSeconds] 签名有效期（秒）
 * @returns {{ url: string|null, loading: boolean }}
 */
export function useSignedMediaUrl(value, ttlSeconds = SIGNED_URL_TTL) {
  const path = toStoragePath(value);
  const isAbsolute = isAbsoluteUrl(value);
  // 🖼️ 本地 URI（刚发出去、尚未回填对象路径的乐观消息）：直接交给 Image / Audio 读取
  const isLocal = isLocalUri(value);

  // 初始值：历史完整 URL / 本地 URI 直接透传；相对路径先查缓存
  const [url, setUrl] = useState(() => {
    if (isAbsolute) return value.trim();
    if (isLocal) return value.trim();
    if (!path) return null;
    return cacheGet(path);
  });

  useEffect(() => {
    // 历史完整 URL / 本地 URI：直接透传，不发起签名请求
    if (isAbsolute || isLocal) return undefined;
    if (!path) return undefined;

    // 缓存命中：无需 setState（初始值已从缓存读取，且缓存不会在渲染间变化）
    if (cacheGet(path)) return undefined;

    let cancelled = false;

    // 🚨 离线降级：请求失败时 getSignedUrl 会回退到缓存（可能为 null），
    //    这里只在拿到有效 URL 时才 setUrl，绝不 setUrl(null) 清空已有图片。
    getSignedUrl(path, ttlSeconds)
      .then((signed) => {
        if (!cancelled && signed) setUrl(signed);
      })
      .catch((error) => {
        console.warn('网络请求签名失败(可能处于离线)，继续保留旧缓存/本地地址', error);
      });

    return () => { cancelled = true; };
  }, [isAbsolute, isLocal, path, ttlSeconds]);

  // 派生值：绝对 URL / 本地 URI / 缓存命中 / 异步签名结果，统一在此收敛
  const resolved = (isAbsolute || isLocal)
    ? value.trim()
    : (url ?? (path ? cacheGet(path) : null));

  return { url: resolved, loading: !resolved };
}

export default useSignedMediaUrl;
// --- END OF FILE src/hooks/chat/useSignedMediaUrl.js ---
