// --- START OF FILE src/scripts/browser/index.js ---
// 🧩 注入脚本统一装配入口
// 职责：把分散的脚本片段按原 browser.js 的顺序拼接成完整字符串
// ⚠️ 拼接顺序必须与原 runBeforeLoad 完全一致，否则脚本行为会变化

import { CLICK_HIJACK_GUARD } from './clickHijackGuard';
import { buildAdGuardScript } from './adGuard';
import { PASSIVE_SNIFFER_SCRIPT } from './passiveSniffer';
import { DESKTOP_SPOOF_SCRIPT } from './desktopSpoof';

export { AD_DOM_WATCHER_SCRIPT } from './adDomWatcher';
export { buildAdCleanupScript } from './adCleanup';
export { MANUAL_SNIFF_SCRIPT } from './manualSniff';
export { REMOVE_AD_STYLE_SCRIPT } from './removeAdStyle';

/**
 * 构造 injectedJavaScriptBeforeContentLoaded 脚本
 * 顺序：点击抢占器 → 防弹窗劫持 → 被动嗅探 → (桌面伪装) → true;
 *
 * @param {{ isDesktopMode?: boolean }} options
 * @returns {string}
 */
export const buildBeforeLoadScript = ({ isDesktopMode = false } = {}) => `
${CLICK_HIJACK_GUARD}
${buildAdGuardScript()}
${PASSIVE_SNIFFER_SCRIPT}
${isDesktopMode ? DESKTOP_SPOOF_SCRIPT : ''}
    true;
  `;
// --- END OF FILE src/scripts/browser/index.js ---
