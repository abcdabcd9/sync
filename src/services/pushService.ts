// --- START OF FILE src/services/pushService.ts ---
import { supabase } from './supabase';
import type { PushSendResult } from '../types/result';
import type { PushErrorCategory } from '../types/push';
import type { SendPushRequest } from '../types/edge';

/**
 * 发送推送弹窗。
 *
 * 🔒 安全说明：
 *   客户端不再直接调用 Expo Push API，也不再查询他人的 expo_push_token。
 *   所有敏感操作（JWT 校验、权限校验、Token 查询、调用 Expo）都在
 *   Supabase Edge Function `send-push` 内部完成。
 *
 * 🔍 诊断说明（P0.4 FIX-C）：
 *   `supabase.functions.invoke` 在非 2xx 时抛出 FunctionsHttpError，其
 *   `message` 恒为「Edge Function returned a non-2xx status code」，
 *   丢失了真正的 HTTP 状态码与服务端错误码，导致无法区分
 *   401（JWT/会话）/ 403（好友或推送授权）/ 404（目标用户缺失）/
 *   500（云函数配置或内部错误）/ 502（Expo Push 调用失败）。
 *   这里只读取 `error.context` 的 HTTP 状态与响应体中的稳定错误码，
 *   用于脱敏日志与返回 reason，**不改变任何鉴权/授权逻辑**。
 *
 * 🚫 脱敏红线：绝不输出 JWT、access_token、refresh_token、Push Token、
 *   service_role key 或任何请求头。仅输出 HTTP 状态码、错误类别与
 *   服务端返回的短错误码/描述（截断）。
 */

// 服务端错误码 → 稳定类别（与 send-push 云函数返回的 error 字段对齐）
const PUSH_ERROR_CATEGORY: Record<number, PushErrorCategory> = {
  401: 'auth', // JWT 缺失/过期/无效
  403: 'forbidden', // 无社交关系 / 发送者资料缺失
  404: 'target_missing', // 目标用户资料缺失
  400: 'bad_request', // 参数非法
  405: 'bad_request',
  500: 'server_config', // 云函数环境变量缺失 / 内部错误
  502: 'upstream', // Expo Push 服务调用失败
};

// 敏感串特征（用于对「服务端返回的错误字符串」做二次脱敏）。
// 即使云函数本应只返回稳定错误码，也必须假设响应体可能被污染
// （例如上游把 token 拼进错误信息、代理注入调试信息等），
// 因此任何进入日志/返回值的字符串都必须先经过此过滤器。
const SENSITIVE_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /ExponentPushToken\[[^\]]*\]/gi, // Expo Push Token
  /ExpoPushToken\[[^\]]*\]/gi, // Expo Push Token（旧格式）
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer xxx
  /\bsb_secret_[A-Za-z0-9_-]+/gi, // Supabase secret key
  /\bservice_role[A-Za-z0-9_-]*/gi, // service_role key 片段
  /\b(?:access|refresh)_token\b\s*[:=]\s*\S+/gi, // token 键值对
];

/**
 * 对任意字符串做脱敏：命中敏感特征一律替换为 [REDACTED]。
 * 这是「纵深防御」——不依赖上游一定不泄露，而是本地兜底。
 *
 * @param input 待脱敏字符串
 * @returns 脱敏后的字符串
 */
