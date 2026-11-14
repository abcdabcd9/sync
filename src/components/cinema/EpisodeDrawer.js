// --- START OF FILE src/components/cinema/EpisodeDrawer.js ---
// 📺 选集悬浮窗
//
// 设计要求（用户明确指定）：
//   1. 从右侧向左滑入
//   2. 宽度约占屏幕 30%
//   3. 半透明（BlurView + 半透明底色）
//   4. 使用影院主题色（palette.primary / palette.background / palette.textPrimary）
//   5. 不影响任何原有操作：仅在打开时覆盖右侧区域，关闭后完全移除
//
// 交互：
//   - 点击遮罩空白处关闭
//   - 点击某一集 → onSelect(index) → 关闭
//   - 当前集高亮显示
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  ScrollView,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const IS_ANDROID = Platform.OS === 'android';

/**
 * @param {object}   props
 * @param {boolean}  props.visible          是否显示
 * @param {Array}    props.episodes         选集列表 [{ url, label, episodeId }]
 * @param {number}   props.currentIndex     当前集索引（-1 表示未知）
 * @param {function} props.onSelect         (index) => void
 * @param {function} props.onClose          () => void
 * @param {object}   props.palette          主题色
 * @param {boolean}  props.isDark           是否深色模式
 * @param {number}   [props.topInset]       顶部安全区（沉浸模式横屏时用）
 * @param {number}   [props.bottomInset]    底部安全区
 */
export default function EpisodeDrawer({
  visible,
  episodes = [],
  currentIndex = -1,
  onSelect,
  onClose,
  palette,
  isDark,
  topInset = 0,
  bottomInset = 0,
}) {
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  // 宽度约占屏幕 36%（在 30% 基础上增加 20%），并做上下限保护
  const drawerWidth = Math.min(Math.max(SCREEN_WIDTH * 0.36, 264), 504);

  // 用 useState 惰性初始化 Animated.Value（避免渲染期访问 ref.current 触发 lint）
  const [translateX] = useState(() => new Animated.Value(drawerWidth));
  const [backdropOpacity] = useState(() => new Animated.Value(0));
  // 内容淡入 + 轻微缩放，让弹出更有层次感
  const [contentOpacity] = useState(() => new Animated.Value(0));
  const [contentScale] = useState(() => new Animated.Value(0.96));
  // 内部挂载状态：关闭时先播退出动画，动画结束后再卸载，保证每次都有动效
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      // 先挂载，再在下一帧启动进入动画（确保动画每次都能播放）
      setMounted(true);
      // 重置到初始态，避免上次关闭残留
      translateX.setValue(drawerWidth);
      backdropOpacity.setValue(0);
      contentOpacity.setValue(0);
      contentScale.setValue(0.96);

      // 打开：抽屉弹性滑入 + 遮罩淡入 + 内容淡入放大（错峰，更有动感）
      Animated.parallel([
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          damping: 18,
          stiffness: 180,
          mass: 0.9,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 240,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.delay(60),
          Animated.parallel([
            Animated.timing(contentOpacity, {
              toValue: 1,
              duration: 220,
              useNativeDriver: true,
            }),
            Animated.spring(contentScale, {
              toValue: 1,
              useNativeDriver: true,
              damping: 16,
              stiffness: 200,
              mass: 0.8,
            }),
          ]),
        ]),
      ]).start();
    } else if (mounted) {
      // 关闭：快速滑出 + 遮罩淡出 + 内容淡出，动画结束后卸载
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: drawerWidth,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(contentOpacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, drawerWidth, translateX, backdropOpacity, contentOpacity, contentScale]);

  // 未挂载时完全不渲染，避免拦截触摸
  if (!mounted) return null;

  const handleSelect = (index) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onSelect) onSelect(index);
  };

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onClose) onClose();
  };

  const tint = isDark ? 'dark' : 'light';
  // 半透明底色：深色模式用黑底，浅色模式用白底
  const sheetBg = isDark ? 'rgba(20,20,22,0.72)' : 'rgba(255,255,255,0.72)';
  const borderColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} pointerEvents="box-none">
      {/* 左侧遮罩：点击关闭，半透明，不遮挡抽屉本身 */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: 'rgba(0,0,0,0.35)', opacity: backdropOpacity },
        ]}
      >
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={handleClose}
        />
      </Animated.View>

      {/* 右侧抽屉 */}
      <Animated.View
        style={[
          styles.drawer,
          {
            width: drawerWidth,
            paddingTop: Math.max(topInset, 12),
            paddingBottom: Math.max(bottomInset, 12),
            transform: [{ translateX }],
          },
        ]}
      >
        <Animated.View
          style={[
            styles.blurWrap,
            { opacity: contentOpacity, transform: [{ scale: contentScale }] },
          ]}
        >
        <BlurView
          tint={tint}
          intensity={IS_ANDROID ? 60 : 80}
          style={[styles.blur, { backgroundColor: sheetBg, borderColor }]}
        >
          {/* 标题栏：仅「选集」+ 关闭按钮，无搜索框 / 网址框 */}
          <View style={[styles.header, { borderBottomColor: borderColor }]}>
            <View style={styles.headerLeft}>
              <Ionicons name="list" size={18} color={palette.primary} />
              <Text style={[styles.title, { color: palette.textPrimary }]}>
                选集
              </Text>
              {episodes.length > 0 && (
                <Text style={[styles.count, { color: palette.textSecondary }]}>
                  {episodes.length}
                </Text>
              )}
            </View>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={10}>
              <Ionicons name="close" size={20} color={palette.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* 集数网格 */}
          {episodes.length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons
                name="hourglass-outline"
                size={28}
                color={palette.textSecondary}
              />
              <Text style={[styles.emptyText, { color: palette.textSecondary }]}>
                正在获取选集…
              </Text>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.gridContent}
              showsVerticalScrollIndicator={false}
            >
              {episodes.map((ep, index) => {
                const active = index === currentIndex;
                const label = ep.label || `第${index + 1}集`;
                return (
                  <TouchableOpacity
                    key={ep.url || index}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: active
                          ? palette.primary
                          : isDark
                          ? 'rgba(255,255,255,0.08)'
                          : 'rgba(0,0,0,0.05)',
                        borderColor: active ? palette.primary : borderColor,
                      },
                    ]}
                    activeOpacity={0.7}
                    onPress={() => handleSelect(index)}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.chipText,
                        { color: active ? '#FFFFFF' : palette.textPrimary },
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </BlurView>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 根容器：抬高层级，确保从上到下覆盖播放条等所有控件
  root: {
    zIndex: 100,
    elevation: 100,
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
  },
  blurWrap: {
    flex: 1,
  },
  blur: {
    flex: 1,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 6,
  },
  count: {
    fontSize: 12,
    marginLeft: 6,
  },
  closeBtn: {
    padding: 2,
  },
  gridContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 10,
    gap: 8,
    // 最后一行不足 3 个时保持左对齐（与上方各行起始位置一致）
    justifyContent: 'flex-start',
  },
  chip: {
    // 固定 3 列：用 flexBasis 百分比实现，保证每行严格 3 个
    // 30% × 3 + 2 个 gap 仍有余量，避免边界换行；最后一行不足 3 个时由
    // gridContent 的 justifyContent:'center' 居中
    flexBasis: '30%',
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 6,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 13,
    marginTop: 8,
  },
});
// --- END OF FILE src/components/cinema/EpisodeDrawer.js ---
