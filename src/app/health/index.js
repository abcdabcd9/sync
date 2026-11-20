import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useHealthData } from '../../hooks/useHealthData';
import MealListItem from '../../components/MealListItem';
import MealDetailSheet from '../../components/MealDetailSheet';
import WaterProgress from '../../components/WaterProgress';
import { useAppTheme } from '../../context/ThemeContext';
import { SIZES } from '../../constants/theme';

const MEALS = ['早餐', '午餐', '晚餐'];

// 健康打卡详情页：只保留「饮食记录」与「水分补充」两个区块
export default function HealthDetailScreen() {
  const { colors: palette } = useAppTheme();
  const { width } = useWindowDimensions();
  const {
    selectedMeal, currentSessionOwnerKey, selectedMealSelectionId,
    mealsStatus, waterAmount, maxWater,
    openMeal, closeMeal, confirmCheck, undoCheck, setWaterDirect, updateMaxWater,
    // 🍎 FINAL-2：D-11 拒绝操作的用户可见提示（设备日期异常）。
    dateAnomalyNotice, clearDateAnomalyNotice,
  } = useHealthData();
  const [scrollEnabled, setScrollEnabled] = useState(true);

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.navBar}>
          {/* 🎨 返回键：显式透明背景 + 透明度按压反馈，消除点击时的黑色高亮方框 */}
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="返回"
            style={({ pressed }) => [styles.backBtn, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Ionicons name="chevron-back" size={26} color={palette.textPrimary} />
          </Pressable>
          <Text style={[styles.navTitle, { color: palette.textPrimary }]}>健康打卡</Text>
          <View style={styles.navSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          scrollEnabled={scrollEnabled}
        >
          <View style={[styles.contentWrapper, { maxWidth: width >= 768 ? 680 : '100%' }]}>
            {/* 🍎 FINAL-2：设备日期异常（回拨）导致写入被拒绝时的用户可见提示。
                拒绝时不显示成功反馈，改为在此明确告知用户恢复正确时间后重试。 */}
            {dateAnomalyNotice ? (
              <View style={[styles.noticeBanner, { backgroundColor: palette.card, borderColor: palette.primary }]}>
                <Ionicons name="alert-circle-outline" size={18} color={palette.primary} />
                <Text style={[styles.noticeText, { color: palette.textPrimary }]}>{dateAnomalyNotice}</Text>
                <Pressable
                  onPress={clearDateAnomalyNotice}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="关闭提示"
                  style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1 }]}
                >
                  <Ionicons name="close" size={18} color={palette.textSecondary} />
                </Pressable>
              </View>
            ) : null}
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: palette.textSecondary }]}>饮食记录</Text>
              <View
                style={[
                  styles.listContainer,
                  {
                    backgroundColor: palette.card,
                    borderColor: palette.cardBorder,
                    borderWidth: 1,
                  },
                ]}
              >
                {MEALS.map((meal, index) => (
                  <View key={meal}>
                    <MealListItem
                      meal={meal}
                      checked={mealsStatus?.[meal]}
                      onPress={() => openMeal(meal)}
                    />
                    {index < MEALS.length - 1 && (
                      <View style={[styles.separator, { backgroundColor: palette.separator }]} />
                    )}
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: palette.textSecondary }]}>水分补充</Text>
              <View
                style={[
                  styles.glassWrapper,
                  {
                    backgroundColor: palette.card,
                    borderColor: palette.cardBorder,
                    borderWidth: 1,
                  },
                ]}
              >
                <WaterProgress
                  waterAmount={waterAmount}
                  maxWater={maxWater}
                  onSetWater={setWaterDirect}
                  onMaxWaterChange={updateMaxWater}
                  setScrollEnabled={setScrollEnabled}
                />
              </View>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>

      <MealDetailSheet
        meal={selectedMeal}
        // 🛡️ FINAL-03 / FINAL-04：传入「当前认证身份」而非「选中态所属身份」。
        //    currentSessionOwnerKey 来自 Provider 的 currentOwnerKey，关闭后不会变 null，
        //    因此合法关闭的退出动画不会被误判为身份失效；
        //    切号 / 登出时它会立即变化，旧弹窗当帧隐藏。
        sessionOwnerKey={currentSessionOwnerKey}
        // 🛡️ 选择实例 id：同账号连续打开同一餐次时用于区分不同实例。
        selectionId={selectedMealSelectionId}
        checked={selectedMeal ? mealsStatus?.[selectedMeal] : false}
        onClose={closeMeal}
        onConfirm={confirmCheck}
        onUndo={undoCheck}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backBtn: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  navTitle: { fontSize: 17, fontWeight: '600' },
  navSpacer: { width: 26 },
  scroll: { paddingBottom: 140 },
  contentWrapper: { width: '100%', alignSelf: 'center' },
  section: { marginTop: 24, paddingHorizontal: SIZES.padding },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 10,
    marginLeft: 16,
    letterSpacing: 0.5,
  },
  listContainer: { borderRadius: SIZES.radiusList, overflow: 'hidden' },
  glassWrapper: { borderRadius: SIZES.radiusList, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
  // 🍎 FINAL-2：设备日期异常提示横幅
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    marginHorizontal: SIZES.padding,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: SIZES.radiusList,
    borderWidth: 1,
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
});
