/**
 * 浏览器 / 嗅探契约（TASK-P1.1 R0 — Phase B4 校正）
 *
 * 依据（逐字段核对，非猜测）：
 *   - `src/hooks/browser/useBrowserHistory.js` 第 248–253 行（历史条目真实构造）
 *   - `src/hooks/browser/useBrowserHistory.js` 第 46–55 行（书签归一化，仅 url/title）
 *   - `src/constants/browser/index.js` 第 52–57 行 `buildMediaItem`（嗅探项真实字段）
 *   - `src/hooks/browser/useBrowserSniffer.js`（嗅探列表）
 *   - `src/hooks/browser/useBrowserNavigation.js`（canGoBack/canGoForward 是布尔返回值）
 *
 * ⚠️ 关键校正（相对上一版）：
 *   1. `HistoryEntry` 的时间字段是 `timestamp`（**毫秒数字**），不是 `visitedAt: string`。
 *   2. `Bookmark` 实际只有 `{ url, title }`，**没有** `id` / `createdAt`。
 *   3. `SniffedMedia` 实际是 `{ id, url, ext, domain }`，**没有** `type` / `sourceUrl` / `title`。
 *   4. `BrowserTab` 在运行时**不存在**（`canGoBack` / `canGoForward` 是
 *      `useBrowserNavigation` 返回的布尔值，不是某个 tab 对象的字段）。
 *      为避免「把未来设计伪装成既有契约」，本文件**移除** `BrowserTab`，
 *      仅在注释中登记为未来多标签扩展的候选设计。
 */

/** 浏览器历史记录项（`useBrowserHistory.addHistory` 构造） */
export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  /** 毫秒时间戳（`Date.now()`） */
  timestamp: number;
}

/**
 * 书签项。
 *
 * 真实来源：`useBrowserHistory.js` 第 46–55 行 `normalizeBookmark`，
 * 归一化后只保留 `{ url, title }`（旧版纯 URL 字符串会转成 `{ url, title: '' }`）。
 */
export interface Bookmark {
  url: string;
  title: string;
}

/**
 * 嗅探到的媒体项。
 *
 * 真实来源：`src/constants/browser/index.js` 第 52–57 行 `buildMediaItem`：
 *   `{ id: url, url, ext: getMediaExt(url), domain: getDomain(url) }`
 */
export interface SniffedMedia {
  /** 以 url 作为唯一 id */
  id: string;
  url: string;
  /** 媒体扩展名（如 m3u8 / mp4；无法识别时为 'media'） */
  ext: string;
  /** 主机名（去掉 www. 前缀；解析失败为空串） */
  domain: string;
}

/**
 * 浏览器标签页 —— **当前运行时不存在此对象**。
 *
 * 现状：浏览器为单标签实现，`canGoBack` / `canGoForward` 是
 * `useBrowserNavigation` 返回的布尔值，并非某个 tab 对象的字段。
 *
 * 因此本文件不声明 `BrowserTab` 接口，避免把未来多标签设计伪装成既有契约。
 * 若后续引入多标签，应在此新增并附真实运行时来源。
 */
