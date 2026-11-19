// --- START OF FILE src/app/bind_partner.js ---
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { useHealthData } from '../hooks/useHealthData';
import { buildProfileCacheKey } from '../hooks/profile/useProfileCache';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';

export default function BindPartnerScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user, authEpoch } = useAuth();
  // 🌐 全局健康上下文：解绑/绑定后必须同步刷新，否则首页伴侣卡片要等冷启动才更新
  //    partnerId 同时作为断网兜底数据源：全局已恢复的绑定关系可直接复用，无需等网络
  const { refreshPartner, partnerId: globalPartnerId } = useHealthData();

  // 🛡️ L4-R2：页面数据与「数据归属身份」必须**原子一致**。
  //    旧实现把 friends / boundPartnerId / loading 拆成三个独立 useState，
  //    再用一个独立的 stateOwnerKey 标记归属，导致「归属已推进、兄弟字段仍是
  //    旧账号值」的中间态：
  //      · RPC 先返回 → claimStateOwner(B) 但 friends 仍是 A 的 → A 好友复活（B3-L4-06）
  //      · 缓存恢复只写数据不推进归属 → B 的合法离线缓存被整体屏蔽（B3-L4-07）
  //    现在四个 state 只允许经由 commitPageState 一次性提交（同一批次内落地），
  //    归属推进与内容更新不可分割，结构上不可能出现「owner 与内容不一致」的
  //    可见状态。stateOwnerKey 与数据同批更新，因此渲染期比对即可安全派生。
  const [friends, setFriends] = useState([]);
  const [boundPartnerId, setBoundPartnerId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stateOwnerKey, setStateOwnerKey] = useState(`${user?.id ?? ''}::${authEpoch}`);
  // 供同步读取的镜像（渲染期禁止读写 ref，故仅在 effect 内同步）。
  const pageStateRef = useRef({ ownerKey: stateOwnerKey, friends, boundPartnerId, loading });
  useEffect(() => {
    pageStateRef.current = { ownerKey: stateOwnerKey, friends, boundPartnerId, loading };
  }, [stateOwnerKey, friends, boundPartnerId, loading]);

  // 🛡️ TASK-P0.3 / B3-06 + L4-R1：页面级异步回调的统一身份契约。
  //    本页的 loadData / handleBindPartner / handleUnbind 都包含多次 await
  //    （RPC、profiles 查询、AsyncStorage 读写、refreshPartner）。若用户在
  //    await 期间切号（或同账号新 authEpoch），旧闭包返回后仍会
  //    setBoundPartnerId / setFriends / setLoading / 写缓存 / 发推送 / 弹窗 /
  //    触发成功震动，把 A 的搭子关系与好友列表写进 B 的页面与缓存。
  //
  //    契约（唯一入口，禁止散落 ad-hoc 判断）：
  //      · identityRef  —— 实时身份镜像（供同步读取）
  //      · isIdentityCurrent(snapshot) —— fail-closed 校验
  //      · runIfCurrent(snapshot, fn)  —— 所有「写 state / 写缓存 / 反馈副作用」
  //        必须经由它执行；身份已失效时整体跳过（返回 undefined）。
  //    与 useHealthData 的 originSnapshot 机制同构。
  const identityRef = useRef({ userId: user?.id ?? null, epoch: authEpoch });
  useEffect(() => {
    identityRef.current = { userId: user?.id ?? null, epoch: authEpoch };
  }, [user?.id, authEpoch]);
  const isIdentityCurrent = useCallback((snapshot) => {
    const now = identityRef.current;
    return !!snapshot && now.userId === snapshot.userId && now.epoch === snapshot.epoch;
  }, []);
  // 🛡️ L4-R1：副作用统一闸门。身份失效 → 不执行任何写 state / 写缓存 / 反馈。
  //    以 ref 暴露稳定引用，使 loadData effect 的依赖数组保持既有形状
  //    （[user, authEpoch, globalPartnerId, isIdentityCurrent]），
  //    不因新增闸门而改变 effect 重建时机。
  const runIfCurrentRef = useRef(null);
  const runIfCurrent = useCallback((snapshot, fn) => {
    if (!isIdentityCurrent(snapshot)) return undefined;
    return fn();
  }, [isIdentityCurrent]);
  // 在 effect 内同步 ref 镜像（渲染期写 ref 会被 react-hooks/refs 判违规）。
  useEffect(() => { runIfCurrentRef.current = runIfCurrent; }, [runIfCurrent]);
  // 🛡️ L4-R2：原子提交闸门 —— 唯一允许写页面数据的入口。
  //    语义：身份已失效 → 整体丢弃（fail-closed，返回 false）；
  //          身份有效 → 以「本次身份」为 ownerKey，把 patch 合并进当前状态，
  //          内容与归属在同一次 setState 中一起落地。
  //    这样「owner 推进」与「内容更新」不可分割：不存在 owner=B 而 friends=A 的
  //    中间态，也不存在内容=B 而 owner=A 的中间态。
  const commitPageStateRef = useRef(null);
  const commitPageState = useCallback((snapshot, patch) => {
    if (!isIdentityCurrent(snapshot)) return false;
    const nextKey = `${snapshot.userId}::${snapshot.epoch}`;
    const prev = pageStateRef.current;
    // 归属不同 → 视为全新会话：未显式提供的字段一律回到安全初值，
    // 绝不把上一账号的 friends / boundPartnerId 带进新账号。
    const sameOwner = prev.ownerKey === nextKey;
    const nextFriends = 'friends' in patch ? patch.friends : (sameOwner ? prev.friends : []);
    const nextBound = 'boundPartnerId' in patch ? patch.boundPartnerId : (sameOwner ? prev.boundPartnerId : null);
    const nextLoading = 'loading' in patch ? patch.loading : (sameOwner ? prev.loading : true);
    // 四个 state 在同一批次内一起落地（React 18 自动批处理），
    // 归属与内容不可分割 —— 不存在 owner 已推进而内容仍是旧账号的可见中间态。
    setStateOwnerKey(nextKey);
    setFriends(nextFriends);
    setBoundPartnerId(nextBound);
    setLoading(nextLoading);
    // 同步更新镜像，使同一 tick 内后续读取（如缓存兜底的 prev 判断）看到最新值。
    pageStateRef.current = { ownerKey: nextKey, friends: nextFriends, boundPartnerId: nextBound, loading: nextLoading };
    return true;
  }, [isIdentityCurrent]);
  useEffect(() => { commitPageStateRef.current = commitPageState; }, [commitPageState]);

  // 🛡️ L4-R2：渲染期派生可见状态。
  //    身份切换的第一次渲染发生在 cleanup effect 之前，此时 friends /
  //    boundPartnerId 仍是上一账号的残留值。这里用「state 所属身份」与
  //    「当前身份」比对，不一致时直接对外呈现安全空值 —— 不依赖后续 useEffect，
  //    首帧即不暴露旧账号内容。
  const ownerKey = `${user?.id ?? ''}::${authEpoch}`;
  const stateIsCurrentOwner = stateOwnerKey === ownerKey;
  const visibleFriends = stateIsCurrentOwner ? friends : [];
  const visibleBoundPartnerId = stateIsCurrentOwner ? boundPartnerId : null;
  const visibleLoading = stateIsCurrentOwner ? loading : true;

  useEffect(() => {
    if (!user) return;
    // 🛡️ B3-06：捕获本次加载的身份快照，所有 await 之后写回前必须校验。
    const origin = { userId: user.id, epoch: authEpoch };
    const loadData = async () => {
      // 💾 守护伴侣页本地缓存 key（按用户隔离，切换账号不会串数据）
      const partnerPageCacheKey = `@partner_page_data_${user.id}`;
      // 💾 全局好友列表缓存 key（与 useChatList 写入的 @friends_list_ 保持一致）
      const globalFriendsCacheKey = `@friends_list_${user.id}`;
      // 💾 全局会话列表缓存 key（兜底：老版本只写过 @chatList_，其中 friends 字段同样可用）
      const globalChatListCacheKey = `@chatList_${user.id}`;

      // 1️⃣ 第 0 步：本地缓存优先（零网络，断网也能瞬间显示守护伴侣与好友列表）
      // 🛡️ L4-R1：每一次 await 读取之后、写 React state 之前都必须校验身份。
      //    旧实现只在 RPC 边界校验，缓存读取（可能因磁盘 IO 排队而晚于切号返回）
      //    会把 A 的好友/搭子直接写进 B 的页面。
      let hasLocalData = false;
      // 🛡️ L4-R2：本账号缓存命中后，一次性原子提交「归属 + 好友 + 搭子 + loading」。
      //    归属随内容一起推进到 origin，B 的合法离线缓存因此立即可见（B3-L4-07），
      //    且不会把 A 的残留字段带进 B（归属不同 → 未提供字段回到安全初值）。
      try {
        const cachedRaw = await AsyncStorage.getItem(partnerPageCacheKey);
        if (cachedRaw) {
          const cachedData = JSON.parse(cachedRaw);
          const patch = {};
          if (cachedData && typeof cachedData === 'object') {
            if (Array.isArray(cachedData.friends) && cachedData.friends.length > 0) {
              patch.friends = cachedData.friends;
              hasLocalData = true;
            }
            if (cachedData.boundPartnerId !== undefined && cachedData.boundPartnerId !== null) {
              patch.boundPartnerId = cachedData.boundPartnerId;
              hasLocalData = true;
            }
          }
          // 缓存已渲染 → 立刻结束 loading，绝不卡在转圈状态
          patch.loading = false;
          commitPageStateRef.current(origin, patch);
        }
      } catch (cacheError) {
        console.warn('⚠️ 读取守护伴侣页缓存失败:', cacheError?.message ?? cacheError);
      }

      // 1️⃣-a 全局伴侣 ID 兜底：页面缓存缺失时，优先复用全局健康上下文已恢复的 partnerId
      //      （useHealthData 的 loadProfile 已从 @user_profile_cache 第 0 帧恢复绑定关系）
      if (globalPartnerId) {
        // 🛡️ L4-R3：兜底判断必须「归属感知」。
        //    旧实现只看 pageStateRef.current.boundPartnerId 是否为空 —— 若上一账号
        //    A 的残留 boundPartnerId 仍非空，B 的合法全局搭子兜底会被直接跳过，
        //    断网时最终显示 null（离线兜底回归）。
        //    正确语义：只有「状态已属于当前 owner 且已有合法绑定」时才不覆盖；
        //    状态仍属于旧 owner 时，旧值不得阻止当前 owner 的合法兜底。
        const stateOwnerKeyNow = pageStateRef.current.ownerKey;
        const currentOwnerKey = `${origin.userId}::${origin.epoch}`;
        const stateBelongsToCurrentOwner = stateOwnerKeyNow === currentOwnerKey;
        const hasCurrentOwnerBinding = stateBelongsToCurrentOwner && !!pageStateRef.current.boundPartnerId;
        if (!hasCurrentOwnerBinding) {
          commitPageStateRef.current(origin, { boundPartnerId: globalPartnerId });
          hasLocalData = true;
        }
      }

      // 1️⃣-b 全局伴侣 ID 兜底：再读当前账号的 V2 profile 缓存中的 bound_partner_id（零网络）
      //      🆔 B1-D：key 已改为 @user_profile_cache_v2_${user.id}，不再读取旧全局 key
      try {
        const profileCacheKey = buildProfileCacheKey(user.id);
        const profileRaw = profileCacheKey ? await AsyncStorage.getItem(profileCacheKey) : null;
        if (profileRaw) {
          const cachedProfile = JSON.parse(profileRaw);
          // 缓存归属校验：只认当前登录用户自己的资料，避免换号后串数据
          if (cachedProfile && cachedProfile.id === user.id && cachedProfile.bound_partner_id) {
            if (!pageStateRef.current.boundPartnerId) {
              commitPageStateRef.current(origin, { boundPartnerId: cachedProfile.bound_partner_id });
              hasLocalData = true;
            }
          }
        }
      } catch (profileCacheError) {
        console.warn('⚠️ 读取个人资料缓存（伴侣 ID）失败:', profileCacheError?.message ?? profileCacheError);
      }

      // 1️⃣-c 全局好友列表兜底：页面缓存为空时，复用 @friends_list_${user.id}
      try {
        const friendsRaw = await AsyncStorage.getItem(globalFriendsCacheKey);
        if (friendsRaw) {
          const cachedFriends = JSON.parse(friendsRaw);
          if (Array.isArray(cachedFriends) && cachedFriends.length > 0) {
            if (!pageStateRef.current.friends || pageStateRef.current.friends.length === 0) {
              commitPageStateRef.current(origin, { friends: cachedFriends });
              hasLocalData = true;
            }
          }
        }
      } catch (friendsCacheError) {
        console.warn('⚠️ 读取全局好友列表缓存失败:', friendsCacheError?.message ?? friendsCacheError);
      }

      // 1️⃣-d 全局会话列表兜底：@chatList_${user.id} 内同样保存了 friends 数组
      try {
        const chatListRaw = await AsyncStorage.getItem(globalChatListCacheKey);
        if (chatListRaw) {
          const cachedChatList = JSON.parse(chatListRaw);
          if (cachedChatList && Array.isArray(cachedChatList.friends) && cachedChatList.friends.length > 0) {
            if (!pageStateRef.current.friends || pageStateRef.current.friends.length === 0) {
              commitPageStateRef.current(origin, { friends: cachedChatList.friends });
              hasLocalData = true;
            }
          }
        }
      } catch (chatListCacheError) {
        console.warn('⚠️ 读取全局会话列表缓存失败:', chatListCacheError?.message ?? chatListCacheError);
      }

      // 本地已有任何可用数据 → 立刻结束 loading，断网下 0 秒呈现，绝不显示空白页
      if (hasLocalData) {
        commitPageStateRef.current(origin, { loading: false });
      }

      try {
        // 🔒 授权关系以服务端 partner_authorizations 为唯一权威来源。
        //    get_active_partner_id() 是 SECURITY DEFINER RPC，只返回「我」的有效搭子，
        //    客户端无法伪造、也无法通过 bound_partner_id 指针越权读取他人健康数据。
        const { data: activePartnerId, error: partnerErr } = await supabase.rpc('get_active_partner_id');
        // 🛡️ B3-06：RPC 往返期间身份可能已切换 → 丢弃旧会话结果
        if (!isIdentityCurrent(origin)) return;
        if (partnerErr) {
          console.warn('⚠️ 读取有效搭子失败:', partnerErr?.message ?? partnerErr);
        }
        const currentPartnerId = activePartnerId || null;

        // 🛡️ L4-R2：服务端权威结果确认后，原子提交「归属 + 搭子」。
        //    关键：这里**只**提交 boundPartnerId，绝不把 friends 一并标记为已就绪。
        //    归属推进到 origin 时，若上一账号的 friends 仍在，commitPageState 会因
        //    ownerKey 不同而把 friends 重置为空 —— 因此 A 的好友不会因 B 的 RPC
        //    先返回而复活（B3-L4-06）。B 的好友要等下面 profiles 查询成功后才写入。
        commitPageStateRef.current(origin, { boundPartnerId: currentPartnerId });

        let allFriendIds = new Set();
        const { data: fData } = await supabase.from('friends').select('user_id, friend_id').or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
        // 🛡️ B3-06：异步边界校验
        if (!isIdentityCurrent(origin)) return;
        if (fData) fData.forEach(r => allFriendIds.add(r.user_id === user.id ? r.friend_id : r.user_id));
        
        const { data: reqData } = await supabase.from('friend_requests').select('sender_id, receiver_id').eq('status', 'accepted').or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);
        // 🛡️ B3-06：异步边界校验
        if (!isIdentityCurrent(origin)) return;
        if (reqData) reqData.forEach(r => allFriendIds.add(r.sender_id === user.id ? r.receiver_id : r.sender_id));

        const uniqueIds = [...allFriendIds];
        let nextFriends = [];
        if (uniqueIds.length > 0) {
          const { data: profilesData } = await supabase.from('profiles').select('id, username').in('id', uniqueIds);
          // 🛡️ B3-06：异步边界校验
          if (!isIdentityCurrent(origin)) return;
          nextFriends = profilesData || [];
          commitPageStateRef.current(origin, { friends: nextFriends });
        } else {
          commitPageStateRef.current(origin, { friends: [] });
        }

        // 3️⃣ 云端成功 → 回写本地缓存，供下次冷启动/断网秒开
        // 🛡️ B3-06：写缓存前最后一道身份闸门，绝不把 A 的搭子/好友写进 B 的 key
        if (!isIdentityCurrent(origin)) return;
        try {
          await AsyncStorage.setItem(
            partnerPageCacheKey,
            JSON.stringify({ friends: nextFriends, boundPartnerId: currentPartnerId, cachedAt: Date.now() })
          );
        } catch (writeError) {
          console.warn('⚠️ 写入守护伴侣页缓存失败:', writeError?.message ?? writeError);
        }

        // 3️⃣-b 云端成功 → 同步回写全局好友列表缓存，让其他页面（联系人/会话）也能断网秒开
        if (nextFriends.length > 0) {
          try {
            await AsyncStorage.setItem(globalFriendsCacheKey, JSON.stringify(nextFriends));
          } catch (globalWriteError) {
            console.warn('⚠️ 写入全局好友列表缓存失败:', globalWriteError?.message ?? globalWriteError);
          }
        }
      } catch (e) {
        // 🚨 离线降级：绝不重置 state，保持本地缓存读取到的守护伴侣与好友列表
        console.warn('离线，使用缓存守护伴侣数据');
        console.warn('⚠️ 守护伴侣页云端查询失败:', e?.message ?? e);
        // 断网时立即结束加载：0 秒呈现全局缓存中的守护伴侣与好友列表，绝不显示空白页
        // 🛡️ L4-R2：catch 分支同样受身份边界约束，旧会话不得改写新会话的 loading。
        //    离线时保留已原子提交的缓存内容（friends / boundPartnerId 不动），
        //    只把 loading 置 false —— B 的合法离线缓存因此正常呈现（B3-L4-07）。
        commitPageStateRef.current(origin, { loading: false });
      } finally {
        // 🛡️ L4-R2：finally 是最容易被忽略的越界写点，必须同样校验身份
        commitPageStateRef.current(origin, { loading: false });
      }
    };
    loadData();
    // ⚠️ 依赖 globalPartnerId：全局上下文从 @user_profile_cache 恢复绑定关系后，
    //    需要重新执行一次兜底读取，确保断网进入本页时守护伴侣不丢失
    // 🛡️ B3-06：依赖 authEpoch，同账号新会话必须重新加载并作废旧闭包。
  }, [user, authEpoch, globalPartnerId, isIdentityCurrent]);

  const handleBindPartner = async (friendId, friendName) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('邀请健康搭子', `确定邀请 [${friendName}] 成为你的健康守护人吗？\n对方同意后，你们的打卡进度将互相通知。`, [
      { text: '取消', style: 'cancel' },
      { text: '发送邀请', onPress: async () => {
          // 🛡️ B3-06：捕获点击瞬间的身份快照，await 之后写回前必须校验
          const origin = { userId: user?.id ?? null, epoch: authEpoch };
          // 🛡️ L4-R1：弹窗确认时再次确认「该操作仍属于当前会话」。
          //    用户可能在 Alert 弹出期间切号，此时点击「发送邀请」不应产生任何副作用。
          if (!isIdentityCurrent(origin)) return;
          commitPageStateRef.current(origin, { loading: true });

          // 🔒 单次 RPC 完成「授权记录 + 邀请卡片」的原子写入。
          //    T6.1/FIX-01：卡片不再由客户端单独 INSERT。
          //    旧实现是「RPC 建授权 → 客户端再 INSERT 卡片」两步：
          //      · RPC 成功但卡片 INSERT 失败 → 留下「有授权、无卡片」的孤立 pending，
          //        对方永远看不到邀请，却占用了「同一对最多一条 pending」的唯一索引；
          //      · 客户端可自行决定卡片 subtype，卡片与授权事实可能不一致。
          //    现在 request_partner 在同一事务内写授权与卡片（卡片 id = 授权 id），
          //    任一失败整体回滚，客户端无需也不允许再写 SYNC_PARTNER_* 卡片。
          const { data: authId, error: reqError } = await supabase.rpc('request_partner', {
            target_user_id: friendId,
          });
          // 🛡️ B3-06：RPC 往返期间身份可能已切换 → 丢弃旧会话结果，不写缓存、不弹窗
          if (!isIdentityCurrent(origin)) return;
          if (reqError || !authId) {
            console.error('创建搭子邀请失败:', reqError);
            // 🛡️ L4-R1：失败反馈同样受身份边界约束
            runIfCurrentRef.current(origin, () => {
              commitPageStateRef.current(origin, { loading: false });
              Alert.alert('发送失败', reqError?.message || '请检查网络后重试');
            });
            return;
          }

          // 卡片已由服务端写入，这里只构造本地缓存条目（id 与授权记录一致）。
          const newMsg = {
            id: authId,
            user_id: user.id,
            receiver_id: friendId,
            type: 'text',
            text: '',
            subtype: 'SYNC_PARTNER_INVITE',
            isMe: true,
            timestamp: Date.now(),
          };

          // ✅ RPC 成功后才写本地缓存
          // 🔒 M-6：Key 必须与 useChatMessages 保持一致（含当前用户 ID）
          const cacheKey = `@chatMessages_${user.id}_${friendId}`;
          const cached = await AsyncStorage.getItem(cacheKey);
          // 🛡️ B3-06：读缓存后再次校验身份，避免把 A 的邀请卡片写进 B 的会话缓存
          if (!isIdentityCurrent(origin)) return;
          const msgs = cached ? JSON.parse(cached) : [];
          await AsyncStorage.setItem(cacheKey, JSON.stringify([newMsg, ...msgs]));

          // 🛡️ L4-R1：AsyncStorage.setItem 是最后一个 await。
          //    写入本身属于「旧会话已完成的合法操作」，不回滚（缓存归属 A 的 key，
          //    不会污染 B）；但**后续所有反馈副作用**（推送 / loading / 震动 / 弹窗 /
          //    导航）必须整体受身份闸门约束，否则 A 的邀请成功提示会出现在 B 的会话里。
          runIfCurrentRef.current(origin, () => {
            // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
            sendPushNotification(friendId, '', '向你发来了搭子邀请', { type: 'chat', targetId: user.id });

            commitPageStateRef.current(origin, { loading: false });
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('邀请已发送', '邀请卡片已发送，请等待对方在聊天中同意！', [{ text: '好的', onPress: () => router.back() }]);
          });
      }}
    ]);
  };

  const handleUnbind = () => {
    Alert.alert('解除绑定', '确定要解除当前的健康守护伴侣吗？', [
      { text: '取消', style: 'cancel' },
      { text: '解除', style: 'destructive', onPress: async () => {
          // 🛡️ B3-06：捕获点击瞬间的身份快照，await 之后写回前必须校验
          const origin = { userId: user?.id ?? null, epoch: authEpoch };
          // 🛡️ L4-R1：弹窗确认时再次确认「该操作仍属于当前会话」。
          if (!isIdentityCurrent(origin)) return;
          commitPageStateRef.current(origin, { loading: true });

          // 🔒 双向解绑必须走服务端 RPC（SECURITY DEFINER）：
          //    客户端直连 UPDATE 只能改自己那行 profiles（对方行受 RLS 限制），
          //    会造成"我解绑了但对方仍绑着我"的单向残留；
          //    且原 .or() 条件会误伤两人之间的所有消息。
          const { error: rpcError } = await supabase.rpc('unbind_partner', {
            target_partner_id: boundPartnerId,
          });

          // 🛡️ B3-06：解绑 RPC 往返期间身份可能已切换 → 不得清空新账号的绑定状态
          if (!isIdentityCurrent(origin)) return;

          if (rpcError) {
            console.error('双向解绑 RPC 失败', rpcError);
            // 🛡️ L4-R1：失败反馈同样受身份边界约束
            runIfCurrentRef.current(origin, () => {
              commitPageStateRef.current(origin, { loading: false });
              Alert.alert('解除失败', '网络异常，请稍后重试。');
            });
            return;
          }

          // ✅ RPC 成功后才更新本地状态，避免云端失败但本地已清空
          // 🛡️ L4-R2：清空搭子同样走原子提交，归属与内容一起落地
          commitPageStateRef.current(origin, { boundPartnerId: null });
          // 🌐 同步刷新全局上下文：清空 partnerId + partnerData，
          //    否则首页伴侣卡片仍显示已解绑的人，需要多次刷新才消失
          await refreshPartner(null);
          // 🛡️ L4-R1：refreshPartner 是最后一个 await。
          //    解绑 RPC 本身属于「旧会话已完成的合法操作」，不回滚；
          //    但 loading / 成功震动属于 UI 反馈，必须整体受身份闸门约束，
          //    否则 A 的解绑成功震动会出现在 B 的页面上。
          runIfCurrentRef.current(origin, () => {
            commitPageStateRef.current(origin, { loading: false });
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          });
      }}
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: palette.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={palette.primary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>选择守护伴侣</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.subHeader}>
        <Text style={[styles.subText, { color: palette.textSecondary }]}>打卡进度将仅向绑定的用户发送实时通知</Text>
      </View>

      {visibleBoundPartnerId && (
        <View style={styles.unbindContainer}>
          <TouchableOpacity style={[styles.unbindBtn, { backgroundColor: palette.card, borderColor: '#FF3B30' }]} onPress={handleUnbind}>
            <Ionicons name="heart-dislike" size={20} color="#FF3B30" />
            <Text style={styles.unbindText}>解除当前守护伴侣</Text>
          </TouchableOpacity>
        </View>
      )}

      {visibleLoading ? (
        <View style={styles.center}><ActivityIndicator color={palette.primary} /></View>
      ) : visibleFriends.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={64} color={palette.separator} />
          <Text style={{ color: palette.textSecondary, marginTop: 16 }}>你还没有添加好友哦</Text>
        </View>
      ) : (
        <FlatList
          data={visibleFriends}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={[styles.friendCard, { backgroundColor: palette.card, borderColor: palette.cardBorder }]} onPress={() => handleBindPartner(item.id, item.username)} activeOpacity={0.7}>
              <View style={[styles.avatar, { backgroundColor: palette.primary }]}>
                <Text style={styles.avatarText}>{item.username.substring(0, 2).toUpperCase()}</Text>
              </View>
              <Text style={{ flex: 1, fontSize: 17, color: palette.textPrimary, fontWeight: '500' }}>{item.username}</Text>
              
              {visibleBoundPartnerId === item.id ? (
                <Ionicons name="checkmark-circle" size={24} color="#34C759" />
              ) : (
                <View style={[styles.radioEmpty, { borderColor: palette.textSecondary }]} />
              )}
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { padding: 4, marginLeft: -8 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  subHeader: { paddingHorizontal: 20, paddingVertical: 16 },
  subText: { fontSize: 13, textAlign: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  friendCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, marginBottom: 12, borderWidth: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  avatarText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 },
  radioEmpty: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5 },
  unbindContainer: { paddingHorizontal: 16, paddingBottom: 12 },
  unbindBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 16, borderWidth: 1 },
  unbindText: { color: '#FF3B30', fontSize: 16, fontWeight: 'bold', marginLeft: 8 }
});
// --- END OF FILE src/app/bind_partner.js ---