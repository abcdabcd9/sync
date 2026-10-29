// --- START OF FILE src/hooks/useHealthData.js ---
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppState } from 'react-native'; 
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../services/supabase'; 
import { sendPushNotification } from '../services/pushService'; 
import { useAuth } from './useAuth';
import { DEFAULT_MEALS } from './health/constants';
import { setGlobalTimeOffset, getTodayDateStr, getYesterdayDateStr, calculateDiffDays } from './health/dateUtils';

const HealthContext = createContext();

export function HealthProvider({ children }) {
  const { user } = useAuth(); 
  
  const [isInitialized, setIsInitialized] = useState(false);
  const [selectedMeal, setSelectedMeal] = useState(null);
  
  const [mealsStatus, setMealsStatus] = useState({ '早餐': false, '午餐': false, '晚餐': false });
  const [waterAmount, setWaterAmount] = useState(0);
  
  const [partnerData, setPartnerData] = useState({ waterAmount: 0, mealsStatus: { '早餐': false, '午餐': false, '晚餐': false } });
  const [partnerId, setPartnerId] = useState(null);

  const [maxWater, setMaxWater] = useState(1800);
  const [motto, setMotto] = useState('今日概览');
  const [mealGuides, setMealGuides] = useState(DEFAULT_MEALS);

  const [streakDays, setStreakDays] = useState(0);
  const [lastCheckInDate, setLastCheckInDate] = useState(null);
  const [lastActiveDate, setLastActiveDate] = useState(null); 

  const cloudSyncTimerRef = useRef(null);
  const wasGoalCompleteRef = useRef(null); 

  const loadAllData = async () => {
    
    // 🍎 每次加载数据前，先强制校准时空法则！(即使网络不好，也有 try/catch 保底防御机制)
    try {
      const { data: serverTimeStr } = await supabase.rpc('get_server_time');
      if (serverTimeStr) {
        setGlobalTimeOffset(new Date(serverTimeStr).getTime() - Date.now());
      }
    } catch (e) {
      console.warn("⚠️ 异国时空校准失败，降级使用本地相对时间", e);
    }

    const todayStr = getTodayDateStr();

    const [savedWater, savedMeals, savedMaxWater, savedMotto, savedGuides, savedStreak, savedCheckIn, savedActive] = await Promise.all([
      AsyncStorage.getItem('@waterAmount'), AsyncStorage.getItem('@mealsStatus'),
      AsyncStorage.getItem('@maxWater'), AsyncStorage.getItem('@motto'), AsyncStorage.getItem('@mealGuides'),
      AsyncStorage.getItem('@streakDays'), AsyncStorage.getItem('@lastCheckInDate'), AsyncStorage.getItem('@lastActiveDate')
    ]);
    
    if (savedMaxWater) setMaxWater(Number(savedMaxWater));
    if (savedMotto) setMotto(savedMotto);
    if (savedGuides) setMealGuides(JSON.parse(savedGuides));
    
    let currentStreak = savedStreak ? Number(savedStreak) : 0;
    if (savedCheckIn && savedCheckIn !== todayStr) {
      if (calculateDiffDays(todayStr, savedCheckIn) > 1) {
        currentStreak = 0; 
        AsyncStorage.setItem('@streakDays', '0');
      }
    }
    setStreakDays(currentStreak);
    if (savedCheckIn) setLastCheckInDate(savedCheckIn);

    if (savedActive !== todayStr) {
      setWaterAmount(0);
      setMealsStatus({ '早餐': false, '午餐': false, '晚餐': false });
      setLastActiveDate(todayStr);
      AsyncStorage.setItem('@lastActiveDate', todayStr);
    } else {
      setLastActiveDate(savedActive);
      if (savedWater) setWaterAmount(Number(savedWater));
      if (savedMeals) setMealsStatus(JSON.parse(savedMeals));
    }

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

        const { data: myData } = await supabase.from('health_records').select('*').eq('user_id', user.id).eq('record_date', todayStr).single();
        if (myData) {
          setWaterAmount(myData.water_amount);
          setMealsStatus(myData.meals_status);
        }
        
        if (pId) {
          const { data: pData } = await supabase.from('health_records').select('*').eq('user_id', pId).eq('record_date', todayStr).single();
          if (pData) setPartnerData({ waterAmount: pData.water_amount || 0, mealsStatus: pData.meals_status || { '早餐': false, '午餐': false, '晚餐': false } });
        }
      } catch (e) {
        console.warn("云端同步失败，降级使用本地数据", e);
      }
    }
    setIsInitialized(true);
  };

  useEffect(() => {
    loadAllData();
  }, [user]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        // App 切回前台时，会顺带执行 loadAllData 里的最新一次对表校准！
        const todayStr = getTodayDateStr();
        setLastActiveDate(prev => {
          if (prev && prev !== todayStr) {
            loadAllData();
            return todayStr;
          }
          return prev;
        });
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    const todayStr = getTodayDateStr();
    const isDoneToday = mealsStatus['早餐'] && mealsStatus['午餐'] && mealsStatus['晚餐'] && waterAmount >= maxWater;

    AsyncStorage.setItem('@waterAmount', waterAmount.toString());
    AsyncStorage.setItem('@mealsStatus', JSON.stringify(mealsStatus));

    if (wasGoalCompleteRef.current !== null && isDoneToday !== wasGoalCompleteRef.current) {
      if (isDoneToday && lastCheckInDate !== todayStr) {
        let newStreak = 1;
        if (lastCheckInDate) {
          const diff = calculateDiffDays(todayStr, lastCheckInDate);
          if (diff === 1) newStreak = streakDays + 1;
          else if (diff > 1) newStreak = 1;
        }
        setStreakDays(newStreak);
        setLastCheckInDate(todayStr);
        AsyncStorage.setItem('@streakDays', newStreak.toString());
        AsyncStorage.setItem('@lastCheckInDate', todayStr);
      } else if (!isDoneToday && lastCheckInDate === todayStr) {
        // 撤销打卡逻辑
        const yStr = getYesterdayDateStr();
        
        const newStreak = Math.max(0, streakDays - 1);
        setStreakDays(newStreak);
        setLastCheckInDate(yStr);
        AsyncStorage.setItem('@streakDays', newStreak.toString());
        AsyncStorage.setItem('@lastCheckInDate', yStr);
      }
    }
    wasGoalCompleteRef.current = isDoneToday;
  }, [mealsStatus, waterAmount, maxWater, isInitialized, lastCheckInDate, streakDays]);

  useEffect(() => {
    if (!partnerId) return;
    const todayStr = getTodayDateStr();
    const channel = supabase.channel('partner_health_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'health_records', filter: `user_id=eq.${partnerId}` }, (payload) => {
        if (payload.new && payload.new.record_date === todayStr) {
          setPartnerData({ waterAmount: payload.new.water_amount || 0, mealsStatus: payload.new.meals_status || { '早餐': false, '午餐': false, '晚餐': false } });
        }
      }).subscribe();
    return () => supabase.removeChannel(channel);
  }, [partnerId]);

  const syncToCloud = useCallback((newWater, newMeals) => {
    if (!user) return;
    const todayStr = getTodayDateStr();
    if (cloudSyncTimerRef.current) clearTimeout(cloudSyncTimerRef.current);
    cloudSyncTimerRef.current = setTimeout(async () => {
      await supabase.from('health_records').upsert({ user_id: user.id, record_date: todayStr, water_amount: newWater, meals_status: newMeals }, { onConflict: 'user_id, record_date' });
    }, 1500);
  }, [user]);

  const setWaterDirect = useCallback((val) => {
    setWaterAmount(prev => {
      const newVal = typeof val === 'function' ? val(prev) : val;
      const nextVal = Math.min(maxWater, Math.max(0, Math.round(newVal)));
      if (prev !== nextVal) syncToCloud(nextVal, mealsStatus);
      return nextVal;
    });
  }, [maxWater, mealsStatus, syncToCloud]);

  const handleAddWater = useCallback(() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setWaterDirect(prev => prev + 1); }, [setWaterDirect]);
  const handleMinusWater = useCallback(() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setWaterDirect(prev => Math.max(0, prev - 1)); }, [setWaterDirect]);

  const confirmCheck = useCallback(async () => {
    if (!selectedMeal || mealsStatus[selectedMeal]) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const newMeals = { ...mealsStatus, [selectedMeal]: true };
    setMealsStatus(newMeals);
    syncToCloud(waterAmount, newMeals);

    if (user && partnerId) {
      sendPushNotification(partnerId, "滴！打卡啦", `TA 刚刚完成了 ${selectedMeal} 打卡！`, { type: 'health' });
      const msgId = 'sys_' + Date.now();
      await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: partnerId, type: 'text', text: `[SYNC_SYSTEM]:完成了 ${selectedMeal} 饮食打卡 🥗` });
    }
    setSelectedMeal(null);
  }, [selectedMeal, mealsStatus, waterAmount, user, partnerId, syncToCloud]);

  const undoCheck = useCallback(() => {
    if (!selectedMeal || !mealsStatus[selectedMeal]) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    const newMeals = { ...mealsStatus, [selectedMeal]: false };
    setMealsStatus(newMeals);
    syncToCloud(waterAmount, newMeals);
    setSelectedMeal(null);
  }, [selectedMeal, mealsStatus, waterAmount, syncToCloud]);

  const updateMaxWater = useCallback((val) => { setMaxWater(val); AsyncStorage.setItem('@maxWater', val.toString()); setWaterAmount(prev => prev > val ? val : prev); }, []);
  const updateMotto = useCallback((text) => { setMotto(text); AsyncStorage.setItem('@motto', text); }, []);
  const updateMealGuide = useCallback((meal, text) => { setMealGuides(prev => { const updated = { ...prev, [meal]: text }; AsyncStorage.setItem('@mealGuides', JSON.stringify(updated)); return updated; }); }, []);
  
  const resetToday = useCallback(() => { 
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); 
    setWaterAmount(0); setMealsStatus({ '早餐': false, '午餐': false, '晚餐': false }); 
    syncToCloud(0, { '早餐': false, '午餐': false, '晚餐': false }); 
  }, [syncToCloud]);
  
  const openMeal = useCallback((meal) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedMeal(meal); }, []);
  const closeMeal = useCallback(() => setSelectedMeal(null), []);

  const value = useMemo(() => ({
    isInitialized, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday
  }), [
    isInitialized, selectedMeal, mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday
  ]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}
export function useHealthData() { return useContext(HealthContext); }
// --- END OF FILE src/hooks/useHealthData.js ---