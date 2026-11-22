/**
 * 统一结果 / 错误契约（TASK-P1.1 R0）
 *
 * 设计原则：
 *   1. 只描述**真实存在**的运行时形态，不发明字段。
 *   2. 与现有 JS 代码兼容：现有函数返回 `{ ok: true, ... }` / `{ ok: false, reason }`
 *      这类判别联合，本文件将其形式化，不改变任何运行时行为。
 *   3. 不引入第三方依赖，纯类型声明。
 */

/** 通用成功结果 */
export interface OkResult<T = void> {
  ok: true;
  data: T;
}

/** 通用失败结果 */
export interface ErrResult<E = AppError> {
  ok: false;
  error: E;
}

/** 判别联合：成功或失败 */
export type Result<T = void, E = AppError> = OkResult<T> | ErrResult<E>;

/** 构造成功结果（纯函数，无副作用） */
export function ok<T>(data: T): OkResult<T> {
  return { ok: true, data };
}

/** 构造失败结果（纯函数，无副作用） */
export function err<E>(error: E): ErrResult<E> {
  return { ok: false, error };
}

/**
 * 应用级错误码。
 *
 * 说明：这里只收录**代码中真实出现**的错误码族，未出现的错误码不预先编造。
 * - `AUTH_STORAGE_*` 来自 `src/services/authStorage.js` 的 `AUTH_STORAGE_ERROR`。
 * - 推送相关分类来自 `src/services/pushService.js` 的 `PUSH_ERROR_CATEGORY`
 *   （真实取值是**小写**：`auth` / `forbidden` / `target_missing` /
 *   `bad_request` / `server_config` / `upstream`，另加 `http_error` / `network`）。
 */
export type AppErrorCode =
  | 'AUTH_STORAGE_UNAVAILABLE'
  | 'AUTH_STORAGE_MIGRATION_FAILED'
  | 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED'
  | 'auth'
  | 'forbidden'
  | 'target_missing'
  | 'bad_request'
  | 'server_config'
  | 'upstream'
  | 'http_error'
  | 'network'
  | 'UNKNOWN';

/** 应用级错误对象 */
export interface AppError {
  code: AppErrorCode;
  message: string;
  /** 原始异常（可选，便于日志排查） */
  cause?: unknown;
}

/**
 * 推送发送结果（对应 `src/services/pushService.js#sendPushNotification` 的返回值）。
 *
 * 真实返回形态（逐分支核对 pushService.js 第 110–151 行）：
 *   - 成功：`result ?? { ok: true }` —— 云函数成功时返回
 *     `{ ok: true, ticketId }` 或 `{ ok: true, skipped: true, reason }`，
 *     客户端原样透传；最差情况兜底 `{ ok: true }`（**无 status**）。
 *   - 失败（无 HTTP 状态，如纯网络错误 / 缺 receiverId / 异常）：
 *     `{ ok: false, reason }`（**无 status / category**）。
 *   - 失败（有 HTTP 状态）：`{ ok: false, reason, status, category }`。
 *
 * 因此 `status` / `category` 在失败分支都是**可选**，成功分支**没有** status。
 * 上一版把成功分支写成必带 `status: number` 是错误的。
 */
export type PushSendResult =
  | { ok: true; ticketId?: string | null; skipped?: boolean; reason?: string }
  | { ok: false; reason: string; status?: number; category?: AppErrorCode };
