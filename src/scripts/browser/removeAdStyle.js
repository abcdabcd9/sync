// --- START OF FILE src/scripts/browser/removeAdStyle.js ---
// 🛡️ 关闭广告拦截时：立即移除已注入的隐藏样式，恢复页面原貌
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动

export const REMOVE_AD_STYLE_SCRIPT = `
        (function() {
          try {
            var s = document.getElementById('__ad_block_style__');
            if (s && s.parentNode) s.parentNode.removeChild(s);
          } catch (e) {}
        })();
        true;
      `;
// --- END OF FILE src/scripts/browser/removeAdStyle.js ---
