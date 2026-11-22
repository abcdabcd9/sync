// --- START OF FILE src/scripts/browser/adDomWatcher.js ---
// 👁️ 实时 DOM 监视器：MutationObserver 秒级销毁动态插入的广告元素
//    ⚠️ 安全红线：命中保护名单（video / audio / 含 video 的容器）一律跳过
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动

export const AD_DOM_WATCHER_SCRIPT = `
    (function() {
      if (window.__ad_dom_watcher_installed) return;
      window.__ad_dom_watcher_installed = true;

      // 广告元素选择器（仅针对明确的广告特征，避免误伤）
      var AD_SELECTOR = [
        '[id*="pop"]',
        '[class*="ad-"]',
        'iframe[src*="ad"]',
        '[style*="z-index: 999"]',
        '[style*="z-index:999"]'
      ].join(',');

      var isProtected = function(el) {
        if (!el || !el.tagName) return true;
        var tag = el.tagName.toUpperCase();
        if (tag === 'VIDEO' || tag === 'SOURCE' || tag === 'AUDIO') return true;
        if (el.querySelector && el.querySelector('video, audio')) return true;
        if (el.closest && el.closest('video, audio')) return true;
        return false;
      };

      var destroyed = 0;

      var purge = function(root) {
        if (!root || !root.querySelectorAll) return;
        var nodes;
        try { nodes = root.querySelectorAll(AD_SELECTOR); } catch (e) { return; }
        for (var i = nodes.length - 1; i >= 0; i--) {
          var el = nodes[i];
          if (!el || !el.parentNode) continue;
          if (isProtected(el)) continue;
          try {
            el.remove();
            destroyed++;
          } catch (e) {}
        }
      };

      var flushCount = function() {
        if (destroyed <= 0) return;
        var n = destroyed;
        destroyed = 0;
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: n, reason: 'dom-watcher' }));
        } catch (e) {}
      };

      // 首次全量清理
      purge(document);

      // 节流：批量变更合并处理，避免频繁 DOM 操作拖慢页面
      var pending = false;
      var schedulePurge = function() {
        if (pending) return;
        pending = true;
        setTimeout(function() {
          pending = false;
          purge(document);
          flushCount();
        }, 300);
      };

      try {
        var observer = new MutationObserver(function(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            if (!added || added.length === 0) continue;
            schedulePurge();
            return;
          }
        });
        var start = function() {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
            schedulePurge();
          }
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
      } catch (e) {}
    })();
    true;
`;
// --- END OF FILE src/scripts/browser/adDomWatcher.js ---
