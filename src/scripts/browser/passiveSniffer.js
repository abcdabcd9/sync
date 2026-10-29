// --- START OF FILE src/scripts/browser/passiveSniffer.js ---
// 🎣 被动嗅探：劫持 XHR / fetch / HTMLMediaElement.src，静默收集媒体直链
// ⚠️ 阶段 1 原样搬移，脚本内部逻辑与转义符严禁改动

export const PASSIVE_SNIFFER_SCRIPT = `
    (function() {
      if (window.__safe_sniffer_installed) return;
      window.__safe_sniffer_installed = true;

      window.__sniffed_urls = window.__sniffed_urls || new Set();

      var videoRegex = /\\.(m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(\\?.*)?$/i;
      
      var getAbsoluteUrl = function(url) {
        try { return new URL(url, window.location.href).href; } catch(e) { return url; }
      };
      
      var recordSilent = function(url) {
        if (!url || typeof url !== 'string') return;
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        
        if (videoRegex.test(url)) {
          window.__sniffed_urls.add(getAbsoluteUrl(url));
        }
      };

      var origOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(method, url) {
        recordSilent(url);
        return origOpen.apply(this, arguments);
      };

      var origFetch = window.fetch;
      window.fetch = function() {
        var arg = arguments[0];
        var url = '';
        if (typeof arg === 'string') url = arg;
        else if (arg && arg.url) url = arg.url;
        recordSilent(url);
        return origFetch.apply(this, arguments);
      };

      var origSrcDesc = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'src');
      if (origSrcDesc && origSrcDesc.set) {
        Object.defineProperty(window.HTMLMediaElement.prototype, 'src', {
          get: origSrcDesc.get,
          set: function(val) {
            recordSilent(val);
            return origSrcDesc.set.call(this, val);
          }
        });
      }
    })();
`;
// --- END OF FILE src/scripts/browser/passiveSniffer.js ---
