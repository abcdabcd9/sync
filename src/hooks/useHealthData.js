// --- START OF FILE src/hooks/useHealthData.js ---
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';
import { useAuth } from './useAuth';
import { useTimeSync } from './health/useTimeSync';
import { useHealthStorage } from './health/useHealthStorage';
import { useHealthCloud } from './health/useHealthCloud';
import { useStreak } from './health/useStreak';
import {
  readProfileCache,
  writeProfileCache,
  normalizeProfile,
} from './profile/useProfileCache';

const HealthContext = createContext();

export function HealthProvider({ children }) {
  const { user } = useAuth();
  const { todayStr, calibrate, getDateStr } = useTimeSync();

  // 📦 所有本地磁盘读写都收敛在 useHealthStorage 内部（零网络请求）
  const storage = useHealthStorage(todayStr);
  const {
    isLoaded,
    waterAmount, mealsStatus, maxWater, motto, mealGuides,
    streakDays, lastCheckInDate, lastActiveDate,
    load: loadLocal,
    hydrateFromCloud,
    setWater, setMeals, setMaxWater, setMotto, setMealGuide,
    setStreak, setCheckInDate, resetTodayLocal,
  } = storage;

  // ☁️ 所有 health_records 网络 IO 都收敛在 useHealthCloud 内部（不碰本地存储）
  const cloud = useHealthCloud(user, getDateStr);
  const {
    partnerData, partnerId, setPartnerId, clearPartner,
    fetchMyRecord, fetchPartnerRecord, applyPartnerRecord,
    subscribePartner, syncToCloud, flushNow,
  } = cloud;

  // 🧠 连续打卡状态机（纯业务规则，零网络 / 零磁盘）
  const { isDoneToday } = useStreak({
    todayStr,
    getDateStr,
    isLoaded,
    mealsStatus,
    waterAmount,
    maxWater,
    streakDays,
    lastCheckInDate,
    setStreak,
    setCheckInDate,
  });

  const [selectedMeal, setSelectedMeal] = useState(null);

  // 👤 个人资料（Cache-First）：断网时永远保留本地缓存，绝不重置为 null
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // 🛡️ 竞态守卫：用户一旦产生任何交互，云端回包就不再允许覆盖本地状态
  const userInteractedRef = useRef(false);

  /**
   * 👤 个人资料加载（Cache-First，第 0 帧秒开）
   *
   * 铁律：
   *   1. 先读 AsyncStorage @user_profile_cache，命中即 setProfile + loading=false
   *   2. 缓存中的 bound_partner_id 必须立即同步给 partnerId（离线也能显示搭子卡片）
   *   3. 云端 profiles 查询失败/超时 → 只 console.warn，绝不 setProfile(null) / setUser(null)
   *   4. 云端成功 → 回写缓存
   */
  // 用 ref 持有最新 userId，保证 loadProfile 引用稳定（避免 effect 反复触发）
  const profileUserIdRef = useRef(user?.id ?? null);
  useEffect(() => {
    profileUserIdRef.current = user?.id ?? null;
  }, [user?.id]);

  const loadProfile = useCallback(async () => {
    const uid = profileUserIdRef.current;

    if (!uid) {
      // 未登录：没有个人资料可展示，但必须结束 loading，避免界面卡死转圈
      setProfile(null);
      setProfileLoading(false);
      return;
    }

    // 1️⃣ 第 0 帧：本地缓存优先（零网络，断网也能瞬间显示头像/昵称/Sync ID）
    const cached = await readProfileCache(uid);
    if (cached) {
      setProfile(cached);
      setProfileLoading(false);

      // 💞 离线恢复搭子 ID：0 毫秒恢复绑定关系，防止搭子卡片消失 / 聊天记录被清空
      if (cached.bound_partner_id) {
        setPartnerId(cached.bound_partner_id);
      }
    }

    // 2️⃣ 云端刷新：任何异常都只降级，绝不清空用户状态
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, sync_id, nickname, bound_partner_id')
        .eq('id', uid)
        .single();

      if (error) throw error;

      if (data) {
        const nextProfile = normalizeProfile(data);
        setProfile(nextProfile);
        // 云端成功 → 回写缓存，供下次冷启动秒开（含 bound_partner_id）
        writeProfileCache(nextProfile);

        // 💞 云端绑定关系同步给 partnerId（仅在确实有值时覆盖，绝不用 null 覆盖缓存值）
        if (nextProfile.bound_partner_id) {
          setPartnerId(nextProfile.bound_partner_id);
        }
      }
    } catch (e) {
      // 🚨 断网 30 秒超时 / 任何网络异常：保持本地缓存 state，绝不重置为 null
      console.warn('离线状态，继续使用本地缓存的个人资料');
      console.warn('⚠️ profiles 云端查询失败:', e?.message ?? e);
    } finally {
      // 无论成功失败，都必须结束 loading，确保 App 维持登录状态、界面不卡死
      setProfileLoading(false);
    }
  }, [setPartnerId]);

  const loadAllData = async () => {
    // 🔓 每次强制刷新都解开"本地操作保护锁"：
    //    否则用户交互过一次后锁永久为 true，跨天/切回前台时云端数据会被错误丢弃
    userInteractedRef.current = false;

    // 🍎 先校准时空法则（失败时 useTimeSync 内部会保留旧 offset）
    await calibrate();

    // 校准后重新取一次"今天"，确保拿到的是最新偏移量下的日期
    const currentDayStr = getDateStr();

    // 1️⃣ 先读本地磁盘（含跨天清零）
    await loadLocal();

    // 2️⃣ 再拉云端，拿到后显式覆盖本地（编排层负责串联 storage ↔ cloud）
    if (user) {
      try {
        const { data: profileRow } = await supabase.from('profiles').select('bound_partner_id').eq('id', user.id).single();
        let pId = profileRow?.bound_partner_id || null;

        if (!pId) {
          const { data: whoBoundMe } = await supabase.from('profiles').select('id').eq('bound_partner_id', user.id).limit(1);
          if (whoBoundMe && whoBoundMe.length > 0) {
            pId = whoBoundMe[0].id;
            // 🍎 P2-11：回写绑定关系不再 fire-and-forget，显式捕获 error 并记录日志
            const { error: bindError } = await supabase
              .from('profiles')
              .update({ bound_partner_id: pId })
              .eq('id', user.id);
            if (bindError) {
              console.error('更新失败:', bindError);
            }
          }
        }

        // 💞 只有云端确实返回了搭子 ID 才覆盖；null 不覆盖，保留缓存恢复的 partnerId
        if (pId) {
          setPartnerId(pId);
          // 同步回写 profile 缓存，保证下次冷启动/断网时搭子关系不丢失
          setProfile(prev => {
            if (!prev) return prev;
            const next = { ...prev, bound_partner_id: pId };
            writeProfileCache(next);
            return next;
          });
        }

        const myData = await fetchMyRecord(currentDayStr);
        // 🛡️ 网络往返期间用户已操作过 → 丢弃云端旧数据，避免覆盖秒级点击
        if (myData && !userInteractedRef.current) {
          hydrateFromCloud({ waterAmount: myData.water_amount, mealsStatus: myData.meals_status });
        }

        if (pId) {
          const pData = await fetchPartnerRecord(pId, currentDayStr);
          applyPartnerRecord(pData);
        }
      } catch (e) {
        // 🚨 离线降级：只记录日志，绝不重置 profile / user / partnerId，
        //    避免搭子卡片消失与聊天记录被清空
        console.warn('离线状态，继续使用本地缓存的个人资料');
        console.warn('云端同步失败，降级使用本地数据', e?.message ?? e);
      }
    }
  };

  useEffect(() => {
    // 包一层微任务：避免在 effect 体内同步触发 setState（React 编译器规则）
    const t = setTimeout(() => { loadAllData(); }, 0);
    return () => clearTimeout(t);
  }, [user]);

  // 👤 个人资料独立加载：与健康数据解耦，断网时也能第 0 帧显示缓存
  useEffect(() => {
    loadProfile();
  }, [loadProfile, user?.id]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        // App 切回前台时，会顺带执行 loadAllData 里的最新一次对表校准！
        const currentDayStr = getDateStr();
        if (lastActiveDate && lastActiveDate !== currentDayStr) {
          loadAllData();
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // 🚨 进入后台前，强制提交还在防抖队列里的数据，防止丢失
        flushNow();
      }
    });
    return () => subscription.remove();
  }, [lastActiveDate, getDateStr, flushNow]);

  // 🔄 伴侣数据实时订阅（网络 IO 由 useHealthCloud 负责）
  useEffect(() => {
    if (!partnerId) return;
    return subscribePartner(partnerId, todayStr);
  }, [partnerId, todayStr, subscribePartner]);

  // 🎯 饮水写入：本地 state 立即更新（零延迟，数字不跳动）+ 云端 500ms 防抖同步
  //
  // 旧实现的两个问题：
  //   1. 每次点击都立刻调用 syncToCloud，长按连加时会产生大量 upsert 请求；
  //   2. 依赖 [waterAmount] 闭包，长按 setInterval 内连续调用时读到的是过期值，
  //      导致「加了又跳回去」的数字抖动。
  //
  // 新实现：
  //   · waterAmountRef 始终持有最新值，任何时刻的增量都基于真实当前值计算；
  //   · setWater 只写本地 state + 落盘（纯本地，无网络）；
  //   · 云端同步统一走 500ms 防抖，用户停手后才真正发请求。
  const waterAmountRef = useRef(waterAmount);
  useEffect(() => { waterAmountRef.current = waterAmount; }, [waterAmount]);

  const maxWaterRef = useRef(maxWater);
  useEffect(() => { maxWaterRef.current = maxWater; }, [maxWater]);

  const mealsStatusRef = useRef(mealsStatus);
  useEffect(() => { mealsStatusRef.current = mealsStatus; }, [mealsStatus]);

  // 云端同步防抖定时器（500ms）
  const waterSyncTimerRef = useRef(null);
  useEffect(() => () => {
    if (waterSyncTimerRef.current) clearTimeout(waterSyncTimerRef.current);
  }, []);

  const scheduleWaterSync = useCallback((nextWater) => {
    if (waterSyncTimerRef.current) clearTimeout(waterSyncTimerRef.current);
    waterSyncTimerRef.current = setTimeout(() => {
      waterSyncTimerRef.current = null;
      syncToCloud(nextWater, mealsStatusRef.current);
    }, 500);
  }, [syncToCloud]);

  /**
   * 统一的饮水写入入口。
   * @param {number|((prev:number)=>number)} val 目标值或 updater
   * @param {{ sync?: boolean }} options sync=false 时只写本地（长按连加过程中使用）
   */
  const setWaterDirect = useCallback((val, options = {}) => {
    const { sync = true } = options;
    const prev = waterAmountRef.current;
    const raw = typeof val === 'function' ? val(prev) : val;
    const nextVal = Math.min(maxWaterRef.current, Math.max(0, Math.round(raw)));
    if (prev === nextVal) return;

    // ① 本地立即生效（同步 ref，保证下一次增量基于最新值）
    waterAmountRef.current = nextVal;
    setWater(nextVal);

    // ② 云端防抖同步
    if (sync) scheduleWaterSync(nextVal);
  }, [setWater, scheduleWaterSync]);

  // 顺序：① storage 纯本地修改 → ② Haptics → ③ cloud.syncToCloud（防抖）
  const handleAddWater = useCallback(() => {
    userInteractedRef.current = true;
    setWaterDirect(prev => prev + 1);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [setWaterDirect]);

  const handleMinusWater = useCallback(() => {
    userInteractedRef.current = true;
    setWaterDirect(prev => Math.max(0, prev - 1));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [setWaterDirect]);

  const confirmCheck = useCallback(async () => {
    if (!selectedMeal || mealsStatus[selectedMeal]) return;
    userInteractedRef.current = true;

    // ① storage 纯本地修改 → ② Haptics → ③ cloud.syncToCloud（防抖）
    const newMeals = { ...mealsStatus, [selectedMeal]: true };
    setMeals(newMeals);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    syncToCloud(waterAmount, newMeals);

    // 伴侣通知（非阻塞，失败不影响本地状态）
    if (user) {
      // 🛡️ partnerId 可能尚未就绪（loadAllData 还在网络往返中）→ 现场兜底查一次
      let targetId = partnerId;
      if (!targetId) {
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('bound_partner_id')
            .eq('id', user.id)
            .single();
          targetId = profile?.bound_partner_id || null;
          if (!targetId) {
            const { data: whoBoundMe } = await supabase
              .from('profiles')
              .select('id')
              .eq('bound_partner_id', user.id)
              .limit(1);
            targetId = whoBoundMe?.[0]?.id || null;
          }
          if (targetId) setPartnerId(targetId);
        } catch (e) {
          console.warn('⚠️ 打卡时解析搭子 ID 失败:', e?.message ?? e);
        }
      }

      if (targetId) {
        // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
        sendPushNotification(targetId, '', `完成了 ${selectedMeal} 饮食打卡`, { type: 'health' });

        // ⚠️ messages.id 是 uuid 类型，绝不能传 'sys_xxx' 这类字符串
        //    这里不传 id，交给数据库默认值（gen_random_uuid()）自动生成
        const { error } = await supabase.from('messages').insert({
          user_id: user.id,
          receiver_id: targetId,
          type: 'text',
          text: `完成了 ${selectedMeal} 饮食打卡`,
          subtype: 'SYNC_SYSTEM',
        });
        if (error) {
          console.warn('⚠️ 打卡系统消息写入失败:', error.message, error.details ?? '', error.hint ?? '');
        }
      } else {
        console.warn('⚠️ 打卡系统消息未发送：当前用户没有绑定健康搭子');
      }
    }
    setSelectedMeal(null);
  }, [selectedMeal, mealsStatus, waterAmount, user, partnerId, setPartnerId, syncToCloud, setMeals]);

  const undoCheck = useCallback(() => {
    if (!selectedMeal || !mealsStatus[selectedMeal]) return;
    userInteractedRef.current = true;

    // ① storage 纯本地修改 → ② Haptics → ③ cloud.syncToCloud（防抖）
    const newMeals = { ...mealsStatus, [selectedMeal]: false };
    setMeals(newMeals);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    syncToCloud(waterAmount, newMeals);
    setSelectedMeal(null);
  }, [selectedMeal, mealsStatus, waterAmount, syncToCloud, setMeals]);

  /**
   * 解绑/绑定后强制刷新伴侣关系（供 bind_partner 等页面调用）。
   * 直接查库而不是依赖本地缓存，确保 UI 立刻反映最新绑定状态。
   * @param {string|null} nextPartnerId 已知的新伴侣 ID；传 null 表示解绑
   */
  const refreshPartner = useCallback(async (nextPartnerId = null) => {
    if (!user) return;
    try {
      if (!nextPartnerId) {
        // 解绑：清空 partnerId + partnerData，首页卡片立即消失
        clearPartner();
        return;
      }
      setPartnerId(nextPartnerId);
      const pData = await fetchPartnerRecord(nextPartnerId, getDateStr());
      if (pData) applyPartnerRecord(pData);
    } catch (e) {
      console.warn('⚠️ 刷新伴侣关系失败:', e?.message ?? e);
    }
  }, [user, clearPartner, setPartnerId, fetchPartnerRecord, applyPartnerRecord, getDateStr]);

  const updateMaxWater = useCallback((val) => { setMaxWater(val); }, [setMaxWater]);
  const updateMotto = useCallback((text) => { setMotto(text); }, [setMotto]);
  const updateMealGuide = useCallback((meal, text) => { setMealGuide(meal, text); }, [setMealGuide]);

  // 顺序：① storage 纯本地重置 → ② Haptics → ③ cloud.syncToCloud（防抖）
  const resetToday = useCallback(() => {
    userInteractedRef.current = true;
    resetTodayLocal();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    syncToCloud(0, { '早餐': false, '午餐': false, '晚餐': false });
  }, [syncToCloud, resetTodayLocal]);

  const openMeal = useCallback((meal) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedMeal(meal); }, []);
  const closeMeal = useCallback(() => setSelectedMeal(null), []);

  const value = useMemo(() => ({
    isInitialized: isLoaded, isDoneToday, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    profile, profileLoading, refreshProfile: loadProfile,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday, refreshPartner
  }), [
    isLoaded, isDoneToday, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    profile, profileLoading, loadProfile,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday, refreshPartner
  ]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}
export function useHealthData() { return useContext(HealthContext); }
// --- END OF FILE src/hooks/useHealthData.js ---