// --- START OF FILE src/app/chat/contacts.js ---
import React, { useCallback } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import { haptic } from '../../constants/haptics';
import { useChatList } from '../../hooks/chat/useChatList';
import SettingsPage from '../../components/settings/SettingsPage';

// params: 无
// 联系人页：新朋友请求 + 所有联系人；右上角「+」进入 /chat/search
export default function ChatContactsScreen() {
  const { colors: palette } = useAppTheme();
  const { user } = useAuth();
  const { friends, requests, loading, refresh, getDisplayName } = useChatList(user);

  // 🔒 安全审计 #6/#7：归属校验，只能处理「发给自己的」好友请求
  const handleAcceptRequest = useCallback(
    async (request) => {
      if (!user || !request || request.receiver_id !== user.id) return;
      if (!request.sender_id || request.sender_id === user.id) return;

      try {
        haptic.success();
        await supabase
          .from('friend_requests')
          .update({ status: 'accepted' })
          .eq('id', request.id)
          .eq('receiver_id', user.id);
        // 🔒 安全审计 #7：friends 关系必须包含当前用户自身，禁止代他人建立关系
        await supabase
          .from('friends')
          .insert({ user_id: user.id, friend_id: request.sender_id })
          .select('id');
        refresh();
      } catch {
        Alert.alert('操作失败', '同意好友请求失败，请稍后重试。');
      }
    },
    [user, refresh]
  );

  // 🔒 安全审计 #6：归属校验，只能删除「发给自己的」好友请求
  const handleRejectRequest = useCallback(
    async (request) => {
      if (!user || !request || request.receiver_id !== user.id) return;

      haptic.light();
      await supabase
        .from('friend_requests')
        .delete()
        .eq('id', request.id)
        .eq('receiver_id', user.id);
      refresh();
    },
    [user, refresh]
  );

  const openContactProfile = (item) => {
    haptic.light();
    const rel = friends.find((f) => f.id === item.id);
    router.push({
      pathname: '/contact_profile',
      params: {
        id: item.id,
        sync_id: item.sync_id,
        nickname: item.nickname,
        username: item.username,
        remark: rel?.remark || '',
      },
    });
  };

  return (
    <SettingsPage title="联系人">
      <TouchableOpacity
        style={[styles.searchEntry, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}
        onPress={() => {
          haptic.light();
          router.push('/chat/search');
        }}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel="搜索添加好友"
      >
        <Ionicons name="search" size={20} color={palette.textSecondary} style={styles.searchIcon} />
        <Text style={[styles.searchPlaceholder, { color: palette.textSecondary }]}>
          通过 Sync ID 搜索添加好友
        </Text>
        <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
      </TouchableOpacity>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={palette.textSecondary} />
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {requests.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionHeader, { color: palette.textSecondary }]}>新朋友请求</Text>
              {requests.map((req) => {
                const displayName = req.sender_profile?.nickname || req.sender_profile?.username || '未知';
                return (
                  <View
                    key={req.id}
                    style={[styles.requestCard, { backgroundColor: palette.card, borderColor: palette.primary }]}
                  >
                    <View style={[styles.avatarRound, { backgroundColor: palette.iconBackground }]}>
                      <Text style={styles.avatarTextRound}>{displayName.substring(0, 2).toUpperCase()}</Text>
                    </View>
                    <Text style={[styles.requestName, { color: palette.textPrimary }]} numberOfLines={1}>
                      {displayName}
                    </Text>
                    <View style={styles.requestActions}>
                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: palette.separator }]}
                        onPress={() => handleRejectRequest(req)}
                        activeOpacity={0.6}
                      >
                        <Text style={[styles.actionText, { color: palette.textPrimary }]}>拒绝</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.actionBtn, { backgroundColor: palette.primary }]}
                        onPress={() => handleAcceptRequest(req)}
                        activeOpacity={0.6}
                      >
                        <Text style={[styles.actionText, styles.actionTextPrimary]}>同意</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          <Text style={[styles.sectionHeader, { color: palette.textSecondary, marginTop: 8 }]}>
            所有联系人
          </Text>
          {friends.length === 0 ? (
            <Text style={[styles.emptyText, { color: palette.textSecondary }]}>暂无好友</Text>
          ) : (
            friends.map((item) => {
              if (!item) return null;
              const displayName = getDisplayName(item);
              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.contactRow}
                  onPress={() => openContactProfile(item)}
                  activeOpacity={0.6}
                >
                  <View style={styles.avatarAreaContact}>
                    <View style={[styles.avatarContact, { backgroundColor: palette.iconBackground }]}>
                      <Text style={styles.avatarTextContact}>
                        {displayName.substring(0, 2).toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={[styles.contentAreaContact, { borderBottomColor: palette.separator }]}>
                    <Text style={[styles.contactName, { color: palette.textPrimary }]} numberOfLines={1}>
                      {displayName}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  searchEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 42,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 24,
  },
  searchIcon: { marginRight: 8 },
  searchPlaceholder: { flex: 1, fontSize: 15 },
  center: { paddingTop: 60, alignItems: 'center' },
  section: { marginBottom: 24 },
  sectionHeader: { fontSize: 13, marginBottom: 8, fontWeight: '500', marginLeft: 4 },
  requestCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
  },
  avatarRound: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  avatarTextRound: { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold' },
  requestName: { fontSize: 16, fontWeight: '600', flex: 1, minWidth: 0, flexShrink: 1 },
  requestActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, flexShrink: 0 },
  actionText: { fontSize: 14, fontWeight: '600' },
  actionTextPrimary: { color: '#FFF' },
  emptyText: { textAlign: 'center', marginTop: 20, fontSize: 14 },
  contactRow: { flexDirection: 'row', alignItems: 'center' },
  avatarAreaContact: { paddingVertical: 10, paddingRight: 14, justifyContent: 'center' },
  avatarContact: {
    width: 41,
    height: 41,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarTextContact: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  contentAreaContact: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contactName: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
});
// --- END OF FILE src/app/chat/contacts.js ---
