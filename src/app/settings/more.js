// --- START OF FILE src/app/settings/more.js ---
import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import { useAppSettings } from '../../hooks/useAppSettings';
import { LANGUAGES, labelOf } from '../../constants/settings';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

// 更多：关怀模式 + 语言 + 恢复默认设置
export default function MoreSettingsScreen() {
  const { colors } = useAppTheme();
  const { settings, updateSetting, resetSettings } = useAppSettings();

  const currentLang = labelOf(LANGUAGES, settings.language, '简体中文');

  const handlePickLanguage = () => {
    haptic.light();
    Alert.alert(
      '界面语言',
      '选择 App 的显示语言',
      [
        ...LANGUAGES.map((opt) => ({
          text: opt.label + (opt.key === settings.language ? '  ✓' : ''),
          onPress: () => {
            updateSetting('language', opt.key);
            haptic.success();
          },
        })),
        { text: '取消', style: 'cancel' },
      ]
    );
  };

  const handleResetSettings = () => {
    haptic.warning();
    Alert.alert(
      '恢复默认设置',
      '将把朋友权限、聊天设置、自动下载与更多设置全部恢复为默认值。此操作不影响你的账号与聊天记录。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '恢复默认',
          style: 'destructive',
          onPress: () => {
            resetSettings();
            haptic.success();
          },
        },
      ]
    );
  };

  return (
    <SettingsPage
      title="更多"
      footer="关怀模式与界面语言将在后续版本接入全局渲染，当前仅保存你的偏好。"
    >
      <GroupTitle>无障碍</GroupTitle>
      <Group>
        <SwitchRow
          title="关怀模式"
          desc="放大全局字号与行高，方便长辈使用"
          value={settings.careMode}
          onValueChange={(v) => updateSetting('careMode', v)}
          isFirst
          isLast
        />
      </Group>

      <GroupTitle>语言</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, { backgroundColor: colors.card }]}
          onPress={handlePickLanguage}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`界面语言，当前${currentLang}`}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>界面语言</Text>
          <View style={styles.right}>
            <Text style={[styles.value, { color: colors.textSecondary }]}>{currentLang}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </View>
        </TouchableOpacity>
      </Group>

      <GroupTitle>重置</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, { backgroundColor: colors.card }]}
          onPress={handleResetSettings}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="恢复默认设置"
        >
          <Text style={[styles.title, { color: colors.primary }]}>恢复默认设置</Text>
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
  right: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { fontSize: 15 },
});
// --- END OF FILE src/app/settings/more.js ---
