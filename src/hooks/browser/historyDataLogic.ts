// --- START OF FILE src/hooks/browser/historyDataLogic.ts ---
/**
 * 🕘 浏览器历史 / 🏷️ 书签 纯数据决策模块（P1.3 R3 解耦）
 *
 * 从 `useBrowserHistory.js` 中提取的**无副作用**纯数据变换：
 *   1. `normalizeBookmark`      —— 单条书签归一化（原 Hook 内联私有函数）
 *   2. `normalizeBookmarkList`  —— 批量归一化 + 按 url 去重（原 Hook 内联私有函数）
 *   3. `cleanHistoryList`       —— 历史读取时的脏数据过滤 + 上限截断（原 loadHistory 内联）
 *   4. `buildHistoryEntry`      —— 历史条目构造（原 addHistory 内联）
 *   5. `mergeHistoryEntry`      —— 历史写入的去重 + 上限截断（原 addHistory 内联）
 *
 * ⚠️ 行为契约（逐条与解耦前一致，不得改动）：
 *   - `normalizeBookmark`：字符串 → isSafeUrl 通过则 `{ url, title: '' }`，否则 null；
 *     对象 → url 非字符串按 '' 处理，isSafeUrl 不通过则 null，title 非字符串按 ''，
 *     否则 trim；非对象非字符串 → null。
 *   - `normalizeBookmarkList`：非数组 → []；逐项归一化，null 丢弃；
 *     按 url 去重（保留首次出现顺序）。
 *   - `cleanHistoryList`：非数组 → []；过滤 `it && typeof it.url === 'string' && isSafeUrl(it.url)`；
 *     再 `.slice(0, limit)`。
 *   - `buildHistoryEntry`：`{ id, url, title: buildHistoryTitle(title, url), timestamp }`；
 *     id / timestamp 由调用方注入（保持 Date.now / Math.random 调用时机不变）。
 *   - `mergeHistoryEntry`：若 `prev[0].url === url` 返回 `{ skip: true }`（同一页面重复回调跳过）；
 *     否则 `next = [entry, ...prev.filter(it => it.url !== url)].slice(0, limit)`。
 *
 * 本模块不依赖 React / React Native / AsyncStorage，不读写 Ref，不调用 setState，
 * 不创建定时器，不触碰 WebView，不注入脚本，不做任何 IO。
 */

import { isSafeUrl, buildHistoryTitle } from '../../constants/browser';
import type { Bookmark, HistoryEntry } from '../../types/browser';

/**
 * 🧩 单条书签归一化：兼容历史版本「纯 URL 字符串」缓存。
 *
 * 与解耦前 `normalizeBookmark` 逐字等价：
 *   · 字符串 → `{ url, title: '' }`（需 isSafeUrl 通过，否则 null）
 *   · 对象   → 只保留合法字段，title 统一 trim
 *   · 其他   → null
 */
export const normalizeBookmark = (item: unknown): Bookmark | null => {
  if (typeof item === 'string') {
    return isSafeUrl(item) ? { url: item, title: '' } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const raw = item as { url?: unknown; title?: unknown };
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (!isSafeUrl(url)) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  return { url, title };
};

/**
 * 🧩 批量归一化 + 按 url 去重（保留首次出现的顺序）。
 *
 * 与解耦前 `normalizeBookmarkList` 逐字等价。
 */
export const normalizeBookmarkList = (list: unknown): Bookmark[] => {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Bookmark[] = [];
  list.forEach((raw) => {
    const item = normalizeBookmark(raw);
    if (!item || seen.has(item.url)) return;
    seen.add(item.url);
    out.push(item);
  });
  return out;
};

/**
 * 🕘 历史读取时的脏数据过滤 + 上限截断。
 *
 * 与解耦前 loadHistory 内联实现逐字等价：
 *   `parsed.filter((it) => it && typeof it.url === 'string' && isSafeUrl(it.url)).slice(0, limit)`
 *
 * 注意：调用方需先确认 `parsed` 是数组（原实现 `if (!Array.isArray(parsed)) return;`）。
 * 本函数对非数组输入返回 []，作为额外兜底，不改变调用方语义。
 */
export const cleanHistoryList = (parsed: unknown, limit: number): HistoryEntry[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (it): it is HistoryEntry =>
        !!it && typeof (it as HistoryEntry).url === 'string' && isSafeUrl((it as HistoryEntry).url)
    )
    .slice(0, limit);
};

/**
 * 🕘 历史条目构造。
 *
 * 与解耦前 addHistory 内联构造**求值顺序**逐字等价：
 *   `{ id: `${Date.now()}-${Math.random()...}`, url,
 *      title: buildHistoryTitle(title, url), timestamp: Date.now() }`
 *
 * ⚠️ 关键：原实现对象字面量的求值顺序是
 *   id（Date.now #1 + Math.random）→ url → title（buildHistoryTitle）→ timestamp（Date.now #2）。
 *   即 **timestamp 的采样发生在标题解析之后**。
 *
 *   为保持该顺序，本函数接收 `timestampProvider`（而非已求值的 timestamp），
 *   在 `buildHistoryTitle` 执行**之后**才调用它。id 仍由调用方在进入本函数前生成，
 *   从而完整复现「ID → 标题 → timestamp」的求值次序与 Date.now 调用次数。
 *
 *   · id：由调用方注入（调用方负责 `Date.now()` + `Math.random()` 的时机）
 *   · timestamp：由 `timestampProvider()` 在本函数内、标题解析之后采样
 */
export const buildHistoryEntry = (
  url: string,
  title: unknown,
  id: string,
  timestampProvider: () => number
): HistoryEntry => {
  const resolvedTitle = buildHistoryTitle(title, url);
  const timestamp = timestampProvider();
  return {
    id,
    url,
    title: resolvedTitle,
    timestamp,
  };
};

/** `mergeHistoryEntry` 的返回：要么跳过（同一页面重复回调），要么给出新列表 */
export type MergeHistoryResult =
  | { skip: true }
  | { skip: false; next: HistoryEntry[] };

/**
 * 🕘 历史写入的去重 + 上限截断。
 *
 * 与解耦前 addHistory 内联实现逐字等价：
 *   · `if (prev.length > 0 && prev[0].url === url) return;` → `{ skip: true }`
 *   · `next = [entry, ...prev.filter((it) => it.url !== url)].slice(0, limit)`
 */
export const mergeHistoryEntry = (
  prev: readonly HistoryEntry[],
  entry: HistoryEntry,
  limit: number
): MergeHistoryResult => {
  const head = prev[0];
  if (head && head.url === entry.url) return { skip: true };
  const next = [entry, ...prev.filter((it) => it.url !== entry.url)].slice(0, limit);
  return { skip: false, next };
};
// --- END OF FILE src/hooks/browser/historyDataLogic.ts ---
