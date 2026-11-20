// --- START OF FILE src/services/pushService.js ---
import { supabase } from './supabase';

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
const PUSH_ERROR_CATEGORY = {
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
const SENSITIVE_PATTERNS = [
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
 * @param {string} input
 * @returns {string}
 */
function sanitizeErrorText(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let out = input;
  for (const re of SENSITIVE_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/**
 * 从 FunctionsHttpError 中提取「脱敏」诊断信息。
 * 只读取 HTTP 状态码与响应体里的 error 字段，绝不读取请求头或 token。
 * 服务端返回的 error 字符串本身也会经过 sanitizeErrorText 二次脱敏。
 *
 * @param {unknown} error - supabase.functions.invoke 抛出的错误对象
 * @returns {Promise<{status: number|null, category: string, serverError: string}>}
 */
async function extractHttpDiagnostics(error) {
  const status =
    typeof error?.context?.status === 'number' ? error.context.status : null;
  const category = status ? PUSH_ERROR_CATEGORY[status] ?? 'http_error' : 'network';

  let serverError = '';
  try {
    const ctx = error?.context;
    if (ctx && typeof ctx.json === 'function') {
      const payload = await ctx.json();
      // 云函数统一返回 { error: string } 或 { error: { code } }
      const raw =
        typeof payload?.error === 'string'
          ? payload.error
          : payload?.error?.code ?? payload?.message ?? '';
      if (typeof raw === 'string') {
        // 先脱敏再截断：即使响应体被污染（含 JWT / Push Token / key），
        // 也不会进入日志或返回值。
        serverError = sanitizeErrorText(raw).slice(0, 120);
      }
    }
  } catch (_) {
    // 响应体不可解析时忽略，仅保留状态码
  }

  return { status, category, serverError };
}

/**
 * @param {string} receiverId - 接收消息的人的 ID (targetId)
 * @param {string} title - 弹窗的加粗标题
 * @param {string} body - 弹窗的详细内容
 * @param {object} data - 附带的暗号数据（用来点击跳转页面）
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, status?: number|null, category?: string}>}
 */
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!receiverId) {
    return { ok: false, reason: 'missing receiverId' };
  }

  try {
    const { data: result, error } = await supabase.functions.invoke('send-push', {
      body: {
        targetUserId: receiverId,
        title,
        body,
        data,
      },
    });

    if (error) {
      const { status, category, serverError } = await extractHttpDiagnostics(error);
      // 脱敏日志：仅状态码 + 类别 + 服务端短错误码，不含 token / 请求头
      console.warn(
        `⚠️ 推送云函数调用失败: status=${status ?? 'n/a'} category=${category}` +
          (serverError ? ` serverError="${serverError}"` : '')
      );
      const reason = serverError || error.message || 'push invoke failed';
      // 契约兼容：无 HTTP 状态（如纯网络错误）时保持旧返回形状 { ok, reason }，
      // 仅在拿到真实状态码时附加 status/category 诊断字段。
      if (status == null) {
        return { ok: false, reason };
      }
      return { ok: false, reason, status, category };
    }

    if (result?.ok === false) {
      console.warn('⚠️ 推送未送达:', result.error ?? result.reason);
      return { ok: false, reason: result.error ?? result.reason };
    }

    return result ?? { ok: true };
  } catch (error) {
    console.warn('⚠️ 发送推送异常:', error?.message ?? error);
    return { ok: false, reason: error?.message ?? String(error) };
  }
}
// --- END OF FILE src/services/pushService.js ---
