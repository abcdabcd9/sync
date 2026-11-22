/**
 * 影院 / Realtime 契约（TASK-P1.1 R0 — Phase B6 校正）
 *
 * 依据（逐字段核对，非猜测）：
 *   - `src/hooks/useSyncRoom.js` 第 47–178 行（broadcast `sync_command` / `danmaku`、presence）
 *   - `src/hooks/useCinema.js` 第 45–47 行（episodeList 结构注释）、第 135–318 行（指令类型）
 *   - `src/utils/episodeUrl.js` 第 22–42 行 `parseEpisodeUrl`（剧集解析真实字段）
 *   - `src/app/invite_friend.js`（影院邀请消息 `type: 'cinema_invite'`）
 *
 * ⚠️ 关键校正（相对上一版）：
 *   1. `SyncCommandPayload.url` 实际**可为 null**（`emitCommand(type, time=0, url=null)`）。
 *   2. `PartnerPresenceStatus` 不是 `'online'|'offline'|'unknown'` 枚举，而是
 *      **展示字符串**（`'等待建立连接...'` / `'对方已加入房间'` / `'等待对方加入...'`）。
 *   3. `EpisodeItem.episodeId` 是 **number**（`Number(m[3])`），不是 string；
 *      且真实解析结果还带 `origin` / `raw`。
 *   4. `emitCommand` 的 `time` / `url` 均有默认值，签名应为可选参数。
 */

/** 播放控制指令类型（`useCinema` 实际 emit / 消费） */
export type PlaybackCommandType = 'PLAY' | 'PAUSE' | 'FORCE_SYNC' | 'AUTO_SYNC';

/**
 * `sync_command` 广播载荷。
 *
 * 真实来源：`useSyncRoom.js` 第 158–162 行 `emitCommand`：
 *   `{ senderId: deviceId, type, time, url }`
 * 其中 `time` 默认 0、`url` 默认 null。
 */
export interface SyncCommandPayload {
  senderId: string;
  type: PlaybackCommandType;
  /** 播放进度（秒） */
  time: number;
  /** 媒体地址（可为 null） */
  url: string | null;
}

/**
 * `danmaku` 广播载荷。
 *
 * 真实来源：`useSyncRoom.js` 第 165–168 行 `emitDanmaku`：
 *   `{ senderId: deviceId, id: Date.now().toString(), text, color, timestamp: Date.now() }`
 */
export interface DanmakuPayload {
  senderId: string;
  id: string;
  text: string;
  color: string;
  /** 毫秒时间戳 */
  timestamp: number;
}

/** 本地弹幕列表项（与广播载荷同构，便于直接追加） */
export type DanmakuItem = DanmakuPayload;

/**
 * 伴侣在线状态（presence 派生的**展示字符串**）。
 *
 * 真实取值（`useSyncRoom.js`）：
 *   - `'等待建立连接...'`（初始）
 *   - `'对方已加入房间'`（presence 在线数 > 1）
 *   - `'等待对方加入...'`（presence 在线数 <= 1）
 *
 * 注意：这是直接用于 UI 展示的中文字符串，**不是**固定的 `online/offline` 枚举。
 */
export type PartnerPresenceStatus = string;

/**
 * 剧集列表项（`useCinema` 的 `episodeList` 元素）。
 *
 * 真实来源：`useCinema.js` 第 45 行注释
 *   `episodeList: [{ url, label, vodId, sourceId, episodeId }]`
 * 其中 `vodId` / `sourceId` 为字符串，`episodeId` 为**数字**
 * （见 `episodeUrl.js#parseEpisodeUrl` 的 `Number(m[3])`）。
 */
export interface EpisodeItem {
  url: string;
  label: string;
  vodId: string | null;
  sourceId: string | null;
  episodeId: number | null;
}

/** 影院邀请消息子类型（与 `messages.subtype` 对应） */
export type CinemaInviteSubtype = 'SYNC_CINEMA_INVITE' | 'SYNC_CINEMA_ENDED';

/** 影院房间可见性（邀请消息 `type` 取值） */
export type CinemaInviteMessageType = 'cinema_invite';

/**
 * `useSyncRoom()` 的返回。
 *
 * 真实来源：`useSyncRoom.js` 第 177 行：
 *   `{ partnerStatus, remoteCommand, emitCommand, danmakuList, emitDanmaku, ownerKey: dataOwnerKey }`
 */
export interface SyncRoomState {
  partnerStatus: PartnerPresenceStatus;
  remoteCommand: SyncCommandPayload | null;
  /** `time` 默认 0、`url` 默认 null */
  emitCommand: (type: PlaybackCommandType, time?: number, url?: string | null) => void;
  danmakuList: DanmakuItem[];
  /** `color` 默认 '#FFFFFF' */
  emitDanmaku: (text: string, color?: string) => void;
  /** 数据归属键（dataOwnerKey），用于跨账号隔离 */
  ownerKey: string;
}
