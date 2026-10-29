// --- START OF FILE src/hooks/browser/useAdBlocker.js ---
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import * as Haptics from 'expo-haptics';
import { isSafeUrl, isAdUrl } from '../../constants/browser';
import { buildAdCleanupScript, REMOVE_AD_STYLE_SCRIPT } from '../../scripts/browser';

/**
 * 🛡️ 广告拦截域 Hook（阶段 5 抽离）
 *
 * 职责：
 *  1. 维护拦截开关状态 isAdBlockEnabled（默认开启）
 *  2. 维护累计拦截计数 blockedAdCount（200ms 批量合并，避免 setState 风暴）
 *  3. 提供网络级拦截判定 handleShouldStartLoad（安全协议校验 + 广告域名黑名单）
 *  4. 提供页面加载完成后的 DOM 级清理注入 runAdCleanup
 *  5. 提供开关切换 toggleAdBlock（关闭时立即移除已注入的隐藏样式）
 *
 * ⚠️ 行为与原 browser.js 内联实现 100% 一致：
 *    - 开关默认 true
 *    - 计数节流窗口 200ms
 *    - 关闭开关时注入 REMOVE_AD_STYLE_SCRIPT 恢复页面原貌
 *    - 卸载时清理节流定时器
 */
export function useAdBlocker(webViewRef) {
  const [isAdBlockEnabled, setIsAdBlockEnabled] = useState(true);
  const [blockedAdCount, setBlockedAdCount] = useState(0);

  // WebView 回调中读取最新开关状态（避免闭包过期）
  const isAdBlockEnabledRef = useRef(true);
  // 计数节流：避免批量弹窗时 setState 风暴
  const adCountBatchRef = useRef(0);
  const adCountTimerRef = useRef(null);

  useEffect(() => {
    isAdBlockEnabledRef.current = isAdBlockEnabled;
  }, [isAdBlockEnabled]);

  // 累加拦截计数（批量合并，200ms 内多次拦截只触发一次渲染）
  const bumpBlockedAdCount = useCallback((n = 1) => {
    adCountBatchRef.current += n;
    if (adCountTimerRef.current) return;
    adCountTimerRef.current = setTimeout(() => {
      const delta = adCountBatchRef.current;
      adCountBatchRef.current = 0;
      adCountTimerRef.current = null;
      if (delta > 0) setBlockedAdCount((prev) => prev + delta);
    }, 200);
  }, []);

  // 🧹 卸载清理：避免 setState on unmounted component
  useEffect(
    () => () => {
      if (adCountTimerRef.current) {
        clearTimeout(adCountTimerRef.current);
        adCountTimerRef.current = null;
      }
    },
    []
  );

  // 🧩 DOM 级清理脚本（工厂函数，仅构建一次）
  const adCleanupScript = useMemo(() => buildAdCleanupScript(), []);

  // 🛡️ 网络级拦截入口：安全协议校验 + 广告域名黑名单
  const handleShouldStartLoad = useCallback(
    (req) => {
      const url = req && req.url;
      // 1️⃣ 安全协议校验（https / about）
      if (!isSafeUrl(url)) return false;
      // 2️⃣ 广告域名黑名单（仅开关开启时生效）
      if (isAdBlockEnabledRef.current && isAdUrl(url)) {
        bumpBlockedAdCount(1);
        return false;
      }
      return true;
    },
    [bumpBlockedAdCount]
  );

  // 🧹 页面加载完成后注入 DOM 级广告清理（开关开启时才执行）
  const runAdCleanup = useCallback(() => {
    if (isAdBlockEnabledRef.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(adCleanupScript);
    }
  }, [webViewRef, adCleanupScript]);

  // 🛡️ 切换广告拦截开关：关闭时立即移除已注入的隐藏样式，恢复页面原貌
  const toggleAdBlock = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const next = !isAdBlockEnabled;
    setIsAdBlockEnabled(next);
    isAdBlockEnabledRef.current = next;
    if (!next && webViewRef.current) {
      webViewRef.current.injectJavaScript(REMOVE_AD_STYLE_SCRIPT);
    }
  }, [isAdBlockEnabled, webViewRef]);

  return {
    isAdBlockEnabled,
    blockedAdCount,
    bumpBlockedAdCount,
    handleShouldStartLoad,
    runAdCleanup,
    toggleAdBlock,
  };
}

export default useAdBlocker;
// --- END OF FILE src/hooks/browser/useAdBlocker.js ---
