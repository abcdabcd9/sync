// --- START OF FILE src/hooks/browser/useWatchHistory.js ---
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  WATCH_HISTORY_LIMIT,
  buildWatchHistoryKey,
  buildWatchRecord,
  normalizeWatchList,
  upsertWatchRecord,
} from './watchHistoryLogic';

/**
 * 🎬 浏览器视频观看历史 域 Hook（V1）
 *
 * 职责：
 *   1. 按 owner 读取 / 写入观看历史（AsyncStorage）
 *   2. 播放进度 upsert（同一 mediaKey 更新同一条，不新增）
 *   3. 单条删除 / 一键清空
 *
 * 🆔 身份隔离（与 useBrowserHistory 完全一致的策略）
 *   - 存储 key：@sync_watch_history_v1_${userId}
 *   - 无有效 userId → 不读、不写、不展示（防跨账号泄漏）
 *   - 写回调闭包绑定「事件发起时的 userId + authEpoch」，
 *     执行时与 ref 比对，不一致即整条丢弃（覆盖 A→B→A 的迟到回调）
 *   - 采用「先算 next → 校验 owner+key → setState → 落盘」顺序，
 *     绝不在 setState updater 内做 IO
 *
 * 🔒 安全
 *   - 落盘前由 watchHistoryLogic 统一剥离敏感查询参数
 *   - 不持久化 token / cookie / Authorization
 *
 * 🛡️ P0-4 多实例一致性（本文件核心修复）
 *   问题：本 Hook 在浏览器页 / 观看历史页 / 影院页各实例化一次，旧实现每个实例
 *         持有独立的 watchList state + watchListRef，异步写入无统一队列 →
 *         旧记录覆盖新进度、已删除记录被旧写入复活。
 *   方案：引入「模块级共享存储」（按 owner key 分桶），所有实例共享同一份
 *         权威列表 + 同一写入队列。不引入任何全局状态框架，仅一个普通 Map。
 *   保证：
 *     - 同 owner 的读写共享同一权威状态（跨实例立即可见）
 *     - 初始加载完成前，空列表绝不覆盖磁盘已有数据（loaded 标记）
 *     - 并发进度更新不倒退（upsert 基于共享权威列表）
 *     - 删除 / 清空后，旧异步写入不会复活（写队列串行 + 删除后版本号推进）
 *     - 严格账号隔离（按 key 分桶，切号即换桶）
 *     - authEpoch 变化后旧回调失效
 *     - 写失败不崩溃 UI（catch 吞掉）
 *
 * ⚠️ 本 Hook 只负责「数据」，不触碰播放器与 UI。
 *
 * @param {string|null} userId 当前登录用户 id
 * @param {number} authEpoch 身份代际（来自 AuthProvider）
 */

// ============================================================
// 🗂️ 模块级共享存储（按 owner key 分桶）
//    每个桶：{ list, loaded, loadFailed, version, queue, pendingOps }
//      list        当前权威列表（所有实例共享）
//      loaded      是否已完成首次磁盘加载（未加载前禁止用空列表覆盖磁盘）
//      loadFailed  首次读盘是否失败（失败时禁止落盘，避免用空/残缺列表覆盖磁盘）
//      version     版本号：每次「权威变更」+1，用于丢弃过期的异步写入
//      queue       串行写入 Promise 链，保证落盘顺序与内存态一致
//      pendingOps  首次读盘期间发生的「权威变更」操作日志（按发生顺序）
//                  ⚠️ 这是修复「hydration 期间 clear/delete 被磁盘数据复活」的关键：
//                     读盘是异步的，期间用户可能新增 / 更新 / 删除 / 清空。
//                     旧实现用「磁盘为基底 + 内存 upsert」合并，导致 clear 后
//                     内存为空 → 磁盘记录原样复活（用户明确禁止）。
//                     现在改为「按序重放操作日志」，破坏性操作（delete/clear）
//                     会真实作用于磁盘数据，不会被 upsert 抵消。
// ============================================================
const sharedStores = new Map();

const getStore = (key) => {
  if (!key) return null;
  let store = sharedStores.get(key);
  if (!store) {
    store = {
      list: [],
      loaded: false,
      loadFailed: false,
      version: 0,
      queue: Promise.resolve(),
      pendingOps: [],
    };
    sharedStores.set(key, store);
  }
  return store;
};

