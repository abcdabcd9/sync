// --- START OF FILE src/app/settings/appearance.js ---
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// 🎨 主题模式切换（跟随系统 / 浅色 / 深色）
const THEME_OPTIONS = [
  { key: 'system', label: '跟随系统', desc: '随系统深浅色自动切换', icon: 'phone-portrait-outline' },
  { key: 'light', label: '浅色', desc: '始终使用浅色外观', icon: 'sunny-outline' },
  { key: 'dark', label: '深色', desc: '始终使用深色外观', icon: 'moon-outline' },
];

export default function AppearanceSettingsScreen() {
  const { colors, themeMode, setThemeMode } = useAppTheme();

  const handlePick = (key) => {
    if (key === themeMode) return;
    haptic.selection();
    setThemeMode(key);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <SettingsPage title="外观模式" footer="外观模式会立即生效，并保存在本机。">
      <GroupTitle>显示主题</GroupTitle>
      <Group>
        {THEME_OPTIONS.map((opt, index) => {
          const selected = opt.key === themeMode;
          const isLast = index === THEME_OPTIONS.length - 1;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.row,
                { backgroundColor: colors.card },
                !isLast && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.separator,
                },
              ]}
              onPress={() => handlePick(opt.key)}
              activeOpacity={0.6}
            >
              <View style={[styles.iconBox, { backgroundColor: colors.iconBackground }]}>
                <Ionicons name={opt.icon} size={16} color="#FFF" />
              </View>
              <View style={styles.textWrap}>
                <Text style={[styles.title, { color: colors.textPrimary }]}>{opt.label}</Text>
                <Text style={[styles.desc, { color: colors.textSecondary }]}>{opt.desc}</Text>
              </View>
              {selected && <Ionicons name="checkmark" size={20} color={colors.primary} />}
            </TouchableOpacity>
          );
        })}
      </Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  iconBox: { width: 28, height: 28, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  textWrap: { flex: 1 },
  title: { fontSize: 16, fontWeight: '400' },
  desc: { fontSize: 12, marginTop: 2 },
});
// --- END OF FILE src/app/settings/appearance.js ---
