// --- START OF FILE src/components/settings/SettingsPage.js ---
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import { SIZES } from '../../constants/theme';

/**
 * L3 设置页通用外壳
 *
 * 视觉与 src/app/settings.js 的导航栏完全一致：
 *   左「‹ 返回」+ 居中标题 + 右侧等宽占位
 * 内容区由调用方用 <Group> 组织。
 */
export default function SettingsPage({ title, children, footer }) {
  const { colors } = useAppTheme();

  const handleBack = () => {
    haptic.light();
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  return (
    // ⚠️ 背景色必须同时铺在最外层 View 上：
    //    iOS 上 SafeAreaView 首帧的安全区高度为 0，第二帧才测量出来，
    //    若背景只画在 SafeAreaView 内部，首帧会露出下层页面的内容，
    //    表现为「进入页面时窗口闪一下」。
    //    外层 View 铺满全屏并带同色背景，可彻底遮住这个首帧空档。
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.navBar}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={handleBack}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="返回"
          >
            <Ionicons name="chevron-back" size={28} color={colors.primary} />
            <Text style={[styles.backText, { color: colors.primary }]}>返回</Text>
          </TouchableOpacity>
          <Text style={[styles.navTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.rightPlaceholder} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {children}
          {footer ? (
            <Text style={[styles.footer, { color: colors.textSecondary }]}>{footer}</Text>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

/**
 * 分组容器：圆角 + 裁剪，内部行用 isFirst / isLast 控制首尾圆角
 */
export function Group({ children, style }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.group, { backgroundColor: colors.card }, style]}>{children}</View>
  );
}

/**
 * 分组标题（与 settings.js 的 sectionTitle 视觉一致）
 */
export function GroupTitle({ children, style }) {
  const { colors } = useAppTheme();
  return (
    <Text style={[styles.groupTitle, { color: colors.textSecondary }, style]}>{children}</Text>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
    paddingHorizontal: 8,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', width: 80 },
  backText: { fontSize: 17, marginLeft: -4 },
  navTitle: { fontSize: 17, fontWeight: '600', flex: 1, textAlign: 'center' },
  rightPlaceholder: { width: 80 },
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 60 },
  group: { borderRadius: SIZES.radiusList, overflow: 'hidden' },
  groupTitle: {
    fontSize: 13,
    fontWeight: '400',
    textTransform: 'uppercase',
    marginBottom: 8,
    marginLeft: 16,
    marginTop: 24,
  },
  footer: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 24,
    paddingHorizontal: 8,
  },
});
// --- END OF FILE src/components/settings/SettingsPage.js ---
