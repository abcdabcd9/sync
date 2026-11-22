# P1.4 R1 — 迁移前 JS 基线冻结清单

本目录冻结 P1.4 R1 迁移**之前**的两个原始 JS 模块完整内容，作为新旧行为等价测试的
「旧实现」基准。基线取自当前工作区（已包含 P1.3 R3-FIX 与 P1.4 R0 全部成果），
**不是** HEAD 上未重构的旧版本。

## 冻结文件

| 冻结文件名 | 原始路径 | 行数 | SHA-256 |
|---|---|---|---|
| `hooks__browser__useBrowserHistory.js` | `src/hooks/browser/useBrowserHistory.js` | 366 | `f29a79ff059613aecd785a64748512ec116a92961b68b03b6c91a4d4a774a26d` |
| `context__BrowserSessionContext.js` | `src/context/BrowserSessionContext.js` | 174 | `cfa9926c771aaf666e976b25c5267eea6806e4bf4eaf32e3a2454c1796e8d87f` |

## 校验方式

```bash
shasum -a 256 tests/fixtures/p14r1/before/*.js
```

## 迁移目标

| 基线 | 迁移后路径 | 说明 |
|---|---|---|
| `hooks__browser__useBrowserHistory.js` | `src/hooks/browser/useBrowserHistory.ts` | 纯 Hook，无 JSX，`.ts` |
| `context__BrowserSessionContext.js` | `src/context/BrowserSessionContext.tsx` | 含 Provider JSX，必须 `.tsx` |

## 公开接口（迁移前，必须逐字保持）

### useBrowserHistory

```js
export function useBrowserHistory(userId = null, authEpoch = 0)
export default useBrowserHistory
```

返回对象键（顺序固定）：
`historyList, addHistory, deleteHistory, clearHistory, bookmarksList, toggleBookmark, removeBookmark, isBookmarked`

### BrowserSessionContext

```js
export function BrowserSessionProvider({ children, userId = null, authEpoch = null })
export function useBrowserSession()
export default BrowserSessionContext   // createContext(null)
```

Provider value 键（顺序固定）：
`pendingUrl, pendingSeq, setPendingUrl, consumePendingUrl, lastUrl, rememberUrl`

## State / Ref / Effect 清单

### useBrowserHistory

- State：`historyList`、`bookmarksList`、`prevOwner`
- Ref：`keysRef`、`userIdRef`、`authEpochRef`、`historyListRef`
- useMemo：`historyKey`、`bookmarksKey`、`seedKey`
- Effect：
  - `keysRef` 镜像（deps `[historyKey, bookmarksKey, seedKey]`）
  - `userIdRef` 镜像（deps `[userId]`）
  - `authEpochRef` 镜像（deps `[authEpoch]`）
  - `historyListRef` 镜像（deps `[historyList]`）
  - `loadBookmarks`（deps `[bookmarksKey, seedKey, userId]`）
  - `loadHistory`（deps `[historyKey, userId]`）
- 渲染期状态调整：`prevOwner !== userId` → 清空 `historyList` / `bookmarksList`
- Callback：`addHistory`、`deleteHistory`、`clearHistory`、`isBookmarked`、`toggleBookmark`、`removeBookmark`

### BrowserSessionContext

- State：`pendingUrl`、`lastUrl`、`pendingSeq`、`stateOwner`、`stateEpoch`
- Ref：`hydratedRef`、`lastUrlOwnerRef`、`authEpochRef`
- Effect：
  - `authEpochRef` 镜像（deps `[authEpoch]`）
  - `hydrate`（deps `[userId]`）
- 渲染期状态调整：
  - `stateOwner !== userId` → 清空 `lastUrl` / `pendingUrl`
  - `stateEpoch !== authEpoch` → 清空 `pendingUrl`（不清 `lastUrl`）
- Callback：`setPendingUrl`、`consumePendingUrl`、`rememberUrl`

## 身份隔离契约（必须逐条保持）

1. 存储 key 命名：`@sync_browser_history_v2_${userId}`、`@sync_browser_bookmarks_v2_${userId}`、
   `@sync_browser_bookmarks_seed_v2_${userId}`、`@browser_last_url_v2_${userId}`。
2. 无有效 userId：不读、不写、不展示任何数据（fail-closed）。
3. 默认书签内容与顺序：Bing / Google / Baidu / DuckDuckGo / Sogou / Yahoo。
4. 书签种子版本号：`BOOKMARKS_SEED_VERSION = 2`。
5. 历史记录上限：`HISTORY_LIMIT = 100`。
6. 同 URL 去重 + 置顶（`mergeHistoryEntry`）。
7. `historyListRef` 影子状态同步（同一事件循环内连续写入不互相覆盖）。
8. 落盘前二次 owner / epoch / key 校验。
9. 异步读取回写前 owner 校验（`userIdRef.current !== loadOwnerId` 丢弃）。
10. A→B→A 旧回调丢弃（`authEpoch` 代际比对）。
11. 同账号新 authEpoch 旧回调丢弃。
12. 渲染期内存态归属重置（不写 ref、不触发级联渲染）。
13. AsyncStorage 读写次数、顺序、JSON 内容不变。
14. 时间戳求值顺序：`Date.now(ID) → Math.random → buildHistoryTitle → Date.now(timestamp)`。
