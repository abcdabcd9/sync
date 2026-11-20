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
 * 负责的 8 个存储 key（TASK-P0.3 / B1-B：全部改为「按账号隔离」的 V2 命名空间）：
 *   @sync_health_v2_${userId}_water / _meals / _maxWater / _motto
 *   @sync_health_v2_${userId}_guides / _streak / _checkIn / _active
 *
 * ⚠️ 旧全局 key（@waterAmount / @mealsStatus / ...）**原样保留、绝不读写、绝不迁移**：
 *    它们属于「无主历史数据」，按 P2 决策原地隔离，正常 UI 不可见。
 *    新账号绝不读取旧值，也绝不把旧值自动认领或上传云端。
 */

const EMPTY_MEALS = { '早餐': false, '午餐': false, '晚餐': false };

/** V2 用户作用域 key 前缀（版本化，便于未来演进） */
const HEALTH_KEY_PREFIX = '@sync_health_v2_';

/** 字段名 → 后缀（与旧 KEYS 一一对应，仅命名空间变化） */
const FIELD_SUFFIX = {
  water: 'water',
  meals: 'meals',
  maxWater: 'maxWater',
  motto: 'motto',
  guides: 'guides',
  streak: 'streak',
  checkIn: 'checkIn',
  active: 'active',
};

/**
 * 构造某个用户的 8 个存储 key。
 * 无有效 userId 时返回 null —— 调用方必须据此跳过所有磁盘读写。
 * @param {string|null|undefined} userId
 * @returns {Record<string,string>|null}
 */
export function buildHealthKeys(userId) {
  if (!userId || typeof userId !== 'string') return null;
  const keys = {};
  for (const [field, suffix] of Object.entries(FIELD_SUFFIX)) {
    keys[field] = `${HEALTH_KEY_PREFIX}${userId}_${suffix}`;
  }
  return keys;
}

/**
 * @param {string} todayStr 服务器校准后的"今天"（YYYY-MM-DD），跨天检测依赖它
 * @param {string|null} userId 当前登录用户 id；无有效 id 时不读写任何磁盘
 * @param {number} authEpoch 身份代际（来自 AuthProvider）。同账号新会话（A→登出→A）
 *   时 userId 不变但 authEpoch 自增，必须让旧会话的 load/hydrate/自动落盘失效。
 */
