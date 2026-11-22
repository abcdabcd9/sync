/**
 * 语音转写 / 配额契约（TASK-P1.1 R0 / Phase C5）
 *
 * ============================================================================
 * 契约来源（逐分支核对，非猜测）
 * ============================================================================
 *   - `supabase/functions/transcribe-audio/index.ts`
 *       ERR 稳定错误码 / ERR_MESSAGE / 成功响应 `{ text }` / 失败响应 `{ error: { code, message } }`
 *   - `supabase/migrations/24_语音转写配额表与原子预占RPC_transcribe_quota.sql`
 *       transcribe_quota_windows / transcribe_quota_reservations 表结构
 *   - `supabase/migrations/26_配额清理改为低频非阻塞_transcribe_quota_cleanup.sql`
 *       transcribe_quota_reserve 签名
 *   - `src/components/ChatInputBar.js`（客户端调用方，消费 `{ text }` / `{ error }`）
 *
 * ============================================================================
 * 边界原则
 * ============================================================================
 *   1. Edge Function 的**客户端可见**响应只有两种：
 *        - 成功：`{ text: string }`
 *        - 失败：`{ error: { code, message } }`
 *      本文件以 `TranscribeSuccessResponse` / `TranscribeErrorResponse` 建模。
 *   2. 配额表（transcribe_quota_windows / reservations）**仅 service_role 可见**，
 *      客户端**不得**直接查询。其 Row 类型已在 database.ts 声明，
 *      本文件仅补充「配额窗口/预占」的领域语义视图，并明确标注仅供服务端。
 *   3. 稳定错误码是**封闭联合**（源码 `ERR` 为 `as const`），客户端据此展示文案，
 *      不解析上游原文。
 */

// ---------------------------------------------------------------------------
// 稳定错误码（封闭联合，与 Edge Function ERR 完全一致）
// ---------------------------------------------------------------------------

/**
 * 转写稳定错误码。
 *
 * 源码：`const ERR = { ... } as const;`（transcribe-audio/index.ts L62-74）
 *
 * 客户端据此展示 `ERR_MESSAGE` 文案，**不解析**上游原文。
 */
export type TranscribeErrorCode =
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'QUOTA_EXCEEDED'
  | 'QUOTA_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

// ---------------------------------------------------------------------------
// 响应契约
// ---------------------------------------------------------------------------

/**
 * 转写成功响应。
 *
 * 源码：`return json({ text });`（L578）
 */
export interface TranscribeSuccessResponse {
  text: string;
}

/**
 * 转写失败响应。
 *
 * 源码：`fail(code, status)` → `json({ error: { code, message } }, status)`（L97-99）
 */
export interface TranscribeErrorResponse {
  error: {
    code: TranscribeErrorCode;
    message: string;
  };
}

/**
 * 转写响应联合（客户端需先判别 `error` 是否存在）。
 */
export type TranscribeResponse = TranscribeSuccessResponse | TranscribeErrorResponse;

/** 类型守卫：是否为失败响应 */
export function isTranscribeError(r: TranscribeResponse): r is TranscribeErrorResponse {
  return typeof (r as TranscribeErrorResponse).error === 'object'
    && (r as TranscribeErrorResponse).error !== null;
}

// ---------------------------------------------------------------------------
// 请求契约（客户端 → Edge Function）
// ---------------------------------------------------------------------------

/**
 * 转写请求为 `multipart/form-data`，字段 `file`（音频文件）。
 *
 * 说明：Edge Function 只接受 POST + multipart，字段名固定为 `file`。
 * 本类型描述客户端应构造的形态，不替代 FormData 运行时对象。
 */
export interface TranscribeRequestFields {
  /** 音频文件（必填，字段名固定 'file'） */
  file: unknown; // 运行时为 File / Blob
}

// ---------------------------------------------------------------------------
// 配额领域视图（仅供服务端，客户端禁止直接查询）
// ---------------------------------------------------------------------------

/**
 * 配额窗口领域视图（对应 transcribe_quota_windows 行）。
 *
 * ⚠️ 仅供 `transcribe-audio` Edge Function / 定时任务使用。
 * 客户端**不得**直接查询该表（RLS 默认拒绝，仅 service_role 可访问）。
 */
export interface TranscribeQuotaWindow {
  scope: 'user' | 'global';
  subjectId: string;
  windowStart: string;
  reqCount: number;
  byteCount: number;
  updatedAt: string;
}

/**
 * 配额预占领域视图（对应 transcribe_quota_reservations 行）。
 *
 * ⚠️ 仅供服务端使用。
 */
export interface TranscribeQuotaReservation {
  reservationId: string;
  userId: string;
  bytes: number;
  windowStart: string;
  status: 'reserved' | 'released';
  createdAt: string;
  releasedAt: string | null;
}

// ---------------------------------------------------------------------------
// 配额限制配置（Edge Function LIMITS，仅供文档/服务端参考）
// ---------------------------------------------------------------------------

/**
 * 转写配额限制配置（来自 Edge Function 环境变量，含默认值）。
 *
 * ⚠️ 仅供服务端参考；客户端不应依赖具体数值（由服务端权威决定）。
 */
export interface TranscribeLimits {
  maxBytes: number;
  maxDurationSec: number;
  userMaxRequests: number;
  userMaxBytes: number;
  globalMaxRequests: number;
  globalMaxBytes: number;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  requestDeadlineMs: number;
}
