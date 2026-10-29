// --- START OF FILE src/hooks/useHealthData.js ---
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';
import { useAuth } from './useAuth';
import { useTimeSync } from './health/useTimeSync';
import { useHealthStorage } from './health/useHealthStorage';
import { useHealthCloud } from './health/useHealthCloud';
import { useStreak } from './health/useStreak';

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
    partnerData, partnerId, setPartnerId,
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

  const loadAllData = async () => {
    
    // 🍎 每次加载数据前，先强制校准时空法则！(失败时 useTimeSync 内部会保留旧 offset)
    await calibrate();

    // 校准后重新取一次"今天"，确保拿到的是最新偏移量下的日期
    const currentDayStr = getDateStr();

    // 1️⃣ 先读本地磁盘（含跨天清零）
    await loadLocal();

    // 2️⃣ 再拉云端，拿到后显式覆盖本地（编排层负责串联 storage ↔ cloud）
    if (user) {
      try {
        const { data: profile } = await supabase.from('profiles').select('bound_partner_id').eq('id', user.id).single();
        let pId = profile?.bound_partner_id || null;

        if (!pId) {
          const { data: whoBoundMe } = await supabase.from('profiles').select('id').eq('bound_partner_id', user.id).limit(1);
          if (whoBoundMe && whoBoundMe.length > 0) {
            pId = whoBoundMe[0].id;
            supabase.from('profiles').update({ bound_partner_id: pId }).eq('id', user.id).then();
          }
        }

        setPartnerId(pId);

        const myData = await fetchMyRecord(currentDayStr);
        if (myData) {
          hydrateFromCloud({ waterAmount: myData.water_amount, mealsStatus: myData.meals_status });
        }

        if (pId) {
          const pData = await fetchPartnerRecord(pId, currentDayStr);
          applyPartnerRecord(pData);
        }
      } catch (e) {
        console.warn("云端同步失败，降级使用本地数据", e);
      }
    }
  };

  useEffect(() => {
    loadAllData();
  }, [user]);

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

  const setWaterDirect = useCallback((val) => {
    setWater(prev => {
      const newVal = typeof val === 'function' ? val(prev) : val;
      const nextVal = Math.min(maxWater, Math.max(0, Math.round(newVal)));
      if (prev !== nextVal) syncToCloud(nextVal, mealsStatus);
      return nextVal;
    });
  }, [maxWater, mealsStatus, syncToCloud, setWater]);

  const handleAddWater = useCallback(() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setWaterDirect(prev => prev + 1); }, [setWaterDirect]);
  const handleMinusWater = useCallback(() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setWaterDirect(prev => Math.max(0, prev - 1)); }, [setWaterDirect]);

  const confirmCheck = useCallback(async () => {
    if (!selectedMeal || mealsStatus[selectedMeal]) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const newMeals = { ...mealsStatus, [selectedMeal]: true };
    setMeals(newMeals);
    syncToCloud(waterAmount, newMeals);

    if (user && partnerId) {
      sendPushNotification(partnerId, "滴！打卡啦", `TA 刚刚完成了 ${selectedMeal} 打卡！`, { type: 'health' });
      const msgId = 'sys_' + Date.now();
      await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: partnerId, type: 'text', text: `[SYNC_SYSTEM]:完成了 ${selectedMeal} 饮食打卡 🥗` });
    }
    setSelectedMeal(null);
  }, [selectedMeal, mealsStatus, waterAmount, user, partnerId, syncToCloud, setMeals]);

  const undoCheck = useCallback(() => {
    if (!selectedMeal || !mealsStatus[selectedMeal]) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    const newMeals = { ...mealsStatus, [selectedMeal]: false };
    setMeals(newMeals);
    syncToCloud(waterAmount, newMeals);
    setSelectedMeal(null);
  }, [selectedMeal, mealsStatus, waterAmount, syncToCloud, setMeals]);

  const updateMaxWater = useCallback((val) => { setMaxWater(val); }, [setMaxWater]);
  const updateMotto = useCallback((text) => { setMotto(text); }, [setMotto]);
  const updateMealGuide = useCallback((meal, text) => { setMealGuide(meal, text); }, [setMealGuide]);
  
  const resetToday = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    resetTodayLocal();
    syncToCloud(0, { '早餐': false, '午餐': false, '晚餐': false });
  }, [syncToCloud, resetTodayLocal]);
  
  const openMeal = useCallback((meal) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedMeal(meal); }, []);
  const closeMeal = useCallback(() => setSelectedMeal(null), []);

  const value = useMemo(() => ({
    isInitialized: isLoaded, isDoneToday, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday
  }), [
    isLoaded, isDoneToday, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday
  ]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}
export function useHealthData() { return useContext(HealthContext); }
// --- END OF FILE src/hooks/useHealthData.js ---