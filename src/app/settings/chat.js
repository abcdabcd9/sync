// --- START OF FILE src/app/settings/chat.js ---
import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import { useAppSettings } from '../../hooks/useAppSettings';
import { CHAT_BACKGROUNDS, labelOf } from '../../constants/settings';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

// 聊天设置：聊天背景 + 听筒模式 + 消息预览
export default function ChatSettingsScreen() {
  const { colors } = useAppTheme();
  const { settings, updateSetting } = useAppSettings();

  const currentBg = labelOf(CHAT_BACKGROUNDS, settings.chatBackground, '跟随主题');

  const handlePickBackground = () => {
    haptic.light();
    Alert.alert(
      '聊天背景',
      '选择聊天页面的背景风格',
      [
        ...CHAT_BACKGROUNDS.map((opt) => ({
          text: opt.label + (opt.key === settings.chatBackground ? '  ✓' : ''),
          onPress: () => {
            updateSetting('chatBackground', opt.key);
            haptic.success();
          },
        })),
        { text: '取消', style: 'cancel' },
      ]
    );
  };

  return (
    <SettingsPage
      title="聊天设置"
      footer="听筒模式与消息预览将在后续版本接入聊天页，当前仅保存你的偏好。"
    >
      <GroupTitle>外观</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, { backgroundColor: colors.card }]}
          onPress={handlePickBackground}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`聊天背景，当前${currentBg}`}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>聊天背景</Text>
          <View style={styles.right}>
            <Text style={[styles.value, { color: colors.textSecondary }]}>{currentBg}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </View>
        </TouchableOpacity>
      </Group>

      <GroupTitle>播放与提醒</GroupTitle>
      <Group>
        <SwitchRow
          title="听筒模式"
          desc="播放语音消息时使用听筒而非扬声器"
          value={settings.earpieceMode}
          onValueChange={(v) => updateSetting('earpieceMode', v)}
          isFirst
        />
        <SwitchRow
          title="消息预览"
          desc="在通知中显示消息内容"
          value={settings.messagePreview}
          onValueChange={(v) => updateSetting('messagePreview', v)}
          isLast
        />
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
  right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { fontSize: 15 },
});
// --- END OF FILE src/app/settings/chat.js ---
