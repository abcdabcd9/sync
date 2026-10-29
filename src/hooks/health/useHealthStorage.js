// --- START OF FILE src/hooks/health/useHealthStorage.js ---
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_MEALS } from './constants';
import { calculateDiffDays } from './dateUtils';

/**
 * 本地磁盘存储 Hook。
 *
 * ⚠️ 最高指令：本文件只做一件事 —— 读写 AsyncStorage。
 *    绝对禁止在此文件出现任何发往 Supabase 的网络请求。
 *    云端数据的拉取与推送由 useHealthCloud / 编排层负责，
 *    云端数据返回后通过 hydrateFromCloud() 显式覆盖本地状态。
 *
 * 负责的 8 个存储 key：
 *   @waterAmount / @mealsStatus / @maxWater / @motto
 *   @mealGuides / @streakDays / @lastCheckInDate / @lastActiveDate
 */

const EMPTY_MEALS = { '早餐': false, '午餐': false, '晚餐': false };

const KEYS = {
  water: '@waterAmount',
  meals: '@mealsStatus',
  maxWater: '@maxWater',
  motto: '@motto',
  guides: '@mealGuides',
  streak: '@streakDays',
  checkIn: '@lastCheckInDate',
  active: '@lastActiveDate',
};

/**
 * @param {string} todayStr 服务器校准后的"今天"（YYYY-MM-DD），跨天检测依赖它
 */
