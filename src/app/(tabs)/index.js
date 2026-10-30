// --- START OF FILE src/app/(tabs)/index.js ---
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import { useHealthData } from '../../hooks/useHealthData';
import AppleCard from '../../components/ui/AppleCard';

// 首页：问候头部 + 一张「健康打卡」总览卡，点击进入完整打卡页
export default function HomeScreen() {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const {
    mealsStatus, waterAmount, maxWater, streakDays, motto,
    partnerData, partnerId, isDoneToday,
  } = useHealthData();

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

  const stats = useMemo(() => {
    const meals = Object.values(mealsStatus || {});
    const mealsDone = meals.filter(Boolean).length;
    const mealsTotal = meals.length || 3;
    const mealRatio = mealsTotal ? mealsDone / mealsTotal : 0;
    const waterRatio = maxWater > 0 ? Math.min(1, waterAmount / maxWater) : 0;
    return {
      mealsDone,
      mealsTotal,
      mealRatio,
      waterRatio,
      overall: (mealRatio + waterRatio) / 2,
    };
  }, [mealsStatus, waterAmount, maxWater]);

  const partnerMeals = Object.values(partnerData?.mealsStatus || {});
  const partnerMealsDone = partnerMeals.filter(Boolean).length;
  const partnerWater = partnerData?.waterAmount ?? 0;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={[styles.wrapper, { maxWidth: width >= 768 ? 680 : '100%' }]}>
            <View style={styles.header}>
              <Text style={[styles.greeting, { color: colors.textPrimary }]}>{greeting}</Text>
              <Text style={[styles.date, { color: colors.textSecondary }]}>{dateText}</Text>
              {motto ? (
                <Text style={[styles.motto, { color: colors.textSecondary }]}>{motto}</Text>
              ) : null}
            </View>

            <View style={styles.cardWrap}>
              <AppleCard
                style={styles.card}
                onPress={() => router.push('/health')}
                accessibilityLabel="健康打卡，查看今日详情"
              >
                <View style={styles.cardTop}>
                  <View style={styles.cardTitleWrap}>
                    <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>健康打卡</Text>
                    <Text style={[styles.cardSub, { color: colors.textSecondary }]}>
                      {isDoneToday ? '今日已完成全部任务' : '完成今日全部任务即可打卡'}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.pctBadge,
                      {
                        backgroundColor: colors.background,
                        borderColor: stats.overall >= 1 ? colors.success : colors.cardBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.pctText,
                        { color: stats.overall >= 1 ? colors.success : colors.textPrimary },
                      ]}
                    >
                      {Math.round(stats.overall * 100)}%
                    </Text>
                  </View>
                </View>

                <View style={[styles.divider, { backgroundColor: colors.separator }]} />

                <View style={styles.rows}>
                  <SummaryRow
                    icon="water-outline"
                    label="饮水"
                    value={`${waterAmount} / ${maxWater} ml`}
                    ratio={stats.waterRatio}
                    colors={colors}
                  />
                  <SummaryRow
                    icon="restaurant-outline"
                    label="饮食"
                    value={`${stats.mealsDone} / ${stats.mealsTotal} 餐`}
                    ratio={stats.mealRatio}
                    colors={colors}
                  />
                  <SummaryRow
                    icon="flame-outline"
                    label="连续打卡"
                    value={`${streakDays ?? 0} 天`}
                    ratio={Math.min(1, ((streakDays || 0) % 7) / 7)}
                    colors={colors}
                  />
                  <SummaryRow
                    icon="people-outline"
                    label="健康搭子"
                    value={
                      partnerId
                        ? `水 ${partnerWater} ml · 饭 ${partnerMealsDone}/${partnerMeals.length || 3}`
                        : '未绑定'
                    }
                    ratio={partnerId ? 1 : 0}
                    colors={colors}
                  />
                </View>

                <View style={styles.cardFooter}>
                  <Text style={[styles.cardFooterText, { color: colors.primary }]}>
                    查看今日详情
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                </View>
              </AppleCard>
            </View>

            <View style={styles.bottomSpacer} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function SummaryRow({ icon, label, value, ratio, colors }) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.rowLabelWrap}>
          <Ionicons name={icon} size={16} color={colors.primary} />
          <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>{label}</Text>
        </View>
        <Text style={[styles.rowValue, { color: colors.textSecondary }]}>{value}</Text>
      </View>
      <View style={[styles.barTrack, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.barFill,
            {
              width: `${Math.round(clamped * 100)}%`,
              backgroundColor: clamped >= 1 ? colors.success : colors.primary,
            },
          ]}
        />
      </View>
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
  cardWrap: { paddingHorizontal: 16, marginTop: 16 },
  card: { padding: 18 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitleWrap: { flex: 1, paddingRight: 12 },
  cardTitle: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  cardSub: { fontSize: 13, marginTop: 5 },
  pctBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pctText: { fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 16 },
  rows: { gap: 14 },
  row: {},
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  rowLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { fontSize: 14, fontWeight: '500' },
  rowValue: { fontSize: 13 },
  barTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3 },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: 18,
  },
  cardFooterText: { fontSize: 14, fontWeight: '600' },
  bottomSpacer: { height: 100 },
});
// --- END OF FILE src/app/(tabs)/index.js ---
