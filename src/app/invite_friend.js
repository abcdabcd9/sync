// --- START OF FILE src/app/invite_friend.js ---
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';

// 🍎 修复核心：加入标准的 UUID 生成器，完美契合数据库的 uuid 类型！
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

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

  const sendInvite = async (friend) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    
    // 🍎 使用标准 UUID，数据库绝对不会再报错拦截了！
    const msgId = generateUUID();
    
    const newMsg = { id: msgId, user_id: user.id, receiver_id: friend.id, type: 'cinema_invite', text: roomId || 'error_room', isMe: true, timestamp: Date.now() };
    const cacheKey = `@chatMessages_${friend.id}`;
    const cached = await AsyncStorage.getItem(cacheKey);
    const msgs = cached ? JSON.parse(cached) : [];
    await AsyncStorage.setItem(cacheKey, JSON.stringify([newMsg, ...msgs]));

    // 存入云端
    const { error } = await supabase.from('messages').insert({
      id: msgId, user_id: user.id, receiver_id: friend.id, type: 'cinema_invite', text: roomId || 'error_room'
    });
    
    if (error) console.error("发送影院卡片失败:", error);

    // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
    sendPushNotification(friend.id, '', '邀请你加入同步放映室，快来！', { type: 'chat', targetId: user.id });
    
    Alert.alert('邀请已发送', `邀请卡片已发送至与 ${friend.username} 的聊天界面`, [
      { text: '返回影院', onPress: () => router.back() }
    ]);
  };

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