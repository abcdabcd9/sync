import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useAppTheme } from '../../context/ThemeContext';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// 双环进度：外环=主进度，内环=次进度
// 用内置 Animated 驱动 strokeDashoffset（SVG 属性不支持 native driver，
// 但只有 2 个标量在变，开销极小；不依赖 Reanimated 原生模块）
export default function ProgressRing({
  size = 120,
  strokeWidth = 10,
  outerProgress = 0,   // 0-1
  innerProgress = 0,   // 0-1
  outerColor,
  innerColor,
  trackColor,
  children,
}) {
  const { colors } = useAppTheme();
  const radius = (size - strokeWidth) / 2;
  const innerRadius = radius - strokeWidth - 4;
  const circumference = 2 * Math.PI * radius;
  const innerCircumference = 2 * Math.PI * innerRadius;

  // useState 惰性初始化：实例只创建一次，且不是 ref，渲染期可安全读取
  const [outer] = useState(() => new Animated.Value(0));
  const [inner] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(outer, {
      toValue: Math.max(0, Math.min(1, outerProgress)),
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [outer, outerProgress]);

  useEffect(() => {
    Animated.timing(inner, {
      toValue: Math.max(0, Math.min(1, innerProgress)),
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [inner, innerProgress]);

  const outerDash = outer.interpolate({
    inputRange: [0, 1],
    outputRange: [circumference, 0],
  });

  const innerDash = inner.interpolate({
    inputRange: [0, 1],
    outputRange: [innerCircumference, 0],
  });

  const cx = size / 2;
  const cy = size / 2;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        {/* 外环轨道 */}
        <Circle
          cx={cx} cy={cy} r={radius}
          stroke={trackColor || colors.separator}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* 外环进度 */}
        <AnimatedCircle
          cx={cx} cy={cy} r={radius}
          stroke={outerColor || colors.primary}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={outerDash}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        {/* 内环轨道 */}
        <Circle
          cx={cx} cy={cy} r={innerRadius}
          stroke={trackColor || colors.separator}
          strokeWidth={strokeWidth * 0.7}
          fill="none"
        />
        {/* 内环进度 */}
        <AnimatedCircle
          cx={cx} cy={cy} r={innerRadius}
          stroke={innerColor || colors.success}
          strokeWidth={strokeWidth * 0.7}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={innerCircumference}
          strokeDashoffset={innerDash}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </Svg>
      {children}
    </View>
  );
}
