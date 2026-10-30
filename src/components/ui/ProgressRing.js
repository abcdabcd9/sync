import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useAppTheme } from '../../context/ThemeContext';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// 双环进度：外环=主进度，内环=次进度
// 用 Reanimated worklet 驱动 strokeDashoffset，UI 线程动画不掉帧
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

  const outer = useSharedValue(0);
  const inner = useSharedValue(0);

  useEffect(() => {
    outer.value = withTiming(Math.max(0, Math.min(1, outerProgress)), {
      duration: 700,
      easing: Easing.out(Easing.cubic),
    });
  }, [outer, outerProgress]);

  useEffect(() => {
    inner.value = withTiming(Math.max(0, Math.min(1, innerProgress)), {
      duration: 700,
      easing: Easing.out(Easing.cubic),
    });
  }, [inner, innerProgress]);

  const outerProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - outer.value),
  }));

  const innerProps = useAnimatedProps(() => ({
    strokeDashoffset: innerCircumference * (1 - inner.value),
  }));

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
          animatedProps={outerProps}
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
          animatedProps={innerProps}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </Svg>
      {children}
    </View>
  );
}
