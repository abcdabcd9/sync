# P1.3 R3 冻结基线 — 浏览器历史 / 书签域 Hook

本目录保存 **P1.3 R3 解耦前** 的真实源码快照，用于新旧行为等价对比。
基线只读，任何测试不得修改本目录内容（测试启动时校验 SHA-256）。

## 文件

| 文件 | 来源 | SHA-256 |
|------|------|---------|
| `hooks__browser__useBrowserHistory.js` | `src/hooks/browser/useBrowserHistory.js`（解耦前，380 行） | `7f72d99b035e1f92227cb8349089f66c1221d130b2362bde19e7deaac5f5828d` |

## 解耦前真实结构（逐项核对，非猜测）

### 公开接口（返回对象，8 个键）
```
historyList, addHistory, deleteHistory, clearHistory,
bookmarksList, toggleBookmark, removeBookmark, isBookmarked
```

### 模块级常量
- `DEFAULT_BOOKMARKS`：6 个默认搜索引擎书签（全部 https://）
- `BOOKMARKS_SEED_VERSION = 2`
- `BOOKMARKS_SEED_KEY_PREFIX = '@sync_browser_bookmarks_seed_v2_'`
- `buildBookmarksSeedKey(userId)`：无有效 userId 返回 null
- `LEGACY_DEFAULT_BOOKMARKS`：运行时拼接的旧默认书签（迁移时精确匹配剔除）

### 模块级纯函数（本次解耦候选）
- `normalizeBookmark(item)`：字符串→`{url,title:''}`（需 isSafeUrl 通过）；对象→仅保留合法 url/title，title trim；非法→null
- `normalizeBookmarkList(list)`：非数组→[]；逐项归一化 + 按 url 去重（保留首次出现顺序）

### State / Ref / Effect / Callback / Memo（依赖数组逐项）
| 名称 | 类型 | 依赖数组 |
|------|------|----------|
| `historyList` | useState([]) | — |
| `bookmarksList` | useState([]) | — |
| `historyKey` | useMemo | `[userId]` |
| `bookmarksKey` | useMemo | `[userId]` |
| `seedKey` | useMemo | `[userId]` |
| `keysRef` | useRef | — |
| keysRef 同步 effect | useEffect | `[historyKey, bookmarksKey, seedKey]` |
| `userIdRef` | useRef | — |
| userIdRef 同步 effect | useEffect | `[userId]` |
| `authEpochRef` | useRef | — |
| authEpochRef 同步 effect | useEffect | `[authEpoch]` |
| `historyListRef` | useRef | — |
| historyListRef 同步 effect | useEffect | `[historyList]` |
| `prevOwner` 渲染期重置 | useState + 渲染期 setState | — |
| 读取书签 effect | useEffect | `[bookmarksKey, seedKey, userId]` |
| 读取历史 effect | useEffect | `[historyKey, userId]` |
| `addHistory` | useCallback | `[userId, authEpoch]` |
| `deleteHistory` | useCallback | `[userId, authEpoch]` |
| `clearHistory` | useCallback | `[userId, authEpoch]` |
| `isBookmarked` | useCallback | `[bookmarksList]` |
| `toggleBookmark` | useCallback | `[bookmarksList, userId, authEpoch]` |
| `removeBookmark` | useCallback | `[bookmarksList, userId, authEpoch]` |

### 身份隔离机制（P0.3 / B1-C / CR-03 / 14-03 / 14-04）
1. 存储 key 按 userId 隔离（V2 命名空间），无 userId 时 key 为 null → 不读不写。
2. 旧全局 key 原样保留、绝不读写、绝不迁移。
3. 异步读取结果回写前校验 `userIdRef.current === loadOwnerId`，否则丢弃。
4. 写回调闭包绑定 `ownerAtCreate = userId` + `epochAtCreate = authEpoch`；
   执行时与 `userIdRef.current` / `authEpochRef.current` 比对，不一致整条丢弃（覆盖 A→B→A）。
