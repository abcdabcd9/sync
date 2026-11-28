// --- START OF FILE src/hooks/browser/watchHistoryLogic.js ---
// 🎬 浏览器视频观看历史 —— 纯逻辑层（无 React / 无原生依赖）
//
// 设计目标：
//   1. 数据模型与归一化：把「播放器事件」收敛成一条可持久化的观看记录；
//   2. 媒体身份（mediaKey）：保证「第 8 集」与「第 9 集」不会互相覆盖进度；
//   3. 续播决策（decideResume）：把「记录 + 当前可用片源」映射成明确的动作；
//   4. 展示格式化：最后观看时间（本地时区，精确到秒）、播放位置（HH:mm:ss）。
//
// ⚠️ 本文件必须保持「纯函数」：
//   - 不 import react / react-native / expo-* / AsyncStorage；
//   - 不读写全局状态、不发网络请求；
//   - 这样 tests/security 下的 Node 沙箱可以直接 import 做契约测试。
//
// 🔒 安全约束（与需求一致）：
//   - 绝不持久化 access token / cookie / Authorization / 带签名的完整媒体 URL；
//   - 媒体 URL 落盘前先做「敏感参数剥离」，但剥离后仍必须能区分不同视频
//     （因此保留 path 与「非敏感」查询参数，并在 mediaKey 中体现）。

import { getDomain, isSafeUrl } from '../../constants/browser/index.js';

// ============================================================================
// 常量
// ============================================================================

/** 观看历史条数上限（与浏览历史保持一致，避免无限增长） */
export const WATCH_HISTORY_LIMIT = 100;

/** 观看历史存储 key 前缀（V1 命名空间，与浏览历史 / 书签完全隔离） */
export const WATCH_HISTORY_KEY_PREFIX = '@sync_watch_history_v1_';

/** 播放中节流保存间隔（毫秒）：5~10s 区间取 6s，兼顾精度与写盘频率 */
export const WATCH_SAVE_THROTTLE_MS = 6000;

/** 距片尾多少秒内视为「已看完」，下次从 0 开始播 */
export const WATCH_NEAR_END_SECONDS = 15;

/** 进度小于该秒数时视为「刚开始」，不写入有效进度（避免 0:01 也弹续播） */
export const WATCH_MIN_PROGRESS_SECONDS = 5;

/**
 * 敏感查询参数名（小写匹配）。
 * 这些参数一旦落盘就等于把「可复用的访问凭证」写进明文存储，
 * 因此持久化前必须剥离；剥离后仍保留其余参数以区分不同视频。
 */
export const SENSITIVE_QUERY_KEYS = [
  'token',
  'access_token',
  'auth',
  'authorization',
  'sign',
  'signature',
  'sig',
  'expires',
  'expire',
  'exp',
  'key',
  'apikey',
  'api_key',
  'secret',
  'password',
  'pwd',
  'session',
  'sessionid',
  'ticket',
  'st',
  'e',
  'auth_key',
  'policy',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-oss-signature',
];

/**
 * 🎯 续播任务超时（毫秒）。
 * 超过该时长仍未完成「身份确认 + seek」的任务视为失效，必须安全清理，
 * 避免「历史 URL 存在就无限等待」。
 */
export const RESUME_TASK_TIMEOUT_MS = 45000;

/** 续播任务状态机（显式状态，便于测试与排障） */
export const RESUME_TASK_STATUS = {
  /** 已创建，等待播放器确认媒体身份 */
  PENDING: 'PENDING',
  /** 身份已确认，等待播放器 readyToPlay */
  MATCHED: 'MATCHED',
  /** seek 已成功执行（终态） */
  APPLIED: 'APPLIED',
  /** 身份不匹配 / 资源不可用 / 超时（终态） */
  ABORTED: 'ABORTED',
};

// ============================================================================
// 基础工具
// ============================================================================

/** 构造某用户的观看历史存储 key；无有效 userId 返回 null（不读不写） */
export const buildWatchHistoryKey = (userId) =>
  (userId && typeof userId === 'string' ? `${WATCH_HISTORY_KEY_PREFIX}${userId}` : null);

/**
 * 生成续播任务的唯一 ID。
 *
 * 为什么不能只用 Date.now()：
 *   同一毫秒内连续点击两条历史（或双击）会得到相同 nonce，
 *   消费方据此判断「是否新任务」时会误判为同一任务 → 第二次点击被吞掉。
 *
 * 实现：时间戳 + 单调递增计数 + 随机后缀，保证同毫秒内也唯一。
 */
