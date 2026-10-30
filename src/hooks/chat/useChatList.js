// --- START OF FILE src/hooks/chat/useChatList.js ---
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { supabase } from '../../services/supabase';

/**
 * 把数据库里的密语翻译成人类可读的预览文本（按 subtype 协议字段判断）
 * 原样迁移自 src/app/(tabs)/chat.js 的 formatPreview
 */
export const formatPreview = (msg) => {
  if (!msg) return '点击进入会话...';
  if (msg.type === 'image') return '[图片]';
  if (msg.type === 'video') return '[视频]';
  if (msg.type === 'audio') return '[语音]';
  // 🗑️ 地图卡片已下线：历史 type='location' 消息在列表里显示为 [位置]（只读兼容）
  if (msg.type === 'location') return '[位置]';
  if (msg.type === 'cinema_invite') return '[邀请同步观影]';
  if (msg.subtype === 'SYNC_CINEMA_ENDED') return '[本次同步放映已结束]';
  if (msg.subtype === 'SYNC_PARTNER_INVITE') return '[健康搭子邀请]';
  if (msg.subtype === 'SYNC_PARTNER_ACCEPTED') return '你们已成为健康搭子！';
  if (msg.subtype === 'SYNC_PARTNER_REJECTED') return '已拒绝健康搭子邀请';
  if (msg.subtype === 'SYNC_PARTNER_UNBOUND') return '已解除健康守护伴侣关系';
  if (msg.subtype === 'SYNC_SYSTEM') return msg.text || '暂无新消息';
  return msg.text || '暂无新消息';
};

/**
 * 会话列表数据层
 *
 * 职责：
 *   1. 拉取好友 / 待处理请求 / 未读数 / 每个会话的最新消息
 *   2. 订阅 messages 表的 INSERT / UPDATE，实时更新预览、时间与未读数
 *   3. 暴露 refresh() 供加好友、同意请求等操作后手动刷新
 *
 * 逻辑与原 src/app/(tabs)/chat.js 的 fetchFriendsAndData + 实时监听完全一致，
 * 仅把状态从页面组件搬到 hook，避免拆分页面时重复实现。
 */
