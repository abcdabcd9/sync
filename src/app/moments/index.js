// --- START OF FILE src/app/moments/index.js ---
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAppTheme } from '../../context/ThemeContext';
import SettingsPage from '../../components/settings/SettingsPage';

// params: 无
// 朋友圈：阶段 6 实现发布 / 时间线，当前为占位页
export default function MomentsScreen() {
  const { colors } = useAppTheme();

  return (
    <SettingsPage title="朋友圈">
      <View style={styles.empty}>
        <View style={[styles.iconBox, { backgroundColor: colors.primary }]}>
          <Ionicons name="sparkles" size={28} color="#FFFFFF" />
        </View>
        <Text style={[styles.title, { color: colors.textPrimary }]}>朋友圈即将上线</Text>
        <Text style={[styles.desc, { color: colors.textSecondary }]}>
          这里将展示好友动态与你的分享。发布内容前可单独设置可见范围，仅好友可见。
        </Text>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 24 },
  iconBox: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 17, fontWeight: '600', marginBottom: 8 },
  desc: { fontSize: 13, lineHeight: 21, textAlign: 'center' },
});
// --- END OF FILE src/app/moments/index.js ---