let resumeTaskSeq = 0;
export const createResumeTaskId = () => {
  resumeTaskSeq = (resumeTaskSeq + 1) % 1000000;
  return `rt_${Date.now().toString(36)}_${resumeTaskSeq.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

/** 安全取整（NaN / Infinity / 负数 → 0） */
const toSafeInt = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
};

/** 秒 → 毫秒（播放器给的是秒，落盘统一用整数毫秒） */
export const secondsToMillis = (sec) => toSafeInt(Number(sec) * 1000);

/** 毫秒 → 秒（浮点，供 seek 使用） */
export const millisToSeconds = (ms) => {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 1000;
};

// ============================================================================
// URL 脱敏
// ============================================================================

/**
 * 剥离 URL 中的敏感查询参数（token / 签名 / 过期时间等）。
 *
 * 规则：
 *   - 仅处理 http(s) URL；其他协议（about: 等）原样返回；
 *   - 保留 path 与 hash（path 是区分不同视频的关键）；
 *   - 保留非敏感查询参数（部分站点的视频 id 在 query 里）；
 *   - 解析失败时退化为「截断到 ? 之前」，宁可少存也不存凭证。
 *
 * @param {string} url
 * @returns {string}
 */
export function sanitizeMediaUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  if (!/^https?:/i.test(url)) return url;
  try {
    const u = new URL(url);
    const kept = [];
    u.searchParams.forEach((value, key) => {
      if (SENSITIVE_QUERY_KEYS.includes(String(key).toLowerCase())) return;
      kept.push([key, value]);
    });
    // 重建 query（保持原始顺序，避免不同视频因参数顺序不同被误判为同一视频）
    const search = kept.length
      ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    return `${u.origin}${u.pathname}${search}${u.hash || ''}`;
  } catch (_e) {
    const idx = url.indexOf('?');
    return idx >= 0 ? url.slice(0, idx) : url;
  }
}

/**
 * 剥离网页 URL 中的敏感参数（用于「原始播放页」字段）。
 * 与 sanitizeMediaUrl 同规则，单独命名以表达语义。
 */
export const sanitizePageUrl = (url) => sanitizeMediaUrl(url);

// ============================================================================
// 媒体身份（mediaKey）
// ============================================================================

/**
 * 计算一条观看记录的「媒体身份」。
 *
 * 为什么不能直接用媒体 URL 当身份：
 *   - m3u8 直链常带一次性签名，每次嗅探到的 URL 都不同 → 同一集会被当成新视频；
 *   - 反过来，不同集若共用同一个 CDN 路径模板，仅靠 host 又会误合并。
 *
 * 因此采用「分层身份」：
 *   1. 有剧集播放页（pageUrl）且能解析出 vodId/sourceId/episodeId → 用它，
 *      这是最精确的「第几部剧的第几集」；
 *   2. 否则用「脱敏后的媒体 URL」→ 精确到具体片源；
 *   3. 再否则用「脱敏后的播放页 URL」；
 *   4. 全都没有 → 返回空串（调用方应放弃写入）。
 *
 * @param {{ mediaUrl?: string, pageUrl?: string, episode?: object|null }} input
 * @returns {string}
 */
export function buildMediaKey({ mediaUrl, pageUrl, episode } = {}) {
  // 🛡️ 站点隔离：不同站点可能使用完全相同的 /play/1-1-8.html 路径，
  //    若不带站点信息，A 站第 8 集与 B 站第 8 集会被判为同一媒体 → 错集续播。
  //    站点来源优先级：播放页域名 > 媒体 URL 域名。
  const site = getDomain(sanitizePageUrl(pageUrl)) || getDomain(sanitizeMediaUrl(mediaUrl));

  // ① 剧集三元组（最可靠）：必须带站点前缀
  //    ⚠️ 安全约束：三元组只描述「播放页是哪一集」，不能证明「这条媒体就是该集正片」。
  //       同一个播放页上可能同时存在正片与广告（ads.tracker.com 等跨站资源）。
  //       若对跨站媒体也套用三元组，广告会拿到与正片完全相同的 mediaKey，
  //       从而通过续播闸门 → 用户明确禁止的「同页广告误续播」。
  //       因此：只有当媒体与播放页属于同一可注册主域（含同站 CDN 子域）时，
  //       才采用三元组身份；跨站媒体退化为自身 URL 身份。
  if (episode && episode.vodId && episode.sourceId && Number.isFinite(episode.episodeId)) {
    // 🛡️ 只有「媒体缺失」或「媒体确属同站正片」时才采用三元组身份。
    //    ⚠️ 同站广告（ads.site.com）与正片（cdn.site.com）可注册主域相同，
    //       因此不能只比 eTLD+1 —— 必须走 isSameSiteMainMedia 的广告排除。
    //    媒体缺失 → 历史记录构造时常见，只能信 pageUrl（此时无媒体可冒充）。
    const mediaMissing = !sanitizeMediaUrl(mediaUrl);
    if (mediaMissing || isSameSiteMainMedia(mediaUrl, pageUrl)) {
      return site
        ? `ep:${site}:${episode.vodId}:${episode.sourceId}:${episode.episodeId}`
        : `ep:${episode.vodId}:${episode.sourceId}:${episode.episodeId}`;
    }
    // 跨站媒体 / 同站广告 → 不继承剧集身份，落到下方 URL 分支
  }
  // ② 脱敏媒体 URL（已含 host，天然带站点隔离）
  const safeMedia = sanitizeMediaUrl(mediaUrl);
  if (safeMedia) return `m:${safeMedia}`;
  // ③ 脱敏播放页 URL（已含 host，天然带站点隔离）
  const safePage = sanitizePageUrl(pageUrl);
  if (safePage) return `p:${safePage}`;
  return '';
}

/**
 * 取「可注册主域」（eTLD+1 的近似实现）。
 *
 * ⚠️ 该值**只能**作为「弱信号」，绝不能单独作为「正片身份证明」。
 *    原因：`cdn.site.com`（正片 CDN）与 `ads.site.com`（同站广告子域）
 *    的可注册主域都是 `site.com`，仅凭主域相同无法区分正片与广告。
 *    因此本函数仅用于「同站子域」的辅助判断，真正的授权必须叠加
 *    `isLikelyAdHost` / `isLikelyAdPath` 排除，或依赖精确媒体证据。
 *
 * 规则（保守、无外部依赖）：
 *   - 取最后两段（`a.b.com` → `b.com`）
 *   - 常见二级后缀（`com.cn` / `co.uk` / `com.tw` 等）取最后三段
 *   - 纯 IP / 单段 → 原样返回
 *
 * @param {string} host
 * @returns {string}
 */
function toRegistrableDomain(host) {
  if (!host) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IPv4
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const secondLevel = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const SLD = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or', 'ne', 'go']);
  if (SLD.has(secondLevel) && tld.length === 2) {
    // 形如 com.cn / co.uk → 取三段
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * 🛡️ 广告子域标签黑名单（按 hostname 的**最左标签**匹配）。
 *
 * 为什么必须有这一层：`ads.site.com` 与 `cdn.site.com` 的可注册主域相同，
 * 若只比较 eTLD+1，同站广告会继承正片的剧集身份 → 误续播（用户明确禁止）。
 * 因此把「广告语义的子域标签」显式排除，使同站广告退化为自身 URL 身份。
 *
 * 注意：这里只匹配**最左标签**（`ads` / `ad` / `preroll` …），
 * 不匹配 path，避免误杀正规 CDN（如 `cdn.site.com/ads-free/index.m3u8`）。
 */
const AD_HOST_LABELS = new Set([
  'ad',
  'ads',
  'adv',
  'advert',
  'adverts',
  'adserver',
  'adservice',
  'adsystem',
  'adtech',
  'preroll',
  'midroll',
  'postroll',
  'vast',
  'vpaid',
  'ima',
  'track',
  'tracker',
  'tracking',
  'analytics',
  'metrics',
  'beacon',
  'pixel',
  'stats',
  'telemetry',
  'doubleclick',
  'googlesyndication',
  'popads',
  'popcash',
  'adsterra',
  'exoclick',
  'juicyads',
  'propellerads',
]);

/**
 * 判断 hostname 是否「明显是广告 / 追踪子域」。
 *
 * 判定：hostname 的最左标签命中 {@link AD_HOST_LABELS}。
 *   - `ads.site.com`      → true（最左标签 `ads`）
 *   - `ad.preroll.site.com` → true（最左标签 `ad`）
 *   - `cdn.site.com`      → false
 *   - `v.cdn.site.com`    → false
 *   - `site.com`          → false
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLikelyAdHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const first = host.split('.').filter(Boolean)[0];
  if (!first) return false;
  return AD_HOST_LABELS.has(first.toLowerCase());
}

/**
 * 判断媒体 URL 的 path 是否「明显是广告资源」。
 *
 * 与 {@link isLikelyAdHost} 互补：有些站点把广告放在主域路径下
 * （`https://site.com/ad/preroll.m3u8`），hostname 无法识别。
 * 这里只匹配**明确的广告路径段**，不匹配普通业务路径。
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLikelyAdPath(url) {
  if (typeof url !== 'string' || !url) return false;
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch (_e) {
    // 允许传入纯 pathname
  }
  return /\/(?:ads?|advert|adverts|adserver|preroll|midroll|postroll|vast|vpaid|ima|track|tracker|tracking|analytics|metrics|beacon|pixel)\//i.test(
    pathname
  );
}

/**
 * 🛡️ 判断「媒体是否可被视为播放页的正片片源」——续播授权的唯一同站依据。
 *
 * 这是本次修复的核心：把「可注册主域相同」从**身份证明**降级为**必要条件**，
 * 并叠加两道广告排除，确保同站广告无法冒充正片：
 *
 *   1. 媒体与播放页的可注册主域必须相同（保留换 CDN 子域续播能力）；
 *   2. 媒体 hostname 不得是广告 / 追踪子域（`ads.site.com` 等）；
 *   3. 媒体 path 不得是广告路径（`/ad/` `/preroll/` 等）。
 *
 * 媒体缺失时返回 false —— 「没有媒体证据」不能证明是正片，
 * 调用方应退化为「等待用户确认」而不是自动续播。
 *
 * @param {string} mediaUrl
 * @param {string} pageUrl
 * @returns {boolean}
 */
