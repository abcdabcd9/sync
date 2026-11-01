// --- START OF FILE src/components/browser/BrowserMenuModal.js ---
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Animated,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * 🗂️ 浏览器主菜单 Modal（阶段 4 抽离 / 阶段 5 拆分）
 *
 * 职责：
 *   - 顶部操作行：电脑版切换 / 收藏本页 / 刷新
 *   - 🛡️ 广告拦截开关行（含累计拦截计数）
 *   - 🏷️ 书签 / 🕘 历史 入口行（阶段 5 起跳转独立页，不再内嵌列表）
 *
 * ⚠️ 最高指令：
 *   - 本组件只负责「展示」，所有状态与业务回调由父组件注入
 */

export default function BrowserMenuModal({
  visible,
  onRequestClose,
  isDark,
  palette,
  // 动画
  menuAnim,
  // 桌面模式
  isDesktopMode,
  onToggleDesktopMode,
  // 收藏
  onSaveBookmark,
  // 刷新
  onReload,
  // 广告拦截
  isAdBlockEnabled,
  blockedAdCount,
  onToggleAdBlock,
  // 列表计数（仅用于展示）
  bookmarksList,
  historyList,
  // 独立页入口
  onOpenBookmarks,
  onOpenHistory,
}) {
  const overlayOpacity = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const menuTranslateY = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [400, 0] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onRequestClose}>
      <View style={styles.modalWrapper}>
        <Animated.View style={[styles.modalOverlay, { opacity: overlayOpacity }]} />
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onRequestClose} activeOpacity={1} />

        <Animated.View style={[styles.menuContainer, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', transform: [{ translateY: menuTranslateY }] }]}>
          <View style={styles.menuDragHandle} />
          <Text style={[styles.menuSectionTitle, { color: palette.textSecondary }]}>浏览器选项</Text>

          <View style={styles.menuActionRow}>
            <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={onToggleDesktopMode} activeOpacity={0.7}>
              <Ionicons name={isDesktopMode ? "phone-portrait" : "desktop"} size={24} color={palette.primary} />
              <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>{isDesktopMode ? '切回手机' : '电脑版'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={onSaveBookmark} activeOpacity={0.7}>
              <Ionicons name="bookmark" size={24} color={palette.success} />
              <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>收藏本页</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={onReload} activeOpacity={0.7}>
              <Ionicons name="refresh" size={24} color={palette.textSecondary} />
              <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>刷新</Text>
            </TouchableOpacity>
          </View>

          {/* 🛡️ 广告拦截开关 + 拦截计数 */}
          <TouchableOpacity
            style={[styles.adBlockRow, { backgroundColor: palette.background }]}
            onPress={onToggleAdBlock}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isAdBlockEnabled ? 'shield-checkmark' : 'shield-outline'}
              size={22}
              color={isAdBlockEnabled ? palette.success : palette.textSecondary}
            />
            <View style={styles.adBlockTextGroup}>
              <Text style={[styles.adBlockTitle, { color: palette.textPrimary }]}>广告拦截</Text>
              <Text style={[styles.adBlockSubtitle, { color: palette.textSecondary }]}>
                已拦截 {blockedAdCount} 个广告
              </Text>
            </View>
            <View
              style={[
                styles.adBlockSwitch,
                { backgroundColor: isAdBlockEnabled ? palette.success : palette.separator },
              ]}
            >
              <View
                style={[
                  styles.adBlockSwitchKnob,
                  { transform: [{ translateX: isAdBlockEnabled ? 18 : 0 }] },
                ]}
              />
            </View>
          </TouchableOpacity>

          {/* 🏷️ 书签 / 🕘 历史 入口行（跳转独立页） */}
          <View style={styles.entryGroup}>
            <TouchableOpacity
              style={[styles.entryRow, { backgroundColor: palette.background }]}
              onPress={onOpenBookmarks}
              activeOpacity={0.7}
            >
              <Ionicons name="bookmarks-outline" size={22} color={palette.primary} />
              <Text style={[styles.entryText, { color: palette.textPrimary }]}>书签</Text>
              <Text style={[styles.entryCount, { color: palette.textSecondary }]}>
                {bookmarksList.length}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.entryRow, { backgroundColor: palette.background }]}
              onPress={onOpenHistory}
              activeOpacity={0.7}
            >
              <Ionicons name="time-outline" size={22} color={palette.primary} />
              <Text style={[styles.entryText, { color: palette.textPrimary }]}>历史记录</Text>
              <Text style={[styles.entryCount, { color: palette.textSecondary }]}>
                {historyList.length}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
            </TouchableOpacity>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalWrapper: { flex: 1, justifyContent: 'flex-end' },
  // 🫧 弹窗效果整体减弱 20%（遮罩 0.1 → 0.08，阴影 0.1 → 0.08，elevation 20 → 16）
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.08)' },
  menuContainer: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 12, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 16 },
  menuDragHandle: { width: 40, height: 5, backgroundColor: 'rgba(150,150,150,0.3)', borderRadius: 3, alignSelf: 'center', marginBottom: 16 },
  menuSectionTitle: { fontSize: 13, fontWeight: '600', marginBottom: 12, marginLeft: 4 },
  menuActionRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  menuActionBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, borderRadius: 16 },
  menuActionText: { fontSize: 12, fontWeight: '500', marginTop: 8 },

  // 🛡️ 广告拦截开关行
  adBlockRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14 },
  adBlockTextGroup: { flex: 1, marginLeft: 10 },
  adBlockTitle: { fontSize: 14, fontWeight: '600' },
  adBlockSubtitle: { fontSize: 11, marginTop: 3 },
  adBlockSwitch: { width: 42, height: 24, borderRadius: 12, padding: 3, justifyContent: 'center' },
  adBlockSwitchKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF' },

  // 🏷️ 书签 / 🕘 历史 入口行
  entryGroup: { marginTop: 12, gap: 10 },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14 },
  entryText: { flex: 1, fontSize: 15, fontWeight: '500' },
  entryCount: { fontSize: 13, fontVariant: ['tabular-nums'] },
});
// --- END OF FILE src/components/browser/BrowserMenuModal.js ---