5. 落盘前二次校验 owner/epoch/key 未变化。
6. `historyListRef` 在写入点同步推进，使同一事件循环内连续 addHistory 不互相覆盖。
7. 身份变化时渲染期清空内存态（`prevOwner !== userId`）。

### 历史写入规则（addHistory）
- `isSafeUrl(url)` 不通过 → 直接 return（不写）
- `url.includes('cn.bing.com/search')` → 直接 return（不记录搜索页）
- 无 key → return
- 迟到回调（owner/epoch 变化）→ return
- 构造 entry：`{ id: Date.now()-random, url, title: buildHistoryTitle(title,url), timestamp: Date.now() }`
- 若 `prev[0].url === url` → return（同一页面重复回调跳过）
- `next = [entry, ...prev.filter(it => it.url !== url)].slice(0, HISTORY_LIMIT)`
- 落盘前二次校验 → 同步推进 historyListRef → setHistoryList → AsyncStorage.setItem

### 历史读取规则（loadHistory effect）
- 无 historyKey → return
- `JSON.parse` 失败 / 非数组 → 丢弃
- `filter(it => it && typeof it.url === 'string' && isSafeUrl(it.url)).slice(0, HISTORY_LIMIT)`

### 书签读取规则（loadBookmarks effect）
- 无 bookmarksKey/seedKey → return
- 无缓存（cached === null）→ 落 DEFAULT_BOOKMARKS + seed 版本
- 有缓存 → `normalizeBookmarkList(JSON.parse(cached))`
- seed 版本已最新 → 原样使用
- seed 版本落后 → 剔除 LEGACY_DEFAULT_BOOKMARKS → 前置 DEFAULT_BOOKMARKS → 归一化去重 → 落盘

### 书签切换规则（toggleBookmark）
- `isSafeUrl(url)` 不通过 → `{ ok:false, action:'invalid' }`
- 无 key / 迟到回调 → `{ ok:false, action:'invalid' }`
- 已收藏 → 过滤掉该 url；未收藏 → `[normalizeBookmark({url,title}), ...bookmarksList].filter(Boolean)`
- 落盘前二次校验 → setBookmarksList → AsyncStorage.setItem
- 返回 `{ ok:true, action: already ? 'removed' : 'added' }`

### 删除书签（removeBookmark）
- 无 key / 迟到回调 → return
- `next = bookmarksList.filter(it => it.url !== url)`
- 二次校验 → setBookmarksList → AsyncStorage.setItem

### 删除历史（deleteHistory）
- 无 key / 迟到回调 → return
- `next = historyListRef.current.filter(it => it.id !== idOrUrl && it.url !== idOrUrl)`
- 二次校验 → 同步推进 ref → setHistoryList → AsyncStorage.setItem

### 清空历史（clearHistory）
- 无 key / 迟到回调 / key 变化 → return
- `historyListRef.current = []` → setHistoryList([]) → AsyncStorage.removeItem

### 已收藏判定（isBookmarked）
- `!!url && bookmarksList.some(it => it.url === url)`

## 消费者
- `src/app/browser/index.js`：`useBrowserHistory(user?.id ?? null, authEpoch)` → 使用 addHistory / toggleBookmark / isBookmarked
- `src/app/browser/history.js`：使用 historyList / deleteHistory / clearHistory
- `src/app/browser/bookmarks.js`：使用 bookmarksList / removeBookmark
- `src/app/settings/security.js`：引用 key 前缀常量做清理（不直接调用 Hook）

## 既有安全测试覆盖
- `tests/security/t6bRuntime.test.mjs`：T-X06（A 迟到回调不得写 B key）、14-03（authEpoch ABA）、14-04（同循环连续 addHistory）
- `tests/security/b1Isolation.test.mjs`：复制 useBrowserHistory.js 做隔离静态检查
