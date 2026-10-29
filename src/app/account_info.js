// --- START OF FILE src/app/account_info.js ---
import React, { useState, useEffect } from 'react';
import { 
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Alert, Modal, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import { useAppTheme } from '../context/ThemeContext';
import { SIZES } from '../constants/theme'; 
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';

// 🔒 安全审计 #18：输入长度与格式的硬性约束（与数据库 CHECK 约束保持一致）
// 注：motto（首页寄语）的编辑入口在 settings.js，其长度校验在那边实现。
const NICKNAME_MAX = 20;
const SYNC_ID_MIN = 3;
const SYNC_ID_MAX = 15;
const SYNC_ID_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * 校验昵称：非空、≤20 字符
 * @returns {string|null} 错误提示，null 表示通过
 */
const validateNickname = (value) => {
  const v = (value || '').trim();
  if (!v) return '昵称不能为空。';
  if (v.length > NICKNAME_MAX) return `昵称最多 ${NICKNAME_MAX} 个字符，当前 ${v.length} 个。`;
  return null;
};

/**
 * 校验 Sync ID：3-15 字符，仅限字母、数字、下划线
 * @returns {string|null} 错误提示，null 表示通过
 */
const validateSyncId = (value) => {
  const v = (value || '').trim();
  if (!v) return 'Sync ID 不能为空。';
  if (v.length < SYNC_ID_MIN || v.length > SYNC_ID_MAX) {
    return `Sync ID 长度需为 ${SYNC_ID_MIN}-${SYNC_ID_MAX} 个字符，当前 ${v.length} 个。`;
  }
  if (!SYNC_ID_PATTERN.test(v)) return 'Sync ID 仅支持字母、数字与下划线（_），不能包含空格或特殊符号。';
  return null;
};

export default function AccountInfoScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter(); 
  const { user } = useAuth();

  const [profile, setProfile] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  const [activeModal, setActiveModal] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [boundPartnerName, setBoundPartnerName] = useState('未绑定');

  useEffect(() => {
    let isMounted = true;
    const fetchProfileData = async () => {
      if (!user) return;
      
      const { data: myProfile, error } = await supabase
        .from('profiles')
        .select('id, username, sync_id, nickname, last_id_modified_at')
        .eq('id', user.id)
        .single();

      if (!error && myProfile && isMounted) {
        setProfile({
          ...myProfile,
          sync_id: myProfile.sync_id || myProfile.username,
          nickname: myProfile.nickname || myProfile.username,
        });
      }

      try {
        const { data: partnerData } = await supabase.from('profiles').select('bound_partner_id').eq('id', user.id).single();
        if (partnerData?.bound_partner_id && isMounted) {
          const { data: pName } = await supabase.from('profiles').select('nickname, username').eq('id', partnerData.bound_partner_id).single();
          if (pName) setBoundPartnerName(pName.nickname || pName.username);
        } else if (isMounted) {
          setBoundPartnerName('未绑定');
        }
      } catch (e) {}

      if (isMounted) setLoadingProfile(false);
    };

    fetchProfileData();
    return () => { isMounted = false; };
  }, [user]);

  const handleCopyId = async () => {
    if (!profile?.sync_id) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await Clipboard.setStringAsync(profile.sync_id);
    Alert.alert('已复制', `你的 Sync ID: ${profile.sync_id}`);
  };

  // 🍎 修复点 1：将普通的函数升级为异步，挂载绝对时钟判定
  const openEditModal = async (type) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    // 严格的时间戳校验：一年仅限修改一次 Sync ID
    if (type === 'syncId' && profile?.last_id_modified_at) {
      
      // 🍎 第一阶段时空法则落实：向服务器索取绝对真理时间，如果弱网失败则降级本地时间（零崩溃铁律）
      const { data: serverTimeStr, error } = await supabase.rpc('get_server_time');
      const now = (error || !serverTimeStr) ? Date.now() : new Date(serverTimeStr).getTime();
      
      const lastModifiedDate = new Date(`${profile.last_id_modified_at}`).getTime();
      const diffMs = now - lastModifiedDate;
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;

      if (diffMs < oneYearMs) {
        const daysLeft = Math.ceil((oneYearMs - diffMs) / (1000 * 60 * 60 * 24));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('修改受限', `Sync ID 每年仅允许修改一次。\n\n距离下次可修改还剩 ${daysLeft} 天。`);
        return;
      }
    }

    setEditValue(type === 'nickname' ? profile?.nickname : profile?.sync_id);
    setActiveModal(type);
  };

  const handleSaveEdit = async () => {
    const newValue = editValue.trim();

    // 🔒 安全审计 #18：保存前硬校验（长度 + 格式），非法直接拦截并给出清晰提示
    if (activeModal === 'nickname') {
      const err = validateNickname(newValue);
      if (err) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('昵称格式错误', err);
        return;
      }
    } else if (activeModal === 'syncId') {
      const err = validateSyncId(newValue);
      if (err) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Sync ID 格式错误', err);
        return;
      }
    } else {
      return;
    }

    setIsSaving(true);
    
    let updatePayload = {};
    if (activeModal === 'nickname') {
      updatePayload = { nickname: newValue };
    } else if (activeModal === 'syncId') {
      
      // 🍎 修复点 2：保存入库时，同样使用绝对服务器时间戳，断绝篡改隐患
      const { data: serverTimeStr } = await supabase.rpc('get_server_time');
      const nowUtc = serverTimeStr || new Date().toISOString();
      
      updatePayload = { 
        sync_id: newValue, 
        last_id_modified_at: nowUtc
      };
    }

    const { error } = await supabase.from('profiles').update(updatePayload).eq('id', user.id);
    
    setIsSaving(false);

    if (error) {
      // 🔒 安全审计 #12：不再透传 error.message，避免泄露表名/约束名/SQL 细节
      if (error.code === '23505' && activeModal === 'syncId') {
        Alert.alert('修改失败', '该 ID 已被其他用户占用！');
      } else if (error.code === '23514' || error.code === '23502') {
        Alert.alert('修改失败', '内容格式不符合要求，请检查后重试。');
      } else if (error.code === '42501' || error.code === 'PGRST301') {
        Alert.alert('修改失败', '登录状态已失效，请重新登录。');
      } else {
        Alert.alert('修改失败', '修改失败，请稍后重试。');
      }
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setProfile({ ...profile, ...updatePayload });
      setActiveModal(null);
    }
  };

  // 下方的 return (UI部分) 原封不动，100%保留你的设计
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: palette.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={28} color={palette.primary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>个人信息</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {loadingProfile ? (
          <View style={{ marginTop: 40 }}><ActivityIndicator color={palette.primary} /></View>
        ) : (
          <View style={[styles.listContainer, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1 }]}>
            
            <View style={[styles.menuItem, { borderBottomColor: palette.separator, borderBottomWidth: StyleSheet.hairlineWidth }]}>
              <Text style={[styles.menuTitle, { color: palette.textPrimary }]}>头像</Text>
              <View style={styles.rightContent}>
                <View style={[styles.avatarBox, { backgroundColor: palette.primary }]}>
                  <Text style={styles.avatarText}>{profile?.nickname?.substring(0, 2).toUpperCase()}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} style={{ marginLeft: 8 }} />
              </View>
            </View>
            
            <TouchableOpacity style={[styles.menuItem, { borderBottomColor: palette.separator, borderBottomWidth: StyleSheet.hairlineWidth }]} onPress={() => openEditModal('nickname')} activeOpacity={0.6}>
              <Text style={[styles.menuTitle, { color: palette.textPrimary }]}>昵称</Text>
              <View style={styles.rightContent}>
                <Text style={[styles.menuValue, { color: palette.textSecondary }]}>{profile?.nickname}</Text>
                <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} style={{ marginLeft: 8 }} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.menuItem, { borderBottomColor: palette.separator, borderBottomWidth: StyleSheet.hairlineWidth }]} onPress={() => openEditModal('syncId')} onLongPress={handleCopyId} activeOpacity={0.6}>
              <Text style={[styles.menuTitle, { color: palette.textPrimary }]}>Sync ID</Text>
              <View style={styles.rightContent}>
                <Text style={[styles.menuValue, { color: palette.textSecondary }]}>{profile?.sync_id}</Text>
                <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} style={{ marginLeft: 8 }} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuItem} onPress={() => router.push('/bind_partner')} activeOpacity={0.6}>
              <Text style={[styles.menuTitle, { color: palette.textPrimary }]}>守护伴侣</Text>
              <View style={styles.rightContent}>
                <Text style={[styles.menuValue, { color: palette.textSecondary }]}>{boundPartnerName}</Text>
                <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} style={{ marginLeft: 8 }} />
              </View>
            </TouchableOpacity>

          </View>
        )}
      </ScrollView>

      <Modal visible={activeModal !== null} transparent animationType="fade" onRequestClose={() => setActiveModal(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
            <Text style={[styles.modalTitle, { color: palette.textPrimary }]}>
              {activeModal === 'nickname' ? '设置个性昵称' : '设置 Sync ID'}
            </Text>
            
            <TextInput
              style={[styles.modalInput, { backgroundColor: palette.background, color: palette.textPrimary, borderColor: palette.chatBorder }]}
              value={editValue}
              onChangeText={setEditValue}
              placeholderTextColor={palette.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={activeModal === 'nickname' ? NICKNAME_MAX : SYNC_ID_MAX}
            />

            {/* 🔒 安全审计 #18：实时字符计数 + 格式提示 */}
            <Text style={{ color: palette.textSecondary, fontSize: 12, textAlign: 'center', marginBottom: 12, paddingHorizontal: 24 }}>
              {activeModal === 'nickname'
                ? `${editValue.trim().length}/${NICKNAME_MAX} 字符`
                : `${editValue.trim().length}/${SYNC_ID_MAX} 字符 · 仅限字母、数字与下划线`}
            </Text>

            {activeModal === 'syncId' && (
              <Text style={{ color: palette.textSecondary, fontSize: 12, textAlign: 'center', marginBottom: 16, paddingHorizontal: 24 }}>
                注：Sync ID 是好友搜索添加的唯一凭证，每年仅允许修改一次。
              </Text>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtn} onPress={() => setActiveModal(null)}>
                <Text style={[styles.modalBtnText, { color: palette.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <View style={[styles.modalDivider, { backgroundColor: palette.separator }]} />
              <TouchableOpacity style={styles.modalBtn} onPress={handleSaveEdit} disabled={isSaving}>
                {isSaving ? <ActivityIndicator size="small" color={palette.primary} /> : <Text style={[styles.modalBtnText, { color: palette.primary, fontWeight: '600' }]}>保存</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { padding: 4, marginLeft: -8 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  scroll: { paddingHorizontal: SIZES.padding, paddingTop: 24, paddingBottom: 60 },
  listContainer: { borderRadius: SIZES.radiusList, overflow: 'hidden' },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, paddingHorizontal: 16, minHeight: 56 }, 
  menuTitle: { fontSize: 16, fontWeight: '500' },
  rightContent: { flexDirection: 'row', alignItems: 'center' },
  menuValue: { fontSize: 15, maxWidth: 150 },
  avatarBox: { width: 44, height: 44, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 }, 
  modalCard: { width: '100%', borderRadius: 20, borderWidth: 1, overflow: 'hidden', paddingTop: 24 }, 
  modalTitle: { fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 12 }, 
  modalInput: { marginHorizontal: 24, height: 44, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, marginBottom: 12 }, 
  modalActions: { flexDirection: 'row', height: 50, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(150,150,150,0.3)' }, 
  modalBtn: { flex: 1, justifyContent: 'center', alignItems: 'center' }, 
  modalBtnText: { fontSize: 17 }, 
  modalDivider: { width: StyleSheet.hairlineWidth, height: '100%' }
});
// --- END OF FILE src/app/account_info.js ---