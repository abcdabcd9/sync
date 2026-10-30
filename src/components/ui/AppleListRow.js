import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';

// 苹果风列表行：左图标 + 标题 + 右值 + 箭头
export default function AppleListRow({
  title,
  value,
  icon,
  iconBg,
  onPress,
  isDestructive = false,
  hideArrow = false,
  isFirst = false,
  isLast = false,
}) {
  const { colors } = useAppTheme();

  const handlePress = () => {
    if (isDestructive) haptic.heavy();
    else haptic.light();
    if (onPress) onPress();
  };

  return (
    <Pressable
      onPress={onPress ? handlePress : undefined}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.card,
          borderTopLeftRadius: isFirst ? 14 : 0,
          borderTopRightRadius: isFirst ? 14 : 0,
          borderBottomLeftRadius: isLast ? 14 : 0,
          borderBottomRightRadius: isLast ? 14 : 0,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      {icon ? (
        <View style={[styles.iconBox, { backgroundColor: iconBg || colors.iconBackground }]}>
          <Text style={styles.iconText}>{icon}</Text>
        </View>
      ) : null}
      <Text
        style={[
          styles.title,
          { color: isDestructive ? '#FF3B30' : colors.textPrimary },
        ]}
      >
        {title}
      </Text>
      {value ? (
        <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {!hideArrow && onPress ? (
        <Text style={[styles.arrow, { color: colors.textSecondary }]}>›</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    gap: 12,
  },
  iconBox: {
    width: 28,
    height: 28,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 15 },
  title: { flex: 1, fontSize: 16 },
  value: { fontSize: 15, maxWidth: '45%' },
  arrow: { fontSize: 20, fontWeight: '300' },
});
