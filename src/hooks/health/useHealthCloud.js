// --- START OF FILE src/hooks/health/useHealthCloud.js ---
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../services/supabase';

/**
 * 云端数据 Hook（health_records 相关网络 IO）。
 *
 * ⚠️ 最高指令：本文件只负责网络 IO。
 *    绝不允许 import AsyncStorage 或 useHealthStorage。
 *    与本地存储的数据交互，只能由 useHealthData 编排层显式传递。
 *
 * 职责：
 *   1. fetchMyRecord(date)     拉取自己今日数据
 *   2. fetchPartnerRecord(id, date) 拉取伴侣今日数据
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
  // 待提交的载荷（防抖队列里唯一的一份，后写覆盖先写）
  const pendingRef = useRef(null);

  /** 真正执行 upsert 的内部函数 */
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
      console.warn('⚠️ health_records 云端写入失败', e);
    }
  }, [user]);

  /** 强制立即提交防抖队列中的数据 */
  const flushNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const payload = pendingRef.current;
    pendingRef.current = null;
    if (payload) await commit(payload);
  }, [commit]);

  /** 1.5 秒防抖写入 */
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

  /** 拉取自己的今日记录 */
  const fetchMyRecord = useCallback(async (date) => {
    if (!user) return null;
    try {
      const { data } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', user.id)
        .eq('record_date', date)
        .single();
      return data || null;
    } catch (e) {
      console.warn('⚠️ 拉取本人 health_records 失败', e);
      return null;
    }
  }, [user]);

  /** 拉取伴侣的今日记录 */
  const fetchPartnerRecord = useCallback(async (pId, date) => {
    if (!pId) return null;
    try {
      const { data } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', pId)
        .eq('record_date', date)
        .single();
      return data || null;
    } catch (e) {
      console.warn('⚠️ 拉取伴侣 health_records 失败', e);
      return null;
    }
  }, []);

  /** 解析并设置伴侣数据（供拉取与订阅共用） */
  const applyPartnerRecord = useCallback((record) => {
    if (!record) return;
    setPartnerData({
      waterAmount: record.water_amount || 0,
      mealsStatus: record.meals_status || EMPTY_MEALS,
    });
  }, []);

  /**
   * 解绑后清空伴侣相关状态。
   * ⚠️ 仅清空 partnerId 不够：partnerData 仍残留旧伴侣的进度，
   *    首页 PartnerStatusCard 会继续显示已解绑的人，直到下次冷启动。
   */
  const clearPartner = useCallback(() => {
    setPartnerId(null);
    setPartnerData({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  }, []);

  /** 订阅伴侣的 health_records 变更 */
  const subscribePartner = useCallback((pId, date) => {
    if (!pId) return () => {};

    // ⚠️ 频道名必须唯一：effect 依赖 (partnerId, todayStr) 会在跨天或切换伴侣时变化，
    //    若复用固定名，旧频道尚未回收时 supabase.channel() 会返回已 subscribe 的实例，
    //    再次 .on() 会直接抛错（通道复用冲突）。加时间戳确保每次订阅都是全新实例。
    const channelName = `partner_health_${pId}_${Date.now()}`;

    // 兜底清理：移除可能残留的同名前缀频道，避免极端情况下泄漏
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
            setPartnerData({
              waterAmount: payload.new.water_amount || 0,
              mealsStatus: payload.new.meals_status || EMPTY_MEALS,
            });
          }
        }
      )
      .subscribe();

    // cleanup：effect 重跑或组件卸载时释放频道
    return () => supabase.removeChannel(channel);
  }, []);

  // 卸载时清掉未触发的定时器，并立即提交队列中尚未写入的数据，
  // 防止用户切换页面时丢失最后一笔防抖中的数据（P3-21）。
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
