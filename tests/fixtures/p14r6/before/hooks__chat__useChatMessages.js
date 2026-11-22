// --- START OF FILE src/hooks/chat/useChatMessages.js ---
import { useState, useRef, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

import { supabase } from '../../services/supabase';
import { downloadToSandbox } from '../../services/mediaCache';
import { getSignedUrl } from './useSignedMediaUrl'; // ⚡ 核心修复：引入签名换取函数
import { useOwnerKey } from '../useOwnerKey';

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

  // 🆔 C1：身份作用域令牌。ownerKey 变化（切号 / 同账号重新登录）时，
  //    旧异步结果与旧 Realtime 回调一律丢弃，避免把 A 的数据写进 B 的 state。
  const { ownerKey, isOwnerKeyCurrent } = useOwnerKey();

  // 🆔 R1-D3（CLIENT-01）：数据所属身份（dataOwnerKey）。
  //    这是「当前 state 里的 messages 属于哪个账号」的真实标记，与「当前渲染身份 ownerKey」
  //    是两个不同概念：
  //      · 切号瞬间（首帧）：ownerKey 已是 B，但 state 仍是 A 的消息 → dataOwnerKey 必须仍为 A，
  //        消费端据此在渲染期遮蔽，绝不依赖后续 useEffect 清理。
  //      · 清理 effect 执行后：state 已清空，dataOwnerKey 同步更新为 B，遮罩解除。
  //    若直接返回 ownerKey（当前身份），消费端比较恒等，遮罩永不触发 —— 这是 CLIENT-01 的原始缺陷。
  const [dataOwnerKey, setDataOwnerKey] = useState(ownerKey);

  // 🆔 R1-D3（CLIENT-01）：切号瞬间清空消息 state，并把数据归属切换到新身份。
  //    用 ref 记录上一次 ownerKey，仅在真实切换时执行一次，避免每次渲染重复 setState。
  const prevOwnerKeyRef = useRef(ownerKey);
  useEffect(() => {
    if (prevOwnerKeyRef.current === ownerKey) return;
    prevOwnerKeyRef.current = ownerKey;
    setMessages([]);
    setDataOwnerKey(ownerKey);
  }, [ownerKey]);

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
    // 🆔 C1-②：捕获本次 effect 的 ownerKey 快照。所有异步 setState 前必须比对，
    //    否则「同 targetId 但换账号」时旧响应会写进新账号 state（cancelled 布尔覆盖不到）。
    const ownerKeySnapshot = ownerKey;
    const isStale = () => cancelled || !isOwnerKeyCurrent(ownerKeySnapshot);

    // 🆔 C1-①：身份切换清理 —— 清空上一个账号/会话的消息，避免切号瞬间闪现旧内容。
    //    放在异步函数首行（微任务）而非 effect 同步体，既保证清理先于任何数据回填，
    //    又避免 react-hooks/set-state-in-effect（同步 setState 触发级联渲染）。
    const loadCachedMessages = async () => {
      if (isStale()) return;
      setMessages([]);
      setLoading(Boolean(user && targetId));
      try {
        const cachedStr = await AsyncStorage.getItem(CACHE_MSG_KEY);
        if (!cachedStr || isStale()) return;
        const cachedMsgs = JSON.parse(cachedStr);
        if (!Array.isArray(cachedMsgs) || cachedMsgs.length === 0) return;

        const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
        const deletedSet = new Set(deletedStr ? JSON.parse(deletedStr) : []);
        const visible = cachedMsgs.filter(m => !deletedSet.has(m.id));

        if (isStale()) return;
        setMessages(visible);
        setLoading(false);
      } catch (_) {}
    };

    const fetchMessages = async () => {
      await loadCachedMessages();
      if (isStale()) return;

      try {
        // ⚠️ 软删除过滤：deleted_by 包含当前用户的消息不返回。
        //    「删除该聊天 / 清空聊天记录」只把 auth.uid() 追加进 deleted_by，
        //    物理行保留，因此对方仍能看到全部历史（单边删除语义）。
        //    PostgREST 的 cs（contains）操作符：deleted_by 数组包含 {我的ID}。
        const { data, error } = await supabase
          .from('messages')
          .select('*')
          .or(`and(user_id.eq.${user.id},receiver_id.eq.${targetId}),and(user_id.eq.${targetId},receiver_id.eq.${user.id})`)
          .not('deleted_by', 'cs', `{${user.id}}`)
          .order('created_at', { ascending: false })
          .limit(FETCH_LIMIT);

        if (error) throw error;

        if (data && !isStale()) {
          const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
          const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
          const deletedSet = new Set(deletedIds);

          // 🆔 C1-②：await 之后身份可能已变化，写 state 前再校验一次
          if (isStale()) return;

          let remoteMessages = data
            .map(r => formatDbMsg(r, user.id))
            .filter(m => !deletedSet.has(m.id));

          setMessages((prev) => {
            // 🆔 C1-②：setState updater 内再校验，防止排队中的更新落到新账号
            if (!isOwnerKeyCurrent(ownerKeySnapshot)) return prev;
            const remoteIds = new Set(remoteMessages.map(m => m.id));
            const localOnly = prev.filter(m => !remoteIds.has(m.id) && !deletedSet.has(m.id));
            
            remoteMessages = remoteMessages.map(remoteMsg => {
              const localMatch = prev.find(p => p.id === remoteMsg.id);
              if (!localMatch?.localUri) {
                autoDownloadMediaInBackground(remoteMsg);
              }
              // 🚨 重发修复：云端 media_url 是权威值，必须覆盖本地乐观值。
              //    旧实现只保留 localUri，导致重发成功后本地仍持有 file:// 的 mediaUrl，
              //    渲染层继续把本地 URI 当远程地址 → 对端/重启后不可读。
              return {
                ...remoteMsg,
                localUri: localMatch?.localUri || null,
                localThumbUri: localMatch?.localThumbUri || null,
                // 保留本地失败态标记，避免云端行存在但媒体不可读时被误判为成功
                ...(localMatch?.status === 'failed' ? { status: 'failed' } : {}),
                ...(localMatch?.resendBlocked ? { resendBlocked: localMatch.resendBlocked } : {}),
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

      // 🆔 C1-②：身份已变化则不再发起已读回写（避免用旧账号身份写库）
      if (isStale()) return;

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

      if (!isStale()) setLoading(false);
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
          // 🆔 C1-③：旧订阅回调保护 —— 身份已变化则直接丢弃事件
          if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
          const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId)
            || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
          if (!isRelevant) return;

          const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
          const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
          if (deletedIds.includes(payload.new.id)) return;

          // 🆔 C1-③：await 之后身份可能已变化，写 state 前再校验
          if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;

          const newMsg = formatDbMsg(payload.new, user.id);
          
          // 立刻抽水机下载
          autoDownloadMediaInBackground(newMsg);

          setMessages(prev => {
            if (!isOwnerKeyCurrent(ownerKeySnapshot)) return prev;
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
          // 🆔 C1-③：旧订阅回调保护
          if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
          const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId)
            || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
          if (!isRelevant) return;

          // ⚠️ 软删除防护：若这条消息的 deleted_by 已包含我（我删过这个会话），
          //    则 UPDATE 事件（如对方撤回）不应把它重新塞回我的列表。
          //    payload.new.deleted_by 是 UUID[]，用 includes 判断即可。
          const deletedBy = Array.isArray(payload.new.deleted_by) ? payload.new.deleted_by : [];
          if (deletedBy.includes(user.id)) {
            // 已在我这边删除 → 从当前列表移除（若存在），不再显示
            setMessages(prev => prev.filter(m => m.id !== payload.new.id));
            return;
          }

          const updatedMsg = formatDbMsg(payload.new, user.id);
          setMessages(prev => {
            if (!isOwnerKeyCurrent(ownerKeySnapshot)) return prev;
            return prev.map(m => m.id === updatedMsg.id ? { ...m, ...updatedMsg, localUri: m.localUri, localThumbUri: m.localThumbUri } : m);
          });
        }
      )
      // 🍎 FIX-B：发送方视角的 UPDATE 订阅。
      //    上面那条 UPDATE 订阅的 filter 是 `receiver_id=eq.<me>`，只能收到「别人发给我
      //    的消息」的更新；而放映厅邀请卡片是「我发给对方」的，其 subtype 由我（发送方）
      //    结束放映时更新 —— 发送方永远收不到自己的 UPDATE 事件，卡片状态不会刷新。
      //    L4 明确禁止使用未经验证的 OR filter 语法，因此这里**单独**再挂一条
      //    `user_id=eq.<me>` 的 UPDATE 订阅（单列等值 filter，语义确定、可验证），
      //    与上一条互补，共同覆盖「我发出的」与「我收到的」两个方向。
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `user_id=eq.${user.id}` },
        (payload) => {
          // 🆔 C1-③：旧订阅回调保护
          if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
          const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId)
            || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
          if (!isRelevant) return;

          const deletedBy = Array.isArray(payload.new.deleted_by) ? payload.new.deleted_by : [];
          if (deletedBy.includes(user.id)) {
            setMessages(prev => prev.filter(m => m.id !== payload.new.id));
            return;
          }

          const updatedMsg = formatDbMsg(payload.new, user.id);
          setMessages(prev => {
            if (!isOwnerKeyCurrent(ownerKeySnapshot)) return prev;
            return prev.map(m => m.id === updatedMsg.id ? { ...m, ...updatedMsg, localUri: m.localUri, localThumbUri: m.localThumbUri } : m);
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
    // 🆔 C1：ownerKey 纳入依赖 —— 切号 / 同账号重新登录时强制重建 effect 与 channel
  }, [user, targetId, CACHE_MSG_KEY, CACHE_DEL_KEY, ownerKey, isOwnerKeyCurrent]);

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

    // 保存撤回前的本地快照，失败时用于权威回滚
    let snapshot = null;
    setMessages(prev => {
      snapshot = prev.find(m => m.id === id) || null;
      return prev.map(m => m.id === id
        ? { ...m, type: 'action', text: '你撤回了一条消息', mediaUrl: null, thumbnailUrl: null }
        : m);
    });

    // 撤回协议必须与迁移 21 的触发器一致：
    //   type='action' + text='撤回了一条消息' + 清空媒体
    // 触发器按 OLD 行角色校验「发送方 + 精确文案」，不匹配即拒绝。
    const { error } = await supabase
      .from('messages')
      .update({ type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null })
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) {
      // 撤回失败：回滚本地乐观更新，并给出最小错误反馈
      if (__DEV__) console.warn('[revokeMessage] 撤回失败:', error.message);
      if (snapshot) {
        setMessages(prev => prev.map(m => (m.id === id ? snapshot : m)));
      }
      // 权威刷新：从云端重新拉取该消息的真实状态，避免本地与云端长期不一致
      try {
        const { data } = await supabase
          .from('messages')
          .select('*')
          .eq('id', id)
          .single();
        if (data) {
          const fresh = formatDbMsg(data, user.id);
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...fresh } : m)));
        }
      } catch (_) {}
      return { ok: false, error };
    }
    return { ok: true };
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
    // 🆔 C1-④ / R1-D3（CLIENT-01）：暴露「数据所属身份」dataOwnerKey，而非当前渲染身份。
    //    消费端（ChatRoomInner）用它和 useOwnerKey().ownerKey（当前身份）比较，
    //    切号首帧即可发现不一致并遮蔽旧消息。
    ownerKey: dataOwnerKey,
  };
}
// --- END OF FILE src/hooks/chat/useChatMessages.js ---