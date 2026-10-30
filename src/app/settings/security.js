// --- START OF FILE src/app/settings/security.js ---
import React, { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { DEVICE_DATA_PROTECTION_NOTES } from '../../constants/security';
import { haptic } from '../../constants/haptics';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import SettingsPage, { GroupTitle } from '../../components/settings/SettingsPage';

// 🔒 安全审计 #29：账号安全说明
const SECURITY_SECTIONS = [
  {
    title: '登录与会话安全',
    body: '账号使用邮箱 + 密码登录，密码要求至少 8 位且包含字母与数字。登录凭证由 Supabase Auth 托管，本地仅保存加密后的会话令牌。',
  },
  {
    title: '推送通知安全',
    body: '推送令牌仅存储在服务端，客户端无法读取他人令牌。所有推送请求必须携带有效登录凭证，并由服务端校验双方社交关系后才允许发送。',
  },
  {
    title: '数据清除',
    body: '如需清除本机缓存数据，可在「健康与打卡偏好」中重置今日打卡数据，或在「存储空间」中清理本地缓存；如需彻底删除云端全部数据，请使用本页底部的「注销账号」，该操作需二次确认且不可逆。',
  },
  {
    title: '注销账号',
    body: '注销将永久删除账号、聊天记录、媒体文件、健康数据与好友关系。为防误触，注销流程包含两次确认弹窗，确认后立即执行且无法撤销。',
  },
  // 🔒 安全审计 #26：设备敏感数据保护说明（文案源：src/constants/security.js）
  ...DEVICE_DATA_PROTECTION_NOTES,
];

// 🧹 P2-19：仅属于「当前用户」的本地存储 key 前缀（以 user.id 结尾）
const USER_SCOPED_KEY_PREFIXES = [
  'sync_chat_favorites_v1_', // 聊天收藏（useChatFavorites）
  'sync_chat_prefs_v1_',     // 会话级偏好：置顶/隐藏/免打扰/星标/拉黑/背景（useChatPrefs）
];

// 🚫 绝对不能删除的「全局 / 设备级」key（多账号共享或与账号无关）
const GLOBAL_KEY_PREFIXES = [
  '@app_known_accounts', // 本机多账号档案
  '@app_theme_mode',     // 全局主题
  '@app_settings',       // 全局偏好设置
  '@sync_device_id',     // 放映室设备 ID
  '@water', '@meals', '@maxWater', '@motto', '@mealGuides', // 健康数据
  '@streak', '@lastCheckIn', '@lastActive',
  '@browser_bookmarks', '@browser_history', // 浏览器书签/历史
];

// 🚫 按「对方 ID」而非「当前用户 ID」命名的聊天缓存：
//    这些 key 属于会话双方共享的本地缓存，删除会误伤其他账号的聊天记录
const PEER_SCOPED_KEY_PREFIXES = [
  '@chatMessages_',
  '@deletedMsgIds_',
];

const isGlobalKey = (key) => GLOBAL_KEY_PREFIXES.some((p) => key.startsWith(p));
const isPeerScopedKey = (key) => PEER_SCOPED_KEY_PREFIXES.some((p) => key.startsWith(p));

/**
 * 精准清理「当前用户」相关的本地状态，绝不误删全盘数据。
 *
 * 策略：
 *   1. 显式移除已知的用户级 key（收藏 / 会话偏好）
 *   2. 扫描全部 key，移除「包含当前 user.id」的 key（覆盖未来新增的用户级 key）
 *   3. 始终跳过全局 key 与按对方 ID 命名的聊天缓存，保证其他账号数据不受影响
 *
 * @param {string} userId 当前登录用户 ID（必须在 signOut 之前取得）
 */
const clearCurrentUserLocalState = async (userId) => {
  if (!userId) return;

  const keysToRemove = new Set();

  // ① 显式用户级 key
  USER_SCOPED_KEY_PREFIXES.forEach((prefix) => keysToRemove.add(`${prefix}${userId}`));

  // ② 扫描全部 key，过滤出包含当前 user.id 的 key
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    allKeys.forEach((key) => {
      if (!key.includes(userId)) return;
      if (isGlobalKey(key)) return;      // 全局 key 绝不删除
      if (isPeerScopedKey(key)) return;  // 对方维度的聊天缓存绝不删除
      keysToRemove.add(key);
    });
  } catch {
    // 扫描失败时仍保留 ① 中的显式 key，继续执行移除
  }

  if (keysToRemove.size === 0) return;
  await AsyncStorage.multiRemove([...keysToRemove]);
};

