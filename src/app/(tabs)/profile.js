// --- START OF FILE src/app/(tabs)/profile.js ---
import React, { useState } from 'react';
import { 
  View, Text, StyleSheet, TouchableOpacity, useColorScheme, 
  ScrollView, Alert, ActivityIndicator, useWindowDimensions
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, useFocusEffect } from 'expo-router';

import { getPalette } from '../../constants/colors';
import { SIZES, TYPOGRAPHY } from '../../constants/theme'; 
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';

export default function ProfileScreen() {
  const palette = getPalette(useColorScheme() === 'dark');
  const router = useRouter(); 
  const { user, signOut } = useAuth();
  const { width } = useWindowDimensions(); // 🍎 引入屏幕宽度检测

  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);

  useFocusEffect(
    React.useCallback(() => {
      let isMounted = true;
      const fetchProfileData = async () => {
        if (!user) { if (isMounted) setProfile(null); return; }
        setLoadingProfile(true);
        const { data: myProfile, error } = await supabase.from('profiles').select('id, username, sync_id, nickname').eq('id', user.id).single();
        if (!error && myProfile && isMounted) {
          setProfile({
            ...myProfile,
            sync_id: myProfile.sync_id || myProfile.username,
            nickname: myProfile.nickname || myProfile.username,
          });
        }
        if (isMounted) setLoadingProfile(false);
      };
      fetchProfileData();
      return () => { isMounted = false; };
    }, [user])
  );

  const handleAuthAction = () => { 
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); 
    if (!user) router.push('/auth'); else router.push('/account_info'); 
  };

  const handleSignOut = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('退出登录', '确定要断开云端连接吗？', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: async () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); await signOut(); }}
    ]);
  };

  const handleDeleteAccount = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      '永久注销账号', 
      '您的账号、所有聊天记录、图片、健康数据及好友关系将被永久删除且无法恢复！\n\n您确定要进行此操作吗？', 
      [
        { text: '手滑了', style: 'cancel' },
        { text: '确认粉碎', style: 'destructive', onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            setLoadingProfile(true);
            const { error } = await supabase.rpc('delete_my_account');
            if (error) { Alert.alert('注销失败', error.message); setLoadingProfile(false); } 
            else { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); Alert.alert('账号已注销', '您在云端的所有数据已被彻底抹除。'); await signOut(); }
          }
        }
      ]
    );
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
                <TouchableOpacity style={styles.menuItem} onPress={() => router.push('/settings')} activeOpacity={0.6}>
                  <View style={styles.menuLeft}><View style={[styles.iconBox, { backgroundColor: palette.iconBackground }]}><Ionicons name="settings" size={16} color="#FFFFFF" /></View><Text style={[styles.menuTitle, { color: palette.textPrimary }]}>通用设置</Text></View>
                  <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
                </TouchableOpacity>
              </View>

              {user && (
                <View style={[styles.listContainer, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1, marginTop: 24 }]}>
                  <TouchableOpacity style={[styles.menuItem, { borderBottomColor: palette.separator, borderBottomWidth: StyleSheet.hairlineWidth }]} onPress={handleSignOut} activeOpacity={0.6}>
                    <View style={styles.menuLeft}><View style={[styles.iconBox, { backgroundColor: '#FF9F0A' }]}><Ionicons name="log-out" size={18} color="#FFFFFF" style={{ marginLeft: 2 }} /></View><Text style={[styles.menuTitle, { color: '#FF9F0A' }]}>退出登录</Text></View>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.menuItem} onPress={handleDeleteAccount} activeOpacity={0.6}>
                    <View style={styles.menuLeft}><View style={[styles.iconBox, { backgroundColor: '#FF3B30' }]}><Ionicons name="trash" size={18} color="#FFFFFF" /></View><Text style={[styles.menuTitle, { color: '#FF3B30' }]}>注销账号</Text></View>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            <View style={{ alignItems: 'center', marginTop: 40, marginBottom: 20 }}>
              <Text style={{ color: palette.textSecondary, fontSize: 12, fontWeight: '500', letterSpacing: 0.5 }}>Sync App v2.1</Text>
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