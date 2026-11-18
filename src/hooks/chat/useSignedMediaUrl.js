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

/**
 * 🆔 TASK-P0.3 / B1-E：身份代际防护
 *
 * 问题：模块级缓存跨账号共享，仅以 storagePath 为键。A 登出后 B 登录，
 *      若 B 恰好请求同一路径（或 A 的旧 Promise 迟到返回），就会把 A 的
 *      签名 URL 交给 B，或把 A 的结果写进 B 的缓存。
 *
 * 方案：
 *   1. 缓存键 = `${ownerId}::${storagePath}`，不同 owner 天然隔离
 *   2. 每次身份变化（owner 变化）自增 epoch，旧 epoch 发起的请求结果一律丢弃
 *   3. inflight 删除前校验「当前映射仍是本 Promise」，防止 A 的旧 Promise
 *      误删 B 的同路径 inflight 条目
 */
let currentOwnerId = null;
let currentEpoch = 0;

/**
 * 🛡️ CR-07：身份变化订阅者集合。
 *
 * 问题：`setSignedUrlOwner()` 是模块级函数，修改模块变量不会触发 React 重渲染。
 *   `useSignedMediaUrl` 在渲染期读取 `getSignedUrlIdentity()`，若身份变化时
 *   组件没有因其他原因重渲染，就会一直使用旧的 renderOwnerId/renderEpoch，
 *   导致旧账号的签名 URL 继续显示（X-04 的修复在「不重渲染」场景下失效）。
 *
 * 方案：维护一个订阅者集合，`setSignedUrlOwner` 在身份真正变化时通知所有
 *   已挂载的 Hook 实例，让它们通过 setState 触发一次重渲染，从而重新读取
 *   最新身份快照并丢弃旧 state。
 */
const identitySubscribers = new Set();

/** 缓存键：owner + 路径 */
const buildCacheKey = (ownerId, objectPath) => `${ownerId ?? 'anon'}::${objectPath}`;

/**
 * 登记当前身份（由 AuthProvider 或调用方在身份变化时调用）。
 * owner 变化时自增 epoch 并清空缓存/inflight，确保旧内容不可被新账号消费。
 *
 * 🆔 X-05：`forceBump` 用于「同一 ownerId 但会话已更换」（A→登出→A 重新登录、
 *   或 token 重新签发）。此时 ownerId 不变，但旧会话的在途 Promise 结果必须失效，
 *   否则旧 token 下的签名 URL 会污染新会话。传 true 时强制自增 epoch 并清空缓存。
 *
 * 🛡️ CR-07：身份真正变化时，同步通知所有已挂载的 Hook 重渲染。
 * @param {string|null} ownerId
 * @param {boolean} [forceBump=false]
 * @returns {number} 新的 epoch
 */
export function setSignedUrlOwner(ownerId, forceBump = false) {
  const next = ownerId ?? null;
  if (next !== currentOwnerId || forceBump) {
    currentOwnerId = next;
    currentEpoch += 1;
    cache.clear();
    inflight.clear();
    // 🛡️ CR-07：通知所有订阅者重渲染（逐个 try，避免单个异常中断其余通知）。
    for (const notify of identitySubscribers) {
      try { notify(); } catch (_) {}
    }
  }
  return currentEpoch;
}

/** 读取当前身份快照（供请求发起时捕获） */
export function getSignedUrlIdentity() {
  return { ownerId: currentOwnerId, epoch: currentEpoch };
}

/** 判断某次请求发起时的身份是否仍然有效 */
function isIdentityStillValid(ownerId, epoch) {
  return currentOwnerId === ownerId && currentEpoch === epoch;
}

/** cacheKey -> { url, expiresAt } */
const cache = new Map();

