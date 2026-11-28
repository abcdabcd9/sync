// --- START OF FILE src/hooks/browser/useBrowserSniffer.ts ---
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { LayoutAnimation } from 'react-native';
import * as Haptics from 'expo-haptics';

import { mergeMediaList } from '../../constants/browser';
import type { SniffedMedia } from '../../types/browser';
import { MANUAL_SNIFF_SCRIPT } from '../../scripts/browser';
import {
  FILTER_OPTIONS,
  normalizeIncomingUrls,
  countByFormat,
  filterByFormat,
} from './snifferMediaLogic';
import type { FilterFormat, FormatCounts } from './snifferMediaLogic';

/**
 * 🎬 视频嗅探核心域 Hook（阶段 3 抽离）
 *
 * 职责：
 *   1. 嗅探状态：sniffedMediaList / filterFormat / isSniffing
 *   2. WebView 消息解析：VIDEO_FOUND / VIDEO_FOUND_LIST / MANUAL_SNIFF_DONE
 *   3. 列表派生：filteredMediaList（useMemo）/ formatCounts
 *   4. 列表操作：removeMediaItem / clearSniffedMedia
 *   5. 手动扫描：triggerManualSniff（注入 MANUAL_SNIFF_SCRIPT + 2s 兜底复位）
 *
 * ⚠️ 最高指令：
 *   - 本 Hook 只负责「嗅探状态 + 消息解析」，绝不触碰全屏影院跳转（useCinema）
 *   - 绝不触碰任何 UI 弹窗组件（Picker / Menu 的显隐与动画由编排层持有）
 *   - AD_BLOCKED 上报不属于嗅探域，由调用方在 handleWebMessage 之前自行分流
 *   - 🔇 静默嗅探：未命中任何片源时「零反馈」（不弹窗、不提示、不震动），
 *     仅当真正嗅探到片源时才通过 onMediaFound 通知编排层弹出选择窗口
 *
 * 🧩 TASK-P1.4 R0：JS → 严格 TypeScript 迁移（仅补类型，不改运行时行为）。
 */

// 🎚️ 筛选选项（顺序即 UI 展示顺序）
//    ⚠️ P1.3 R2：实现已迁至 ./snifferMediaLogic，此处仅重新导出以保持公开接口不变
export { FILTER_OPTIONS };

/** WebView 引用：仅声明本 Hook 实际使用的方法（结构类型，兼容真实 WebView ref）。 */
export interface SnifferWebViewHandle {
  injectJavaScript: (script: string) => void;
}

/** WebView onMessage 事件（仅读取 nativeEvent.data）。 */
export interface BrowserWebMessageEvent {
  nativeEvent: {
    data: string;
  };
}

export interface UseBrowserSnifferParams {
  onMediaFound?: (list: readonly SniffedMedia[]) => void;
}

export interface UseBrowserSnifferResult {
  // 状态
  sniffedMediaList: readonly SniffedMedia[];
  filterFormat: FilterFormat;
  setFilterFormat: (format: FilterFormat) => void;
  isSniffing: boolean;
  // 派生
  filteredMediaList: readonly SniffedMedia[];
  formatCounts: FormatCounts;
  // 消息
  handleWebMessage: (event: BrowserWebMessageEvent) => boolean;
  // 操作
  removeMediaItem: (id: string) => void;
  clearSniffedMedia: () => void;
  triggerManualSniff: (webViewRef: MutableRefObject<SnifferWebViewHandle | null>) => void;
}

