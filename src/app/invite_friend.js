// --- START OF FILE src/app/invite_friend.js ---
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';

export default function InviteFriendScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { roomId } = useLocalSearchParams();
  const { user } = useAuth();

  const [friends, setFriends] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const loadFriends = async () => {
      let allFriendIds = new Set();
      const { data: fData } = await supabase.from('friends').select('user_id, friend_id').or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
      if (fData) fData.forEach(r => allFriendIds.add(r.user_id === user.id ? r.friend_id : r.user_id));
      
      const { data: reqData } = await supabase.from('friend_requests').select('sender_id, receiver_id').eq('status', 'accepted').or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);
      if (reqData) reqData.forEach(r => allFriendIds.add(r.sender_id === user.id ? r.receiver_id : r.sender_id));

      const uniqueIds = [...allFriendIds];
      if (uniqueIds.length > 0) {
        const { data: profilesData } = await supabase.from('profiles').select('id, username').in('id', uniqueIds);
        setFriends(profilesData || []);
      } else {
        setFriends([]);
      }
      setLoading(false);
    };
    loadFriends();
  }, [user]);

  // 🍎 用 useCallback 包裹：sendInvite 只在用户点击时执行（事件回调），
  //    但 React Compiler 的 purity 规则无法静态区分「render 期调用」与
  //    「事件回调」，会把 Date.now() 误判为 render 期不纯调用。
  //    显式声明为 useCallback 后编译器可正确识别为回调作用域。
  const sendInvite = useCallback(async (friend) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    
    // 🍎 使用标准 UUID，数据库绝对不会再报错拦截了！
    const msgId = Crypto.randomUUID();
    
    // 🚨 修复「消息删不掉 / 顺序错乱」：
    //   旧实现直接 [newMsg, ...msgs] 覆盖缓存，既不过滤「已删除 ID 黑名单」，
    //   也不按时间排序，导致被删消息被重新写回、时间轴错乱。
    //   现在与 useChatMessages 的合并规则保持一致：
    //   过滤黑名单 → 按 timestamp 降序 → 截断到 300 条。
    const newMsg = {
      id: msgId,
      type: 'cinema_invite',
      subtype: null,
      text: roomId || 'error_room',
      mediaUrl: null,
      thumbnailUrl: null,
      duration: 0,
      isMe: true,
      timestamp: Date.now(),
    };
    // ☁️ 先写云端：失败则直接中断，绝不落本地，避免产生无法撤销的"幽灵消息"
    const { error } = await supabase.from('messages').insert({
      id: msgId, user_id: user.id, receiver_id: friend.id, type: 'cinema_invite', text: roomId || 'error_room'
    });

    if (error) {
      console.error("发送影院卡片失败:", error);
      Alert.alert('发送失败', '请检查网络后重试');
      return;
    }

    // ✅ 云端成功后才写本地缓存
    // 🔒 M-6：Key 必须与 useChatMessages 保持一致（含当前用户 ID），
    //    否则这里写入的缓存读不到，且注销时无法被清理，成为孤儿数据。
    const cacheKey = `@chatMessages_${user.id}_${friend.id}`;
    const delKey = `@deletedMsgIds_${user.id}_${friend.id}`;
    const [cached, deletedStr] = await Promise.all([
      AsyncStorage.getItem(cacheKey),
      AsyncStorage.getItem(delKey),
    ]);
    const msgs = cached ? JSON.parse(cached) : [];
    const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
    const deletedSet = new Set(deletedIds);
    const merged = [newMsg, ...msgs]
      .filter((m) => !deletedSet.has(m.id))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 300);
    await AsyncStorage.setItem(cacheKey, JSON.stringify(merged));

    // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
    sendPushNotification(friend.id, '', '邀请你加入同步放映室，快来！', { type: 'chat', targetId: user.id });
    
    Alert.alert('邀请已发送', `邀请卡片已发送至与 ${friend.username} 的聊天界面`, [
      { text: '返回影院', onPress: () => router.back() }
    ]);
  }, [roomId, user]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: palette.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="close" size={28} color={palette.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>邀请谁一起看？</Text>
        <View style={{ width: 28 }} />
      </View>

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
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16 }}
          renderItem={({ item }) => (
            <TouchableOpacity style={[styles.friendCard, { backgroundColor: palette.card, borderColor: palette.cardBorder }]} onPress={() => sendInvite(item)} activeOpacity={0.7}>
              <View style={[styles.avatar, { backgroundColor: palette.primary }]}>
                <Text style={styles.avatarText}>{item.username.substring(0, 2).toUpperCase()}</Text>
              </View>
              <Text style={{ flex: 1, fontSize: 17, color: palette.textPrimary, fontWeight: '500' }}>{item.username}</Text>
              <Ionicons name="paper-plane" size={20} color={palette.primary} />
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  friendCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, marginBottom: 12, borderWidth: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  avatarText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 }
});
// --- END OF FILE src/app/invite_friend.js ---