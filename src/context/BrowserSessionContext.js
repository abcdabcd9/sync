// --- START OF FILE src/context/BrowserSessionContext.js ---
import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSafeUrl } from '../constants/browser';

/**
 * 🌐 浏览器会话上下文（跨页 URL 交接 + 上次网址持久化）
 *
 * 解决的问题：
 *   1. 历史 / 书签页点击网址时，不再 router.replace 新建第二个浏览器实例，
 *      而是把目标 URL 写入 pendingUrl，然后 router.back() 回到已有浏览器实例。
 *   2. 浏览器每次打开时恢复上次最后访问的网址（而非固定首页）。
 *
 * 设计约束：
 *   - 纯数据层，不触碰任何 UI / 动画 / WebView / 安全注入脚本
 *   - 存储 Key 独立为 @browser_last_url，不影响 @browser_history / @browser_bookmarks
 *   - pendingUrl 用 ref 承载「一次性交接」，同时用 state 触发消费方 effect
 */

// 🔒 存储 Key（独立命名空间，禁止与历史 / 书签混用）
const LAST_URL_KEY = '@browser_last_url';

const BrowserSessionContext = createContext(null);

export function BrowserSessionProvider({ children }) {
  // 📌 待加载 URL（历史 / 书签页写入，浏览器页消费后清空）
  const [pendingUrl, setPendingUrlState] = useState(null);
  // 🕘 上次访问网址（持久化到 AsyncStorage）
  const [lastUrl, setLastUrlState] = useState(null);
  // 🔁 交接序号：同一 URL 连续点击也能触发消费方 effect
  const [pendingSeq, setPendingSeq] = useState(0);
  // 🧊 首次读取完成标记，避免恢复逻辑与读取竞态
  const hydratedRef = useRef(false);

  // 🕘 启动时读取上次网址（容错：脏数据 / 非安全地址直接丢弃）
  useEffect(() => {
    let alive = true;
    const hydrate = async () => {
      try {
        const cached = await AsyncStorage.getItem(LAST_URL_KEY);
        if (alive && cached && isSafeUrl(cached)) {
          setLastUrlState(cached);
        }
      } catch (_) {}
      hydratedRef.current = true;
    };
    hydrate();
    return () => {
      alive = false;
    };
  }, []);

  // 📌 写入待加载 URL（供历史 / 书签页调用）
  const setPendingUrl = useCallback((url) => {
    if (!isSafeUrl(url)) return;
    setPendingUrlState(url);
    setPendingSeq((n) => n + 1);
  }, []);

  // 📌 消费待加载 URL（浏览器页读取后调用，避免重复触发）
  const consumePendingUrl = useCallback(() => {
    setPendingUrlState(null);
    return null;
  }, []);

  // 🕘 记录上次访问网址（浏览器页导航状态变化时调用）
  const rememberUrl = useCallback((url) => {
    if (!isSafeUrl(url)) return;
    setLastUrlState((prev) => {
      if (prev === url) return prev;
      AsyncStorage.setItem(LAST_URL_KEY, url).catch(() => {});
      return url;
    });
  }, []);

  const value = {
    pendingUrl,
    pendingSeq,
    setPendingUrl,
    consumePendingUrl,
    lastUrl,
    rememberUrl,
  };

  return (
    <BrowserSessionContext.Provider value={value}>{children}</BrowserSessionContext.Provider>
  );
}

export function useBrowserSession() {
  const ctx = useContext(BrowserSessionContext);
  if (!ctx) {
    throw new Error('useBrowserSession 必须在 BrowserSessionProvider 内使用');
  }
  return ctx;
}

export default BrowserSessionContext;
// --- END OF FILE src/context/BrowserSessionContext.js ---
