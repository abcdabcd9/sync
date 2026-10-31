// --- START OF FILE src/app/(tabs)/profile.js ---
import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, useWindowDimensions
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, useFocusEffect } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { SIZES, TYPOGRAPHY } from '../../constants/theme';
import { useAuth } from '../../hooks/useAuth';
import { useProfileCache } from '../../hooks/profile/useProfileCache';

export default function ProfileScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { width } = useWindowDimensions(); // 🍎 引入屏幕宽度检测

  // 👤 Cache-First：第 0 帧读本地缓存秒开，云端失败只降级、绝不清空
  const { profile, loading: loadingProfile, refresh } = useProfileCache(user);

  // 每次回到「我的」页时静默刷新云端（缓存已在第 0 帧渲染，不会闪白/转圈）
  useFocusEffect(
    React.useCallback(() => {
      refresh();
    }, [refresh])
  );

  const handleAuthAction = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!user) router.push('/auth'); else router.push('/account_info');
  };

  // 与其他设置入口保持一致的跳转方式：轻触感 + 统一 activeOpacity
  const handleOpenSettings = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/settings');
  };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          
          {/* 🍎 平板自适应核心：像 iPadOS 一样约束设置页面的最大宽度 */}
          <View style={[styles.contentWrapper, { maxWidth: width >= 768 ? 680 : '100%' }]}>
            
            <View style={styles.header}><Text style={[styles.largeTitle, { color: palette.textPrimary }]}>我的</Text></View>
            
            <TouchableOpacity style={[styles.profileCard, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1 }]} activeOpacity={0.7} onPress={handleAuthAction}>
              <View style={[styles.avatarPlaceholder, { backgroundColor: user ? palette.primary : palette.separator }]}>
                {loadingProfile ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={{ color: '#FFFFFF', fontSize: 24, fontWeight: '700' }}>
                    {profile ? (profile.nickname || profile.sync_id).substring(0, 2).toUpperCase() : <Ionicons name="person" size={32} color="#FFFFFF" />}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.profileName, { color: palette.textPrimary }]} numberOfLines={1}>{user ? (profile?.nickname || '加载中...') : '本地账户'}</Text>
                <Text style={[styles.profileSub, { color: palette.textSecondary }]}>{user ? `ID: ${profile?.sync_id || '加载中...'}` : '点击连接云端账号'}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={palette.textSecondary} style={{ marginRight: 8 }} />
            </TouchableOpacity>
            
            <View style={styles.section}>
              <View style={[styles.listContainer, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1 }]}>
                <TouchableOpacity style={styles.menuItem} onPress={handleOpenSettings} activeOpacity={0.6}>
                  <View style={styles.menuLeft}><View style={[styles.iconBox, { backgroundColor: palette.iconBackground }]}><Ionicons name="settings" size={16} color="#FFFFFF" /></View><Text style={[styles.menuTitle, { color: palette.textPrimary }]}>通用设置</Text></View>
                  <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            <View style={{ alignItems: 'center', marginTop: 40, marginBottom: 20 }}>
              <Text style={{ color: palette.textSecondary, fontSize: 12, fontWeight: '500', letterSpacing: 0.5 }}>Sync App v3.0</Text>
              <Text style={{ color: palette.textSecondary, fontSize: 12, fontWeight: '500', letterSpacing: 0.5 }}>© 2026 Sync Inc.</Text>
            </View>

          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 }, scroll: { paddingBottom: 140 }, 
  contentWrapper: { width: '100%', alignSelf: 'center' }, // 🍎 新增自适应包裹层
  header: { paddingHorizontal: SIZES.padding, paddingTop: 24, paddingBottom: 16 }, largeTitle: TYPOGRAPHY.largeTitle, profileCard: { flexDirection: 'row', alignItems: 'center', marginHorizontal: SIZES.padding, padding: 18, borderRadius: SIZES.radiusCard, marginBottom: 32 }, avatarPlaceholder: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginRight: 16 }, profileName: { fontSize: 22, fontWeight: '700', marginBottom: 4 }, profileSub: { fontSize: 13, fontWeight: '400' }, section: { paddingHorizontal: SIZES.padding }, listContainer: { borderRadius: SIZES.radiusList, overflow: 'hidden' }, menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: 16, minHeight: 52 }, menuLeft: { flexDirection: 'row', alignItems: 'center', gap: 14 }, iconBox: { width: 30, height: 30, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }, menuTitle: { fontSize: 17, fontWeight: '500' }
});
// --- END OF FILE src/app/(tabs)/profile.js ---s