// --- START OF FILE src/hooks/health/useHealthCloud.js ---
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../services/supabase';

/**
 * 云端数据 Hook（health_records 相关网络 IO 与双镜像离线持久化）。
 *
 * 职责：
 *   1. fetchMyRecord(date)     拉取自己今日数据
 *   2. fetchPartnerRecord(pId, date) 拉取伴侣今日数据（Cache-First 本地优先）
 *   3. subscribePartner(id, date, onData) partner_health_channel 实时订阅
 *   4. syncToCloud(water, meals) 1.5 秒防抖 upsert
 *   5. flushNow()              强制立即提交防抖队列中的数据
 */

const EMPTY_MEALS = { '早餐': false, '午餐': false, '晚餐': false };
const DEBOUNCE_MS = 1500;

/**
 * @param {object|null} user 当前登录用户
 * @param {() => string} getDateStr 返回校准后的今日日期字符串
 */
export function useHealthCloud(user, getDateStr) {
  const [partnerData, setPartnerData] = useState({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  const [partnerId, setPartnerId] = useState(null);

  const timerRef = useRef(null);
  const pendingRef = useRef(null);

  const commit = useCallback(async (payload) => {
    if (!payload || !user) return;
    try {
      await supabase.from('health_records').upsert(
        {
          user_id: user.id,
          record_date: payload.recordDate,
          water_amount: payload.water,
          meals_status: payload.meals,
        },
        { onConflict: 'user_id, record_date' }
      );
    } catch (e) {
      console.warn('⚠️ health_records 云端写入失败(离线状态)', e?.message || e);
    }
  }, [user]);

  const flushNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const payload = pendingRef.current;
    pendingRef.current = null;
    if (payload) await commit(payload);
  }, [commit]);

  const syncToCloud = useCallback((newWater, newMeals) => {
    if (!user) return;
    pendingRef.current = { recordDate: getDateStr(), water: newWater, meals: newMeals };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const payload = pendingRef.current;
      pendingRef.current = null;
      if (payload) commit(payload);
    }, DEBOUNCE_MS);
  }, [user, getDateStr, commit]);

  const fetchMyRecord = useCallback(async (date) => {
    if (!user) return null;
    try {
      const { data, error } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', user.id)
        .eq('record_date', date)
        .single();
      if (error) throw error;
      return data || null;
    } catch (e) {
      console.warn('⚠️ 拉取本人 health_records 失败(离线状态)', e?.message || e);
      return null;
    }
  }, [user]);

  /** 
   * 拉取伴侣的今日记录 (Cache-First 离线秒开架构) 
   */
  const fetchPartnerRecord = useCallback(async (pId, date) => {
    if (!pId) return null;
    const cacheKey = `@partner_health_${pId}_${date}`;

    // 1. 离线缓存优先加载（第 0 帧秒开，绝不显示 0）
    try {
      const cachedStr = await AsyncStorage.getItem(cacheKey);
      if (cachedStr) {
        setPartnerData(JSON.parse(cachedStr));
      }
    } catch (_) {}

    // 2. 网络请求非阻塞与错误降级
    try {
      const { data, error } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', pId)
        .eq('record_date', date)
        .single();
      
      if (error) throw error;

      if (data) {
        const newData = {
          waterAmount: data.water_amount || 0,
          mealsStatus: data.meals_status || EMPTY_MEALS,
        };
        // 更新内存并回写本地磁盘镜像
        setPartnerData(newData);
        AsyncStorage.setItem(cacheKey, JSON.stringify(newData)).catch(() => {});
        return data;
      }
    } catch (e) {
      // 🚨 断网降级保护：绝对禁止重置为 0，保持本地缓存数据！
      console.warn('离线状态，使用本地缓存的搭子健康数据');
    }
    return null;
  }, []);

  const applyPartnerRecord = useCallback((record) => {
    if (!record) return;
    setPartnerData({
      waterAmount: record.water_amount || 0,
      mealsStatus: record.meals_status || EMPTY_MEALS,
    });
  }, []);

  const clearPartner = useCallback(() => {
    setPartnerId(null);
    setPartnerData({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  }, []);

  /** 订阅伴侣的 health_records 变更 */
  const subscribePartner = useCallback((pId, date) => {
    if (!pId) return () => {};

    const channelName = `partner_health_${pId}_${Date.now()}`;
    const cacheKey = `@partner_health_${pId}_${date}`;

    try {
      supabase
        .getChannels()
        .filter((ch) => ch.topic === `realtime:${channelName}`)
        .forEach((ch) => supabase.removeChannel(ch));

      const channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'health_records', filter: `user_id=eq.${pId}` },
          (payload) => {
            if (payload.new && payload.new.record_date === date) {
              const newData = {
                waterAmount: payload.new.water_amount || 0,
                mealsStatus: payload.new.meals_status || EMPTY_MEALS,
              };
              // 实时更新内存并同步本地磁盘镜像
              setPartnerData(newData);
              AsyncStorage.setItem(cacheKey, JSON.stringify(newData)).catch(() => {});
            }
          }
        )
        .subscribe();

      return () => supabase.removeChannel(channel);
    } catch (e) {
      console.warn('搭子健康订阅离线失败，静默降级', e?.message || e);
      return () => {};
    }
  }, []);

  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const payload = pendingRef.current;
    pendingRef.current = null;
    if (payload) commit(payload);
  }, [commit]);

  return useMemo(() => ({
    partnerData,
    partnerId,
    setPartnerId,
    clearPartner,
    fetchMyRecord,
    fetchPartnerRecord,
    applyPartnerRecord,
    subscribePartner,
    syncToCloud,
    flushNow,
  }), [
    partnerData, partnerId, clearPartner, fetchMyRecord, fetchPartnerRecord,
    applyPartnerRecord, subscribePartner, syncToCloud, flushNow,
  ]);
}
// --- END OF FILE src/hooks/health/useHealthCloud.js ---