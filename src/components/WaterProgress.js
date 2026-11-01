// --- START OF FILE WaterProgress.js ---
import React, { useRef, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
  Animated,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
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

const AmountDisplay = React.memo(({ waterAmount, maxWater, palette, onPressAmount }) => (
  <View>
    {/* 🖊️ 点击数字可直接输入精确水量（解决 10 的倍数导致个位数被锁死的问题） */}
    <TouchableOpacity
      style={styles.amountRow}
      onPress={onPressAmount}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={`当前饮水 ${waterAmount} 毫升，点击可手动输入`}
    >
      <ThemedText style={styles.amount} color={palette.textPrimary}>
        {waterAmount}
      </ThemedText>
      <ThemedText style={styles.unit} color={palette.textSecondary}>
        mL
      </ThemedText>
    </TouchableOpacity>
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

// 目标水量调节：单击 ±100mL
const GOAL_STEP_ML = 100;
// 目标水量下限（防止出现 0 或负数）
const GOAL_MIN_ML = 100;
// 目标水量上限（与设置页保持一致）
const GOAL_MAX_ML = 5000;

export default function WaterProgress({
  waterAmount,
  maxWater,
  onSetWater,
  setScrollEnabled,
  onMaxWaterChange,
}) {
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

  const actionsRef = useRef({ onSetWater, onMaxWaterChange });
  useEffect(() => {
    actionsRef.current = { onSetWater, onMaxWaterChange };
  }, [onSetWater, onMaxWaterChange]);

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

  // 🎯 加减按钮现在控制「目标水量」（不再是已饮水量）。
  //    单击 ±100mL，并钳制在 [100, 5000] 区间内。
  //    持久化由父层 updateMaxWater → AsyncStorage(@maxWater) 完成。
  const changeGoal = (direction) => {
    const next = Math.max(
      GOAL_MIN_ML,
      Math.min(GOAL_MAX_ML, maxWaterRef.current + direction * GOAL_STEP_ML)
    );
    if (next === maxWaterRef.current) return;
    maxWaterRef.current = next;
    haptic.light();
    actionsRef.current.onMaxWaterChange?.(next);
  };

  // ---- 🖊️ 手动输入水量 ----
  const [inputVisible, setInputVisible] = useState(false);
  const [inputText, setInputText] = useState('');

  const openInput = () => {
    haptic.light();
    setInputText(String(waterAmount));
    setInputVisible(true);
  };

  const closeInput = () => setInputVisible(false);

  const submitInput = () => {
    const parsed = parseInt(inputText, 10);
    if (!Number.isFinite(parsed)) {
      closeInput();
      return;
    }
    // 交给父层统一做 0 ~ maxWater 的钳制与云端防抖同步
    actionsRef.current.onSetWater(parsed);
    haptic.success();
    closeInput();
  };

  // 水位达标时给一次选择反馈（只在跨过目标线那一刻触发）
  const prevDoneRef = useRef(done);
  useEffect(() => {
    if (done && !prevDoneRef.current) haptic.selection();
    prevDoneRef.current = done;
  }, [done]);

  return (
    <View style={[styles.card, { backgroundColor: palette.card }]}>
      <View style={styles.header}>
        <AmountDisplay
          waterAmount={waterAmount}
          maxWater={maxWater}
          palette={palette}
          onPressAmount={openInput}
        />
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: palette.background }]}
            onPress={() => changeGoal(-1)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="目标水量减少 100 毫升"
          >
            <Ionicons name="remove" size={20} color={palette.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: palette.background }]}
            onPress={() => changeGoal(1)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="目标水量增加 100 毫升"
          >
            <Ionicons name="add" size={20} color={palette.primary} />
          </TouchableOpacity>
        </View>
      </View>
      <ProgressTrack palette={palette} done={done} animatedPercentage={animatedPercentage} knobOpacity={knobOpacity} trackWidthRef={trackWidthRef} panResponder={panResponder} />

      {/* 🖊️ 手动输入水量弹窗 */}
      <Modal
        visible={inputVisible}
        transparent
        animationType="fade"
        onRequestClose={closeInput}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.modalCard, { backgroundColor: palette.card }]}>
            <Text style={[styles.modalTitle, { color: palette.textPrimary }]}>设置饮水量</Text>
            <Text style={[styles.modalHint, { color: palette.textSecondary }]}>
              范围 0 ~ {safeMaxWater} mL
            </Text>
            <View style={[styles.modalInputRow, { backgroundColor: palette.background }]}>
              <TextInput
                style={[styles.modalInput, { color: palette.textPrimary }]}
                value={inputText}
                onChangeText={(t) => setInputText(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                maxLength={5}
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                onSubmitEditing={submitInput}
                placeholder="0"
                placeholderTextColor={palette.textSecondary}
              />
              <Text style={[styles.modalUnit, { color: palette.textSecondary }]}>mL</Text>
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: palette.background }]}
                onPress={closeInput}
                activeOpacity={0.7}
              >
                <Text style={[styles.modalBtnText, { color: palette.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: palette.primary }]}
                onPress={submitInput}
                activeOpacity={0.7}
              >
                <Text style={[styles.modalBtnText, { color: '#FFFFFF' }]}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  knob: { position: 'absolute', width: 24, height: 24, borderRadius: 12, borderWidth: 4, marginLeft: -12 },

  // 🖊️ 手动输入弹窗
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  modalCard: {
    width: '100%',
    maxWidth: 320,
    borderRadius: SIZES.radiusList,
    padding: 20,
  },
  modalTitle: { fontSize: 17, fontWeight: '600', marginBottom: 4 },
  modalHint: { fontSize: 12, marginBottom: 14 },
  modalInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 52,
  },
  modalInput: { flex: 1, fontSize: 24, fontWeight: '700', padding: 0 },
  modalUnit: { fontSize: 15, fontWeight: '500', marginLeft: 6 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  modalBtn: { flex: 1, height: 44, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  modalBtnText: { fontSize: 15, fontWeight: '600' },
});
// --- END OF FILE WaterProgress.js ---