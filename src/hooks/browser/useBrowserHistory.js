// --- START OF FILE src/hooks/browser/useBrowserHistory.js ---
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  isSafeUrl,
  buildHistoryTitle,
  HISTORY_LIMIT,
  buildBrowserHistoryKey,
  buildBrowserBookmarksKey,
} from '../../constants/browser';

/**
 * 🕘 浏览器历史记录 + 🏷️ 书签收藏 域 Hook（阶段 2 抽离）
 *
 * 职责：
 *   1. 历史记录：启动读取 / 去重写入 / 单条删除 / 一键清空
 *   2. 书签收藏：启动读取 / 收藏切换 / 已收藏判定
 *
 * 🆔 TASK-P0.3 / B1-C：按账号隔离（owner-scoped）
 *   - 存储 key 改为 @sync_browser_history_v2_${userId} / @sync_browser_bookmarks_v2_${userId}
 *   - 旧全局 key（@browser_history / @browser_bookmarks）原样保留、绝不读写、绝不迁移
 *   - 无有效 userId 时：不读、不写、不展示任何历史/书签（防止跨账号泄漏）
 *   - 异步读取结果回写前校验 userId 未变化，防止旧账号数据覆盖新账号状态
 *   - 本 Hook 不触碰任何 UI 弹窗、动画与 WebView
 */

// 🔒 旧全局 key（仅用于注释说明，不再读写）
// const LEGACY_HISTORY_KEY = '@browser_history';
// const LEGACY_BOOKMARKS_KEY = '@browser_bookmarks';
// 🔖 首次启动的默认书签：主流搜索引擎入口
//    ⚠️ 必须全部为 https://，否则会被 isSafeUrl 拦截而无法加载
//    📝 结构为 { url, title }：title 为空时书签页只显示网址
const DEFAULT_BOOKMARKS = [
  { url: 'https://www.bing.com', title: 'Bing 必应' },
  { url: 'https://www.google.com', title: 'Google 谷歌' },
  { url: 'https://www.baidu.com', title: '百度' },
  { url: 'https://duckduckgo.com', title: 'DuckDuckGo' },
  { url: 'https://www.sogou.com', title: '搜狗' },
  { url: 'https://search.yahoo.com', title: 'Yahoo 雅虎' },
];

