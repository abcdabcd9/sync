// --- START OF FILE src/components/browser/SniffedMediaModal.js ---
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  Animated,
  Platform,
  PanResponder,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { haptic } from '../../constants/haptics';

import { ellipsisMiddle } from '../../constants/browser';
import { FILTER_OPTIONS } from '../../hooks/browser/useBrowserSniffer';

/**
 * 🎬 多视频源选择 Bottom Sheet（阶段 4 抽离）
 *
 * 职责：
 *   - 半屏(50%) ⇄ 全屏(92%) 拉伸动画
 *   - 顶部拖拽条手势：上滑展开 / 全屏下滑收起 / 半屏下滑关闭
 *   - MP4 / M3U8 / MOV 格式筛选切片
 *   - 视频卡片列表（播放 / 复制 / 删除）
 *
 * ⚠️ 最高指令：
 *   - 样式、动画参数、Haptics 交互与原内联实现 100% 一致
 *   - 本组件只负责「展示 + 手势」，所有数据与业务回调由父组件注入
 */

// 🎴 视频源卡片
function MediaCard({ item, palette, onPlay, onCopy, onRemove }) {
  return (
    <View
      style={[
        styles.mediaCard,
        {
          backgroundColor: palette.background,
          borderColor: palette.cardBorder,
        },
      ]}
    >
      <View style={styles.mediaCardTop}>
        <View style={[styles.mediaBadge, { backgroundColor: palette.primary }]}>
          <Text style={styles.mediaBadgeText}>.{item.ext}</Text>
        </View>
        <Text style={[styles.mediaDomain, { color: palette.textSecondary }]} numberOfLines={1}>
          {item.domain || '未知域名'}
        </Text>
      </View>

      <Text style={[styles.mediaUrl, { color: palette.textPrimary }]} numberOfLines={1}>
        {ellipsisMiddle(item.url)}
      </Text>

      <View style={styles.mediaCardActions}>
        <TouchableOpacity
          style={[styles.mediaActionBtn, { backgroundColor: palette.primary }]}
          onPress={onPlay}
          activeOpacity={0.8}
        >
          <Ionicons name="play" size={15} color="#FFFFFF" />
          <Text style={styles.mediaActionPrimaryText}>播放</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.mediaActionBtn, styles.mediaActionGhost, { borderColor: palette.cardBorder }]}
          onPress={onCopy}
          activeOpacity={0.8}
        >
          <Ionicons name="copy-outline" size={15} color={palette.textPrimary} />
          <Text style={[styles.mediaActionGhostText, { color: palette.textPrimary }]}>复制</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.mediaRemoveBtn}
          onPress={onRemove}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={16} color="#FF3B30" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function SniffedMediaModal({
  visible,
  onRequestClose,
  isDark,
  palette,
  // 动画
  pickerAnim,
  // 数据
  sniffedMediaList,
  filteredMediaList,
  filterFormat,
  onFilterChange,
  formatCounts,
  // 展开态
  pickerExpanded,
  onToggleExpanded,
  onExpand,
  onCollapse,
  // 操作
  onClear,
  onPlay,
  onCopy,
  onRemove,
}) {
  // 🖐️ 顶部拖拽条手势：上滑展开 / 全屏下滑收起 / 半屏下滑关闭
  //    ✅ 使用 useMemo 惰性创建（替代原 useState(() => ...) 写法），
  //       依赖数组包含 pickerExpanded，展开态变化时重建手势实例，
  //       回调内直接读取最新 props，彻底消除 react-hooks/refs「Cannot access refs during render」告警。
  const pickerPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderRelease: (_, g) => {
          if (g.dy < -50) {
            onExpand();
          } else if (g.dy > 50) {
            if (pickerExpanded) {
              onCollapse();
            } else {
              onRequestClose();
            }
          }
        },
      }),
    [pickerExpanded, onExpand, onCollapse, onRequestClose]
  );

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onRequestClose}>
      <View style={styles.modalWrapper}>
        <Animated.View style={[styles.modalOverlay, { opacity: pickerAnim }]} />
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onRequestClose} activeOpacity={1} />

        <Animated.View
          style={[
            styles.pickerContainer,
            {
              backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
              height: pickerExpanded ? '92%' : '50%',
              transform: [{
                translateY: pickerAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }),
              }],
            },
          ]}
        >
          {/* 🖐️ 拖拽条：上滑展开 / 全屏下滑收起 / 半屏下滑关闭 */}
          <View style={styles.pickerDragZone} {...pickerPanResponder.panHandlers}>
            <View style={styles.menuDragHandle} />
          </View>

          <View style={styles.pickerHeader}>
            <Text style={[styles.pickerTitle, { color: palette.textPrimary }]} numberOfLines={1}>
              选择要播放的视频源 ({sniffedMediaList.length})
            </Text>
            <View style={styles.pickerHeaderActions}>
              <TouchableOpacity
                style={styles.pickerHeaderBtn}
                onPress={onToggleExpanded}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons
                  name={pickerExpanded ? 'chevron-down' : 'chevron-up'}
                  size={20}
                  color={palette.primary}
                />
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickerHeaderBtn} onPress={onClear} activeOpacity={0.7}>
                <Text style={[styles.pickerHeaderBtnText, { color: '#FF3B30' }]}>清空</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickerHeaderBtn} onPress={onRequestClose} activeOpacity={0.7}>
                <Text style={[styles.pickerHeaderBtnText, { color: palette.primary }]}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* 🎚️ 格式筛选切片栏 */}
          <View style={styles.filterChipRow}>
            {FILTER_OPTIONS.map((opt) => {
              const active = filterFormat === opt;
              const label = opt === 'ALL' ? '全部' : opt;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[
                    styles.filterChip,
                    { borderColor: active ? '#FF2D55' : palette.cardBorder },
                    active && { backgroundColor: '#FF2D55' },
                  ]}
                  onPress={() => {
                    haptic.selection();
                    onFilterChange(opt);
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.filterChipText, { color: active ? '#FFFFFF' : palette.textSecondary }]}>
                    {label} ({formatCounts[opt]})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <FlatList
            data={filteredMediaList}
            keyExtractor={(item) => item.id}
            style={styles.pickerList}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <Text style={[styles.pickerEmpty, { color: palette.textSecondary }]}>
                {sniffedMediaList.length === 0
                  ? '暂无嗅探到的视频源'
                  : `未找到 ${filterFormat} 格式的视频源`}
              </Text>
            }
            renderItem={({ item }) => (
              <MediaCard
                item={item}
                palette={palette}
                onPlay={() => onPlay(item.url)}
                onCopy={() => onCopy(item.url)}
                onRemove={() => onRemove(item.id)}
              />
            )}
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalWrapper: { flex: 1, justifyContent: 'flex-end' },
  // 🫧 弹窗效果整体减弱 20%（遮罩 0.1 → 0.08，阴影 0.1 → 0.08，elevation 20 → 16）
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.08)' },
  menuDragHandle: { width: 40, height: 5, backgroundColor: 'rgba(150,150,150,0.3)', borderRadius: 3, alignSelf: 'center', marginBottom: 16 },

  // 🎬 多视频源选择弹窗
  pickerContainer: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 12, maxHeight: '78%', shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 16 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  pickerTitle: { flex: 1, fontSize: 16, fontWeight: '700', marginRight: 8 },
  pickerHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pickerHeaderBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  pickerHeaderBtnText: { fontSize: 14, fontWeight: '600' },
  pickerList: { flexGrow: 0 },
  pickerEmpty: { fontSize: 14, textAlign: 'center', paddingVertical: 32 },

  // 🎚️ 格式筛选切片
  filterChipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1 },
  filterChipText: { fontSize: 12, fontWeight: '600' },
  mediaCard: { borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 10 },
  mediaCardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  mediaBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginRight: 8 },
  mediaBadgeText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3 },
  mediaDomain: { flex: 1, fontSize: 12 },
  mediaUrl: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 10 },
  mediaCardActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mediaActionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, gap: 5 },
  mediaActionPrimaryText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
  mediaActionGhost: { backgroundColor: 'transparent', borderWidth: 1 },
  mediaActionGhostText: { fontSize: 13, fontWeight: '600' },
  mediaRemoveBtn: { marginLeft: 'auto', padding: 6 },

  // 🖐️ 嗅探弹窗拖拽区
  pickerDragZone: { paddingTop: 4, paddingBottom: 4 },
});
// --- END OF FILE src/components/browser/SniffedMediaModal.js ---
