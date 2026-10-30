// --- START OF FILE src/app/settings/health.js ---
import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAppTheme } from '../../context/ThemeContext';
import { useHealthData } from '../../hooks/useHealthData';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// 🔒 安全审计 #18：首页寄语长度上限（与数据库 profiles_motto_length_check 保持一致）
const MOTTO_MAX = 50;

export default function HealthSettingsScreen() {
  const { colors } = useAppTheme();
  const { maxWater, updateMaxWater, motto, updateMotto, mealGuides, updateMealGuide, resetToday } =
    useHealthData();

  const [localMotto, setLocalMotto] = useState(motto);
  const [editingMeal, setEditingMeal] = useState(null);
  const [tempMealText, setTempMealText] = useState('');

  const handleAdjustWater = (delta) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    updateMaxWater(Math.max(500, Math.min(5000, maxWater + delta)));
  };

  // 🔒 安全审计 #18：寄语长度硬校验（与数据库 profiles_motto_length_check 保持一致）
  const handleSaveMotto = () => {
    const next = localMotto.trim();
    if (next.length > MOTTO_MAX) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('寄语过长', `首页寄语最多 ${MOTTO_MAX} 个字符，当前 ${next.length} 个。`);
      setLocalMotto(motto);
      return;
    }
    if (next !== motto) updateMotto(next || '今日概览');
  };

  const openMealEditor = (meal) => {
    setTempMealText(mealGuides[meal]);
    setEditingMeal(meal);
  };

  const saveMealEditor = () => {
    updateMealGuide(editingMeal, tempMealText);
    setEditingMeal(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleResetToday = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert('重置今日打卡数据', '将清空今天的饮水与三餐打卡记录，此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '重置',
        style: 'destructive',
        onPress: () => {
          resetToday();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  };

  const isMottoOverLimit = localMotto.trim().length > MOTTO_MAX;

  return (
    <SettingsPage title="健康与打卡偏好">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GroupTitle>基础目标</GroupTitle>
        <Group>
          <View style={styles.customRow}>
            <Text style={[styles.customRowLabel, { color: colors.textPrimary }]}>饮水目标</Text>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={[styles.stepBtn, { backgroundColor: colors.background }]}
                onPress={() => handleAdjustWater(-100)}
                activeOpacity={0.6}
              >
                <Ionicons name="remove" size={16} color={colors.primary} />
              </TouchableOpacity>
              <Text style={[styles.stepValue, { color: colors.textPrimary }]}>{maxWater} mL</Text>
              <TouchableOpacity
                style={[styles.stepBtn, { backgroundColor: colors.background }]}
                onPress={() => handleAdjustWater(100)}
                activeOpacity={0.6}
              >
                <Ionicons name="add" size={16} color={colors.primary} />
              </TouchableOpacity>
            </View>
          </View>
        </Group>

        <GroupTitle>个性化</GroupTitle>
        <Group>
          <View style={[styles.customRow, { borderBottomWidth: 0, paddingBottom: 4 }]}>
            <Text style={[styles.customRowLabel, { color: colors.textPrimary }]}>首页寄语</Text>
          </View>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, { color: colors.primary }]}
              value={localMotto}
              onChangeText={setLocalMotto}
              onBlur={handleSaveMotto}
              returnKeyType="done"
              maxLength={MOTTO_MAX}
              placeholder="输入首页短句..."
              placeholderTextColor={colors.textSecondary}
            />
          </View>
          {/* 🔒 安全审计 #18：实时字符计数，接近上限时给出提示 */}
          <Text
            style={[
              styles.counter,
              { color: isMottoOverLimit ? '#FF3B30' : colors.textSecondary },
            ]}
          >
            {localMotto.trim().length}/{MOTTO_MAX}
          </Text>
        </Group>

        <GroupTitle>自定义食谱</GroupTitle>
        <Group>
          {['早餐', '午餐', '晚餐'].map((meal, index) => (
            <View key={meal}>
              <TouchableOpacity
                style={styles.customRow}
                onPress={() => openMealEditor(meal)}
                activeOpacity={0.6}
              >
                <Text style={[styles.customRowLabel, { color: colors.textPrimary }]}>{meal}</Text>
                <View style={styles.rowRight}>
                  <Text style={[styles.rowValue, { color: colors.textSecondary }]}>编辑内容</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </View>
              </TouchableOpacity>
              {index < 2 && (
                <View style={[styles.rowSeparator, { backgroundColor: colors.separator }]} />
              )}
            </View>
          ))}
        </Group>

        <Group style={{ marginTop: 32 }}>
          <TouchableOpacity style={styles.customRow} onPress={handleResetToday} activeOpacity={0.6}>
            <Text style={[styles.customRowLabel, { color: colors.primary }]}>重置今日打卡数据</Text>
          </TouchableOpacity>
        </Group>
      </KeyboardAvoidingView>

      {/* 饮食编辑二级弹窗 */}
      {!!editingMeal && (
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.modalCenter}
          >
            <View
              style={[styles.editorCard, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
            >
              <View style={[styles.editorHeader, { borderBottomColor: colors.separator }]}>
                <TouchableOpacity onPress={() => setEditingMeal(null)} style={styles.editorBtn}>
                  <Text style={[styles.editorBtnText, { color: colors.textSecondary }]}>取消</Text>
                </TouchableOpacity>
                <Text style={[styles.editorTitle, { color: colors.textPrimary }]}>
                  编辑{editingMeal}
                </Text>
                <TouchableOpacity onPress={saveMealEditor} style={styles.editorBtn}>
                  <Text style={[styles.editorSave, { color: colors.primary }]}>保存</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={[styles.editorInput, { color: colors.textPrimary }]}
                value={tempMealText}
                onChangeText={setTempMealText}
                multiline
                autoFocus
                placeholder={`编辑${editingMeal}内容...\n首行将作为高亮标题显示`}
                placeholderTextColor={colors.textSecondary}
                textAlignVertical="top"
              />
            </View>
          </KeyboardAvoidingView>
        </View>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  customRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  customRowLabel: { fontSize: 16, fontWeight: '400' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowValue: { fontSize: 15 },
  rowSeparator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  stepValue: { fontSize: 17, fontWeight: '600', minWidth: 85, textAlign: 'center' },
  inputRow: { paddingHorizontal: 16, paddingBottom: 16 },
  input: { fontSize: 17, fontWeight: '500', padding: 0 },
  counter: { fontSize: 12, textAlign: 'right', paddingHorizontal: 16, paddingBottom: 10 },

  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCenter: { width: '100%', alignItems: 'center' },
  editorCard: { width: '100%', borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editorBtn: { padding: 8 },
  editorBtnText: { fontSize: 16 },
  editorTitle: { fontSize: 17, fontWeight: '600' },
  editorSave: { fontSize: 16, fontWeight: '600' },
  editorInput: { height: 200, fontSize: 16, lineHeight: 24, padding: 16 },
});
// --- END OF FILE src/app/settings/health.js ---
