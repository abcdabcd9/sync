// --- START OF FILE src/hooks/chat/useChatMessages.js ---
import { useState, useRef, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

import { supabase } from '../../services/supabase';

/**
 * 💬 聊天消息域 Hook（任务 7 阶段 1）
 *
 * 职责（仅文字 / 系统消息，不含任何媒体上传与录音）：
 *   1. 本地缓存读写（@chatMessages_* / @deletedMsgIds_*）
 *   2. 历史消息拉取（最近 50 条）+ 已读标定
 *   3. Supabase Realtime 频道订阅（INSERT / UPDATE）
 *   4. formatDbMsg 数据库行 → UI 消息对象
 *   5. 撤回（revokeMessage）、本地删除（deleteMessage）
 *   6. 乐观发送（saveAndSend）—— 供文字发送与媒体发送共用
 *
 * ⚠️ 最高指令：本文件不触碰媒体上传、缩略图生成、录音与音频播放。
 *    媒体相关逻辑仍留在 ChatRoomInner.js 中，仅复用本 Hook 的 saveAndSend。
 */

// 本地缓存最多保留条数
const CACHE_LIMIT = 300;
// 首次拉取历史消息条数
const FETCH_LIMIT = 50;

/**
 * 数据库行 → UI 消息对象
 *
 * ⚠️ 只有「撤回」类 action 才覆写文案；带 subtype 的协议消息必须保留真实 text
 *    （任务 3 的 subtype 协议依赖此判断，勿改）
 */
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

/**
 * @param {string|null} targetId 聊天对象 ID
 * @param {object|null} user     当前登录用户
 */
export function useChatMessages(targetId, user) {
  const [messages, setMessages] = useState([]);
  // 无 user/targetId 时无需加载，直接视为已完成（避免在 effect 内同步 setState）
  const [loading, setLoading] = useState(Boolean(user && targetId));

  // 供回调读取最新消息列表（避免闭包陈旧）
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const CACHE_MSG_KEY = `@chatMessages_${targetId}`;
  const CACHE_DEL_KEY = `@deletedMsgIds_${targetId}`;

  // 1️⃣ 拉取历史 + 已读标定 + Realtime 订阅
  useEffect(() => {
    if (!user || !targetId) return;

    let cancelled = false;

    const fetchMessages = async () => {
      // ① 先渲染本地缓存，避免白屏
      try {
        const cachedStr = await AsyncStorage.getItem(CACHE_MSG_KEY);
        if (cachedStr && !cancelled) setMessages(JSON.parse(cachedStr));
      } catch (_) {}

      // ② 拉取云端最近 50 条
      const { data } = await supabase
        .from('messages')
        .select('*')
        .or(`and(user_id.eq.${user.id},receiver_id.eq.${targetId}),and(user_id.eq.${targetId},receiver_id.eq.${user.id})`)
        .order('created_at', { ascending: false })
        .limit(FETCH_LIMIT);

      if (data && !cancelled) {
        const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
        const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
        const mergedMessages = data
          .map(r => formatDbMsg(r, user.id))
          .filter(m => !deletedIds.includes(m.id));
        setMessages(mergedMessages);
        AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(mergedMessages.slice(0, CACHE_LIMIT)));
      }

      // ③ 已读标定：把对方发给我的未读消息置为已读
      // 🔒 安全审计 #8：三重归属校验，只能标记「发给自己」的消息，杜绝越权改他人已读态
      if (user?.id && targetId) {
        await supabase
          .from('messages')
          .update({ is_read: true })
          .eq('user_id', targetId)
          .eq('receiver_id', user.id)
          .eq('is_read', false);
      }

      if (!cancelled) setLoading(false);
    };
    fetchMessages();

    // ④ Realtime 订阅
    // ⚠️ 频道名必须唯一：effect 依赖 user 对象引用，Auth 刷新会重跑 effect，
    //    若复用固定频道名，supabase.channel() 会返回「已 subscribe 的旧实例」，
    //    再对其 .on() 即抛出 "cannot add postgres_changes callbacks after subscribe()"。
    const sortedIds = [user.id, targetId].sort().join('_');
    const channelName = `chat_${sortedIds}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 保险：若同名频道仍残留在 client 中，先彻底移除，保证拿到全新实例
    supabase.getChannels()
      .filter((ch) => ch.topic === `realtime:${channelName}`)
      .forEach((ch) => supabase.removeChannel(ch));

    const channel = supabase.channel(channelName);

    // ✅ 所有 .on() 必须在 .subscribe() 之前链式完成
    //
    // 🔒 P0-1：Realtime 全表广播泄漏修复
    //   旧实现未加 filter，所有在线客户端都会收到全表 INSERT/UPDATE 事件，
    //   再靠 JS 里的 isRelevant 丢弃 —— 若 RLS 配置不严，payload 中完整的
    //   new 行（含消息正文）会泄露给无关用户，且造成全量流量浪费。
    //   现在由服务端按 receiver_id 过滤，只推送「发给我」的消息。
    //   （自己发出的消息由 saveAndSend 乐观插入，不依赖 Realtime 回环。）
    //   isRelevant 判断保留作为二次防御，filter 生效后恒为 true，无副作用。
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
          setMessages(prev => {
            if (prev.find(m => m.id === newMsg.id)) return prev;
            if (!newMsg.isMe) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            return [newMsg, ...prev];
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
          setMessages(prev => prev.map(m => m.id === updatedMsg.id ? updatedMsg : m));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user, targetId, CACHE_MSG_KEY, CACHE_DEL_KEY]);

  // 2️⃣ 乐观发送：先本地插入并写缓存，再返回给调用方做云端写入
  const saveAndSend = useCallback((newMsg) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMessages((prev) => {
      const updated = [newMsg, ...prev];
      AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(updated.slice(0, CACHE_LIMIT)));
      return updated;
    });
  }, [CACHE_MSG_KEY]);

  // 3️⃣ 撤回：本地立即改为 action，再同步云端
  const revokeMessage = useCallback(async (id) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMessages(prev => prev.map(m => m.id === id
      ? { ...m, type: 'action', text: '你撤回了一条消息', mediaUrl: null, thumbnailUrl: null }
      : m));
    await supabase
      .from('messages')
      .update({ type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null })
      .eq('id', id);
  }, []);

  // 4️⃣ 本地删除：从列表移除并记入「已删除 ID」黑名单（防止 Realtime 重新拉回）
  const deleteMessage = useCallback(async (id) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setMessages(prev => prev.filter(m => m.id !== id));
    const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
    const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
    deletedIds.push(id);
    await AsyncStorage.setItem(CACHE_DEL_KEY, JSON.stringify(deletedIds));
  }, [CACHE_DEL_KEY]);

  return {
    messages,
    loading,
    messagesRef,
    saveAndSend,
    revokeMessage,
    deleteMessage,
    formatDbMsg,
    CACHE_MSG_KEY,
    CACHE_DEL_KEY,
  };
}

// --- END OF FILE src/hooks/chat/useChatMessages.js ---