export function isSameSiteMainMedia(mediaUrl, pageUrl) {
  const safeMedia = sanitizeMediaUrl(mediaUrl);
  const safePage = sanitizePageUrl(pageUrl);
  if (!safeMedia || !safePage) return false;
  const mediaHost = getDomain(safeMedia);
  const pageHost = getDomain(safePage);
  if (!mediaHost || !pageHost) return false;
  // ② 广告子域 → 直接否决（同站广告的核心防线）
  if (isLikelyAdHost(mediaHost)) return false;
  // ③ 广告路径 → 直接否决
  if (isLikelyAdPath(safeMedia)) return false;
  // ① 同站（含同站 CDN 子域）→ 允许
  return toRegistrableDomain(mediaHost) === toRegistrableDomain(pageHost);
}

/**
 * 计算「观看记录身份」（recordKey）—— 三层身份模型的第一层。
 *
 * 语义：确定「是哪一部影片、哪一集」，**与具体 CDN 地址无关**。
 *   - 能解析出剧集三元组 → `ep:<site>:<vod>:<src>:<ep>`（换 CDN 不变）
 *   - 否则退化为脱敏媒体 URL（`m:`），再退化为播放页 URL（`p:`）
 *
 * ⚠️ 关键安全约束（禁止同页广告误获续播授权）：
 *   剧集三元组只来自 pageUrl，而「同一个播放页上可能同时存在正片与广告」。
 *   若仅凭 pageUrl 就判定「同一集」，同页广告会拿到与正片相同的 recordKey，
 *   从而通过续播闸门 —— 这正是用户明确禁止的缺陷。
 *
 *   因此本函数只有在「媒体 URL 与播放页属于同一站点」时才采用三元组身份：
 *     · 同站（可注册主域相同，如 cdn-a.site.com 与 site.com）→ 视为该集真实片源
 *     · 跨站（主域不同，典型如 ads.tracker.com）→ 不采用三元组，
 *       退化为媒体自身身份，确保广告与正片身份不同
 *
 *   这样既保留「换 CDN 仍能续播」（同站换 CDN 子域不影响），
 *   又杜绝同页广告冒充正片。
 *
 * @param {{ mediaUrl?: string, pageUrl?: string }} input
 * @returns {string}
 */
export function buildRecordKey({ mediaUrl, pageUrl } = {}) {
  const episode = parseEpisodeTriple(pageUrl);
  if (episode) {
    // 🛡️ 与 buildMediaKey 同源判定：媒体缺失 → 信 pageUrl；
    //    否则必须通过 isSameSiteMainMedia（同站 + 非广告子域 + 非广告路径）。
    //    ⚠️ 仅比较 eTLD+1 不足以排除同站广告（ads.site.com）。
    const mediaMissing = !sanitizeMediaUrl(mediaUrl);
    if (mediaMissing || isSameSiteMainMedia(mediaUrl, pageUrl)) {
      return buildMediaKey({ mediaUrl, pageUrl, episode });
    }
    // 跨站媒体 / 同站广告 → 不继承剧集身份
  }
  return buildMediaKey({ mediaUrl, pageUrl });
}

/**
 * 从播放页 URL 解析剧集三元组（与 src/utils/episodeUrl.js 的解析规则一致）。
 * 这里内联一份「最小实现」，避免纯逻辑模块依赖 utils（保持零耦合、便于单测）。
 *
 * @param {string} pageUrl
 * @returns {{ vodId: string, sourceId: string, episodeId: number } | null}
 */
export function parseEpisodeTriple(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl) return null;
  let pathname = pageUrl;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch (_e) {
    // 允许传入纯 pathname
  }
  const m = /\/play\/(\d+)-(\d+)-(\d+)\.html/i.exec(pathname);
  if (!m) return null;
  return { vodId: m[1], sourceId: m[2], episodeId: Number(m[3]) };
}

// ============================================================================
// 集数标签（用户可见的「第 N 集」）
// ============================================================================
//
// 🐞 真机故障 A 的根因（必须永久隔离）：
//   URL 里的 `episodeId`（如 700596）是**站点内部资源 ID**，不是集数。
//   旧实现直接 `第${triple.episodeId}集` → 界面出现「第 700596 集」。
//   `src/utils/episodeUrl.js` 已明确记录：第 1 集 = 700596，第 2 集 = 700597。
//
// ✅ 正确来源（按可信度排序）：
//   ① 选集列表里网页给出的真实标题（EPISODE_LIST_SCRIPT 抓到的 a.textContent）
//   ② 选集列表中的真实顺序（index + 1），与 EpisodeDrawer 的兜底一致
//   ③ 都无法确认 → 留空，绝不编造数字
//
// ⚠️ episodeId 仍然必须保留在 URL 定位 / 身份匹配（recordKey / mediaKey）中，
//    本节的函数**只**影响「展示给用户的文字」，不参与任何身份计算。

/**
 * 判断一个标签是否是「内部 episodeId 泄漏成集数」的脏数据。
 *
 * 判定：形如 `第700596集`，且数字位数 ≥ 4（真实集数极少超过 3 位）。
 * 这类标签由旧版本写入磁盘，必须非破坏性清洗（清空标签，保留整条记录）。
 *
 * @param {any} label
 * @returns {boolean}
 */
export function isLeakedEpisodeIdLabel(label) {
  if (typeof label !== 'string') return false;
  const m = /^第\s*(\d+)\s*集$/.exec(label.trim());
  if (!m) return false;
  return m[1].length >= 4;
}

/**
 * 从选集列表中取出「当前集」的真实标签。
 *
 * @param {object[]} episodeList 选集列表（元素含 url / label）
 * @param {number} currentIndex 当前集索引（-1 表示未知）
 * @returns {string} 真实集数标签；无法确认时返回空串
 */
export function resolveEpisodeLabel(episodeList, currentIndex) {
  const list = Array.isArray(episodeList) ? episodeList : [];
  const idx = Number.isInteger(currentIndex) ? currentIndex : -1;
  if (idx >= 0 && idx < list.length) {
    const ep = list[idx];
    const raw = ep && typeof ep.label === 'string' ? ep.label.trim() : '';
    // ① 网页给出的真实标题（最可信）
    if (raw && !isLeakedEpisodeIdLabel(raw)) return raw;
    // ② 选集列表的真实顺序（与 EpisodeDrawer 兜底一致）
    return `第${idx + 1}集`;
  }
  // ③ 无法确认 → 留空（绝不使用 episodeId 编造集数）
  return '';
}

/**
 * 清洗「已落盘的旧记录」中的错误集数标签（非破坏性）。
 *
 * 只把「内部 ID 泄漏」的标签清空，**不删除记录、不改动进度**，
 * 用户原有观看历史完整保留，仅去掉错误数字。
 *
 * @param {any} label
 * @returns {string}
 */
