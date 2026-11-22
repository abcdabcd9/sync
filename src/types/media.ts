/**
 * Storage / Media 契约（TASK-P1.1 R0 / Phase C3）
 *
 * ============================================================================
 * 契约来源（逐函数核对返回值，非猜测）
 * ============================================================================
 *   - `src/hooks/chat/useMediaUpload.js`
 *       cleanStoragePath / createSignedMediaUrl / uploadToSupabase / guessContentType
 *   - `src/hooks/chat/useSignedMediaUrl.js`
 *       toStoragePath / buildPublicStorageUrl / getSignedUrl / useSignedMediaUrl
 *   - `src/services/mediaCache.js`
 *       persistMedia / resolveLocalMedia / downloadToSandbox / getMediaCacheSize
 *   - `src/constants/browser/index.js`
 *       buildMediaItem（嗅探媒体，见 browser.ts）
 *
 * ============================================================================
 * 核心原则：四种「地址」是不同业务概念，禁止混为一谈
 * ============================================================================
 *   1. **对象路径（ObjectPath）**：桶内相对路径，形如 `userId/img_123.jpg`。
 *      这是 `messages.media_url` 实际存储的形态（私有桶）。
 *   2. **签名 URL（SignedUrl）**：临时可访问的完整 https URL，带过期时间。
 *      由 `createSignedUrl` 生成，**不可持久化**（会过期）。
 *   3. **公共 URL（PublicUrl）**：`/storage/v1/object/public/...` 兜底地址。
 *      桶为 private 时会被拒绝，仅作最后兜底。
 *   4. **本地文件 URI（LocalUri）**：`file://` / `content://` / `ph://` 等。
 *      乐观发送阶段与离线缓存使用，**不能**拿去签名。
 *
 * 另：**缓存状态（MediaCacheState）** 与地址无关，描述「本地是否已有副本」。
 */

// ---------------------------------------------------------------------------
// 地址类型（品牌化，编译期区分）
// ---------------------------------------------------------------------------

/**
 * 桶内对象路径（相对路径，无协议头）。
 *
 * 例：`<userId>/img_1700000000000_<uuid>.jpg`
 *
 * 品牌化：运行时仍是 string，仅编译期与 SignedUrl/PublicUrl/LocalUri 区分。
 */
export type ObjectPath = string & { readonly __brand: 'ObjectPath' };

/**
 * 临时签名 URL（完整 https，带 token/过期）。
 *
 * 品牌化：防止被误当作可持久化的对象路径。
 */
export type SignedUrl = string & { readonly __brand: 'SignedUrl' };

/**
 * 公共存储 URL（`/storage/v1/object/public/...`）。
 */
export type PublicUrl = string & { readonly __brand: 'PublicUrl' };

/**
 * 本地文件 URI（`file://` / `content://` / `ph://` / `assets-library://` 等）。
 */
export type LocalUri = string & { readonly __brand: 'LocalUri' };

/**
 * 任意媒体地址（联合）。
 *
 * 用于「可能是以上任一种」的边界输入，例如 `messages.media_url`
 * （历史数据可能是完整 URL，新数据是相对路径）。
 */
export type MediaAddress = ObjectPath | SignedUrl | PublicUrl | LocalUri | string;

// ---------------------------------------------------------------------------
// 媒体种类
// ---------------------------------------------------------------------------

/**
 * 媒体种类（与 `mediaCache.js#KIND_DIRS` 一致）。
 *
 * 注意：`thumb` 是缩略图缓存目录，不是独立业务媒体类型。
 */
export type MediaCacheKind = 'audio' | 'image' | 'video' | 'thumb';

/**
 * 上传前缀（与 `uploadToSupabase(uri, prefix, userId)` 的 prefix 一致）。
 *
 * 源码实际使用：'audio' / 'vid' / 'img'（见 useMediaUpload 调用方）。
 */
