// --- START OF FILE src/components/chat/ConversationRow.js ---
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAppTheme } from '../../context/ThemeContext';

/**
 * 会话行
 *
 * 视觉与原 src/app/(tabs)/chat.js 的 renderMessagesView 逐项对齐：
 *   46×46 圆角 10 头像 + 未读角标（静音时改为小红点）+ 昵称 + 预览 + 静音图标
 * 交互：点击进聊天室，长按弹菜单（由父组件处理）
 */
export default function ConversationRow({
  item,
  displayName,
  previewText,
  unreadNum = 0,
  isMuted = false,
  isSelected = false,
  onPress,
  onLongPress,
}) {
  const { isDark, colors: palette } = useAppTheme();

  return (
    <TouchableOpacity
      style={[styles.row, isSelected && { backgroundColor: isDark ? '#1C1C1E' : '#F2F2F7' }]}
      onPress={onPress}
      onLongPress={onLongPress}
      // 长按触发时间缩短 50%（RN 默认 500ms → 250ms）
      delayLongPress={250}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={`${displayName}${unreadNum > 0 ? `，${unreadNum} 条未读` : ''}`}
    >
      <View style={styles.avatarArea}>
        <View style={[styles.avatar, { backgroundColor: palette.primary }]}>
          <Text style={styles.avatarText}>{displayName.substring(0, 2).toUpperCase()}</Text>
          {unreadNum > 0 && !isMuted && (
            <View style={styles.badgeContainer}>
              <Text style={styles.badgeText}>{unreadNum > 99 ? '99+' : unreadNum}</Text>
            </View>
          )}
          {unreadNum > 0 && isMuted && <View style={styles.mutedBadgeContainer} />}
        </View>
      </View>

      <View
        style={[
          styles.contentArea,
          { borderBottomColor: isSelected ? 'transparent' : palette.separator },
        ]}
      >
        <View style={styles.textContainer}>
          <Text style={[styles.name, { color: palette.textPrimary }]} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={[styles.preview, { color: palette.textSecondary }]} numberOfLines={1}>
            {unreadNum > 0 ? `[${unreadNum}条] ${previewText}` : previewText}
          </Text>
        </View>
        <View style={styles.rightInfo}>
          {isMuted && <Ionicons name="notifications-off" size={14} color={palette.textSecondary} />}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  avatarArea: { paddingVertical: 12, paddingRight: 14, justifyContent: 'center' },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  avatarText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  contentArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 66,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // 🔒 安全审计 #18：minWidth: 0 + flexShrink 让超长昵称在 flex 布局中真正被压缩
  textContainer: { flex: 1, minWidth: 0, justifyContent: 'center' },
  name: { fontSize: 16, fontWeight: '500', marginBottom: 4, flexShrink: 1 },
  preview: { fontSize: 13, flexShrink: 1 },
  rightInfo: { alignItems: 'flex-end', marginLeft: 8, flexShrink: 0 },
  badgeContainer: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#FF3B30',
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: 'bold' },
  mutedBadgeContainer: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: '#FF3B30',
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
});
// --- END OF FILE src/components/chat/ConversationRow.js ---
