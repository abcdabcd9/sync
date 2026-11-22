// --- START OF FILE src/scripts/browser/adCleanup.js ---
// 🧹 第三重：DOM 样式级浮层广告与假播放按钮自动清理
//    ⚠️ 安全红线：绝不删除 <video> / <source> / 播放器容器本身，
//       仅移除「透明 + 超高 z-index + 覆盖在 video 之上」的拦截浮层
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动
//     AD_DOMAIN_REGEX 通过函数参数插值，避免模块加载时求值

import { AD_DOMAIN_REGEX } from '../../constants/browser';

export const buildAdCleanupScript = () => `
    (function() {
      if (window.__ad_cleanup_installed) return;
      window.__ad_cleanup_installed = true;

      var AD_HOST_REGEX = ${AD_DOMAIN_REGEX.toString()};
      var isAdUrl = function(url) {
        if (!url || typeof url !== 'string') return false;
        var host = '';
        try { host = new URL(url, window.location.href).hostname; } catch (e) { host = url; }
        return AD_HOST_REGEX.test(host);
      };

      // 1️⃣ 注入广告隐藏 CSS（仅隐藏，不删除，避免破坏页面布局）
      var AD_CSS = [
        '[id*="pop-ad"]', '[id*="popup-ad"]', '[id*="ad-banner"]', '[id*="adsbygoogle"]',
        '[class*="ad-banner"]', '[class*="ad-container"]', '[class*="adsbygoogle"]',
        '[class*="popup-ad"]', '[class*="ad-overlay"]', '[class*="ad-overlay"]',
        'iframe[src*="ad"]', 'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
        'ins.adsbygoogle', '.ad-float', '.ad-sticky', '.ad-popup', '.ad-modal',
        '[id^="ad_"]', '[id^="ads_"]', '[class^="ad_"]'
      ].join(',') + '{display:none !important;visibility:hidden !important;pointer-events:none !important;}';

      var injectCss = function() {
        try {
          if (document.getElementById('__ad_block_style__')) return;
          var style = document.createElement('style');
          style.id = '__ad_block_style__';
          style.type = 'text/css';
          style.appendChild(document.createTextNode(AD_CSS));
          (document.head || document.documentElement).appendChild(style);
        } catch (e) {}
      };

      // 2️⃣ 智能清除覆盖在 <video> 上方的透明点击拦截层
      var isTransparent = function(color) {
        if (!color) return true;
        var c = String(color).replace(/\\s+/g, '').toLowerCase();
        return c === 'transparent' || c === 'rgba(0,0,0,0)' || c === 'rgba(255,255,255,0)';
      };

      var removeClickHijackOverlays = function() {
        try {
          var videos = document.querySelectorAll('video');
          if (!videos.length) return;
          var removed = 0;
          for (var v = 0; v < videos.length; v++) {
            var video = videos[v];
            var vRect = video.getBoundingClientRect();
            if (vRect.width < 40 || vRect.height < 40) continue;

            // 只检查 video 的兄弟节点与父级子节点，范围可控，避免全页扫描误杀
            var scope = video.parentElement || document.body;
            if (!scope) continue;
            var candidates = scope.children;
            for (var i = candidates.length - 1; i >= 0; i--) {
              var el = candidates[i];
              if (!el || el === video) continue;
              if (el.tagName === 'VIDEO' || el.tagName === 'SOURCE') continue;
              // 保护播放器容器：包含 video 的祖先/兄弟容器一律跳过
              if (el.contains && el.contains(video)) continue;

              var cs;
              try { cs = window.getComputedStyle(el); } catch (e) { continue; }
              if (!cs) continue;
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;

              var zIndex = parseInt(cs.zIndex, 10);
              if (isNaN(zIndex) || zIndex < 9999) continue;

              var pos = cs.position;
              if (pos !== 'absolute' && pos !== 'fixed') continue;

              // 背景必须完全透明（含渐变透明）
              var bg = cs.backgroundColor;
              var bgImage = cs.backgroundImage || 'none';
              var bgTransparent = isTransparent(bg) && (bgImage === 'none' || /rgba\\([^)]*,\\s*0\\s*\\)/.test(bgImage));
              if (!bgTransparent) continue;

              // 必须与 video 区域重叠（覆盖在播放器上方）
              var r = el.getBoundingClientRect();
              if (r.width < 40 || r.height < 40) continue;
              var overlapX = Math.min(r.right, vRect.right) - Math.max(r.left, vRect.left);
              var overlapY = Math.min(r.bottom, vRect.bottom) - Math.max(r.top, vRect.top);
              if (overlapX <= 0 || overlapY <= 0) continue;
              var overlapArea = overlapX * overlapY;
              var videoArea = vRect.width * vRect.height;
              if (videoArea <= 0 || overlapArea / videoArea < 0.5) continue;

              // 命中：透明 + 超高 z-index + 覆盖播放器 → 移除
              try {
                el.style.setProperty('pointer-events', 'none', 'important');
                el.remove();
                removed++;
              } catch (e) {}
            }
          }
          if (removed > 0) {
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: removed, reason: 'overlay' }));
            } catch (e) {}
          }
        } catch (e) {}
      };

      // 3️⃣ 移除广告域名的 iframe / script（保留 video 与 source）
      var stripAdFrames = function() {
        try {
          var nodes = document.querySelectorAll('iframe[src], script[src]');
          var removed = 0;
          for (var i = 0; i < nodes.length; i++) {
            var src = nodes[i].getAttribute('src') || '';
            if (src && isAdUrl(src)) {
              try { nodes[i].remove(); removed++; } catch (e) {}
            }
          }
          if (removed > 0) {
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: removed, reason: 'frame' }));
            } catch (e) {}
          }
        } catch (e) {}
      };

      var runCleanup = function() {
        injectCss();
        stripAdFrames();
        removeClickHijackOverlays();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runCleanup, { once: true });
      } else {
        runCleanup();
      }
      window.addEventListener('load', runCleanup, { once: true });

      // 4️⃣ 动态内容持续清理（节流 800ms，避免性能损耗）
      var scheduled = false;
      var scheduleCleanup = function() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function() {
          scheduled = false;
          runCleanup();
        }, 800);
      };
      try {
        var observer = new MutationObserver(scheduleCleanup);
        var startObserve = function() {
          if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        };
        if (document.body) startObserve();
        else document.addEventListener('DOMContentLoaded', startObserve, { once: true });
      } catch (e) {}
    })();
    true;
`;
// --- END OF FILE src/scripts/browser/adCleanup.js ---