export function sanitizeEpisodeLabel(label) {
  if (typeof label !== 'string') return '';
  const trimmed = label.trim();
  if (!trimmed) return '';
  return isLeakedEpisodeIdLabel(trimmed) ? '' : trimmed;
}

// ============================================================================
// 记录构造与归一化
// ============================================================================

/**
 * 构造一条观看记录。
 *
 * 字段说明：
 *   id            记录唯一 id（同一 mediaKey 复用旧 id，保证「重复观看更新同一条」）
 *   mediaKey      媒体身份（去重 / 续播匹配的唯一依据）
 *   recordKey     观看记录身份（与 CDN 无关的「哪一集」，续播授权第一依据）
 *   title         视频标题（优先剧集标题，其次网页标题，最后域名）
 *   domain        站点域名（展示用）
 *   pageUrl       原始播放页 URL（脱敏；Case B 失效时回到这里）
 *   episodePageUrl 实际成功播放的「那一集」播放页 URL（脱敏）
 *                 —— P0-5：优先于 pageUrl，用于「点历史直达目标集数」
 *   episodeId     站点内部集数资源 ID（仅用于定位，**绝不**作为集数展示）
 *   episodeTitle  网页给出的真实集数标题（可为空，绝不编造）
 *   mediaUrl      媒体直链（脱敏；Case A 直接续播用）
 *   episodeLabel  集数标签（如「第 8 集」，可为空）
 *   positionMillis 播放位置（整数毫秒）
 *   durationMillis 总时长（整数毫秒，未知为 0）
 *   completed     是否已看完（片尾 / 接近片尾）
 *   lastWatchedAt 最后观看时间（UTC 毫秒时间戳）
 *
 * @param {object} input
 * @returns {object|null} 无法确定媒体身份时返回 null
 */
export function buildWatchRecord(input = {}) {
  const {
    id,
    mediaUrl,
    pageUrl,
    episodePageUrl,
    episodeId,
    episodeTitle,
    title,
    episodeLabel,
    positionMillis,
    durationMillis,
    completed,
    lastWatchedAt,
    now,
  } = input;

  // 🎯 P0-5：定位用播放页优先取「实际成功播放的那一集」，
  //    缺失时退回 pageUrl（兼容旧调用方 / 旧记录）。
  const safeEpisodePage = sanitizePageUrl(episodePageUrl) || sanitizePageUrl(pageUrl);
  // 🛡️ 身份计算仍以「定位页」为准：它才是真正播放的那一集。
  const identityPage = safeEpisodePage || pageUrl;

  const episode = parseEpisodeTriple(identityPage);
  const mediaKey = buildMediaKey({ mediaUrl, pageUrl: identityPage, episode });
  if (!mediaKey) return null;
  // 🛡️ 三层身份模型第一层：观看记录身份（与 CDN 无关的「哪一集」）
  //    历史记录自带 recordKey，续播时无需重新推导，避免语义漂移。
  const recordKey = buildRecordKey({ mediaUrl, pageUrl: identityPage });

  const posMs = toSafeInt(positionMillis);
  const durMs = toSafeInt(durationMillis);
  const isCompleted = completed === true;

  // 标题回退链：显式标题 → 集数标签 → 域名 → 脱敏 URL 预览
  const safePage = sanitizePageUrl(pageUrl);
  const safeMedia = sanitizeMediaUrl(mediaUrl);
  const domain = getDomain(safeEpisodePage || safePage || safeMedia);
  const explicitTitle = typeof title === 'string' ? title.trim() : '';
  const finalTitle = explicitTitle || episodeLabel || domain || safePage || safeMedia;

  // 🎯 内部集数 ID：只接受正整数，仅用于定位，绝不参与展示
  const safeEpisodeId = Number.isFinite(Number(episodeId)) && Number(episodeId) > 0
    ? Math.floor(Number(episodeId))
    : (episode ? episode.episodeId : 0);

  return {
    id: typeof id === 'string' && id ? id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mediaKey,
    recordKey,
    title: finalTitle,
    domain,
    pageUrl: safePage,
    // 🎯 P0-5：精确定位信息（点历史直达该集播放页）
    episodePageUrl: safeEpisodePage,
    episodeId: safeEpisodeId,
    episodeTitle: typeof episodeTitle === 'string' ? episodeTitle.trim() : '',
    mediaUrl: safeMedia,
    // 🐞 故障 A：写入前清洗「内部 episodeId 泄漏成集数」的标签（如「第700596集」）
    episodeLabel: sanitizeEpisodeLabel(episodeLabel),
    positionMillis: posMs,
    durationMillis: durMs,
    completed: isCompleted,
    lastWatchedAt: toSafeInt(lastWatchedAt) || toSafeInt(now) || Date.now(),
  };
}

/**
 * 归一化「从磁盘读到的」记录（防御脏数据 / 旧版本结构）。
 * 任何字段非法都不会抛错，最差返回 null 由调用方过滤。
 *
 * @param {any} raw
 * @returns {object|null}
 */
