# P1.3 R2 冻结基线 — 浏览器媒体嗅探 Hook

## 用途

本目录保存 P1.3 R2「媒体嗅探决策解耦」**修改前**的真实源码全文，用于新旧并行执行等价测试。
基线只读，任何测试不得修改本目录内容以制造通过。

## 文件清单

| 文件 | 原始路径 | 行数 | SHA-256 |
|------|----------|------|---------|
| `hooks__browser__useBrowserSniffer.js` | `src/hooks/browser/useBrowserSniffer.js` | 214 | `6b0d945f80f0f1e1368776eb28a1feb76bc65cb04a6edb30dff7504e4d38a5eb` |

## 冻结时点

- 分支：`refactor/phase-0`
- HEAD：`96881618a70a7b16871a7223ec81074601d64692`
- 冻结时间：P1.3 R2 Phase C（修改前）

## 基线内容要点（供契约核对）

1. `FILTER_OPTIONS = ['ALL', 'MP4', 'M3U8', 'MOV']`（顺序即 UI 展示顺序）
2. `isSafeMediaUrl(url)`：M-5 协议白名单，仅放行 `^https?:\/\/\S+`（大小写不敏感），非字符串 / 空串 / 纯空白一律 false
3. `pushMedia(incoming)`：`Array.isArray` 兜底 → `filter(isSafeMediaUrl)` → `map(url => url.trim())` → 空则静默返回 → `mergeMediaList(prev, safeIncoming)`
4. `handleWebMessage(event)`：`JSON.parse` 失败返回 false；`VIDEO_FOUND`（需 `data.url` 真值）/ `VIDEO_FOUND_LIST`（`Array.isArray(data.urls)` 后 `filter(Boolean)`）/ `MANUAL_SNIFF_DONE` 三类消费，其余返回 false
5. `formatCounts`：`reduce` 累加 `{ALL, MP4, M3U8, MOV}`，`ext` 取 `(item.ext || '').toUpperCase()`
6. `filteredMediaList`：`filterFormat === 'ALL'` 时**返回原数组引用**（不新建），否则 `filter(item => (item.ext || '').toUpperCase() === filterFormat)`
7. `triggerManualSniff(webViewRef)`：Haptics Warning → `setIsSniffing(true)` → 若 ref 存在则 `injectJavaScript(MANUAL_SNIFF_SCRIPT)` → 清旧 timer → `setTimeout(2000)` 复位
8. 卸载 Effect：`clearTimeout(sniffTimerRef.current)` 并置 null
9. `onMediaFoundRef` 同步 Effect：依赖 `[onMediaFound]`

## 已知原始行为特征（仅记录，不在本批修复）

- `filteredMediaList` 在 `ALL` 分支返回 `sniffedMediaList` **同一引用**；若改为新建数组会破坏下游 `FlatList` 的引用相等语义。
- `pushMedia` 中 `map(url => url.trim())` 在 `filter` 之后执行，因此 `isSafeMediaUrl` 已保证是字符串。
- `formatCounts` 对 `ext` 为 `'media'`（无法识别）的项只累加 `ALL`，不计入任何具体格式。