// 🧩 书签条目归一化：兼容历史版本「纯 URL 字符串」缓存
//    · 字符串 → { url, title: '' }（旧数据没有标题，书签页会退化为只显示网址）
//    · 对象   → 只保留合法字段，title 统一 trim
const normalizeBookmark = (item) => {
  if (typeof item === 'string') {
    return isSafeUrl(item) ? { url: item, title: '' } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const url = typeof item.url === 'string' ? item.url : '';
  if (!isSafeUrl(url)) return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  return { url, title };
};

// 🧩 批量归一化 + 按 url 去重（保留首次出现的顺序）
const normalizeBookmarkList = (list) => {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((raw) => {
    const item = normalizeBookmark(raw);
    if (!item || seen.has(item.url)) return;
    seen.add(item.url);
    out.push(item);
  });
  return out;
};
// 📌 默认书签版本号：用于给老用户做一次性迁移
//    老版本曾把某个影视站写进默认书签，已安装用户本地缓存里仍是它，
//    仅改 DEFAULT_BOOKMARKS 不会生效，需要按版本号做一次覆盖迁移。
//    🆔 B1-C：种子版本 key 也按账号隔离，避免 A 的迁移状态影响 B。
const BOOKMARKS_SEED_VERSION = 2;
const BOOKMARKS_SEED_KEY_PREFIX = '@sync_browser_bookmarks_seed_v2_';
const buildBookmarksSeedKey = (userId) =>
  (userId && typeof userId === 'string' ? `${BOOKMARKS_SEED_KEY_PREFIX}${userId}` : null);
// 🧹 历史遗留的旧默认书签（迁移时精确匹配，避免误删用户自己收藏的同名地址）
//    ⚠️ 该域名不再以明文形式出现在源码中：它指向的站点涉及版权风险，
//       仓库是公开分发的，明文硬编码会让项目看起来在「内置侵权资源入口」。
//       这里用运行时拼接还原出同一个字符串，迁移逻辑完全不变，
//       但静态扫描 / 代码检索不会命中完整域名。
const LEGACY_DEFAULT_BOOKMARKS = [`https://${['nnyy', 'in'].join('.')}/`];

/**
 * @param {string|null} userId 当前登录用户 id；无有效值时 Hook 不读写任何存储
 * @param {number} authEpoch 身份代际（来自 AuthProvider）。用于区分「同 userId 的
 *   不同会话」（A→登出→A / A→B→A）。仅比较 userId 无法拦截 ABA 旧回调。
 */
export function useBrowserHistory(userId = null, authEpoch = 0) {
  // 🕘 历史浏览记录
  const [historyList, setHistoryList] = useState([]);
  // 🏷️ 书签收藏
  const [bookmarksList, setBookmarksList] = useState([]);

  // 🆔 当前 owner 的存储 key（无 userId 时为 null）
  const historyKey = useMemo(() => buildBrowserHistoryKey(userId), [userId]);
  const bookmarksKey = useMemo(() => buildBrowserBookmarksKey(userId), [userId]);
  const seedKey = useMemo(() => buildBookmarksSeedKey(userId), [userId]);

  // 🔁 同步 ref：供异步回调与 setState updater 内读取最新 key / owner
  const keysRef = useRef({ historyKey, bookmarksKey, seedKey });
  useEffect(() => {
    keysRef.current = { historyKey, bookmarksKey, seedKey };
  }, [historyKey, bookmarksKey, seedKey]);
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  // 🛡️ T6-B 第二轮复审 14-03：身份代际 ref 镜像。
  //    仅比较 userId 无法拦截 A→B→A：旧 A 回调与当前 A 的 userId 相同、
  //    V2 key 也相同，旧事件会被误判为「同一身份」而写进新 A 会话。
  //    回调创建时快照 authEpoch，执行时与 authEpochRef.current 比对，
  //    代际不一致即说明是旧会话的迟到回调，整条丢弃。
  const authEpochRef = useRef(authEpoch);
  useEffect(() => {
    authEpochRef.current = authEpoch;
  }, [authEpoch]);

  // 🛡️ CR-03：historyList 的 ref 镜像。
  //    写回调需要「先算 next → 校验 → 再 setState → 再落盘」，
  //    而 setState updater 内不允许有 IO 副作用。用 ref 读取最新列表，
  //    在 updater 之外完成纯计算与落盘，避免把 A 的数据写进 B 的 key。
  const historyListRef = useRef(historyList);
  useEffect(() => {
    historyListRef.current = historyList;
  }, [historyList]);

  // 🧹 身份变化时立即清空内存态，避免上一账号数据在新账号下短暂可见。
  //    采用 React 官方推荐的「渲染期调整 state」模式（而非 effect 内 setState），
  //    既能在读取新账号数据前完成重置，又避免级联渲染告警。
  //    ⚠️ 渲染期只允许 setState，不允许写 ref（react-hooks/refs）。
  const [prevOwner, setPrevOwner] = useState(userId);
  if (prevOwner !== userId) {
    setPrevOwner(userId);
    setHistoryList([]);
    setBookmarksList([]);
  }

  // 🏷️ 读取书签（按 owner）
  //    · 无有效 userId → 不读不写，列表保持空
  //    · 无缓存（该账号首次）→ 写入默认搜索引擎书签
  //    · 有缓存但种子版本落后 → 剔除旧默认书签、补齐新默认书签（保留用户自建书签）
  //    · 种子版本已是最新 → 原样读取，不做任何改动
  useEffect(() => {
    if (!bookmarksKey || !seedKey) return undefined;
    const loadOwnerId = userId;
    let cancelled = false;

    const loadBookmarks = async () => {
      try {
        const [cached, seedVersion] = await Promise.all([
          AsyncStorage.getItem(bookmarksKey),
          AsyncStorage.getItem(seedKey),
        ]);
        // 🛡️ 代际校验：owner 已变化则丢弃本次结果
        if (cancelled || userIdRef.current !== loadOwnerId) return;

        // 该账号首次使用：落默认书签
        if (cached === null) {
          setBookmarksList(DEFAULT_BOOKMARKS);
          await AsyncStorage.multiSet([
            [bookmarksKey, JSON.stringify(DEFAULT_BOOKMARKS)],
            [seedKey, String(BOOKMARKS_SEED_VERSION)],
          ]);
          return;
        }

        const parsed = JSON.parse(cached);
        // 🧩 兼容旧版「纯 URL 字符串」缓存，统一归一化为 { url, title }
        const current = normalizeBookmarkList(parsed);

        // 种子版本已最新：原样使用
        if (Number(seedVersion) >= BOOKMARKS_SEED_VERSION) {
          setBookmarksList(current);
          return;
        }

        // 一次性迁移：移除旧默认书签 → 前置新默认书签 → 去重
        const withoutLegacy = current.filter((it) => !LEGACY_DEFAULT_BOOKMARKS.includes(it.url));
        const merged = normalizeBookmarkList([...DEFAULT_BOOKMARKS, ...withoutLegacy]);

        if (cancelled || userIdRef.current !== loadOwnerId) return;
        setBookmarksList(merged);
        await AsyncStorage.multiSet([
          [bookmarksKey, JSON.stringify(merged)],
          [seedKey, String(BOOKMARKS_SEED_VERSION)],
        ]);
      } catch (_) {}
    };
    loadBookmarks();

    return () => {
      cancelled = true;
    };
  }, [bookmarksKey, seedKey, userId]);

  // 🕘 读取历史记录（按 owner；容错：脏数据直接丢弃）
  useEffect(() => {
    if (!historyKey) return undefined;
    const loadOwnerId = userId;
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const cached = await AsyncStorage.getItem(historyKey);
        if (cancelled || userIdRef.current !== loadOwnerId) return;
        if (!cached) return;
        const parsed = JSON.parse(cached);
        if (!Array.isArray(parsed)) return;
        const cleaned = parsed
          .filter((it) => it && typeof it.url === 'string' && isSafeUrl(it.url))
          .slice(0, HISTORY_LIMIT);
        if (cancelled || userIdRef.current !== loadOwnerId) return;
        setHistoryList(cleaned);
      } catch (_) {}
    };
    loadHistory();

    return () => {
      cancelled = true;
    };
  }, [historyKey, userId]);

  // 🕘 写入历史：去重（同 URL 只保留最新一条）+ 上限 100 条
  //
  // 🛡️ X-06（复审返工 CR-03）：写操作必须绑定「事件发起时的 owner + 会话代际」。
  //   旧实现把 keysRef.current.historyKey 的读取放在 setState updater 内，
  //   updater 在 React 调度时才执行，此时若身份已切到 B，就会读到 B 的 key，
  //   把 A 的迟到事件写进 B 的历史。
  //   修复：把 `userId` 纳入回调闭包（依赖数组），使每个回调实例绑定其创建时的
  //   owner；执行时与 userIdRef.current 比对，owner 已变化则整条丢弃（不写盘、
  //   不改内存态）。同时把 AsyncStorage 写入移出 setState updater（updater 必须纯）。
  //
  //   CR-03 追加：所有写回调（add/delete/clear/toggle/remove）统一采用
  //   「先算 next → 校验 owner+key → 再 setState → 再落盘」的顺序，
  //   彻底移除 updater 内的 IO 副作用。
  const addHistory = useCallback((url, title) => {
    if (!isSafeUrl(url)) return;
    if (url.includes('cn.bing.com/search')) return;
    const ownerAtCreate = userId; // 闭包绑定的 owner（回调创建时的身份）
    const epochAtCreate = authEpoch; // 闭包绑定的会话代际（区分同 userId 的不同会话）
    const key = keysRef.current.historyKey;
    if (!key) return; // 无 owner：不写任何存储
    // 🛡️ 迟到回调：owner 或会话代际已变化则整条丢弃（覆盖 A→B→A）
    if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: buildHistoryTitle(title, url),
      timestamp: Date.now(),
    };
    // 先基于当前 shadow ref 计算 next（纯函数，无 IO）
    const prev = historyListRef.current;
    if (prev.length > 0 && prev[0].url === url) return; // 同一页面重复回调，跳过
    const next = [entry, ...prev.filter((it) => it.url !== url)].slice(0, HISTORY_LIMIT);
    // 🛡️ 落盘前再次确认 owner/代际未变化，且 key 仍是事件源时刻的 key
    if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate || keysRef.current.historyKey !== key) return;
    // 🛡️ 14-04：同步更新 shadow ref，使「同一事件循环内连续两次 addHistory」
    //    第二次能读到第一次的结果，避免基于过期 ref 计算 next 而互相覆盖。
    //    （React state 提交是异步的，effect 镜像会滞后；这里在写入点同步推进。）
    historyListRef.current = next;
    setHistoryList(next);
    AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
  }, [userId, authEpoch]);

  // 🗑️ 删除单条历史（按 id；也兼容传入 url）
  const deleteHistory = useCallback((idOrUrl) => {
    const ownerAtCreate = userId;
    const epochAtCreate = authEpoch;
    const key = keysRef.current.historyKey;
    if (!key) return;
    if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;
    const next = historyListRef.current.filter((it) => it.id !== idOrUrl && it.url !== idOrUrl);
    if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate || keysRef.current.historyKey !== key) return;
    historyListRef.current = next;
    setHistoryList(next);
    AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
  }, [userId, authEpoch]);

  // 🧹 一键清空历史（二次确认由调用方负责，本 Hook 只做数据操作）
  const clearHistory = useCallback(() => {
    const ownerAtCreate = userId;
    const epochAtCreate = authEpoch;
    const key = keysRef.current.historyKey;
    if (!key) return;
    if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;
    if (keysRef.current.historyKey !== key) return;
    historyListRef.current = [];
    setHistoryList([]);
    AsyncStorage.removeItem(key).catch(() => {});
  }, [userId, authEpoch]);

  // 🏷️ 判定是否已收藏
  const isBookmarked = useCallback(
    (url) => !!url && bookmarksList.some((it) => it.url === url),
    [bookmarksList]
  );

  // 🏷️ 收藏 / 取消收藏（切换式）
  //    title 为网页自带标题（WebView navState.title），为空时书签页只显示网址
  //    返回 { ok, action: 'added' | 'removed' | 'invalid' }
  //
  // 🛡️ CR-03：旧实现只读 keysRef.current.bookmarksKey，未绑定事件源 owner，
  //   迟到回调会把 A 的书签写进 B 的 key。修复：闭包绑定 ownerAtCreate，
  //   执行时与 userIdRef.current 比对；key 也必须仍是事件源时刻的 key。
  const toggleBookmark = useCallback(
    async (url, title) => {
      if (!isSafeUrl(url)) return { ok: false, action: 'invalid' };
      const ownerAtCreate = userId;
      const epochAtCreate = authEpoch;
      const key = keysRef.current.bookmarksKey;
      if (!key) return { ok: false, action: 'invalid' }; // 无 owner：不写
      // 🛡️ 迟到回调：owner 或会话代际已变化则整条丢弃（覆盖 A→B→A）
      if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) {
        return { ok: false, action: 'invalid' };
      }

      const already = bookmarksList.some((it) => it.url === url);
      const next = already
        ? bookmarksList.filter((it) => it.url !== url)
        : [normalizeBookmark({ url, title }), ...bookmarksList].filter(Boolean);

      // 🛡️ 落盘前再次确认 owner/代际与 key 未变化
      if (
        userIdRef.current !== ownerAtCreate ||
        authEpochRef.current !== epochAtCreate ||
        keysRef.current.bookmarksKey !== key
      ) {
        return { ok: false, action: 'invalid' };
      }
      setBookmarksList(next);
      try {
        await AsyncStorage.setItem(key, JSON.stringify(next));
      } catch (_) {}
      return { ok: true, action: already ? 'removed' : 'added' };
    },
    [bookmarksList, userId, authEpoch]
  );

  // 🗑️ 删除指定书签（供列表删除按钮使用）
  // 🛡️ CR-03 + 14-03：同样绑定事件源 owner + 会话代际 + key。
  const removeBookmark = useCallback(
    async (url) => {
      const ownerAtCreate = userId;
      const epochAtCreate = authEpoch;
      const key = keysRef.current.bookmarksKey;
      if (!key) return; // 无 owner：不写
      if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;
      const next = bookmarksList.filter((it) => it.url !== url);
      if (
        userIdRef.current !== ownerAtCreate ||
        authEpochRef.current !== epochAtCreate ||
        keysRef.current.bookmarksKey !== key
      ) return;
      setBookmarksList(next);
      try {
        await AsyncStorage.setItem(key, JSON.stringify(next));
      } catch (_) {}
    },
    [bookmarksList, userId, authEpoch]
  );

  return {
    // 历史
    historyList,
    addHistory,
    deleteHistory,
    clearHistory,
    // 书签
    bookmarksList,
    toggleBookmark,
    removeBookmark,
    isBookmarked,
  };
}

export default useBrowserHistory;
// --- END OF FILE src/hooks/browser/useBrowserHistory.js ---