export function useChatList(user) {
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [friendsMap, setFriendsMap] = useState({});
  const [latestMessages, setLatestMessages] = useState({});
  const [lastMsgTimes, setLastMsgTimes] = useState({});
  const [loading, setLoading] = useState(true);

  // 防止 user 切换后旧请求回写
  // ⚠️ 不能在渲染期写 ref（react-hooks/refs），改在 effect 中同步
  const userIdRef = useRef(null);
  useEffect(() => {
    userIdRef.current = user?.id ?? null;
  }, [user]);

  const fetchAll = useCallback(async () => {
    const currentUserId = userIdRef.current;
    if (!currentUserId) {
      setLoading(false);
      return;
    }

    try {
      const allFriendIds = new Set();
      const fMap = {};

      const { data: fData } = await supabase
        .from('friends')
        .select('*')
        .or(`user_id.eq.${currentUserId},friend_id.eq.${currentUserId}`);

      if (fData) {
        fData.forEach((r) => {
          const fid = r.user_id === currentUserId ? r.friend_id : r.user_id;
          allFriendIds.add(fid);
          if (r.user_id === currentUserId) fMap[fid] = r;
        });
      }

      const { data: reqData } = await supabase
        .from('friend_requests')
        .select('*')
        .or(`sender_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`);

      const pendingReceived = [];
      if (reqData) {
        reqData.forEach((r) => {
          if (r.status === 'accepted') {
            allFriendIds.add(r.sender_id === currentUserId ? r.receiver_id : r.sender_id);
          } else if (r.status === 'pending' && r.receiver_id === currentUserId) {
            pendingReceived.push(r);
          }
        });
      }

      // 好友资料
      const uniqueFriendIds = [...allFriendIds];
      if (uniqueFriendIds.length > 0) {
        const { data: profilesData } = await supabase
          .from('profiles')
          .select('id, username, nickname, sync_id')
          .in('id', uniqueFriendIds);
        setFriends(profilesData || []);
        setFriendsMap(fMap);
      } else {
        setFriends([]);
        setFriendsMap({});
      }

      // 待处理的好友请求（带发送者资料）
      if (pendingReceived.length > 0) {
        const senderIds = pendingReceived.map((r) => r.sender_id);
        const { data: pData } = await supabase
          .from('profiles')
          .select('id, username, nickname')
          .in('id', senderIds);
        setRequests(
          pendingReceived.map((req) => ({
            ...req,
            sender_profile: pData?.find((p) => p.id === req.sender_id),
          }))
        );
      } else {
        setRequests([]);
      }

      // 未读数量
      const { data: unreadData } = await supabase
        .from('messages')
        .select('user_id')
        .eq('receiver_id', currentUserId)
        .eq('is_read', false);
      if (unreadData) {
        const counts = {};
        unreadData.forEach((msg) => {
          counts[msg.user_id] = (counts[msg.user_id] || 0) + 1;
        });
        setUnreadCounts(counts);
      }

      // 批量抓取最近 200 条消息，用于渲染真实预览
      const { data: recentMsgs } = await supabase
        .from('messages')
        .select('*')
        .or(`user_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`)
        .order('created_at', { ascending: false })
        .limit(200);

      const latestMap = {};
      const timeMap = {};
      if (recentMsgs) {
        recentMsgs.forEach((msg) => {
          const partnerId = msg.user_id === currentUserId ? msg.receiver_id : msg.user_id;
          if (!latestMap[partnerId]) {
            latestMap[partnerId] = formatPreview(msg);
            timeMap[partnerId] = new Date(msg.created_at).getTime();
          }
        });
      }
      setLatestMessages(latestMap);
      setLastMsgTimes(timeMap);
    } catch {
      // 网络异常时保持上一次的数据，不打断界面
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次页面获得焦点都刷新（从聊天室返回时未读数需要更新）
  useFocusEffect(
    useCallback(() => {
      fetchAll();
    }, [fetchAll])
  );

  // 全局消息实时监听：新消息自动置顶 + 未读 +1
  useEffect(() => {
    if (!user) return undefined;

    // ⚠️ 频道名必须唯一：effect 依赖 user 对象引用，重跑时若复用固定名，
    //    supabase.channel() 会返回已 subscribe 的旧实例，再 .on() 会直接抛错。
    const channelName = `chat_list_realtime_${user.id}_${Date.now()}`;
    supabase
      .getChannels()
      .filter((ch) => ch.topic === `realtime:${channelName}`)
      .forEach((ch) => supabase.removeChannel(ch));

    // ✅ 所有 .on() 必须在 .subscribe() 之前链式完成
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        if (msg.user_id === user.id || msg.receiver_id === user.id) {
          const partnerId = msg.user_id === user.id ? msg.receiver_id : msg.user_id;
          setLatestMessages((prev) => ({ ...prev, [partnerId]: formatPreview(msg) }));
          setLastMsgTimes((prev) => ({ ...prev, [partnerId]: new Date(msg.created_at).getTime() }));
          if (msg.receiver_id === user.id) {
            setUnreadCounts((prev) => ({ ...prev, [partnerId]: (prev[partnerId] || 0) + 1 }));
          }
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        // 对方撤回消息时，预览也要跟着变
        if (msg.user_id === user.id || msg.receiver_id === user.id) {
          const partnerId = msg.user_id === user.id ? msg.receiver_id : msg.user_id;
          setLatestMessages((prev) => ({ ...prev, [partnerId]: formatPreview(msg) }));
        }
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [user]);

  // 按最新消息时间倒序排列的会话列表
  const conversations = [...friends].sort((a, b) => {
    const timeA = lastMsgTimes[a.id] || 0;
    const timeB = lastMsgTimes[b.id] || 0;
    return timeB - timeA;
  });

  const getDisplayName = useCallback(
    (item) => {
      if (!item) return '未知';
      const rel = friendsMap[item.id];
      return rel?.remark || item.nickname || item.username;
    },
    [friendsMap]
  );

  return {
    friends,
    requests,
    unreadCounts,
    friendsMap,
    latestMessages,
    lastMsgTimes,
    conversations,
    loading,
    refresh: fetchAll,
    getDisplayName,
  };
}
// --- END OF FILE src/hooks/chat/useChatList.js ---
