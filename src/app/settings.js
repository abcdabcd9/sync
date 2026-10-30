// --- START OF FILE src/app/settings.js ---
import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Keyboard, ScrollView, Modal, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';

import { SIZES } from '../constants/theme';
import { DEVICE_DATA_PROTECTION_NOTES } from '../constants/security';
import { useAppTheme } from '../context/ThemeContext';
import { useHealthData } from '../hooks/useHealthData';
import { useAuth } from '../hooks/useAuth';

// 🔒 安全审计 #18：首页寄语长度上限（与数据库 profiles_motto_length_check 保持一致）
const MOTTO_MAX = 50;

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
  const { colors: palette, themeMode, setThemeMode } = useAppTheme();
  const router = useRouter();
  const { signOut } = useAuth();
  
  // 健康数据 Hook
  const { maxWater, updateMaxWater, motto, updateMotto, mealGuides, updateMealGuide, resetToday } = useHealthData();
  const [localMotto, setLocalMotto] = useState(motto);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [editingMeal, setEditingMeal] = useState(null);
  const [tempMealText, setTempMealText] = useState('');

  // 🔒 安全审计 #29：合规弹窗（隐私政策 / 账号安全），App Store 审核必查项
  const [legalModal, setLegalModal] = useState(null); // 'privacy' | 'security' | null

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

  // 🔒 安全审计 #29：隐私政策与数据使用说明（健康数据 + 聊天信息的合规使用）
  const PRIVACY_SECTIONS = [
    {
      title: '我们收集哪些数据',
      body: '· 账号信息：邮箱、昵称、Sync ID\n· 健康数据：饮水目标、三餐打卡记录、连续打卡天数\n· 聊天数据：文字、语音、图片、视频消息及发送时间\n· 设备信息：推送令牌（仅用于消息通知）',
    },
    {
      title: '健康数据如何使用',
      body: '健康与打卡数据仅用于为你生成每日进度、连续打卡统计，并在你绑定「健康搭子」后与对方同步打卡状态。我们不会将健康数据用于广告投放，也不会出售给任何第三方。',
    },
    {
      title: '聊天信息如何使用',
      body: '聊天消息通过 Supabase 加密传输并存储，仅你与对话双方可见。消息内容不会用于训练模型或人工审阅，除非依据法律法规要求配合调查。',
    },
    {
      title: '数据存储与保留',
      body: '数据存储于 Supabase 云端数据库。你随时可以在「账号安全」中注销账号，注销后所有聊天记录、图片、健康数据及好友关系将被永久删除且不可恢复。',
    },
    {
      title: '你的权利',
      body: '你有权访问、更正、导出及删除自己的全部数据。如需行使上述权利，可通过「个人资料」页面修改信息，或直接注销账号完成彻底删除。',
    },
  ];

  // 🔒 安全审计 #29：账号安全说明
  const SECURITY_SECTIONS = [
    {
      title: '登录与会话安全',
      body: '账号使用邮箱 + 密码登录，密码要求至少 8 位且包含字母与数字。登录凭证由 Supabase Auth 托管，本地仅保存加密后的会话令牌。',
    },
    {
      title: '推送通知安全',
      body: '推送令牌仅存储在服务端，客户端无法读取他人令牌。所有推送请求必须携带有效登录凭证，并由服务端校验双方社交关系后才允许发送。',
    },
    {
      title: '数据清除',
      body: '如需清除本机缓存数据，可在「健康与打卡偏好」中重置今日打卡数据；如需彻底删除云端全部数据，请前往「我的 → 注销账号」，该操作需二次确认且不可逆。',
    },
    {
      title: '注销账号',
      body: '注销将永久删除账号、聊天记录、媒体文件、健康数据与好友关系。为防误触，注销流程包含两次确认弹窗，确认后立即执行且无法撤销。',
    },
    // 🔒 安全审计 #26：设备敏感数据保护说明（文案源：src/constants/security.js）
    ...DEVICE_DATA_PROTECTION_NOTES,
  ];

  // 🎨 主题模式切换（跟随系统 / 浅色 / 深色）
  const THEME_OPTIONS = [
    { key: 'system', label: '跟随系统', icon: 'phone-portrait-outline' },
    { key: 'light', label: '浅色', icon: 'sunny-outline' },
    { key: 'dark', label: '深色', icon: 'moon-outline' },
  ];
  const currentThemeLabel = THEME_OPTIONS.find(o => o.key === themeMode)?.label || '跟随系统';

  const handlePickTheme = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(
      '外观模式',
      '选择 App 的显示主题',
      [
        ...THEME_OPTIONS.map(opt => ({
          text: opt.label + (opt.key === themeMode ? '  ✓' : ''),
          onPress: () => {
            setThemeMode(opt.key);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        })),
        { text: '取消', style: 'cancel' },
      ]
    );
  };

  // --- 健康设置相关方法 ---
  // 🔒 安全审计 #18：寄语长度硬校验（与数据库 profiles_motto_length_check 保持一致）
  const handleSaveMotto = () => {
    const next = localMotto.trim();
    if (next.length > MOTTO_MAX) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('寄语过长', `首页寄语最多 ${MOTTO_MAX} 个字符，当前 ${next.length} 个。`);
      // 回滚到已保存的值，避免超长文本被写入本地与云端
      setLocalMotto(motto);
      return;
    }
    if (next !== motto) updateMotto(next || '今日概览');
  };
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
            {/* 🔒 安全审计 #29：真实交互，弹出隐私政策与数据使用说明 */}
            <SettingRow title="个人信息与权限" icon="shield-checkmark" iconBg="#34C759" onPress={() => setLegalModal('privacy')} palette={palette} />
            {/* 🔒 安全审计 #29：真实交互，弹出账号安全与数据清除说明 */}
            <SettingRow title="账号安全" icon="lock-closed" iconBg="#5E5CE6" onPress={() => setLegalModal('security')} isLast palette={palette} />
          </View>

          {/* 2. 通用栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>通用</Text>
          <View style={styles.group}>
            <SettingRow title="通知" icon="notifications" iconBg="#FF3B30" onPress={() => handleNotImplemented('通知设置')} isFirst palette={palette} />
            <SettingRow title="外观模式" icon="color-palette" iconBg="#FF9F0A" value={currentThemeLabel} onPress={handlePickTheme} palette={palette} />
            <SettingRow title="朋友权限" icon="people" iconBg="#32ADE6" onPress={() => router.push('/settings/privacy')} palette={palette} />
            <SettingRow title="存储空间" icon="server" iconBg="#8E8E93" onPress={() => router.push('/settings/storage')} palette={palette} />
            <SettingRow title="更多" icon="ellipsis-horizontal" iconBg="#BF5AF2" onPress={() => router.push('/settings/more')} isLast palette={palette} />
          </View>

          {/* 3. 功能栏 */}
          <Text style={[styles.sectionTitle, { color: palette.textSecondary, marginTop: 24 }]}>功能</Text>
          <View style={styles.group}>
            <SettingRow title="聊天设置" icon="chatbubbles" iconBg="#34C759" onPress={() => router.push('/settings/chat')} isFirst palette={palette} />
            <SettingRow title="健康与打卡偏好" icon="fitness" iconBg="#FF2D55" onPress={() => setShowHealthModal(true)} palette={palette} />
            <SettingRow title="自动下载设置" icon="cloud-download" iconBg="#0A84FF" onPress={() => router.push('/settings/download')} isLast palette={palette} />
          </View>

          {/* 4. 底部操作栏 */}
          <View style={[styles.group, { marginTop: 36, marginBottom: 40 }]}>
            <SettingRow title="切换账号" hideArrow onPress={() => handleNotImplemented('切换账号')} isFirst palette={palette} />
            <SettingRow title="退出登录" hideArrow isDestructive onPress={handleSignOut} isLast palette={palette} />
          </View>

        </ScrollView>
      </SafeAreaView>

      {/* --- 🔒 安全审计 #29：隐私政策 / 账号安全 合规弹窗（App Store 审核必查） --- */}
      <Modal
        visible={!!legalModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setLegalModal(null)}
      >
        <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top']}>
          <View style={[styles.navBar, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.separator }]}>
            <TouchableOpacity style={styles.backBtn} onPress={() => setLegalModal(null)} activeOpacity={0.6}>
              <Text style={[styles.backText, { color: palette.primary, marginLeft: 16 }]}>关闭</Text>
            </TouchableOpacity>
            <Text style={[styles.navTitle, { color: palette.textPrimary }]}>
              {legalModal === 'security' ? '账号安全' : '隐私政策与数据使用说明'}
            </Text>
            <View style={styles.rightPlaceholder} />
          </View>

          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <Text style={[styles.legalIntro, { color: palette.textSecondary }]}>
              {legalModal === 'security'
                ? '我们采用业界通行的安全措施保护你的账号与数据。以下说明帮助你了解账号安全机制与数据清除方式。'
                : '我们深知个人信息对你的重要性，并会尽全力保护你的个人信息安全。本说明将帮助你了解我们如何收集、使用、存储与保护你的信息。'}
            </Text>

            {(legalModal === 'security' ? SECURITY_SECTIONS : PRIVACY_SECTIONS).map((section, index, arr) => (
              <View
                key={section.title}
                style={[
                  styles.legalCard,
                  { backgroundColor: palette.card, borderColor: palette.cardBorder },
                  index === arr.length - 1 && { marginBottom: 32 },
                ]}
              >
                <View style={styles.legalCardHeader}>
                  <View style={[styles.legalDot, { backgroundColor: legalModal === 'security' ? '#5E5CE6' : '#34C759' }]} />
                  <Text style={[styles.legalCardTitle, { color: palette.textPrimary }]}>{section.title}</Text>
                </View>
                <Text style={[styles.legalCardBody, { color: palette.textSecondary }]}>{section.body}</Text>
              </View>
            ))}

            <Text style={[styles.legalFooter, { color: palette.textSecondary }]}>
              最后更新：2026 年 10 月{'\n'}如对本说明有任何疑问，可通过「个人资料」页面联系我们。
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

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
                  <TextInput style={[styles.input, { color: palette.primary }]} value={localMotto} onChangeText={setLocalMotto} onBlur={handleSaveMotto} returnKeyType="done" maxLength={MOTTO_MAX} placeholder="输入首页短句..." placeholderTextColor={palette.textSecondary} />
                </View>
                {/* 🔒 安全审计 #18：实时字符计数，接近上限时给出提示 */}
                <Text style={{ color: localMotto.trim().length > MOTTO_MAX ? '#FF3B30' : palette.textSecondary, fontSize: 12, textAlign: 'right', paddingHorizontal: 16, paddingBottom: 10 }}>
                  {localMotto.trim().length}/{MOTTO_MAX}
                </Text>
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

  // 🔒 安全审计 #29：合规弹窗样式
  legalIntro: { fontSize: 13, lineHeight: 20, marginBottom: 16, paddingHorizontal: 4 },
  legalCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  legalCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  legalDot: { width: 6, height: 6, borderRadius: 3, marginRight: 8 },
  legalCardTitle: { fontSize: 15, fontWeight: '600' },
  legalCardBody: { fontSize: 13, lineHeight: 21 },
  legalFooter: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 8, marginBottom: 40, paddingHorizontal: 8 },

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