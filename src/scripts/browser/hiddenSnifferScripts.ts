// --- START OF FILE src/scripts/browser/hiddenSnifferScripts.ts ---
// 🕵️ 隐藏 WebView 嗅探脚本集合
//
// 用途：在 1x1 透明 WebView 中打开剧集播放页，绕过 cdndefend 挑战、
//      自动关闭「安装 APP」弹窗、拦截 /play/ → /channel/ 跳转，
//      并被动嗅探出 m3u8 播放列表地址。
//
// ⚠️ 关键经验（踩过的坑，勿改）：
//   1. 绝不能把 window.ReactNativeWebView 置为 undefined —— 否则所有
//      postMessage 静默失败，表现为「脚本执行了但一条日志都没有」。
//      正确做法：把真实通道存到 window.__rnwv，脚本统一走 __rnwv。
//   2. 站点会在页面加载后把 /play/xxx.html 跳到 /channel/2.html。
//      必须在 onShouldStartLoadWithRequest 里拦截（JS 层拦不住 302）。
//   3. 播放页有「安装 APP」遮罩弹窗，不关掉则 video 元素不初始化。
//   4. .ts 是 HLS 分片，数量成百上千且无法单独播放，必须过滤掉。

// 统一的消息发送辅助（所有脚本共用）
const POST_HELPER: string = `
  var __post = function(obj) {
    try {
      var ch = window.__rnwv || window.ReactNativeWebView;
      ch && ch.postMessage(JSON.stringify(obj));
    } catch (e) {}
  };
`;

// 媒体地址正则：只收「播放列表级」地址
export const MEDIA_PLAYLIST_REGEX: RegExp = /\.(m3u8|mp4|flv|mkv|mov|mpd|webm)(\?.*)?$/i;

/**
 * 环境伪装：抹掉 WebView / 自动化特征，防止站点反爬脚本主动跳转。
 * 同时把真实 postMessage 通道保存到 window.__rnwv。
 */
export const STEALTH_SCRIPT: string = `
  (function() {
    if (window.__stealthInstalled) return true;
    window.__stealthInstalled = true;

    // 1️⃣ 保留 ReactNativeWebView 通道（藏到 __rnwv，绝不置 undefined）
    try {
      if (window.ReactNativeWebView) window.__rnwv = window.ReactNativeWebView;
    } catch (e) {}

    // 2️⃣ 抹掉 webdriver
    try {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; }, configurable: true });
    } catch (e) {}

    // 3️⃣ 补齐 window.chrome
    try {
      if (!window.chrome) {
        window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
      }
    } catch (e) {}

    // 4️⃣ 补齐 navigator.plugins / languages
    try {
      if (!navigator.plugins || navigator.plugins.length === 0) {
        Object.defineProperty(navigator, 'plugins', {
          get: function() { return [1, 2, 3, 4, 5]; },
          configurable: true
        });
      }
      if (!navigator.languages || navigator.languages.length === 0) {
        Object.defineProperty(navigator, 'languages', {
          get: function() { return ['zh-CN', 'zh', 'en']; },
          configurable: true
        });
      }
    } catch (e) {}

    // 5️⃣ 抹掉 navigator.userAgentData
    try {
      if (navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true });
      }
    } catch (e) {}
  })();
  true;
`;

/**
 * 被动嗅探：劫持 XHR / fetch / HTMLMediaElement.src，捕获 m3u8 等播放列表地址。
 */
export const PURE_SNIFFER_SCRIPT: string = `
  (function() {
    if (window.__pure_sniffer_installed) return;
    window.__pure_sniffer_installed = true;
    window.__sniffed_urls = window.__sniffed_urls || new Set();
    ${POST_HELPER}
    var MEDIA_REGEX = ${MEDIA_PLAYLIST_REGEX.toString()};
    var push = function(u) {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
      if (!/^https?:/i.test(u)) return;
      if (!MEDIA_REGEX.test(u)) return;
      if (window.__sniffed_urls.has(u)) return;
      window.__sniffed_urls.add(u);
      __post({ type: 'VIDEO_FOUND', url: u });
    };
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
      try { push(u); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function(input) {
        try { push(typeof input === 'string' ? input : (input && input.url)); } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
    try {
      var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      if (desc && desc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          set: function(v) { try { push(v); } catch (e) {} return desc.set.call(this, v); },
          get: desc.get,
          configurable: true
        });
      }
    } catch (e) {}
  })();
  true;
`;

