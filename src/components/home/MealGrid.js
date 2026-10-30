import { StyleSheet, View } from 'react-native';
import AppleCard from '../ui/AppleCard';
import MealListItem from '../MealListItem';

// 2×2 餐食格：早餐 / 午餐 / 晚餐（+ 加餐，若 mealsStatus 里有）
// mealsStatus 形如 { '早餐': false, '午餐': true, '晚餐': false }
// MealListItem 的 meal prop 是字符串，不是对象
export default function MealGrid({ mealsStatus, onPressMeal }) {
  const entries = Object.entries(mealsStatus || {});

  return (
    <View style={styles.grid}>
      {entries.map(([name, checked]) => (
        <AppleCard
          key={name}
          style={styles.cell}
          onPress={() => onPressMeal(name)}
        >
          <MealListItem
            meal={name}
            checked={!!checked}
            onPress={() => onPressMeal(name)}
          />
        </AppleCard>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    marginTop: 12,
    gap: 8,
  },
  cell: {
    width: '48%',
    padding: 12,
  },
});
