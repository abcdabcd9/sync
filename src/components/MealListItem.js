import React from 'react';
import { View, Text, StyleSheet, TouchableHighlight } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../context/ThemeContext';

export default function MealListItem({ meal, checked, onPress }) {
  const { isDark, colors: palette } = useAppTheme();

  return (
    <TouchableHighlight
      underlayColor={isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'}
      onPress={onPress}
    >
      <View style={styles.container}>
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
      </View>
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