function sanitizeErrorText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  let out = input;
  for (const re of SENSITIVE_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/**
 * `supabase.functions.invoke` 抛出的错误对象的最小结构视图。
 *
 * 说明：SDK 的 `FunctionsError.context` 类型为 `any`，这里用结构化接口
 * 精确描述我们**实际读取**的字段（status / json），避免 `any` 泄漏。
 */
interface FunctionsErrorContext {
  status?: unknown;
  json?: () => Promise<unknown>;
}

interface FunctionsErrorLike {
  message?: unknown;
  context?: FunctionsErrorContext | null;
}

/**
 * `send-push` 云函数响应体的结构化视图。
 *
 * 与 `src/types/edge.ts#SendPushResponse` 契约一致，但额外容纳运行时
 * 可能出现的 `{ ok: false, reason }` 形态（原 JS 用 `result.error ?? result.reason`
 * 兼容读取）。字段全部可选，本函数按 `ok` 判别后安全读取。
 *
 * ⚠️ 等价性约束（P1.2 R4 修复）：原 JS 成功分支是 `return result ?? { ok: true }`，
 * 即**原样透传**云函数返回的任意对象（包括 `{}`、`{ ticketId }`、`{ ok: 1 }`、
 * 甚至 `false` 这类非对象值）。因此本视图必须允许任意附加字段，且 `ok` 不得
 * 被收窄为 `boolean` —— 否则类型系统会诱导实现去「修正」运行时值。
 */
interface InvokeResultPayload {
  ok?: unknown;
  ticketId?: unknown;
  skipped?: unknown;
  reason?: unknown;
  error?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

/** 从任意错误对象中安全读取 `context`（不信任其形状）。 */
function readErrorContext(error: unknown): FunctionsErrorContext | null {
  if (typeof error !== 'object' || error === null) return null;
  const ctx = (error as FunctionsErrorLike).context;
  if (typeof ctx !== 'object' || ctx === null) return null;
  return ctx;
}

/** 从任意错误对象中安全读取 `message`（仅当为字符串时）。 */
function readErrorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const msg = (error as FunctionsErrorLike).message;
  return typeof msg === 'string' ? msg : null;
}

/**
 * 从 FunctionsHttpError 中提取「脱敏」诊断信息。
 * 只读取 HTTP 状态码与响应体里的 error 字段，绝不读取请求头或 token。
 * 服务端返回的 error 字符串本身也会经过 sanitizeErrorText 二次脱敏。
 *
 * @param error supabase.functions.invoke 抛出的错误对象
 */
async function extractHttpDiagnostics(error: unknown): Promise<{
  status: number | null;
  category: PushErrorCategory;
  serverError: string;
}> {
  const ctx = readErrorContext(error);
  const status =
    ctx && typeof ctx.status === 'number' ? ctx.status : null;
  const category: PushErrorCategory = status
    ? PUSH_ERROR_CATEGORY[status] ?? 'http_error'
    : 'network';

  let serverError = '';
  try {
    if (ctx && typeof ctx.json === 'function') {
      const payload: unknown = await ctx.json();
      // 云函数统一返回 { error: string } 或 { error: { code } }
      const raw = extractServerErrorText(payload);
      if (typeof raw === 'string') {
        // 先脱敏再截断：即使响应体被污染（含 JWT / Push Token / key），
        // 也不会进入日志或返回值。
        serverError = sanitizeErrorText(raw).slice(0, 120);
      }
    }
  } catch {
    // 响应体不可解析时忽略，仅保留状态码
  }

  return { status, category, serverError };
}

/**
 * 从响应体 payload 中提取服务端错误文本。
 * 兼容 `{ error: string }` / `{ error: { code } }` / `{ message }` 三种形态。
 */
function extractServerErrorText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const obj = payload as { error?: unknown; message?: unknown };
  if (typeof obj.error === 'string') return obj.error;
  if (typeof obj.error === 'object' && obj.error !== null) {
    const code = (obj.error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  if (typeof obj.message === 'string') return obj.message;
  return '';
}

/**
 * @param receiverId 接收消息的人的 ID (targetId)
 * @param title 弹窗的加粗标题
 * @param body 弹窗的详细内容
 * @param data 附带的暗号数据（用来点击跳转页面）
 */
export async function sendPushNotification(
  receiverId: string,
  title: string,
  body: string,
  data: SendPushRequest['data'] = {},
): Promise<PushSendResult> {
  if (!receiverId) {
    return { ok: false, reason: 'missing receiverId' };
  }

  try {
    // 以结构化视图接收云函数响应：运行时可能返回成功体
    // `{ ok: true, ticketId }` / `{ ok: true, skipped, reason }`，
    // 也可能返回失败体 `{ ok: false, error }` / `{ ok: false, reason }`。
    // 该视图精确描述本函数**实际读取**的字段，避免对联合类型做不安全断言。
    const { data: result, error } = await supabase!.functions.invoke<InvokeResultPayload>(
      'send-push',
      {
        body: {
          targetUserId: receiverId,
          title,
          body,
          data,
        },
      },
    );

    if (error) {
      const { status, category, serverError } = await extractHttpDiagnostics(error);
      // 脱敏日志：仅状态码 + 类别 + 服务端短错误码，不含 token / 请求头
      console.warn(
        `⚠️ 推送云函数调用失败: status=${status ?? 'n/a'} category=${category}` +
          (serverError ? ` serverError="${serverError}"` : '')
      );
      const reason = serverError || readErrorMessage(error) || 'push invoke failed';
      // 契约兼容：无 HTTP 状态（如纯网络错误）时保持旧返回形状 { ok, reason }，
      // 仅在拿到真实状态码时附加 status/category 诊断字段。
      if (status == null) {
        return { ok: false, reason };
      }
      return { ok: false, reason, status, category };
    }

    // 运行时可能返回 `{ ok: false, error }`（HTTP 200 但 ticket 失败）或
    // `{ ok: false, reason }`；这里用结构化读取兼容两种失败文本字段。
    //
    // ⚠️ 等价性约束：原 JS 是 `reason: result.error ?? result.reason`，
    // 当两者都不存在时 reason 为 `undefined`（**不是** `''`）。此处不得补 `?? ''`。
    if (result?.ok === false) {
      const failure = result.error ?? result.reason;
      console.warn('⚠️ 推送未送达:', failure);
      return { ok: false, reason: failure as string };
    }

    // 成功分支：与原 JS `return result ?? { ok: true }` **逐字等价**。
    // 原样透传云函数返回的任意值（`{}` / `{ ticketId }` / `{ ok: 1 }` /
    // `{ ok: true, delivered: true }` / 甚至 `false`），仅在 `null`/`undefined`
    // 时兜底 `{ ok: true }`。不得强制补 `ok: true`，不得丢弃附加字段。
    //
    // 类型说明：`PushSendResult` 是面向调用方的**契约收窄**（成功分支必带
    // `ok: true`），而云函数运行时可能返回契约外的形态。为保持运行时等价，
    // 这里在「已确认无 error 且非 ok:false」的可信边界上做一次最小断言，
    // 不改变任何运行时值。
    return (result ?? { ok: true }) as PushSendResult;
  } catch (error) {
    console.warn('⚠️ 发送推送异常:', readErrorMessage(error) ?? error);
    return { ok: false, reason: readErrorMessage(error) ?? String(error) };
  }
}
// --- END OF FILE src/services/pushService.ts ---
