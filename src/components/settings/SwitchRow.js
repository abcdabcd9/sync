// --- START OF FILE src/components/settings/SwitchRow.js ---
import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';

/**
 * 开关行
 *
 * 视觉对齐 AppleListRow：minHeight 52 / paddingHorizontal 16 / gap 12 / fontSize 16
 * 右侧放 RN 原生 Switch，trackColor 用主题主色。
 *
 * props:
 *   title      主标题
 *   desc       可选副标题（小字，说明该开关的作用）
 *   value      当前值
 *   onValueChange(value) 变更回调
 *   isFirst / isLast  首尾圆角
 *   disabled   禁用态
 */
export default function SwitchRow({
  title,
  desc,
  value,
  onValueChange,
  isFirst = false,
  isLast = false,
  disabled = false,
}) {
  const { colors } = useAppTheme();

  const handleChange = (next) => {
    haptic.selection();
    if (onValueChange) onValueChange(next);
  };

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card },
        !isLast && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.separator,
        },
        isFirst && { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
        isLast && { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
        disabled && { opacity: 0.4 },
      ]}
    >
      <View style={styles.textWrap}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        {desc ? (
          <Text style={[styles.desc, { color: colors.textSecondary }]}>{desc}</Text>
        ) : null}
      </View>
      <Switch
        value={Boolean(value)}
        onValueChange={handleChange}
        disabled={disabled}
        trackColor={{ false: colors.separator, true: colors.primary }}
        ios_backgroundColor={colors.separator}
        accessibilityLabel={title}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  textWrap: { flex: 1 },
  title: { fontSize: 16, fontWeight: '400' },
  desc: { fontSize: 12, marginTop: 3, lineHeight: 16 },
});
// --- END OF FILE src/components/settings/SwitchRow.js ---
