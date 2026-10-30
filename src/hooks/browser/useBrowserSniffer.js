// --- START OF FILE src/hooks/browser/useBrowserSniffer.js ---
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { LayoutAnimation } from 'react-native';
import * as Haptics from 'expo-haptics';

import { mergeMediaList } from '../../constants/browser';
import { MANUAL_SNIFF_SCRIPT } from '../../scripts/browser';

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
 */

// 🎚️ 筛选选项（顺序即 UI 展示顺序）
export const FILTER_OPTIONS = ['ALL', 'MP4', 'M3U8', 'MOV'];

export function useBrowserSniffer({ onMediaFound } = {}) {
  // 🎞️ 嗅探到的视频源列表
  const [sniffedMediaList, setSniffedMediaList] = useState([]);
  // 🎚️ 格式筛选：'ALL' | 'MP4' | 'M3U8' | 'MOV'
  const [filterFormat, setFilterFormat] = useState('ALL');
  // 🔍 扫描动画状态
  const [isSniffing, setIsSniffing] = useState(false);

  // ⏱️ 手动扫描兜底定时器
  const sniffTimerRef = useRef(null);

  // 📣 命中回调：用 ref 持有，避免调用方内联函数导致 handleWebMessage 频繁重建
  const onMediaFoundRef = useRef(onMediaFound);
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
  const pushMedia = useCallback((incoming) => {
    setSniffedMediaList((prev) => {
      const next = mergeMediaList(prev, incoming);
      if (next !== prev) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // 📣 真正嗅探到片源 → 通知编排层打开选择播放源弹窗
        onMediaFoundRef.current?.(next);
      }
      return next;
    });
  }, []);

  /**
   * 📨 处理来自 <WebView> 的 onMessage 事件
   * @returns {boolean} true = 已被嗅探域消费；false = 非嗅探消息（如 AD_BLOCKED），交由调用方处理
   */
  const handleWebMessage = useCallback(
    (event) => {
      let data;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch (_) {
        return false;
      }
      if (!data || typeof data !== 'object') return false;

      // 单条命中（被动嗅探，保留旧协议兼容）
      if (data.type === 'VIDEO_FOUND' && data.url) {
        setIsSniffing(false);
        pushMedia([data.url]);
        return true;
      }

      // 多片源批量命中（手动扫描）
      if (data.type === 'VIDEO_FOUND_LIST') {
        setIsSniffing(false);
        const urls = Array.isArray(data.urls) ? data.urls.filter(Boolean) : [];
        // 🔇 空结果：静默处理，不弹窗、不提示
        if (urls.length === 0) return true;
        pushMedia(urls);
        return true;
      }

      // 旧版手动扫描完成信号（兼容）
      if (data.type === 'MANUAL_SNIFF_DONE') {
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
  const removeMediaItem = useCallback((id) => {
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
  const triggerManualSniff = useCallback((webViewRef) => {
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
  }, []);

  // 🎚️ 各格式计数（用于筛选 Chip 徽标）
  const formatCounts = useMemo(
    () =>
      sniffedMediaList.reduce(
        (acc, item) => {
          const ext = (item.ext || '').toUpperCase();
          acc.ALL += 1;
          if (ext === 'MP4') acc.MP4 += 1;
          else if (ext === 'M3U8') acc.M3U8 += 1;
          else if (ext === 'MOV') acc.MOV += 1;
          return acc;
        },
        { ALL: 0, MP4: 0, M3U8: 0, MOV: 0 }
      ),
    [sniffedMediaList]
  );

  // 🎚️ 按当前筛选格式派生的展现列表
  const filteredMediaList = useMemo(
    () =>
      filterFormat === 'ALL'
        ? sniffedMediaList
        : sniffedMediaList.filter((item) => (item.ext || '').toUpperCase() === filterFormat),
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
// --- END OF FILE src/hooks/browser/useBrowserSniffer.js ---