/**
 * 自动关闭「安装 APP」引导弹窗（遮罩 + 关闭按钮）。
 * 只在首次成功关闭时上报一次，避免刷屏。
 */
export const CLOSE_POPUP_SCRIPT: string = `
  (function() {
    if (window.__closePopupInstalled) return true;
    window.__closePopupInstalled = true;
    ${POST_HELPER}

    var CLOSE_SELECTORS = [
      '.close', '.close-btn', '.btn-close', '.popup-close', '.modal-close',
      '.dialog-close', '.layui-layer-close', '.el-dialog__close',
      '[class*="close"]', '[class*="Close"]',
      '.layui-layer-setwin a', '.layui-layer-setwin span',
      '[aria-label="close"]', '[aria-label="Close"]'
    ];

    var POPUP_SELECTORS = [
      '.layui-layer', '.modal', '.dialog', '.popup', '.mask', '.overlay',
      '[class*="mask"]', '[class*="Mask"]', '[class*="popup"]', '[class*="Popup"]',
      '[class*="dialog"]', '[class*="Dialog"]', '[class*="modal"]', '[class*="Modal"]',
      '[class*="install"]', '[class*="Install"]', '[class*="download"]', '[class*="Download"]'
    ];

    var tryClose = function() {
      var closed = 0;
      for (var i = 0; i < CLOSE_SELECTORS.length; i++) {
        var btns = document.querySelectorAll(CLOSE_SELECTORS[i]);
        for (var j = 0; j < btns.length; j++) {
          var b = btns[j];
          try {
            var st = window.getComputedStyle(b);
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            b.click();
            closed++;
          } catch (e) {}
        }
      }
      for (var k = 0; k < POPUP_SELECTORS.length; k++) {
        var nodes = document.querySelectorAll(POPUP_SELECTORS[k]);
        for (var m = 0; m < nodes.length; m++) {
          var n = nodes[m];
          try {
            var s = window.getComputedStyle(n);
            var z = parseInt(s.zIndex, 10);
            if (s.position === 'fixed' || s.position === 'absolute' || (!isNaN(z) && z >= 100)) {
              if (n.querySelector && n.querySelector('video')) continue;
              n.style.display = 'none';
              closed++;
            }
          } catch (e) {}
        }
      }
      try {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
        document.body.style.position = '';
      } catch (e) {}
      return closed;
    };

    tryClose();
    var tries = 0;
    var reported = false;
    var timer = setInterval(function() {
      tries++;
      var n = tryClose();
      if (n > 0 && !reported) {
        reported = true;
        __post({ type: 'POPUP_CLOSED', count: n, tries: tries });
      }
      if (tries >= 40) clearInterval(timer);
    }, 500);
  })();
  true;
`;

/**
 * 自动播放：让页面内播放器跑起来，从而触发 m3u8 请求。
 */
export const AUTO_PLAY_SCRIPT: string = `
  (function() {
    if (window.__autoPlayStarted) return true;
    window.__autoPlayStarted = true;
    var tries = 0;
    var timer = setInterval(function() {
      tries++;
      var v = document.querySelector('video');
      if (v) {
        try { v.muted = true; } catch (e) {}
        var p = v.play();
        if (p && p.catch) { p.catch(function() {}); }
      }
      try {
        var btn = document.querySelector('.play-btn, .vjs-big-play-button, .dplayer-play-icon, [class*="play-btn"], [class*="playBtn"], [class*="player-btn"]');
        if (btn) btn.click();
      } catch (e) {}
      if (tries >= 24) clearInterval(timer);
    }, 500);
  })();
  true;
`;

