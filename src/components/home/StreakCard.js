import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import AppleCard from '../ui/AppleCard';
import ProgressRing from '../ui/ProgressRing';

// 连续打卡卡：双环（外环=今日完成度，内环=本周进度）
export default function StreakCard({ streakDays = 0, todayProgress = 0, isDoneToday = false }) {
  const { colors } = useAppTheme();
  const weekProgress = Math.min(1, (streakDays % 7) / 7);

  return (
    <AppleCard style={styles.card}>
      <View style={styles.row}>
        <ProgressRing
          size={92}
          strokeWidth={9}
          outerProgress={todayProgress}
          innerProgress={weekProgress}
        >
          <View style={styles.ringCenter}>
            <Text style={[styles.days, { color: colors.textPrimary }]}>
              {streakDays}
            </Text>
            <Text style={[styles.daysLabel, { color: colors.textSecondary }]}>
              天
            </Text>
          </View>
        </ProgressRing>
        <View style={styles.info}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            {isDoneToday ? '今日已打卡' : '连续打卡'}
          </Text>
          <Text style={[styles.desc, { color: colors.textSecondary }]}>
            {isDoneToday
              ? `已坚持 ${streakDays} 天，继续保持`
              : '完成今日全部任务即可打卡'}
          </Text>
        </View>
      </View>
    </AppleCard>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  ringCenter: { alignItems: 'center', justifyContent: 'center' },
  days: { fontSize: 26, fontWeight: '700' },
  daysLabel: { fontSize: 11, marginTop: -2 },
  info: { flex: 1 },
  title: { fontSize: 17, fontWeight: '600' },
  desc: { fontSize: 13, marginTop: 6, lineHeight: 19 },
});
