// --- START OF FILE src/app/settings/privacy.js ---
import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import { useAppSettings } from '../../hooks/useAppSettings';
import { MOMENTS_VISIBILITY, labelOf } from '../../constants/settings';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

// 朋友权限：朋友圈可见范围 + 加好友 + 被搜索
export default function PrivacySettingsScreen() {
  const { colors } = useAppTheme();
  const { settings, updateSetting } = useAppSettings();

  const currentVisibility = labelOf(MOMENTS_VISIBILITY, settings.momentsVisibility, '仅好友');

  const handlePickVisibility = () => {
    haptic.light();
    Alert.alert(
      '朋友圈可见范围',
      '选择谁可以看到你发布的朋友圈',
      [
        ...MOMENTS_VISIBILITY.map((opt) => ({
          text: opt.label + (opt.key === settings.momentsVisibility ? '  ✓' : ''),
          onPress: () => {
            updateSetting('momentsVisibility', opt.key);
            haptic.success();
          },
        })),
        { text: '取消', style: 'cancel' },
      ]
    );
  };

  return (
    <SettingsPage
      title="朋友权限"
      footer="这些设置只影响新朋友与朋友圈的可见性，不会改变已有的好友关系。"
    >
      <GroupTitle>朋友圈</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, { backgroundColor: colors.card }]}
          onPress={handlePickVisibility}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`朋友圈可见范围，当前${currentVisibility}`}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>谁可以看我的朋友圈</Text>
          <View style={styles.right}>
            <Text style={[styles.value, { color: colors.textSecondary }]}>{currentVisibility}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </View>
        </TouchableOpacity>
      </Group>

      <GroupTitle>添加方式</GroupTitle>
      <Group>
        <SwitchRow
          title="允许他人加我为好友"
          desc="关闭后，别人无法向你发送好友请求"
          value={settings.allowFriendRequest}
          onValueChange={(v) => updateSetting('allowFriendRequest', v)}
          isFirst
        />
        <SwitchRow
          title="允许通过 Sync ID 搜索到我"
          desc="关闭后，你只能被已有好友看到"
          value={settings.allowSearch}
          onValueChange={(v) => updateSetting('allowSearch', v)}
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
// --- END OF FILE src/app/settings/privacy.js ---
