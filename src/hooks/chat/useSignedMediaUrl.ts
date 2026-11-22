// --- START OF FILE src/hooks/chat/useSignedMediaUrl.ts ---
import { useEffect, useState } from 'react';
import { supabase } from '../../services/supabase';

/**
 * 聊天媒体签名 URL（带 LRU 缓存 + 并发去重 + 身份代际防护）
 *
 * ⚠️ P1.4 R5 迁移约束（零行为变更）：
 *   · 模块级 `currentOwnerId` / `currentEpoch` / `identitySubscribers` / `cache` / `inflight`
 *     必须保持**模块单例**语义（不得改为类实例或 Context）。
 *   · `getSignedUrl` 的短路顺序、代际闸门位置、finally 只删自身 inflight 条目逐字保持。
 *   · `toStoragePath` / `buildPublicStorageUrl` 的正则与短路顺序逐字保持。
 *   · `Date.now()` 采样点（cacheSet / cacheGet）次数与顺序保持。
 *   · `useSignedMediaUrl` 的 Effect 依赖数组必须含 renderOwnerId / renderEpoch。
 */

const STORAGE_BUCKET = 'chat_media';

/** 签名 URL 默认有效期：7 天（秒） */
export const SIGNED_URL_TTL = 60 * 60 * 24 * 7;

/** 提前刷新窗口：1 天（毫秒） */
const REFRESH_AHEAD_MS = 60 * 60 * 24 * 1000;

/** LRU 缓存上限 */
const MAX_CACHE_ENTRIES = 500;

// ---------------------------------------------------------------------------
// 身份代际（模块级单例）
// ---------------------------------------------------------------------------
let currentOwnerId: string | null = null;
let currentEpoch = 0;
const identitySubscribers = new Set<() => void>();

/** 构造缓存键：owner + 对象路径（绝不跨账号命中） */
const buildCacheKey = (ownerId: string | null, objectPath: string): string =>
  `${ownerId ?? 'anon'}::${objectPath}`;

/**
 * 设置当前签名身份。owner 变化或 forceBump 时自增 epoch 并清空缓存。
 * @returns 新的 epoch
 */
export function setSignedUrlOwner(ownerId: string | null, forceBump: boolean = false): number {
  const next = ownerId ?? null;
  if (next !== currentOwnerId || forceBump) {
    currentOwnerId = next;
    currentEpoch += 1;
    cache.clear();
    inflight.clear();
    for (const notify of identitySubscribers) {
      try {
        notify();
      } catch {
        /* 订阅者异常不得影响其他订阅者 */
      }
    }
  }
  return currentEpoch;
}

/** 读取当前签名身份快照 */
export function getSignedUrlIdentity(): { ownerId: string | null; epoch: number } {
  return { ownerId: currentOwnerId, epoch: currentEpoch };
}

/** 判断某次请求发起时的身份是否仍然有效 */
function isIdentityStillValid(ownerId: string | null, epoch: number): boolean {
  return currentOwnerId === ownerId && currentEpoch === epoch;
}

// ---------------------------------------------------------------------------
// 缓存（模块级单例）
// ---------------------------------------------------------------------------
interface CacheEntry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * 把「完整 URL / chat_media 前缀路径 / 相对路径」归一化为桶内对象路径。
 * 非字符串 / 空 / 本地 URI → null；非 http 开头 → 原样返回。
 */
