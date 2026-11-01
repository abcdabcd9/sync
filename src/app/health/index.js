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
    selectedMeal, mealsStatus, waterAmount, maxWater,
    openMeal, closeMeal, confirmCheck, undoCheck, setWaterDirect, updateMaxWater,
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
});
