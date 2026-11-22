/**
 * 消息 / 聊天契约（TASK-P1.1 R0 — Phase B2 校正）
 *
 * 依据（逐字段核对，非猜测）：
 *   - `messages` 表：migration 07 第 59–72 行（`type TEXT NOT NULL`，**无 CHECK**）、
 *     migration 01（subtype）、migration 19（deleted_by UUID[] NOT NULL DEFAULT '{}'）
 *   - `src/hooks/chat/useChatMessages.js#formatDbMsg`（第 14–26 行，客户端消息形态）
 *   - `src/hooks/chat/useChatMessages.js#revokeMessage`（第 330–399 行，撤回写 action）
 *   - `src/hooks/chat/useChatList.js#formatPreview`（第 69–84 行，返回**字符串**）
 *   - `src/hooks/chat/useChatList.js` 第 460–499 行（conversations = friends 排序）
 *   - `src/hooks/chat/useChatFavorites.js` 第 113–126 行（收藏项真实字段）
 *   - `src/components/MessageBubble.js` 第 21–51 行（subtype → 展示类型映射）
 *   - `src/app/invite_friend.js` / `src/hooks/useHealthData.js` / `src/app/bind_partner.js`
 *     （真实写入的 type / subtype 取值）
 *
 * ⚠️ 关键校正（相对上一版）：
 *   1. `messages.type` 是 `TEXT NOT NULL` 且**无 CHECK/ENUM**，因此**不得**建模为
 *      封闭联合。这里拆成 `KnownMessageType`（已知取值，便于补全）与
 *      `MessageType = KnownMessageType | (string & {})`（开放，兼容历史/未来值）。
 *   2. `ChatMessage.timestamp` 是**毫秒数字**（`new Date(created_at).getTime()`），
 *      不是字符串。
 *   3. `ChatPreview` 实际是 `formatPreview()` 返回的**字符串**，不是对象。
 *   4. `Conversation` 实际就是 `friends` 数组元素（profiles 行），**没有**
 *      `preview` / `unreadCount` 等聚合字段；聚合数据在 `latestMessages` /
 *      `unreadCounts` / `lastMsgTimes` 三个独立 map 中。
 *   5. `ChatFavoriteItem.timestamp` / `.savedAt` 是**数字**；`msgId` / `peerId`
 *      实际可为 `null`（`msg.id` 缺失 / `meta.peerId` 缺失时）。
 */

import type { MessagesRow } from './database';

/**
 * 已知消息类型（数据库 `type` 列的真实取值，来自全仓库写入点）。
 *
 * 注意：这只是「已知集合」，不是封闭枚举 —— 见 `MessageType`。
 */
export type KnownMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'cinema_invite'
  | 'location'
  | 'system'
  | 'action';

/**
 * 消息类型（数据库 `type` 列，`TEXT NOT NULL` 无约束）。
 *
 * 开放字符串：既保留已知取值的补全能力，又允许历史/未来任意值，
 * 避免把无约束的 TEXT 列错误建模为封闭联合。
 */
export type MessageType = KnownMessageType | (string & {});

/**
 * 已知消息子类型（数据库 `subtype` 列，可空，`TEXT` 无约束）。
 *
 * 真实来源：
 *   - 影院：`SYNC_CINEMA_INVITE` / `SYNC_CINEMA_ENDED`（migration 29）
 *   - 健康搭子：`SYNC_PARTNER_INVITE` / `SYNC_PARTNER_ACCEPTED` /
 *     `SYNC_PARTNER_REJECTED` / `SYNC_PARTNER_UNBOUND`（migration 05/14）
 *     / `SYNC_PARTNER_EXPIRED`（migration 20）
 *   - 系统：`SYNC_SYSTEM`（useHealthData 打卡消息）
 *   - 语音：`SYNC_AUDIO`（MessageBubble / useChatMessages 音频识别）
 */
export type KnownMessageSubtype =
  | 'SYNC_CINEMA_INVITE'
  | 'SYNC_CINEMA_ENDED'
  | 'SYNC_PARTNER_INVITE'
  | 'SYNC_PARTNER_ACCEPTED'
  | 'SYNC_PARTNER_REJECTED'
  | 'SYNC_PARTNER_UNBOUND'
  | 'SYNC_PARTNER_EXPIRED'
  | 'SYNC_SYSTEM'
  | 'SYNC_AUDIO';

