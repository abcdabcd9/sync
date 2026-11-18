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
    partnerData, partnerId, authGeneration, setPartnerId, bindPartner, clearPartner,
    fetchMyRecord, fetchPartnerRecord, applyPartnerRecord,
    subscribePartner, subscribeAuthorization, syncToCloud, flushNow,
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
        // 🔒 唯一权威来源：服务端 partner_authorizations（经 get_active_partner_id() 读取）。
        //    不再读 profiles.bound_partner_id 指针，也不再反向扫描「谁绑了我」——
        //    旧指针路径既不安全（可被伪造）又会造成单向残留。
        const { data: activePartnerId, error: partnerErr } = await supabase.rpc('get_active_partner_id');
        if (partnerErr) {
          // 🛡️ T6/A06：RPC 失败 ≠ 没有搭子。网络异常时绝不能据此清空本地搭子状态，
          //    否则一次抖动就会让搭子卡片消失、聊天记录被清空。保持缓存，仅记录日志。
          console.warn('⚠️ 读取有效搭子失败:', partnerErr?.message ?? partnerErr);
        } else {
          const pId = activePartnerId || null;

          if (pId) {
            // 💞 权威确认存在有效搭子 → 绑定并作废旧代际的在途请求
            bindPartner(pId);
            // 同步回写 profile 缓存，保证下次冷启动/断网时搭子关系不丢失
            setProfile(prev => {
              if (!prev) return prev;
              const next = { ...prev, bound_partner_id: pId };
              writeProfileCache(next);
              return next;
            });
          } else {
            // 🧹 T6/A06：权威返回「无有效搭子」→ 必须清空，而不是保留陈旧 partnerId。
            //    旧实现「null 不覆盖」会让已撤销的搭子一直挂在首页，且继续订阅对方健康数据。
            //    传入旧 partnerId 以便一并清理其本地健康缓存镜像。
            clearPartner(partnerId);
            setProfile(prev => {
              if (!prev || !prev.bound_partner_id) return prev;
              const next = { ...prev, bound_partner_id: null };
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
        } else if (user) {
          // 🛡️ T6/A06：即使没跨天，切回前台也要复验搭子授权。
          //    对方可能在我方后台期间解绑，若不复验，首页会继续展示已撤销的搭子卡片，
          //    并继续订阅对方健康数据。这里只做轻量的权威复验，不重拉全部健康数据。
          supabase
            .rpc('get_active_partner_id')
            .then(({ data, error }) => {
              if (error) return; // 网络异常 → 保持现状，绝不清空
              const pId = data || null;
              if (pId) {
                if (pId !== partnerId) bindPartner(pId);
                // 🔧 T7-H22 兜底：切回前台时主动拉一次搭子快照。
                //    实时订阅可能因后台挂起、网络切换、重绑同一人等原因漏事件，
                //    这里用一次轻量查询补齐，保证「回到前台即是最新」，
                //    不再依赖用户手动重启 App。
                fetchPartnerRecord(pId, getDateStr())
                  .then((rec) => {
                    if (rec) applyPartnerRecord(rec);
                  })
                  .catch(() => {});
              } else if (partnerId) {
                clearPartner(partnerId);
                setProfile(prev => {
                  if (!prev || !prev.bound_partner_id) return prev;
                  const next = { ...prev, bound_partner_id: null };
                  writeProfileCache(next);
                  return next;
                });
              }
            })
            .catch(() => {});
        }
      } else if (nextAppState === 'background' || nextAppState === 'inactive') {
        // 🚨 进入后台前，强制提交还在防抖队列里的数据，防止丢失
        flushNow();
      }
    });
    return () => subscription.remove();
  }, [
    lastActiveDate, getDateStr, flushNow, user, partnerId,
    bindPartner, clearPartner, fetchPartnerRecord, applyPartnerRecord,
  ]);

  // 🔄 伴侣数据实时订阅（网络 IO 由 useHealthCloud 负责）
  //
  // 🔧 T7-H22：依赖数组必须包含 authGeneration。
  //    场景：B 与 C 解绑后再次绑定同一个人 → partnerId 的值前后完全相同，
  //    React 认为依赖未变、不会重建 effect；而解绑时旧订阅已被 cleanup 移除，
  //    结果就是「没有任何订阅存活」，对方打卡/饮水/饮食都不再实时推送，
  //    只有重启 App（走 loadAllData 一次性快照）才能看到数据。
  //    authGeneration 是 state，bindPartner / clearPartner 都会自增它，
  //    因此重绑同一人时也会触发本 effect 重建订阅。
  useEffect(() => {
    if (!partnerId) return;
    return subscribePartner(partnerId, todayStr);
  }, [partnerId, todayStr, authGeneration, subscribePartner]);

  // 🔔 T6.1/FIX-05：授权撤销实时感知。
  //    对方解绑时 partner_authorizations 的 status 由 accepted 变为 revoked，
  //    迁移 27 已把该表加入 Realtime 白名单，这里订阅并立即失效本地状态：
  //      · clearPartner 自增授权代际 → 在途 fetch / 实时回调全部作废
  //      · 清空 profile 缓存里的 bound_partner_id 指针
  //    这样「双方都在前台」时也能即时看到搭子卡片消失，无需等切后台再回来。
  useEffect(() => {
    if (!partnerId) return;
    return subscribeAuthorization(partnerId, () => {
      clearPartner(partnerId);
      setProfile(prev => {
        if (!prev || !prev.bound_partner_id) return prev;
        const next = { ...prev, bound_partner_id: null };
        writeProfileCache(next);
        return next;
      });
    });
  }, [partnerId, subscribeAuthorization, clearPartner]);

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
          // 🔒 走服务端权威 RPC，不再读 bound_partner_id 指针
          const { data: activePartnerId } = await supabase.rpc('get_active_partner_id');
          targetId = activePartnerId || null;
          // 🛡️ T6/A06：走 bindPartner 以自增授权代际，避免旧代际在途请求写回
          if (targetId) bindPartner(targetId);
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
  }, [selectedMeal, mealsStatus, waterAmount, user, partnerId, bindPartner, syncToCloud, setMeals]);

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
        // 解绑：清空 partnerId + partnerData + 本地健康缓存镜像，首页卡片立即消失
        // 传入旧 partnerId 以便清理其缓存键
        clearPartner(partnerId);
        setProfile(prev => {
          if (!prev || !prev.bound_partner_id) return prev;
          const next = { ...prev, bound_partner_id: null };
          writeProfileCache(next);
          return next;
        });
        return;
      }
      // 绑定/换绑：作废旧代际的在途请求后再拉取新搭子数据
      bindPartner(nextPartnerId);
      const pData = await fetchPartnerRecord(nextPartnerId, getDateStr());
      if (pData) applyPartnerRecord(pData);
    } catch (e) {
      console.warn('⚠️ 刷新伴侣关系失败:', e?.message ?? e);
    }
  }, [user, partnerId, clearPartner, bindPartner, fetchPartnerRecord, applyPartnerRecord, getDateStr]);

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