// --- START OF FILE src/app/settings.js ---
import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, useColorScheme, Keyboard, ScrollView, Modal, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';

import { getPalette } from '../constants/colors';
import { SIZES } from '../constants/theme';
import { useHealthData } from '../hooks/useHealthData';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';

// --- 原生风格的设置项组件 ---
const SettingRow = ({ title, value, icon, iconBg, onPress, isDestructive, hideArrow, isFirst, isLast, palette }) => (
  <TouchableOpacity 
    style={[
      styles.settingRow, 
      { backgroundColor: palette.card },
      !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.separator },
      isFirst && { borderTopLeftRadius: SIZES.radiusList, borderTopRightRadius: SIZES.radiusList },
      isLast && { borderBottomLeftRadius: SIZES.radiusList, borderBottomRightRadius: SIZES.radiusList }
    ]} 
    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onPress?.(); }}
    activeOpacity={0.6}
  >
    <View style={styles.rowLeft}>
      {icon && (
        <View style={[styles.rowIconBox, { backgroundColor: iconBg || palette.primary }]}>
          <Ionicons name={icon} size={16} color="#FFF" />
        </View>
      )}
      <Text style={[styles.rowTitle, { color: isDestructive ? '#FF3B30' : palette.textPrimary }]}>{title}</Text>
    </View>
    <View style={styles.rowRight}>
      {value && <Text style={[styles.rowValue, { color: palette.textSecondary }]}>{value}</Text>}
      {!hideArrow && !isDestructive && <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} style={{ marginLeft: 6 }} />}
    </View>
  </TouchableOpacity>
);

