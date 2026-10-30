import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useAppTheme } from '../../context/ThemeContext';
import { DURATION } from '../../constants/motion';

// 骨架屏：微光从左到右循环
export default function Skeleton({ width = '100%', height = 16, radius = 8, style }) {
  const { isDark } = useAppTheme();
  // useState 惰性初始化：实例只创建一次，且不是 ref，渲染期可安全读取
  const [shimmer] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: DURATION.skeleton,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const translateX = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-200, 200],
  });

  const base = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const highlight = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.6)';

  return (
    <View
      style={[
        { width, height, borderRadius: radius, backgroundColor: base, overflow: 'hidden' },
        style,
      ]}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { transform: [{ translateX }] }]}
      >
        <LinearGradient
          colors={['transparent', highlight, 'transparent']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}
