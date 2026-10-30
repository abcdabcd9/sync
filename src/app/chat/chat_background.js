// --- START OF FILE src/app/chat/chat_background.js ---
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { haptic } from '../../constants/haptics';
import { useChatPrefs } from '../../hooks/chat/useChatPrefs';
import { CHAT_BACKGROUNDS } from '../../constants/settings';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: targetId, targetName
// 设置当前聊天背景（L3 独立页）
export default function ChatBackgroundScreen() {
  const { colors: palette } = useAppTheme();
  const { user } = useAuth();
  const { targetId } = useLocalSearchParams();

  const prefs = useChatPrefs(user);
  const currentKey = prefs.getBackground(targetId);

  const handlePick = (key) => {
    haptic.selection();
    prefs.setBackground(targetId, key);
    haptic.success();
  };

  return (
    <SettingsPage title="聊天背景">
      <GroupTitle>选择背景风格</GroupTitle>
      <Group>
        {CHAT_BACKGROUNDS.map((opt, index) => {
          const active = opt.key === currentKey;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.row,
                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
              ]}
              onPress={() => handlePick(opt.key)}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.label}
            >
              <Text style={[styles.title, { color: palette.textPrimary }]}>{opt.label}</Text>
              {active && <Ionicons name="checkmark" size={20} color={palette.primary} />}
            </TouchableOpacity>
          );
        })}
      </Group>
      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: palette.textSecondary }]}>
          背景仅对当前会话生效，可随时更换。
        </Text>
      </View>
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
  },
  title: { fontSize: 16, flex: 1 },
  footer: { paddingHorizontal: 16, paddingTop: 12 },
  footerText: { fontSize: 12, lineHeight: 18 },
});
// --- END OF FILE src/app/chat/chat_background.js ---
