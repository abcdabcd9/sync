import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import AppleCard from '../ui/AppleCard';
import WaterProgress from '../WaterProgress';

// 饮水卡：复用现有 WaterProgress，不改其内部逻辑
// props 与 WaterProgress 签名一一对应
export default function WaterCard({
  waterAmount,
  maxWater,
  onSetWater,
  setScrollEnabled,
  onMaxWaterChange,
}) {
  const { colors } = useAppTheme();
  return (
    <AppleCard style={styles.card}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>今日饮水</Text>
        <Text style={[styles.value, { color: colors.primary }]}>
          {waterAmount} / {maxWater} ml
        </Text>
      </View>
      <WaterProgress
        waterAmount={waterAmount}
        maxWater={maxWater}
        onSetWater={onSetWater}
        setScrollEnabled={setScrollEnabled}
        onMaxWaterChange={onMaxWaterChange}
      />
    </AppleCard>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { fontSize: 17, fontWeight: '600' },
  value: { fontSize: 15, fontWeight: '600' },
});