export default function SettingsScreen() {
  const palette = getPalette(useColorScheme() === 'dark');
  const router = useRouter();
  const { signOut } = useAuth();
  
  // 健康数据 Hook
  const { maxWater, updateMaxWater, motto, updateMotto, mealGuides, updateMealGuide, resetToday } = useHealthData();
  const [localMotto, setLocalMotto] = useState(motto);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [editingMeal, setEditingMeal] = useState(null); 
  const [tempMealText, setTempMealText] = useState('');

  const isGoingBack = useRef(false);
  useEffect(() => { setLocalMotto(motto); }, [motto]);

  const handleBack = () => {
    if (isGoingBack.current) return;
    isGoingBack.current = true;
    Keyboard.dismiss(); 
    if (router.canGoBack()) router.back(); else router.replace('/profile');
    setTimeout(() => { isGoingBack.current = false; }, 500);
  };

  const handleSignOut = () => {
    Alert.alert('退出登录', '确定要断开云端连接吗？', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: async () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); await signOut(); router.replace('/auth'); }}
    ]);
  };

  const handleNotImplemented = (feature) => {
    Alert.alert('功能开发中', `[${feature}] 将在后续版本开放，敬请期待！`);
  };

  // --- 健康设置相关方法 ---
  const handleSaveMotto = () => { if (localMotto.trim() !== motto) updateMotto(localMotto.trim() || '今日概览'); };
  const handleAdjustWater = (delta) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); updateMaxWater(Math.max(500, Math.min(5000, maxWater + delta))); };
  const openMealEditor = (meal) => { setTempMealText(mealGuides[meal]); setEditingMeal(meal); };
  const saveMealEditor = () => { updateMealGuide(editingMeal, tempMealText); setEditingMeal(null); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.navBar}>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack} activeOpacity={0.6}>
            <Ionicons name="chevron-back" size={28} color={palette.primary} />
            <Text style={[styles.backText, { color: palette.primary }]}>返回</Text>
          </TouchableOpacity>
          <Text style={[styles.navTitle, { color: palette.textPrimary }]}>设置</Text>
          <View style={styles.rightPlaceholder} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          
          {/* 1. 账号栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary }]}>账号与安全</Text>
          <View style={styles.group}>
            <SettingRow title="个人资料" icon="person" iconBg="#0A84FF" onPress={() => router.push('/account_info')} isFirst palette={palette} />
            <SettingRow title="个人信息与权限" icon="shield-checkmark" iconBg="#34C759" onPress={() => handleNotImplemented('权限管理')} palette={palette} />
            <SettingRow title="账号安全" icon="lock-closed" iconBg="#5E5CE6" onPress={() => handleNotImplemented('账号安全与注销')} isLast palette={palette} />
          </View>

          {/* 2. 通用栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>通用</Text>
          <View style={styles.group}>
            <SettingRow title="通知" icon="notifications" iconBg="#FF3B30" onPress={() => handleNotImplemented('通知设置')} isFirst palette={palette} />
            <SettingRow title="界面与显示" icon="color-palette" iconBg="#FF9F0A" onPress={() => handleNotImplemented('界面外观')} palette={palette} />
            <SettingRow title="朋友权限" icon="people" iconBg="#32ADE6" onPress={() => handleNotImplemented('朋友圈与权限')} palette={palette} />
            <SettingRow title="存储空间" icon="server" iconBg="#8E8E93" value="1.2 GB" onPress={() => handleNotImplemented('存储管理')} palette={palette} />
            <SettingRow title="更多" icon="ellipsis-horizontal" iconBg="#BF5AF2" value="关怀模式" onPress={() => handleNotImplemented('更多通用设置')} isLast palette={palette} />
          </View>

          {/* 3. 功能栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>功能</Text>
          <View style={styles.group}>
            <SettingRow title="聊天设置" icon="chatbubbles" iconBg="#34C759" onPress={() => handleNotImplemented('聊天背景与听筒模式')} isFirst palette={palette} />
            <SettingRow title="健康与打卡偏好" icon="fitness" iconBg="#FF2D55" onPress={() => setShowHealthModal(true)} palette={palette} />
            <SettingRow title="自动下载设置" icon="cloud-download" iconBg="#0A84FF" onPress={() => handleNotImplemented('自动下载配置')} isLast palette={palette} />
          </View>

          {/* 4. 底部操作栏 */}
          <View style={[styles.group, { marginTop: 36, marginBottom: 40 }]}>
            <SettingRow title="切换账号" hideArrow onPress={() => handleNotImplemented('切换账号')} isFirst palette={palette} />
            <SettingRow title="退出登录" hideArrow isDestructive onPress={handleSignOut} isLast palette={palette} />
          </View>

        </ScrollView>
      </SafeAreaView>

      {/* --- 健康打卡偏好专属面板 (整合原 settings.js 的功能) --- */}
      <Modal visible={showHealthModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowHealthModal(false)}>
        <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top']}>
          <View style={[styles.navBar, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.separator }]}>
            <TouchableOpacity style={styles.backBtn} onPress={() => setShowHealthModal(false)}>
              <Text style={[styles.backText, { color: palette.textSecondary, marginLeft: 16 }]}>取消</Text>
            </TouchableOpacity>
            <Text style={[styles.navTitle, { color: palette.textPrimary }]}>健康与打卡偏好</Text>
            <View style={styles.rightPlaceholder} />
          </View>

          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
              <Text style={[styles.sectionTitle, { color: palette.textSecondary }]}>基础目标</Text>
              <View style={[styles.group, { backgroundColor: palette.card }]}>
                <View style={styles.customRow}>
                  <Text style={[styles.customRowLabel, { color: palette.textPrimary }]}>饮水目标</Text>
                  <View style={styles.stepper}>
                    <TouchableOpacity style={[styles.stepBtn, { backgroundColor: palette.background }]} onPress={() => handleAdjustWater(-100)}><Ionicons name="remove" size={16} color={palette.primary} /></TouchableOpacity>
                    <Text style={[styles.stepValue, { color: palette.textPrimary }]}>{maxWater} mL</Text>
                    <TouchableOpacity style={[styles.stepBtn, { backgroundColor: palette.background }]} onPress={() => handleAdjustWater(100)}><Ionicons name="add" size={16} color={palette.primary} /></TouchableOpacity>
                  </View>
                </View>
              </View>

              <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>个性化</Text>
              <View style={[styles.group, { backgroundColor: palette.card }]}>
                <View style={[styles.customRow, { borderBottomWidth: 0, paddingBottom: 4 }]}><Text style={[styles.customRowLabel, { color: palette.textPrimary }]}>首页寄语</Text></View>
                <View style={styles.inputRow}>
                  <TextInput style={[styles.input, { color: palette.primary }]} value={localMotto} onChangeText={setLocalMotto} onBlur={handleSaveMotto} returnKeyType="done" maxLength={15} placeholder="输入首页短句..." placeholderTextColor={palette.textSecondary} />
                </View>
              </View>

              <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>自定义食谱</Text>
              <View style={[styles.group, { backgroundColor: palette.card }]}>
                {['早餐', '午餐', '晚餐'].map((meal, index) => (
                  <View key={meal}>
                    <TouchableOpacity style={styles.customRow} onPress={() => openMealEditor(meal)} activeOpacity={0.6}>
                      <Text style={[styles.customRowLabel, { color: palette.textPrimary }]}>{meal}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Text style={{ fontSize: 15, color: palette.textSecondary }}>编辑内容</Text>
                        <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
                      </View>
                    </TouchableOpacity>
                    {index < 2 && <View style={[styles.rowSeparator, { backgroundColor: palette.separator }]} />}
                  </View>
                ))}
              </View>

              <View style={[styles.group, { backgroundColor: palette.card, marginTop: 32 }]}>
                <TouchableOpacity style={styles.customRow} onPress={() => { resetToday(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setShowHealthModal(false); }} activeOpacity={0.6}>
                  <Text style={[styles.customRowLabel, { color: palette.primary }]}>重置今日打卡数据</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      {/* 饮食编辑二级弹窗 */}
      <Modal visible={!!editingMeal} animationType="fade" transparent onRequestClose={() => setEditingMeal(null)}>
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%', alignItems: 'center' }}>
            <View style={[styles.editorCard, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
              <View style={[styles.editorHeader, { borderBottomColor: palette.separator }]}>
                <TouchableOpacity onPress={() => setEditingMeal(null)} style={{ padding: 8 }}><Text style={{ fontSize: 16, color: palette.textSecondary }}>取消</Text></TouchableOpacity>
                <Text style={{ fontSize: 17, fontWeight: '600', color: palette.textPrimary }}>编辑{editingMeal}</Text>
                <TouchableOpacity onPress={saveMealEditor} style={{ padding: 8 }}><Text style={{ fontSize: 16, fontWeight: '600', color: palette.primary }}>保存</Text></TouchableOpacity>
              </View>
              <TextInput style={[styles.editorInput, { color: palette.textPrimary }]} value={tempMealText} onChangeText={setTempMealText} multiline autoFocus placeholder={`编辑${editingMeal}内容...\n首行将作为高亮标题显示`} placeholderTextColor={palette.textSecondary} textAlignVertical="top" />
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 },
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44, paddingHorizontal: 8 },
  backBtn: { flexDirection: 'row', alignItems: 'center', width: 80 }, backText: { fontSize: 17, marginLeft: -4 },
  navTitle: { fontSize: 17, fontWeight: '600' }, rightPlaceholder: { width: 80 },
  scroll: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 60 }, 
  sectionTitle: { fontSize: 13, fontWeight: '400', textTransform: 'uppercase', marginBottom: 8, marginLeft: 16 },
  group: { borderRadius: SIZES.radiusList, overflow: 'hidden' },
  
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 16, minHeight: 52 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowIconBox: { width: 28, height: 28, borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  rowTitle: { fontSize: 16, fontWeight: '400' },
  rowRight: { flexDirection: 'row', alignItems: 'center' },
  rowValue: { fontSize: 15 },

  // 健康偏好面板样式
  customRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, paddingHorizontal: 16 },
  customRowLabel: { fontSize: 16, fontWeight: '400' }, 
  rowSeparator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  stepValue: { fontSize: 17, fontWeight: '600', minWidth: 85, textAlign: 'center' },
  inputRow: { paddingHorizontal: 16, paddingBottom: 16 }, 
  input: { fontSize: 17, fontWeight: '500', padding: 0 },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  editorCard: { width: '100%', borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  editorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  editorInput: { height: 200, fontSize: 16, lineHeight: 24, padding: 16 }
});
// --- END OF FILE src/app/settings.js ---