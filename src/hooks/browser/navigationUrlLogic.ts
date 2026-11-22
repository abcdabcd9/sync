// --- START OF FILE src/hooks/browser/navigationUrlLogic.ts ---
/**
 * 🧭 浏览器导航 URL 决策纯函数（TASK-P1.3 R0 解耦）
 *
 * 背景
 *   这些判定原先内联在 `useBrowserNavigation.js` 的 useCallback 中，
 *   与 React 状态 / Ref / 定时器 / WebView 副作用混在一起，无法独立测试。
 *   本模块只承载**纯字符串决策**，不持有任何状态、不产生任何副作用。
 *
 * 严格约束（行为契约冻结）
 *   - 本模块的每个函数必须与解耦前内联实现**逐字节等价**。
 *   - 不得改变正则、大小写敏感性、trim 时机、判断顺序。
 *   - 副作用（loadUrl / emitCommand / goCinema / setState / injectJavaScript）
 *     一律留在 Hook 内，本模块只返回决策结果。
 *
 * 真实来源（解耦前 useBrowserNavigation.js）
 *   - resolveSubmitTarget  ← handleSubmitUrl L130–156
 *   - rewriteDesktopHost   ← toggleDesktopMode L164–172
 *   - shouldSyncInputUrl   ← handleNavigationStateChange L202
 */

import { isSafeUrl } from '../../constants/browser';

/** 直链视频扩展名判定（与解耦前 L140 完全一致） */
const DIRECT_VIDEO_REGEX = /\.(mp4|m3u8)(\?.*)?$/i;
/** 明文 http:// 前缀（与解耦前 L136 完全一致） */
const HTTP_PREFIX_REGEX = /^http:\/\//i;
/** 已加密 https:// 前缀（与解耦前 L150 完全一致） */
const HTTPS_PREFIX_REGEX = /^https:\/\//i;
/** 桌面模式：m./wap. → www.（与解耦前 L169 完全一致） */
const TO_DESKTOP_HOST_REGEX = /^(https?:\/\/)(m|wap)\./i;
/** 移动模式：www. → m.（与解耦前 L171 完全一致） */
const TO_MOBILE_HOST_REGEX = /^(https?:\/\/)www\./i;

/** Bing 搜索入口（与解耦前 L151 完全一致） */
const BING_SEARCH_PREFIX = 'https://cn.bing.com/search?q=';

/**
 * `handleSubmitUrl` 的纯决策结果。
 *
 * - `kind: 'empty'`   → 输入为空，调用方直接 return（无任何副作用）
 * - `kind: 'video'`   → 直链视频，调用方执行 loadUrl + emitCommand('PLAY') + goCinema
 * - `kind: 'navigate'`→ 普通导航，调用方 setCurrentUrl + 更新 actualLoadedUrl + LayoutAnimation
 */
export type SubmitTarget =
  | { kind: 'empty' }
  | { kind: 'video'; url: string }
  | { kind: 'navigate'; url: string };

/**
 * 解析地址栏提交目标（纯函数）。
 *
 * 判定顺序必须与解耦前完全一致：
 *   1. trim 后为空 → empty
 *   2. 明文 http:// → 升级为 https://（必须先于直链视频判断，安全审计 #25）
 *   3. 命中直链视频扩展名 → video
 *   4. 非 https:// → 拼接 Bing 搜索
 *   5. 其余 → navigate
 *
 * ⚠️ 运行时语义（P1.3 R1 修复）
 *   解耦前实现为 `inputUrl.trim()` —— 直接调用，非字符串输入会抛出
 *   `TypeError: inputUrl.trim is not a function`。本函数必须保持该语义：
 *   参数类型声明为 `string`，并直接调用 `.trim()`，**不得**增加
 *   `typeof` 防御性判断把异常吞掉（否则与冻结基线行为不等价）。
 *   参数名必须保持为 `inputUrl`：V8 的 TypeError 消息会带上标识符名
 *   （`inputUrl.trim is not a function`），改名会改变可观测异常消息。
 */
export const resolveSubmitTarget = (inputUrl: string): SubmitTarget => {
  const trimmed = inputUrl.trim();
  if (!trimmed) return { kind: 'empty' };

  let target = trimmed;

  // 🔒 安全审计 #25：明文 http:// 一律升级为 https://（必须先于直链视频判断）
  if (HTTP_PREFIX_REGEX.test(target)) {
    target = target.replace(HTTP_PREFIX_REGEX, 'https://');
  }

  if (DIRECT_VIDEO_REGEX.test(target)) {
    return { kind: 'video', url: target };
  }

  // 非 http(s) 输入走 Bing 搜索
  if (!HTTPS_PREFIX_REGEX.test(target)) {
    target = BING_SEARCH_PREFIX + encodeURIComponent(target);
  }

  return { kind: 'navigate', url: target };
};

/**
 * 桌面 / 移动模式主机名改写（纯函数）。
 *
 * 仅改写主机名部分，避免误伤 path / query 中的 "://m." 片段。
 * 与解耦前 toggleDesktopMode 的 deskUrl 计算完全一致。
 *
 * @param targetUrl 当前真实已加载 URL
 * @param nextMode  true = 切到桌面版（m./wap. → www.）；false = 切到移动版（www. → m.）
 * @returns 改写后的 URL；若无需改写则返回原值（引用相等）
 */
export const rewriteDesktopHost = (targetUrl: string, nextMode: boolean): string => {
  if (nextMode) {
    return targetUrl.replace(TO_DESKTOP_HOST_REGEX, '$1www.');
  }
  return targetUrl.replace(TO_MOBILE_HOST_REGEX, '$1m.');
};

/**
 * 导航状态变化时是否应同步地址栏 inputUrl（纯函数）。
 *
 * 与解耦前 handleNavigationStateChange L202 的判定完全一致：
 *   isSafeUrl(url) && url !== inputUrl && !url.includes('cn.bing.com')
 */
export const shouldSyncInputUrl = (url: unknown, inputUrl: unknown): boolean => {
  if (!isSafeUrl(url)) return false;
  if (url === inputUrl) return false;
  if (typeof url === 'string' && url.includes('cn.bing.com')) return false;
  return true;
};
// --- END OF FILE src/hooks/browser/navigationUrlLogic.ts ---
