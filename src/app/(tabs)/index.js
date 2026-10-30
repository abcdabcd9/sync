// --- START OF FILE src/app/(tabs)/index.js ---
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../../context/ThemeContext';
import { useHealthData } from '../../hooks/useHealthData';
import PartnerStatusCard from '../../components/home/PartnerStatusCard';
import WaterCard from '../../components/home/WaterCard';
import MealGrid from '../../components/home/MealGrid';
import StreakCard from '../../components/home/StreakCard';
import MealDetailSheet from '../../components/MealDetailSheet';

// 首页：问候 → 搭子卡 → 饮水卡 → 2×2 餐食格 → 连续打卡卡
export default function HomeScreen() {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const {
    selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto,
    partnerData, partnerId, isDoneToday,
    openMeal, closeMeal, confirmCheck, undoCheck,
    handleAddWater, handleMinusWater, setWaterDirect,
  } = useHealthData();

  const [scrollEnabled, setScrollEnabled] = useState(true);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 18) return '下午好';
    return '晚上好';
  }, []);

  const dateText = useMemo(
    () => new Date().toLocaleDateString('zh-CN', {
      month: 'long', day: 'numeric', weekday: 'long',
    }),
    []
  );

  // 今日完成度：餐食完成率与饮水完成率各占一半
  const todayProgress = useMemo(() => {
    const meals = Object.values(mealsStatus || {});
    const mealRatio = meals.length ? meals.filter(Boolean).length / meals.length : 0;
    const waterRatio = maxWater > 0 ? Math.min(1, waterAmount / maxWater) : 0;
    return (mealRatio + waterRatio) / 2;
  }, [mealsStatus, waterAmount, maxWater]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView
          scrollEnabled={scrollEnabled}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.wrapper, { maxWidth: width >= 768 ? 680 : '100%' }]}>
            <View style={styles.header}>
              <Text style={[styles.greeting, { color: colors.textPrimary }]}>
                {greeting}
              </Text>
              <Text style={[styles.date, { color: colors.textSecondary }]}>
                {dateText}
              </Text>
              {motto ? (
                <Text style={[styles.motto, { color: colors.textSecondary }]}>
                  {motto}
                </Text>
              ) : null}
            </View>

            <PartnerStatusCard partnerId={partnerId} partnerData={partnerData} />

            <WaterCard
              waterAmount={waterAmount}
              maxWater={maxWater}
              onSetWater={setWaterDirect}
              setScrollEnabled={setScrollEnabled}
              onAdd={handleAddWater}
              onMinus={handleMinusWater}
            />

            <MealGrid mealsStatus={mealsStatus} onPressMeal={openMeal} />

            <StreakCard
              streakDays={streakDays ?? 0}
              todayProgress={todayProgress}
              isDoneToday={!!isDoneToday}
            />

            <View style={styles.bottomSpacer} />
          </View>
        </ScrollView>
      </SafeAreaView>

      <MealDetailSheet
        meal={selectedMeal}
        checked={selectedMeal ? !!mealsStatus?.[selectedMeal] : false}
        onClose={closeMeal}
        onConfirm={confirmCheck}
        onUndo={undoCheck}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  content: { paddingTop: 8 },
  wrapper: { width: '100%', alignSelf: 'center' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  greeting: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4 },
  date: { fontSize: 14, marginTop: 4 },
  motto: { fontSize: 13, marginTop: 6 },
  bottomSpacer: { height: 100 },
});
// --- END OF FILE src/app/(tabs)/index.js ---
