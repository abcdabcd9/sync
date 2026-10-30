// --- START OF FILE src/app/contact_profile.js ---
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { useAppTheme } from '../context/ThemeContext';
import { haptic } from '../constants/haptics';

export default function ContactProfileScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();

  const { id, nickname, sync_id, username, remark } = useLocalSearchParams();

  const displayName = remark || nickname || username || '未知用户';
  const displayId = sync_id || username || '暂无 ID';

  const handleBack = () => {
    haptic.light();
    router.back();
  };

  // 右上角「3 个点」：直接跳转朋友设置页（不再弹窗）
  const handleOpenFriendSettings = () => {
    if (!id) return;
    haptic.light();
    router.push({
      pathname: '/chat/friend_settings',
      params: {
        id,
        nickname: nickname || '',
        username: username || '',
        sync_id: sync_id || '',
        remark: remark || '',
      },
    });
  };

  const handleSendMessage = () => {
    haptic.medium();
    router.push({ pathname: '/chat_room', params: { targetId: id, targetName: displayName } });
  };

  const handleCall = () => {
    haptic.warning();
    Alert.alert(
      '音视频通话',
      '加密音视频通话功能即将开放，敬请期待！\n\n当前可先通过「发消息」与好友保持联系。'
    );
  };

  // 好友动态：进入 TA 的动态列表（L3 页）
  const handleOpenMoments = () => {
    if (!id) return;
    haptic.light();
    router.push({ pathname: '/chat/moments', params: { id, nickname: displayName } });
  };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        
        <View style={styles.navBar}>
          <TouchableOpacity onPress={handleBack} style={styles.backBtn} activeOpacity={0.6}>
            <Ionicons name="chevron-back" size={28} color={palette.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleOpenFriendSettings}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="朋友设置"
            accessibilityHint="打开朋友设置页面"
          >
            <Ionicons name="ellipsis-horizontal" size={24} color={palette.textPrimary} style={{ marginRight: 16 }} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false}>
          
          {/* 🍎 极简居中排版的个人资料 */}
          <View style={styles.profileHeader}>
            <View style={[styles.avatar, { backgroundColor: palette.primary }]}>
              <Text style={styles.avatarText}>{displayName.substring(0, 2).toUpperCase()}</Text>
            </View>
            <Text style={[styles.nameText, { color: palette.textPrimary }]} numberOfLines={1}>{displayName}</Text>
            <Text style={[styles.idText, { color: palette.textSecondary }]}>ID: {displayId}</Text>
            {remark && <Text style={[styles.subText, { color: palette.textSecondary }]}>昵称: {nickname || username}</Text>}
          </View>

          <TouchableOpacity
            style={[styles.momentsEntry, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}
            onPress={handleOpenMoments}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="查看好友动态"
            accessibilityHint="打开 TA 的动态列表"
          >
            <View style={[styles.momentsIconBox, { backgroundColor: palette.iconBackground }]}>
              <Ionicons name="images-outline" size={22} color={palette.primary} />
            </View>
            <View style={styles.momentsTextCol}>
              <Text style={[styles.momentsTitle, { color: palette.textPrimary }]}>好友动态</Text>
              <Text style={[styles.momentsSub, { color: palette.textSecondary }]} numberOfLines={1}>
                查看 {displayName} 发布的动态
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
          </TouchableOpacity>
          
        </ScrollView>

        {/* 🍎 修复：去除傻大黑粗的设定，采用极其收敛的高级上下层级结构 */}
        <View style={styles.actionContainer}>
          <TouchableOpacity style={[styles.actionBtnPrimary, { backgroundColor: palette.primary }]} onPress={handleSendMessage} activeOpacity={0.8}>
            <Ionicons name="chatbubble" size={18} color="#FFFFFF" />
            <Text style={[styles.actionTextPrimary, { color: '#FFFFFF' }]}>发消息</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={[styles.actionBtnSecondary, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1 }]} onPress={handleCall} activeOpacity={0.7}>
            <Ionicons name="videocam-outline" size={20} color={palette.textPrimary} />
            <Text style={[styles.actionTextSecondary, { color: palette.textPrimary }]}>音视频通话</Text>
          </TouchableOpacity>
        </View>

      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
  backBtn: { padding: 4 },
  
  // 🍎 头部布局改为完全居中
  profileHeader: { alignItems: 'center', paddingTop: 20, paddingBottom: 40 },
  avatar: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  avatarText: { color: '#FFF', fontSize: 26, fontWeight: 'bold' },
  nameText: { fontSize: 22, fontWeight: '700', marginBottom: 6, paddingHorizontal: 20, textAlign: 'center' },
  idText: { fontSize: 13, fontWeight: '500', marginBottom: 4, letterSpacing: 0.5 },
  subText: { fontSize: 12, fontWeight: '400' },
  
  momentsEntry: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginBottom: 24, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  momentsIconBox: { width: 38, height: 38, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  momentsTextCol: { flex: 1 },
  momentsTitle: { fontSize: 15, fontWeight: '600', marginBottom: 2 },
  momentsSub: { fontSize: 12 },
  
  // 🍎 优雅的上下分级按钮布局
  actionContainer: { paddingHorizontal: 32, paddingBottom: Platform.OS === 'ios' ? 24 : 32, gap: 14 },
  actionBtnPrimary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 8 },
  actionTextPrimary: { fontSize: 16, fontWeight: '600', marginLeft: 8 },
  actionBtnSecondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 24 },
  actionTextSecondary: { fontSize: 15, fontWeight: '500', marginLeft: 8 },
});
// --- END OF FILE src/app/contact_profile.js ---
