// --- START OF FILE src/hooks/chat/useChatFavorites.ts ---
import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * ⭐ 聊天收藏（本地持久化）
 *
 * 为什么不用数据库：messages 表没有「收藏」字段，加列属于数据层变更。
 * 这里用 AsyncStorage 按「用户 ID」隔离存储，切换账号互不干扰。
 *
 * 存储结构（单个 key，避免多次读写）：
 *   [
 *     {
 *       id: 'fav_1699999999_123',   // 收藏项自身 ID
 *       msgId: 'uuid',              // 原消息 ID（用于去重）
 *       type: 'text' | 'image' | 'video' | 'audio',
 *       text: '...',                // 文本内容（媒体消息为空）
 *       mediaUrl: 'path',           // 媒体相对路径（文本消息为 null）
 *       thumbnailUrl: 'path',
 *       duration: 0,
 *       peerId: 'friendId',         // 来自哪个会话
 *       peerName: '好友昵称',
 *       isMe: false,
 *       timestamp: 1699999999000,   // 原消息时间
 *       savedAt: 1699999999000,     // 收藏时间
 *     },
 *   ]
 *
 * ⚠️ 与 useChatPrefs 相同的「派生 loaded」模式：
 *    绝不在 effect 里同步 setState，避免 react-hooks/set-state-in-effect。
 */
const KEY_PREFIX = 'sync_chat_favorites_v1_';

/** 收藏项（落盘结构） */
export interface FavoriteItem {
  id: string;
  msgId: string | null;
  type: string;
  text: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
  peerId: string | null;
  peerName: string;
  isMe: boolean;
  timestamp: number;
  savedAt: number;
}

/** 收藏来源消息（来自 MessageBubble 的 actionMessage，字段可能缺失） */
export interface FavoriteSourceMessage {
  id?: string | null;
  type?: string | null;
  text?: string | null;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  duration?: number | null;
  isMe?: boolean | null;
  timestamp?: number | null;
}

export interface FavoriteMeta {
  peerId?: string | null;
  peerName?: string | null;
}

export interface ChatFavoritesApi {
  loaded: boolean;
  items: FavoriteItem[];
  count: number;
  isFavorited: (msgId: string | null | undefined) => boolean;
  addFavorite: (msg: FavoriteSourceMessage | null | undefined, meta?: FavoriteMeta) => boolean;
  removeFavorite: (favId: string | null | undefined) => void;
  clearFavorites: () => void;
}

// ⚠️ 与迁移前 JS 严格一致：入参为任意 unknown（可能来自 JSON.parse 的脏数据），
//    逐字段做 typeof / 真值校验后再归一，不做任何额外的运行时分支。
const normalizeItem = (raw: unknown): FavoriteItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!r.id) return null;
  return {
    id: String(r.id),
    msgId: r.msgId ? String(r.msgId) : null,
    type: (r.type as string) || 'text',
    text: typeof r.text === 'string' ? r.text : '',
    mediaUrl: (r.mediaUrl as string) || null,
    thumbnailUrl: (r.thumbnailUrl as string) || null,
    duration: typeof r.duration === 'number' ? r.duration : 0,
    peerId: (r.peerId as string) || null,
    peerName: (r.peerName as string) || '',
    isMe: !!r.isMe,
    timestamp: typeof r.timestamp === 'number' ? r.timestamp : Date.now(),
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : Date.now(),
  };
};

const normalize = (raw: unknown): FavoriteItem[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeItem).filter((x): x is FavoriteItem => !!x);
};

const makeId = (): string => `fav_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

/** 收藏 Hook 的 user 入参（仅需 id） */
export interface ChatFavoritesUser {
  id?: string | null;
}

export function useChatFavorites(user: ChatFavoritesUser | null | undefined): ChatFavoritesApi {
  const storageKey = user?.id ? `${KEY_PREFIX}${user.id}` : null;
  // 记录「当前列表属于哪个 storageKey」，用于派生 loaded
  const [state, setState] = useState<{ key: string | null; items: FavoriteItem[] }>({ key: null, items: [] });

  // 读取：user 变化时重新加载（异步回调里 setState 是允许的）
  useEffect(() => {
    let cancelled = false;
    if (!storageKey) return () => { cancelled = true; };
    (async () => {
      let next: FavoriteItem[] = [];
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        next = raw ? normalize(JSON.parse(raw)) : [];
      } catch {
        next = [];
      }
      if (!cancelled) setState({ key: storageKey, items: next });
    })();
    return () => { cancelled = true; };
  }, [storageKey]);

  const loaded = storageKey ? state.key === storageKey : true;

  // 统一的「基于当前列表计算下一版并落盘」工具
  const update = useCallback(
    (compute: (base: FavoriteItem[]) => FavoriteItem[]) => {
      if (!storageKey) return;
      setState((prev) => {
        const base = prev.key === storageKey ? prev.items : [];
        const next = compute(base);
        if (next === base) return prev;
        AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
        return { key: storageKey, items: next };
      });
    },
    [storageKey]
  );

  /**
   * 收藏一条消息
   * @returns true = 新收藏，false = 已存在（重复收藏）
   */
  const addFavorite = useCallback(
    (msg: FavoriteSourceMessage | null | undefined, meta: FavoriteMeta = {}): boolean => {
      if (!msg || !msg.id) return false;
      let added = false;
      update((prev) => {
        // 同一条消息只收藏一次
        if (prev.some((it) => it.msgId === msg.id)) return prev;
        added = true;
        const entry = normalizeItem({
          id: makeId(),
          msgId: msg.id,
          type: msg.type || 'text',
          text: msg.text || '',
          mediaUrl: msg.mediaUrl || null,
          thumbnailUrl: msg.thumbnailUrl || null,
          duration: msg.duration || 0,
          peerId: meta.peerId || null,
          peerName: meta.peerName || '',
          isMe: !!msg.isMe,
          timestamp: msg.timestamp || Date.now(),
          savedAt: Date.now(),
        }) as FavoriteItem;
        return [entry, ...prev];
      });
      return added;
    },
    [update]
  );

  const removeFavorite = useCallback(
    (favId: string | null | undefined) => {
      if (!favId) return;
      update((prev) => (prev.some((it) => it.id === favId) ? prev.filter((it) => it.id !== favId) : prev));
    },
    [update]
  );

  const clearFavorites = useCallback(() => {
    update((prev) => (prev.length === 0 ? prev : []));
  }, [update]);

  const api = useMemo<ChatFavoritesApi>(() => {
    // 未加载完成时对外暴露空列表，避免闪现上一个账号的收藏
    const items = loaded ? state.items : [];
    return {
      loaded,
      items,
      count: items.length,
      isFavorited: (msgId) => items.some((it) => it.msgId === msgId),
      addFavorite,
      removeFavorite,
      clearFavorites,
    };
  }, [loaded, state.items, addFavorite, removeFavorite, clearFavorites]);

  return api;
}

export default useChatFavorites;
// --- END OF FILE src/hooks/chat/useChatFavorites.ts ---
