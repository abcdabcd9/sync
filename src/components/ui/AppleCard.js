import { useState } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import { DURATION, SCALE } from '../../constants/motion';
import { haptic } from '../../constants/haptics';

// 苹果风卡片：圆角 + 液态玻璃背景 + 按压缩放 + 触感
// 色值全部来自 useAppTheme().colors，禁止硬编码
// 动画走 RN 内置 Animated + useNativeDriver，跑在原生线程，
// 不依赖 Reanimated 原生模块（本项目原生工程未包含该模块）
export default function AppleCard({
  children,
  onPress,
  onLongPress,
  style,
  disabled = false,
  hapticOnPress = 'light',
  accessibilityLabel,
}) {
  const { colors } = useAppTheme();
  const [scale] = useState(() => new Animated.Value(1));

  const animateTo = (to) => {
    Animated.timing(scale, {
      toValue: to,
      duration: DURATION.instant,
      useNativeDriver: true,
    }).start();
  };

  const handlePressIn = () => animateTo(SCALE.pressIn);
  const handlePressOut = () => animateTo(SCALE.pressOut);

  const handlePress = (e) => {
    if (hapticOnPress && haptic[hapticOnPress]) haptic[hapticOnPress]();
    if (onPress) onPress(e);
  };

  const content = (
    <Animated.View
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.cardBorder,
          transform: [{ scale }],
        },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );

  if (!onPress && !onLongPress) return content;

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    overflow: 'hidden',
  },
});