export default function SecurityScreen() {
  const { colors } = useAppTheme();
  const { signOut, user } = useAuth();
  const [isDeleting, setIsDeleting] = useState(false);

  // 🔒 安全审计 #9：真正的注销执行体（仅在二次确认通过后调用）
  const performAccountDeletion = async () => {
    haptic.heavy();
    setIsDeleting(true);

    // 必须在 signOut 之前捕获 user.id，否则会话清除后无法定位用户级 key
    const currentUserId = user?.id ?? null;

    const { error } = await supabase.rpc('delete_my_account');

    // 🔒 安全审计 #12：不再透传 error.message，避免泄露数据库函数/表结构
    if (error) {
      Alert.alert('注销失败', '注销失败，请稍后重试。');
      setIsDeleting(false);
      return;
    }

    // 🔒 P2-19：注销成功后仅清除「当前用户」的本地状态，
    //    不再使用 AsyncStorage.clear() 误删全盘数据（其他账号的聊天记录与全局偏好必须保留）
    try {
      await clearCurrentUserLocalState(currentUserId);
    } catch {
      // 清缓存失败不阻断注销流程
    }

    haptic.success();

    // 先结束会话（signOut 内部会抹除云端 expo_push_token），再强制跳转登录页
    try {
      await signOut();
    } catch {
      // 会话已失效时忽略
    }

    setIsDeleting(false);
    Alert.alert('账号已注销', '您在云端的所有数据已被彻底抹除。', [
      { text: '好的', onPress: () => router.replace('/auth') },
    ]);
  };

  // 🔒 安全审计 #9：二次确认 —— 第一次弹窗说明后果，第二次弹窗再次明确「不可逆」
  const handleDeleteAccount = () => {
    if (isDeleting) return;
    haptic.warning();
    Alert.alert(
      '永久注销账号',
      '您的账号、所有聊天记录、图片、健康数据及好友关系将被永久删除且无法恢复！\n\n您确定要进行此操作吗？',
      [
        { text: '手滑了', style: 'cancel' },
        {
          text: '继续',
          style: 'destructive',
          onPress: () => {
            // 第二次确认：明确警示不可逆，用户再次确认后才真正执行
            Alert.alert(
              '⚠️ 最后确认',
              '此操作不可逆，将永久删除所有聊天与打卡数据，且无法通过任何方式找回。\n\n确认永久注销？',
              [
                { text: '取消', style: 'cancel' },
                { text: '确认永久注销', style: 'destructive', onPress: performAccountDeletion },
              ]
            );
          },
        },
      ]
    );
  };

  return (
    <SettingsPage title="账号安全">
      <Text style={[styles.intro, { color: colors.textSecondary }]}>
        我们采用业界通行的安全措施保护你的账号与数据。以下说明帮助你了解账号安全机制与数据清除方式。
      </Text>

      {SECURITY_SECTIONS.map((section) => (
        <View
          key={section.title}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
        >
          <View style={styles.cardHeader}>
            <View style={[styles.dot, { backgroundColor: '#5E5CE6' }]} />
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{section.title}</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.textSecondary }]}>{section.body}</Text>
        </View>
      ))}

      {/* 🔒 危险操作区：注销账号（原「我的 → 注销账号」，现下沉到账号安全页） */}
      <GroupTitle>危险操作</GroupTitle>
      <TouchableOpacity
        style={[
          styles.dangerBtn,
          { backgroundColor: colors.card, borderColor: colors.cardBorder },
          isDeleting && styles.dangerBtnDisabled,
        ]}
        onPress={handleDeleteAccount}
        disabled={isDeleting}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel="注销账号"
        accessibilityHint="永久删除账号及全部云端数据，需二次确认"
      >
        {isDeleting ? (
          <ActivityIndicator size="small" color="#FF3B30" />
        ) : (
          <Text style={styles.dangerText}>注销账号</Text>
        )}
      </TouchableOpacity>
      <Text style={[styles.dangerHint, { color: colors.textSecondary }]}>
        注销后账号、聊天记录、媒体文件、健康数据与好友关系将被永久删除，无法恢复。
      </Text>

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        最后更新：2026 年 10 月{'\n'}如对本说明有任何疑问，可通过「个人资料」页面联系我们。
      </Text>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 13, lineHeight: 20, marginBottom: 16, paddingHorizontal: 4 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 8 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardBody: { fontSize: 13, lineHeight: 21 },
  dangerBtn: {
    minHeight: 52,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerBtnDisabled: { opacity: 0.5 },
  dangerText: { fontSize: 16, fontWeight: '600', color: '#FF3B30' },
  dangerHint: { fontSize: 12, lineHeight: 18, marginTop: 8, paddingHorizontal: 4 },
  footer: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 24, marginBottom: 40, paddingHorizontal: 8 },
});
// --- END OF FILE src/app/settings/security.js ---
