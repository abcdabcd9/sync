// --- START OF FILE WaterProgress.js ---
import React, { useRef, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PanResponder, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAppTheme } from '../context/ThemeContext';
import { SIZES } from '../constants/theme';
import { haptic } from '../constants/haptics';

const ThemedText = React.memo(({ children, style, color, ...props }) => (
  <Text style={[style, { color }]} {...props}>
    {children}
  </Text>
));

const AmountDisplay = React.memo(({ waterAmount, maxWater, palette }) => (
  <View>
    <View style={styles.amountRow}>
      <ThemedText style={styles.amount} color={palette.textPrimary}>
        {waterAmount}
      </ThemedText>
      <ThemedText style={styles.unit} color={palette.textSecondary}>
        mL
      </ThemedText>
    </View>
    <ThemedText style={styles.subtitle} color={palette.textSecondary}>
      目标: {maxWater} mL
    </ThemedText>
  </View>
));

const ProgressTrack = React.memo(({ palette, done, animatedPercentage, knobOpacity, trackWidthRef, panResponder }) => (
  <View style={styles.trackContainer}>
    <View style={[styles.track, { backgroundColor: palette.background }]} onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width; }} pointerEvents="none">
      <Animated.View style={[styles.fill, { width: animatedPercentage, backgroundColor: done ? palette.success : palette.primary }]} />
      <Animated.View style={[styles.knob, { left: animatedPercentage, backgroundColor: 'transparent', borderColor: done ? palette.success : palette.primary, opacity: knobOpacity }]} />
    </View>
    <View style={styles.trackHitbox} {...panResponder.panHandlers} />
  </View>
));

export default function WaterProgress({ waterAmount, maxWater, onSetWater, setScrollEnabled, onAdd, onMinus }) {
  const { colors: palette } = useAppTheme();
  const safeMaxWater = Math.max(1, maxWater || 1800);
  const ratio = Math.min(1, Math.max(0, waterAmount / safeMaxWater));
  const done = waterAmount >= safeMaxWater;

  const animatedRatio = useRef(new Animated.Value(ratio)).current;
  const isDragging = useRef(false);
  const knobOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isDragging.current) {
      Animated.timing(animatedRatio, { toValue: ratio, duration: 0, useNativeDriver: false }).start();
    } else {
      Animated.spring(animatedRatio, { toValue: ratio, friction: 7, tension: 50, useNativeDriver: false }).start();
    }
  }, [ratio, animatedRatio]);

  const animatedPercentage = useMemo(() => animatedRatio.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'], extrapolate: 'clamp' }), [animatedRatio]);

  const trackWidthRef = useRef(0);
  const currentWaterRef = useRef(waterAmount);
  const initialTouchXRef = useRef(0);
  const maxWaterRef = useRef(safeMaxWater);
  useEffect(() => { maxWaterRef.current = safeMaxWater; }, [safeMaxWater]);
  useEffect(() => { currentWaterRef.current = waterAmount; }, [waterAmount]);

  const actionsRef = useRef({ onSetWater, onAdd, onMinus });
  useEffect(() => { actionsRef.current = { onSetWater, onAdd, onMinus }; }, [onSetWater, onAdd, onMinus]);

  const timerRef = useRef(null);
  const holdStartTime = useRef(0);
  const tickCount = useRef(0);

  useEffect(() => { return () => { if (timerRef.current) clearInterval(timerRef.current); }; }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        isDragging.current = true; 
        setScrollEnabled(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        Animated.timing(knobOpacity, { toValue: 0.4, duration: 100, useNativeDriver: false }).start();
        initialTouchXRef.current = evt.nativeEvent.locationX;
        if (trackWidthRef.current > 0) {
          const newRatio = Math.min(1, Math.max(0, initialTouchXRef.current / trackWidthRef.current));
          actionsRef.current.onSetWater(newRatio * maxWaterRef.current);
        }
      },
      onPanResponderMove: (evt, gestureState) => {
        if (trackWidthRef.current > 0) {
          const currentX = initialTouchXRef.current + gestureState.dx;
          const newRatio = Math.min(1, Math.max(0, currentX / trackWidthRef.current));
          actionsRef.current.onSetWater(newRatio * maxWaterRef.current);
        }
      },
      onPanResponderRelease: () => {
        isDragging.current = false; setScrollEnabled(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        Animated.timing(knobOpacity, { toValue: 1, duration: 150, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => {
        isDragging.current = false; setScrollEnabled(true);
        Animated.timing(knobOpacity, { toValue: 1, duration: 150, useNativeDriver: false }).start();
      },
    })
  ).current;

  const startAction = (direction) => {
    stopAction();
    haptic.light();
    const actionFunc = direction > 0 ? actionsRef.current.onAdd : actionsRef.current.onMinus;
    actionFunc();
    holdStartTime.current = Date.now();
    tickCount.current = 0;
    timerRef.current = setInterval(() => {
      tickCount.current += 1;
      const elapsed = Date.now() - holdStartTime.current;
      if (elapsed >= 1000) {
        if (tickCount.current % 2 === 0) {
           actionsRef.current.onSetWater(currentWaterRef.current + direction * 100);
           Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
      } else {
        actionFunc();
      }
    }, 50);
  };

  const stopAction = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  // 水位达标时给一次选择反馈（只在跨过目标线那一刻触发）
  const prevDoneRef = useRef(done);
  useEffect(() => {
    if (done && !prevDoneRef.current) haptic.selection();
    prevDoneRef.current = done;
  }, [done]);

  return (
    <View style={[styles.card, { backgroundColor: palette.card }]}>
      <View style={styles.header}>
        <AmountDisplay waterAmount={waterAmount} maxWater={maxWater} palette={palette} />
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.button, { backgroundColor: palette.background }]} onPressIn={() => startAction(-1)} onPressOut={stopAction} activeOpacity={0.6}>
            <Ionicons name="remove" size={20} color={palette.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, { backgroundColor: palette.background }]} onPressIn={() => startAction(1)} onPressOut={stopAction} activeOpacity={0.6}>
            <Ionicons name="add" size={20} color={palette.primary} />
          </TouchableOpacity>
        </View>
      </View>
      <ProgressTrack palette={palette} done={done} animatedPercentage={animatedPercentage} knobOpacity={knobOpacity} trackWidthRef={trackWidthRef} panResponder={panResponder} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: SIZES.radiusList, padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 },
  
  // 🍎 核心修复：强制给予容器 120 的物理宽度，绝不让安卓自己乱缩放截断字母！
  amountRow: { flexDirection: 'row', alignItems: 'flex-end', minWidth: 120 }, 
  
  // 🍎 核心修复：给数字右侧加上一点点 padding，彻底破除边界溢出导致的字母切割！
  amount: { fontSize: 28, fontWeight: '700', paddingRight: 4 },
  
  unit: { fontSize: 17, fontWeight: '500', marginBottom: 3 }, 
  subtitle: { fontSize: 13, fontWeight: '400', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8 },
  button: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  trackContainer: { position: 'relative', paddingVertical: 16, marginVertical: -16, justifyContent: 'center' },
  track: { height: 12, borderRadius: 6, justifyContent: 'center' },
  trackHitbox: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  fill: { height: '100%', borderRadius: 6 },
  knob: { position: 'absolute', width: 24, height: 24, borderRadius: 12, borderWidth: 4, marginLeft: -12 }
});
// --- END OF FILE WaterProgress.js ---