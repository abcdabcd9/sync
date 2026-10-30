import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useHealthData } from '../../hooks/useHealthData';
import MealListItem from '../../components/MealListItem';
import MealDetailSheet from '../../components/MealDetailSheet';
import WaterProgress from '../../components/WaterProgress';
import { useAppTheme } from '../../context/ThemeContext';
import { SIZES, TYPOGRAPHY } from '../../constants/theme';

const MEALS = ['早餐', '午餐', '晚餐'];

// 健康打卡详情页：界面回退为阶段 2 之前的原版今日页，仅顶部加返回栏
export default function HealthDetailScreen() {
  const { colors: palette } = useAppTheme();
  const { width } = useWindowDimensions();
  const {
    selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect,
  } = useHealthData();
  const [scrollEnabled, setScrollEnabled] = useState(true);

  const partnerMealsDone = Object.values(partnerData?.mealsStatus || {}).filter(Boolean).length;

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.navBar}>
          <Ionicons
            name="chevron-back"
            size={26}
            color={palette.textPrimary}
            onPress={() => router.back()}
          />
          <Text style={[styles.navTitle, { color: palette.textPrimary }]}>健康打卡</Text>
          <View style={styles.navSpacer} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          scrollEnabled={scrollEnabled}
        >
          <View style={[styles.contentWrapper, { maxWidth: width >= 768 ? 680 : '100%' }]}>
            <View style={styles.header}>
              <View style={styles.titleRow}>
                <Text style={[styles.largeTitle, { color: palette.textPrimary }]}>{motto}</Text>
              </View>

              <View style={styles.badgesRow}>
                {streakDays > 0 && (
                  <View
                    style={[
                      styles.badge,
                      {
                        backgroundColor: palette.card,
                        borderColor: palette.cardBorder,
                        borderWidth: 1,
                      },
                    ]}
                  >
                    <Ionicons name="flame" size={16} color={palette.primary} />
                    <Text style={[styles.badgeText, { color: palette.primary }]}>
                      {streakDays} 天坚持
                    </Text>
                  </View>
                )}
                {partnerId && (
                  <View
                    style={[
                      styles.badge,
                      {
                        backgroundColor: palette.card,
                        borderColor: palette.cardBorder,
                        borderWidth: 1,
                      },
                    ]}
                  >
                    <Ionicons name="heart" size={16} color={palette.primary} />
                    <Text style={[styles.badgeText, { color: palette.textPrimary }]}>
                      TA：水 {partnerData?.waterAmount ?? 0}ml | 饭 {partnerMealsDone}/3
                    </Text>
                  </View>
                )}
              </View>
            </View>

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
                  onAdd={handleAddWater}
                  onMinus={handleMinusWater}
                  onSetWater={setWaterDirect}
                  setScrollEnabled={setScrollEnabled}
                />
              </View>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>

      <MealDetailSheet
        meal={selectedMeal}
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
  navTitle: { fontSize: 17, fontWeight: '600' },
  navSpacer: { width: 26 },
  scroll: { paddingBottom: 140 },
  contentWrapper: { width: '100%', alignSelf: 'center' },
  header: { paddingHorizontal: SIZES.padding, paddingTop: 24, paddingBottom: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  largeTitle: TYPOGRAPHY.largeTitle,
  badgesRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  badgeText: { fontSize: 13, fontWeight: '600', marginLeft: 4 },
  section: { marginTop: 32, paddingHorizontal: SIZES.padding },
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
});