export type MediaUploadPrefix = 'audio' | 'vid' | 'img';

// ---------------------------------------------------------------------------
// 上传结果
// ---------------------------------------------------------------------------

/**
 * `uploadToSupabase()` 成功返回值。
 *
 * 源码：`return { path: fileName, signedUrl };`
 *   - `path`：桶内对象路径（写入 messages.media_url 的值）
 *   - `signedUrl`：首屏秒开用的签名 URL；签名失败时为 null（不阻断上传）
 *
 * 失败时函数返回 `null`（不是抛异常）。
 */
export interface UploadResult {
  path: ObjectPath;
  signedUrl: SignedUrl | null;
}

// ---------------------------------------------------------------------------
// 签名 URL 结果
// ---------------------------------------------------------------------------

/**
 * `createSignedMediaUrl()` / `getSignedUrl()` 的返回。
 *
 * 源码：成功返回 `data?.signedUrl || null`；失败/非法路径返回 `null`。
 * 因此类型为 `SignedUrl | null`。
 */
export type SignedMediaResult = SignedUrl | null;

// ---------------------------------------------------------------------------
// 媒体缓存状态
// ---------------------------------------------------------------------------

/**
 * 本地媒体缓存状态（描述「本地是否已有副本」）。
 *
 * 与地址类型无关：地址回答「在哪」，缓存状态回答「本地有没有」。
 */
export type MediaCacheState =
  | { status: 'absent' }
  | { status: 'cached'; uri: LocalUri }
  | { status: 'downloading' }
  | { status: 'failed'; reason?: string };

/**
 * 媒体缓存身份（与 `mediaCache.js#getMediaCacheIdentity()` 对齐）。
 *
 * 注意：`epoch` 仅用于拒绝迟到异步写回，**不进入**持久化路径/索引键。
 */
export interface MediaCacheIdentitySnapshot {
  ownerId: string | null;
  epoch: number;
}

/**
 * 媒体缓存大小统计（`getMediaCacheSize()` 返回）。
 *
 * 源码：返回字节数（number）。
 */
export type MediaCacheSizeBytes = number;

// ---------------------------------------------------------------------------
// 媒体缓存操作契约（函数签名，供未来 TS 迁移对照）
// ---------------------------------------------------------------------------

/**
 * `persistMedia(uri, msgId, kind)` → 本地 URI | null
 *
 * 身份失效 / 未登录 / 参数非法 → null（fail-closed）。
 */
export type PersistMedia = (
  uri: string,
  msgId: string,
  kind: MediaCacheKind
) => Promise<LocalUri | null>;

/**
 * `resolveLocalMedia(msgId, kind)` → 本地 URI | null
 */
export type ResolveLocalMedia = (
  msgId: string,
  kind: MediaCacheKind
) => Promise<LocalUri | null>;

/**
 * `downloadToSandbox(remoteUrl, msgId, kind)` → 本地 URI | null
 */
export type DownloadToSandbox = (
  remoteUrl: string,
  msgId: string,
  kind: MediaCacheKind
) => Promise<LocalUri | null>;

/**
 * `getMemoryLocalMedia(msgId, kind)` → 本地 URI | null（同步，仅内存索引）
 */
export type GetMemoryLocalMedia = (msgId: string, kind: MediaCacheKind) => LocalUri | null;

// ---------------------------------------------------------------------------
// 存储桶常量
// ---------------------------------------------------------------------------

/**
 * 聊天媒体桶名（私有桶）。
 *
 * 依据：`useMediaUpload.js` / `useSignedMediaUrl.js` 中的 `STORAGE_BUCKET`。
 * RLS 要求对象路径首段 = auth.uid()。
 */
export const CHAT_MEDIA_BUCKET = 'chat_media' as const;

/** 签名 URL 默认有效期（秒）——与源码 SIGNED_URL_TTL 对齐（具体值以源码为准） */
export type SignedUrlTtlSeconds = number;
