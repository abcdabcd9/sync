// --- START OF FILE src/app/chat/chat_settings.js ---
import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import { haptic } from '../../constants/haptics';
import { useChatPrefs } from '../../hooks/chat/useChatPrefs';
import { CHAT_BACKGROUNDS, labelOf } from '../../constants/settings';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

// params: targetId, targetName
// 聊天设置页（L2 聊天室右上角「3 个点」跳转目标）
// 功能：联系人头像卡片 / 查找聊天记录 / 消息免打扰 + 置顶聊天提醒 / 聊天背景 / 清空聊天记录 / 投诉
export default function ChatSettingsScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { targetId, targetName } = useLocalSearchParams();

  const prefs = useChatPrefs(user);

  // 联系人资料（用于顶部头像卡片 + 跳转朋友设置时携带参数）
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!targetId) return () => { cancelled = true; };
    (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, nickname, username, sync_id')
          .eq('id', targetId)
          .maybeSingle();
        if (!cancelled) setProfile(data || null);
      } catch {
        if (!cancelled) setProfile(null);
      }
    })();
    return () => { cancelled = true; };
  }, [targetId]);

  const displayName = profile?.nickname || profile?.username || targetName || '好友';
  const displayId = profile?.sync_id || profile?.username || '';

  const currentBgKey = prefs.getBackground(targetId);
  const currentBg = labelOf(CHAT_BACKGROUNDS, currentBgKey, '跟随主题');

  // ===== 0. 头像卡片 → 朋友设置页（与通讯录「3 个点」同一目标）=====
  const handleOpenFriendSettings = () => {
    if (!targetId) return;
    haptic.light();
    router.push({
      pathname: '/chat/friend_settings',
      params: {
        id: targetId,
        nickname: profile?.nickname || '',
        username: profile?.username || '',
        sync_id: profile?.sync_id || '',
        remark: '',
      },
    });
  };

  // ===== 1. 查找聊天记录 → 独立页 =====
  const handleOpenSearch = () => {
    haptic.light();
    router.push({
      pathname: '/chat/chat_search',
      params: { targetId, targetName: targetName || '' },
    });
  };

  // ===== 4. 设置当前聊天背景 → 独立页 =====
  const handleOpenBackground = () => {
    haptic.light();
    router.push({
      pathname: '/chat/chat_background',
      params: { targetId, targetName: targetName || '' },
    });
  };

  // ===== 5. 清空聊天记录 =====
  const handleClearHistory = () => {
    haptic.warning();
    Alert.alert(
      '清空聊天记录',
      `确定要清空与「${targetName || '该好友'}」的全部聊天记录吗？此操作不可恢复。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清空',
          style: 'destructive',
          onPress: async () => {
            if (!user || !targetId) return;
            // 🔒 归属校验：只删除「我参与的」这段会话
            const { error } = await supabase
              .from('messages')
              .delete()
              .or(
                `and(user_id.eq.${user.id},receiver_id.eq.${targetId}),and(user_id.eq.${targetId},receiver_id.eq.${user.id})`
              );
            if (error) {
              haptic.error();
              Alert.alert('清空失败', error.message);
              return;
            }
            prefs.clearChat(targetId);
            haptic.success();
            Alert.alert('已清空', '聊天记录已删除。');
          },
        },
      ]
    );
  };

  // ===== 我的收藏 → 独立页 =====
  const handleOpenFavorites = () => {
    haptic.light();
    router.push('/chat/favorites');
  };

  // ===== 6. 投诉 → 独立页 =====
  const handleOpenComplaint = () => {
    haptic.light();
    router.push({
      pathname: '/chat/complaint',
      params: { targetId, targetName: targetName || '', scope: 'chat' },
    });
  };

  return (
    <SettingsPage title={displayName}>
      {/* 0. 联系人头像卡片 → 朋友设置页（放进 Group 内，宽度与下方各行完全一致） */}
      <Group style={styles.profileGroup}>
        <TouchableOpacity
          style={styles.profileCard}
          onPress={handleOpenFriendSettings}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${displayName} 的朋友设置`}
          accessibilityHint="打开朋友设置页面"
        >
          <View style={[styles.profileAvatar, { backgroundColor: palette.primary }]}>
            <Text style={styles.profileAvatarText}>
              {displayName.substring(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={styles.profileTextCol}>
            <Text style={[styles.profileName, { color: palette.textPrimary }]} numberOfLines={1}>
              {displayName}
            </Text>
            {!!displayId && (
              <Text style={[styles.profileId, { color: palette.textSecondary }]} numberOfLines={1}>
                ID: {displayId}
              </Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
      </Group>

      {/* 1. 查找聊天记录（跳转页） */}
      <GroupTitle>聊天记录</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={handleOpenSearch}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="查找聊天记录"
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>查找聊天记录</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
      </Group>

      {/* 2 + 3. 消息免打扰 / 置顶聊天提醒（同一按钮样式） */}
      <GroupTitle>提醒</GroupTitle>
      <Group>
        <SwitchRow
          title="消息免打扰"
          desc="收到消息时不发出提示音与横幅"
          value={prefs.isMuted(targetId)}
          onValueChange={() => prefs.toggleMute(targetId)}
          isFirst
        />
        <SwitchRow
          title="置顶聊天提醒"
          desc="置顶后仍按普通消息提醒"
          value={prefs.isPinned(targetId)}
          onValueChange={() => prefs.togglePin(targetId)}
          isLast
        />
      </Group>

      {/* 4. 聊天背景（跳转页） */}
      <GroupTitle>外观</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={handleOpenBackground}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`聊天背景，当前${currentBg}`}
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>设置当前聊天背景</Text>
          <View style={styles.right}>
            <Text style={[styles.value, { color: palette.textSecondary }]}>{currentBg}</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
          </View>
        </TouchableOpacity>
      </Group>

      {/* 5. 我的收藏 / 清空聊天记录 */}
      <GroupTitle>数据</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.separator }]}
          onPress={handleOpenFavorites}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="我的收藏"
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>我的收藏</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.row}
          onPress={handleClearHistory}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="清空聊天记录"
        >
          <Text style={[styles.title, styles.danger, { color: '#FF3B30' }]}>清空聊天记录</Text>
        </TouchableOpacity>
      </Group>

      {/* 6. 投诉（跳转页） */}
      <GroupTitle>举报</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={handleOpenComplaint}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="投诉"
        >
          <Text style={[styles.title, styles.danger, { color: '#FF3B30' }]}>投诉</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
      </Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // 与 GroupTitle 的 marginTop: 24 对齐，让卡片和下方分组节奏一致
  profileGroup: { marginTop: 24 },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  profileAvatar: {
    width: 52,
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileAvatarText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  profileTextCol: { flex: 1 },
  profileName: { fontSize: 17, fontWeight: '600' },
  profileId: { fontSize: 12, marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  title: { fontSize: 16, flex: 1 },
  danger: { fontWeight: '500' },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { fontSize: 15 },
});
// --- END OF FILE src/app/chat/chat_settings.js ---
