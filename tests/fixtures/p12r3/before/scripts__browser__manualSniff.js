// --- START OF FILE src/scripts/browser/manualSniff.js ---
// 🔍 手动深度扫描：汇总被动嗅探池 + DOM 节点 + HTML 源码中的媒体直链
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动

export const MANUAL_SNIFF_SCRIPT = `
    (function() {
      var MEDIA_REGEX = /\\.(m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(\\?.*)?$/i;
      var seen = {};
      var results = [];

      var getAbsUrl = function(url) {
        try { return new URL(url, window.location.href).href; } catch(e) { return url; }
      };

      // 收集（不再"找到第一个就停"），去重后统一回传
      var collect = function(src) {
        if (!src || typeof src !== 'string') return;
        if (src.startsWith('blob:') || src.startsWith('data:')) return;
        if (!/^https?:/i.test(src)) return;
        if (!MEDIA_REGEX.test(src)) return;
        var abs = getAbsUrl(src);
        if (seen[abs]) return;
        seen[abs] = true;
        results.push(abs);
      };

      // 1️⃣ 被动嗅探池（XHR / fetch / media.src 劫持所得）
      if (window.__sniffed_urls && window.__sniffed_urls.size > 0) {
        window.__sniffed_urls.forEach(function(url) { collect(url); });
      }

      // 2️⃣ DOM 中的 <video> / <source>
      var nodes = document.querySelectorAll('video, source');
      for (var i = 0; i < nodes.length; i++) {
        collect(nodes[i].src);
        collect(nodes[i].getAttribute('src'));
        collect(nodes[i].getAttribute('data-src'));
        collect(nodes[i].getAttribute('data-original'));
        var children = nodes[i].querySelectorAll ? nodes[i].querySelectorAll('source') : [];
        for (var j = 0; j < children.length; j++) {
          collect(children[j].src);
          collect(children[j].getAttribute('src'));
        }
      }

      // 3️⃣ 兜底：扫描 HTML 源码中的媒体直链
      try {
        var htmlContent = document.documentElement.innerHTML;
        var htmlRegex = /(https?:\\/\\/[^"'\\s<>]+?\\.(?:m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(?:\\?[^"'\\s<>]*)?)/gi;
        var match;
        while ((match = htmlRegex.exec(htmlContent)) !== null) {
          collect(match[1]);
        }
      } catch (e) {}

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'VIDEO_FOUND_LIST',
        urls: results,
        found: results.length > 0
      }));
    })();
    true;
`;
// --- END OF FILE src/scripts/browser/manualSniff.js ---