/**
 * 手动嗅探兜底：从 DOM video/source 节点与 HTML 源码中提取媒体地址。
 */
export const MANUAL_SNIFF_SCRIPT: string = `
  (function() {
    ${POST_HELPER}
    var MEDIA_REGEX = ${MEDIA_PLAYLIST_REGEX.toString()};
    var found = [];
    var seen = {};
    var add = function(u) {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
      if (!/^https?:/i.test(u)) return;
      if (!MEDIA_REGEX.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      found.push(u);
    };
    try {
      if (window.__sniffed_urls && window.__sniffed_urls.forEach) {
        window.__sniffed_urls.forEach(function(u) { add(u); });
      }
    } catch (e) {}
    try {
      var nodes = document.querySelectorAll('video, source');
      for (var i = 0; i < nodes.length; i++) {
        add(nodes[i].currentSrc);
        add(nodes[i].src);
        add(nodes[i].getAttribute && nodes[i].getAttribute('data-src'));
      }
    } catch (e) {}
    try {
      var html = document.documentElement ? document.documentElement.innerHTML : '';
      var re = /https?:\\/\\/[^"'\\s\\\\]+?\\.(?:m3u8|mp4|flv|mpd)(?:\\?[^"'\\s\\\\]*)?/gi;
      var m;
      var guard = 0;
      while ((m = re.exec(html)) !== null && guard < 50) {
        guard++;
        add(m[0]);
      }
    } catch (e) {}
    __post({ type: 'VIDEO_FOUND_LIST', urls: found, found: found.length });
    __post({ type: 'MANUAL_SNIFF_DONE', found: found.length });
  })();
  true;
`;

/**
 * 剧集列表抓取：从播放页 DOM 中提取「当前线路」的整部剧选集链接。
 *
 * ⚠️ 关键：站点页面里同时存在多条线路（sourceId 不同）的选集链接，
 *    以及大量推荐位/排行榜链接（实测全页有 1300+ 个 a[href]）。
 *    必须用「当前页 URL 的 vodId + sourceId」双重过滤，否则会抓到
 *    别的线路甚至别的剧（实测未过滤时抓到 329 集，全是 sourceId=21 的）。
 *
 * 站点结构（kkys11 类模板）通常为：
 *   <div class="playlist"> / <ul class="content_playlist"> / <div id="playlist">
 *     <a href="/play/392563-36-700596.html">第01集</a>
 *     ...
 *   </div>
 *
 * 回传：{ type: 'EPISODE_LIST', episodes: [{ url, label, vodId, sourceId, episodeId }],
 *         count, scanned, vodId, sourceId }
 */
