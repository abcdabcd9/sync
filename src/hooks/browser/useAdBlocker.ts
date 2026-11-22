// --- START OF FILE src/hooks/browser/useAdBlocker.ts ---
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import * as Haptics from 'expo-haptics';
import { buildAdCleanupScript, REMOVE_AD_STYLE_SCRIPT } from '../../scripts/browser';
import { decideRequestAllow } from './adBlockDecision';

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
 *
 * 🧩 TASK-P1.4 R0：JS → 严格 TypeScript 迁移（仅补类型，不改运行时行为）。
 */

/** WebView 引用：仅声明本 Hook 实际使用的方法（结构类型，兼容真实 WebView ref）。 */
export interface AdBlockerWebViewHandle {
  injectJavaScript: (script: string) => void;
}

/** WebView shouldStartLoadWithRequest 请求对象（仅读取 url）。 */
export interface ShouldStartLoadRequest {
  url?: string;
}

export interface UseAdBlockerResult {
  isAdBlockEnabled: boolean;
  blockedAdCount: number;
  bumpBlockedAdCount: (n?: number) => void;
  handleShouldStartLoad: (req: ShouldStartLoadRequest | null | undefined) => boolean;
  runAdCleanup: () => void;
  toggleAdBlock: () => void;
}

export function useAdBlocker(
  webViewRef: MutableRefObject<AdBlockerWebViewHandle | null>
): UseAdBlockerResult {
  const [isAdBlockEnabled, setIsAdBlockEnabled] = useState<boolean>(true);
  const [blockedAdCount, setBlockedAdCount] = useState<number>(0);

  // WebView 回调中读取最新开关状态（避免闭包过期）
  const isAdBlockEnabledRef = useRef<boolean>(true);
  // 计数节流：避免批量弹窗时 setState 风暴
  const adCountBatchRef = useRef<number>(0);
  const adCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  //    🧭 纯决策委托 adBlockDecision.decideRequestAllow（P1.3 R1 解耦）：
  //       判定顺序 / 短路语义 / 正则均保持不变；命中广告域名时由本 Hook 计数。
  const handleShouldStartLoad = useCallback(
    (req: ShouldStartLoadRequest | null | undefined) => {
      const url = req && req.url;
      const decision = decideRequestAllow(url, isAdBlockEnabledRef.current);
      if (decision.blockedByAd) {
        bumpBlockedAdCount(1);
      }
      return decision.allow;
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
// --- END OF FILE src/hooks/browser/useAdBlocker.ts ---
