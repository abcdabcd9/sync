import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, StyleSheet, useColorScheme, TouchableOpacity, Pressable, Animated, Platform } from 'react-native';
import { getPalette } from '../constants/colors';
import { useHealthData } from '../hooks/useHealthData';

export default function MealDetailSheet({ meal, checked, onClose, onConfirm, onUndo }) {
  const palette = getPalette(useColorScheme() === 'dark');
  const { mealGuides } = useHealthData();
  
  const [isVisible, setIsVisible] = useState(false);
  const [internalMeal, setInternalMeal] = useState(null);

  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (meal) {
      setInternalMeal(meal);
      setIsVisible(true);
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, friction: 7, tension: 50, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 200, useNativeDriver: true })
      ]).start();
    }
  }, [meal, scaleAnim, opacityAnim]);

  const handleClose = () => {
    Animated.parallel([
      // 强制统一：全部使用 useNativeDriver: true，绝不越界
      Animated.spring(scaleAnim, { toValue: 0.9, friction: 7, tension: 50, useNativeDriver: true }),
      Animated.timing(opacityAnim, { toValue: 0, duration: 200, useNativeDriver: true }) 
    ]).start(() => {
      setIsVisible(false);
      onClose(); 
    });
  };

  const handleAction = () => {
    if (checked) onUndo();
    else onConfirm();
    handleClose(); 
  };

  const guideText = internalMeal && mealGuides ? mealGuides[internalMeal] : '';
  const lines = guideText ? guideText.split('\n').filter(line => line.trim() !== '') : [];
  const rule = lines.length > 0 ? lines[0] : '暂无饮食建议';
  const bullets = lines.slice(1);

  return (
    <Modal visible={isVisible} transparent animationType="none" onRequestClose={handleClose}>
      {/* 巧妙修复：直接对带有深色背景的父容器应用 opacity 动画，完美兼容 Native Driver */}
      <Animated.View style={[styles.overlay, { opacity: opacityAnim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        
        <Animated.View 
          style={[
            styles.card, 
            { backgroundColor: palette.card, transform: [{ scale: scaleAnim }] }
          ]} 
        >
          <Pressable onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.title, { color: palette.textPrimary }]}>{internalMeal} 饮食建议</Text>
            
            <View style={[styles.guideBox, { backgroundColor: palette.background }]}>
              <Text style={[styles.rule, { color: palette.primary }]}>{rule}</Text>
              
              {bullets.length > 0 ? bullets.map((line, index) => (
                <Text key={index} style={[styles.line, { color: palette.textPrimary }]}>{line}</Text>
              )) : (
                <Text style={[styles.line, { color: palette.textSecondary, textAlign: 'center' }]}>
                  请前往“我的 - 偏好设置”定制专属食谱
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: checked ? palette.background : palette.primary }]}
              onPress={handleAction}
            >
              <Text style={[styles.actionText, { color: checked ? palette.primary : '#FFFFFF' }]}>
                {checked ? '撤销打卡' : '确认打卡'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Animated.View>
        
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.45)', // 静态背景色移至此处
    justifyContent: 'center', 
    alignItems: 'center', 
    padding: 24 
  },
  card: { 
    width: '100%', 
    borderRadius: 24, 
    padding: 24, 
    ...Platform.select({
      ios: {
        shadowColor: '#000', 
        shadowOffset: { width: 0, height: 12 }, 
        shadowOpacity: 0.2, 
        shadowRadius: 24, 
      },
      android: {
        elevation: 0, 
      }
    })
  },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: 0.35, marginBottom: 20, textAlign: 'center' },
  guideBox: { padding: 16, borderRadius: 12, marginBottom: 24 },
  rule: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  line: { fontSize: 14, lineHeight: 24, letterSpacing: -0.24, marginBottom: 4 },
  actionBtn: { height: 50, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  actionText: { fontSize: 17, fontWeight: '600', letterSpacing: -0.41 },
});