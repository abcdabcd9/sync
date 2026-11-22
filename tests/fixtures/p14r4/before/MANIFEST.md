# P1.4 R4 — Cinema Hook 迁移前冻结基线

## 冻结文件

| 文件 | 说明 |
|---|---|
| `hooks__useCinema.js` | `src/hooks/useCinema.js` 迁移前真实源码（521 行 / 26261 字节） |

## 校验方式

```bash
shasum -a 256 tests/fixtures/p14r4/before/hooks__useCinema.js
# 期望：217660aed60a8e7812b6e3061fda271ad5de59a0ea33b332ad91494d2d526d83
```

## 迁移目标

| 迁移前 | 迁移后 |
|---|---|
| `src/hooks/useCinema.js` | `src/hooks/useCinema.tsx` |
| （内联 `buildVideoSource` / `MOBILE_UA`） | `src/hooks/cinema/videoSource.ts` |

## 公开接口（必须逐项保持）

### 导出

- `CinemaProvider({ children })` — React 组件
- `useCinema()` — 返回 `CinemaContext` 值

### State（10）

`currentUrl`、`isMinimized`、`isPlaying`、`episodeList`、`episodePageUrl`、`currentEpisodeIndex`、`episodeSwitchRequest`、`episodeListRequested`、`episodeListRequest`、`cinemaRoomId`

### Ref（13）

`isHandlingRemote`、`silenceTimer`、`lastPlayingState`、`lastVideoTime`、`lastForceSyncTime`、`seekLockTimer`、`currentUrlRef`、`isScrubbingRef`、`episodePageUrlRef`、`lastPartnerBroadcastRef`、`pollTimerRef`、`handledRemoteCommandRef`、`prevOwnerKeyRef`

### useCallback（8）

`setScrubbing`、`stopPolling`、`startPolling`、`loadUrl`、`closePlayer`、`togglePlay`、`applyEpisodeList`、`requestEpisode`、`playPrevEpisode`、`playNextEpisode`、`clearEpisodes`

### useEffect（5）

1. 音频混音设置（`setAudioModeAsync`，deps `[]`）
2. `currentUrlRef` 同步（deps `[currentUrl]`）
3. `episodePageUrlRef` 同步（deps `[episodePageUrl]`）
4. partnerStatus 广播（deps `[partnerStatus]`）
5. 轮询启停（deps `[player, currentUrl, startPolling, stopPolling]`）
6. AppState 监听（deps `[startPolling, stopPolling]`）
7. remoteCommand 处理（deps `[remoteCommand]`）
8. ownerKey 变化清理（deps `[ownerKey, player]`）

### value 对象字段（30）

`player, currentUrl, isMinimized, setIsMinimized, partnerStatus, emitCommand, loadUrl, closePlayer, isPlaying, togglePlay, cinemaRoomId, setCinemaRoomId, danmakuList, emitDanmaku, ownerKey, setScrubbing, episodeList, episodePageUrl, currentEpisodeIndex, episodeSwitchRequest, episodeListRequested, episodeListRequest, applyEpisodeList, requestEpisode, playPrevEpisode, playNextEpisode, clearEpisodes`

## 业务不变量（等价测试逐条覆盖）

1. 同源短路（`loadUrl` 不重复 `replaceAsync`）
2. remoteCommand 引用去重
3. seek 锁 3000ms
4. AUTO_SYNC 节流 2000ms
5. 漂移阈值 2.5s
6. iOS/Android 时序差异（50ms+1000ms vs 800ms）
7. partnerStatus 广播去重 + 无效 currentTime 不广播
8. 切号清理不调 RPC
9. closePlayer 调 RPC 且吞异常
10. `isHandlingRemote` 静默窗口 1200ms
11. 拖动期间跳过漂移判定
12. `episodeListRequest` 一次性语义
