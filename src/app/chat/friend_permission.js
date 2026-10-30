// --- START OF FILE src/app/chat/friend_permission.js ---
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: id, nickname
// 朋友权限（L3 独立页）
const PERMISSIONS = [
  {
    key: 'all',
    label: '聊天、朋友圈、微信运动等',
    desc: '对方可以看到你的朋友圈与运动数据',
  },
  {
    key: 'chat',
    label: '仅聊天',
    desc: '对方只能与你聊天，看不到朋友圈与运动数据',
  },
];

export default function FriendPermissionScreen() {
  const { colors: palette } = useAppTheme();
  const { nickname } = useLocalSearchParams();

  // 本地选择（权限字段尚未落到数据库，先做交互闭环）
  const [selected, setSelected] = useState('all');

  const handlePick = (key) => {
    haptic.selection();
    setSelected(key);
    haptic.success();
  };

  return (
    <SettingsPage title="朋友权限">
      <GroupTitle>{nickname ? `对「${nickname}」的权限` : '权限范围'}</GroupTitle>
      <Group>
        {PERMISSIONS.map((opt, index) => {
          const active = opt.key === selected;
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
              <View style={styles.textCol}>
                <Text style={[styles.title, { color: palette.textPrimary }]}>{opt.label}</Text>
                <Text style={[styles.desc, { color: palette.textSecondary }]}>{opt.desc}</Text>
              </View>
              {active && <Ionicons name="checkmark" size={20} color={palette.primary} />}
            </TouchableOpacity>
          );
        })}
      </Group>
      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: palette.textSecondary }]}>
          修改权限不会通知对方。
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
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  textCol: { flex: 1 },
  title: { fontSize: 16 },
  desc: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  footer: { paddingHorizontal: 16, paddingTop: 12 },
  footerText: { fontSize: 12, lineHeight: 18 },
});
// --- END OF FILE src/app/chat/friend_permission.js ---
