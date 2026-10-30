import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAppTheme } from '../../context/ThemeContext';
import AppleCard from '../ui/AppleCard';
import AppleButton from '../ui/AppleButton';

// 搭子状态卡：未绑定 → 引导邀请；已绑定 → 显示对方今日进度
// 数据契约来自 useHealthData：partnerId（string|null）、partnerData（{ waterAmount, mealsStatus }）
export default function PartnerStatusCard({ partnerId, partnerData }) {
  const { colors } = useAppTheme();

  if (!partnerId) {
    return (
      <AppleCard style={styles.card}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          找个健康搭子
        </Text>
        <Text style={[styles.desc, { color: colors.textSecondary }]}>
          邀请好友成为你的健康守护人，互相监督打卡进度
        </Text>
        <AppleButton
          title="邀请搭子"
          variant="filled"
          size="sm"
          style={styles.btn}
          onPress={() => router.push('/bind_partner')}
        />
      </AppleCard>
    );
  }

  const meals = partnerData?.mealsStatus || {};
  const mealsDone = Object.values(meals).filter(Boolean).length;
  const mealsTotal = Object.keys(meals).length || 3;
  const water = partnerData?.waterAmount ?? 0;
  const done = mealsDone >= mealsTotal && mealsTotal > 0;

  return (
    <AppleCard style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Text style={styles.avatarText}>搭</Text>
        </View>
        <View style={styles.info}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>
            健康搭子
          </Text>
          <Text style={[styles.status, { color: colors.textSecondary }]}>
            水 {water} ml · 饭 {mealsDone}/{mealsTotal}
          </Text>
        </View>
        <View
          style={[
            styles.dot,
            { backgroundColor: done ? colors.success : colors.separator },
          ]}
        />
      </View>
    </AppleCard>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 12 },
  title: { fontSize: 17, fontWeight: '600' },
  desc: { fontSize: 14, marginTop: 6, lineHeight: 20 },
  btn: { marginTop: 14, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
  info: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  status: { fontSize: 13, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
