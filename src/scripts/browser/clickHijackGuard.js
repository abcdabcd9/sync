// --- START OF FILE src/scripts/browser/clickHijackGuard.js ---
// 🥇 最前端：捕获阶段点击抢占器（优先级高于网页自身广告脚本）
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动

export const CLICK_HIJACK_GUARD = `
    // 🥇 最前端：捕获阶段点击抢占器（优先级高于网页自身广告脚本）
    (function() {
      if (window.__click_hijack_guard_installed) return;
      window.__click_hijack_guard_installed = true;

      // 保护名单：视频播放器及其内部元素绝不销毁
      var isProtected = function(el) {
        if (!el || !el.tagName) return true;
        var tag = el.tagName.toUpperCase();
        if (tag === 'VIDEO' || tag === 'SOURCE' || tag === 'AUDIO') return true;
        if (el.querySelector && el.querySelector('video, audio')) return true;
        if (el.closest && el.closest('video, audio')) return true;
        return false;
      };

      window.addEventListener('click', function(e) {
        var target = e.target;
        if (!target || !target.tagName) return;

        // 1️⃣ 强行把 target="_blank" 改为当前页打开，防止点击弹新窗口
        var anchor = target.closest ? target.closest('a') : null;
        if (anchor && anchor.getAttribute && anchor.getAttribute('target') === '_blank') {
          anchor.setAttribute('target', '_self');
          anchor.removeAttribute('rel');
        }

        // 2️⃣ 智能粉碎覆盖在页面或播放器上方的透明广告拦截层
        if (isProtected(target)) return;
        var style;
        try { style = window.getComputedStyle(target); } catch (err) { return; }
        if (!style) return;

        if (style.position === 'absolute' || style.position === 'fixed') {
          var z = parseInt(style.zIndex, 10);
          // 超高层级的非视频浮层：直接粉碎，并杀死广告点击事件
          if (!isNaN(z) && z >= 500) {
            try { target.remove(); } catch (err) {}
            e.stopImmediatePropagation();
            e.preventDefault();
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: 1, reason: 'click-hijack' }));
            } catch (err) {}
          }
        }
      }, true); // true = 捕获阶段，优先级高于网页内部脚本！

      // 3️⃣ 彻底冻结 window.open 弹窗
      try {
        window.open = function() { return null; };
        Object.defineProperty(window, 'open', {
          value: function() { return null; },
          writable: false,
          configurable: false
        });
      } catch (err) {}
    })();

    window.alert = function() { return null; };
    window.confirm = function() { return null; };
`;
// --- END OF FILE src/scripts/browser/clickHijackGuard.js ---
