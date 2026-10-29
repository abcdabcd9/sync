// --- START OF FILE src/hooks/useHealthData.js ---
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { supabase } from '../services/supabase';
import { sendPushNotification } from '../services/pushService';
import { useAuth } from './useAuth';
import { calculateDiffDays } from './health/dateUtils';
import { useTimeSync } from './health/useTimeSync';
import { useHealthStorage } from './health/useHealthStorage';

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

  const [selectedMeal, setSelectedMeal] = useState(null);
  
  const [partnerData, setPartnerData] = useState({ waterAmount: 0, mealsStatus: { '早餐': false, '午餐': false, '晚餐': false } });
  const [partnerId, setPartnerId] = useState(null);

  const cloudSyncTimerRef = useRef(null);
  const wasGoalCompleteRef = useRef(null);

  const loadAllData = async () => {
    
    // 🍎 每次加载数据前，先强制校准时空法则！(失败时 useTimeSync 内部会保留旧 offset)
    await calibrate();

    // 校准后重新取一次"今天"，确保拿到的是最新偏移量下的日期
    const currentDayStr = getDateStr();

    // 1️⃣ 先读本地磁盘（含跨天清零）
    await loadLocal();

    // 2️⃣ 再拉云端，拿到后显式覆盖本地
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

        const { data: myData } = await supabase.from('health_records').select('*').eq('user_id', user.id).eq('record_date', currentDayStr).single();
        if (myData) {
          hydrateFromCloud({ waterAmount: myData.water_amount, mealsStatus: myData.meals_status });
        }
        
        if (pId) {
          const { data: pData } = await supabase.from('health_records').select('*').eq('user_id', pId).eq('record_date', currentDayStr).single();
          if (pData) setPartnerData({ waterAmount: pData.water_amount || 0, mealsStatus: pData.meals_status || { '早餐': false, '午餐': false, '晚餐': false } });
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
      }
    });
    return () => subscription.remove();
  }, [lastActiveDate, getDateStr]);

  useEffect(() => {
    // 本地磁盘加载完成后才允许判定打卡状态，避免用初始空值误判
    if (!isLoaded) return;
    const isDoneToday = mealsStatus['早餐'] && mealsStatus['午餐'] && mealsStatus['晚餐'] && waterAmount >= maxWater;

    if (wasGoalCompleteRef.current !== null && isDoneToday !== wasGoalCompleteRef.current) {
      if (isDoneToday && lastCheckInDate !== todayStr) {
        let newStreak = 1;
        if (lastCheckInDate) {
          const diff = calculateDiffDays(todayStr, lastCheckInDate);
          if (diff === 1) newStreak = streakDays + 1;
          else if (diff > 1) newStreak = 1;
        }
        setStreak(newStreak);
        setCheckInDate(todayStr);
      } else if (!isDoneToday && lastCheckInDate === todayStr) {
        // 撤销打卡逻辑：把 lastCheckInDate 回退到"昨天"
        const yDate = new Date(`${todayStr}T00:00:00Z`);
        yDate.setUTCDate(yDate.getUTCDate() - 1);
        const yStr = getDateStr(yDate);
        
        const newStreak = Math.max(0, streakDays - 1);
        setStreak(newStreak);
        setCheckInDate(yStr);
      }
    }
    wasGoalCompleteRef.current = isDoneToday;
  }, [mealsStatus, waterAmount, maxWater, isLoaded, lastCheckInDate, streakDays, todayStr, getDateStr, setStreak, setCheckInDate]);

  useEffect(() => {
    if (!partnerId) return;
    const channel = supabase.channel('partner_health_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'health_records', filter: `user_id=eq.${partnerId}` }, (payload) => {
        if (payload.new && payload.new.record_date === todayStr) {
          setPartnerData({ waterAmount: payload.new.water_amount || 0, mealsStatus: payload.new.meals_status || { '早餐': false, '午餐': false, '晚餐': false } });
        }
      }).subscribe();
    return () => supabase.removeChannel(channel);
  }, [partnerId, todayStr]);

  const syncToCloud = useCallback((newWater, newMeals) => {
    if (!user) return;
    const recordDate = getDateStr();
    if (cloudSyncTimerRef.current) clearTimeout(cloudSyncTimerRef.current);
    cloudSyncTimerRef.current = setTimeout(async () => {
      await supabase.from('health_records').upsert({ user_id: user.id, record_date: recordDate, water_amount: newWater, meals_status: newMeals }, { onConflict: 'user_id, record_date' });
    }, 1500);
  }, [user, getDateStr]);

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
    isInitialized: isLoaded, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday
  }), [
    isLoaded, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday
  ]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}
export function useHealthData() { return useContext(HealthContext); }
// --- END OF FILE src/hooks/useHealthData.js ---