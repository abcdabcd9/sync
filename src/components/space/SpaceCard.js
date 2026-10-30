// --- START OF FILE src/components/space/SpaceCard.js ---
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import AppleCard from '../ui/AppleCard';

/**
 * 空间页通用入口卡
 *
 * 结构：图标方块 + 标题（可带角标）+ 副标题 + 右侧箭头
 * 交互：按压缩放 + 触感，全部由 AppleCard 提供
 * 色值：一律取自 useAppTheme().colors，禁止硬编码
 */
export default function SpaceCard({
  icon,
  title,
  subtitle,
  badge,
  accentColor,
  onPress,
  accessibilityLabel,
}) {
  const { colors } = useAppTheme();

  return (
    <AppleCard
      style={styles.card}
      onPress={onPress}
      hapticOnPress="medium"
      accessibilityLabel={accessibilityLabel || title}
    >
      <View style={styles.row}>
        <View style={[styles.iconBox, { backgroundColor: accentColor || colors.primary }]}>
          <Ionicons name={icon} size={24} color="#FFFFFF" />
        </View>

        <View style={styles.info}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
              {title}
            </Text>
            {badge ? (
              <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                <Text style={styles.badgeText}>{badge}</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
      </View>
    </AppleCard>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 20, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  subtitle: { fontSize: 13, marginTop: 4 },
});
// --- END OF FILE src/components/space/SpaceCard.js ---
