// --- START OF FILE src/hooks/cinema/videoSource.ts ---
// 🎬 播放源构造（P1.4 R4 有界解耦）
//
// 从 `src/hooks/useCinema.js` 原样提取的**纯函数**与常量：
//   · 无 Hook 调用、无 state、无 ref、无定时器、无 I/O；
//   · 唯一「副作用」是 `new URL(referer).origin` 的纯计算（异常被 try/catch 吞掉）。
//
// 提取目的：让防盗链头部构造逻辑可被独立测试，同时保持 `useCinema` 内调用表达式逐字不变。
// 行为契约（迁移前后必须完全一致）：
//   · 空 url → null
//   · 非 http(s) url → 原样返回（string）
//   · http(s) url → { uri, headers: { 'User-Agent': MOBILE_UA, [Referer], [Origin] } }
//   · referer 非 http(s) → 不附加 Referer / Origin

/**
 * iOS 防盗链修复用的移动端 UA。
 *
 * 背景：m3u8 在 WebView 里能播（带 Referer / Cookie），但 expo-video 的原生播放器
 * （iOS AVPlayer）直接请求时不带 Referer，被 CDN 以 HTTP 403 Forbidden 拒绝
 * （CoreMediaErrorDomain -12660）。这里把播放源包装成 VideoSourceObject，
 * 附带 Referer（剧集播放页）与移动 UA，让原生播放器请求带上与 WebView 一致的头部。
 */
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 随视频请求发送的头部集合。
 *
 * 索引签名必须为 `string`（而非 `string | undefined`），才能与 expo-video
 * `VideoSourceObject.headers?: Record<string, string>` 结构兼容。
 * `Referer` / `Origin` 为可选属性：仅在 referer 为 http(s) 时写入，
 * 因此运行时对象上「不存在该键」而非「键值为 undefined」——与迁移前一致。
 *
 * 注：可选键与 `string` 索引签名在 TS 下天然冲突（可选键隐含 undefined），
 * 故此处不声明可选键，统一由索引签名表达；构造处用 `as` 断言收窄，
 * 不改变运行时形态（迁移前为普通对象字面量）。
 */
export interface VideoSourceHeaders {
  'User-Agent': string;
  [key: string]: string;
}

/** `buildVideoSource` 对 http(s) 源返回的对象形态（与 expo-video `VideoSourceObject` 兼容）。 */
export interface VideoSourceResult {
  uri: string;
  headers: VideoSourceHeaders;
}

/**
 * 构造带防盗链头部的播放源。
 *
 * 说明：expo-video 的 `VideoSourceObject.headers` 会把头部随「视频请求」一起发送
 * （官方文档：Only for Android/iOS — Specifies headers sent with the video request）。
 * 这里附加 Referer（剧集播放页）+ 移动 UA + Origin，绕过常见 CDN 的防盗链校验。
 * 注：Cookie 需要原生 CookieManager（@react-native-cookies/cookies）才能读取，
 * 本项目未安装该原生依赖，故不注入 Cookie，避免引入需重新构建的依赖。
 *
 * @param url 媒体地址（可为 null / undefined / 空串 / 非 http(s)）
 * @param referer 剧集播放页地址（用于 Referer / Origin）
 * @returns `null`（空 url）| 原样 url（非 http(s)）| `{ uri, headers }`（http(s)）
 */
export function buildVideoSource(
  url: string | null | undefined,
  referer: string | null | undefined,
): string | null | VideoSourceResult {
  if (!url) return null;
  // 仅对 http(s) 媒体源附加头部；本地/空源原样返回
  if (!/^https?:/i.test(url)) return url;
  const headers: VideoSourceHeaders = { 'User-Agent': MOBILE_UA };
  if (referer && /^https?:/i.test(referer)) {
    headers.Referer = referer;
    // 部分 CDN 校验 Origin，一并带上（取 referer 的 origin）
    try {
      headers.Origin = new URL(referer).origin;
    } catch (_e) {
      // 非法 referer：忽略 Origin，保持与迁移前一致
    }
  }
  return { uri: url, headers };
}
// --- END OF FILE src/hooks/cinema/videoSource.ts ---
