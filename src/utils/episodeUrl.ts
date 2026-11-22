// --- START OF FILE src/utils/episodeUrl.ts ---
// 🎬 剧集播放页 URL 解析与「下一集」推断
//
// 站点播放页格式（可可影视 kkys11）：
//   https://www.kkys11.com/play/<vodId>-<sourceId>-<episodeId>.html
//   例：https://www.kkys11.com/play/392563-36-700596.html
//
// 实测（线路 3 / jisuzyv）：
//   第 1 集 700596 → 第 2 集 700597 → 第 3 集 700598
//   即 episodeId 步长为 +1，可直接递增推断下一集。
//
// 注意：不同线路（sourceId）的 episodeId 步长可能不同（线路 2 实测步长 +2），
//      因此这里把步长做成可配置参数，默认 +1。

const PLAY_PATH_RE = /\/play\/(\d+)-(\d+)-(\d+)\.html/i;

const DEFAULT_ORIGIN = 'https://www.kkys11.com';

export interface ParsedEpisodeUrl {
  vodId: string;
  sourceId: string;
  episodeId: number;
  origin: string;
  raw: string;
}

export interface EpisodeUrlParts {
  vodId: string;
  sourceId: string;
  episodeId: number;
  origin?: string;
}

/**
 * 解析播放页 URL。
 * @param url 待解析的 URL（可为 null / undefined / 非字符串）
 * @returns 解析结果；无法解析时返回 null
 */
export function parseEpisodeUrl(url: string | null | undefined): ParsedEpisodeUrl | null {
  if (!url || typeof url !== 'string') return null;
  let pathname = url;
  let origin = '';
  try {
    const u = new URL(url);
    pathname = u.pathname;
    origin = u.origin;
  } catch {
    // 允许传入纯 pathname
  }
  const m = PLAY_PATH_RE.exec(pathname);
  if (!m) return null;
  return {
    vodId: m[1] as string,
    sourceId: m[2] as string,
    episodeId: Number(m[3]),
    origin,
    raw: url,
  };
}

/**
 * 构造播放页 URL。
 * @param parts 播放页各组成部分
 * @returns 构造出的播放页 URL
 */
export function buildEpisodeUrl({
  vodId,
  sourceId,
  episodeId,
  origin = DEFAULT_ORIGIN,
}: EpisodeUrlParts): string {
  return `${origin}/play/${vodId}-${sourceId}-${episodeId}.html`;
}

/**
 * 推断下一集播放页 URL。
 * @param currentUrl 当前播放页 URL
 * @param step episodeId 步长（默认 1）
 * @returns 下一集 URL；无法解析时返回 null
 */
export function buildNextEpisodeUrl(currentUrl: string, step = 1): string | null {
  const parsed = parseEpisodeUrl(currentUrl);
  if (!parsed) return null;
  return buildEpisodeUrl({
    vodId: parsed.vodId,
    sourceId: parsed.sourceId,
    episodeId: parsed.episodeId + step,
    origin: parsed.origin || DEFAULT_ORIGIN,
  });
}

/**
 * 判断两个播放页 URL 是否属于同一部剧（vodId + sourceId 相同）。
 * @param a 播放页 URL A
 * @param b 播放页 URL B
 * @returns 是否同一部剧
 */
export function isSameSeries(a: string, b: string): boolean {
  const pa = parseEpisodeUrl(a);
  const pb = parseEpisodeUrl(b);
  if (!pa || !pb) return false;
  return pa.vodId === pb.vodId && pa.sourceId === pb.sourceId;
}

/**
 * 从 m3u8 直链反推「线路特征」，用于判断两条直链是否同一线路。
 * 例：https://vv.jisuzyv.com/play/aADQRA9e/index.m3u8 → 'vv.jisuzyv.com'
 * @param m3u8Url m3u8 直链
 * @returns 主机名；解析失败时返回空字符串
 */
export function getCdnHost(m3u8Url: string): string {
  try {
    return new URL(m3u8Url).host;
  } catch {
    return '';
  }
}
// --- END OF FILE src/utils/episodeUrl.ts ---