/**
 * 记录一次「首次读盘期间」的权威变更操作。
 *
 * 仅在 `store.loaded === false` 时记录；加载完成后不再需要（直接作用于 list）。
 * 操作类型：
 *   { type: 'upsert', record }  新增 / 更新一条记录
 *   { type: 'delete', idOrKey } 删除一条记录（按 id 或 mediaKey）
 *   { type: 'clear' }           清空全部
 *
 * @param {object} store
 * @param {object} op
 */
const recordPendingOp = (store, op) => {
  if (!store || store.loaded) return;
  store.pendingOps.push(op);
};

/**
 * 把「首次读盘期间的操作日志」按发生顺序重放到磁盘列表上。
 *
 * 语义严格等价于「这些操作本来就发生在已加载的列表上」：
 *   - upsert：合并进列表（同 mediaKey 以新数据为准）
 *   - delete：从列表移除（按 id 或 mediaKey）
 *   - clear ：清空列表，且**后续**操作继续作用于空列表
 *
 * 这样：
 *   · 加载期间新增 → 与磁盘旧记录共存（不丢历史）
 *   · 加载期间删除 → 该记录不会因磁盘合并而复活
 *   · 加载期间清空 → 磁盘记录全部作废，不会复活
 *
 * @param {object[]} diskList 磁盘读到的列表（已归一化）
 * @param {Array<object>} ops 操作日志
 * @param {number} limit
 * @returns {{ list: object[], destructive: boolean }}
 *          destructive 表示日志中存在 delete / clear（需要回写磁盘）
 */
const replayPendingOps = (diskList, ops, limit) => {
  let list = Array.isArray(diskList) ? diskList : [];
  let destructive = false;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.type === 'upsert' && op.record) {
      list = upsertWatchRecord(list, op.record, limit);
    } else if (op.type === 'delete') {
      const target = op.idOrKey;
      if (target === undefined || target === null) continue;
      list = list.filter((it) => it && it.id !== target && it.mediaKey !== target);
      destructive = true;
    } else if (op.type === 'clear') {
      list = [];
      destructive = true;
    }
  }
  return { list, destructive };
};

// 订阅者集合：key → Set<listener>，任一实例写入后广播给同 key 的所有实例
const subscribers = new Map();

const notify = (key, list) => {
  const set = subscribers.get(key);
  if (!set) return;
  set.forEach((fn) => {
    try { fn(list); } catch (_) {}
  });
};

const subscribe = (key, fn) => {
  if (!key) return () => {};
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(key);
  };
};

/**
 * 串行落盘：把一次写入排入该 key 的队列，保证顺序执行。
 * 写入前比对 version：若期间权威状态已被更新（如删除 / 清空），
 * 则丢弃这次过期写入，避免「旧写入复活已删除记录」。
 */
const enqueuePersist = (key, store, version, list) => {
  store.queue = store.queue.then(async () => {
    // 🛡️ 过期写入：权威版本已推进 → 丢弃（不落盘）
    if (store.version !== version) return;
    // 🛡️ 首次读盘失败 → 磁盘内容未知，绝不落盘覆盖（否则会永久丢失历史）
    //    内存态仍可用（用户本次会话能看到并操作），只是不写回磁盘。
    if (store.loadFailed) return;
    try {
      if (list.length === 0) {
        await AsyncStorage.removeItem(key);
      } else {
        await AsyncStorage.setItem(key, JSON.stringify(list));
      }
    } catch (_) {
      // 写失败不崩溃 UI
    }
  });
  return store.queue;
};

