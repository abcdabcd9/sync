// --- START OF FILE src/app/settings.js ---
import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Keyboard, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';

import { SIZES } from '../constants/theme';
import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';

// --- 原生风格的设置项组件 ---
const SettingRow = ({ title, value, icon, iconBg, onPress, isDestructive, hideArrow, isFirst, isLast, palette }) => (
  <TouchableOpacity 
    style={[
      styles.settingRow, 
      { backgroundColor: palette.card },
      !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.separator },
      isFirst && { borderTopLeftRadius: SIZES.radiusList, borderTopRightRadius: SIZES.radiusList },
      isLast && { borderBottomLeftRadius: SIZES.radiusList, borderBottomRightRadius: SIZES.radiusList }
    ]} 
    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onPress?.(); }}
    activeOpacity={0.6}
  >
    <View style={styles.rowLeft}>
      {icon && (
        <View style={[styles.rowIconBox, { backgroundColor: iconBg || palette.primary }]}>
          <Ionicons name={icon} size={16} color="#FFF" />
        </View>
      )}
      <Text style={[styles.rowTitle, { color: isDestructive ? '#FF3B30' : palette.textPrimary }]}>{title}</Text>
    </View>
    <View style={styles.rowRight}>
      {value && <Text style={[styles.rowValue, { color: palette.textSecondary }]}>{value}</Text>}
      {!hideArrow && !isDestructive && <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} style={{ marginLeft: 6 }} />}
    </View>
  </TouchableOpacity>
);

export default function SettingsScreen() {
  const { colors: palette, themeMode } = useAppTheme();
  const router = useRouter();
  const { signOut } = useAuth();

  const isGoingBack = useRef(false);

  const handleBack = () => {
    if (isGoingBack.current) return;
    isGoingBack.current = true;
    Keyboard.dismiss(); 
    if (router.canGoBack()) router.back(); else router.replace('/profile');
    setTimeout(() => { isGoingBack.current = false; }, 500);
  };

  const handleSignOut = () => {
    Alert.alert('退出登录', '确定要断开云端连接吗？', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: async () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); await signOut(); router.replace('/auth'); }}
    ]);
  };

  // 🎨 主题模式标签（仅用于「外观模式」行的右侧值展示）
  const THEME_OPTIONS = [
    { key: 'system', label: '跟随系统' },
    { key: 'light', label: '浅色' },
    { key: 'dark', label: '深色' },
  ];
  const currentThemeLabel = THEME_OPTIONS.find(o => o.key === themeMode)?.label || '跟随系统';

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.navBar}>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack} activeOpacity={0.6}>
            <Ionicons name="chevron-back" size={28} color={palette.primary} />
            <Text style={[styles.backText, { color: palette.primary }]}>返回</Text>
          </TouchableOpacity>
          <Text style={[styles.navTitle, { color: palette.textPrimary }]}>设置</Text>
          <View style={styles.rightPlaceholder} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          
          {/* 1. 账号栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary }]}>账号与安全</Text>
          <View style={styles.group}>
            <SettingRow title="个人资料" icon="person" iconBg="#0A84FF" onPress={() => router.push('/account_info')} isFirst palette={palette} />
            {/* 🔒 安全审计 #29：隐私政策与数据使用说明（L3 页面） */}
            <SettingRow title="个人信息与权限" icon="shield-checkmark" iconBg="#34C759" onPress={() => router.push('/settings/privacy-policy')} palette={palette} />
            {/* 🔒 安全审计 #29：账号安全与数据清除说明（L3 页面） */}
            <SettingRow title="账号安全" icon="lock-closed" iconBg="#5E5CE6" onPress={() => router.push('/settings/security')} isLast palette={palette} />
          </View>

          {/* 2. 通用栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>通用</Text>
          <View style={styles.group}>
            <SettingRow title="通知" icon="notifications" iconBg="#FF3B30" onPress={() => router.push('/settings/notifications')} isFirst palette={palette} />
            <SettingRow title="外观模式" icon="color-palette" iconBg="#FF9F0A" value={currentThemeLabel} onPress={() => router.push('/settings/appearance')} palette={palette} />
            <SettingRow title="朋友权限" icon="people" iconBg="#32ADE6" onPress={() => router.push('/settings/privacy')} palette={palette} />
            <SettingRow title="存储空间" icon="server" iconBg="#8E8E93" onPress={() => router.push('/settings/storage')} palette={palette} />
            <SettingRow title="更多" icon="ellipsis-horizontal" iconBg="#BF5AF2" onPress={() => router.push('/settings/more')} isLast palette={palette} />
          </View>

          {/* 3. 功能栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>功能</Text>
          <View style={styles.group}>
            <SettingRow title="聊天设置" icon="chatbubbles" iconBg="#34C759" onPress={() => router.push('/settings/chat')} isFirst palette={palette} />
            <SettingRow title="健康与打卡偏好" icon="fitness" iconBg="#FF2D55" onPress={() => router.push('/settings/health')} palette={palette} />
            <SettingRow title="自动下载设置" icon="cloud-download" iconBg="#0A84FF" onPress={() => router.push('/settings/download')} isLast palette={palette} />
          </View>

          {/* 4. 底部操作栏（注销账号已下沉到「账号安全」页） */}
          <View style={[styles.group, { marginTop: 36, marginBottom: 40 }]}>
            <SettingRow title="切换账号" onPress={() => router.push('/settings/accounts')} isFirst palette={palette} />
            <SettingRow title="退出登录" hideArrow isDestructive onPress={handleSignOut} isLast palette={palette} />
          </View>

        </ScrollView>
      </SafeAreaView>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44, paddingHorizontal: 8 },
  backBtn: { flexDirection: 'row', alignItems: 'center', width: 80 }, backText: { fontSize: 17, marginLeft: -4 },
  navTitle: { fontSize: 17, fontWeight: '600' }, rightPlaceholder: { width: 80 },
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 60 }, 
  sectionTitle: { fontSize: 13, fontWeight: '400', textTransform: 'uppercase', marginBottom: 8, marginLeft: 16 },
  group: { borderRadius: SIZES.radiusList, overflow: 'hidden' },
  
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, minHeight: 52 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowIconBox: { width: 28, height: 28, borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  rowTitle: { fontSize: 16, fontWeight: '400' },
  rowRight: { flexDirection: 'row', alignItems: 'center' },
  rowValue: { fontSize: 15 },
});
// --- END OF FILE src/app/settings.js ---