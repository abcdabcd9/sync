// --- START OF FILE src/app/chat/friend_settings.js ---
import React, { useState } from 'react';
import { Alert, Share, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { haptic } from '../../constants/haptics';
import { useChatPrefs } from '../../hooks/chat/useChatPrefs';
import { useFriendActions } from '../../hooks/chat/useFriendActions';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

// params: id, nickname, username, sync_id, remark
// 朋友设置页（通讯录详细页右上角「3 个点」跳转目标）
// 功能：设置朋友资料 / 朋友权限 / 推荐给朋友 / 添加到桌面 / 设为星标好友 /
//       加入黑名单 / 投诉 / 删除好友
export default function FriendSettingsScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { id, nickname, username, sync_id, remark } = useLocalSearchParams();

  const prefs = useChatPrefs(user);
  const { deleteFriend, updateRemark } = useFriendActions(user);

  const displayName = remark || nickname || username || '未知用户';
  const displayId = sync_id || username || '暂无 ID';

  const [remarkEditing, setRemarkEditing] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState(remark || '');

  // ===== 1. 设置朋友资料（备注）=====
  const handleSaveRemark = async () => {
    const res = await updateRemark(id, remarkDraft.trim());
    if (res.ok) {
      haptic.success();
      setRemarkEditing(false);
      Alert.alert('已保存', '备注已更新。');
    } else {
      haptic.error();
      Alert.alert('保存失败', res.error || '请稍后重试。');
    }
  };

  // ===== 2. 朋友权限 → 独立页 =====
  const handlePermission = () => {
    haptic.light();
    router.push({
      pathname: '/chat/friend_permission',
      params: { id, nickname: nickname || '' },
    });
  };

  // ===== 3. 推荐给朋友 =====
  const handleRecommend = async () => {
    haptic.light();
    try {
      await Share.share({
        message: `推荐你添加 Sync 好友「${displayName}」，Sync ID：${displayId}`,
      });
    } catch {
      // 用户取消分享，无需提示
    }
  };

  // ===== 4. 添加到桌面（生成深链，可复制或分享到桌面快捷方式）=====
  const handleAddToHome = () => {
    haptic.light();
    // 生成可直达该好友会话的深链（scheme 由 app.json 的 scheme 决定）
    const deepLink = Linking.createURL('/chat_room', {
      queryParams: { targetId: id, targetName: displayName },
    });

    Alert.alert(
      '添加到桌面',
      `复制下面的专属链接，粘贴到系统「快捷指令 / 桌面快捷方式」中，即可一键直达与「${displayName}」的聊天。\n\n${deepLink}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '复制链接',
          onPress: async () => {
            try {
              await Clipboard.setStringAsync(deepLink);
              haptic.success();
              Alert.alert('已复制', '专属链接已复制到剪贴板。');
            } catch {
              haptic.error();
              Alert.alert('复制失败', '请手动长按上方链接复制。');
            }
          },
        },
        {
          text: '分享',
          onPress: async () => {
            try {
              await Share.share({ message: `一键和「${displayName}」聊天：${deepLink}` });
            } catch {
              // 用户取消分享
            }
          },
        },
      ]
    );
  };

  // ===== 6. 加入黑名单 =====
  const handleBlock = () => {
    haptic.warning();
    const blocked = prefs.isBlocked(id);
    Alert.alert(
      blocked ? '移出黑名单' : '加入黑名单',
      blocked
        ? `移出后，你将重新收到「${displayName}」的消息。`
        : `加入黑名单后，你将不再收到「${displayName}」的消息。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: blocked ? '移出' : '加入',
          style: blocked ? 'default' : 'destructive',
          onPress: () => {
            prefs.toggleBlock(id);
            haptic.success();
          },
        },
      ]
    );
  };

  // ===== 7. 投诉 → 独立页 =====
  const handleComplaint = () => {
    haptic.light();
    router.push({
      pathname: '/chat/complaint',
      params: { targetId: id, targetName: displayName, scope: 'friend' },
    });
  };

  // ===== 8. 删除好友 =====
  const handleDeleteFriend = () => {
    haptic.warning();
    Alert.alert(
      '删除好友',
      `确定要删除「${displayName}」吗？删除后聊天记录将不再显示，且需要重新添加才能继续聊天。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            const res = await deleteFriend(id);
            if (res.ok) {
              haptic.success();
              // 回到通讯录列表（跳过详细页）
              if (router.canGoBack()) router.back();
              else router.replace('/chat/contacts');
            } else {
              haptic.error();
              Alert.alert('删除失败', res.error || '请稍后重试。');
            }
          },
        },
      ]
    );
  };

  return (
    <SettingsPage title="朋友设置">
      {/* 1. 设置朋友资料 */}
      <GroupTitle>资料</GroupTitle>
      <Group>
        {remarkEditing ? (
          <View style={styles.editRow}>
            <TextInput
              style={[styles.input, { color: palette.textPrimary, borderColor: palette.cardBorder }]}
              value={remarkDraft}
              onChangeText={setRemarkDraft}
              placeholder="输入备注名"
              placeholderTextColor={palette.textSecondary}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSaveRemark}
            />
            <TouchableOpacity onPress={handleSaveRemark} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="保存备注">
              <Text style={[styles.saveText, { color: palette.primary }]}>保存</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              haptic.light();
              setRemarkDraft(remark || '');
              setRemarkEditing(true);
            }}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="设置朋友资料"
          >
            <Text style={[styles.title, { color: palette.textPrimary }]}>设置朋友资料</Text>
            <View style={styles.right}>
              <Text style={[styles.value, { color: palette.textSecondary }]} numberOfLines={1}>
                {remark || '未设置备注'}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
            </View>
          </TouchableOpacity>
        )}
      </Group>

      {/* 2. 朋友权限 */}
      <GroupTitle>权限</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={handlePermission}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="朋友权限"
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>朋友权限</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
      </Group>

      {/* 5. 设为星标好友（开关样式） */}
      <GroupTitle>星标</GroupTitle>
      <Group>
        <SwitchRow
          title="设为星标好友"
          desc="星标好友会排在通讯录最前"
          value={prefs.isStarred(id)}
          onValueChange={() => prefs.toggleStar(id)}
          isFirst
          isLast
        />
      </Group>

      {/* 3 + 4. 推荐给朋友 / 添加到桌面 */}
      <GroupTitle>分享</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={handleRecommend}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="把它推荐给朋友"
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>把它推荐给朋友</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
        <View style={[styles.divider, { backgroundColor: palette.separator }]} />
        <TouchableOpacity
          style={styles.row}
          onPress={handleAddToHome}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="添加到桌面"
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>添加到桌面</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
      </Group>

      {/* 6 + 7 + 8. 黑名单 / 投诉 / 删除好友 */}
      <GroupTitle>安全</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={handleBlock}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={prefs.isBlocked(id) ? '移出黑名单' : '加入黑名单'}
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>
            {prefs.isBlocked(id) ? '移出黑名单' : '加入黑名单'}
          </Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
        <View style={[styles.divider, { backgroundColor: palette.separator }]} />
        <TouchableOpacity
          style={styles.row}
          onPress={handleComplaint}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="投诉"
        >
          <Text style={[styles.title, { color: palette.textPrimary }]}>投诉</Text>
          <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
        </TouchableOpacity>
        <View style={[styles.divider, { backgroundColor: palette.separator }]} />
        <TouchableOpacity
          style={styles.row}
          onPress={handleDeleteFriend}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="删除好友"
        >
          <Text style={[styles.title, styles.danger]}>删除好友</Text>
        </TouchableOpacity>
      </Group>
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
    gap: 12,
  },
  title: { fontSize: 16, flex: 1 },
  danger: { color: '#FF3B30', fontWeight: '500' },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  value: { fontSize: 15, maxWidth: 180 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  input: {
    flex: 1,
    fontSize: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  saveText: { fontSize: 16, fontWeight: '600' },
});
// --- END OF FILE src/app/chat/friend_settings.js ---
