// --- START OF FILE src/hooks/chat/useChatList.js ---
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from '../../services/supabase';

/** 会话列表本地缓存 key（按用户隔离，切换账号不会串数据） */
const chatListCacheKey = (userId) => `@chatList_${userId}`;

/** 读取本地缓存的会话列表（只读磁盘，零网络） */
const readChatListCache = async (userId) => {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(chatListCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    console.warn('⚠️ 读取会话列表缓存失败:', e?.message ?? e);
    return null;
  }
};

/** 写入本地缓存的会话列表（失败不影响主流程） */
const writeChatListCache = async (userId, payload) => {
  if (!userId) return;
  try {
    await AsyncStorage.setItem(chatListCacheKey(userId), JSON.stringify(payload));
  } catch (e) {
    console.warn('⚠️ 写入会话列表缓存失败:', e?.message ?? e);
  }
};

/** 好友列表本地缓存 key（按用户隔离，切换账号不会串数据） */
const friendsListCacheKey = (userId) => `@friends_list_${userId}`;

/** 读取本地缓存的好友列表（只读磁盘，零网络） */
const readFriendsListCache = async (userId) => {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(friendsListCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    console.warn('⚠️ 读取好友列表缓存失败:', e?.message ?? e);
    return null;
  }
};

/** 写入本地缓存的好友列表（失败不影响主流程） */
const writeFriendsListCache = async (userId, payload) => {
  if (!userId) return;
  try {
    await AsyncStorage.setItem(friendsListCacheKey(userId), JSON.stringify(payload));
  } catch (e) {
    console.warn('⚠️ 写入好友列表缓存失败:', e?.message ?? e);
  }
};

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
    // 直接读取 user?.id（而非 ref），使依赖数组真正生效：切换账号时自动重新拉取
    const currentUserId = user?.id ?? null;
    if (!currentUserId) {
      setLoading(false);
      return;
    }

    // 1️⃣ 第 0 帧：本地缓存优先（零网络，断网也能瞬间显示会话列表）
    const cached = await readChatListCache(currentUserId);
    if (cached) {
      if (Array.isArray(cached.friends)) setFriends(cached.friends);
      if (cached.friendsMap && typeof cached.friendsMap === 'object') setFriendsMap(cached.friendsMap);
      if (Array.isArray(cached.requests)) setRequests(cached.requests);
      if (cached.latestMessages && typeof cached.latestMessages === 'object') setLatestMessages(cached.latestMessages);
      if (cached.lastMsgTimes && typeof cached.lastMsgTimes === 'object') setLastMsgTimes(cached.lastMsgTimes);
      if (cached.unreadCounts && typeof cached.unreadCounts === 'object') setUnreadCounts(cached.unreadCounts);
      // 缓存已渲染 → 立刻结束 loading，绝不卡在转圈状态
      setLoading(false);
    }

    // 1️⃣-b 第 0 步：好友列表独立缓存优先（Cache-First，断网秒显联系人）
    const cachedFriends = await readFriendsListCache(currentUserId);
    if (cachedFriends) {
      setFriends(cachedFriends);
      // 缓存已渲染 → 立刻结束 loading，确保断网时不会卡在空白/转圈
      setLoading(false);
    }

    try {
      const allFriendIds = new Set();
      const fMap = {};

      const { data: fData, error: fError } = await supabase
        .from('friends')
        .select('*')
        .or(`user_id.eq.${currentUserId},friend_id.eq.${currentUserId}`);
      if (fError) throw fError;

      if (fData) {
        fData.forEach((r) => {
          const fid = r.user_id === currentUserId ? r.friend_id : r.user_id;
          allFriendIds.add(fid);
          if (r.user_id === currentUserId) fMap[fid] = r;
        });
      }

      const { data: reqData, error: reqError } = await supabase
        .from('friend_requests')
        .select('*')
        .or(`sender_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`);
      if (reqError) throw reqError;

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
      let nextFriends = [];
      let nextRequests = [];
      if (uniqueFriendIds.length > 0) {
        const { data: profilesData, error: pError } = await supabase
          .from('profiles')
          .select('id, username, nickname, sync_id')
          .in('id', uniqueFriendIds);
        if (pError) throw pError;
        nextFriends = profilesData || [];
        setFriends(nextFriends);
        setFriendsMap(fMap);
      } else {
        setFriends([]);
        setFriendsMap({});
      }

      // 待处理的好友请求（带发送者资料）
      if (pendingReceived.length > 0) {
        const senderIds = pendingReceived.map((r) => r.sender_id);
        const { data: pData, error: sError } = await supabase
          .from('profiles')
          .select('id, username, nickname')
          .in('id', senderIds);
        if (sError) throw sError;
        nextRequests = pendingReceived.map((req) => ({
          ...req,
          sender_profile: pData?.find((p) => p.id === req.sender_id),
        }));
        setRequests(nextRequests);
      } else {
        setRequests([]);
      }

      // 未读数量
      let nextUnread = {};
      const { data: unreadData, error: uError } = await supabase
        .from('messages')
        .select('user_id')
        .eq('receiver_id', currentUserId)
        .eq('is_read', false);
      if (uError) throw uError;
      if (unreadData) {
        unreadData.forEach((msg) => {
          nextUnread[msg.user_id] = (nextUnread[msg.user_id] || 0) + 1;
        });
        setUnreadCounts(nextUnread);
      }

      // 批量抓取最近 200 条消息，用于渲染真实预览
      const { data: recentMsgs, error: mError } = await supabase
        .from('messages')
        .select('*')
        .or(`user_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`)
        .order('created_at', { ascending: false })
        .limit(200);
      if (mError) throw mError;

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

      // 3️⃣ 云端成功 → 合并写回本地缓存，供下次冷启动/断网秒开
      writeChatListCache(currentUserId, {
        friends: nextFriends,
        friendsMap: fMap,
        requests: nextRequests,
        latestMessages: latestMap,
        lastMsgTimes: timeMap,
        unreadCounts: nextUnread,
        cachedAt: Date.now(),
      });

      // 3️⃣-b 云端成功 → 好友列表单独回写缓存（@friends_list_${user.id}）
      writeFriendsListCache(currentUserId, nextFriends);
    } catch (e) {
      // 🚨 离线降级：绝不清空已加载的本地会话列表，仅记录日志
      console.warn('离线，使用缓存好友列表');
      console.warn('离线状态，使用本地缓存会话列表');
      console.warn('⚠️ 会话列表云端查询失败:', e?.message ?? e);
    } finally {
      setLoading(false);
    }
    // ⚠️ 依赖 user?.id：切换账号时必须重新全量拉取，否则会残留上一个账号的列表
  }, [user?.id]);

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

    // 🔒 服务端过滤：只订阅"发给我的消息"，避免全表广播导致的数据泄露与性能浪费。
    //    注意：filter 只能作用于单列，因此这里用 receiver_id 而非 (user_id OR receiver_id)。
    //    自己发出的消息由发送方本地乐观更新（saveAndSend）负责，无需依赖 Realtime 回环。
    const receiverFilter = `receiver_id=eq.${user.id}`;

    // ✅ 所有 .on() 必须在 .subscribe() 之前链式完成
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: receiverFilter },
        (payload) => {
          const msg = payload.new;
          // 底层已按 receiver_id 过滤，此处无需再做归属判断
          const partnerId = msg.user_id;
          setLatestMessages((prev) => ({ ...prev, [partnerId]: formatPreview(msg) }));
          setLastMsgTimes((prev) => ({ ...prev, [partnerId]: new Date(msg.created_at).getTime() }));
          setUnreadCounts((prev) => ({ ...prev, [partnerId]: (prev[partnerId] || 0) + 1 }));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: receiverFilter },
        (payload) => {
          const msg = payload.new;
          // 对方撤回/编辑消息时，预览也要跟着变
          const partnerId = msg.user_id;
          setLatestMessages((prev) => ({ ...prev, [partnerId]: formatPreview(msg) }));
          // 已读回执：未读数递减（进入聊天室后对方消息被标记 is_read=true）
          if (msg.is_read) {
            setUnreadCounts((prev) => ({
              ...prev,
              [partnerId]: Math.max(0, (prev[partnerId] || 0) - 1),
            }));
          }
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [user]);

  // =========================================================================
  // 关系网实时监听：friends / friend_requests
  // =========================================================================
  // 为什么需要：
  //   1. friends          —— 对方删我好友 / 我加好友成功 → 会话列表与联系人立刻变化
  //   2. friend_requests  —— 收到好友请求 → 联系人页红点与请求卡片立刻出现
  //
  // ⚠️ 为什么用「防抖全量刷新」而不是「增量改本地状态」：
  //   friends 表的一次关系变化会牵动 friends / friendsMap / requests / 未读数
  //   四份状态，增量维护极易漏改（例如删好友后 friendsMap 残留、请求卡片不消失）。
  //   关系变化本身是低频事件，直接调 fetchAll() 全量重拉最稳、最不容易出 bug。
  //   防抖 400ms 是为了合并「加好友」这类一次操作触发多条变更的抖动。
  //
  // ⚠️ 为什么不用 filter：
  //   friends 表的关系可能落在 user_id 或 friend_id 任一列，Realtime 的 filter
  //   只能作用于单列，无法表达 (user_id = me OR friend_id = me)。
  //   因此这里不加 filter，靠 RLS 兜底 —— Realtime 推送前会按订阅者 RLS 逐行校验，
  //   无权看的行不会推送，不会造成数据泄露。
  //
  // 🔒 H-3 安全加固：已移除对 profiles 的 Realtime 订阅
  //   原实现订阅 `{ event: 'UPDATE', table: 'profiles' }`（无 filter），
  //   用于「好友改昵称/头像时刷新列表」。
  //   但 profiles 的 SELECT 策略是 USING (true)（搜人必需），
  //   无 filter 订阅等于**任何登录用户都能收到全站用户资料变更的事件流**。
  //   迁移 16_Realtime白名单 已把 profiles 移出 publication。
  //
  //   为什么不能改成 filter：
  //   需要监听「所有好友」的资料变更，而 Realtime 的 filter 只支持单值 eq，
  //   无法表达 id IN (好友1, 好友2, ...)；逐个好友建频道在好友多时
  //   会撑爆连接数（Supabase 免费版并发频道上限很低）。
  //
  //   替代方案（好友改昵称属于低频事件，以下时机足够覆盖）：
  //   · useFocusEffect —— 每次进入会话列表 / 联系人页都会 fetchAll()
  //   · friends / friend_requests 变更事件 —— 已订阅，会触发全量刷新
  //   · 下拉刷新 / 手动 refresh()
  useEffect(() => {
    if (!user?.id) return undefined;

    const currentUserId = user.id;
    const channelName = `relation_realtime_${currentUserId}_${Date.now()}`;

    // 清掉可能残留的同名频道（effect 重跑时避免复用已 subscribe 的旧实例）
    supabase
      .getChannels()
      .filter((ch) => ch.topic === `realtime:${channelName}`)
      .forEach((ch) => supabase.removeChannel(ch));

    // 防抖：合并短时间内的多次变更，只触发一次全量刷新
    let debounceTimer = null;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        fetchAll();
      }, 400);
    };

    const channel = supabase
      .channel(channelName)
      // 好友关系增删 → 会话列表 / 联系人列表变化
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friends' },
        scheduleRefresh
      )
      // 好友请求新增 / 状态变更（pending → accepted）→ 红点与请求卡片变化
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_requests' },
        scheduleRefresh
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [user?.id, fetchAll]);

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
