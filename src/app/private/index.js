// --- START OF FILE src/app/private/index.js ---
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAppTheme } from '../../context/ThemeContext';
import SettingsPage from '../../components/settings/SettingsPage';

// params: 无
// 私密空间：阶段 6 实现相册 / 笔记，当前为占位页
export default function PrivateSpaceScreen() {
  const { colors } = useAppTheme();

  return (
    <SettingsPage title="私密空间">
      <View style={styles.empty}>
        <View style={[styles.iconBox, { backgroundColor: colors.iconBackground }]}>
          <Ionicons name="lock-closed" size={28} color="#FFFFFF" />
        </View>
        <Text style={[styles.title, { color: colors.textPrimary }]}>私密空间即将上线</Text>
        <Text style={[styles.desc, { color: colors.textSecondary }]}>
          这里将存放只属于你的相册与笔记，内容仅本机可见，不会同步给任何好友。
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
// --- END OF FILE src/app/private/index.js ---
