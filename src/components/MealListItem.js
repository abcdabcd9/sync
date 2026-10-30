import React, { useState } from 'react';
import { Animated, View, Text, StyleSheet, TouchableHighlight } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../context/ThemeContext';
import { DURATION, SCALE } from '../constants/motion';
import { haptic } from '../constants/haptics';

// 动画走 RN 内置 Animated + useNativeDriver，不依赖 Reanimated
export default function MealListItem({ meal, checked, onPress }) {
  const { isDark, colors: palette } = useAppTheme();
  const [scale] = useState(() => new Animated.Value(1));

  const animateTo = (to) => {
    Animated.timing(scale, {
      toValue: to,
      duration: DURATION.instant,
      useNativeDriver: true,
    }).start();
  };

  const handlePress = () => {
    if (checked) haptic.success();
    else haptic.light();
    if (onPress) onPress();
  };

  return (
    <TouchableHighlight
      underlayColor={isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'}
      onPress={handlePress}
      onPressIn={() => animateTo(SCALE.pressIn)}
      onPressOut={() => animateTo(SCALE.pressOut)}
    >
      <Animated.View style={[styles.container, { transform: [{ scale }] }]}>
        <View style={styles.leftContent}>
          <View style={[
            styles.iconBox, 
            checked 
              ? { backgroundColor: palette.checkBg, borderWidth: 0 } 
              : { backgroundColor: 'transparent', borderColor: palette.checkRing, borderWidth: 1.5 }
          ]}>
            {checked && <Ionicons name="checkmark" size={18} color="#FFFFFF" />}
          </View>
          <Text style={[styles.title, { color: palette.textPrimary }]}>{meal}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
      </Animated.View>
    </TouchableHighlight>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12, 
    paddingHorizontal: 16,
    minHeight: 52, 
  },
  leftContent: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 14 
  },
  iconBox: { 
    width: 28, 
    height: 28, 
    borderRadius: 14, 
    justifyContent: 'center', 
    alignItems: 'center' 
  },
  title: { 
    fontSize: 17, 
    fontWeight: '500', 
    letterSpacing: -0.41 
  },
});
