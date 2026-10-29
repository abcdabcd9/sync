// --- START OF FILE src/scripts/browser/desktopSpoof.js ---
// 🖥️ 深度伪装成 macOS 桌面浏览器：让站点 UA 嗅探 + 平台嗅探双重命中桌面版
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动

export const DESKTOP_SPOOF_SCRIPT = `
      (function() {
        // 🖥️ 深度伪装成 macOS 桌面浏览器：让站点 UA 嗅探 + 平台嗅探双重命中桌面版
        var spoof = function(target, prop, value) {
          try {
            Object.defineProperty(target, prop, { get: function() { return value; }, configurable: true });
          } catch (e) {}
        };
        spoof(navigator, 'platform', 'MacIntel');
        spoof(navigator, 'maxTouchPoints', 0);
        spoof(navigator, 'vendor', 'Apple Computer, Inc.');
        spoof(window, 'innerWidth', 1280);
        spoof(window, 'outerWidth', 1280);
        spoof(window, 'devicePixelRatio', 1);

        // 🛡️ 视口重写：document.head 可能尚未创建，需 DOMContentLoaded / documentElement 兜底
        var DESKTOP_VIEWPORT = 'width=1280, initial-scale=1.0, maximum-scale=2.0, user-scalable=yes';
        var applyViewport = function() {
          try {
            var root = document.head || document.documentElement;
            if (!root) return false;
            var meta = document.querySelector('meta[name="viewport"]');
            if (meta) {
              meta.setAttribute('content', DESKTOP_VIEWPORT);
            } else {
              meta = document.createElement('meta');
              meta.setAttribute('name', 'viewport');
              meta.setAttribute('content', DESKTOP_VIEWPORT);
              root.appendChild(meta);
            }
            return true;
          } catch (e) { return false; }
        };

        if (!applyViewport()) {
          document.addEventListener('DOMContentLoaded', applyViewport, { once: true });
          window.addEventListener('load', applyViewport, { once: true });
        }
      })();
`;
// --- END OF FILE src/scripts/browser/desktopSpoof.js ---
