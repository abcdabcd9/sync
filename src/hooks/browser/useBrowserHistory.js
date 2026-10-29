// --- START OF FILE src/hooks/browser/useBrowserHistory.js ---
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { isSafeUrl, buildHistoryTitle, HISTORY_KEY, HISTORY_LIMIT } from '../../constants/browser';

/**
 * 🕘 浏览器历史记录 + 🏷️ 书签收藏 域 Hook（阶段 2 抽离）
 *
 * 职责：
 *   1. 历史记录：启动读取 / 去重写入 / 单条删除 / 一键清空（@browser_history）
 *   2. 书签收藏：启动读取 / 收藏切换 / 已收藏判定（@browser_bookmarks）
 *
 * ⚠️ 最高指令：
 *   - 存储 Key 锁死为 @browser_history 与 @browser_bookmarks，严禁改名（否则用户数据丢失）
 *   - 本 Hook 不触碰任何 UI 弹窗、动画与 WebView
 */

// 🔒 存储 Key（锁死，禁止修改）
const BOOKMARKS_KEY = '@browser_bookmarks';
// 首次启动的默认书签
const DEFAULT_BOOKMARKS = ['https://nnyy.in/'];

export function useBrowserHistory() {
  // 🕘 历史浏览记录
  const [historyList, setHistoryList] = useState([]);
  // 🏷️ 书签收藏
  const [bookmarksList, setBookmarksList] = useState([]);

  // 🏷️ 启动时读取书签（无缓存则写入默认书签）
  useEffect(() => {
    const loadBookmarks = async () => {
      try {
        const cached = await AsyncStorage.getItem(BOOKMARKS_KEY);
        if (cached !== null) {
          setBookmarksList(JSON.parse(cached));
        } else {
          setBookmarksList(DEFAULT_BOOKMARKS);
          await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(DEFAULT_BOOKMARKS));
        }
      } catch (_) {}
    };
    loadBookmarks();
  }, []);

  // 🕘 启动时读取历史记录（容错：脏数据直接丢弃）
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const cached = await AsyncStorage.getItem(HISTORY_KEY);
        if (!cached) return;
        const parsed = JSON.parse(cached);
        if (!Array.isArray(parsed)) return;
        const cleaned = parsed
          .filter((it) => it && typeof it.url === 'string' && isSafeUrl(it.url))
          .slice(0, HISTORY_LIMIT);
        setHistoryList(cleaned);
      } catch (_) {}
    };
    loadHistory();
  }, []);

  // 🕘 写入历史：去重（同 URL 只保留最新一条）+ 上限 100 条
  const addHistory = useCallback((url, title) => {
    if (!isSafeUrl(url)) return;
    if (url.includes('cn.bing.com/search')) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: buildHistoryTitle(title, url),
      timestamp: Date.now(),
    };
    setHistoryList((prev) => {
      if (prev.length > 0 && prev[0].url === url) return prev; // 同一页面重复回调，跳过
      const next = [entry, ...prev.filter((it) => it.url !== url)].slice(0, HISTORY_LIMIT);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  // 🗑️ 删除单条历史（按 id；也兼容传入 url）
  const deleteHistory = useCallback((idOrUrl) => {
    setHistoryList((prev) => {
      const next = prev.filter((it) => it.id !== idOrUrl && it.url !== idOrUrl);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  // 🧹 一键清空历史（二次确认由调用方负责，本 Hook 只做数据操作）
  const clearHistory = useCallback(() => {
    setHistoryList([]);
    AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
  }, []);

  // 🏷️ 判定是否已收藏
  const isBookmarked = useCallback(
    (url) => !!url && bookmarksList.includes(url),
    [bookmarksList]
  );

  // 🏷️ 收藏 / 取消收藏（切换式）
  //    返回 { ok, action: 'added' | 'removed' | 'invalid' }
  const toggleBookmark = useCallback(
    async (url) => {
      if (!isSafeUrl(url)) return { ok: false, action: 'invalid' };

      const already = bookmarksList.includes(url);
      const next = already
        ? bookmarksList.filter((it) => it !== url)
        : [url, ...bookmarksList];

      setBookmarksList(next);
      try {
        await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next));
      } catch (_) {}
      return { ok: true, action: already ? 'removed' : 'added' };
    },
    [bookmarksList]
  );

  // 🗑️ 删除指定书签（供列表删除按钮使用）
  const removeBookmark = useCallback(
    async (url) => {
      const next = bookmarksList.filter((it) => it !== url);
      setBookmarksList(next);
      try {
        await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next));
      } catch (_) {}
    },
    [bookmarksList]
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