/** cacheKey -> Promise<string|null>（并发去重） */
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
function cacheSet(cacheKey, url, ttlSeconds) {
  if (cache.has(cacheKey)) cache.delete(cacheKey);
  cache.set(cacheKey, {
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
function cacheGet(cacheKey) {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return null;
  }
  // 刷新 LRU 顺序
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  return entry.url;
}

/**
 * 为对象路径生成签名 URL（带缓存 + 并发去重 + 身份代际防护）。
 *
 * @param {string} path 桶内对象路径
 * @param {number} [ttlSeconds] 有效期（秒）
 * @returns {Promise<string|null>}
 */
export async function getSignedUrl(path, ttlSeconds = SIGNED_URL_TTL) {
  if (!path) return null;

  // 🚫 本地 URI（file:// / content:// / ph:// / assets-library:// / data: / blob:）
  //    不是桶内对象，绝对不能拿去 createSignedUrl —— 否则必然 `Object not found`。
  //    这里在入口处直接短路，调用方应改用本地直读。
  if (isLocalUri(path)) return null;

  // 🔧 兜底归一化：调用方若误传「完整 URL」或「chat_media/ 前缀路径」，
  //    createSignedUrl 会因对象不存在抛 `Object not found`。
  //    toStoragePath 对已是相对路径的输入是幂等的，不会改变正常行为。
  const objectPath = toStoragePath(path);
  if (!objectPath) return null;

  // 📸 捕获发起时的身份快照
  const { ownerId: startOwnerId, epoch: startEpoch } = getSignedUrlIdentity();

  // 🛡️ T6-B/X-09b：未登录边界 fail-closed。
  //    无已认证 owner 时不得以 anon 身份请求签名，也不得读写 anon 缓存
  //    （否则可能命中历史 anon 缓存残留，或向 Supabase 发起无 JWT 的签名请求）。
  //    直接返回 null，由调用方回退到本地地址 / 占位图。
  if (!startOwnerId) return null;

  const cacheKey = buildCacheKey(startOwnerId, objectPath);

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 并发去重：同一 owner + 同一路径只发一次请求
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const task = (async () => {
    try {
      // 🔍 诊断日志：确认真正发给 Supabase 的对象路径（必须形如 `${userId}/xxx.jpg`）
      console.log(`[Storage Sign] 尝试请求签名 URL，清洗后路径: ${objectPath}`);
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(objectPath, ttlSeconds);
      if (error) throw error;
      const url = data?.signedUrl || null;
      // 🛡️ 代际校验：身份已变化 → 绝不写入新账号缓存，也不返回给调用方
      if (!isIdentityStillValid(startOwnerId, startEpoch)) return null;
      if (url) cacheSet(cacheKey, url, ttlSeconds);
      return url;
    } catch (e) {
      // 🚨 离线降级：网络失败 / 超时时绝不返回「空」覆盖调用方已有状态。
      //    优先回退到缓存里可能仍存在的旧签名 URL（即使已过期，也比黑屏好），
      //    让调用方继续渲染旧缓存 / 本地地址，而不是把图片清空。
      console.warn('网络请求签名失败(可能处于离线)，继续保留旧缓存/本地地址', e);
      // 🛡️ 代际校验：身份已变化 → 不返回旧账号的缓存内容
      if (!isIdentityStillValid(startOwnerId, startEpoch)) return null;
      return cacheGet(cacheKey) ?? null;
    } finally {
      // 🛡️ 只删除「仍属于本 Promise」的 inflight 条目，
      //    防止 A 的旧 Promise 误删 B 的同路径 inflight
      if (inflight.get(cacheKey) === task) inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, task);
  return task;
}

/**
 * 清空缓存（登出 / 切换账号时调用，避免跨账号串号）。
 * ⚠️ 仅清理客户端内存缓存，不代表已签发的 URL 被吊销（7 天 TTL 仍有效）。
 */
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
  // 🆔 B1-E：按当前 owner 构造缓存键，绝不跨账号命中
  const objectPath = toStoragePath(trimmed);
  if (!objectPath) return null;
  return cacheGet(buildCacheKey(currentOwnerId, objectPath));
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

  // 📸 渲染期捕获当前身份快照（owner + epoch）。身份变化时 epoch 自增，
  //    使旧 state 自动失效。
  const { ownerId: renderOwnerId, epoch: renderEpoch } = getSignedUrlIdentity();

  // 🛡️ CR-07：订阅身份变化，强制重渲染。
  //    setSignedUrlOwner() 是模块级函数，修改模块变量不会触发 React 更新；
  //    若组件未因其他原因重渲染，renderOwnerId/renderEpoch 会停留在旧值，
  //    旧账号的签名 URL 继续显示。这里用 setState 订阅，身份变化时触发一次
  //    重渲染，从而重新读取最新身份快照并丢弃旧 state。
  const [, forceIdentityRender] = useState(0);
  useEffect(() => {
    const notify = () => forceIdentityRender((n) => n + 1);
    identitySubscribers.add(notify);
    return () => { identitySubscribers.delete(notify); };
  }, []);

  // 🛡️ X-04：url state 必须与「它所属的身份」绑定。
  //    旧实现只存 url，A→B 切换后组件不卸载时 url 仍持有 A 的签名 URL，
  //    且 effect 依赖不含 owner/epoch 不会重跑，导致 B 看到 A 的图片。
  //    这里把 { url, ownerId, epoch } 一起存，读取时校验归属。
  const [state, setState] = useState(() => {
    if (isAbsolute || isLocal) return { url: value.trim(), ownerId: renderOwnerId, epoch: renderEpoch };
    if (!path) return { url: null, ownerId: renderOwnerId, epoch: renderEpoch };
    return {
      url: cacheGet(buildCacheKey(renderOwnerId, path)),
      ownerId: renderOwnerId,
      epoch: renderEpoch,
    };
  });

  useEffect(() => {
    // 历史完整 URL / 本地 URI：直接透传，不发起签名请求
    if (isAbsolute || isLocal) return undefined;
    if (!path) return undefined;

    // 缓存命中：无需 setState（初始值已从缓存读取，且缓存不会在渲染间变化）
    if (cacheGet(buildCacheKey(currentOwnerId, path))) return undefined;

    let cancelled = false;
    // 📸 捕获本次请求发起时的身份快照
    const { ownerId: startOwnerId, epoch: startEpoch } = getSignedUrlIdentity();

    // 🚨 离线降级：请求失败时 getSignedUrl 会回退到缓存（可能为 null），
    //    这里只在拿到有效 URL 时才 setState，绝不 setState(null) 清空已有图片。
    getSignedUrl(path, ttlSeconds)
      .then((signed) => {
        // 🛡️ 代际校验：身份已变化 → 绝不把旧账号 URL 交给新账号组件
        if (!isIdentityStillValid(startOwnerId, startEpoch)) return;
        if (!cancelled && signed) {
          setState({ url: signed, ownerId: startOwnerId, epoch: startEpoch });
        }
      })
      .catch((error) => {
        console.warn('网络请求签名失败(可能处于离线)，继续保留旧缓存/本地地址', error);
      });

    return () => { cancelled = true; };
    // 🛡️ X-04：owner/epoch 纳入依赖，身份切换时重新发起签名并丢弃旧 state
  }, [isAbsolute, isLocal, path, ttlSeconds, renderOwnerId, renderEpoch]);

  // 派生值：绝对 URL / 本地 URI / 缓存命中 / 异步签名结果，统一在此收敛
  if (isAbsolute || isLocal) {
    return { url: value.trim(), loading: false };
  }
  // 🛡️ X-04：仅当 state 属于当前身份时才采用，否则回落到当前 owner 的缓存
  const stateValid = state.ownerId === renderOwnerId && state.epoch === renderEpoch;
  const resolved = (stateValid ? state.url : null)
    ?? (path ? cacheGet(buildCacheKey(renderOwnerId, path)) : null);

  return { url: resolved, loading: !resolved };
}

export default useSignedMediaUrl;
// --- END OF FILE src/hooks/chat/useSignedMediaUrl.js ---