export function toStoragePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // 本地 URI 不是桶内对象
  if (/^(file|content|ph|assets-library|data|blob):/i.test(trimmed)) return null;

  // 非 http 开头：视为已是相对路径，原样返回
  // ⚠️ P1.4 R6-A1：必须保持原 JS 的 `/^https?:\/\//i`（要求 `//`），
  //    否则 `http:owner/media/x.jpg` 这类非完整 URL 会被误判为完整 URL，
  //    进而走 chat_media 提取分支返回 null，破坏「相对路径原样返回」语义。
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;

  const match = trimmed.match(/\/chat_media\/([^?#]+)/i);
  if (!match) return null;
  // 捕获组 1 必然存在（正则要求至少一个字符），noUncheckedIndexedAccess 下显式断言。
  const captured = match[1]!;
  try {
    return decodeURIComponent(captured);
  } catch {
    return captured;
  }
}

/**
 * 是否为「历史完整 URL」（需要直接透传渲染）。
 * ⚠️ P1.4 R6-A2：必须保持原 JS 的 `/^https?:\/\//i`（仅 http/https 且要求 `//`）。
 *    不得把 file:/content:/data: 等本地 URI 判为绝对 URL —— 它们由 isLocalUri 单独处理，
 *    混入会改变 useSignedMediaUrl 的透传/签名分支选择。
 */
function isAbsoluteUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * 构造公共存储 URL（桶为 private 时会被拒绝，仅作最后兜底）。
 * 完整 URL / 本地 URI / 无配置 → null。
 */
export function buildPublicStorageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // 已是完整 URL 或本地 URI：无需拼公共地址
  if (/^(https?|file|content|ph|assets-library|data|blob):/i.test(trimmed)) return null;

  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) return null;

  const objectPath = toStoragePath(trimmed);
  if (!objectPath) return null;

  const cleanBase = base.replace(/\/+$/, '');
  // ⚠️ P1.4 R6-A3：必须保留原 JS 的 `.filter(Boolean)`，
  //    否则前导斜杠 / 连续斜杠会产生空段，拼出 `//` 的畸形 URL。
  const encodedPath = objectPath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${cleanBase}/storage/v1/object/public/${STORAGE_BUCKET}/${encodedPath}`;
}

/** 是否为本地 URI（file/content/ph/assets-library/data/blob） */
function isLocalUri(value: unknown): boolean {
  return typeof value === 'string' && /^(file|content|ph|assets-library|data|blob):/i.test(value.trim());
}

/** 写入缓存（带提前刷新窗口 + LRU 逐出） */
function cacheSet(cacheKey: string, url: string, ttlSeconds: number): void {
  if (cache.has(cacheKey)) cache.delete(cacheKey);
  cache.set(cacheKey, {
    url,
    expiresAt: Date.now() + Math.max(0, ttlSeconds * 1000 - REFRESH_AHEAD_MS),
  });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 读取缓存（命中则刷新 LRU 顺序），过期返回 null */
function cacheGet(cacheKey: string): string | null {
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
 * @param path 桶内对象路径
 * @param ttlSeconds 有效期（秒）
 */
export async function getSignedUrl(path: string, ttlSeconds: number = SIGNED_URL_TTL): Promise<string | null> {
  if (!path) return null;

  // 🚫 本地 URI 不是桶内对象，绝对不能拿去 createSignedUrl
  if (isLocalUri(path)) return null;

  // 🔧 兜底归一化（对已是相对路径的输入幂等）
  const objectPath = toStoragePath(path);
  if (!objectPath) return null;

  // 📸 捕获发起时的身份快照
  const { ownerId: startOwnerId, epoch: startEpoch } = getSignedUrlIdentity();

  // 🛡️ T6-B/X-09b：未登录边界 fail-closed
  if (!startOwnerId) return null;

  const cacheKey = buildCacheKey(startOwnerId, objectPath);

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 并发去重：同一 owner + 同一路径只发一次请求
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;

  // ⚠️ P1.4 R6-A5（获授权的定向可靠性修复，非机械恢复旧行为）：
  //
  //   旧 JS 的缺陷：`const task = (async () => { ... finally { if (inflight.get(k) === task) ... } })()`
  //   在 `supabase.storage.from()` **同步抛错** 时，async IIFE 的同步段先于 `const task` 赋值完成，
  //   finally 内访问 `task` 触发 TDZ → ReferenceError，且 `inflight.set()` 从未执行。
  //   旧行为：Promise 以 ReferenceError 拒绝（调用方拿到异常而非 null）。
  //
  //   本实现的目标（按 Gatekeeper 授权）：
  //     1) 同步抛错不再产生 ReferenceError，而是走正常 catch → 返回缓存或 null；
  //     2) 同步抛错后**不遗留 stale inflight 条目**；
  //     3) 恢复网络后同路径可重新签名（不残留 inflight 即满足）；
  //     4) 仅删除属于当前 Promise 的 inflight 条目（A→B→A 旧 Promise 不得删/覆盖新会话条目）；
  //     5) owner/epoch 双重闸门完全不变。
  //
  //   实现要点（关键顺序，勿改）：
  //     a) 先把「同步段」包进 try，使同步异常也进入 catch 分支；
  //     b) **先创建 Promise，再 inflight.set()**。因为 async IIFE 的同步段会在
  //        `const task = (...)` 赋值完成前执行完毕（含 finally），若此时 inflight 里
  //        还没有条目，finally 的比较必然不成立 → 不会误删、也不会残留；
  //     c) finally 通过 holder.task 比较，确保只删自己（holder.task 在 set 之前为 null，
  //        而 Map 值恒为 Promise，故同步路径永不误删）。
  // holder 记录「本 Promise 是否已 settle」以及「本 Promise 自身引用」。
  //   · settled=true 表示 async IIFE 的同步段已抛错并走完 finally（早于 inflight.set）；
  //   · task 用于 finally 中做「只删自己」的身份比较。
  const holder: { task: Promise<string | null> | null; settled: boolean } = {
    task: null,
    settled: false,
  };
  const task = (async (): Promise<string | null> => {
    try {
      // 🔍 诊断日志：确认真正发给 Supabase 的对象路径
      console.log(`[Storage Sign] 尝试请求签名 URL，清洗后路径: ${objectPath}`);
      // ⚠️ 同步抛错点：storage.from() / createSignedUrl() 均可能在返回 Promise 前抛错。
      //    放在 try 内，确保同步异常也走 catch（旧实现会在此处产生 TDZ ReferenceError）。
      const { data, error } = await supabase!.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(objectPath, ttlSeconds);
      if (error) throw error;
      const url = data?.signedUrl || null;
      // 🛡️ 代际校验：身份已变化 → 绝不写入新账号缓存，也不返回给调用方
      if (!isIdentityStillValid(startOwnerId, startEpoch)) return null;
      if (url) cacheSet(cacheKey, url, ttlSeconds);
      return url;
    } catch (e) {
      // 🚨 离线降级：网络失败 / 超时时绝不返回「空」覆盖调用方已有状态
      console.warn('网络请求签名失败(可能处于离线)，继续保留旧缓存/本地地址', e);
      // 🛡️ 代际校验：身份已变化 → 不返回旧账号的缓存内容
      if (!isIdentityStillValid(startOwnerId, startEpoch)) return null;
      return cacheGet(cacheKey) ?? null;
    } finally {
      // 🛡️ 只删除「仍属于本 Promise」的 inflight 条目。
      //    holder.task 在 set 之前为 null，此时 inflight.get() 不可能等于 null（Map 值为 Promise），
      //    因此同步抛错路径（finally 早于 set）不会误删任何条目。
      if (inflight.get(cacheKey) === holder.task) inflight.delete(cacheKey);
      // 标记：本 Promise 的同步段已结束（finally 已执行）。
      // 若此时 holder.task 仍为 null，说明 finally 早于 inflight.set() 执行，
      // 即同步段抛错 → 该 task 已 settle，绝不能再登记进 inflight。
      holder.settled = true;
    }
  })();

  // ⚠️ P1.4 R6-A5 关键：若 async IIFE 的同步段已抛错并走完 finally，
  //    说明该 task 已 settle（rejected/resolved），此时**绝不能**再写入 inflight，
  //    否则会留下一个「已完成但未删除」的 stale 条目，导致后续同路径请求
  //    永远命中这个已 settle 的 Promise（网络恢复后仍拿不到 URL）。
  if (holder.settled) {
    // 同步段已抛错并完成 finally：不登记 inflight，直接返回已 settle 的 task
    return task;
  }
  holder.task = task;
  inflight.set(cacheKey, task);
  return task;
}

/**
 * 清空缓存（登出 / 切换账号时调用，避免跨账号串号）。
 * ⚠️ 仅清理客户端内存缓存，不代表已签发的 URL 被吊销（7 天 TTL 仍有效）。
 */
export function clearSignedUrlCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * ⚡ 同步读取内存缓存中的签名 URL（0.0 秒秒开专用）
 */
export const getMemoryCachedSignedUrl = (path: string | null | undefined): string | null => {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;

  // 已是完整 URL：直接返回（本地 URI 也原样透传）
  if (/^(https?|file|content|data):/i.test(trimmed)) return trimmed;

  // iOS 相册原生句柄：expo-image 无法加载，必须返回 null
  if (/^(ph|assets-library|blob):/i.test(trimmed)) return null;

  // 相对对象路径：同步读 LRU 缓存（按当前 owner 构造缓存键）
  const objectPath = toStoragePath(trimmed);
  if (!objectPath) return null;
  return cacheGet(buildCacheKey(currentOwnerId, objectPath));
};

/** `useSignedMediaUrl` 的返回 */
export interface SignedMediaUrlResult {
  url: string | null;
  loading: boolean;
}

/** Hook 内部 state：url 与其所属身份绑定 */
interface SignedMediaState {
  url: string | null;
  ownerId: string | null;
  epoch: number;
}

/**
 * React Hook：根据「相对路径」或「历史签名 URL」返回可渲染的 URL。
 *
 * @param value 相对路径或历史完整 URL
 * @param ttlSeconds 签名有效期（秒）
 */
export function useSignedMediaUrl(
  value: string | null | undefined,
  ttlSeconds: number = SIGNED_URL_TTL
): SignedMediaUrlResult {
  const path = toStoragePath(value);
  const isAbsolute = isAbsoluteUrl(value);
  // 🖼️ 本地 URI（乐观消息）：直接交给 Image / Audio 读取
  const isLocal = isLocalUri(value);

  // 📸 渲染期捕获当前身份快照（owner + epoch）
  const { ownerId: renderOwnerId, epoch: renderEpoch } = getSignedUrlIdentity();

  // 🛡️ CR-07：订阅身份变化，强制重渲染
  const [, forceIdentityRender] = useState<number>(0);
  useEffect(() => {
    const notify = (): void => forceIdentityRender((n) => n + 1);
    identitySubscribers.add(notify);
    return () => {
      identitySubscribers.delete(notify);
    };
  }, []);

  // 🛡️ X-04：url state 必须与「它所属的身份」绑定
  const [state, setState] = useState<SignedMediaState>(() => {
    if (isAbsolute || isLocal) return { url: value!.trim(), ownerId: renderOwnerId, epoch: renderEpoch };
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

    // 缓存命中：无需 setState（初始值已从缓存读取）
    if (cacheGet(buildCacheKey(currentOwnerId, path))) return undefined;

    let cancelled = false;
    // 📸 捕获本次请求发起时的身份快照
    const { ownerId: startOwnerId, epoch: startEpoch } = getSignedUrlIdentity();

    // 🚨 离线降级：只在拿到有效 URL 时才 setState，绝不 setState(null) 清空已有图片
    getSignedUrl(path, ttlSeconds)
      .then((signed) => {
        // 🛡️ 代际校验：身份已变化 → 绝不把旧账号 URL 交给新账号组件
        if (!isIdentityStillValid(startOwnerId, startEpoch)) return;
        if (!cancelled && signed) {
          setState({ url: signed, ownerId: startOwnerId, epoch: startEpoch });
        }
      })
      .catch((error: unknown) => {
        console.warn('网络请求签名失败(可能处于离线)，继续保留旧缓存/本地地址', error);
      });

    return () => {
      cancelled = true;
    };
    // 🛡️ X-04：owner/epoch 纳入依赖，身份切换时重新发起签名并丢弃旧 state
  }, [isAbsolute, isLocal, path, ttlSeconds, renderOwnerId, renderEpoch]);

  // 派生值：绝对 URL / 本地 URI / 缓存命中 / 异步签名结果，统一在此收敛
  if (isAbsolute || isLocal) {
    return { url: value!.trim(), loading: false };
  }
  // 🛡️ X-04：仅当 state 属于当前身份时才采用，否则回落到当前 owner 的缓存
  const stateValid = state.ownerId === renderOwnerId && state.epoch === renderEpoch;
  const resolved =
    (stateValid ? state.url : null) ??
    (path ? cacheGet(buildCacheKey(renderOwnerId, path)) : null);

  return { url: resolved, loading: !resolved };
}

export default useSignedMediaUrl;
// --- END OF FILE src/hooks/chat/useSignedMediaUrl.ts ---