export function useHealthStorage(todayStr) {
  const [isLoaded, setIsLoaded] = useState(false);

  const [waterAmount, setWaterAmount] = useState(0);
  const [mealsStatus, setMealsStatus] = useState(EMPTY_MEALS);
  const [maxWater, setMaxWater] = useState(1800);
  const [motto, setMotto] = useState('今日概览');
  const [mealGuides, setMealGuides] = useState(DEFAULT_MEALS);
  const [streakDays, setStreakDays] = useState(0);
  const [lastCheckInDate, setLastCheckInDate] = useState(null);
  const [lastActiveDate, setLastActiveDate] = useState(null);

  // 防止 hydrate 之前把空状态写回磁盘，覆盖掉真实数据
  const isLoadedRef = useRef(false);

  /**
   * 从磁盘加载全部数据，并执行跨天清零。
   * 只读磁盘，不涉及任何网络。
   */
  const load = useCallback(async () => {
    const [savedWater, savedMeals, savedMaxWater, savedMotto, savedGuides, savedStreak, savedCheckIn, savedActive] = await Promise.all([
      AsyncStorage.getItem(KEYS.water), AsyncStorage.getItem(KEYS.meals),
      AsyncStorage.getItem(KEYS.maxWater), AsyncStorage.getItem(KEYS.motto), AsyncStorage.getItem(KEYS.guides),
      AsyncStorage.getItem(KEYS.streak), AsyncStorage.getItem(KEYS.checkIn), AsyncStorage.getItem(KEYS.active),
    ]);

    if (savedMaxWater) setMaxWater(Number(savedMaxWater));
    if (savedMotto) setMotto(savedMotto);
    if (savedGuides) setMealGuides(JSON.parse(savedGuides));

    // ---- 跨天清零：streak 断档检测 ----
    let currentStreak = savedStreak ? Number(savedStreak) : 0;
    if (savedCheckIn && savedCheckIn !== todayStr) {
      if (calculateDiffDays(todayStr, savedCheckIn) > 1) {
        currentStreak = 0;
        AsyncStorage.setItem(KEYS.streak, '0');
      }
    }
    setStreakDays(currentStreak);
    if (savedCheckIn) setLastCheckInDate(savedCheckIn);

    // ---- 跨天清零：当日饮水/三餐重置 ----
    if (savedActive !== todayStr) {
      setWaterAmount(0);
      setMealsStatus(EMPTY_MEALS);
      setLastActiveDate(todayStr);
      AsyncStorage.setItem(KEYS.active, todayStr);
    } else {
      setLastActiveDate(savedActive);
      if (savedWater) setWaterAmount(Number(savedWater));
      if (savedMeals) setMealsStatus(JSON.parse(savedMeals));
    }

    isLoadedRef.current = true;
    setIsLoaded(true);
  }, [todayStr]);

  /**
   * 用云端数据显式覆盖本地状态（并同步落盘）。
   * 由编排层在拿到 health_records 后调用。
   * @param {{waterAmount?: number, mealsStatus?: object}} data
   */
  const hydrateFromCloud = useCallback((data) => {
    if (!data) return;
    if (typeof data.waterAmount === 'number') {
      setWaterAmount(data.waterAmount);
      AsyncStorage.setItem(KEYS.water, data.waterAmount.toString());
    }
    if (data.mealsStatus) {
      setMealsStatus(data.mealsStatus);
      AsyncStorage.setItem(KEYS.meals, JSON.stringify(data.mealsStatus));
    }
  }, []);

  // ---- 纯本地 setter（写 state + 落盘，无网络）----

  const setWater = useCallback((val) => {
    setWaterAmount(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      AsyncStorage.setItem(KEYS.water, next.toString());
      return next;
    });
  }, []);

  const setMeals = useCallback((val) => {
    setMealsStatus(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      AsyncStorage.setItem(KEYS.meals, JSON.stringify(next));
      return next;
    });
  }, []);

  const setMaxWaterValue = useCallback((val) => {
    setMaxWater(val);
    AsyncStorage.setItem(KEYS.maxWater, val.toString());
    setWaterAmount(prev => {
      const next = prev > val ? val : prev;
      if (next !== prev) AsyncStorage.setItem(KEYS.water, next.toString());
      return next;
    });
  }, []);

  const setMottoValue = useCallback((text) => {
    setMotto(text);
    AsyncStorage.setItem(KEYS.motto, text);
  }, []);

  const setMealGuideValue = useCallback((meal, text) => {
    setMealGuides(prev => {
      const updated = { ...prev, [meal]: text };
      AsyncStorage.setItem(KEYS.guides, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const setStreak = useCallback((val) => {
    setStreakDays(val);
    AsyncStorage.setItem(KEYS.streak, val.toString());
  }, []);

  const setCheckInDate = useCallback((val) => {
    setLastCheckInDate(val);
    AsyncStorage.setItem(KEYS.checkIn, val);
  }, []);

  const setActiveDate = useCallback((val) => {
    setLastActiveDate(val);
    AsyncStorage.setItem(KEYS.active, val);
  }, []);

  /** 重置今日饮水与三餐（纯本地，不推送云端） */
  const resetTodayLocal = useCallback(() => {
    setWaterAmount(0);
    setMealsStatus(EMPTY_MEALS);
    AsyncStorage.setItem(KEYS.water, '0');
    AsyncStorage.setItem(KEYS.meals, JSON.stringify(EMPTY_MEALS));
  }, []);

  // 加载完成后，饮水/三餐变化自动落盘（替代原 useHealthData 中的持久化 effect）
  useEffect(() => {
    if (!isLoadedRef.current) return;
    AsyncStorage.setItem(KEYS.water, waterAmount.toString());
    AsyncStorage.setItem(KEYS.meals, JSON.stringify(mealsStatus));
  }, [waterAmount, mealsStatus]);

  return useMemo(() => ({
    isLoaded,
    waterAmount,
    mealsStatus,
    maxWater,
    motto,
    mealGuides,
    streakDays,
    lastCheckInDate,
    lastActiveDate,
    load,
    hydrateFromCloud,
    setWater,
    setMeals,
    setMaxWater: setMaxWaterValue,
    setMotto: setMottoValue,
    setMealGuide: setMealGuideValue,
    setStreak,
    setCheckInDate,
    setActiveDate,
    resetTodayLocal,
  }), [
    isLoaded, waterAmount, mealsStatus, maxWater, motto, mealGuides,
    streakDays, lastCheckInDate, lastActiveDate,
    load, hydrateFromCloud, setWater, setMeals, setMaxWaterValue,
    setMottoValue, setMealGuideValue, setStreak, setCheckInDate, setActiveDate, resetTodayLocal,
  ]);
}

// --- END OF FILE src/hooks/health/useHealthStorage.js ---
