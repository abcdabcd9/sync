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
  getProfileCacheGeneration,
} from './profile/useProfileCache';

const HealthContext = createContext();

export function HealthProvider({ children }) {
  const { user, authEpoch } = useAuth();
  const { todayStr, calibrate, getDateStr } = useTimeSync();

  // 📦 所有本地磁盘读写都收敛在 useHealthStorage 内部（零网络请求）
  // 🆔 TASK-P0.3 / B1-B：传入当前 userId，使 8 个健康 key 按账号隔离。
  //    无 userId 时 Hook 内部不读写任何磁盘（绝不读取旧全局 key）。
  // 🛡️ T6-B 第二轮复审 14-02：同时传入 authEpoch，使「同账号新会话」
  //    （userId 不变但 authEpoch 自增）也能作废旧会话的 load/hydrate/落盘。
  const storage = useHealthStorage(todayStr, user?.id ?? null, authEpoch);
  const {
    isLoaded,
    waterAmount, mealsStatus, maxWater, motto, mealGuides,
    streakDays, lastCheckInDate, lastActiveDate,
    load: loadLocal,
    hydrateFromCloud,
    getSessionEpoch,
    // 🛡️ Round 4A / CR4-01：不再解构 getIdentitySnapshot。
    //    该函数返回「当前实时身份」，用它做 isIdentityCurrent 校验恒为 true，
    //    是 Round 3 守卫失效的根因。现统一改用 originSnapshot（创建时捕获）。
    isIdentityCurrent,
    setWater, setMeals, setMaxWater, setMotto, setMealGuide,
    setStreak, setCheckInDate, resetTodayLocal,
  } = storage;

  // ☁️ 所有 health_records 网络 IO 都收敛在 useHealthCloud 内部（不碰本地存储）
  // 🛡️ TASK-P0.3 / B3-01：传入 authEpoch，使「同账号新会话」（userId 不变但
  //    authEpoch 自增）也能作废旧会话的搭子状态、在途请求与实时订阅。
  //    旧实现只传 user，账号切换清理 effect 仅比较 user.id，
  //    A→登出→A 重新登录时搭子状态与旧订阅不会被作废。
  const cloud = useHealthCloud(user, getDateStr, authEpoch);
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

  // 🛡️ Round 4A 收尾 / R4A-01：饮食详情选中态必须绑定「打开时的身份」。
  //    内部存 { meal, ownerKey, selectionId }，ownerKey = `${userId}::${authEpoch}`；
  //    对外暴露时若 ownerKey 与当前身份不一致，直接视为 null（渲染期派生，
  //    无需 effect 内 setState，身份切换当帧即失效）。
  // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：额外携带 selectionId（每次打开唯一）。
  //    异步回调（confirmCheck 的 messages.insert 等）返回后，必须同时校验
  //    「身份未变」+「该选中实例仍是当前实例」，否则会清空新账号/新实例的选择。
  const [selectedMeal, setSelectedMeal] = useState(null);
  const currentOwnerKey = `${user?.id ?? ''}::${authEpoch}`;
  const visibleSelectedMeal =
    selectedMeal && selectedMeal.ownerKey === currentOwnerKey ? selectedMeal.meal : null;
  // 每次打开自增，作为「选中实例」唯一标识（同账号连续打开不同餐次 / 重开同一餐次均可区分）
  const selectionSeqRef = useRef(0);

  // 👤 个人资料（Cache-First）：断网时永远保留本地缓存，绝不重置为 null
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // 🛡️ 竞态守卫：用户一旦产生任何交互，云端回包就不再允许覆盖本地状态
  const userInteractedRef = useRef(false);

  /**
   * 🛡️ T6-B Round 4A / CR4-01：**回调来源身份快照**（创建时捕获）。
   *
   *    根因：旧实现里所有外部回调（setWaterDirect / confirmCheck / undoCheck /
   *    resetToday / refreshPartner / loadAllData）都在**执行时**调用
   *    getIdentitySnapshot()，而该函数返回的是「当前实时身份」——
   *    因此 isIdentityCurrent(snapshot) 恒为 true，旧会话闭包在切号后执行时
   *    永远通过校验，把 A 的操作写进 B（或污染 shadow ref / 云端）。
   *
   *    修复：originSnapshot 由 useMemo 依赖 [user?.id, authEpoch] 生成，
   *    即「本渲染周期回调创建时的身份」。回调执行时用 isIdentityCurrent(originSnapshot)
   *    与实时身份比对，不一致则整体 fail-closed。
   *
   *    注意：这里刻意不使用 ref 镜像（ref 会被实时更新，等于又回到执行时取值）。
   *    useMemo 的依赖变化会重建回调，旧回调闭包中保留的 originSnapshot 永久不变，
   *    这正是「创建时身份」的语义。
   */
  const originSnapshot = useMemo(
    () => ({ userId: user?.id ?? null, epoch: authEpoch }),
    [user?.id, authEpoch]
  );

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

  // 🆔 B1-D：身份变化时清空内存态，防止上一账号资料在新账号下短暂可见。
  //    采用 React 官方推荐的「渲染期调整 state」模式（而非 effect 内 setState），
  //    既能在读取新账号数据前完成重置，又避免级联渲染告警。
  //    ⚠️ 渲染期只允许 setState，不允许写 ref / 模块级副作用（react-hooks/refs）。
  const [prevProfileOwner, setPrevProfileOwner] = useState(user?.id ?? null);
  if (prevProfileOwner !== (user?.id ?? null)) {
    setPrevProfileOwner(user?.id ?? null);
    setProfile(null);
    setProfileLoading(!!user?.id);
  }

  // 🆔 X-01（复审返工 CR-02）：owner 的**唯一权威**是 AuthProvider。
  //    业务 Hook（本文件 / useProfileCache）一律不得调用 setProfileCacheOwner，
  //    否则「旧 Hook 在登出后重跑」会把 owner 重新登记成旧身份，绕过写入闸门。
  //    这里不再登记 owner；写入闸门依赖 AuthProvider 已登记的 currentOwnerId +
  //    writeProfileCache 内部的 profile.id === currentOwnerId 校验（fail-closed）。

  const loadProfile = useCallback(async () => {
    const uid = profileUserIdRef.current;

    if (!uid) {
      // 未登录：没有个人资料可展示，但必须结束 loading，避免界面卡死转圈
      setProfile(null);
      setProfileLoading(false);
      return;
    }

    // 🛡️ T6-B 第二轮复审 14-05：快照发起时的全局 Profile 代际。
    //    仅比对 profileUserIdRef 无法覆盖 A→B→A（userId 相同但已是新会话）：
    //    旧 A 请求迟到时 userId 仍等于 A，会误判为「身份未变」而写进新 A 的 React state。
    //    因此必须同时比对模块级 owner 代际（AuthProvider 在身份转移时推进）。
    const startGeneration = getProfileCacheGeneration();

    // 1️⃣ 第 0 帧：本地缓存优先（零网络，断网也能瞬间显示头像/昵称/Sync ID）
    const cached = await readProfileCache(uid);
    // 🛡️ 代际校验：读取期间身份已变化 → 丢弃
    if (profileUserIdRef.current !== uid) return;
    if (getProfileCacheGeneration() !== startGeneration) return;
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

      // 🛡️ 代际校验：云端返回时身份已变化 → 绝不回写新账号缓存
      if (profileUserIdRef.current !== uid) return;
      if (getProfileCacheGeneration() !== startGeneration) return;

      if (data) {
        const nextProfile = normalizeProfile(data);
        // 🛡️ setProfile 前最后一道闸门：ABA 后旧 A 响应不得更新新 A 会话的 UI
        if (getProfileCacheGeneration() !== startGeneration) return;
        setProfile(nextProfile);
        // 云端成功 → 回写缓存，供下次冷启动秒开（含 bound_partner_id）
        // writeProfileCache 内部还会按 expectedGeneration 做 fail-closed 校验
        writeProfileCache(nextProfile, startGeneration);

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
      if (profileUserIdRef.current === uid) setProfileLoading(false);
    }
  }, [setPartnerId]);

  const loadAllData = async () => {
    // 🛡️ Round 4A / CR4-02：**先校验来源身份，再产生任何副作用**。
    //    旧实现在第一行就无条件 userInteractedRef.current = false，
    //    旧会话（A）的迟到 loadAllData 会把新会话（B）刚设置的交互保护锁解开，
    //    随后 B 的云端回包就会覆盖 B 的本地秒级操作。
    //    这里用回调创建时捕获的 originSnapshot 做 fail-closed 校验。
    if (!isIdentityCurrent(originSnapshot)) return;

    // 🔓 每次强制刷新都解开"本地操作保护锁"：
    //    否则用户交互过一次后锁永久为 true，跨天/切回前台时云端数据会被错误丢弃
    userInteractedRef.current = false;

    // 🛡️ X-02 / CR-05：快照发起时的 owner + 会话代际。云端往返期间若身份
    //    或会话已切换（含 A→B→A / 同账号重登），迟到的 health_records 响应
    //    绝不能写进新账号/新会话的 V2 key。
    const loadOwnerId = user?.id ?? null;
    const loadEpoch = getSessionEpoch();

    // 🍎 先校准时空法则（失败时 useTimeSync 内部会保留旧 offset）
    await calibrate();

    // 🛡️ Round 4A / CR4-02：异步边界 ①（calibrate 网络往返）后再校验一次。
    if (!isIdentityCurrent(originSnapshot)) return;

    // 校准后重新取一次"今天"，确保拿到的是最新偏移量下的日期
    const currentDayStr = getDateStr();

    // 1️⃣ 先读本地磁盘（含跨天清零）
    await loadLocal();

    // 🛡️ Round 4A / CR4-02：异步边界 ②（loadLocal 磁盘往返）后再校验一次。
    if (!isIdentityCurrent(originSnapshot)) return;

    // 2️⃣ 再拉云端，拿到后显式覆盖本地（编排层负责串联 storage ↔ cloud）
    if (user) {
      try {
        // 🔒 唯一权威来源：服务端 partner_authorizations（经 get_active_partner_id() 读取）。
        //    不再读 profiles.bound_partner_id 指针，也不再反向扫描「谁绑了我」——
        //    旧指针路径既不安全（可被伪造）又会造成单向残留。
        const { data: activePartnerId, error: partnerErr } = await supabase.rpc('get_active_partner_id');

        // 🛡️ Round 4A / CR4-02：异步边界 ③（get_active_partner_id RPC 往返）。
        //    旧会话的 RPC 若晚于新会话返回，绝不能执行 bindPartner / clearPartner /
        //    setProfile / writeProfileCache 等副作用。
        if (!isIdentityCurrent(originSnapshot)) return;

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
          // 🛡️ X-02 / CR-05：身份或会话代际已切换 → 丢弃旧账号/旧会话的云端响应，
          //    绝不写进新账号/新会话 key。hydrateFromCloud 内部还会再次 fail-closed 校验。
          // 🛡️ Round 4A / CR4-02：异步边界 ④（fetchMyRecord 往返）同样需要来源身份校验。
          if (
            myData &&
            !userInteractedRef.current &&
            isIdentityCurrent(originSnapshot) &&
            profileUserIdRef.current === loadOwnerId &&
            getSessionEpoch() === loadEpoch
          ) {
            hydrateFromCloud(
              { waterAmount: myData.water_amount, mealsStatus: myData.meals_status },
              loadOwnerId,
              loadEpoch
            );
          }

          if (pId) {
            const pData = await fetchPartnerRecord(pId, currentDayStr);
            // 🛡️ Round 4A / CR4-02：异步边界 ⑤（fetchPartnerRecord 往返）。
            //    旧会话的搭子快照绝不能 applyPartnerRecord 到新会话 UI。
            if (!isIdentityCurrent(originSnapshot)) return;
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
    // 🛡️ Round 4A / CR4-02：AppState 监听器在**注册时**绑定来源身份。
    //    该 effect 依赖 [user, ...]，身份切换会重建监听器；旧监听器在 remove 前
    //    仍可能收到事件并执行在途 RPC 回调，因此每个异步边界都要用此快照校验。
    const listenerOrigin = originSnapshot;

    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        // 🛡️ Round 4A / CR4-02：事件到达时先校验来源身份（同步路径）。
        if (!isIdentityCurrent(listenerOrigin)) return;

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
              // 🛡️ Round 4A / CR4-02：RPC 返回后校验来源身份，
              //    旧会话的迟到响应绝不能 bindPartner / clearPartner / setProfile。
              if (!isIdentityCurrent(listenerOrigin)) return;
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
                    // 🛡️ Round 4A / CR4-02：搭子快照是第二个异步边界，
                    //    落库前必须再次校验来源身份。
                    if (!isIdentityCurrent(listenerOrigin)) return;
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
    originSnapshot, isIdentityCurrent,
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
  //
  // 🛡️ TASK-P0.3 / B3-05：依赖数组必须包含 authEpoch。
  //    场景：A → 登出 → A 重新登录（partnerId 值相同、authGeneration 可能
  //    尚未自增）→ 旧订阅若不重建，会继续以旧会话身份接收事件。
  //    纳入 authEpoch 后，同账号新会话必然重建订阅，旧订阅被 cleanup 移除。
  useEffect(() => {
    if (!partnerId) return;
    return subscribePartner(partnerId, todayStr);
  }, [partnerId, todayStr, authGeneration, authEpoch, subscribePartner]);

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
    // 🛡️ TASK-P0.3 / B3-05：authEpoch 纳入依赖，同账号新会话必须重建授权订阅，
    //    避免旧会话订阅的复验结果清空新会话的搭子状态。
  }, [partnerId, authEpoch, subscribeAuthorization, clearPartner]);

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

  // 🛡️ T6-B 第三轮复审 15-01：scheduleWaterSync 在**排队时**捕获身份快照，
  //    定时器真正触发时再校验一次。身份已切换（旧会话回调）则丢弃，绝不把
  //    旧会话的饮水值同步到云端（避免「本地被拒、云端却仍排队」的错位）。
  const scheduleWaterSync = useCallback((nextWater, snapshot) => {
    if (waterSyncTimerRef.current) clearTimeout(waterSyncTimerRef.current);
    waterSyncTimerRef.current = setTimeout(() => {
      waterSyncTimerRef.current = null;
      if (!isIdentityCurrent(snapshot)) return;
      syncToCloud(nextWater, mealsStatusRef.current);
    }, 500);
  }, [syncToCloud, isIdentityCurrent]);

  /**
   * 统一的饮水写入入口。
   * @param {number|((prev:number)=>number)} val 目标值或 updater
   * @param {{ sync?: boolean }} options sync=false 时只写本地（长按连加过程中使用）
   */
  const setWaterDirect = useCallback((val, options = {}) => {
    const { sync = true } = options;
    // 🛡️ Round 4A / CR4-01：校验**回调创建时**的身份（originSnapshot），
    //    而不是执行时的实时身份。旧会话回调（A 的 setWaterDirect 在切到 B 后
    //    才触发）必须整体 fail-closed——不写 shadow ref、不 setState、不排队云端同步。
    //    关键：校验必须先于 waterAmountRef.current 的写入，否则即使 storage 拒绝落盘，
    //    shadow ref 也已被旧会话污染，导致新会话下一次合法增量基于错误基数。
    if (!isIdentityCurrent(originSnapshot)) return;

    const prev = waterAmountRef.current;
    const raw = typeof val === 'function' ? val(prev) : val;
    const nextVal = Math.min(maxWaterRef.current, Math.max(0, Math.round(raw)));
    if (prev === nextVal) return;

    // ① 本地立即生效（同步 ref，保证下一次增量基于最新值）
    waterAmountRef.current = nextVal;
    setWater(nextVal);

    // ② 云端防抖同步（携带创建时身份快照，触发时二次校验）
    if (sync) scheduleWaterSync(nextVal, originSnapshot);
  }, [originSnapshot, isIdentityCurrent, setWater, scheduleWaterSync]);

  // 顺序：① storage 纯本地修改 → ② Haptics → ③ cloud.syncToCloud（防抖）
  // 🛡️ Round 4A 收尾 / R4A-02：包装回调必须在**任何副作用之前**校验创建时身份。
  //    旧实现先无条件写 userInteractedRef.current = true，再调 setWaterDirect。
  //    旧会话（A）的包装回调在切到 B 后执行时，即使 setWaterDirect 内部 fail-closed，
  //    userInteractedRef 已被污染为 true → B 的云端 hydrate 被永久拦截。
  //    这里把身份校验提到最前（早于 ref 写入 / 触感 / 状态更新），复用 originSnapshot。
  const handleAddWater = useCallback(() => {
    if (!isIdentityCurrent(originSnapshot)) return;
    userInteractedRef.current = true;
    setWaterDirect(prev => prev + 1);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [setWaterDirect, originSnapshot, isIdentityCurrent]);

  const handleMinusWater = useCallback(() => {
    if (!isIdentityCurrent(originSnapshot)) return;
    userInteractedRef.current = true;
    setWaterDirect(prev => Math.max(0, prev - 1));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [setWaterDirect, originSnapshot, isIdentityCurrent]);

  const confirmCheck = useCallback(async () => {
    // 🛡️ Round 4A 收尾 / R4A-01：selectedMeal 内部存 { meal, ownerKey }，
    //    这里必须使用「按当前身份派生」的餐次名，身份不符时视为未选中。
    const meal = visibleSelectedMeal;
    if (!meal || mealsStatus[meal]) return;
    // 🛡️ Round 4A / CR4-01：校验**回调创建时**身份（originSnapshot），
    //    旧会话回调必须整体 fail-closed——不 setState、不排队云端同步、
    //    不发伴侣通知。否则 storage 侧虽已拒绝写盘，云端仍会收到旧账号的打卡。
    if (!isIdentityCurrent(originSnapshot)) return;
    // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：捕获本次操作所属的「选中实例」。
    //    异步返回后必须同时校验身份 + 实例仍有效，否则会清空新会话的选择。
    const selectionIdAtStart = selectedMeal ? selectedMeal.selectionId : null;
    userInteractedRef.current = true;

    // ① storage 纯本地修改 → ② Haptics → ③ cloud.syncToCloud（防抖）
    const newMeals = { ...mealsStatus, [meal]: true };
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
          // 🛡️ Round 4A / CR4-01：RPC 往返期间身份可能已切换（A→B / A→B→A /
          //    同账号新 authEpoch）。必须在**任何副作用之前**再次校验创建时身份，
          //    否则旧会话会把 A 的搭子绑定 / 通知 / 系统消息写进 B。
          if (!isIdentityCurrent(originSnapshot)) return;
          targetId = activePartnerId || null;
          // 🛡️ T6/A06：走 bindPartner 以自增授权代际，避免旧代际在途请求写回
          if (targetId) bindPartner(targetId);
        } catch (e) {
          console.warn('⚠️ 打卡时解析搭子 ID 失败:', e?.message ?? e);
        }
      }

      // 🛡️ Round 4A / CR4-01：即使 targetId 来自闭包（无需 RPC），也必须在
      //    发送通知 / 写系统消息前再校验一次身份（覆盖 await 之前的同步路径）。
      if (!isIdentityCurrent(originSnapshot)) return;

      if (targetId) {
        // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
        sendPushNotification(targetId, '', `完成了 ${meal} 饮食打卡`, { type: 'health' });

        // ⚠️ messages.id 是 uuid 类型，绝不能传 'sys_xxx' 这类字符串
        //    这里不传 id，交给数据库默认值（gen_random_uuid()）自动生成
        const { error } = await supabase.from('messages').insert({
          user_id: user.id,
          receiver_id: targetId,
          type: 'text',
          text: `完成了 ${meal} 饮食打卡`,
          subtype: 'SYNC_SYSTEM',
        });
        if (error) {
          console.warn('⚠️ 打卡系统消息写入失败:', error.message, error.details ?? '', error.hint ?? '');
        }
      } else {
        console.warn('⚠️ 打卡系统消息未发送：当前用户没有绑定健康搭子');
      }
    }
    // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：异步返回后清理选择前，必须确认
    //    ① 身份仍是创建时身份；② 当前选中实例仍是本次操作对应的实例。
    //    否则 A 的迟到 Promise 会清空 B 刚打开的选择，或清空同账号新打开的实例。
    if (!isIdentityCurrent(originSnapshot)) return;
    setSelectedMeal(prev => {
      if (!prev) return prev;
      if (prev.selectionId !== selectionIdAtStart) return prev;
      return null;
    });
  }, [visibleSelectedMeal, selectedMeal, mealsStatus, waterAmount, user, partnerId, bindPartner, syncToCloud, setMeals, originSnapshot, isIdentityCurrent]);

  const undoCheck = useCallback(() => {
    // 🛡️ Round 4A 收尾 / R4A-01：同 confirmCheck，使用按当前身份派生的餐次名。
    const meal = visibleSelectedMeal;
    if (!meal || !mealsStatus[meal]) return;
    // 🛡️ Round 4A / CR4-01：校验**回调创建时**身份（originSnapshot），
    //    旧会话回调必须整体 fail-closed——不 setState、不排队云端同步。
    if (!isIdentityCurrent(originSnapshot)) return;
    // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：捕获本次操作所属的「选中实例」。
    const selectionIdAtStart = selectedMeal ? selectedMeal.selectionId : null;
    userInteractedRef.current = true;

    // ① storage 纯本地修改 → ② Haptics → ③ cloud.syncToCloud（防抖）
    const newMeals = { ...mealsStatus, [meal]: false };
    setMeals(newMeals);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    syncToCloud(waterAmount, newMeals);
    // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：仅当实例仍是本次操作对应的实例才清理，
    //    避免误清空同账号新打开的餐次选择。
    setSelectedMeal(prev => {
      if (!prev) return prev;
      if (prev.selectionId !== selectionIdAtStart) return prev;
      return null;
    });
  }, [visibleSelectedMeal, selectedMeal, mealsStatus, waterAmount, syncToCloud, setMeals, originSnapshot, isIdentityCurrent]);

  /**
   * 解绑/绑定后强制刷新伴侣关系（供 bind_partner 等页面调用）。
   * 直接查库而不是依赖本地缓存，确保 UI 立刻反映最新绑定状态。
   * @param {string|null} nextPartnerId 已知的新伴侣 ID；传 null 表示解绑
   */
  const refreshPartner = useCallback(async (nextPartnerId = null) => {
    if (!user) return;
    // 🛡️ Round 4A / CR4-01：校验**回调创建时**身份（originSnapshot）。
    //    该回调由 bind_partner / ChatRoomInner 等页面在 await 之后调用，
    //    旧会话闭包在切号后执行会直接 clearPartner / bindPartner / applyPartnerRecord，
    //    把 A 的搭子关系写进 B。必须在任何副作用之前 fail-closed。
    if (!isIdentityCurrent(originSnapshot)) return;
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
      // 🛡️ Round 4A / CR4-01：await 期间身份可能已切换，落库前再校验一次。
      if (!isIdentityCurrent(originSnapshot)) return;
      if (pData) applyPartnerRecord(pData);
    } catch (e) {
      console.warn('⚠️ 刷新伴侣关系失败:', e?.message ?? e);
    }
  }, [user, partnerId, clearPartner, bindPartner, fetchPartnerRecord, applyPartnerRecord, getDateStr, originSnapshot, isIdentityCurrent]);

  const updateMaxWater = useCallback((val) => { setMaxWater(val); }, [setMaxWater]);
  const updateMotto = useCallback((text) => { setMotto(text); }, [setMotto]);
  const updateMealGuide = useCallback((meal, text) => { setMealGuide(meal, text); }, [setMealGuide]);

  // 顺序：① storage 纯本地重置 → ② Haptics → ③ cloud.syncToCloud（防抖）
  const resetToday = useCallback(() => {
    // 🛡️ Round 4A / CR4-01：校验**回调创建时**身份（originSnapshot），
    //    旧会话回调必须整体 fail-closed，避免把「重置」写进新账号本地与云端。
    if (!isIdentityCurrent(originSnapshot)) return;
    userInteractedRef.current = true;
    resetTodayLocal();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    syncToCloud(0, { '早餐': false, '午餐': false, '晚餐': false });
  }, [syncToCloud, resetTodayLocal, originSnapshot, isIdentityCurrent]);

  // 🛡️ Round 4A 收尾 / R4A-01：饮食详情选中态必须绑定「回调创建时身份」。
  //    旧实现 openMeal / closeMeal 无任何身份校验，A 的旧闭包在切到 B 后执行
  //    仍能打开/关闭 B 的弹窗（跨会话残留）。这里复用 originSnapshot 机制 fail-closed。
  const openMeal = useCallback((meal) => {
    if (!isIdentityCurrent(originSnapshot)) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：每次打开生成唯一 selectionId，
    //    使异步回调能区分「同一餐次的不同打开实例」。
    selectionSeqRef.current += 1;
    setSelectedMeal({
      meal,
      ownerKey: `${originSnapshot.userId ?? ''}::${originSnapshot.epoch}`,
      selectionId: selectionSeqRef.current,
    });
  }, [originSnapshot, isIdentityCurrent]);
  const closeMeal = useCallback(() => {
    if (!isIdentityCurrent(originSnapshot)) return;
    setSelectedMeal(null);
  }, [originSnapshot, isIdentityCurrent]);


  // 🛡️ Round 4A 收尾 / R4A-03（修复 1）：向组件暴露「当前选中态所属身份」。
  //    MealDetailSheet 需要它来区分「合法用户关闭」与「身份失效关闭」：
  //    两者都会让 meal 变 null，仅凭 meal 字符串无法区分。
  //    身份切换时 ownerKey 变化 → 组件据此立即作废退出动画的可见性保持。
  const selectedMealOwnerKey = selectedMeal ? selectedMeal.ownerKey : null;

  // 🛡️ Round 4A 最终封版 / FINAL-03 + FINAL-04：**当前认证身份**（唯一权威）。
  //    语义必须与 selectedMealOwnerKey 严格区分：
  //      · currentSessionOwnerKey = 当前 userId + authEpoch，**不**从 selectedMeal 反向推断；
  //        关闭/确认/撤销后 selectedMeal 变 null，它依然保持为当前身份（不会变 null）。
  //      · selectedMealOwnerKey = 「选中态所属身份」，关闭后为 null。
  //    旧实现把后者当作「当前身份」传给 Modal，导致：
  //      FINAL-03：正常关闭后 ownerKey 变 null → Modal 认为身份失效 → 退出动画被截断；
  //      FINAL-04：切号后 selectedMeal 仍保留 A 的对象 → ownerKey 仍是 A →
  //                Modal 误判「身份未变」→ 继续展示 A 的弹窗。
  //    登出时 user 为 null → currentOwnerKey 变为 '::epoch'，与任何已打开会话都不相等，
  //    旧会话的关闭动画自然失效（安全失效）。
  // 🛡️ 同时暴露 selectedMealSelectionId：同账号连续打开同一餐次时 ownerKey 不变，
  //    必须靠 selectionId 区分「不同选择实例」，否则旧关闭动画会误关新实例。
  const selectedMealSelectionId = selectedMeal ? selectedMeal.selectionId : null;

  const value = useMemo(() => ({
    isInitialized: isLoaded, isDoneToday, selectedMeal: visibleSelectedMeal, selectedMealOwnerKey,
    // 🛡️ FINAL-03 / FINAL-04：当前认证身份（不随 selectedMeal 变 null）+ 当前选择实例
    currentSessionOwnerKey: currentOwnerKey, selectedMealSelectionId,
    mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    profile, profileLoading, refreshProfile: loadProfile,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday, refreshPartner
  }), [
    isLoaded, isDoneToday, visibleSelectedMeal, selectedMealOwnerKey, currentOwnerKey, selectedMealSelectionId,
    mealsStatus, waterAmount, maxWater, streakDays, motto, mealGuides, partnerData, partnerId,
    profile, profileLoading, loadProfile,
    openMeal, closeMeal, confirmCheck, undoCheck, handleAddWater, handleMinusWater, setWaterDirect, updateMaxWater, updateMotto, updateMealGuide, resetToday, refreshPartner
  ]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}
export function useHealthData() { return useContext(HealthContext); }
// --- END OF FILE src/hooks/useHealthData.js ---