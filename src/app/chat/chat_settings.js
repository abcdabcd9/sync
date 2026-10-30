// --- START OF FILE src/app/chat/chat_settings.js ---
import React from 'react';
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
// 功能：查找聊天记录 / 消息免打扰 + 置顶聊天提醒 / 聊天背景 / 清空聊天记录 / 投诉
export default function ChatSettingsScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { targetId, targetName } = useLocalSearchParams();

  const prefs = useChatPrefs(user);

  const currentBgKey = prefs.getBackground(targetId);
  const currentBg = labelOf(CHAT_BACKGROUNDS, currentBgKey, '跟随主题');

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

  // ===== 6. 投诉 → 独立页 =====
  const handleOpenComplaint = () => {
    haptic.light();
    router.push({
      pathname: '/chat/complaint',
      params: { targetId, targetName: targetName || '', scope: 'chat' },
    });
  };

  return (
    <SettingsPage title={targetName ? `${targetName}` : '聊天设置'}>
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

      {/* 5. 清空聊天记录 */}
      <GroupTitle>数据</GroupTitle>
      <Group>
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
