// --- START OF FILE src/app/bind_partner.js ---
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { useHealthData } from '../hooks/useHealthData';
import { PROFILE_CACHE_KEY } from '../hooks/profile/useProfileCache';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';

export default function BindPartnerScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  // 🌐 全局健康上下文：解绑/绑定后必须同步刷新，否则首页伴侣卡片要等冷启动才更新
  //    partnerId 同时作为断网兜底数据源：全局已恢复的绑定关系可直接复用，无需等网络
  const { refreshPartner, partnerId: globalPartnerId } = useHealthData();

  const [friends, setFriends] = useState([]);
  const [boundPartnerId, setBoundPartnerId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const loadData = async () => {
      // 💾 守护伴侣页本地缓存 key（按用户隔离，切换账号不会串数据）
      const partnerPageCacheKey = `@partner_page_data_${user.id}`;
      // 💾 全局好友列表缓存 key（与 useChatList 写入的 @friends_list_ 保持一致）
      const globalFriendsCacheKey = `@friends_list_${user.id}`;
      // 💾 全局会话列表缓存 key（兜底：老版本只写过 @chatList_，其中 friends 字段同样可用）
      const globalChatListCacheKey = `@chatList_${user.id}`;

      // 1️⃣ 第 0 步：本地缓存优先（零网络，断网也能瞬间显示守护伴侣与好友列表）
      let hasLocalData = false;
      try {
        const cachedRaw = await AsyncStorage.getItem(partnerPageCacheKey);
        if (cachedRaw) {
          const cachedData = JSON.parse(cachedRaw);
          if (cachedData && typeof cachedData === 'object') {
            if (Array.isArray(cachedData.friends) && cachedData.friends.length > 0) {
              setFriends(cachedData.friends);
              hasLocalData = true;
            }
            if (cachedData.boundPartnerId !== undefined && cachedData.boundPartnerId !== null) {
              setBoundPartnerId(cachedData.boundPartnerId);
              hasLocalData = true;
            }
          }
          // 缓存已渲染 → 立刻结束 loading，绝不卡在转圈状态
          setLoading(false);
        }
      } catch (cacheError) {
        console.warn('⚠️ 读取守护伴侣页缓存失败:', cacheError?.message ?? cacheError);
      }

      // 1️⃣-a 全局伴侣 ID 兜底：页面缓存缺失时，优先复用全局健康上下文已恢复的 partnerId
      //      （useHealthData 的 loadProfile 已从 @user_profile_cache 第 0 帧恢复绑定关系）
      if (globalPartnerId) {
        setBoundPartnerId((prev) => prev || globalPartnerId);
        hasLocalData = true;
      }

      // 1️⃣-b 全局伴侣 ID 兜底：再读 @user_profile_cache 中的 bound_partner_id（零网络）
      try {
        const profileRaw = await AsyncStorage.getItem(PROFILE_CACHE_KEY);
        if (profileRaw) {
          const cachedProfile = JSON.parse(profileRaw);
          // 缓存归属校验：只认当前登录用户自己的资料，避免换号后串数据
          if (cachedProfile && cachedProfile.id === user.id && cachedProfile.bound_partner_id) {
            setBoundPartnerId((prev) => prev || cachedProfile.bound_partner_id);
            hasLocalData = true;
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
            setFriends((prev) => (prev && prev.length > 0 ? prev : cachedFriends));
            hasLocalData = true;
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
            setFriends((prev) => (prev && prev.length > 0 ? prev : cachedChatList.friends));
            hasLocalData = true;
          }
        }
      } catch (chatListCacheError) {
        console.warn('⚠️ 读取全局会话列表缓存失败:', chatListCacheError?.message ?? chatListCacheError);
      }

      // 本地已有任何可用数据 → 立刻结束 loading，断网下 0 秒呈现，绝不显示空白页
      if (hasLocalData) {
        setLoading(false);
      }

      try {
        const { data: profile } = await supabase.from('profiles').select('bound_partner_id').eq('id', user.id).single();
        let currentPartnerId = profile?.bound_partner_id || null;

        if (!currentPartnerId) {
          const { data: acceptedMsgs } = await supabase.from('messages')
            .select('receiver_id')
            .eq('user_id', user.id)
            .eq('subtype', 'SYNC_PARTNER_ACCEPTED')
            .order('created_at', { ascending: false })
            .limit(1);

          if (acceptedMsgs && acceptedMsgs.length > 0) {
            currentPartnerId = acceptedMsgs[0].receiver_id;
            await supabase.from('profiles').update({ bound_partner_id: currentPartnerId }).eq('id', user.id);
          }
        }

        setBoundPartnerId(currentPartnerId);

        let allFriendIds = new Set();
        const { data: fData } = await supabase.from('friends').select('user_id, friend_id').or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
        if (fData) fData.forEach(r => allFriendIds.add(r.user_id === user.id ? r.friend_id : r.user_id));
        
        const { data: reqData } = await supabase.from('friend_requests').select('sender_id, receiver_id').eq('status', 'accepted').or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);
        if (reqData) reqData.forEach(r => allFriendIds.add(r.sender_id === user.id ? r.receiver_id : r.sender_id));

        const uniqueIds = [...allFriendIds];
        let nextFriends = [];
        if (uniqueIds.length > 0) {
          const { data: profilesData } = await supabase.from('profiles').select('id, username').in('id', uniqueIds);
          nextFriends = profilesData || [];
          setFriends(nextFriends);
        } else {
          setFriends([]);
        }

        // 3️⃣ 云端成功 → 回写本地缓存，供下次冷启动/断网秒开
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
        setLoading(false);
      } finally {
        setLoading(false);
      }
    };
    loadData();
    // ⚠️ 依赖 globalPartnerId：全局上下文从 @user_profile_cache 恢复绑定关系后，
    //    需要重新执行一次兜底读取，确保断网进入本页时守护伴侣不丢失
  }, [user, globalPartnerId]);

  const handleBindPartner = async (friendId, friendName) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('邀请健康搭子', `确定邀请 [${friendName}] 成为你的健康守护人吗？\n对方同意后，你们的打卡进度将互相通知。`, [
      { text: '取消', style: 'cancel' },
      { text: '发送邀请', onPress: async () => {
          setLoading(true);
          
          const msgId = Crypto.randomUUID();
          const secretText = '';
          const secretSubtype = 'SYNC_PARTNER_INVITE';

          const newMsg = { id: msgId, user_id: user.id, receiver_id: friendId, type: 'text', text: secretText, subtype: secretSubtype, isMe: true, timestamp: Date.now() };

          // ☁️ 先写云端：失败则直接中断，绝不落本地，避免产生无法撤销的"幽灵消息"
          const { error } = await supabase.from('messages').insert({
            id: msgId, user_id: user.id, receiver_id: friendId, type: 'text', text: secretText, subtype: secretSubtype
          });

          if (error) {
            console.error("发送搭子卡片失败:", error);
            setLoading(false);
            Alert.alert('发送失败', '请检查网络后重试');
            return;
          }

          // ✅ 云端成功后才写本地缓存
          const cacheKey = `@chatMessages_${friendId}`;
          const cached = await AsyncStorage.getItem(cacheKey);
          const msgs = cached ? JSON.parse(cached) : [];
          await AsyncStorage.setItem(cacheKey, JSON.stringify([newMsg, ...msgs]));

          // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
          sendPushNotification(friendId, '', '向你发来了搭子邀请', { type: 'chat', targetId: user.id });

          setLoading(false);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert('邀请已发送', '邀请卡片已发送，请等待对方在聊天中同意！', [{ text: '好的', onPress: () => router.back() }]);
      }}
    ]);
  };

  const handleUnbind = () => {
    Alert.alert('解除绑定', '确定要解除当前的健康守护伴侣吗？', [
      { text: '取消', style: 'cancel' },
      { text: '解除', style: 'destructive', onPress: async () => {
          setLoading(true);

          // 🔒 双向解绑必须走服务端 RPC（SECURITY DEFINER）：
          //    客户端直连 UPDATE 只能改自己那行 profiles（对方行受 RLS 限制），
          //    会造成"我解绑了但对方仍绑着我"的单向残留；
          //    且原 .or() 条件会误伤两人之间的所有消息。
          const { error: rpcError } = await supabase.rpc('unbind_partner', {
            target_partner_id: boundPartnerId,
          });

          if (rpcError) {
            console.error('双向解绑 RPC 失败', rpcError);
            setLoading(false);
            Alert.alert('解除失败', '网络异常，请稍后重试。');
            return;
          }

          // ✅ RPC 成功后才更新本地状态，避免云端失败但本地已清空
          setBoundPartnerId(null);
          // 🌐 同步刷新全局上下文：清空 partnerId + partnerData，
          //    否则首页伴侣卡片仍显示已解绑的人，需要多次刷新才消失
          await refreshPartner(null);
          setLoading(false);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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

      {boundPartnerId && (
        <View style={styles.unbindContainer}>
          <TouchableOpacity style={[styles.unbindBtn, { backgroundColor: palette.card, borderColor: '#FF3B30' }]} onPress={handleUnbind}>
            <Ionicons name="heart-dislike" size={20} color="#FF3B30" />
            <Text style={styles.unbindText}>解除当前守护伴侣</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={palette.primary} /></View>
      ) : friends.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={64} color={palette.separator} />
          <Text style={{ color: palette.textSecondary, marginTop: 16 }}>你还没有添加好友哦</Text>
        </View>
      ) : (
        <FlatList
          data={friends}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={[styles.friendCard, { backgroundColor: palette.card, borderColor: palette.cardBorder }]} onPress={() => handleBindPartner(item.id, item.username)} activeOpacity={0.7}>
              <View style={[styles.avatar, { backgroundColor: palette.primary }]}>
                <Text style={styles.avatarText}>{item.username.substring(0, 2).toUpperCase()}</Text>
              </View>
              <Text style={{ flex: 1, fontSize: 17, color: palette.textPrimary, fontWeight: '500' }}>{item.username}</Text>
              
              {boundPartnerId === item.id ? (
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