export const EPISODE_LIST_SCRIPT: string = `
  (function() {
    ${POST_HELPER}
    var PLAY_RE = /\\/play\\/(\\d+)-(\\d+)-(\\d+)\\.html/i;

    // 🎯 从当前页 URL 解析出 vodId / sourceId，作为过滤基准
    var cur = PLAY_RE.exec(location.pathname + location.search);
    if (!cur) {
      __post({ type: 'EPISODE_LIST', episodes: [], count: 0, scanned: 0, reason: 'not_play_page' });
      return;
    }
    var CUR_VOD = cur[1];
    var CUR_SRC = cur[2];

    var seen = {};
    var list = [];

    var push = function(href, label) {
      if (!href || typeof href !== 'string') return;
      var m = PLAY_RE.exec(href);
      if (!m) return;
      // 🎯 只保留「同一部剧 + 同一条线路」的选集
      if (m[1] !== CUR_VOD || m[2] !== CUR_SRC) return;
      var abs;
      try { abs = new URL(href, location.origin).href; } catch (e) { return; }
      if (seen[abs]) return;
      seen[abs] = 1;
      list.push({
        url: abs,
        label: (label || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        vodId: m[1],
        sourceId: m[2],
        episodeId: parseInt(m[3], 10)
      });
    };

    // 1️⃣ 优先在常见选集容器内查找
    var CONTAINERS = [
      '.playlist', '.play-list', '.play_list', '.content_playlist',
      '#playlist', '#play_list', '.episode-list', '.episode_list',
      '.anthology', '.series-list', '.vod-play-list', '.module-play-list',
      '[class*="playlist"]', '[class*="play-list"]', '[class*="episode"]'
    ];
    var scanned = 0;
    for (var i = 0; i < CONTAINERS.length; i++) {
      var boxes = document.querySelectorAll(CONTAINERS[i]);
      for (var b = 0; b < boxes.length; b++) {
        var as = boxes[b].querySelectorAll('a[href]');
        for (var a = 0; a < as.length; a++) {
          push(as[a].getAttribute('href'), as[a].textContent);
          scanned++;
        }
      }
    }

    // 2️⃣ 兜底：全页扫描（容器选择器失效时；过滤条件已保证只留本线路）
    if (list.length === 0) {
      var all = document.querySelectorAll('a[href]');
      for (var k = 0; k < all.length; k++) {
        push(all[k].getAttribute('href'), all[k].textContent);
        scanned++;
      }
    }

    // 3️⃣ 按 episodeId 升序（同线路内集数递增）
    list.sort(function(x, y) { return x.episodeId - y.episodeId; });

    __post({
      type: 'EPISODE_LIST',
      episodes: list,
      count: list.length,
      scanned: scanned,
      vodId: CUR_VOD,
      sourceId: CUR_SRC
    });
  })();
  true;
`;

/**
 * 诊断：回传页面结构，用于排查嗅探失败原因。
 */
export const DIAGNOSE_SCRIPT: string = `
  (function() {
    ${POST_HELPER}
    try {
      var out = {
        type: 'DIAGNOSE',
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyLen: (document.body ? document.body.innerHTML.length : 0),
        videoCount: document.querySelectorAll('video').length,
        iframeCount: document.querySelectorAll('iframe').length,
        iframes: [],
        videoSrcs: [],
        sniffedPool: (window.__sniffed_urls ? window.__sniffed_urls.size : -1),
        globals: []
      };
      var ifs = document.querySelectorAll('iframe');
      for (var i = 0; i < ifs.length && i < 10; i++) {
        out.iframes.push(ifs[i].src || ifs[i].getAttribute('data-src') || '(empty)');
      }
      var vs = document.querySelectorAll('video');
      for (var j = 0; j < vs.length && j < 10; j++) {
        out.videoSrcs.push(vs[j].currentSrc || vs[j].src || '(empty)');
      }
      var keys = ['player_aaaa','player','videoUrl','url','m3u8','MAC','Player','config','vod_url'];
      for (var k = 0; k < keys.length; k++) {
        if (typeof window[keys[k]] !== 'undefined') {
          var val = window[keys[k]];
          var s = '';
          try { s = typeof val === 'string' ? val : JSON.stringify(val); } catch (e) { s = '[obj]'; }
          out.globals.push(keys[k] + ' = ' + String(s).slice(0, 300));
        }
      }
      __post(out);
    } catch (e) {
      __post({ type: 'DIAGNOSE_ERR', msg: String(e) });
    }
  })();
  true;
`;

/**
 * 组装「页面加载前」注入的完整脚本。
 * @returns {string}
 */
export function buildHiddenSnifferBeforeLoadScript(): string {
  return [STEALTH_SCRIPT, PURE_SNIFFER_SCRIPT].join('\n');
}

/**
 * 组装「页面加载后」注入的完整脚本。
 * @returns {string}
 */
export function buildHiddenSnifferAfterLoadScript(): string {
  return [CLOSE_POPUP_SCRIPT, AUTO_PLAY_SCRIPT].join('\n');
}
// --- END OF FILE src/scripts/browser/hiddenSnifferScripts.ts ---
