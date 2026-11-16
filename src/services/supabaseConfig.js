// --- START OF FILE src/services/supabaseConfig.js ---
/**
 * Supabase 配置解析（纯函数 / 同步 / 无副作用 / 无依赖）
 *
 * 目的：
 *   在创建 Supabase Client 之前，对 EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY
 *   做一次严格的本地静态校验。校验失败时只返回固定错误码，绝不返回可用的
 *   url / key / storageKey，也绝不构造任何客户端。
 *
 * 设计约束（见 06_FINAL_PLAN.md §3）：
 *   1. 纯函数：不读环境变量、不访问网络、不读写存储、不产生日志。
 *   2. 失败仅返回固定错误码，不携带真实输入，避免泄露配置。
 *   3. 成功时 storageKey 严格沿用 `sb-${hostname 首段}-auth-token`，
 *      与既有 SDK 默认规则逐字节一致，正常配置下不会导致用户被登出。
 *   4. 仅允许 https://（本任务批准范围）。http:// 及无显式 scheme 一律拒绝。
 *   5. isSupabaseConfigured 仅表示"通过本地配置校验"，不代表网络连通或认证有效。
 */

// 固定错误码（不包含任何真实配置值）
export const CONFIG_ERROR = Object.freeze({
  MISSING_URL: 'MISSING_URL',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_URL: 'INVALID_URL',
  INVALID_PROTOCOL: 'INVALID_PROTOCOL',
  INVALID_KEY: 'INVALID_KEY',
});

const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0;

// 控制字符（C0 0x00-0x1F 与 DEL 0x7F）。
// 依据：真实 SDK 在把 key 写入 HTTP Headers 时，含 CR/LF/NUL 的值会触发
//   TypeError: Headers.append: "..." is an invalid header value.
// 为避免"配置看似合法、运行期才在请求头构造处抛错"，在解析阶段直接拒绝。
// 注意：仅拒绝控制字符，不校验 JWT 结构、不做凭据真实性验证（不在本任务范围）。
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 解析并校验 Supabase 配置。
 *
 * @param {unknown} rawUrl  EXPO_PUBLIC_SUPABASE_URL 原始值
 * @param {unknown} rawKey  EXPO_PUBLIC_SUPABASE_ANON_KEY 原始值
 * @returns {{ ok: true, url: string, key: string, storageKey: string }
 *          | { ok: false, errors: string[] }}
 */
export function parseSupabaseConfig(rawUrl, rawKey) {
  const errors = [];

  const url = isNonEmptyString(rawUrl) ? rawUrl.trim() : '';
  const key = isNonEmptyString(rawKey) ? rawKey.trim() : '';

  if (!url) errors.push(CONFIG_ERROR.MISSING_URL);
  if (!key) errors.push(CONFIG_ERROR.MISSING_KEY);

  // Key 内嵌控制字符（CR/LF/NUL 等）→ INVALID_KEY。
  // 仅当 key 非空时检查，避免与 MISSING_KEY 重复。
  if (key && CONTROL_CHARS.test(key)) {
    errors.push(CONFIG_ERROR.INVALID_KEY);
  }

  let parsed = null;
  if (url) {
    // 显式要求 scheme：URL 构造器对 "abc.supabase.co" 这类无 scheme 输入
    // 会宽松地当作相对路径处理，必须提前拦截。
    if (!/^https:\/\//i.test(url)) {
      // 区分"协议错误"与"完全非法"：含 :// 但不是 https 视为协议错误
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        errors.push(CONFIG_ERROR.INVALID_PROTOCOL);
      } else {
        errors.push(CONFIG_ERROR.INVALID_URL);
      }
    } else {
      try {
        parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
          errors.push(CONFIG_ERROR.INVALID_PROTOCOL);
        }
        // hostname 必须存在，且首段（第一个 '.' 之前）非空。
        // 否则会生成 "sb--auth-token" 这类脏 storageKey（如 https://.example.com）。
        const hostnameFirstLabel = parsed.hostname
          ? parsed.hostname.split('.')[0]
          : '';
        if (!parsed.hostname || !hostnameFirstLabel) {
          errors.push(CONFIG_ERROR.INVALID_URL);
        }
        // 禁止 URL 内嵌凭据（user:pass@host）
        if (parsed.username || parsed.password) {
          errors.push(CONFIG_ERROR.INVALID_URL);
        }
      } catch {
        errors.push(CONFIG_ERROR.INVALID_URL);
      }
    }
  }

  // 去重（同一错误码可能被多条规则命中）
  const uniqueErrors = [...new Set(errors)];

  if (uniqueErrors.length > 0) {
    // 失败：不返回 url / key / storageKey
    return { ok: false, errors: uniqueErrors };
  }

  // 成功：storageKey 与既有 SDK 默认规则逐字节一致
  const storageKey = `sb-${parsed.hostname.split('.')[0]}-auth-token`;

  return { ok: true, url, key, storageKey };
}
// --- END OF FILE src/services/supabaseConfig.js ---