export function useWatchHistory(userId = null, authEpoch = 0) {
  const [watchList, setWatchList] = useState([]);

  // 🆔 当前 owner 的存储 key（无 userId 时为 null）
  const watchKey = useMemo(() => buildWatchHistoryKey(userId), [userId]);

  // 🔁 同步 ref：供异步回调读取最新 key / owner / 列表
  const keysRef = useRef({ watchKey });
  useEffect(() => {
    keysRef.current = { watchKey };
  }, [watchKey]);

  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  // 🛡️ 身份代际镜像：拦截 A→B→A 的迟到回调
  const authEpochRef = useRef(authEpoch);
  useEffect(() => {
    authEpochRef.current = authEpoch;
  }, [authEpoch]);

  // 🛡️ 列表 ref 镜像：写回调在 updater 之外完成纯计算与落盘
  const watchListRef = useRef(watchList);
  useEffect(() => {
    watchListRef.current = watchList;
  }, [watchList]);

  // 🧹 身份变化时立即清空内存态（渲染期调整 state，避免上一账号数据短暂可见）
  //    ⚠️ 渲染期只调整 state，不写 ref（ref 写入属于副作用，须放 effect）。
  //       watchListRef 由下方 [watchList] effect 自动同步。
  const [prevOwner, setPrevOwner] = useState(userId);
  if (prevOwner !== userId) {
    setPrevOwner(userId);
    setWatchList([]);
  }

  // 📖 读取观看历史（按 owner；脏数据直接丢弃）
  //    🛡️ P0-4：读取结果写入「共享桶」，并广播给同 key 的所有实例。
  //       若桶已加载过（另一实例先加载），直接复用桶内权威列表，不重复读盘。
  useEffect(() => {
    if (!watchKey) return undefined;
    const loadOwnerId = userId;
    const store = getStore(watchKey);
    if (!store) return undefined;
    let cancelled = false;

    // 🔔 订阅共享桶：任一实例写入后同步到本实例
    const unsub = subscribe(watchKey, (list) => {
      if (cancelled) return;
      watchListRef.current = list;
      setWatchList(list);
    });

    const load = async () => {
      // 已加载过 → 直接采用桶内权威列表（跨实例一致）
      if (store.loaded) {
        if (cancelled || userIdRef.current !== loadOwnerId) return;
        watchListRef.current = store.list;
        setWatchList(store.list);
        return;
      }
      let cached;
      try {
        cached = await AsyncStorage.getItem(watchKey);
      } catch (_) {
        // 🛡️ 读盘失败：磁盘内容未知。
        //    绝不能标记 loaded 并当作空列表——否则后续任何写入都会用
        //    「空列表 + 新记录」覆盖磁盘，永久丢失既有历史。
        //    标记 loadFailed：内存态照常可用（本次会话可新增/删除），
        //    但 enqueuePersist 会拒绝落盘，保护磁盘上的既有数据。
        if (cancelled || userIdRef.current !== loadOwnerId) return;
        store.loadFailed = true;
        store.loaded = true;
        return;
      }
      if (cancelled || userIdRef.current !== loadOwnerId) return;

      // 🛡️ 解析失败（脏数据）：视为「磁盘内容不可信」，同样不落盘覆盖。
      //    与读失败区别：脏数据可以安全地当作空列表展示，但仍不写回磁盘，
      //    避免把用户可能还能人工恢复的原始字符串抹掉。
      let cleaned = [];
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          cleaned = normalizeWatchList(parsed, WATCH_HISTORY_LIMIT);
        } catch (_) {
          store.loadFailed = true;
        }
      }
      if (cancelled || userIdRef.current !== loadOwnerId) return;
      // 🛡️ 加载期间若已有权威变更（store.version > 0），必须「按序重放」而非
      //    「磁盘为基底 + 内存 upsert」。
      //
      //    🐞 旧实现的缺陷（用户明确禁止）：
      //       合并时以磁盘列表为基底，把内存列表逐条 upsert 进去。
      //       若加载期间用户执行了 clear（内存变空），upsert 循环体不执行，
      //       结果 merged === cleaned → 磁盘上已删除的记录全部复活。
      //       同理，加载期间 delete 掉的单条记录也会被磁盘数据重新带回。
      //
      //    ✅ 新实现：把加载期间的操作日志（pendingOps）按发生顺序重放到磁盘列表上。
      //       · upsert → 与磁盘旧记录共存（不丢历史，P15FC-06 仍成立）
      //       · delete → 真实移除，不会被磁盘合并复活
      //       · clear  → 清空，后续操作继续作用于空列表
      //       重放结果与「这些操作本来就发生在已加载列表上」完全等价。
      const ops = store.pendingOps;
      let needRepersist = false;
      if (store.version === 0 && ops.length === 0) {
        // 加载期间无任何变更 → 磁盘即权威
        store.list = cleaned;
      } else {
        const replayed = replayPendingOps(cleaned, ops, WATCH_HISTORY_LIMIT);
        store.list = replayed.list;
        // 🛡️ 必须回写磁盘：
        //    · 有 upsert → 磁盘缺新记录，需补齐
        //    · 有 delete / clear → 磁盘仍含已删除记录，必须落盘清除（否则重启复活）
        needRepersist = true;
      }
      // 操作日志已重放完毕，清空避免重复应用
      store.pendingOps = [];
      store.loaded = true;
      watchListRef.current = store.list;
      setWatchList(store.list);
      notify(watchKey, store.list);
      if (needRepersist) {
        // 推进版本号，确保这次回写不被任何在途的旧写入覆盖
        store.version += 1;
        enqueuePersist(watchKey, store, store.version, store.list);
      }
    };
    load();

    return () => {
      cancelled = true;
      unsub();
    };
  }, [watchKey, userId]);

  /**
   * 💾 写入 / 更新一条观看记录。
   *
   * 调用方（播放器进度采集）负责节流；本方法只做「合并 + 落盘」。
   * 返回 true 表示已写入，false 表示被丢弃（无 owner / 迟到回调 / 身份非法）。
   *
   * @param {object} input 见 watchHistoryLogic.buildWatchRecord
   * @returns {boolean}
   */
  const saveWatchRecord = useCallback(
    (input) => {
      const ownerAtCreate = userId;
      const epochAtCreate = authEpoch;
      const key = keysRef.current.watchKey;
      if (!key) return false; // 无 owner：不写任何存储
      if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) {
        return false; // 迟到回调：身份已变化
      }

      const record = buildWatchRecord(input);
      if (!record) return false; // 无法确定媒体身份

      const store = getStore(key);
      if (!store) return false;

      // 🛡️ 基于「共享权威列表」合并，而非本实例的局部 ref
      const next = upsertWatchRecord(store.list, record, WATCH_HISTORY_LIMIT);

      // 🛡️ 落盘前再次确认 owner / 代际 / key 未变化
      if (
        userIdRef.current !== ownerAtCreate ||
        authEpochRef.current !== epochAtCreate ||
        keysRef.current.watchKey !== key
      ) {
        return false;
      }

      // 推进权威状态 + 版本号，广播给所有实例
      store.list = next;
      store.version += 1;
      // 🛡️ 首次读盘尚未完成 → 记录操作日志，供加载完成后按序重放
      recordPendingOp(store, { type: 'upsert', record });
      const versionAtWrite = store.version;
      watchListRef.current = next;
      setWatchList(next);
      notify(key, next);
      // 串行落盘（过期写入自动丢弃）
      enqueuePersist(key, store, versionAtWrite, next);
      return true;
    },
    [userId, authEpoch]
  );

  /** 🗑️ 删除单条（按 id；也兼容传入 mediaKey） */
  const deleteWatchRecord = useCallback(
    (idOrKey) => {
      const ownerAtCreate = userId;
      const epochAtCreate = authEpoch;
      const key = keysRef.current.watchKey;
      if (!key) return;
      if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;
      const store = getStore(key);
      if (!store) return;
      const next = store.list.filter(
        (it) => it.id !== idOrKey && it.mediaKey !== idOrKey
      );
      if (
        userIdRef.current !== ownerAtCreate ||
        authEpochRef.current !== epochAtCreate ||
        keysRef.current.watchKey !== key
      ) {
        return;
      }
      // 🛡️ 推进版本号：任何在途的旧写入都会因版本不匹配被丢弃（不复活已删除记录）
      store.list = next;
      store.version += 1;
      // 🛡️ 首次读盘尚未完成 → 记录删除操作，加载完成后重放（防止磁盘数据复活该条）
      recordPendingOp(store, { type: 'delete', idOrKey });
      const versionAtWrite = store.version;
      watchListRef.current = next;
      setWatchList(next);
      notify(key, next);
      enqueuePersist(key, store, versionAtWrite, next);
    },
    [userId, authEpoch]
  );

  /** 🧹 一键清空（二次确认由调用方负责） */
  const clearWatchHistory = useCallback(() => {
    const ownerAtCreate = userId;
    const epochAtCreate = authEpoch;
    const key = keysRef.current.watchKey;
    if (!key) return;
    if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;
    if (keysRef.current.watchKey !== key) return;
    const store = getStore(key);
    if (!store) return;
    // 🛡️ 推进版本号：清空后任何在途旧写入都会被丢弃（不复活）
    store.list = [];
    store.version += 1;
    // 🛡️ 首次读盘尚未完成 → 记录清空操作，加载完成后重放（防止磁盘记录全部复活）
    recordPendingOp(store, { type: 'clear' });
    const versionAtWrite = store.version;
    watchListRef.current = [];
    setWatchList([]);
    notify(key, []);
    enqueuePersist(key, store, versionAtWrite, []);
  }, [userId, authEpoch]);

  /** 🔍 按 mediaKey 查找记录（供续播使用） */
  const findWatchRecord = useCallback(
    (mediaKey) => (mediaKey ? watchList.find((it) => it.mediaKey === mediaKey) || null : null),
    [watchList]
  );

  return {
    watchList,
    saveWatchRecord,
    deleteWatchRecord,
    clearWatchHistory,
    findWatchRecord,
  };
}

export default useWatchHistory;
// --- END OF FILE src/hooks/browser/useWatchHistory.js ---