/**
 * 消息子类型（数据库 `subtype` 列，可空，`TEXT` 无约束）。
 *
 * 开放字符串 + `null`：`subtype` 为 NULL 表示普通聊天消息。
 */
export type MessageSubtype = KnownMessageSubtype | (string & {}) | null;

/**
 * `messages` 表行（数据库原始形态）。
 *
 * ⚠️ 权威定义在 `database.ts#MessagesRow`，此处**别名**引用，避免两处漂移。
 *
 * 可空性严格对应 schema（migration 07 + 19）：
 *   - NOT NULL：id / created_at / user_id / type / deleted_by
 *   - `duration`（INTEGER DEFAULT 0）/ `is_read`（BOOLEAN DEFAULT false）**无 NOT NULL**，故可空
 *   - `text` / `media_url` / `thumbnail_url` / `receiver_id` / `group_id` / `subtype` 可空
 *
 * 注意：`type` / `subtype` 在 database.ts 中为 `string` / `string | null`（开放），
 * 与 `MessageType` / `MessageSubtype` 语义一致（后者是前者的领域别名）。
 */
export type MessageRow = MessagesRow;

/**
 * 客户端格式化后的消息（`formatDbMsg` 的返回）。
 *
 * 与 `MessageRow` 的差异（见 `useChatMessages.js` 第 14–26 行）：
 *   - 用 `isMe` 替代 `user_id` 判断
 *   - `timestamp` 是 `new Date(created_at).getTime()` 的**毫秒数字**
 *   - 字段名改为 camelCase
 */
export interface ChatMessage {
  id: string;
  type: MessageType;
  subtype: MessageSubtype;
  text: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
  isMe: boolean;
  /** 毫秒时间戳（`new Date(created_at).getTime()`） */
  timestamp: number;
}

/**
 * 会话预览文本（`formatPreview()` 的返回）。
 *
 * 真实返回是**字符串**（如 `'[图片]'` / `'你们已成为健康搭子！'`），
 * 不是对象。见 `useChatList.js` 第 69–84 行。
 */
export type ChatPreview = string;

/**
 * 会话列表项。
 *
 * 真实来源：`useChatList.js` 第 460–499 行 —— `conversations` 就是
 * `friends`（profiles 行）按 `lastMsgTimes` 排序后的数组，**没有**聚合字段。
 * 预览 / 未读 / 时间分别在 `latestMessages` / `unreadCounts` / `lastMsgTimes`
 * 三个独立 map 中，以 `peerId` 为键。
 *
 * 因此这里只声明 profiles 行中真实被会话列表读取的字段子集。
 */
export interface Conversation {
  id: string;
  username: string | null;
  nickname: string | null;
  sync_id: string | null;
}

/**
 * 收藏消息项（`useChatFavorites` 本地存储结构）。
 *
 * 真实来源：`useChatFavorites.js` 第 113–126 行 `entry` 对象。
 *   - `msgId`：`msg.id`（可能缺失 → 归一化后可为 null）
 *   - `peerId`：`meta.peerId || null`（可为 null）
 *   - `timestamp`：`msg.timestamp || Date.now()`（**数字**）
 *   - `savedAt`：`Date.now()`（**数字**）
 */
export interface ChatFavoriteItem {
  id: string;
  msgId: string | null;
  type: MessageType;
  text: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
  peerId: string | null;
  peerName: string;
  isMe: boolean;
  /** 毫秒时间戳 */
  timestamp: number;
  /** 毫秒时间戳 */
  savedAt: number;
}

/**
 * 聊天偏好（`useChatPrefs` 本地存储结构）。
 *
 * 各数组元素为 peerId；`backgrounds` 为 peerId → 背景标识。
 */
export interface ChatPrefs {
  pinned: string[];
  hidden: string[];
  muted: string[];
  starred: string[];
  blocked: string[];
  backgrounds: Record<string, string>;
}

/** 聊天本地存储键前缀（与实现保持一致，供类型层引用） */
export const CHAT_FAVORITES_KEY_PREFIX = 'sync_chat_favorites_v1_';
export const CHAT_PREFS_KEY_PREFIX = 'sync_chat_prefs_v1_';
