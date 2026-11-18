// --- START OF FILE src/hooks/health/useHealthCloud.js ---
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../services/supabase';
import {
  createRevokeVerifier,
  isAuthEventRelevant,
  shouldRevokeOnAuthChange,
} from './authRevokeLogic';

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

export function useHealthCloud(user, getDateStr) {
  const [partnerData, setPartnerData] = useState({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  const [partnerId, setPartnerId] = useState(null);

  const timerRef = useRef(null);
  const pendingRef = useRef(null);

  // 🛡️ T6/A06：授权代际令牌。
  //    每次「搭子关系发生变化」（绑定 / 解绑 / 权威空结果）都会自增。
  //    任何在途的 fetchPartnerRecord / 实时回调在写回 state 前必须比对代际，
  //    代际不一致说明授权已变更，其结果属于过期数据，必须丢弃。
  //    这解决了「解绑后旧请求晚到，把已撤销搭子的健康数据写回缓存」的竞争问题。
  //
  // 🔧 T7-H22 修复：代际同时以 ref + state 双轨维护。
  //    · ref（authGenerationRef）：供异步回调同步读取，零延迟、不触发重渲染。
  //    · state（authGeneration）：供 React 依赖数组使用，让「重绑同一搭子」
  //      这种 partnerId 值未变化、但授权代际已变的场景也能触发订阅重建。
  //    旧实现只有 ref，导致 B↔C 反复绑定同一人时 partnerId 值不变 →
  //    subscribePartner 的 useEffect 不重跑 → 旧订阅已被 cleanup 移除 →
  //    没有任何实时订阅存活，只能重启 App 才刷新。
  const authGenerationRef = useRef(0);
  const [authGeneration, setAuthGeneration] = useState(0);
  const bumpAuthGeneration = useCallback(() => {
    authGenerationRef.current += 1;
    const next = authGenerationRef.current;
    setAuthGeneration(next);
    return next;
  }, []);

  // 🔧 T7-H22：partnerId 的 ref 镜像。
  //    实时回调里用它做「当前是否仍是这个搭子」的实时判定，
  //    替代旧实现「订阅建立时快照 gen，回调时 gen 不一致就丢弃」的做法。
  //    旧做法在重绑同一人后会让订阅永久失效（gen 已变但订阅未重建）。
  const partnerIdRef = useRef(null);
  useEffect(() => {
    partnerIdRef.current = partnerId;
  }, [partnerId]);

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
      // PGRST116 代表没有数据（用户今天还没打卡），属于正常情况不抛错
      if (error && error.code !== 'PGRST116') throw error;
      return data || null;
    } catch (e) {
      console.warn('⚠️ 拉取本人 health_records 失败(离线状态)', e?.message || e);
      return null;
    }
  }, [user]);

  /** 
   * ⚡ 核心修复：拉取伴侣的今日记录 (Cache-First 离线秒开架构) 
   */
  const fetchPartnerRecord = useCallback(async (pId, date) => {
    if (!pId) return null;
    const cacheKey = `@partner_health_${pId}_${date}`;

    // 🛡️ T6/A06：进入时快照当前授权代际。
    //    任何 await 之后写回 state 前都必须比对；不一致说明授权已变更
    //    （解绑 / 换绑 / 权威空结果），本次结果必须整体丢弃，绝不写回缓存。
    const gen = authGenerationRef.current;

    // 1. 离线缓存优先加载（第 0 帧秒开，断网绝不显示 0）
    try {
      const cachedStr = await AsyncStorage.getItem(cacheKey);
      if (cachedStr && gen === authGenerationRef.current) {
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

      if (error && error.code !== 'PGRST116') throw error;

      // 🛡️ 网络往返期间授权可能已被撤销 → 丢弃过期结果
      if (gen !== authGenerationRef.current) return null;

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
      console.warn('离线状态，使用本地缓存的搭子健康数据', e?.message || e);
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

  /**
   * 🧹 T6/A06：权威清空搭子状态。
   *
   * 与旧实现的区别：
   *   1. 先自增授权代际 → 所有在途 fetchPartnerRecord / 实时回调立即失效
   *   2. 清空 partnerId 与 partnerData（不再「null 不覆盖」而保留陈旧搭子）
   *   3. 删除该搭子的本地健康缓存镜像，避免下次冷启动把已撤销搭子的数据读回来
   *
   * @param {string|null} stalePartnerId 已知被撤销的搭子 id（用于清理缓存键）
   */
  const clearPartner = useCallback((stalePartnerId = null) => {
    bumpAuthGeneration();
    setPartnerId(null);
    setPartnerData({ waterAmount: 0, mealsStatus: EMPTY_MEALS });

    if (stalePartnerId) {
      // 清理该搭子所有日期的本地缓存镜像（键格式：@partner_health_<id>_<date>）
      const prefix = `@partner_health_${stalePartnerId}_`;
      AsyncStorage.getAllKeys()
        .then((keys) => {
          const stale = keys.filter((k) => k.startsWith(prefix));
          if (stale.length > 0) return AsyncStorage.multiRemove(stale);
          return null;
        })
        .catch(() => {});
    }
  }, [bumpAuthGeneration]);

  /**
   * 🔗 T6/A06：确认/切换搭子关系时调用，使旧代际的在途请求全部失效。
   *    绑定新搭子或权威复验确认关系仍有效时使用。
   */
  const bindPartner = useCallback((nextPartnerId) => {
    bumpAuthGeneration();
    setPartnerId(nextPartnerId ?? null);
  }, [bumpAuthGeneration]);

  /**
   * 🔔 T6.1/FIX-05：订阅「授权关系变更」，用于实时感知对方解绑。
   *
   * 为什么需要单独订阅：
   *   迁移 16 的 Realtime 白名单原本不含 partner_authorizations，
   *   对方解绑时本端收不到任何事件，只能等切前台复验或冷启动。
   *   迁移 27 已把该表加入白名单，且 RLS 限定订阅者只能收到
   *   「自己参与的行」，因此这里可以安全订阅。
   *
   * ⚠️ FIX-05 关键约束：**绝不依赖 `payload.old.status`**。
   *   Supabase Realtime 的 postgres_changes UPDATE 事件，只有在表设置了
   *   `REPLICA IDENTITY FULL` 时才会在 `payload.old` 里带上旧列值；否则
   *   `payload.old` 只包含主键（id）。本表（迁移 20）并未设置 FULL，
   *   因此旧实现里 `prev.status === 'accepted'` 恒为 false，撤销事件被
   *   静默丢弃 —— 这正是 FIX-05 要修复的缺陷。
   *
   *   正确做法：收到任何「与本端当前搭子相关」的 UPDATE 事件后，
   *   **重新向服务端权威复验**（get_active_partner_id RPC），以服务端
   *   返回的有效搭子为准：
   *     · 服务端仍返回同一 pId → 授权仍有效，忽略该事件；
   *     · 服务端返回 null 或不同的 id → 授权已撤销/变更，调用 onRevoked()。
   *   这样既不依赖 payload.old，也不依赖 payload.new 的字段完整性，
   *   一切以服务端权威状态为准。
   *
   * 账号切换隔离：
   *   · 订阅建立时快照授权代际 gen；回调触发时若代际已变（本端主动解绑/
   *     换绑/账号切换），直接丢弃，避免旧账号的异步结果写回。
   *   · 复验 RPC 是异步的，await 之后再次比对代际，防止复验期间发生切换。
   *
   * @param {string|null} pId 当前搭子 id（用于过滤，避免无关授权事件触发清空）
   * @param {Function} onRevoked 撤销回调
   */
  const subscribeAuthorization = useCallback((pId, onRevoked) => {
    if (!pId) return () => {};

    const channelName = `partner_auth_${pId}_${Date.now()}`;
    const gen = authGenerationRef.current;

    // 🔒 T6.2 收尾：复验协调器（verifying / pending 状态机）。
    //   复验期间若又收到新事件，不能直接丢弃 —— 因为当前这次复验的 RPC 可能
    //   早于「新事件所代表的状态变更」发出，其返回结果无法反映最新状态。
    //   协调器会标记 pending，待当前复验结束后**再复验一次**，确保最终以
    //   最新服务端状态为准（否则可能漏掉撤销）。
    //   状态机抽到 authRevokeLogic.createRevokeVerifier，生产与测试共用同一实现。
    const verifier = createRevokeVerifier({
      // 代际已变更（本端已主动解绑/换绑/账号切换）→ 丢弃结果且不再复验
      isStale: () => gen !== authGenerationRef.current,
      // 🔒 以服务端权威状态为准，不信任 payload.old / payload.new
      verify: () => supabase.rpc('get_active_partner_id'),
      onResult: (rpcResult) => {
        // 网络异常 → 保持现状，绝不清空（避免抖动误删搭子）
        if (rpcResult?.error) {
          console.warn('⚠️ 授权复验失败，保持现状:', rpcResult.error?.message ?? rpcResult.error);
          return;
        }
        // 纯函数决策：服务端仍确认当前搭子有效 → 忽略；否则触发撤销
        if (shouldRevokeOnAuthChange(rpcResult, pId)) {
          console.log('🔔 授权复验确认搭子已失效，触发撤销:', rpcResult?.data ?? null);
          onRevoked?.();
        }
      },
    });

    const verifyAndMaybeRevoke = () => {
      // 协调器内部已捕获 verify 异常语义（onResult 不抛），此处仅触发
      verifier.trigger().catch((e) => {
        console.warn('⚠️ 授权复验异常，保持现状:', e?.message ?? e);
      });
    };

    try {
      supabase
        .getChannels()
        .filter((ch) => ch.topic === `realtime:${channelName}`)
        .forEach((ch) => supabase.removeChannel(ch));

      const channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'partner_authorizations' },
          (payload) => {
            // 授权代际已变更（本端已主动解绑/换绑）→ 无需重复处理
            if (gen !== authGenerationRef.current) return;

            // 只处理与本端当前搭子相关的关系（纯函数，绝不读 payload.old.status）。
            // 无法排除相关性时交给服务端复验兜底（宁可多查一次）。
            if (!isAuthEventRelevant(payload, pId)) return;

            // 不依赖 payload.old.status：直接向服务端复验权威状态
            verifyAndMaybeRevoke();
          }
        )
        .subscribe();

      return () => supabase.removeChannel(channel);
    } catch (e) {
      console.warn('搭子授权订阅离线失败，静默降级', e?.message || e);
      return () => {};
    }
  }, []);

  /** ⚡ 核心修复：订阅伴侣变更（支持离线防崩与缓存回写） */
  const subscribePartner = useCallback((pId, date) => {
    if (!pId) return () => {};

    const channelName = `partner_health_${pId}_${Date.now()}`;
    const cacheKey = `@partner_health_${pId}_${date}`;

    // 🛡️ T7-H22：不再快照授权代际做丢弃判断。
    //    原实现用 `gen !== authGenerationRef.current` 丢弃事件，本意是防止
    //    「解绑后旧 channel 的在途事件写回」。但订阅本身在 partnerId 变化时
    //    就会被 cleanup 移除，代际判断反而导致「重绑同一搭子」后订阅永久失效
    //    （partnerId 值未变 → effect 不重建 → 旧订阅已被移除 → 无订阅存活）。
    //    改为在回调内实时比对 partnerIdRef，语义更准确：
    //    只有「当前搭子已不是这个 pId」时才丢弃事件。
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
            // 当前搭子已变更（解绑 / 换人）→ 忽略过期实时事件
            if (partnerIdRef.current !== pId) return;
            if (payload.new && payload.new.record_date === date) {
              const newData = {
                waterAmount: payload.new.water_amount || 0,
                mealsStatus: payload.new.meals_status || EMPTY_MEALS,
              };
              // 实时更新内存并同步存入本地磁盘
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

  // 🔑 T6.1/FIX-05：账号切换时必须重置授权代际与搭子状态。
  //
  // 问题：authGenerationRef 只在「绑定/解绑/权威空结果」时自增，
  //   账号切换（user.id 变化）不会触发。若 A 账号有搭子、切到 B 账号，
  //   partnerId / partnerData 仍是 A 的残留值，B 会短暂看到 A 的搭子卡片
  //   与健康数据，且旧代际的在途请求仍可能写回。
  //
  // 处理：user.id 变化时自增代际（作废所有在途请求）+ 清空 partnerId /
  //   partnerData。注意这里**不**清理磁盘缓存（那是 clearPartner 的职责，
  //   需要具体 stalePartnerId），账号切换由 useHealthData 的 profile 加载负责。
  const lastUserIdRef = useRef(user?.id ?? null);
  useEffect(() => {
    const nextUserId = user?.id ?? null;
    if (lastUserIdRef.current === nextUserId) return;
    lastUserIdRef.current = nextUserId;

    // 作废所有在途请求与实时回调
    bumpAuthGeneration();
    setPartnerId(null);
    setPartnerData({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  }, [user?.id, bumpAuthGeneration]);

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
    // 🔧 T7-H22：对外暴露授权代际 state，供 useHealthData 的订阅 effect 纳入依赖，
    //    使「重绑同一搭子」（partnerId 值不变、代际已变）也能重建实时订阅。
    authGeneration,
    setPartnerId,
    bindPartner,
    clearPartner,
    fetchMyRecord,
    fetchPartnerRecord,
    applyPartnerRecord,
    subscribePartner,
    subscribeAuthorization,
    syncToCloud,
    flushNow,
  }), [
    partnerData, partnerId, authGeneration, bindPartner, clearPartner, fetchMyRecord,
    fetchPartnerRecord, applyPartnerRecord, subscribePartner, subscribeAuthorization,
    syncToCloud, flushNow,
  ]);
}
// --- END OF FILE src/hooks/health/useHealthCloud.js ---