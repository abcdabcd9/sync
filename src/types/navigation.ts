/**
 * 导航路由参数契约（TASK-P1.1 R0 / Phase C7）
 *
 * 来源：对 `src/app/**` 中 `useLocalSearchParams()` 与 `router.push()/replace()`
 *       实际传参的扫描结果。仅收录**跨模块共享**的核心路由参数类型；
 *       页面局部 Props 留待后续 TSX 迁移任务登记。
 *
 * 重要约定：
 * - Expo Router 的 `useLocalSearchParams()` 返回值在运行时**全部是 string**
 *   （或 string[]），且可能缺失。因此这里的字段一律声明为 `string`，
 *   可选字段用 `?` 表示"调用方可能不传"，而不是"运行时一定存在"。
 * - 本文件不引入 expo-router 依赖，保持纯类型、零运行时。
 */

/* ------------------------------------------------------------------ *
 * 1. 聊天相关路由
 * ------------------------------------------------------------------ */

/** `/chat_room` —— 聊天室主界面 */
export interface ChatRoomParams {
  /** 对方用户 id（必传） */
  targetId: string;
  /** 对方显示名（用于标题兜底） */
  targetName?: string;
  /** 位置消息回传：纬度（字符串形式） */
  locLat?: string;
  /** 位置消息回传：经度（字符串形式） */
  locLng?: string;
  /** 位置消息回传：地点名称 */
  locLabel?: string;
}

/** `/chat/chat_settings` —— 聊天设置 */
export interface ChatSettingsParams {
  targetId: string;
  targetName?: string;
}

/** `/chat/chat_background` —— 聊天背景选择 */
export interface ChatBackgroundParams {
  targetId: string;
}

/** `/chat/chat_search` —— 聊天记录搜索 */
export interface ChatSearchParams {
  targetId: string;
  targetName?: string;
}

/** `/chat/location` —— 位置选择/发送 */
export interface ChatLocationParams {
  targetId: string;
  targetName?: string;
}

/** `/chat/complaint` —— 举报 */
export interface ComplaintParams {
  targetId: string;
  targetName?: string;
  /** 举报作用域（由调用方传入，DB 无此列，仅前端路由使用） */
  scope?: string;
}

/** `/chat/moments` —— 某用户的朋友圈 */
export interface MomentsParams {
  id: string;
  nickname?: string;
}

/** `/chat/friend_settings` —— 好友设置 */
export interface FriendSettingsParams {
  id: string;
  nickname?: string;
  username?: string;
  sync_id?: string;
  remark?: string;
}

/** `/chat/friend_permission` —— 好友权限 */
export interface FriendPermissionParams {
  nickname?: string;
}

/** `/contact_profile` —— 联系人资料页 */
export interface ContactProfileParams {
  id: string;
  nickname?: string;
  sync_id?: string;
  username?: string;
  remark?: string;
}

/** `/invite_friend` —— 邀请好友进入同步房间 */
export interface InviteFriendParams {
  roomId: string;
}

/* ------------------------------------------------------------------ *
 * 2. 浏览器 / 影院路由
 * ------------------------------------------------------------------ */

/**
 * `/browser/index` —— 内置浏览器
 *
 * 说明：该页面通过 `useLocalSearchParams()` 读取参数，但当前源码中
 *       未显式声明字段名。此处仅登记"存在路由参数"这一事实，
 *       具体字段待后续 TSX 迁移时按真实读取补齐。
 */
export interface BrowserParams {
  /** 初始 URL（若调用方传入） */
  url?: string;
  [key: string]: string | string[] | undefined;
}

/**
 * `/cinema` —— 同步影院
 *
 * 说明：同 BrowserParams，当前源码未显式声明字段名。
 */
export interface CinemaParams {
  /** 房间 id（若调用方传入） */
  roomId?: string;
  [key: string]: string | string[] | undefined;
}

/* ------------------------------------------------------------------ *
 * 3. 认证路由
 * ------------------------------------------------------------------ */

/**
 * `/auth` —— 登录/注册
 *
 * 说明：该页面通过 `useLocalSearchParams()` 读取参数，当前源码未显式
 *       声明字段名。此处仅登记存在路由参数。
 */
export interface AuthRouteParams {
  [key: string]: string | string[] | undefined;
}

/* ------------------------------------------------------------------ *
 * 4. 通知点击导航数据
 * ------------------------------------------------------------------ */

/**
 * 推送通知点击后携带的导航数据（来自 `usePushNotifications.js` 的
 * `router.push({ pathname, params })` 分支）。
 *
 * 注意：这是**通知 data 载荷**，不是路由参数本身；字段可能缺失。
 */
export interface NotificationNavigationData {
  /** 目标路由 pathname，例如 `/chat_room` */
  pathname?: string;
  /** 目标路由参数 */
  params?: Record<string, string>;
  /** 原始推送 data（透传） */
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * 5. 路由名常量（仅类型层，便于后续统一引用）
 * ------------------------------------------------------------------ */

/** 已登记的核心路由 pathname 字面量联合 */
export type KnownRoutePath =
  | '/chat_room'
  | '/chat/chat_settings'
  | '/chat/chat_background'
  | '/chat/chat_search'
  | '/chat/location'
  | '/chat/complaint'
  | '/chat/moments'
  | '/chat/friend_settings'
  | '/chat/friend_permission'
  | '/contact_profile'
  | '/invite_friend'
  | '/browser/index'
  | '/cinema'
  | '/auth';
