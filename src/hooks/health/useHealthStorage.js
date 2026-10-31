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
      // ⚠️ calculateDiffDays 取绝对值，无法区分"过去"与"未来"，
      //    因此先用时间戳做方向判断，避免系统时间回拨造成的错乱。
      const savedTime = new Date(savedCheckIn).getTime();
      const todayTime = new Date(todayStr).getTime();

      if (savedTime > todayTime) {
        // 发现未来日期（系统时间被修改然后回拨），视为时间流异常，直接清零
        currentStreak = 0;
        AsyncStorage.setItem(KEYS.streak, '0');
      } else if (calculateDiffDays(todayStr, savedCheckIn) > 1) {
        // 正常断档超过 1 天，清零
        currentStreak = 0;
        AsyncStorage.setItem(KEYS.streak, '0');
      }
    }
    setStreakDays(currentStreak);
    if (savedCheckIn) setLastCheckInDate(savedCheckIn);

    // ---- 跨天清零：当日饮水/三餐重置 ----
    // ⚠️ 必须同时满足「有上次活跃日期」且「与今天不同」才清零：
    //    首次安装（savedActive 为 null）时不应误判为跨天，但仍需写入今天的活跃日期。
    if (savedActive && savedActive !== todayStr) {
      // 已跨过 24 小时进入新的一天 → 第 0 帧彻底清零，并立即回写磁盘，
      // 确保冷启动 / 跨天切回 App 时昨天的饮水与三餐状态 100% 不会残留。
      setWaterAmount(0);
      setMealsStatus(EMPTY_MEALS);
      setLastActiveDate(todayStr);
      await AsyncStorage.setItem(KEYS.water, '0');
      await AsyncStorage.setItem(KEYS.meals, JSON.stringify(EMPTY_MEALS));
      await AsyncStorage.setItem(KEYS.active, todayStr);
    } else {
      setLastActiveDate(savedActive || todayStr);
      if (savedWater) setWaterAmount(Number(savedWater));
      if (savedMeals) setMealsStatus(JSON.parse(savedMeals));
      // 首次安装（无活跃日期）→ 补写今天的活跃日期，供下次跨天检测使用
      if (!savedActive) {
        await AsyncStorage.setItem(KEYS.active, todayStr);
      }
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
    // ⚠️ AsyncStorage 不接受 null/undefined，撤销打卡归零时传 null 会抛错，
    //    因此 null 语义等价于"无打卡记录"，直接删除该键。
    if (val === null || val === undefined) {
      AsyncStorage.removeItem(KEYS.checkIn);
    } else {
      AsyncStorage.setItem(KEYS.checkIn, String(val));
    }
  }, []);

  const setActiveDate = useCallback((val) => {
    setLastActiveDate(val);
    if (val === null || val === undefined) {
      AsyncStorage.removeItem(KEYS.active);
    } else {
      AsyncStorage.setItem(KEYS.active, String(val));
    }
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
