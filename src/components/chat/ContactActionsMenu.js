// --- START OF FILE src/components/chat/ContactActionsMenu.js ---
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Platform } from 'react-native';

import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';

/**
 * 联系人操作菜单（聊天室 L2 与通讯录详细页 L3 共用）
 *
 * 视觉与聊天页右上角「+」小弹窗完全一致：圆角卡片 + 纯文字行 + 细分隔线，无图标。
 * 位置：默认贴右上角（与「+」同款），可通过 anchorTop 微调。
 *
 * 用法：
 *   <ContactActionsMenu
 *     visible={menuVisible}
 *     displayName={displayName}
 *     onClose={() => setMenuVisible(false)}
 *     onViewProfile={...}   // 查看详细资料
 *     onDeleteFriend={...}  // 删除好友（危险项，红色）
 *   />
 *
 * 说明：菜单本身不持有数据层逻辑，删除好友的确认弹窗与数据库操作由调用方注入，
 * 这样聊天室（需要返回上一页）与通讯录详细页（需要刷新列表）可以各自处理副作用。
 */
export default function ContactActionsMenu({
  visible,
  displayName,
  onClose,
  onViewProfile,
  onDeleteFriend,
  anchorTop,
}) {
  const { isDark, colors: palette } = useAppTheme();

  const handle = (fn) => {
    haptic.light();
    onClose?.();
    // 等菜单关闭动画起帧后再执行副作用，避免 Modal 与 Alert 抢焦点
    setTimeout(() => fn?.(), 60);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <View
          style={[
            styles.menu,
            {
              backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
              borderColor: palette.cardBorder,
              top: anchorTop ?? (Platform.OS === 'ios' ? 96 : 72),
            },
          ]}
        >
          <TouchableOpacity
            style={styles.item}
            onPress={() => handle(onViewProfile)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="查看详细资料"
          >
            <Text style={[styles.itemText, { color: palette.textPrimary }]}>查看详细资料</Text>
          </TouchableOpacity>

          <View style={[styles.line, { backgroundColor: palette.separator }]} />

          <TouchableOpacity
            style={styles.item}
            onPress={() => handle(onDeleteFriend)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={`删除好友${displayName ? ` ${displayName}` : ''}`}
          >
            <Text style={[styles.itemText, styles.itemTextDanger]}>删除好友</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'transparent' },
  menu: {
    position: 'absolute',
    right: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  item: { paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontSize: 16, fontWeight: '500', textAlign: 'center' },
  itemTextDanger: { color: '#FF3B30' },
  line: { height: StyleSheet.hairlineWidth },
});
// --- END OF FILE src/components/chat/ContactActionsMenu.js ---
