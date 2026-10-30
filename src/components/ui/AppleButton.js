import { useState } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import { DURATION, SCALE } from '../../constants/motion';
import { haptic } from '../../constants/haptics';

// 苹果风按钮：主色填充 / 描边 / 文字三种变体
export default function AppleButton({
  title,
  onPress,
  variant = 'filled', // 'filled' | 'outline' | 'text'
  size = 'md',        // 'sm' | 'md' | 'lg'
  disabled = false,
  style,
  textStyle,
}) {
  const { colors } = useAppTheme();
  // useState 惰性初始化：实例只创建一次，且不是 ref，渲染期可安全读取
  const [scale] = useState(() => new Animated.Value(1));

  const animateTo = (to) =>
    Animated.timing(scale, {
      toValue: to,
      duration: DURATION.instant,
      useNativeDriver: true,
    }).start();

  const handlePress = () => {
    haptic.medium();
    if (onPress) onPress();
  };

  const bg =
    variant === 'filled' ? colors.primary : 'transparent';
  const border =
    variant === 'outline' ? colors.primary : 'transparent';
  const fg = variant === 'filled' ? '#FFFFFF' : colors.primary;

  const paddingV = size === 'sm' ? 8 : size === 'lg' ? 16 : 12;
  const fontSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;

  return (
    <Pressable
      onPress={handlePress}
      onPressIn={() => animateTo(SCALE.pressIn)}
      onPressOut={() => animateTo(SCALE.pressOut)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <Animated.View
        style={[
          styles.btn,
          {
            backgroundColor: bg,
            borderColor: border,
            borderWidth: variant === 'outline' ? 1.5 : 0,
            paddingVertical: paddingV,
            opacity: disabled ? 0.4 : 1,
            transform: [{ scale }],
          },
          style,
        ]}
      >
        <Text style={[styles.text, { color: fg, fontSize }, textStyle]}>
          {title}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  text: {
    fontWeight: '600',
  },
});
