// --- START OF FILE src/scripts/browser/adGuard.js ---
// 🛡️ 第二重：JS 前置注入 —— 防弹窗 / 防跳转劫持
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动
//     AD_DOMAIN_REGEX 通过函数参数插值，避免模块加载时求值

import { AD_DOMAIN_REGEX } from '../../constants/browser';

export const buildAdGuardScript = () => `
    // 🛡️ 第二重：JS 前置注入 —— 防弹窗 / 防跳转劫持
    (function() {
      if (window.__ad_guard_installed) return;
      window.__ad_guard_installed = true;

      var AD_HOST_REGEX = ${AD_DOMAIN_REGEX.toString()};
      var isAdUrl = function(url) {
        if (!url || typeof url !== 'string') return false;
        var host = '';
        try { host = new URL(url, window.location.href).hostname; } catch (e) { host = url; }
        return AD_HOST_REGEX.test(host);
      };

      // 1️⃣ 冻结 window.open：静默返回 null，绝不打开新窗口
      try {
        window.open = function() { return null; };
        Object.defineProperty(window, 'open', {
          value: function() { return null; },
          writable: false,
          configurable: false
        });
      } catch (e) {}

      // 2️⃣ 强力屏蔽 target="_blank"：全部改写为 _self，避免点击触发广告新标签页
      var neutralizeBlankTargets = function() {
        try {
          var links = document.querySelectorAll('a[target="_blank"], a[target=_blank], area[target="_blank"]');
          for (var i = 0; i < links.length; i++) {
            links[i].setAttribute('target', '_self');
            links[i].removeAttribute('rel');
          }
        } catch (e) {}
      };

      // 3️⃣ 防护跳转劫持：拦截非用户主动点击引发的定时器重定向
      //    仅在「无用户手势」时拦截，用户真实点击后的正常跳转不受影响
      var hadUserGesture = false;
      var markGesture = function() { hadUserGesture = true; };

      ['pointerdown', 'touchstart', 'mousedown', 'click', 'keydown'].forEach(function(evt) {
        window.addEventListener(evt, markGesture, { capture: true, passive: true });
      });

      var guardNavigation = function(originalFn, name) {
        return function() {
          var target = arguments[0];
          // 用户主动点击触发的跳转：放行
          if (hadUserGesture) return originalFn.apply(this, arguments);
          // 无用户手势：命中广告域名或任意跨域跳转一律拦截
          if (typeof target === 'string' && (isAdUrl(target) || !/^https?:/i.test(target))) {
            try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', reason: name })); } catch (e) {}
            return undefined;
          }
          return originalFn.apply(this, arguments);
        };
      };

      try {
        var origAssign = window.location.assign.bind(window.location);
        var origReplace = window.location.replace.bind(window.location);
        window.location.assign = guardNavigation(origAssign, 'location.assign');
        window.location.replace = guardNavigation(origReplace, 'location.replace');
      } catch (e) {}

      // 4️⃣ 拦截广告域名的 iframe / script 注入（DOM 级兜底）
      var stripAdNodes = function() {
        try {
          var nodes = document.querySelectorAll('iframe[src], script[src], img[src]');
          for (var i = 0; i < nodes.length; i++) {
            var src = nodes[i].getAttribute('src') || '';
            if (src && isAdUrl(src)) {
              try { nodes[i].remove(); } catch (e) {}
            }
          }
        } catch (e) {}
      };

      var runGuards = function() {
        neutralizeBlankTargets();
        stripAdNodes();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runGuards, { once: true });
      } else {
        runGuards();
      }
      window.addEventListener('load', runGuards, { once: true });

      // 5️⃣ MutationObserver：持续清理动态插入的 _blank 链接与广告节点
      try {
        var observer = new MutationObserver(function() { runGuards(); });
        var startObserve = function() {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
          }
        };
        if (document.body) startObserve();
        else document.addEventListener('DOMContentLoaded', startObserve, { once: true });
      } catch (e) {}
    })();
`;
// --- END OF FILE src/scripts/browser/adGuard.js ---
