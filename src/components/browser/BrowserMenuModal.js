// --- START OF FILE src/components/browser/BrowserMenuModal.js ---
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  Animated,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ellipsisMiddle, formatHistoryTime } from '../../constants/browser';

/**
 * 🗂️ 浏览器主菜单 Modal（阶段 4 抽离）
 *
 * 职责：
 *   - 顶部操作行：电脑版切换 / 收藏本页 / 刷新
 *   - 🛡️ 广告拦截开关行（含累计拦截计数）
 *   - 🏷️ 书签 / 🕘 历史 双 Tab 列表
 *
 * ⚠️ 最高指令：
 *   - 样式、动画参数、Haptics 交互与原内联实现 100% 一致
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
  // Tab
  menuTab,
  onMenuTabChange,
  // 书签
  bookmarksList,
  onLoadBookmark,
  onDeleteBookmark,
  // 历史
  historyList,
  onLoadHistory,
  onDeleteHistory,
  onClearHistory,
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

          {/* 🏷️ 书签 / 历史 双 Tab */}
          <View style={[styles.menuTabBar, { backgroundColor: palette.background }]}>
            <TouchableOpacity
              style={[styles.menuTabBtn, menuTab === 'bookmark' && { backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }]}
              onPress={() => onMenuTabChange('bookmark')}
              activeOpacity={0.8}
            >
              <Text style={[styles.menuTabText, { color: menuTab === 'bookmark' ? palette.primary : palette.textSecondary }]}>
                影院书签 ({bookmarksList.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuTabBtn, menuTab === 'history' && { backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }]}
              onPress={() => onMenuTabChange('history')}
              activeOpacity={0.8}
            >
              <Text style={[styles.menuTabText, { color: menuTab === 'history' ? palette.primary : palette.textSecondary }]}>
                历史记录 ({historyList.length})
              </Text>
            </TouchableOpacity>
          </View>

          {menuTab === 'bookmark' ? (
            <FlatList
              data={bookmarksList}
              keyExtractor={(item) => item}
              style={styles.bookmarkList}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <Text style={[styles.listEmptyText, { color: palette.textSecondary }]}>暂无收藏的网址</Text>
              }
              renderItem={({ item }) => (
                <View style={[styles.bookmarkItem, { borderBottomColor: palette.separator }]}>
                  <TouchableOpacity style={styles.bookmarkContent} onPress={() => onLoadBookmark(item)}>
                    <Ionicons name="globe-outline" size={20} color={palette.textSecondary} style={{ marginRight: 12 }} />
                    <Text style={[styles.bookmarkText, { color: palette.textPrimary }]} numberOfLines={1}>{item}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.bookmarkDeleteBtn} onPress={() => onDeleteBookmark(item)}>
                    <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                  </TouchableOpacity>
                </View>
              )}
            />
          ) : (
            <View style={styles.historySection}>
              <View style={styles.historyToolbar}>
                <Text style={[styles.historyCountText, { color: palette.textSecondary }]}>
                  最近 {historyList.length} 条记录
                </Text>
                <TouchableOpacity
                  style={styles.historyClearBtn}
                  onPress={onClearHistory}
                  disabled={historyList.length === 0}
                  activeOpacity={0.7}
                >
                  <Ionicons name="trash-bin-outline" size={15} color={historyList.length === 0 ? palette.separator : '#FF3B30'} />
                  <Text style={[styles.historyClearText, { color: historyList.length === 0 ? palette.separator : '#FF3B30' }]}>
                    清空历史
                  </Text>
                </TouchableOpacity>
              </View>

              <FlatList
                data={historyList}
                keyExtractor={(item) => item.id}
                style={styles.bookmarkList}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <Text style={[styles.listEmptyText, { color: palette.textSecondary }]}>暂无浏览历史</Text>
                }
                renderItem={({ item }) => (
                  <View style={[styles.bookmarkItem, { borderBottomColor: palette.separator }]}>
                    <TouchableOpacity style={styles.historyContent} onPress={() => onLoadHistory(item.url)} activeOpacity={0.7}>
                      <View style={styles.historyTextGroup}>
                        <Text style={[styles.historyTitle, { color: palette.textPrimary }]} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Text style={[styles.historyUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                          {ellipsisMiddle(item.url, 28, 14)}
                        </Text>
                      </View>
                      <Text style={[styles.historyTime, { color: palette.textSecondary }]}>
                        {formatHistoryTime(item.timestamp)}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.bookmarkDeleteBtn} onPress={() => onDeleteHistory(item.id)}>
                      <Ionicons name="close-circle-outline" size={20} color={palette.textSecondary} />
                    </TouchableOpacity>
                  </View>
                )}
              />
            </View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalWrapper: { flex: 1, justifyContent: 'flex-end' },
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.1)' },
  menuContainer: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 12, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 20 },
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

  bookmarkList: { marginTop: 8, maxHeight: 250 },
  bookmarkItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  bookmarkContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  bookmarkText: { fontSize: 15, flex: 1 },
  bookmarkDeleteBtn: { padding: 8, marginLeft: 8 },
  listEmptyText: { fontSize: 14, textAlign: 'center', paddingVertical: 28 },

  // 🗂️ 书签 / 历史 双 Tab
  menuTabBar: { flexDirection: 'row', marginTop: 16, marginBottom: 4, padding: 4, borderRadius: 12 },
  menuTabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 9 },
  menuTabText: { fontSize: 13, fontWeight: '600' },

  // 🕘 历史记录
  historySection: { marginTop: 4 },
  historyToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  historyCountText: { fontSize: 12 },
  historyClearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
  historyClearText: { fontSize: 12, fontWeight: '600' },
  historyContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  historyTextGroup: { flex: 1, marginRight: 10 },
  historyTitle: { fontSize: 14, fontWeight: '500' },
  historyUrl: { fontSize: 11, marginTop: 3 },
  historyTime: { fontSize: 11, fontVariant: ['tabular-nums'] },
});
// --- END OF FILE src/components/browser/BrowserMenuModal.js ---
