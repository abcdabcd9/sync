// --- START OF FILE src/hooks/chat/useChatPrefs.ts ---
import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatPrefs } from '../../types/chat';

/**
 * 会话级偏好（置顶 / 隐藏 / 免打扰 / 星标）持久化
 *
 * 为什么不用数据库：friends 表没有这些字段，加列属于数据层变更。
 * 这里用 AsyncStorage 按「用户 ID」隔离存储，切换账号互不干扰。
 *
 * 存储结构（单个 key，避免多次读写）：
 *   {
 *     pinned:   ['friendId', ...],
 *     hidden:   ['friendId', ...],
 *     muted:    ['friendId', ...],
 *     starred:  ['friendId', ...],
 *   }
 *
 * ⚠️ 隐藏恢复机制：hidden 只是「列表不显示」，
 *    一旦该会话产生新消息（收或发），调用方应调用 unhide(id) 让它重新出现。
 */
const KEY_PREFIX = 'sync_chat_prefs_v1_';

const EMPTY: ChatPrefs = { pinned: [], hidden: [], muted: [], starred: [], blocked: [], backgrounds: {} };

/** 可切换的列表字段（toggleIn / addTo / removeFrom 的合法入参） */
type PrefsListField = 'pinned' | 'hidden' | 'muted' | 'starred' | 'blocked';

interface PrefsState {
  key: string | null;
  prefs: ChatPrefs;
}

interface ChatPrefsUser {
  id?: string | null;
}

const normalize = (raw: unknown): ChatPrefs => {
  const r = (raw ?? {}) as Partial<Record<keyof ChatPrefs, unknown>>;
  return {
    pinned: Array.isArray(r.pinned) ? (r.pinned as string[]) : [],
    hidden: Array.isArray(r.hidden) ? (r.hidden as string[]) : [],
    muted: Array.isArray(r.muted) ? (r.muted as string[]) : [],
    starred: Array.isArray(r.starred) ? (r.starred as string[]) : [],
    blocked: Array.isArray(r.blocked) ? (r.blocked as string[]) : [],
    // 每个会话单独的背景：{ [friendId]: 'default' | 'dark' | ... }
    backgrounds:
      r.backgrounds && typeof r.backgrounds === 'object'
        ? (r.backgrounds as Record<string, string>)
        : {},
  };
};

export interface ChatPrefsApi {
  loaded: boolean;
  pinned: string[];
  hidden: string[];
  muted: string[];
  starred: string[];
  blocked: string[];
  backgrounds: Record<string, string>;
  isPinned: (id: string) => boolean;
  isHidden: (id: string) => boolean;
  isMuted: (id: string) => boolean;
  isStarred: (id: string) => boolean;
  isBlocked: (id: string) => boolean;
  togglePin: (id: string) => void;
  toggleMute: (id: string) => void;
  toggleStar: (id: string) => void;
  toggleBlock: (id: string) => void;
  getBackground: (id: string) => string;
  setBackground: (id: string, key: string) => void;
  hide: (id: string) => void;
  unhide: (id: string) => void;
  clearChat: (id: string) => void;
  resetAll: () => void;
}

export function useChatPrefs(user: ChatPrefsUser | null | undefined): ChatPrefsApi {
  const storageKey = user?.id ? `${KEY_PREFIX}${user.id}` : null;
  // 记录「当前 prefs 属于哪个 storageKey」，用于派生 loaded，避免在 effect 里同步 setState
  const [state, setState] = useState<PrefsState>({ key: null, prefs: EMPTY });

  // 读取：user 变化时重新加载（异步回调里 setState 是允许的）
  useEffect(() => {
    let cancelled = false;
    if (!storageKey) return () => { cancelled = true; };
    (async () => {
      let next: ChatPrefs = EMPTY;
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        next = raw ? normalize(JSON.parse(raw)) : EMPTY;
      } catch {
        next = EMPTY;
      }
      if (!cancelled) setState({ key: storageKey, prefs: next });
    })();
    return () => { cancelled = true; };
  }, [storageKey]);

  // 派生值：storageKey 与已加载的 key 一致才算 loaded
  const loaded = storageKey ? state.key === storageKey : true;
  const prefs = loaded ? state.prefs : EMPTY;

  // 写入：任何变更都落盘（loaded 之前不写，避免用空值覆盖已有数据）
  const persist = useCallback(
    (next: ChatPrefs) => {
      if (!storageKey) return;
      setState({ key: storageKey, prefs: next });
      AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
    },
    [storageKey]
  );

  // 统一的「基于当前 prefs 计算下一版并落盘」工具
  const update = useCallback(
    (compute: (base: ChatPrefs) => ChatPrefs) => {
      if (!storageKey) return;
      setState((prev) => {
        const base = prev.key === storageKey ? prev.prefs : EMPTY;
        const next = compute(base);
        if (next === base) return prev;
        AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
        return { key: storageKey, prefs: next };
      });
    },
    [storageKey]
  );

  const toggleIn = useCallback(
    (field: PrefsListField, id: string) => {
      if (!id) return;
      update((prev) => {
        const list = prev[field];
        const nextList = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
        return { ...prev, [field]: nextList };
      });
    },
    [update]
  );

  const addTo = useCallback(
    (field: PrefsListField, id: string) => {
      if (!id) return;
      update((prev) => (prev[field].includes(id) ? prev : { ...prev, [field]: [...prev[field], id] }));
    },
    [update]
  );

  const removeFrom = useCallback(
    (field: PrefsListField, id: string) => {
      if (!id) return;
      update((prev) =>
        prev[field].includes(id) ? { ...prev, [field]: prev[field].filter((x) => x !== id) } : prev
      );
    },
    [update]
  );

  // 设置某个会话的背景
  const setBackground = useCallback(
    (id: string, key: string) => {
      if (!id) return;
      update((prev) => ({ ...prev, backgrounds: { ...prev.backgrounds, [id]: key } }));
    },
    [update]
  );

  const api = useMemo<ChatPrefsApi>(
    () => ({
      loaded,
      pinned: prefs.pinned,
      hidden: prefs.hidden,
      muted: prefs.muted,
      starred: prefs.starred,
      blocked: prefs.blocked,
      backgrounds: prefs.backgrounds,

      isPinned: (id) => prefs.pinned.includes(id),
      isHidden: (id) => prefs.hidden.includes(id),
      isMuted: (id) => prefs.muted.includes(id),
      isStarred: (id) => prefs.starred.includes(id),
      isBlocked: (id) => prefs.blocked.includes(id),

      togglePin: (id) => toggleIn('pinned', id),
      toggleMute: (id) => toggleIn('muted', id),
      toggleStar: (id) => toggleIn('starred', id),
      toggleBlock: (id) => toggleIn('blocked', id),

      // 会话背景
      getBackground: (id) => prefs.backgrounds[id] || 'default',
      setBackground,

      hide: (id) => addTo('hidden', id),
      // 隐藏恢复：收到或发出新消息时调用
      unhide: (id) => removeFrom('hidden', id),
      // 清空聊天记录后同时取消置顶
      clearChat: (id) => {
        if (!id) return;
        update((prev) => ({
          ...prev,
          hidden: prev.hidden.filter((x) => x !== id),
          pinned: prev.pinned.filter((x) => x !== id),
        }));
      },
      resetAll: () => persist(EMPTY),
    }),
    [loaded, prefs, toggleIn, addTo, removeFrom, persist, update, setBackground]
  );

  return api;
}
// --- END OF FILE src/hooks/chat/useChatPrefs.ts ---