export function normalizeWatchRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mediaKey = typeof raw.mediaKey === 'string' ? raw.mediaKey : '';
  if (!mediaKey) return null;
  const positionMillis = toSafeInt(raw.positionMillis);
  const durationMillis = toSafeInt(raw.durationMillis);
  // 🛡️ 旧版本记录可能没有 recordKey → 从 pageUrl/mediaUrl 重新推导（向后兼容）
  const recordKey =
    typeof raw.recordKey === 'string' && raw.recordKey
      ? raw.recordKey
      : buildRecordKey({ mediaUrl: raw.mediaUrl, pageUrl: raw.pageUrl });
  const pageUrl = typeof raw.pageUrl === 'string' ? raw.pageUrl : '';
  // 🎯 P0-5 向后兼容：旧记录没有 episodePageUrl → 用 pageUrl 兜底；
  //    没有 episodeId → 从 pageUrl 三元组推导（仅定位用，绝不展示）。
  const episodePageUrl =
    typeof raw.episodePageUrl === 'string' && raw.episodePageUrl
      ? raw.episodePageUrl
      : pageUrl;
  const triple = parseEpisodeTriple(episodePageUrl || pageUrl);
  const rawEpisodeId = Number(raw.episodeId);
  const episodeId =
    Number.isFinite(rawEpisodeId) && rawEpisodeId > 0
      ? Math.floor(rawEpisodeId)
      : (triple ? triple.episodeId : 0);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${mediaKey}`,
    mediaKey,
    recordKey,
    title: typeof raw.title === 'string' ? raw.title : '',
    domain: typeof raw.domain === 'string' ? raw.domain : '',
    pageUrl,
    // 🎯 P0-5：精确定位信息（旧记录自动补齐，不丢历史）
    episodePageUrl,
    episodeId,
    episodeTitle: typeof raw.episodeTitle === 'string' ? raw.episodeTitle : '',
    mediaUrl: typeof raw.mediaUrl === 'string' ? raw.mediaUrl : '',
    // 🐞 故障 A 非破坏性兼容：旧版本落盘的「第700596集」在此清空标签，
    //    记录本身（进度 / 标题 / 播放页）完整保留，不清空用户观看历史。
    episodeLabel: sanitizeEpisodeLabel(raw.episodeLabel),
    positionMillis,
    durationMillis,
    completed: raw.completed === true,
    lastWatchedAt: toSafeInt(raw.lastWatchedAt),
  };
}

/**
 * 归一化整个列表：过滤非法项、按 mediaKey 去重（保留最新）、按时间倒序、截断上限。
 *
 * @param {any} list
 * @param {number} [limit]
 * @returns {object[]}
 */
export function normalizeWatchList(list, limit = WATCH_HISTORY_LIMIT) {
  if (!Array.isArray(list)) return [];
  const byKey = new Map();
  list.forEach((raw) => {
    const item = normalizeWatchRecord(raw);
    if (!item) return;
    const prev = byKey.get(item.mediaKey);
    // 同一 mediaKey 只保留「最后观看时间更新」的一条
    if (!prev || item.lastWatchedAt >= prev.lastWatchedAt) {
      byKey.set(item.mediaKey, item);
    }
  });
  return Array.from(byKey.values())
    .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
    .slice(0, limit);
}

/**
 * 把一条新记录合并进列表（「重复观看更新同一条」的核心）。
 *
 * 语义：
 *   - 同 mediaKey 已存在 → 复用其 id，用新数据覆盖进度与时间；
 *   - 不存在 → 插入到最前；
 *   - 结果按 lastWatchedAt 倒序并截断上限。
 *
 * @param {object[]} prevList
 * @param {object} record
 * @param {number} [limit]
 * @returns {object[]}
 */
export function upsertWatchRecord(prevList, record, limit = WATCH_HISTORY_LIMIT) {
  if (!record || !record.mediaKey) return Array.isArray(prevList) ? prevList : [];
  const list = Array.isArray(prevList) ? prevList : [];
  const existing = list.find((it) => it && it.mediaKey === record.mediaKey);
  const merged = {
    ...record,
    // 复用旧 id，保证列表 key 稳定（避免删除按钮指向错行）
    id: existing && existing.id ? existing.id : record.id,
    // 新记录若缺少标题 / 播放页，用旧记录补齐（例如从直链续播时拿不到标题）
    title: record.title || (existing && existing.title) || '',
    pageUrl: record.pageUrl || (existing && existing.pageUrl) || '',
    // 🎯 P0-5：定位信息同样「新优先、旧补齐」，绝不因新记录缺字段而丢失目标集数
    episodePageUrl:
      record.episodePageUrl ||
      (existing && existing.episodePageUrl) ||
      record.pageUrl ||
      (existing && existing.pageUrl) ||
      '',
    episodeId:
      (record.episodeId > 0 ? record.episodeId : 0) ||
      (existing && existing.episodeId > 0 ? existing.episodeId : 0) ||
      0,
    episodeTitle: record.episodeTitle || (existing && existing.episodeTitle) || '',
    // 🐞 故障 A：合并时同样清洗，避免旧脏标签被「补齐」回新记录
    episodeLabel:
      sanitizeEpisodeLabel(record.episodeLabel) ||
      sanitizeEpisodeLabel(existing && existing.episodeLabel) ||
      '',
  };
  const rest = list.filter((it) => it && it.mediaKey !== record.mediaKey);
  return [merged, ...rest]
    .sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0))
    .slice(0, limit);
}

// ============================================================================
// 进度判定
// ============================================================================

/**
 * 判断一条记录是否「值得续播」。
 *   - 已看完（completed）→ 不续播，从头播；
 *   - 进度过短（< 5s）→ 不续播；
 *   - 距片尾过近（< 15s）→ 视为看完，从头播。
 *
 * @param {object} record
 * @returns {boolean}
 */
export function shouldResume(record) {
  if (!record) return false;
  if (record.completed) return false;
  const pos = toSafeInt(record.positionMillis);
  const dur = toSafeInt(record.durationMillis);
  if (pos < WATCH_MIN_PROGRESS_SECONDS * 1000) return false;
  if (dur > 0 && dur - pos < WATCH_NEAR_END_SECONDS * 1000) return false;
  return true;
}

/**
 * 计算「实际要 seek 到的秒数」。
 * 不值得续播时返回 0（从头播）。
 *
 * @param {object} record
 * @returns {number} 秒（浮点）
 */
export function resolveResumeSeconds(record) {
  if (!shouldResume(record)) return 0;
  return millisToSeconds(record.positionMillis);
}

/**
 * 判断播放是否已到片尾（用于写入 completed 状态）。
 *
 * @param {number} positionSec 当前播放位置（秒）
 * @param {number} durationSec 总时长（秒）
 * @returns {boolean}
 */
export function isNearEnd(positionSec, durationSec) {
  const pos = Number(positionSec);
  const dur = Number(durationSec);
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur <= 0) return false;
  return dur - pos <= WATCH_NEAR_END_SECONDS;
}

// ============================================================================
// 续播决策状态机
// ============================================================================

/** 续播动作枚举 */
export const RESUME_ACTION = {
  /** 直接播放（无需 seek，从头开始） */
  PLAY_FROM_START: 'PLAY_FROM_START',
  /** 直接播放并 seek 到指定位置（Case A：片源仍可用） */
  PLAY_AND_SEEK: 'PLAY_AND_SEEK',
  /** 片源不可用 → 回到原始播放页，等待重新识别（Case B） */
  NAVIGATE_TO_PAGE: 'NAVIGATE_TO_PAGE',
  /** 无法续播（记录损坏 / 无任何可用 URL） */
  UNAVAILABLE: 'UNAVAILABLE',
};

/**
 * 🎯 P0-6：解析「点击历史后应该打开的播放页 URL」。
 *
 * 优先级（严格按此顺序，绝不猜测内部 ID）：
 *   ① `episodePageUrl` —— 实际成功播放的那一集播放页（最精确）
 *   ② `pageUrl` —— 兼容旧记录
 *
 * 🛡️ 安全约束：
 *   - 只接受 http(s) 播放页 URL；
 *   - **绝不**用 `episodeId` 数字去拼 URL（站点内部 ID 与集数序号无固定关系，
 *     拼出来的地址大概率是错的，甚至指向别的剧）；
 *   - 若保存的是详情页 / 首页（无三元组），仍返回它（由浏览器页重新嗅探），
 *     但绝不「按集数猜 URL」。
 *
 * @param {object|null} record
 * @returns {string} 目标播放页 URL；无可用值时返回空串
 */
export function resolveTargetEpisodePage(record) {
  if (!record || typeof record !== 'object') return '';
  const candidates = [record.episodePageUrl, record.pageUrl];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    const safe = sanitizePageUrl(raw);
    if (!safe || !/^https?:/i.test(safe)) continue;
    return safe;
  }
  return '';
}

/**
 * 续播决策（纯函数）。
 *
 * 输入：
 *   record       观看记录
 *   candidates   当前「已实际嗅探到」的片源列表 [{ url, mediaKey? }]（可为空）
 *
 * 输出：{ action, url?, seekSeconds?, reason, unverified? }
 *
 * 决策顺序（严格按此顺序，避免「随便挑第一个资源」）：
 *   1. 记录无效 → UNAVAILABLE
 *   2. 有候选片源且能确认「同一媒体身份」→ PLAY_AND_SEEK / PLAY_FROM_START
 *      （身份确认方式：candidate.mediaKey === record.mediaKey，
 *        或 candidate.url 脱敏后等于 record.mediaUrl）
 *   3. 有安全 pageUrl → NAVIGATE_TO_PAGE（回原始页重新嗅探，最可靠）
 *   4. 无播放页时，历史直链作为「未验证候选」→ PLAY_AND_SEEK / PLAY_FROM_START
 *      并标记 unverified=true，调用方必须处理失败回退
 *   5. 全无 → UNAVAILABLE
 *
 * 🛡️ 为什么把 pageUrl 提到 mediaUrl 之前：
 *   落盘时已剥离签名 / token / 过期参数，脱敏后的直链很可能已失效
 *   （403 / 404 / 空响应）。若优先直连，用户会看到「点了没反应」。
 *   回原始播放页 → 真实嗅探 → 身份确认 → 恢复进度，才是可靠路径。
 *
 * ⚠️ 绝不「取候选列表第一项」：身份不匹配的片源一律不播，
 *    否则会出现「点第 8 集却播了第 9 集」的错续播。
 *
 * @param {object|null} record
 * @param {Array<{url: string, mediaKey?: string}>} [candidates]
 * @returns {{ action: string, url?: string, seekSeconds?: number, reason: string, unverified?: boolean }}
 */
export function decideResume(record, candidates = []) {
  if (!record || !record.mediaKey) {
    return { action: RESUME_ACTION.UNAVAILABLE, reason: 'invalid_record' };
  }
  const seekSeconds = resolveResumeSeconds(record);
  const list = Array.isArray(candidates) ? candidates : [];

  // ② 在候选片源中寻找「身份确认」的那一个
  //    ⚠️ 候选来自「当前实际嗅探到的片源」，属于已证明可用的资源，
  //       因此命中后可以直接播放并 seek。
  const matched = list.find((c) => {
    if (!c || typeof c.url !== 'string' || !c.url) return false;
    if (c.mediaKey && c.mediaKey === record.mediaKey) return true;
    if (record.mediaUrl && sanitizeMediaUrl(c.url) === record.mediaUrl) return true;
    return false;
  });
  if (matched) {
    return {
      action: seekSeconds > 0 ? RESUME_ACTION.PLAY_AND_SEEK : RESUME_ACTION.PLAY_FROM_START,
      url: matched.url,
      seekSeconds,
      reason: 'matched_candidate',
    };
  }

  // ③ 优先回「那一集」的播放页（Case B）：由真实嗅探重新确认片源后再恢复进度
  //    🎯 P0-6：必须直达目标集数播放页，绝不落在站点首页 / 剧集详情页。
  //       episodePageUrl 是「实际成功播放的那一集」的页面（P0-5 落盘），
  //       优先于 pageUrl（可能是详情页 / 首页）。
  const targetPage = resolveTargetEpisodePage(record);
  if (targetPage && isSafeUrl(targetPage)) {
    return {
      action: RESUME_ACTION.NAVIGATE_TO_PAGE,
      url: targetPage,
      seekSeconds,
      reason: 'need_renavigate',
    };
  }

  // ④ 无播放页兜底：历史直链作为「未验证候选」
  //    🛡️ 脱敏后的直链不保证仍可播放，调用方必须在失败时安全降级
  if (record.mediaUrl && /^https?:/i.test(record.mediaUrl)) {
    return {
      action: seekSeconds > 0 ? RESUME_ACTION.PLAY_AND_SEEK : RESUME_ACTION.PLAY_FROM_START,
      url: record.mediaUrl,
      seekSeconds,
      reason: 'unverified_saved_media_url',
      unverified: true,
    };
  }

  return { action: RESUME_ACTION.UNAVAILABLE, reason: 'no_usable_url' };
}

/**
 * 待续播任务（pending resume）的身份校验。
 *
 * 场景：用户点历史 → 回原始播放页 → 隐藏 WebView 重新嗅探到 m3u8。
 * 此时必须确认「新嗅探到的片源」与「待续播记录」是同一个视频，
 * 否则会把第 8 集的进度套到第 9 集上。
 *
 * 🛡️ 为什么「仅 pageUrl 相同」不足以判定同一媒体：
 *   - 同一播放页里既有广告视频又有正片；
 *   - 同一播放页可能内嵌多个不同视频（推荐位 / 预告片）；
 *   - 同一部剧的不同集可能共用同一个播放页（SPA 路由 / query 切集）。
 *   因此 pageUrl 相同只能作为「弱信号」，必须再叠加媒体层面的证据。
 *
 * 判定规则（任一成立即命中）：
 *   ① mediaKey 完全一致（最强，已含站点 + 剧集三元组 / 媒体 URL）；
 *   ② 媒体 URL 脱敏后一致（同一片源）；
 *   ③ pageUrl 一致 **且** 双方都能解析出剧集三元组且三元组一致
 *      （同一页面的同一集，而不是同一页面的不同集 / 广告）。
 *
 * @param {object|null} pending 待续播任务 { mediaKey, pageUrl, mediaUrl, seekSeconds }
 * @param {{ mediaKey?: string, pageUrl?: string, mediaUrl?: string }} found 新识别到的片源
 * @returns {boolean}
 */
export function isPendingResumeMatch(pending, found) {
  if (!pending || !found) return false;
  if (!pending.mediaKey && !pending.recordKey && !pending.mediaUrl && !pending.pageUrl) return false;

  // ① 观看记录身份一致（recordKey）→ 命中。
  //    ✅ 这是「换 CDN 仍能续播」的关键：同一部剧的同一集，无论新嗅探到的
  //       m3u8 域名 / 路径 / 签名如何变化，都判为同一目标。
  const pendingRecordKey =
    pending.recordKey ||
    buildRecordKey({ mediaUrl: pending.mediaUrl, pageUrl: pending.pageUrl }) ||
    pending.mediaKey ||
    '';
  const foundRecordKey =
    found.recordKey || buildRecordKey({ mediaUrl: found.mediaUrl, pageUrl: found.pageUrl }) || '';
  if (pendingRecordKey && foundRecordKey && pendingRecordKey === foundRecordKey) {
    return true;
  }

  // ② 实际媒体身份一致（mediaKey）→ 命中（同一片源，覆盖无剧集三元组的站点）
  if (found.mediaKey && pending.mediaKey && found.mediaKey === pending.mediaKey) return true;

  // ③ 媒体 URL 脱敏后一致 → 命中（同一片源兜底）
  if (found.mediaUrl && pending.mediaUrl && sanitizeMediaUrl(found.mediaUrl) === sanitizeMediaUrl(pending.mediaUrl)) {
    return true;
  }

  // ④ pageUrl 一致只是弱信号：必须叠加「剧集三元组一致」才命中
  //    ⚠️ 绝不因为「pageUrl 相同」就放行：同页广告 / 同页不同集都会被误授权。
  const foundPage = sanitizePageUrl(found.pageUrl);
  const pendingPage = sanitizePageUrl(pending.pageUrl);
  if (foundPage && pendingPage && foundPage === pendingPage) {
    const foundTriple = parseEpisodeTriple(foundPage);
    const pendingTriple = parseEpisodeTriple(pendingPage);
    // 双方都能解析出三元组且完全一致 → 同一页面的同一集
    if (
      foundTriple &&
      pendingTriple &&
      foundTriple.vodId === pendingTriple.vodId &&
      foundTriple.sourceId === pendingTriple.sourceId &&
      foundTriple.episodeId === pendingTriple.episodeId
    ) {
      // 🛡️ 关键安全闸门：三元组只证明「播放页是哪一集」，不能证明「这条媒体就是该集正片」。
      //    同页广告与正片共享同一 pageUrl 与三元组，若仅凭此放行，广告会获得续播授权。
      //    ⚠️ 仅比较可注册主域（eTLD+1）**不够**：`ads.site.com` 与 `cdn.site.com`
      //       的主域都是 `site.com`，同站广告会因此冒充正片。
      //    因此必须走 isSameSiteMainMedia：同站 + 排除广告子域 + 排除广告路径。
      //    · 媒体缺失（纯页面命中）→ 无法证明是正片，不放行
      //    · 跨站媒体 / 同站广告 → 不放行
      //    · 同站正片媒体（含换 CDN 子域）→ 放行
      return isSameSiteMainMedia(found.mediaUrl, foundPage);
    }
    // 页面相同但无法证明是同一集（无三元组 / 集数不同）→ 不命中
    return false;
  }

  return false;
}

/**
 * 判断「当前播放器里的媒体」是否就是待续播任务的目标媒体。
 *
 * 用于 Cinema 内 seek 前的最后一道闸门：即使任务已进入影院，
 * 也必须确认播放器当前加载的确实是同一媒体，才允许 seek。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🛡️ 三层身份模型（本次最终收口的核心修复）
 * ═══════════════════════════════════════════════════════════════════════
 * 旧实现的致命缺陷：历史记录用 `buildMediaKey({mediaUrl, pageUrl, episode})`
 * 生成 `ep:<site>:<vod>:<src>:<ep>`；而 Cinema 侧只传 `{mediaUrl, pageUrl}`
 * 不传 episode，于是生成 `m:<mediaUrl>`。两者永远不相等 → seek 永不执行。
 * 只有「媒体 URL 逐字节相同」这一条逃生通道，一旦换 CDN 就彻底失效。
 *
 * 修复后必须严格区分三个概念，绝不混用：
 *
 *   ① 观看记录身份 recordKey —— 「是哪一部影片、哪一集」，与 CDN 无关。
 *      由 `buildRecordKey({mediaUrl, pageUrl})` 计算（内部强制解析剧集三元组）。
 *      历史记录落盘的 `mediaKey` 字段即此语义。
 *
 *   ② 实际媒体身份 mediaKey —— 「播放器此刻加载的是哪个具体资源」。
 *      由 `buildMediaKey({mediaUrl, pageUrl})` 计算，通常为 `m:<脱敏URL>`。
 *      仅用于「同一片源」的强校验，**不能**用来判断「是不是同一集」。
 *
 *   ③ 续播授权 resumeGrant —— 「当前这个资源是否被允许套用该记录的进度」。
 *      这是本函数要回答的问题，判定顺序：
 *
 *        (a) 记录身份一致（recordKey 相等）→ 授权通过。
 *            ✅ 这是「换 CDN 仍能续播」的关键：只要还是同一部剧的同一集，
 *               无论 CDN 域名 / 路径 / 签名如何变化，都允许恢复进度。
 *        (b) 实际媒体身份一致（mediaKey 相等）→ 授权通过。
 *            覆盖「无剧集三元组、只能靠媒体 URL 识别」的站点。
 *        (c) 脱敏媒体 URL 一致 → 授权通过（同一片源的兜底）。
 *        (d) 以上都不成立 → 拒绝。
 *            ⚠️ 绝不因为「pageUrl 相同」就放行：同页广告 / 同页不同集
 *               都会因此被错误授权（用户明确指出的缺陷）。
 *
 * 参数兼容：`pending` 可能是历史记录（含 mediaKey=recordKey），也可能是
 * 续播任务（含 mediaKey=recordKey + mediaUrl）。`current` 由 Cinema 用
 * `{mediaUrl, pageUrl}` 构造，本函数内部自行推导 recordKey / mediaKey，
 * 因此调用方**不需要**知道该传哪个 key —— 这是消除语义错配的根本手段。
 *
 * @param {object|null} pending 待续播任务 / 历史记录
 *        { mediaKey?: string, recordKey?: string, mediaUrl?: string, pageUrl?: string }
 * @param {{ mediaUrl?: string, pageUrl?: string, mediaKey?: string, recordKey?: string }} current
 *        当前播放器媒体
 * @returns {boolean}
 */
export function isResumeTargetCurrent(pending, current) {
  if (!pending || !current) return false;

  // 🛡️ 前置否决：当前媒体若「明显是广告」，无论身份是否相同一律拒绝。
  //    原因：同站广告（ads.site.com）与正片（cdn.site.com）可注册主域相同，
  //    若 recordKey 因历史数据 / 旧版本记录而恰好相同，仅靠 (a) 会误放行。
  //    这里用 hostname / path 的广告特征做最后一道硬否决。
  const currentMediaUrl = sanitizeMediaUrl(current.mediaUrl);
  if (currentMediaUrl) {
    const currentMediaHost = getDomain(currentMediaUrl);
    if (isLikelyAdHost(currentMediaHost) || isLikelyAdPath(currentMediaUrl)) {
      return false;
    }
  }

  // 推导双方的「观看记录身份」与「实际媒体身份」
  const pendingRecordKey =
    pending.recordKey ||
    buildRecordKey({ mediaUrl: pending.mediaUrl, pageUrl: pending.pageUrl }) ||
    pending.mediaKey ||
    '';
  const currentRecordKey =
    current.recordKey ||
    buildRecordKey({ mediaUrl: current.mediaUrl, pageUrl: current.pageUrl }) ||
    '';

  // (a) 记录身份一致 → 同一部剧的同一集，允许续播（换 CDN 也成立）
  if (pendingRecordKey && currentRecordKey && pendingRecordKey === currentRecordKey) {
    return true;
  }

  // (b) 实际媒体身份一致 → 同一片源（覆盖无剧集三元组的站点）
  const pendingMediaKey = pending.mediaKey || '';
  const currentMediaKey =
    current.mediaKey || buildMediaKey({ mediaUrl: current.mediaUrl, pageUrl: current.pageUrl }) || '';
  if (pendingMediaKey && currentMediaKey && pendingMediaKey === currentMediaKey) {
    return true;
  }

  // (c) 脱敏媒体 URL 一致 → 同一片源兜底
  if (
    current.mediaUrl &&
    pending.mediaUrl &&
    sanitizeMediaUrl(current.mediaUrl) === sanitizeMediaUrl(pending.mediaUrl)
  ) {
    return true;
  }

  // (d) 其余一律拒绝（尤其：仅 pageUrl 相同不放行）
  return false;
}

/**
 * 🎬 故障 B 核心：把「嗅探到的候选片源列表」与「待续播任务」做匹配。
 *
 * 这是「点击观看历史 → 自动嗅探 → 自动进入影院」链路中唯一的判定入口，
 * 浏览器页只负责调用本函数并按结果执行，不再自行拼装身份。
 *
 * 返回三种明确结果（调用方据此决定 UI 行为，绝不静默停在网页）：
 *   · `{ status: 'MATCHED', url, pageUrl }` —— 唯一可靠匹配，可直接 loadUrl + goCinema
 *   · `{ status: 'AMBIGUOUS', candidates }` —— 多个候选命中，必须让用户选择
 *   · `{ status: 'NONE', candidates }`      —— 无命中，保留任务并提示用户
 *
 * ⚠️ 安全约束：
 *   - 绝不「无依据地选第一条」：只有通过 isPendingResumeMatch 的候选才算命中；
 *   - 命中多条时不做任何自动选择（同剧多线路 / 多清晰度都可能命中）；
 *   - 广告候选天然被 isPendingResumeMatch 的 isSameSiteMainMedia 闸门排除。
 *
 * @param {object|null} pending 待续播任务
 * @param {Array<{url: string}>|string[]} mediaList 嗅探到的候选片源
 * @param {string} pageUrl 当前播放页 URL（用于构造 found 身份）
 * @returns {{ status: 'MATCHED'|'AMBIGUOUS'|'NONE', url?: string, pageUrl?: string, candidates: string[] }}
 */
export function matchResumeCandidates(pending, mediaList, pageUrl) {
  const empty = { status: 'NONE', candidates: [] };
  if (!pending || typeof pending !== 'object') return empty;
  const list = Array.isArray(mediaList) ? mediaList : [];
  const safePage = typeof pageUrl === 'string' ? pageUrl : '';
  const triple = parseEpisodeTriple(safePage);

  const candidates = [];
  list.forEach((item) => {
    const url = typeof item === 'string' ? item : item && item.url;
    if (typeof url !== 'string' || !url) return;
    if (candidates.includes(url)) return;
    const found = {
      mediaUrl: url,
      pageUrl: safePage,
      recordKey: buildRecordKey({ mediaUrl: url, pageUrl: safePage }),
      mediaKey: buildMediaKey({ mediaUrl: url, pageUrl: safePage, episode: triple || undefined }),
    };
    if (isPendingResumeMatch(pending, found)) candidates.push(url);
  });

  if (candidates.length === 1) {
    return { status: 'MATCHED', url: candidates[0], pageUrl: safePage, candidates };
  }
  if (candidates.length > 1) {
    return { status: 'AMBIGUOUS', candidates };
  }
  return { status: 'NONE', candidates: [] };
}

/**
 * 🎯 判断「续播目标播放页」与「WebView 实际已加载页」是否同一页面。
 *
 * 为什么需要它（真机故障：同 URL 不刷新导致自动续播失败）：
 *   浏览器会恢复上次访问的页面。若用户当前就停在第 8 集播放页，
 *   再从观看历史点第 8 集，目标 URL 与当前 URL 完全相同。
 *   旧实现只调用 `injectUrl(target)` → `setCurrentUrl(target)`，
 *   React 对相同字符串 bail out（Object.is 相等）→ 不重渲染 →
 *   `<WebView source={{ uri: currentUrl }}>` 不变 → 不重新加载 →
 *   `onLoadEnd` 不触发 → 自动嗅探不执行 → 无法自动进入影院。
 *   因此必须先判定「是否同一页」，同页时主动 `reload()`。
 *
 * 归一化规则（只抹平「与集数无关」的差异，绝不忽略能区分集数的部分）：
 *   - 协议统一小写；`http` 与 `https` 视为同一页（站点常自动升级）
 *   - hostname 统一小写，并去掉 `www.` 前缀
 *   - 去掉默认端口（80 / 443）
 *   - pathname 去掉末尾多余的 `/`（`/play/1-1-8.html` 与 `/play/1-1-8.html/` 同页）
 *   - **保留** pathname 与全部非敏感 query（`/play/1-1-8.html` 与
 *     `/play/1-1-9.html` 必须判为不同页；`?ep=8` 与 `?ep=9` 也必须不同）
 *   - 丢弃 hash（`#player` 之类不影响加载哪一集）
 *
 * ⚠️ 安全约束：
 *   - 只接受 http(s)；任一非法 / 空值 → 返回 false（宁可走正常导航，也不误判为同页）
 *   - 解析失败时退化为「字符串严格相等」，绝不宽松匹配
 *
 * @param {string} targetUrl 续播任务的目标播放页
 * @param {string} currentUrl WebView 实际已加载的页面（actualLoadedUrl）
 * @returns {boolean} true = 同一页面（必须主动 reload）
 */
