// --- START OF FILE src/app/account_info.js ---
import React, { useState, useEffect, useCallback } from 'react';
import { 
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Alert, Modal, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { SIZES } from '../constants/theme';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';
import { readProfileCache, writeProfileCache, normalizeProfile } from '../hooks/profile/useProfileCache';

// 🔒 安全审计 #18：输入长度与格式的硬性约束（与数据库 CHECK 约束保持一致）
// 注：motto（首页寄语）的编辑入口在 settings.js，其长度校验在那边实现。
const NICKNAME_MAX = 20;
const SYNC_ID_MIN = 3;
const SYNC_ID_MAX = 15;
const SYNC_ID_PATTERN = /^[A-Za-z0-9_]+$/;

// 云端 profiles 查询超时（毫秒）。超时即降级到本地缓存，绝不让界面永久转圈。
const PROFILE_FETCH_TIMEOUT_MS = 8000;

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

  // 用 ref 持有最新 profile，避免在 effect 依赖里引入 profile 导致重复拉取
  const profileRef = React.useRef(null);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    let isMounted = true;
    const fetchProfileData = async () => {
      if (!user) {
        if (isMounted) setLoadingProfile(false);
        return;
      }

      // 1️⃣ 第 0 帧：本地缓存优先，命中即秒开（断网也能显示昵称 / Sync ID）
      const cached = await readProfileCache(user.id);
      if (cached && isMounted) {
        setProfile(cached);
        setLoadingProfile(false);
      }

      // 2️⃣ 云端刷新：任何异常都只降级，绝不清空 profile
      //    ⚠️ 必须带超时保护：Supabase 请求若挂住（弱网 / DNS 卡死），
      //    裸 await 会让 loadingProfile 永远为 true，界面永久转圈。
      try {
        const queryPromise = supabase
          .from('profiles')
          .select('id, username, sync_id, nickname, last_id_modified_at')
          .eq('id', user.id)
          .single();

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('profile-fetch-timeout')), PROFILE_FETCH_TIMEOUT_MS);
        });

        const { data: myProfile, error } = await Promise.race([queryPromise, timeoutPromise]);

        if (error) throw error;

        if (myProfile) {
          const nextProfile = normalizeProfile(myProfile);
          if (isMounted) setProfile(nextProfile);
          // 云端成功 → 回写缓存，供下次冷启动秒开
          writeProfileCache(nextProfile);
        }
      } catch (e) {
        console.warn('离线状态，继续使用本地缓存的个人资料', e?.message ?? e);
      }

      // 💞 第 0 步：本地缓存优先恢复搭子昵称（零网络，断网也能 0 秒显示，绝不误显示“未绑定”）
      //    数据源优先级：@user_profile_cache.bound_partner_nickname
      //                → @friends_list_${user.id}（useChatList 写入）→ @chatList_${user.id}（会话列表缓存）
      let cachedPartnerName = cached?.bound_partner_nickname || null;
      try {
        const cachedPartnerId = cached?.bound_partner_id || null;
        if (cachedPartnerId && !cachedPartnerName) {
          const friendsRaw = await AsyncStorage.getItem(`@friends_list_${user.id}`);
          const cachedFriends = friendsRaw ? JSON.parse(friendsRaw) : null;
          if (Array.isArray(cachedFriends)) {
            const hit = cachedFriends.find((f) => f && f.id === cachedPartnerId);
            if (hit) cachedPartnerName = hit.nickname || hit.username || null;
          }

          // 兜底：老版本只写过 @chatList_，其中 friends 字段同样保存了好友资料
          if (!cachedPartnerName) {
            const chatListRaw = await AsyncStorage.getItem(`@chatList_${user.id}`);
            const cachedChatList = chatListRaw ? JSON.parse(chatListRaw) : null;
            if (cachedChatList && Array.isArray(cachedChatList.friends)) {
              const hit = cachedChatList.friends.find((f) => f && f.id === cachedPartnerId);
              if (hit) cachedPartnerName = hit.nickname || hit.username || null;
            }
          }
        }
      } catch (cacheError) {
        console.warn('⚠️ 读取本地好友缓存（搭子昵称）失败:', cacheError?.message ?? cacheError);
      }

      // 缓存命中 → 立即渲染搭子昵称，无需等待网络
      if (cachedPartnerName && isMounted) {
        setBoundPartnerName(cachedPartnerName);
      }

      try {
        const { data: partnerData } = await supabase.from('profiles').select('bound_partner_id').eq('id', user.id).single();
        if (partnerData?.bound_partner_id && isMounted) {
          const { data: pName } = await supabase.from('profiles').select('nickname, username').eq('id', partnerData.bound_partner_id).single();
          if (pName) {
            const partnerName = pName.nickname || pName.username;
            setBoundPartnerName(partnerName);
            // 💾 云端成功 → 把伴侣昵称一并写入 @user_profile_cache，下次断网可直接展示
            if (partnerName) {
              writeProfileCache({
                ...(cached || {}),
                ...(profileRef.current || {}),
                id: user.id,
                bound_partner_id: partnerData.bound_partner_id,
                bound_partner_nickname: partnerName,
              });
            }
          }
        } else if (isMounted) {
          // 🔒 离线保护锁：只要本地缓存里存在 bound_partner_id，就绝不渲染“未绑定”
          const hasBoundPartner = Boolean(cached?.bound_partner_id || cachedPartnerName);
          if (!hasBoundPartner) {
            setBoundPartnerName('未绑定');
          }
        }
      } catch {
        // 伴侣信息拉取失败（离线/超时）→ 静默降级，不影响个人资料展示
        // 🔒 离线保护锁：保留本地缓存恢复的搭子昵称，绝不重置为“未绑定”
        if (!cachedPartnerName) {
          console.warn('离线，搭子昵称暂用本地缓存');
        }
      }

      // 🔒 最终兜底：只要 bound_partner_id 存在，就绝不允许界面停留在“未绑定”
      if (isMounted) {
        const finalPartnerId = cached?.bound_partner_id || profileRef.current?.bound_partner_id || null;
        if (finalPartnerId) {
          setBoundPartnerName((prev) => (prev && prev !== '未绑定' ? prev : '守护伴侣'));
        }
      }

      if (isMounted) setLoadingProfile(false);
    };

    fetchProfileData();
    return () => { isMounted = false; };
  }, [user]);

  // =========================================================================
  // 💞 守护伴侣绑定关系 + 对方昵称的同步策略
  // =========================================================================
  // 场景：
  //   1. 我在别的设备/别处绑定了搭子 → 本页「守护伴侣」行显示对方名字
  //   2. 对方解绑 → 本页回到「未绑定」
  //   3. 对方改昵称 → 本页显示的名字更新
  //
  // 🔒 H-3 安全加固：不再订阅 profiles 的 Realtime 广播
  //   原实现订阅 `{ event: 'UPDATE', table: 'profiles' }`（无 filter），
  //   意味着**全站任何用户改资料**都会触发本页重查。
  //   而 profiles 的 SELECT 策略是 USING (true)（搜人必需），
  //   等于任何登录用户都能收到全站用户资料变更的事件流。
  //   迁移 16_Realtime白名单 已把 profiles 移出 publication。
  //
  //   为什么不能改成 filter: id=eq.<自己>：
  //   伴侣的昵称存在「伴侣自己的 profiles 行」里，只订阅自己那一行
  //   收不到对方改名；而伴侣 id 是动态的，无法在订阅时静态确定。
  //   Realtime 的 filter 只支持单值 eq，也无法表达「我 + 我的伴侣」两行。
  //
  //   替代方案（本 effect）：
  //   · 页面重新获得焦点时重查一次（useFocusEffect）—— 覆盖「对方改昵称」
  //   · 绑定/解绑动作本身在本地立即刷新（bind_partner / ChatRoomInner
  //     已调用 refreshPartner，本页返回时焦点刷新即可拿到最新值）
  //   · 下拉刷新 / 重新进入本页
  //   伴侣关系变更是低频事件，焦点刷新足够，且不产生任何全站广播。
  //
  // ⚠️ 为什么重查而不是用 payload：
  //   「守护伴侣」需要两跳查询（我的 bound_partner_id → 伴侣的 nickname），
  //   重新查一次最简单可靠。
  const syncPartner = useCallback(async () => {
    if (!user?.id) return;
    const currentUserId = user.id;

    try {
      const { data: mine } = await supabase
        .from('profiles')
        .select('id, username, sync_id, nickname, last_id_modified_at, bound_partner_id')
        .eq('id', currentUserId)
        .single();

      if (!mine) return;

      // 自己的资料（昵称 / Sync ID）同步到界面
      const nextProfile = normalizeProfile(mine);
      setProfile(nextProfile);
      writeProfileCache(nextProfile);

      // 伴侣昵称：两跳查询
      if (mine.bound_partner_id) {
        const { data: partner } = await supabase
          .from('profiles')
          .select('nickname, username')
          .eq('id', mine.bound_partner_id)
          .single();
        const partnerName = partner?.nickname || partner?.username;
        if (partnerName) {
          setBoundPartnerName(partnerName);
          writeProfileCache({
            ...nextProfile,
            bound_partner_id: mine.bound_partner_id,
            bound_partner_nickname: partnerName,
          });
        } else {
          setBoundPartnerName('守护伴侣');
        }
      } else {
        // 已解绑 → 回到「未绑定」
        setBoundPartnerName('未绑定');
        writeProfileCache({
          ...nextProfile,
          bound_partner_id: null,
          bound_partner_nickname: null,
        });
      }
    } catch (e) {
      // 同步失败不影响主流程，静默降级
      console.warn('守护伴侣同步失败:', e?.message ?? e);
    }
  }, [user]);

  // 每次页面获得焦点时同步一次（替代原 Realtime 订阅）
  useFocusEffect(
    useCallback(() => {
      syncPartner();
    }, [syncPartner])
  );

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
      // 🍎 P2-18：后端触发器拦截「未满一年修改 Sync ID」时抛出 23514，需单独给出明确提示
      const isSyncIdLimitError =
        activeModal === 'syncId' &&
        (error.code === '23514' || /sync.?id|一年|year/i.test(error.message || ''));

      if (isSyncIdLimitError) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('修改失败', 'Sync ID 每年仅可修改一次');
        return;
      } else if (error.code === '23505' && activeModal === 'syncId') {
        Alert.alert('修改失败', '该 ID 已被其他用户占用！');
      } else if (error.code === '23514' || error.code === '23502') {
        Alert.alert('修改失败', '内容格式不符合要求，请检查后重试。');
      } else if (error.code === '42501' || error.code === 'PGRST301') {
        Alert.alert('修改失败', '登录状态已失效，请重新登录。');
      } else {
        Alert.alert('修改失败', '修改失败，请稍后重试。');
      }
      return;
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const nextProfile = normalizeProfile({ ...profile, ...updatePayload });
      setProfile(nextProfile);
      // 保存成功 → 同步回写本地缓存，保证下次冷启动/断网时看到的是最新资料
      writeProfileCache(nextProfile);
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