// --- START OF FILE src/hooks/chat/useChatMessages.js ---
import { useState, useRef, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

import { supabase } from '../../services/supabase';
import { downloadToSandbox } from '../../services/mediaCache';
import { getSignedUrl } from './useSignedMediaUrl'; // ⚡ 核心修复：引入签名换取函数

const CACHE_LIMIT = 300;
const FETCH_LIMIT = 50;

export const formatDbMsg = (row, currentUserId) => ({
  id: row.id,
  type: row.type,
  subtype: row.subtype ?? null,
  text: (row.type === 'action' && !row.subtype)
    ? (row.user_id === currentUserId ? '你撤回了一条消息' : '对方撤回了一条消息')
    : row.text,
  mediaUrl: row.media_url,
  thumbnailUrl: row.thumbnail_url,
  duration: row.duration || 0,
  isMe: row.user_id === currentUserId,
  timestamp: new Date(row.created_at).getTime(),
});

// ⚡ 核心修复：下载前必须先把云端相对路径换成 HTTP 签名 URL！
const autoDownloadMediaInBackground = async (msg) => {
  if (!msg) return;

  const downloadIfMissing = async (path, id, kind) => {
    if (!path) return;
    let downloadUrl = path;
    // 如果是数据库里的相对路径，必须先换取签名 HTTP 网址
    if (!/^(https?|file|content|data):/i.test(path)) {
      downloadUrl = await getSignedUrl(path);
    }
    // 只有拿到真正的 HTTP 网址，才能让下载器去下载！
    if (downloadUrl) {
      await downloadToSandbox(downloadUrl, id, kind);
    }
  };

  if ((msg.type === 'image' || msg.type === 'video') && msg.mediaUrl && !msg.localUri) {
    downloadIfMissing(msg.mediaUrl, msg.id, msg.type);
  }
  if (msg.type === 'video' && msg.thumbnailUrl && !msg.localThumbUri) {
    downloadIfMissing(msg.thumbnailUrl, msg.id, 'thumb');
  }
  if ((msg.type === 'audio' || msg.subtype === 'SYNC_AUDIO') && (msg.mediaUrl || msg.text)) {
    const rawAudioPath = (msg.mediaUrl || msg.text || '').replace(/^\[SYNC_AUDIO\]\s*/i, '').trim();
    if (rawAudioPath && !msg.localUri) {
      downloadIfMissing(rawAudioPath, msg.id, 'audio');
    }
  }
};

export function useChatMessages(targetId, user) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(Boolean(user && targetId));

  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // 🔒 M-6：缓存 Key 必须带上「当前用户 ID」做账号隔离
  //    旧格式 @chatMessages_${targetId} 只按对方 ID 命名，同一台设备上
  //    切换账号后，A 账号与某好友的聊天记录会被 B 账号读到（若 B 也认识该好友），
  //    造成跨账号本地数据泄露。加入 user.id 后每个账号拥有独立缓存命名空间。
  const CACHE_MSG_KEY = `@chatMessages_${user?.id}_${targetId}`;
  const CACHE_DEL_KEY = `@deletedMsgIds_${user?.id}_${targetId}`;

  useEffect(() => {
    if (!user || !targetId) return;

    let cancelled = false;

    const loadCachedMessages = async () => {
      try {
        const cachedStr = await AsyncStorage.getItem(CACHE_MSG_KEY);
        if (!cachedStr || cancelled) return;
        const cachedMsgs = JSON.parse(cachedStr);
        if (!Array.isArray(cachedMsgs) || cachedMsgs.length === 0) return;

        const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
        const deletedSet = new Set(deletedStr ? JSON.parse(deletedStr) : []);
        const visible = cachedMsgs.filter(m => !deletedSet.has(m.id));

        if (cancelled) return;
        setMessages(visible);
        setLoading(false);
      } catch (_) {}
    };

    const fetchMessages = async () => {
      await loadCachedMessages();
      if (cancelled) return;

      try {
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .or(`and(user_id.eq.${user.id},receiver_id.eq.${targetId}),and(user_id.eq.${targetId},receiver_id.eq.${user.id})`)
          .order('created_at', { ascending: false })
          .limit(FETCH_LIMIT);

        if (error) throw error;

        if (data && !cancelled) {
          const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
          const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
          const deletedSet = new Set(deletedIds);
          
          let remoteMessages = data
            .map(r => formatDbMsg(r, user.id))
            .filter(m => !deletedSet.has(m.id));

          setMessages((prev) => {
            const remoteIds = new Set(remoteMessages.map(m => m.id));
            const localOnly = prev.filter(m => !remoteIds.has(m.id) && !deletedSet.has(m.id));
            
            remoteMessages = remoteMessages.map(remoteMsg => {
              const localMatch = prev.find(p => p.id === remoteMsg.id);
              if (!localMatch?.localUri) {
                autoDownloadMediaInBackground(remoteMsg);
              }
              return {
                ...remoteMsg,
                localUri: localMatch?.localUri || null,
                localThumbUri: localMatch?.localThumbUri || null,
              };
            });

            const merged = [...localOnly, ...remoteMessages]
              .filter(m => !deletedSet.has(m.id))
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(merged.slice(0, CACHE_LIMIT)));
            return merged;
          });
        }
      } catch (_) {
        console.warn('离线状态，使用本地缓存消息');
      }

      if (user?.id && targetId) {
        try {
          await supabase
            .from('messages')
            .update({ is_read: true })
            .eq('user_id', targetId)
            .eq('receiver_id', user.id)
            .eq('is_read', false);
        } catch (_) {}
      }

      if (!cancelled) setLoading(false);
    };
    fetchMessages();

    const sortedIds = [user.id, targetId].sort().join('_');
    const channelName = `chat_${sortedIds}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    supabase.getChannels()
      .filter((ch) => ch.topic === `realtime:${channelName}`)
      .forEach((ch) => supabase.removeChannel(ch));

    const channel = supabase.channel(channelName);

    channel
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${user.id}` },
        async (payload) => {
          const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId)
            || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
          if (!isRelevant) return;

          const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
          const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
          if (deletedIds.includes(payload.new.id)) return;

          const newMsg = formatDbMsg(payload.new, user.id);
          
          // 立刻抽水机下载
          autoDownloadMediaInBackground(newMsg);

          setMessages(prev => {
            if (prev.find(m => m.id === newMsg.id)) return prev;
            if (!newMsg.isMe) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            const next = [newMsg, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(next.slice(0, CACHE_LIMIT)));
            return next;
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `receiver_id=eq.${user.id}` },
        (payload) => {
          const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId)
            || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
          if (!isRelevant) return;
          const updatedMsg = formatDbMsg(payload.new, user.id);
          setMessages(prev => prev.map(m => m.id === updatedMsg.id ? { ...m, ...updatedMsg, localUri: m.localUri, localThumbUri: m.localThumbUri } : m));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user, targetId, CACHE_MSG_KEY, CACHE_DEL_KEY]);

  const saveAndSend = useCallback((newMsg) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMessages((prev) => {
      const updated = [newMsg, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(updated.slice(0, CACHE_LIMIT)));
      return updated;
    });
  }, [CACHE_MSG_KEY]);

  const patchMessage = useCallback((id, patch) => {
    if (!id || !patch) return;
    setMessages((prev) => {
      let changed = false;
      const updated = prev.map((m) => {
        if (m.id !== id) return m;
        changed = true;
        return { ...m, ...patch };
      });
      if (changed) {
        AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(updated.slice(0, CACHE_LIMIT)));
      }
      return changed ? updated : prev;
    });
  }, [CACHE_MSG_KEY]);

  const revokeMessage = useCallback(async (id) => {
    if (!user?.id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMessages(prev => prev.map(m => m.id === id
      ? { ...m, type: 'action', text: '你撤回了一条消息', mediaUrl: null, thumbnailUrl: null }
      : m));
    await supabase
      .from('messages')
      .update({ type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null })
      .eq('id', id)
      .eq('user_id', user.id);
  }, [user]);

  const deleteMessage = useCallback(async (id) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setMessages(prev => {
      const next = prev.filter(m => m.id !== id);
      AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(next.slice(0, CACHE_LIMIT)));
      return next;
    });
    const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
    const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
    if (!deletedIds.includes(id)) deletedIds.push(id);
    await AsyncStorage.setItem(CACHE_DEL_KEY, JSON.stringify(deletedIds));

    if (!user?.id) return;
    try {
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id);
      if (error && __DEV__) console.warn('[deleteMessage] 云端删除失败:', error.message);
    } catch (e) {
      if (__DEV__) console.warn('[deleteMessage] 云端删除异常:', e?.message);
    }
  }, [CACHE_MSG_KEY, CACHE_DEL_KEY, user]);

  return {
    messages,
    loading,
    messagesRef,
    saveAndSend,
    patchMessage,
    revokeMessage,
    deleteMessage,
    formatDbMsg,
    CACHE_MSG_KEY,
    CACHE_DEL_KEY,
  };
}
// --- END OF FILE src/hooks/chat/useChatMessages.js ---