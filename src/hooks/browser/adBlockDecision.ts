// --- START OF FILE src/hooks/browser/adBlockDecision.ts ---
// 🛡️ 广告拦截「WebView 请求是否允许加载」纯决策（P1.3 R1 解耦）
//
// 本模块只承载**一个**解耦维度：网络级请求放行判定。
// 不涉及 React 生命周期、200ms 计数节流、DOM 清理注入、开关切换、卸载清理——
// 这些仍由 useAdBlocker Hook 负责。
//
// 判定顺序必须与解耦前 handleShouldStartLoad 完全一致（短路求值顺序不可变）：
//   1. 安全协议校验：非 https:// / about: → 直接拒绝（不检查广告域名）
//   2. 广告域名黑名单：仅当开关开启时检查；命中 → 拒绝并计数 +1
//   3. 其余 → 放行
//
// 纯函数约束：
//   · 不依赖 React / 原生模块；
//   · 不读取 Hook Ref、不调用 setState、不设置定时器；
//   · 不调用 WebView、不注入脚本；
//   · 不修改安全协议正则 / 广告域名正则 / 短路顺序 / 边界异常行为。

import { isSafeUrl, isAdUrl } from '../../constants/browser';

/**
 * 请求放行决策结果。
 *
 * - `allow: true`  → 允许 WebView 加载该请求
 * - `allow: false` → 拒绝加载
 * - `blockedByAd: true` → 该拒绝是因为命中广告域名（调用方需 bumpBlockedAdCount(1)）
 *   安全协议拒绝时 `blockedByAd` 恒为 false（不计数）。
 */
export interface AdBlockDecision {
  allow: boolean;
  blockedByAd: boolean;
}

/**
 * 判定一个 WebView 请求是否允许加载（纯函数）。
 *
 * @param url            请求 URL（来自 req.url，可能为 undefined / 非字符串）
 * @param adBlockEnabled 当前广告拦截开关状态（由调用方从 Ref 读取后传入）
 * @returns 放行决策；命中广告域名时 `blockedByAd` 为 true
 *
 * ⚠️ 短路顺序（与解耦前逐字一致）：
 *   先 `isSafeUrl`，不通过直接返回（不触碰 isAdUrl）；
 *   再 `adBlockEnabled && isAdUrl`，命中才标记 blockedByAd。
 */
export const decideRequestAllow = (
  url: unknown,
  adBlockEnabled: boolean
): AdBlockDecision => {
  // 1️⃣ 安全协议校验（https / about）——不通过直接拒绝，不检查广告域名
  if (!isSafeUrl(url)) {
    return { allow: false, blockedByAd: false };
  }
  // 2️⃣ 广告域名黑名单（仅开关开启时生效）
  if (adBlockEnabled && isAdUrl(url)) {
    return { allow: false, blockedByAd: true };
  }
  return { allow: true, blockedByAd: false };
};
// --- END OF FILE src/hooks/browser/adBlockDecision.ts ---
