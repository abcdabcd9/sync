// --- START OF FILE src/app/bind_partner.js ---
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';

const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

export default function BindPartnerScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();

  const [friends, setFriends] = useState([]);
  const [boundPartnerId, setBoundPartnerId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const loadData = async () => {
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
      if (uniqueIds.length > 0) {
        const { data: profilesData } = await supabase.from('profiles').select('id, username').in('id', uniqueIds);
        setFriends(profilesData || []);
      } else {
        setFriends([]);
      }
      setLoading(false);
    };
    loadData();
  }, [user]);

  const handleBindPartner = async (friendId, friendName) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('邀请健康搭子', `确定邀请 [${friendName}] 成为你的健康守护人吗？\n对方同意后，你们的打卡进度将互相通知。`, [
      { text: '取消', style: 'cancel' },
      { text: '发送邀请', onPress: async () => {
          setLoading(true);
          
          const msgId = generateUUID();
          const secretText = '';
          const secretSubtype = 'SYNC_PARTNER_INVITE';

          const newMsg = { id: msgId, user_id: user.id, receiver_id: friendId, type: 'text', text: secretText, subtype: secretSubtype, isMe: true, timestamp: Date.now() };
          const cacheKey = `@chatMessages_${friendId}`;
          const cached = await AsyncStorage.getItem(cacheKey);
          const msgs = cached ? JSON.parse(cached) : [];
          await AsyncStorage.setItem(cacheKey, JSON.stringify([newMsg, ...msgs]));

          const { error } = await supabase.from('messages').insert({
            id: msgId, user_id: user.id, receiver_id: friendId, type: 'text', text: secretText, subtype: secretSubtype
          });
          
          if (error) console.error("发送搭子卡片失败:", error);
          
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
          await supabase.from('profiles').update({ bound_partner_id: null }).eq('id', user.id);
          
          await supabase.from('messages')
            .update({ text: '', subtype: 'SYNC_PARTNER_UNBOUND' })
            .eq('subtype', 'SYNC_PARTNER_ACCEPTED')
            .or(`user_id.eq.${user.id},receiver_id.eq.${user.id}`);

          setBoundPartnerId(null);
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
            <Ionicons name="heart-disallow" size={20} color="#FF3B30" />
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