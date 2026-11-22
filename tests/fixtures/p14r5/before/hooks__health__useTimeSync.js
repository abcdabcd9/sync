// --- START OF FILE src/hooks/health/useTimeSync.js ---
import { useCallback, useMemo, useRef, useState } from 'react';
import { supabase } from '../../services/supabase';
import { formatDateStr } from './dateUtils';

/**
 * 时间校准 Hook。
 *
 * 设计要点：
 * 1. offset 同时存在 ref 与 state 中：
 *    - ref 用于同步读取（getDateStr / todayStr 计算时立刻拿到最新值，不受渲染批次影响）
 *    - state 用于驱动重渲染（todayStr / offsetMs / isSynced 变化时通知消费方）
 * 2. 校准失败时保留旧 offset，绝不归零 —— 避免网络抖动导致"今天"跳变、streak 被误清零。
 * 3. 所有 setState 都做了值相等判断，重复调用 calibrate 不会产生多余渲染，也不会触发无限循环。
 */
export function useTimeSync() {
  const offsetRef = useRef(0);
  const [offsetMs, setOffsetMs] = useState(0);
  const [isSynced, setIsSynced] = useState(false);
  const [todayStr, setTodayStr] = useState(() => formatDateStr(new Date()));

  // 同步读取当前校准后的绝对时间
  const getNow = useCallback(() => new Date(Date.now() + offsetRef.current), []);

  // 把任意 Date 格式化为 YYYY-MM-DD（UTC），供调用方复用
  const getDateStr = useCallback((date = getNow()) => formatDateStr(date), [getNow]);

  // 重新计算 todayStr，仅在真正跨天时才 setState
  const refreshToday = useCallback(() => {
    const next = formatDateStr(new Date(Date.now() + offsetRef.current));
    setTodayStr(prev => (prev === next ? prev : next));
    return next;
  }, []);

  /**
   * 拉取服务器时间并校准偏移量。
   * @returns {Promise<boolean>} 是否校准成功
   */
  const calibrate = useCallback(async () => {
    try {
      const { data: serverTimeStr, error } = await supabase.rpc('get_server_time');
      if (error) throw error;
      if (!serverTimeStr) return false;

      const nextOffset = new Date(serverTimeStr).getTime() - Date.now();
      if (!Number.isFinite(nextOffset)) return false;

      // ref 始终写入最新值（保证 getDateStr 立刻准确）
      offsetRef.current = nextOffset;

      // state 仅在偏移量发生"有意义"的变化时才更新，避免毫秒级抖动引发无谓重渲染
      setOffsetMs(prev => (Math.abs(prev - nextOffset) < 1000 ? prev : nextOffset));
      setIsSynced(true);
      refreshToday();
      return true;
    } catch (e) {
      // 🍎 校准失败：保留旧 offset，降级使用上一次的校准结果（首次失败则用本地时间）
      console.warn('⚠️ 异国时空校准失败，沿用上一次的偏移量', e);
      return false;
    }
  }, [refreshToday]);

  return useMemo(() => ({
    todayStr,
    offsetMs,
    isSynced,
    calibrate,
    getDateStr,
    getNow,
    refreshToday,
  }), [todayStr, offsetMs, isSynced, calibrate, getDateStr, getNow, refreshToday]);
}

// --- END OF FILE src/hooks/health/useTimeSync.js ---