export function useHealthStorage(todayStr, userId = null, authEpoch = 0) {
  const [isLoaded, setIsLoaded] = useState(false);

  // 当前生效的 key 集合（随 userId 变化重建）
  const keys = useMemo(() => buildHealthKeys(userId), [userId]);
  const keysRef = useRef(keys);
  useEffect(() => { keysRef.current = keys; }, [keys]);

  // 当前 userId 的 ref 镜像（供异步 load 写回前比对，防止旧账号结果覆盖新账号）
  const userIdRef = useRef(userId);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

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
  // 🛡️ X-03 / CR-05：记录「当前内存态是为哪个 owner + 哪个会话代际加载的」。
  //    旧实现 loadedOwnerRef 只存 userId，无法区分 A→B→A（userId 相同但会话不同）
  //    与「同账号登出再登录」——旧会话的 load/hydrate/自动落盘会误判为同一 owner，
  //    把旧会话数据写进新会话。
  //    修复：引入 sessionEpochRef，每次 userId 变化（含 A→B→A）自增；
  //    loadedOwnerRef 存 { userId, epoch }，自动落盘与 hydrate 都必须同时匹配。
  const sessionEpochRef = useRef(0);
  const loadedOwnerRef = useRef(null); // { userId, epoch } | null

  // 🛡️ T6-B 第二轮复审 14-02（BLOCKER）：会话代际必须同时感知「userId 变化」与
  //    「AuthProvider 的 authEpoch 变化」。
  //
  //    旧实现只在 userId 变化时自增 sessionEpochRef。但「同账号新会话」
  //    （A→登出→A 重新登录，或 A→B→A 中 A 的第二次登录）userId 相同，
  //    AuthProvider 已 bump authEpoch，而 HealthStorage 的 sessionEpochRef 不变 →
  //    旧会话在途的云端查询返回后，expectedOwnerId + expectedEpoch 仍与当前一致 →
  //    旧会话数据被写进新会话的本地 key。
  //
  //    修复：把 authEpoch 纳入会话代际判定。authEpoch 变化（真实身份转移）时
  //    同样自增 sessionEpochRef 并作废旧加载标记。
  //    注意：正常 TOKEN_REFRESHED 不会 bump authEpoch（见 useAuth CR-06），
  //    因此不会误伤合法在途请求。
  const epochUserIdRef = useRef(userId);
  const epochAuthEpochRef = useRef(authEpoch);
  useEffect(() => {
    const userIdChanged = epochUserIdRef.current !== userId;
    const authEpochChanged = epochAuthEpochRef.current !== authEpoch;
    if (userIdChanged || authEpochChanged) {
      epochUserIdRef.current = userId;
      epochAuthEpochRef.current = authEpoch;
      sessionEpochRef.current += 1;
      // 旧会话的加载标记立即失效，防止新会话 load 完成前旧内存态被落盘。
      loadedOwnerRef.current = null;
      isLoadedRef.current = false;
    }
  }, [userId, authEpoch]);

  /**
   * 从磁盘加载全部数据，并执行跨天清零。
   * 只读磁盘，不涉及任何网络。
   */
  const load = useCallback(async () => {
    const k = keysRef.current;
    // 无有效 userId → 不读任何磁盘，保持空状态（绝不读取旧全局 key）
    if (!k) {
      isLoadedRef.current = false;
      loadedOwnerRef.current = null;
      setIsLoaded(false);
      return;
    }

    // 快照发起时的 userId + 会话代际，用于 await 之后比对
    // （防止旧账号 / 旧会话结果覆盖新账号 / 新会话）。
    const loadUserId = userIdRef.current;
    const loadEpoch = sessionEpochRef.current;

    const [savedWater, savedMeals, savedMaxWater, savedMotto, savedGuides, savedStreak, savedCheckIn, savedActive] = await Promise.all([
      AsyncStorage.getItem(k.water), AsyncStorage.getItem(k.meals),
      AsyncStorage.getItem(k.maxWater), AsyncStorage.getItem(k.motto), AsyncStorage.getItem(k.guides),
      AsyncStorage.getItem(k.streak), AsyncStorage.getItem(k.checkIn), AsyncStorage.getItem(k.active),
    ]);

    // 🛡️ 身份或会话代际已切换 → 丢弃本次读取结果，绝不写回新账号/新会话状态
    if (userIdRef.current !== loadUserId || sessionEpochRef.current !== loadEpoch) return;

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
        AsyncStorage.setItem(k.streak, '0');
      } else if (calculateDiffDays(todayStr, savedCheckIn) > 1) {
        // 正常断档超过 1 天，清零
        currentStreak = 0;
        AsyncStorage.setItem(k.streak, '0');
      }
    }
    setStreakDays(currentStreak);
    if (savedCheckIn) setLastCheckInDate(savedCheckIn);

    // ---- 跨天清零：当日饮水/三餐重置 ----
    // ⚠️ 必须同时满足「有上次活跃日期」且「与今天不同」才清零：
    //    首次安装（savedActive 为 null）时不应误判为跨天，但仍需写入今天的活跃日期。
    //
    // 🛡️ BUG-01（D-11）修复：仅当「上次活跃日期 < 今天」（正常向前跨天）才清零。
    //    若「上次活跃日期 > 今天」（系统时间被回拨到过去），绝不能清零——
    //    否则用户把手机日期调回昨天后，今天已记录的数据会被误判为「跨天」而清空，
    //    随后新操作写入「昨天」槽位，造成数据被覆盖/丢失。
    //    与上方 streak 分支的方向判断保持一致（savedTime > todayTime 视为时间流异常）。
    const savedActiveTime = savedActive ? new Date(savedActive).getTime() : NaN;
    const todayTime = new Date(todayStr).getTime();
    const isForwardDayChange = savedActive && savedActive !== todayStr && savedActiveTime < todayTime;
    const isBackwardClockSkew = savedActive && savedActive !== todayStr && savedActiveTime > todayTime;

    if (isForwardDayChange) {
      // 已跨过 24 小时进入新的一天 → 第 0 帧彻底清零，并立即回写磁盘，
      // 确保冷启动 / 跨天切回 App 时昨天的饮水与三餐状态 100% 不会残留。
      setWaterAmount(0);
      setMealsStatus(EMPTY_MEALS);
      setLastActiveDate(todayStr);
      await AsyncStorage.setItem(k.water, '0');
      await AsyncStorage.setItem(k.meals, JSON.stringify(EMPTY_MEALS));
      await AsyncStorage.setItem(k.active, todayStr);
    } else {
      // 正常同日 / 首次安装 / 系统时间回拨（savedActive > todayStr）：
      // 一律保留磁盘数据，绝不清零。回拨场景仅记录告警，不修改任何数据。
      if (isBackwardClockSkew) {
        console.warn(
          '[useHealthStorage] 检测到系统日期回拨（上次活跃 %s > 今天 %s），保留本地数据不清零',
          savedActive,
          todayStr
        );
      }
      setLastActiveDate(savedActive || todayStr);
      if (savedWater) setWaterAmount(Number(savedWater));
      if (savedMeals) setMealsStatus(JSON.parse(savedMeals));
      // 首次安装（无活跃日期）→ 补写今天的活跃日期，供下次跨天检测使用
      if (!savedActive) {
        await AsyncStorage.setItem(k.active, todayStr);
      }
    }

    // 再次确认身份 + 会话代际未变，才允许标记已加载（否则新账号/新会话的 load 会自行接管）
    if (userIdRef.current !== loadUserId || sessionEpochRef.current !== loadEpoch) return;
    isLoadedRef.current = true;
    // 🛡️ X-03 / CR-05：标记「内存态已为 {loadUserId, loadEpoch} 加载完成」，
    //    供自动落盘 effect 与 hydrate 校验归属（含 ABA 与同账号重登）。
    loadedOwnerRef.current = { userId: loadUserId, epoch: loadEpoch };
    setIsLoaded(true);
  }, [todayStr]);

  /**
   * 用云端数据显式覆盖本地状态（并同步落盘）。
   * 由编排层在拿到 health_records 后调用。
   *
   * 🛡️ X-02 / CR-05：必须显式传入期望 owner 与期望会话代际。
   *    旧实现 expectedOwnerId 默认 null 可绕开 owner 检查；且只比对 userId，
   *    无法拦截 A→B→A / 同账号重登的旧会话迟到写入。
   *    修复：expectedOwnerId 与 expectedEpoch 都必须与当前一致才允许写盘；
   *    任一为 null/undefined 或与当前不符 → 直接丢弃（fail-closed）。
   * @param {{waterAmount?: number, mealsStatus?: object}} data
   * @param {string|null} expectedOwnerId 发起云端请求时的 owner
   * @param {number} expectedEpoch 发起云端请求时的会话代际
   */
  const hydrateFromCloud = useCallback((data, expectedOwnerId = null, expectedEpoch = null) => {
    if (!data) return;
    // 🛡️ fail-closed：未声明期望 owner / 代际 → 拒绝写盘（不允许默认放行）。
    if (!expectedOwnerId) return;
    if (expectedOwnerId !== userIdRef.current) return;
    if (expectedEpoch === null || expectedEpoch === undefined) return;
    if (expectedEpoch !== sessionEpochRef.current) return;
    const k = keysRef.current;
    if (!k) return; // 无有效 userId → 不写盘
    if (typeof data.waterAmount === 'number') {
      setWaterAmount(data.waterAmount);
      AsyncStorage.setItem(k.water, data.waterAmount.toString());
    }
    if (data.mealsStatus) {
      setMealsStatus(data.mealsStatus);
      AsyncStorage.setItem(k.meals, JSON.stringify(data.mealsStatus));
    }
  }, []);

  // ---- 纯本地 setter（写 state + 落盘，无网络）----
  // 所有落盘均通过 keysRef.current 取当前账号 key；无 userId 时只更新内存 state。
  //
  // 🛡️ T6-B 第二轮复审 14-06（RISK → CONFIRMED 可达）：
  //    这些 setter 是稳定 callback（deps 为空），执行时才读 keysRef.current。
  //    可达的跨身份延迟路径：设置页 Alert.alert 的确认按钮
  //    （src/app/settings/health.js:61-71，onPress: () => resetToday()）。
  //    用户点「重置」→ 弹框 → 期间切换账号 / A→B→A → 再点「重置」，
  //    旧闭包执行时 keysRef.current 已是新账号 key → 把新账号数据写成 0。
  //    修复：setter 在**创建时**快照 owner+epoch，执行时与当前值比对；
  //    不匹配则只更新内存 state、绝不落盘（fail-closed）。
  //    注意：不能用「执行时读 ref」的方式判断来源，那正是缺陷本身。
  //
  // ⚠️ 关键：快照必须在 setter **创建时**捕获，而不是执行时读 ref。
  //    旧实现 `const snapshot = ownerAtCreateRef.current;` 在回调体内执行时读取，
  //    而 ownerAtCreateRef 已被 effect 更新为「当前身份」→ snapshot 恒等于当前值 →
  //    canPersist 恒为 true → 旧闭包照样写新账号 key（缺陷本身）。
  //    修复：setter 依赖 [userId, authEpoch]，身份变化时重建；闭包变量 userId/authEpoch
  //    即「创建时身份」，执行时与实时镜像比对，不一致则只更新内存、绝不落盘。
  const authEpochRef = useRef(authEpoch);
  useEffect(() => { authEpochRef.current = authEpoch; }, [authEpoch]);

  /**
   * 🛡️ T6-B 第三轮复审 15-01（BLOCKER）：身份校验必须**先于任何 setState**。
   *
   *    上一轮（14-06）只把 IO 包在 canPersist 里，但 setter 仍先执行 setState：
   *    旧账号 setter 在 B 已加载完成后触发时，虽然磁盘写入被拒，却把 B 的 React
   *    state 改成旧值；随后自动落盘 effect（owner/epoch 校验对 B 合法通过）把
   *    这个被污染的 state 写进 **B 的 V2 key**。
   *
   *    修复：每个 setter 进入时先调用 isIdentityCurrent(snapshot)；
   *    身份不匹配则**整体 fail-closed**——不 setState、不改 ref、不写盘。
   *
   *    snapshot 在 setter **创建时**捕获（依赖 [userId, authEpoch]），
   *    执行时与实时镜像 userIdRef / authEpochRef 比对。
   */
  const isIdentityCurrent = useCallback((snapshot) => {
    if (!snapshot) return false;
    if (snapshot.userId !== userIdRef.current) return false;
    if (snapshot.epoch !== authEpochRef.current) return false;
    return !!keysRef.current;
  }, []);

  const setWater = useCallback((val) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setWaterAmount(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      AsyncStorage.setItem(keysRef.current.water, next.toString());
      return next;
    });
  }, [isIdentityCurrent, userId, authEpoch]);

  const setMeals = useCallback((val) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setMealsStatus(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      AsyncStorage.setItem(keysRef.current.meals, JSON.stringify(next));
      return next;
    });
  }, [isIdentityCurrent, userId, authEpoch]);

  const setMaxWaterValue = useCallback((val) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setMaxWater(val);
    AsyncStorage.setItem(keysRef.current.maxWater, val.toString());
    setWaterAmount(prev => {
      const next = prev > val ? val : prev;
      if (next !== prev) AsyncStorage.setItem(keysRef.current.water, next.toString());
      return next;
    });
  }, [isIdentityCurrent, userId, authEpoch]);

  const setMottoValue = useCallback((text) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setMotto(text);
    AsyncStorage.setItem(keysRef.current.motto, text);
  }, [isIdentityCurrent, userId, authEpoch]);

  const setMealGuideValue = useCallback((meal, text) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setMealGuides(prev => {
      const updated = { ...prev, [meal]: text };
      AsyncStorage.setItem(keysRef.current.guides, JSON.stringify(updated));
      return updated;
    });
  }, [isIdentityCurrent, userId, authEpoch]);

  const setStreak = useCallback((val) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setStreakDays(val);
    AsyncStorage.setItem(keysRef.current.streak, val.toString());
  }, [isIdentityCurrent, userId, authEpoch]);

  const setCheckInDate = useCallback((val) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setLastCheckInDate(val);
    const k = keysRef.current;
    // ⚠️ AsyncStorage 不接受 null/undefined，撤销打卡归零时传 null 会抛错，
    //    因此 null 语义等价于"无打卡记录"，直接删除该键。
    if (val === null || val === undefined) {
      AsyncStorage.removeItem(k.checkIn);
    } else {
      AsyncStorage.setItem(k.checkIn, String(val));
    }
  }, [isIdentityCurrent, userId, authEpoch]);

  const setActiveDate = useCallback((val) => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setLastActiveDate(val);
    const k = keysRef.current;
    if (val === null || val === undefined) {
      AsyncStorage.removeItem(k.active);
    } else {
      AsyncStorage.setItem(k.active, String(val));
    }
  }, [isIdentityCurrent, userId, authEpoch]);

  /** 重置今日饮水与三餐（纯本地，不推送云端） */
  const resetTodayLocal = useCallback(() => {
    const snapshot = { userId, epoch: authEpoch };
    if (!isIdentityCurrent(snapshot)) return;
    setWaterAmount(0);
    setMealsStatus(EMPTY_MEALS);
    const k = keysRef.current;
    AsyncStorage.setItem(k.water, '0');
    AsyncStorage.setItem(k.meals, JSON.stringify(EMPTY_MEALS));
  }, [isIdentityCurrent, userId, authEpoch]);

  // 加载完成后，饮水/三餐变化自动落盘（替代原 useHealthData 中的持久化 effect）
  // 🛡️ X-03 / CR-05：必须校验「内存态归属」与「当前 userId + 会话代际」一致。
  //    身份切换后、新账号 load() 完成前，loadedOwnerRef 仍是旧账号/旧会话，
  //    此时自动落盘必须跳过，绝不能用旧账号/旧会话内存态覆盖新账号已存数据。
  //    CR-05：仅比对 userId 无法覆盖 A→B→A（userId 相同但会话不同），
  //    因此同时比对 epoch。
  useEffect(() => {
    if (!isLoadedRef.current) return;
    const owner = loadedOwnerRef.current;
    if (!owner) return;
    if (owner.userId !== userIdRef.current) return;
    if (owner.epoch !== sessionEpochRef.current) return;
    const k = keysRef.current;
    if (!k) return;
    AsyncStorage.setItem(k.water, waterAmount.toString());
    AsyncStorage.setItem(k.meals, JSON.stringify(mealsStatus));
  }, [waterAmount, mealsStatus]);

  // 🆔 TASK-P0.3 / B1-B：身份切换时「清空当前 Provider 的用户级内存状态」。
  //    必须在读取新账号磁盘数据之前完成，确保 UI 不会把上一个账号的
  //    饮水/三餐/连续天数当作新账号的加载占位符展示。
  //    注意：这里只重置内存 state，不删除任何磁盘数据（旧账号 V2 key 原样保留）。
  //    采用 React 官方推荐的「渲染期调整 state」模式（而非 effect 内 setState），
  //    既能在读取新账号数据前完成重置，又避免级联渲染告警。
  //    ⚠️ 渲染期只允许 setState，不允许写 ref（react-hooks/refs）。
  //       isLoadedRef 的同步置位由 load() 在读取前负责（见 load 内 !k 分支）。
  const [prevUserId, setPrevUserId] = useState(userId);
  if (prevUserId !== userId) {
    setPrevUserId(userId);
    setIsLoaded(false);
    setWaterAmount(0);
    setMealsStatus(EMPTY_MEALS);
    setMaxWater(1800);
    setMotto('今日概览');
    setMealGuides(DEFAULT_MEALS);
    setStreakDays(0);
    setLastCheckInDate(null);
    setLastActiveDate(null);
  }

  // 🛡️ CR-05：对外暴露「读取当前会话代际」的稳定函数，
  //    供编排层在发起云端请求前快照 epoch，并在 hydrate 时回传校验。
  const getSessionEpoch = useCallback(() => sessionEpochRef.current, []);

  // 🛡️ T6-B 第三轮复审 15-01：对外暴露「当前身份快照」与「校验函数」，
  //    供 useHealthData 的 setWaterDirect / scheduleWaterSync 在写 shadow ref
  //    或排队云端同步前，用与 storage setter 完全相同的口径验证回调来源身份。
  //    getIdentitySnapshot 返回**当前实时** { userId, epoch }（执行时读取）；
  //    isIdentityCurrent(snapshot) 判断某快照是否仍等于当前实时身份。
  const getIdentitySnapshot = useCallback(
    () => ({ userId: userIdRef.current, epoch: authEpochRef.current }),
    []
  );

  return useMemo(() => ({
    isLoaded,
    userId,
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
    getSessionEpoch,
    getIdentitySnapshot,
    isIdentityCurrent,
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
    isLoaded, userId, waterAmount, mealsStatus, maxWater, motto, mealGuides,
    streakDays, lastCheckInDate, lastActiveDate,
    load, hydrateFromCloud, getSessionEpoch, getIdentitySnapshot, isIdentityCurrent,
    setWater, setMeals, setMaxWaterValue,
    setMottoValue, setMealGuideValue, setStreak, setCheckInDate, setActiveDate, resetTodayLocal,
  ]);
}

// --- END OF FILE src/hooks/health/useHealthStorage.js ---
