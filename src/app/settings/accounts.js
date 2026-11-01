// --- START OF FILE src/app/settings/accounts.js ---
import React, { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { useAccountSwitcher } from '../../hooks/useAccountSwitcher';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

/**
 * 🔀 切换账号（本地多 profile 快速切换）
 *
 * 行为说明：
 *   - 列出本机登录过的账号档案（最多 5 个），当前账号高亮并标「当前」
 *   - 点击其他账号 → 二次确认 → signOut 当前账号 → 跳 /auth
 *   - 长按 / 右侧按钮 → 从本机档案移除（不影响云端账号）
 *
 * 为什么切换要重新登录：
 *   Supabase 会话在 AsyncStorage 里是单例，无法同时持有多个活跃 session。
 *   所以「切换」= 登出 + 跳登录页，用户需重新输入邮箱与密码。
 *
 * 🔒 L-4：本机档案不再保存明文邮箱，只保留掩码（emailMasked）用于展示。
 *   因此切换时**不再预填邮箱**——安全优先，避免明文 PII 落盘与回填。
 */

function formatLastUsed(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚使用';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前使用`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前使用`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前使用`;
  return '很久以前使用';
}

// 🔒 L-4：档案中已无明文 email，展示统一回退到 emailMasked
function displayNameOf(account) {
  return account.nickname || account.syncId || account.emailMasked || '未命名账号';
}

function initialOf(account) {
  const source = account.nickname || account.syncId || account.emailMasked || '?';
  return source.substring(0, 2).toUpperCase();
}

export default function AccountsSettingsScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { accounts, isLoading, forgetAccount } = useAccountSwitcher();

  const [switchingId, setSwitchingId] = useState(null);

  const handleSwitch = (account) => {
    if (switchingId) return;
    if (account.id === user?.id) {
      haptic.light();
      Alert.alert('当前账号', '这已经是当前登录的账号了。');
      return;
    }

    haptic.medium();
    Alert.alert(
      '切换账号',
      `将退出当前账号，并切换到「${displayNameOf(account)}」。\n\n出于安全考虑，需要重新输入该账号的邮箱与密码。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '继续切换',
          onPress: async () => {
            setSwitchingId(account.id);
            try {
              await signOut();
              haptic.success();
              // 🔒 L-4：不再携带明文邮箱参数，用户自行输入
              router.replace('/auth');
            } catch (e) {
              console.warn('⚠️ 切换账号失败:', e?.message ?? e);
              haptic.error();
              Alert.alert('切换失败', '退出当前账号时出错，请稍后重试。');
            } finally {
              setSwitchingId(null);
            }
          },
        },
      ]
    );
  };

  const handleForget = (account) => {
    haptic.warning();
    Alert.alert(
      '从本机移除',
      `将从本机账号列表中移除「${displayNameOf(account)}」。\n\n这不会删除云端账号，你仍可以用邮箱密码重新登录。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '移除',
          style: 'destructive',
          onPress: async () => {
            await forgetAccount(account.id);
            haptic.success();
          },
        },
      ]
    );
  };

  const handleAddAccount = () => {
    haptic.light();
    Alert.alert(
      '添加账号',
      '将退出当前账号并前往登录页，登录成功后新账号会自动加入本机列表。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '去登录',
          onPress: async () => {
            try {
              await signOut();
              router.replace('/auth');
            } catch (e) {
              console.warn('⚠️ 前往登录失败:', e?.message ?? e);
              Alert.alert('操作失败', '请稍后重试。');
            }
          },
        },
      ]
    );
  };

  const renderAccountRow = (account, index, total) => {
    const isCurrent = account.id === user?.id;
    const isBusy = switchingId === account.id;
    const isFirst = index === 0;
    const isLast = index === total - 1;

    return (
      <View
        key={account.id}
        style={[
          styles.row,
          { backgroundColor: colors.card },
          !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
          isFirst && styles.rowFirst,
          isLast && styles.rowLast,
        ]}
      >
        <TouchableOpacity
          style={styles.rowMain}
          onPress={() => handleSwitch(account)}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`切换到 ${displayNameOf(account)}`}
        >
          <View style={[styles.avatar, { backgroundColor: account.avatarColor }]}>
            {isBusy ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Text style={styles.avatarText}>{initialOf(account)}</Text>
            )}
          </View>

          <View style={styles.rowBody}>
            <View style={styles.nameLine}>
              <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
                {account.nickname || account.syncId || '未命名账号'}
              </Text>
              {isCurrent ? (
                <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                  <Text style={styles.badgeText}>当前</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.sub, { color: colors.textSecondary }]} numberOfLines={1}>
              {account.syncId ? `ID: ${account.syncId}` : account.emailMasked || '—'}
            </Text>
            {formatLastUsed(account.lastUsedAt) ? (
              <Text style={[styles.meta, { color: colors.textSecondary }]}>
                {formatLastUsed(account.lastUsedAt)}
              </Text>
            ) : null}
          </View>

          {isCurrent ? (
            <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
          ) : (
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          )}
        </TouchableOpacity>

        {!isCurrent ? (
          <TouchableOpacity
            style={styles.removeBtn}
            onPress={() => handleForget(account)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={`从本机移除 ${displayNameOf(account)}`}
          >
            <Ionicons name="close-circle-outline" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>
    );
  };

  return (
    <SettingsPage
      title="切换账号"
      footer="本机最多保留 5 个账号档案，仅保存昵称、ID 与脱敏邮箱（如 al***@gmail.com），不保存明文邮箱、密码或登录凭证。移除档案不会删除云端账号。"
    >
      <GroupTitle>本机账号</GroupTitle>

      {isLoading ? (
        <Group>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textSecondary }]}>正在读取本机账号…</Text>
          </View>
        </Group>
      ) : accounts.length === 0 ? (
        <Group>
          <View style={styles.emptyBox}>
            <Ionicons name="people-outline" size={32} color={colors.textSecondary} />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>还没有其他账号</Text>
            <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>
              登录过的账号会自动出现在这里，方便下次快速切换。
            </Text>
          </View>
        </Group>
      ) : (
        <Group>{accounts.map((account, index) => renderAccountRow(account, index, accounts.length))}</Group>
      )}

      <GroupTitle>添加</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, styles.addRow, { backgroundColor: colors.card }]}
          onPress={handleAddAccount}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="添加账号"
        >
          <View style={[styles.avatar, { backgroundColor: colors.iconBackground }]}>
            <Ionicons name="add" size={22} color="#FFFFFF" />
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.name, { color: colors.primary }]}>添加账号</Text>
            <Text style={[styles.sub, { color: colors.textSecondary }]}>
              退出当前账号并前往登录页
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingRight: 12,
  },
  rowFirst: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  rowLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 8,
    gap: 12,
  },
  rowBody: { flex: 1, gap: 2 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
  sub: { fontSize: 13 },
  meta: { fontSize: 11, opacity: 0.7 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '600' },
  removeBtn: { padding: 8 },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 64,
    paddingHorizontal: 16,
  },
  loadingText: { fontSize: 14 },
  emptyBox: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600' },
  emptyDesc: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  addRow: { paddingLeft: 16, paddingVertical: 12, gap: 12 },
});
// --- END OF FILE src/app/settings/accounts.js ---