export function useBrowserSniffer({
  onMediaFound,
}: UseBrowserSnifferParams = {}): UseBrowserSnifferResult {
  // 🎞️ 嗅探到的视频源列表
  const [sniffedMediaList, setSniffedMediaList] = useState<readonly SniffedMedia[]>([]);
  // 🎚️ 格式筛选：'ALL' | 'MP4' | 'M3U8' | 'MOV'
  const [filterFormat, setFilterFormat] = useState<FilterFormat>('ALL');
  // 🔍 扫描动画状态
  const [isSniffing, setIsSniffing] = useState<boolean>(false);

  // ⏱️ 手动扫描兜底定时器
  const sniffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 📣 命中回调：用 ref 持有，避免调用方内联函数导致 handleWebMessage 频繁重建
  const onMediaFoundRef = useRef<UseBrowserSnifferParams['onMediaFound']>(onMediaFound);
  useEffect(() => {
    onMediaFoundRef.current = onMediaFound;
  }, [onMediaFound]);

  // 🧹 卸载时清理定时器（避免 setState on unmounted component）
  useEffect(
    () => () => {
      if (sniffTimerRef.current) {
        clearTimeout(sniffTimerRef.current);
        sniffTimerRef.current = null;
      }
    },
    []
  );

  // 🎬 合并新片源：去重 + 置顶 + 触感反馈 + 布局动画
  //    ✅ 仅当「确实新增了片源」时才反馈，并通知编排层弹出选择窗口
  //    🔒 M-5：入列前统一做协议白名单过滤，非 http(s) 一律丢弃
  //
  //    🐞 P0 真机崩溃修复（React 渲染期跨组件 setState）：
  //       旧实现把 LayoutAnimation / Haptics / onMediaFound 全部写在
  //       `setSniffedMediaList(prev => ...)` 的 updater 内部。updater 会在
  //       React 渲染阶段被调用，此时同步调用 onMediaFound → 编排层
  //       loadUrl() → useCinema 的 setCurrentUrl()，触发
  //       「Cannot update a component while rendering a different component」。
  //       现在 updater 只做纯计算（返回新列表），所有副作用（动画 / 震动 /
  //       通知编排层）统一在「提交后」的 effect 中基于真实列表派发。
  const pushMedia = useCallback((incoming: unknown) => {
    // ⚠️ P1.3 R2：数组兜底 + M-5 白名单过滤 + trim 已迁至 ./snifferMediaLogic
    const safeIncoming = normalizeIncomingUrls(incoming);
    // 🔇 全部被过滤掉：静默返回，不触发动画/震动/弹窗
    if (safeIncoming.length === 0) return;
    // ✅ updater 必须保持纯函数：只计算并返回新列表，绝不执行任何副作用
    setSniffedMediaList((prev) => mergeMediaList(prev, safeIncoming));
  }, []);

  // 📣 媒体发现通知（提交后派发）：基于「真实已提交的 sniffedMediaList」，
  //    在 effect 中比较「上次已通知的列表引用」判断是否新增，再执行
  //    动画 / 震动 / 通知编排层。这样彻底避开渲染期跨组件 setState。
  const notifiedListRef = useRef<readonly SniffedMedia[] | null>(null);
  useEffect(() => {
    const prev = notifiedListRef.current;
    // 首次挂载（空列表）不通知
    if (prev === null) {
      notifiedListRef.current = sniffedMediaList;
      return;
    }
    if (prev === sniffedMediaList) return;
    notifiedListRef.current = sniffedMediaList;
    // 列表被清空 / 移除（长度减少）→ 不视为「发现新片源」
    if (!Array.isArray(sniffedMediaList) || sniffedMediaList.length === 0) return;
    if (Array.isArray(prev) && sniffedMediaList.length <= prev.length) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // 📣 真正嗅探到新片源 → 通知编排层（此时已脱离渲染阶段，setState 安全）
    onMediaFoundRef.current?.(sniffedMediaList);
  }, [sniffedMediaList]);

  /**
   * 📨 处理来自 <WebView> 的 onMessage 事件
   * @returns true = 已被嗅探域消费；false = 非嗅探消息（如 AD_BLOCKED），交由调用方处理
   */
  const handleWebMessage = useCallback(
    (event: BrowserWebMessageEvent): boolean => {
      let data: unknown;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return false;
      }
      if (!data || typeof data !== 'object') return false;

      const msg = data as { type?: unknown; url?: unknown; urls?: unknown };

      // 单条命中（被动嗅探，保留旧协议兼容）
      if (msg.type === 'VIDEO_FOUND' && msg.url) {
        setIsSniffing(false);
        pushMedia([msg.url]);
        return true;
      }

      // 多片源批量命中（手动扫描）
      if (msg.type === 'VIDEO_FOUND_LIST') {
        setIsSniffing(false);
        const urls = Array.isArray(msg.urls) ? msg.urls.filter(Boolean) : [];
        // 🔇 空结果：静默处理，不弹窗、不提示
        if (urls.length === 0) return true;
        pushMedia(urls);
        return true;
      }

      // 旧版手动扫描完成信号（兼容）
      if (msg.type === 'MANUAL_SNIFF_DONE') {
        setIsSniffing(false);
        // 🔇 未命中：静默处理，不弹窗、不提示
        return true;
      }

      // 非嗅探域消息（AD_BLOCKED 等）
      return false;
    },
    [pushMedia]
  );

  // 🗑️ 移除单条嗅探源（卡片横滑触发）
  const removeMediaItem = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSniffedMediaList((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // 🧹 清空嗅探列表（弹窗关闭由调用方负责）
  const clearSniffedMedia = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSniffedMediaList([]);
  }, []);

  // 🔍 触发网页内手动嗅探脚本（2s 后兜底复位扫描动画）
  const triggerManualSniff = useCallback(
    (webViewRef: MutableRefObject<SnifferWebViewHandle | null>) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setIsSniffing(true);
      if (webViewRef && webViewRef.current) {
        webViewRef.current.injectJavaScript(MANUAL_SNIFF_SCRIPT);
      }
      if (sniffTimerRef.current) clearTimeout(sniffTimerRef.current);
      sniffTimerRef.current = setTimeout(() => {
        sniffTimerRef.current = null;
        setIsSniffing(false);
      }, 2000);
    },
    []
  );

  // 🎚️ 各格式计数（用于筛选 Chip 徽标）
  //    ⚠️ P1.3 R2：reduce 已迁至 ./snifferMediaLogic（依赖数组保持不变）
  const formatCounts = useMemo(() => countByFormat(sniffedMediaList), [sniffedMediaList]);

  // 🎚️ 按当前筛选格式派生的展现列表
  //    ⚠️ P1.3 R2：三元 + filter 已迁至 ./snifferMediaLogic（ALL 分支仍返回原引用）
  const filteredMediaList = useMemo(
    () => filterByFormat(sniffedMediaList, filterFormat),
    [sniffedMediaList, filterFormat]
  );

  return {
    // 状态
    sniffedMediaList,
    filterFormat,
    setFilterFormat,
    isSniffing,
    // 派生
    filteredMediaList,
    formatCounts,
    // 消息
    handleWebMessage,
    // 操作
    removeMediaItem,
    clearSniffedMedia,
    triggerManualSniff,
  };
}

export default useBrowserSniffer;
// --- END OF FILE src/hooks/browser/useBrowserSniffer.ts ---
