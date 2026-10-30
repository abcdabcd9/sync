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
        const deletedSet = new Set(deletedIds);
        const remoteMessages = data
          .map(r => formatDbMsg(r, user.id))
          .filter(m => !deletedSet.has(m.id));

        // 🚨 关键修复（「位置卡片发送后不立刻出现，必须退出重进」）：
        //   旧实现直接 setMessages(remoteMessages) 覆盖整个列表。
        //   但 /chat/location 页用 router.replace 回到聊天室，会重新挂载
        //   ChatRoomInner → 新的 useChatMessages 实例 → messages 从 [] 开始，
        //   而此刻乐观插入的位置消息已随旧实例卸载而丢失。
        //   若 DB insert 尚未提交，fetch 结果里也没有它 → 卡片不显示；
        //   等用户退出重进时 DB 已有数据，才「突然出现」。
        //   修复：把「本地已有但云端还没返回」的消息（乐观消息）合并保留。
        //
        // 🚨 二次修复（「消息删不掉 / 顺序错乱」）：
        //   1. 删不掉：旧实现 localOnly 只过滤 deletedIds，但 remoteMessages 与
        //      本地缓存写入都没有统一过滤；且本地缓存里可能残留已删除消息。
        //      现在合并后统一按 deletedSet 再过滤一次，并回写「干净」缓存。
        //   2. 顺序错乱：旧实现 [...localOnly, ...remoteMessages] 直接拼接，
        //      localOnly 是旧缓存顺序、remoteMessages 是云端倒序，两者混在一起
        //      时间轴完全错乱。现在合并后按 timestamp 降序统一排序
        //      （列表是 inverted，最新在上）。
        setMessages((prev) => {
          const remoteIds = new Set(remoteMessages.map(m => m.id));
          const localOnly = prev.filter(m => !remoteIds.has(m.id) && !deletedSet.has(m.id));
          const merged = [...localOnly, ...remoteMessages]
            .filter(m => !deletedSet.has(m.id))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(merged.slice(0, CACHE_LIMIT)));
          return merged;
        });
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
            // 🚨 顺序修复：不能简单前插，必须按 timestamp 降序统一排序，
            //    否则与本地乐观消息 / 缓存消息混排时时间轴会错乱。
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
      // 🚨 顺序修复：乐观插入同样按 timestamp 降序排序，保证与云端回填一致。
      const updated = [newMsg, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(updated.slice(0, CACHE_LIMIT)));
      return updated;
    });
  }, [CACHE_MSG_KEY]);

  // 2️⃣-b 乐观消息回填：媒体上传成功后，把本地 file:// URI 换成真实对象路径
  //      （否则刚发出的图片 / 视频 / 语音在本次会话内无法渲染或播放，
  //        必须退出重进才恢复正常 —— 因为重进时是从云端拉取的真实路径）
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
  //    🚨 修复「消息删不掉」：旧实现只更新内存 + 黑名单，没有同步清理
  //    @chatMessages_* 缓存。下次进入会话时 fetchMessages 会先把缓存原样
  //    setMessages，被删消息立刻「复活」；且合并逻辑若未过滤黑名单也会带回。
  //    现在：内存过滤 → 黑名单落盘 → 缓存同步剔除，三处一致。
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

    // 🚨 修复「删不掉」的根因：旧实现只删本地，云端记录仍在。
    //    换设备 / 清缓存 / 重装后 fetchMessages 会把它重新拉回来。
    //    这里同步删除云端行；RLS 保证只能删自己发的消息。
    //    失败不阻塞 UI（本地已移除 + 黑名单已落盘），仅开发期告警。
    try {
      const { error } = await supabase.from('messages').delete().eq('id', id);
      if (error && __DEV__) console.warn('[deleteMessage] 云端删除失败:', error.message);
    } catch (e) {
      if (__DEV__) console.warn('[deleteMessage] 云端删除异常:', e?.message);
    }
  }, [CACHE_MSG_KEY, CACHE_DEL_KEY]);

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
