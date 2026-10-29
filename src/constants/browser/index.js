// --- START OF FILE src/constants/browser/index.js ---
// 🌐 浏览器常量与纯工具函数（阶段 1 抽离，逻辑与原 browser.js 完全一致）

export const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";
export const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

// 🔒 安全审计 #25：仅允许加密协议 https:// 与内部 about: 协议，彻底拒绝明文 http://
export const SAFE_URL_PATTERN = /^(https:\/\/|about:)/i;
export const isSafeUrl = (url) => typeof url === 'string' && SAFE_URL_PATTERN.test(url);

// 🎞️ 媒体扩展名识别（用于列表徽章）
export const MEDIA_EXT_REGEX = /\.(m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(?:\?|#|$)/i;

// 🛡️ 第一重：广告 / 弹窗 / 赌博域名黑名单（网络级拦截）
//     ⚠️ 仅匹配主机名（hostname），绝不匹配 path / query，避免误杀正规视频 CDN 直链
export const AD_DOMAIN_REGEX = /(popads|popcash|adsterra|juicyads|exoclick|doubleclick|adservice|googlesyndication|propellerads|bet365|casino|gambling|redirector)/i;

// 判断 URL 是否命中广告域名黑名单（解析失败时按字符串兜底匹配）
export const isAdUrl = (url) => {
  if (typeof url !== 'string' || !url) return false;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    host = url;
  }
  return AD_DOMAIN_REGEX.test(host);
};

export const getMediaExt = (url) => {
  if (typeof url !== 'string') return 'media';
  const m = url.match(MEDIA_EXT_REGEX);
  return m ? m[1].toLowerCase() : 'media';
};

export const getDomain = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
};

// 中间省略的 URL 预览
export const ellipsisMiddle = (url, head = 26, tail = 18) => {
  if (typeof url !== 'string') return '';
  if (url.length <= head + tail + 3) return url;
  return `${url.slice(0, head)}…${url.slice(-tail)}`;
};

// 统一构造列表项
export const buildMediaItem = (url) => ({
  id: url,
  url,
  ext: getMediaExt(url),
  domain: getDomain(url),
});

// 合并去重（新项在前，保持稳定顺序）
export const HISTORY_KEY = '@browser_history';
export const HISTORY_LIMIT = 100;

// 🕒 历史记录时间格式化：10-29 14:30
export const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
export const formatHistoryTime = (ts) => {
  const d = new Date(typeof ts === 'number' ? ts : Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 🏷️ 历史记录标题：优先页面标题，其次域名，最后 URL 预览
export const buildHistoryTitle = (title, url) => {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t) return t;
  const domain = getDomain(url);
  if (domain) return domain;
  return ellipsisMiddle(url, 30, 12);
};

export const mergeMediaList = (prev, incoming) => {
  if (!Array.isArray(incoming) || incoming.length === 0) return prev;
  const seen = new Set(prev.map((it) => it.url));
  const added = [];
  incoming.forEach((raw) => {
    if (typeof raw !== 'string' || !raw) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    added.push(buildMediaItem(raw));
  });
  if (added.length === 0) return prev;
  return [...added, ...prev];
};
// --- END OF FILE src/constants/browser/index.js ---
