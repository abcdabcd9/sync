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

  const cached = cacheGet(path);
  if (cached) return cached;

  // 并发去重：同一路径只发一次请求
  if (inflight.has(path)) return inflight.get(path);

  const task = (async () => {
    try {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(path, ttlSeconds);
      if (error) throw error;
      const url = data?.signedUrl || null;
      if (url) cacheSet(path, url, ttlSeconds);
      return url;
    } catch (e) {
      console.warn('⚠️ 生成签名 URL 失败:', path, e?.message ?? e);
      return null;
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
 * React Hook：根据「相对路径」或「历史签名 URL」返回可渲染的 URL。
 *
 * @param {string|null|undefined} value 相对路径或历史完整 URL
 * @param {number} [ttlSeconds] 签名有效期（秒）
 * @returns {{ url: string|null, loading: boolean }}
 */
export function useSignedMediaUrl(value, ttlSeconds = SIGNED_URL_TTL) {
  const path = toStoragePath(value);
  const isAbsolute = isAbsoluteUrl(value);

  // 初始值：历史完整 URL 直接透传；相对路径先查缓存
  const [url, setUrl] = useState(() => {
    if (isAbsolute) return value.trim();
    if (!path) return null;
    return cacheGet(path);
  });

  useEffect(() => {
    // 历史完整 URL：直接透传，不发起签名请求
    if (isAbsolute) return undefined;
    if (!path) return undefined;

    // 缓存命中：无需 setState（初始值已从缓存读取，且缓存不会在渲染间变化）
    if (cacheGet(path)) return undefined;

    let cancelled = false;

    getSignedUrl(path, ttlSeconds).then((signed) => {
      if (!cancelled && signed) setUrl(signed);
    });

    return () => { cancelled = true; };
  }, [isAbsolute, path, ttlSeconds]);

  // 派生值：绝对 URL / 缓存命中 / 异步签名结果，统一在此收敛
  const resolved = isAbsolute ? value.trim() : (url ?? (path ? cacheGet(path) : null));

  return { url: resolved, loading: !resolved };
}

export default useSignedMediaUrl;
// --- END OF FILE src/hooks/chat/useSignedMediaUrl.js ---
