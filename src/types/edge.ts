/**
 * Edge Functions 边界契约（TASK-P1.1 R0 / Phase C6）
 *
 * ============================================================================
 * 契约来源（逐分支核对，非猜测）
 * ============================================================================
 *   - `supabase/functions/send-push/index.ts`
 *       PushPayload / 全部 json() 响应分支 / 状态码
 *   - `supabase/functions/transcribe-audio/index.ts`
 *       ERR / ERR_MESSAGE / 成功 `{ text }` / 失败 `{ error: { code, message } }`
 *
 * ============================================================================
 * 设计原则
 * ============================================================================
 *   1. **复用既有权威契约，避免两套漂移枚举**：
 *        - 转写错误码复用 `transcription.ts#TranscribeErrorCode`
 *        - 推送错误类别复用 `push.ts#PushErrorCategory`
 *      本文件只声明「云函数 HTTP 边界」的请求/响应形态，不重复定义枚举。
 *   2. 云函数响应均为 JSON；成功/失败通过 HTTP 状态码 + body 形态区分。
 *   3. **不修改** Edge Function 业务代码，仅描述其对外契约。
 */

import type { TranscribeErrorCode, TranscribeSuccessResponse } from './transcription';
import type { PushErrorCategory } from './push';

// ===========================================================================
// 一、send-push 边界
// ===========================================================================

/**
 * `send-push` 请求体（客户端 → 云函数）。
 *
 * 源码：`interface PushPayload { targetUserId?, title?, body?, data? }`（L36-41）
 *
 * 注意：字段全部可选（服务端逐项校验），但实际调用应提供 targetUserId。
 */
export interface SendPushRequest {
  targetUserId?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

/**
 * `send-push` 成功响应。
 *
 * 源码分支（`supabase/functions/send-push/index.ts`）：
 *   - L287 `return json({ ok: true, ticketId: ticket?.id ?? null })`（正常发送）
 *   - L224 `return json({ ok: true, skipped: true, reason: 'target has no push token' })`
 *
 * **重要**：`ticketId` 为 `ticket?.id ?? null`，即 Expo 未返回 ticket.id 时为 `null`。
 * 因此 `ticketId` 类型必须是 `string | null`，**不得**建模为必然存在的 `string`。
 */
export type SendPushSuccessResponse =
  | { ok: true; ticketId: string | null }
  | { ok: true; skipped: true; reason: string };

/**
 * `send-push` 失败响应。
 *
 * 源码分支（`json({ error: ... }, status)`）：
 *   - 405 `{ error: 'Method not allowed' }`
 *   - 401 `{ error: 'Missing or malformed Authorization header' }`
 *   - 401 `{ error: 'Invalid or expired token' }`
 *   - 400 `{ error: 'Invalid JSON body' }`
 *   - 400 `{ error: 'targetUserId is required' }`
 *   - 400 `{ error: 'body is required (max 500 chars)' }`
 *   - 400 `{ error: 'Cannot push to yourself' }`
 *   - 403 `{ error: 'Sender profile not found' }`
 *   - 403 `{ error: 'Not authorized to push to this user' }`
 *   - 404 `{ error: 'Target profile not found' }`
 *   - 500 `{ error: 'Server misconfigured' }`
 *   - 502 `{ error: 'Expo push failed', status }`
 *   - 502 `{ error: 'Failed to reach Expo push service' }`
 *   - 200 `{ ok: false, error: ticket.message }`（Expo 返回 ticket 错误）
 *
 * 说明：`error` 为字符串；部分分支附带 `status`（Expo 上游状态码）。
 */
export interface SendPushErrorResponse {
  error: string;
  status?: number;
}

/**
 * `send-push` 响应联合。
 *
 * 判别：成功分支必有 `ok: true`；失败分支有 `error` 字符串。
 * 注意存在 `{ ok: false, error }`（HTTP 200 但 ticket 失败）这一特殊形态，
 * 因此不能仅凭 HTTP 状态判断成功。
 */
export type SendPushResponse =
  | SendPushSuccessResponse
  | SendPushErrorResponse
  | { ok: false; error: string };

/** 类型守卫：是否为 send-push 成功响应 */
export function isSendPushSuccess(r: SendPushResponse): r is SendPushSuccessResponse {
  return (r as SendPushSuccessResponse).ok === true;
}

/**
 * `send-push` 错误类别映射（HTTP 状态 → 类别）。
 *
 * 源码：`pushService.js#PUSH_ERROR_CATEGORY`（客户端侧映射，非云函数返回）。
 * 此处仅作边界文档，实际类别由客户端 `pushService.js` 计算。
 */
export type SendPushHttpStatusToCategory = Partial<Record<number, PushErrorCategory>>;

// ===========================================================================
// 二、transcribe-audio 边界
// ===========================================================================

/**
 * `transcribe-audio` 请求为 `multipart/form-data`，字段 `file`。
 *
 * 说明：只接受 POST；字段名固定 'file'；音频 MIME/扩展名需在白名单内。
 */
export interface TranscribeAudioRequest {
  /** 音频文件（运行时为 File/Blob，字段名固定 'file'） */
  file: unknown;
}

/**
 * `transcribe-audio` 成功响应（复用 transcription.ts）。
 */
export type TranscribeAudioSuccessResponse = TranscribeSuccessResponse;

/**
 * `transcribe-audio` 失败响应。
 *
 * 源码：`fail(code, status)` → `{ error: { code, message } }`
 * 错误码复用 `TranscribeErrorCode`（封闭联合）。
 */
export interface TranscribeAudioErrorResponse {
  error: {
    code: TranscribeErrorCode;
    message: string;
  };
}

/** `transcribe-audio` 响应联合 */
export type TranscribeAudioResponse =
  | TranscribeAudioSuccessResponse
  | TranscribeAudioErrorResponse;

/** 类型守卫：是否为 transcribe-audio 失败响应 */
export function isTranscribeAudioError(
  r: TranscribeAudioResponse
): r is TranscribeAudioErrorResponse {
  return typeof (r as TranscribeAudioErrorResponse).error === 'object'
    && (r as TranscribeAudioErrorResponse).error !== null;
}

// ===========================================================================
// 三、云函数名称清单（编译期清单）
// ===========================================================================

/** 已建模的 Edge Function 名称 */
export type EdgeFunctionName = 'send-push' | 'transcribe-audio';
