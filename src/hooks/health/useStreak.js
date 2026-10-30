// --- START OF FILE src/hooks/health/useStreak.js ---
import { useEffect, useMemo, useRef } from 'react';
import { calculateDiffDays } from './dateUtils';

/**
 * 连续打卡状态机（纯业务规则大脑）。
 *
 * ⚠️ 最高指令：本文件只负责"算"业务规则。
 *    绝对禁止引入网络请求（supabase / fetch）或直接调用 AsyncStorage。
 *    所有状态与 setter 均由编排层 useHealthData 显式传入。
 *
 * 职责：
 *   1. 派生 isDoneToday（三餐全打卡 + 饮水达标）
 *   2. 用 wasGoalCompleteRef 做边沿检测，只在"未完成 → 完成"或"完成 → 未完成"的瞬间触发
 *   3. 完成瞬间：按 lastCheckInDate 与 todayStr 的天数差推进 streak
 *   4. 撤销瞬间：streak 回退 1，lastCheckInDate 回退到"昨天"
 *
 * @param {object} params
 * @param {string}   params.todayStr         校准后的今日日期 YYYY-MM-DD
 * @param {Function} params.getDateStr       时间层提供的日期格式化函数
 * @param {boolean}  params.isLoaded         本地磁盘是否加载完成
 * @param {object}   params.mealsStatus      三餐打卡状态
 * @param {number}   params.waterAmount      当前饮水量
 * @param {number}   params.maxWater         目标饮水量
 * @param {number}   params.streakDays       当前连续天数
 * @param {string|null} params.lastCheckInDate 最近一次打卡日期
 * @param {Function} params.setStreak        写入连续天数
 * @param {Function} params.setCheckInDate   写入最近打卡日期
 * @returns {{ isDoneToday: boolean }}
 */
export function useStreak({
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
}) {
  // 今日目标是否达成（派生值，不额外占用 state）
  const isDoneToday = useMemo(() => {
    return Boolean(
      mealsStatus?.['早餐'] &&
      mealsStatus?.['午餐'] &&
      mealsStatus?.['晚餐'] &&
      waterAmount >= maxWater
    );
  }, [mealsStatus, waterAmount, maxWater]);

  // 边沿检测器：记录上一次的目标达成状态（null 表示尚未初始化）
  const wasGoalCompleteRef = useRef(null);

  useEffect(() => {
    // 本地磁盘加载完成后才允许判定打卡状态，避免用初始空值误判
    if (!isLoaded) return;

    const prev = wasGoalCompleteRef.current;

    if (prev !== null && isDoneToday !== prev) {
      if (isDoneToday && lastCheckInDate !== todayStr) {
        // ✅ 达成目标：推进连续天数
        let newStreak = 1;
        if (lastCheckInDate) {
          const diff = calculateDiffDays(todayStr, lastCheckInDate);
          if (diff === 1) newStreak = streakDays + 1;
          else if (diff > 1) newStreak = 1;
        }
        setStreak(newStreak);
        setCheckInDate(todayStr);
      } else if (!isDoneToday && lastCheckInDate === todayStr) {
        // ↩️ 撤销打卡：streak 回退 1
        // ⚠️ getDateStr 内部走 formatDateStr(date)，必须传 Date 对象而非时间戳
        const yStr = getDateStr(new Date(Date.now() - 86400000));
        const newStreak = Math.max(0, streakDays - 1);
        setStreak(newStreak);
        // 若回退后为 0，说明已无连续记录，必须清空打卡日期，
        // 否则下次打卡会因"昨天打过卡"被误判为连续而污染 streak
        setCheckInDate(newStreak === 0 ? null : yStr);
      }
    }

    wasGoalCompleteRef.current = isDoneToday;
  }, [
    isLoaded,
    isDoneToday,
    lastCheckInDate,
    streakDays,
    todayStr,
    getDateStr,
    setStreak,
    setCheckInDate,
  ]);

  return { isDoneToday };
}

// --- END OF FILE src/hooks/health/useStreak.js ---
