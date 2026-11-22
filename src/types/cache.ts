/**
 * 缓存 / 本地存储契约（TASK-P1.1 R0）
 *
 * 依据（真实客户端代码）：
 *   - `src/hooks/useOwnerKey.js`：ownerKey 生成规则
 *   - `src/services/mediaCache.js`：媒体缓存身份与操作
 *   - `src/hooks/profile/useProfileCache.js`：资料缓存键
 *   - `src/hooks/chat/useChatMessages.js` / `useChatList.js`：聊天缓存键
 *
 * 说明：本文件只声明**真实存在**的缓存键规则与身份结构，不发明新键。
 */

import type { OwnerKey } from './auth';

/**
 * 媒体缓存身份。
 *
 * 用于在账号切换时判定缓存是否属于当前身份，避免跨账号串数据。
 */
export interface MediaCacheIdentity {
  ownerId: string | null;
  authEpoch: number;
}

/** 资料缓存键（`useProfileCache`） */
export function profileCacheKey(userId: string): string {
  return `@user_profile_cache_v2_${userId}`;
}

/** 聊天消息缓存键（`useChatMessages`） */
export function chatMessagesCacheKey(userId: string, targetId: string): string {
  return `@chatMessages_${userId}_${targetId}`;
}

/** 已删除消息 id 缓存键（`useChatMessages`） */
export function deletedMessagesCacheKey(userId: string, targetId: string): string {
  return `@deletedMsgIds_${userId}_${targetId}`;
}

/** 会话列表缓存键（`useChatList`） */
export function chatListCacheKey(userId: string): string {
  return `@chatList_${userId}`;
}

/** 好友列表缓存键（`useChatList`） */
export function friendsListCacheKey(userId: string): string {
  return `@friends_list_${userId}`;
}

/**
 * 缓存条目通用包装。
 *
 * 说明：现有实现多数直接存业务对象；此接口用于需要显式记录归属与时间的场景。
 */
export interface OwnerScopedCacheEntry<T> {
  ownerKey: OwnerKey;
  updatedAt: string;
  data: T;
}
