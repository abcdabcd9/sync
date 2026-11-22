// --- START OF FILE src/hooks/browser/snifferMediaLogic.ts ---
/**
 * 🎬 媒体嗅探纯决策模块（P1.3 R2 解耦）
 *
 * 从 `useBrowserSniffer.js` 中提取的**无副作用**媒体列表决策：
 *   1. `isSafeMediaUrl`      —— M-5 协议白名单（原 Hook 内联私有函数）
 *   2. `normalizeIncomingUrls` —— 入列前的数组兜底 + 白名单过滤 + trim
 *   3. `countByFormat`       —— 各格式计数（原 useMemo 内联 reduce）
 *   4. `filterByFormat`      —— 按筛选格式派生列表（原 useMemo 内联三元）
 *
 * ⚠️ 行为契约（逐条与解耦前一致，不得改动）：
 *   - `isSafeMediaUrl`：非字符串 → false；trim 后空 → false；
 *     仅 `^https?:\/\/\S+` 放行（大小写不敏感，要求协议后紧跟非空白内容）。
 *   - `normalizeIncomingUrls`：非数组按空数组处理；先 filter 后 map(trim)；
 *     全部被过滤时返回空数组（调用方据此静默返回）。
 *   - `countByFormat`：`ext` 取 `(item.ext || '').toUpperCase()`；
 *     `ALL` 恒 +1；仅精确匹配 MP4 / M3U8 / MOV 才累加对应键；
 *     无法识别（如 `'media'`）只计入 ALL。
 *   - `filterByFormat`：`filterFormat === 'ALL'` 时**返回入参数组同一引用**
 *     （不新建数组，保持下游引用相等语义）；否则返回 `filter` 新数组。
 *
 * 本模块不依赖 React / React Native，不读写 Ref，不调用 setState，
 * 不创建定时器，不触碰 WebView，不注入脚本。
 */

/** 🎚️ 筛选选项（顺序即 UI 展示顺序）—— 与解耦前完全一致 */
export const FILTER_OPTIONS = ['ALL', 'MP4', 'M3U8', 'MOV'] as const;

export type FilterFormat = (typeof FILTER_OPTIONS)[number];

/** 各格式计数结构 */
export interface FormatCounts {
  ALL: number;
  MP4: number;
  M3U8: number;
  MOV: number;
}

/** 媒体项最小结构（与 `SniffedMedia` 兼容，仅读取 ext） */
interface MediaLike {
  ext?: unknown;
}

/**
 * 🔒 M-5：嗅探 URL 协议白名单校验
 *
 * 嗅探结果来自网页注入脚本，属于**不可信输入**：恶意页面可以伪造
 * VIDEO_FOUND / VIDEO_FOUND_LIST 消息，把 `javascript:`、`data:`、
 * `file:`、`intent:` 等危险 scheme 塞进播放列表，诱导用户点击后
 * 触发脚本执行或本地文件读取。
 *
 * 这里只放行 http / https 两种协议，其余一律丢弃。
 */
export const isSafeMediaUrl = (url: unknown): boolean => {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // 大小写不敏感匹配，且要求协议后紧跟内容（排除 "http://" 这类空主机）
  return /^https?:\/\/\S+/i.test(trimmed);
};

/**
 * 入列前归一化：数组兜底 → 白名单过滤 → trim。
 *
 * 与解耦前 `pushMedia` 内联实现逐字等价：
 *   `(Array.isArray(incoming) ? incoming : []).filter(isSafeMediaUrl).map((url) => url.trim())`
 *
 * 返回空数组表示「全部被过滤」，调用方应静默返回（不触发动画/震动/弹窗）。
 */
export const normalizeIncomingUrls = (incoming: unknown): string[] =>
  (Array.isArray(incoming) ? incoming : [])
    .filter(isSafeMediaUrl)
    .map((url) => (url as string).trim());

/**
 * 各格式计数（用于筛选 Chip 徽标）。
 *
 * 与解耦前 `formatCounts` useMemo 内联 reduce 逐字等价。
 */
export const countByFormat = (list: readonly MediaLike[]): FormatCounts =>
  list.reduce<FormatCounts>(
    (acc, item) => {
      const ext = ((item.ext as string) || '').toUpperCase();
      acc.ALL += 1;
      if (ext === 'MP4') acc.MP4 += 1;
      else if (ext === 'M3U8') acc.M3U8 += 1;
      else if (ext === 'MOV') acc.MOV += 1;
      return acc;
    },
    { ALL: 0, MP4: 0, M3U8: 0, MOV: 0 }
  );

/**
 * 按当前筛选格式派生展现列表。
 *
 * ⚠️ `filterFormat === 'ALL'` 时**返回入参数组同一引用**（与解耦前一致），
 * 不得改为 `[...list]` 或 `list.slice()`。
 */
export const filterByFormat = <T extends MediaLike>(
  list: readonly T[],
  filterFormat: string
): readonly T[] =>
  filterFormat === 'ALL'
    ? list
    : list.filter((item) => ((item.ext as string) || '').toUpperCase() === filterFormat);
// --- END OF FILE src/hooks/browser/snifferMediaLogic.ts ---