export function isSameEpisodePage(targetUrl, currentUrl) {
  const a = typeof targetUrl === 'string' ? targetUrl.trim() : '';
  const b = typeof currentUrl === 'string' ? currentUrl.trim() : '';
  if (!a || !b) return false;
  if (!/^https?:/i.test(a) || !/^https?:/i.test(b)) return false;

  const normalize = (raw) => {
    try {
      const u = new URL(raw);
      const protocol = u.protocol.toLowerCase() === 'http:' ? 'https:' : u.protocol.toLowerCase();
      const host = u.hostname.toLowerCase().replace(/^www\./i, '');
      const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
      // 保留非敏感 query（能区分集数），丢弃 hash
      const kept = [];
      u.searchParams.forEach((value, key) => {
        if (SENSITIVE_QUERY_KEYS.includes(String(key).toLowerCase())) return;
        kept.push([key, value]);
      });
      const search = kept.length
        ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        : '';
      const pathname = u.pathname.replace(/\/+$/, '') || '/';
      return `${protocol}//${host}${port}${pathname}${search}`;
    } catch (_e) {
      return raw;
    }
  };

  return normalize(a) === normalize(b);
}

/**
 * 续播任务是否已超时（必须安全清理，避免无限等待）。
 *
 * @param {object|null} task 待续播任务（含 createdAt）
 * @param {number} [now] 当前时间戳（便于测试注入）
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
export function isResumeTaskExpired(task, now = Date.now(), timeoutMs = RESUME_TASK_TIMEOUT_MS) {
  if (!task || typeof task !== 'object') return true;
  const createdAt = Number(task.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
  return now - createdAt > timeoutMs;
}

// ============================================================================
// 展示格式化
// ============================================================================

/**
 * 最后观看时间：本地时区，精确到秒 → YYYY-MM-DD HH:mm:ss
 *
 * 存储的是 UTC 毫秒时间戳，展示时用设备本地时区换算。
 *
 * @param {number} ts 毫秒时间戳
 * @returns {string}
 */
export function formatWatchTime(ts) {
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  const p = (v) => (v < 10 ? `0${v}` : `${v}`);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 播放位置 / 总时长：HH:mm:ss（超过 1 小时自动进位）
 *
 * @param {number} millis 毫秒
 * @returns {string}
 */
export function formatDuration(millis) {
  const ms = typeof millis === 'number' ? millis : Number(millis);
  if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (v) => (v < 10 ? `0${v}` : `${v}`);
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/**
 * 进度百分比（0~1），用于进度条宽度。
 * 时长未知时返回 0。
 *
 * @param {number} positionMillis
 * @param {number} durationMillis
 * @returns {number}
 */
export function computeProgressRatio(positionMillis, durationMillis) {
  const pos = toSafeInt(positionMillis);
  const dur = toSafeInt(durationMillis);
  if (dur <= 0) return 0;
  return Math.max(0, Math.min(1, pos / dur));
}

// --- END OF FILE src/hooks/browser/watchHistoryLogic.js ---
