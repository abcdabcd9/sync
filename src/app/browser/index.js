// --- START OF FILE src/app/browser/index.js ---
import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, TextInput, Keyboard, Platform, LayoutAnimation, UIManager, Alert, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useAppTheme } from '../../context/ThemeContext';
import { useBrowserSession } from '../../context/BrowserSessionContext';
import { useCinema } from '../../hooks/useCinema';
import { useAuth } from '../../hooks/useAuth';

// 🧩 领域 Hook（阶段 2~5 抽离）
import { useBrowserHistory } from '../../hooks/browser/useBrowserHistory';
import { useBrowserSniffer } from '../../hooks/browser/useBrowserSniffer';
import { useAdBlocker } from '../../hooks/browser/useAdBlocker';
import { useBrowserProgress } from '../../hooks/browser/useBrowserProgress';
import { useBrowserNavigation } from '../../hooks/browser/useBrowserNavigation';
// 🎬 视频观看历史（V1）：按 owner 隔离的观看记录 + 续播决策
import { useWatchHistory } from '../../hooks/browser/useWatchHistory';
import {
  decideResume,
  RESUME_ACTION,
  buildMediaKey,
  buildRecordKey,
  isPendingResumeMatch,
  isResumeTaskExpired,
  isSameEpisodePage,
  matchResumeCandidates,
  parseEpisodeTriple,
  RESUME_TASK_STATUS,
} from '../../hooks/browser/watchHistoryLogic';

// 🧩 UI 弹窗组件（阶段 4 抽离）
import BrowserMenuModal from '../../components/browser/BrowserMenuModal';
import SniffedMediaModal from '../../components/browser/SniffedMediaModal';

// 🌐 常量与注入脚本（阶段 1 抽离）
import { MOBILE_USER_AGENT, DESKTOP_USER_AGENT, isSafeUrl } from '../../constants/browser';
import { buildBeforeLoadScript, AD_DOM_WATCHER_SCRIPT } from '../../scripts/browser';
import { SPRING } from '../../constants/motion';
import { haptic } from '../../constants/haptics';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// params: { targetUrl?: string }
// 浏览器主页：WebView 主体 + 嗅探投屏；历史/书签已拆为独立页
export default function BrowserScreen() {
  const { isDark, colors: palette } = useAppTheme();
  const { user, authEpoch } = useAuth();
  const params = useLocalSearchParams();
  const { loadUrl, emitCommand } = useCinema();
  const {
    pendingUrl, pendingSeq, consumePendingUrl,
    pendingResume, updatePendingResumeStatus,
    lastUrl, rememberUrl,
  } = useBrowserSession();

  // 🌐 起始网址优先级：显式参数 > 上次访问网址 > 默认首页
  //    ⚠️ 仅首次挂载生效（useState 惰性初始化），后续切换走 injectUrl
  //    🐞 修复「冷启动不恢复上次网址」：
  //       lastUrl 由 BrowserSessionProvider 异步从 AsyncStorage 读取，
  //       首帧渲染时仍为 null，而 useBrowserNavigation 内部用 useState(startUrl)
  //       惰性初始化，之后 lastUrl 水合完成也不会再同步 → 恢复功能形同虚设。
  //       这里用 ref 记录「是否已应用过起始网址」，等 lastUrl 就绪后补一次注入。
  const startUrl = params.targetUrl || lastUrl || 'https://www.bing.com';
  const startUrlAppliedRef = useRef(!!params.targetUrl);
  const webViewRef = useRef(null);

  // 🗂️ 菜单 / 🎬 嗅探弹窗的 UI 状态与动画
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnim] = useState(() => new Animated.Value(0));
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnim] = useState(() => new Animated.Value(0));
  const [pickerExpanded, setPickerExpanded] = useState(false); // false=半屏50% / true=全屏92%
  const pickerExpandedRef = useRef(false);

  const openMenu = useCallback(() => {
    haptic.light();
    setMenuVisible(true);
    Animated.spring(menuAnim, { toValue: 1, ...SPRING.bouncy, useNativeDriver: true }).start();
  }, [menuAnim]);

  const closeMenu = useCallback(() => {
    Animated.timing(menuAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMenuVisible(false);
    });
  }, [menuAnim]);

  // 🕘 历史记录 + 🏷️ 书签收藏（阶段 2）
  //    🆔 B1-C：传入当前 userId，实现按账号隔离
  const {
    historyList, addHistory,
    bookmarksList, toggleBookmark, isBookmarked,
  } = useBrowserHistory(user?.id ?? null, authEpoch);

  // 🎬 视频观看历史（V1）：仅用于菜单计数
  //    ⚠️ 写入由影院页的 useWatchProgressRecorder 负责，本页只读
  const { watchList } = useWatchHistory(user?.id ?? null, authEpoch);

  // 🎬 视频嗅探核心（阶段 3）
  //    🔇 静默嗅探：未命中时零反馈；命中时由 onMediaFound 自动弹出选择播放源窗口
  //    ⚠️ openPicker 定义在下方，此处用 ref 转发，避免 Hook 调用顺序 / 依赖问题
  //
  //    🐞 真机故障 B 修复（点击观看历史只停在网页）：
  //       旧实现 handleMediaFound 无条件只调用 openPickerRef.current?.()，
  //       于是「历史 → 播放页 → 嗅探命中」后仅弹出选源窗口，用户还得手动点，
  //       且点完才进影院 —— 用户感知就是「只跳转了原始网页」。
  //       现在：存在待续播任务时，先走 matchResumeCandidates 做身份匹配：
  //         · 唯一可靠匹配 → 自动 loadUrl + goCinema（无需用户操作）
  //         · 多候选       → 打开 Picker，用户选择后由 handleLaunchCinema 完成跳转
  //         · 无命中       → 明确提示 + 保留任务（不静默停在网页）
  //       无待续播任务时保持原有正常浏览行为（仅弹 Picker）。
  const openPickerRef = useRef(null);
  // 🎯 续播交接状态：'idle' | 'sniffing' | 'matched' | 'ambiguous' | 'failed'
  //    用于给用户明确反馈（避免「只看到网页、不知道程序在做什么」）
  const [resumeHandoff, setResumeHandoff] = useState('idle');
  // 🎯 已自动交接过的 taskId：同一任务只自动跳转一次，杜绝重复进入 Cinema
  const autoHandoffTaskIdRef = useRef(null);
  // 🎯 已自动嗅探过的 taskId：同一任务只自动触发一次嗅探，杜绝重定向循环
  const autoSniffTaskIdRef = useRef(null);
  // 🎯 自动嗅探失败兜底定时器：2.5s 内无匹配 → 明确提示，绝不无限等待
  const resumeHandoffTimerRef = useRef(null);
  // 🎯 待续播任务镜像：供嗅探回调（闭包可能过期）同步读取
  const pendingResumeRef = useRef(null);
  useEffect(() => {
    pendingResumeRef.current = pendingResume;
  }, [pendingResume]);

  // 🎯 已主动发起过「页面加载 / 刷新」的 taskId：
  //    一个任务只允许触发一次导航或一次 reload，杜绝重定向 / 多次 onLoadEnd 造成无限刷新。
  const resumeNavTaskIdRef = useRef(null);
  // 🎯 同 URL 强制刷新后，等待 onLoadEnd 期间的重入保护（防止 effect 重跑重复 reload）
  const resumeReloadPendingRef = useRef(null);

  // 🛡️ §3.5 账号切换终止：authEpoch 变化（切号 / 登出）时，
  //    旧账号的续播任务与所有去重标记必须立即失效，
  //    绝不允许旧任务在新账号下继续导航 / 刷新 / 进入影院。
  //    ⚠️ 只清理 ref 与定时器（外部系统），状态复位交给「新任务到达」分支，
  //       避免在 effect 内同步 setState 造成级联渲染。
  useEffect(() => {
    resumeNavTaskIdRef.current = null;
    resumeReloadPendingRef.current = null;
    autoSniffTaskIdRef.current = null;
    autoHandoffTaskIdRef.current = null;
    if (resumeHandoffTimerRef.current) {
      clearTimeout(resumeHandoffTimerRef.current);
      resumeHandoffTimerRef.current = null;
    }
  }, [authEpoch]);

  // 🧹 卸载时清理兜底定时器，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (resumeHandoffTimerRef.current) {
        clearTimeout(resumeHandoffTimerRef.current);
        resumeHandoffTimerRef.current = null;
      }
    },
    []
  );

  // 🛡️ 广告拦截域（阶段 5）
  const {
    isAdBlockEnabled, blockedAdCount, bumpBlockedAdCount,
    handleShouldStartLoad, runAdCleanup, toggleAdBlock,
  } = useAdBlocker(webViewRef);

  // 🧭 导航域（阶段 5）
  const {
    currentUrl, inputUrl, setInputUrl, canGoBack, canGoForward,
    isDesktopMode, actualLoadedUrl, actualLoadedTitle,
    handleSubmitUrl, handleGoBack, handleGoForward, handleClose,
    toggleDesktopMode, handleNavigationStateChange, injectUrl, goCinema,
  } = useBrowserNavigation({
    startUrl,
    webViewRef,
    loadUrl,
    emitCommand,
    addHistory,
    closeMenu,
    onUrlVisited: rememberUrl,
  });

  /**
   * 🎬 续播交接核心：把「嗅探到的候选列表」交给匹配器并执行对应动作。
   *    ⚠️ 必须定义在 useBrowserNavigation 之后（依赖 goCinema）。
   * @param {Array<{url: string}>|string[]} mediaList 候选片源
   * @param {string} pageUrl 当前播放页 URL
   * @returns {'matched'|'ambiguous'|'none'} 处理结果
   */
  const runResumeHandoff = useCallback(
    (mediaList, pageUrl) => {
      const task = pendingResumeRef.current;
      if (!task || !task.taskId) return 'none';
      // 🆔 同一任务只自动交接一次，杜绝重复进入 Cinema
      if (autoHandoffTaskIdRef.current === task.taskId) return 'matched';
      // ⏱️ 任务已超时 → 作废并提示，绝不无限等待
      if (isResumeTaskExpired(task)) {
        updatePendingResumeStatus(task.taskId, RESUME_TASK_STATUS.ABORTED);
        setResumeHandoff('failed');
        return 'none';
      }
      const result = matchResumeCandidates(task, mediaList, pageUrl);
      if (result.status === 'MATCHED') {
        // ✅ 唯一可靠匹配 → 自动进入影院，任务保留给影院页 seek 后消费
        autoHandoffTaskIdRef.current = task.taskId;
        setResumeHandoff('matched');
        haptic.heavy();
        loadUrl(result.url, result.pageUrl || null);
        goCinema();
        return 'matched';
      }
      if (result.status === 'AMBIGUOUS') {
        // ⚠️ 多候选 → 绝不无依据地选第一条，也绝不弹 Picker（用户明确要求无弹窗）。
        //    优先用「上次成功播放的媒体身份」在候选中做精确匹配（matchResumeCandidates
        //    已按 recordKey / mediaKey / 脱敏 URL 三层身份过滤，命中多条说明确实无法区分）。
        //    此时给出非弹窗式状态提示，保留任务与历史，让用户可手动点嗅探按钮重试。
        setResumeHandoff('ambiguous');
        return 'ambiguous';
      }
      // ❌ 无命中 → 明确状态 + 保留任务（用户可手动点嗅探按钮重试）
      setResumeHandoff('failed');
      return 'none';
    },
    [loadUrl, goCinema, updatePendingResumeStatus]
  );

  // 🎬 嗅探命中回调（故障 B2）：必须定义在 useBrowserNavigation 之后，
  //    因为它读取 actualLoadedUrl（导航域返回值）。
  //
  //    🐞 P0 修复（历史续播模式必须完全无弹窗）：
  //       旧实现「无命中」时仍会 openPickerRef.current?.()，用户点历史后仍会看到
  //       媒体选择弹窗 —— 与「一键直达、无弹窗」要求冲突。
  //       现在：存在待续播任务时，无论 matched / ambiguous / none 都**绝不打开 Picker**，
  //       只通过状态条给出非弹窗式反馈；无待续播任务（普通浏览 / 手动嗅探）保持原行为。
  const handleMediaFound = useCallback(
    (nextList) => {
      const task = pendingResumeRef.current;
      if (task && task.taskId) {
        const pageUrl = actualLoadedUrl.current || currentUrl || '';
        // 续播模式：只做匹配与状态提示，绝不弹 Picker
        runResumeHandoff(nextList, pageUrl);
        return;
      }
      // 普通浏览模式：保持原有「嗅探到片源 → 弹选择窗口」行为
      openPickerRef.current?.();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actualLoadedUrl 为 ref，引用恒定
    [runResumeHandoff, currentUrl]
  );

  // 🎬 视频嗅探核心（阶段 3）
  //    🔇 静默嗅探：未命中时零反馈；命中时由 onMediaFound 自动弹出选择播放源窗口
  const {
    sniffedMediaList, filterFormat, setFilterFormat, isSniffing,
    filteredMediaList, formatCounts, handleWebMessage,
    removeMediaItem, clearSniffedMedia, triggerManualSniff,
  } = useBrowserSniffer({ onMediaFound: handleMediaFound });

  // 🔗 消费历史 / 书签页交接过来的 URL（同一实例内切换，不新建浏览器）
  //    🎬 视频观看历史（V1）：若同时存在待续播任务，则按 decideResume 分流：
  //       - Case A（直链可用）→ 直接进入影院，由影院页在播放器就绪后 seek
  //       - Case B（仅播放页）→ 注入播放页，保留 pendingResume 供嗅探命中后匹配续播
  //    🛡️ P0-1 修复：浏览器页**只负责发起交接**，绝不在此处 consumePendingResume。
  //       旧实现 goCinema() 后立即 consumePendingResume()，导致影院页 seek effect
  //       读到的 pendingResume 已是 null，续播永远不执行（真实逻辑阻断）。
  //       现在任务保留在 Context 中，由影院页在「媒体身份确认 + 播放器就绪 +
  //       seek 成功」后消费；失败 / 超时 / 切号由影院页或 Context 清理。
  useEffect(() => {
    if (!pendingUrl) return;
    const resumeTask = pendingResume;
    // 🎬 新任务到达 → 重置交接状态与去重标记，避免旧任务状态污染新视频
    if (resumeTask && resumeTask.taskId) {
      if (autoSniffTaskIdRef.current !== resumeTask.taskId) {
        autoSniffTaskIdRef.current = null;
        autoHandoffTaskIdRef.current = null;
        setResumeHandoff('idle');
      }
      // 🆔 新任务 → 允许发起一次新的加载 / 刷新（旧任务的去重标记必须失效）
      if (resumeNavTaskIdRef.current && resumeNavTaskIdRef.current !== resumeTask.taskId) {
        resumeNavTaskIdRef.current = null;
        resumeReloadPendingRef.current = null;
      }
    }
    if (resumeTask) {
      // 用「当前可用的直链」作为候选：仅当 pendingUrl 本身就是直链时才可能命中
      const candidates = /^https?:/i.test(pendingUrl) ? [{ url: pendingUrl }] : [];
      const decision = decideResume(
        {
          mediaKey: resumeTask.mediaKey,
          mediaUrl: resumeTask.mediaUrl,
          pageUrl: resumeTask.pageUrl,
          positionMillis: Math.round((resumeTask.seekSeconds || 0) * 1000),
          durationMillis: 0,
          completed: false,
        },
        candidates
      );
      if (decision.action === RESUME_ACTION.PLAY_AND_SEEK || decision.action === RESUME_ACTION.PLAY_FROM_START) {
        // Case A：直链仍可用 → 直接进影院，由影院页在播放器就绪后 seek
        //    ⚠️ 不 consumePendingResume：任务必须留给影院页消费
        haptic.heavy();
        const pageUrl = resumeTask.pageUrl || null;
        loadUrl(decision.url, pageUrl);
        goCinema();
        consumePendingUrl();
        return;
      }
      // Case B：需要回原始播放页重新嗅探 → 保留 pendingResume，等嗅探命中后匹配
      //    ⚠️ 不在此处 consumePendingResume，交由影院页嗅探回调消费
      //
      //    🐞 真机故障修复（同 URL 不刷新导致自动续播失败）：
      //       旧实现无条件 injectUrl(pendingUrl)。当 WebView 已经停在该集播放页时，
      //       setCurrentUrl(相同字符串) 被 React bail out → 不重渲染 →
      //       <WebView source={{ uri: currentUrl }}> 不变 → 不重新加载 →
      //       onLoadEnd 不触发 → 自动嗅探不执行 → 无法自动进入影院。
      //       现在按「实际已加载页」判定：
      //         · 同一页 → 主动 reload()（§3.2），并重置旧嗅探状态（§3.4）
      //         · 不同页 → 正常导航到目标页（§3.3），不额外 reload
      //       🆔 同一 taskId 只发起一次，杜绝重定向 / 多次 onLoadEnd 造成无限刷新（§3.5）。
      const taskId = resumeTask.taskId;
      if (resumeNavTaskIdRef.current === taskId) {
        // 本任务已发起过加载 / 刷新 → 只消费 URL，绝不重复触发
        consumePendingUrl();
        return;
      }
      resumeNavTaskIdRef.current = taskId;
      // 🧹 §3.4：重置旧页面的嗅探结果与交接状态，避免旧页资源参与匹配
      autoSniffTaskIdRef.current = null;
      autoHandoffTaskIdRef.current = null;
      clearSniffedMedia();
      setResumeHandoff('idle');
      if (resumeHandoffTimerRef.current) {
        clearTimeout(resumeHandoffTimerRef.current);
        resumeHandoffTimerRef.current = null;
      }

      // §3.1：用 WebView 实际已加载的 URL 判定，而不是只看 React currentUrl
      const loadedUrl = actualLoadedUrl.current || currentUrl || '';
      if (isSameEpisodePage(pendingUrl, loadedUrl)) {
        // §3.2：同一页面 → 必须由本任务主动刷新，否则 onLoadEnd 永不触发
        injectUrl(pendingUrl);
        resumeReloadPendingRef.current = taskId;
        webViewRef.current?.reload();
        consumePendingUrl();
        return;
      }
      // §3.3：不同页面 → 正常导航到目标集数播放页（不额外 reload）
      injectUrl(pendingUrl);
      consumePendingUrl();
      return;
    }
    injectUrl(pendingUrl);
    consumePendingUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumePendingUrl / clearSniffedMedia 为稳定引用
  }, [pendingUrl, pendingSeq, pendingResume, injectUrl, loadUrl, goCinema]);

  // 🕘 冷启动补注入上次网址：
  //    lastUrl 异步水合完成后（首帧为 null），若本次进入没有显式 targetUrl、
  //    且尚未应用过起始网址，则把上次网址注入 WebView。
  //    ⚠️ 只在「首次」补一次，避免用户已手动导航后被强行拉回。
  useEffect(() => {
    if (startUrlAppliedRef.current) return;
    if (!lastUrl) return;
    if (params.targetUrl) return;
    startUrlAppliedRef.current = true;
    injectUrl(lastUrl);
  }, [lastUrl, params.targetUrl, injectUrl]);

  // 📊 加载进度条（阶段 5）：加载完成后注入广告清理 + 写入历史
  //    ⚠️ 回调内读取 actualLoadedUrl.current，故不放入依赖数组（ref 引用恒定）
  //
  //    🎬 故障 B1 修复：存在待续播任务时，页面加载完成后自动触发一次「有界」媒体检测，
  //       不再要求用户手动点嗅探按钮。复用现有 triggerManualSniff（注入 MANUAL_SNIFF_SCRIPT
  //       + 2s 兜底复位），不重新开发嗅探引擎。
  //       ⏱️ 有界：只触发一次（autoSniffTaskIdRef 去重），且 2s 内无结果即由
  //          resumeHandoffTimerRef 判定失败并给出明确提示，绝不无限等待。
  const handleLoadFinish = useCallback(
    ({ nativeEvent }) => {
      runAdCleanup();
      const loadedUrl = nativeEvent?.url || actualLoadedUrl.current;
      if (loadedUrl) addHistory(loadedUrl, nativeEvent?.title);

      // 🎬 自动续播嗅探（仅当存在有效待续播任务）
      const task = pendingResumeRef.current;
      if (!task || !task.taskId) return;
      // 同一任务只自动嗅探一次，避免重定向 / 多次 onLoadEnd 造成循环嗅探
      if (autoSniffTaskIdRef.current === task.taskId) return;
      if (isResumeTaskExpired(task)) {
        updatePendingResumeStatus(task.taskId, RESUME_TASK_STATUS.ABORTED);
        setResumeHandoff('failed');
        return;
      }
      // 🛡️ §3.4 页面归属校验：本次加载完成的页面必须属于当前任务。
      //    若任务目标页与「实际加载页」既不同页、也不是同一集播放页，
      //    说明这次 onLoadEnd 来自无关页面（重定向 / 用户手动导航），
      //    绝不能据此启动嗅探，否则会把别的页面资源当成目标视频。
      const targetPage = task.pageUrl || '';
      const loadedPage = loadedUrl || '';
      if (targetPage && loadedPage && !isSameEpisodePage(targetPage, loadedPage)) {
        // 目标页尚未到达 → 不嗅探、不判失败，等真正的目标页 onLoadEnd
        return;
      }
      // ✅ 已到达目标页（含同 URL 强制刷新场景）→ 清除 reload 等待标记
      if (resumeReloadPendingRef.current === task.taskId) {
        resumeReloadPendingRef.current = null;
      }
      autoSniffTaskIdRef.current = task.taskId;
      setResumeHandoff('sniffing');
      // 有界检测：注入一次手动嗅探脚本（内部 2s 兜底复位 isSniffing）
      triggerManualSniff(webViewRef);
      // ⏱️ 失败兜底：2.5s 内仍未匹配到目标 → 明确提示，保留任务供用户手动重试
      if (resumeHandoffTimerRef.current) clearTimeout(resumeHandoffTimerRef.current);
      resumeHandoffTimerRef.current = setTimeout(() => {
        resumeHandoffTimerRef.current = null;
        const cur = pendingResumeRef.current;
        if (!cur || cur.taskId !== task.taskId) return;
        // 已 matched / ambiguous 时不再覆盖状态
        setResumeHandoff((prev) => (prev === 'sniffing' ? 'failed' : prev));
      }, 2500);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actualLoadedUrl 为 ref，引用恒定
    [runAdCleanup, addHistory, triggerManualSniff, updatePendingResumeStatus]
  );

  const { progressOpacity, progressWidth, handleLoadStart, handleLoadProgress, handleLoadEnd } =
    useBrowserProgress({ onFinish: handleLoadFinish });

  // 🧩 注入脚本装配（阶段 1）：isDesktopMode 变化时才重建
  const runBeforeLoad = useMemo(() => buildBeforeLoadScript({ isDesktopMode }), [isDesktopMode]);

  // 📨 WebView 消息分流：AD_BLOCKED 留在编排层，其余交由 useBrowserSniffer
  const onMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'AD_BLOCKED') {
          const n = typeof data.count === 'number' && data.count > 0 ? data.count : 1;
          bumpBlockedAdCount(n);
          return;
        }
      } catch (_) {
        return;
      }
      handleWebMessage(event);
    },
    [bumpBlockedAdCount, handleWebMessage]
  );

  // 🎬 打开 / 关闭多资源选择弹窗（默认半屏）
  //    ⚠️ 仅在真正嗅探到片源时由 onMediaFound 触发，空列表不再打开
  const openPicker = useCallback(() => {
    haptic.light();
    pickerExpandedRef.current = false;
    setPickerExpanded(false);
    setPickerVisible(true);
    Animated.spring(pickerAnim, { toValue: 1, ...SPRING.bouncy, useNativeDriver: true }).start();
  }, [pickerAnim]);

  // 🔗 将 openPicker 挂到 ref，供嗅探 Hook 的 onMediaFound 回调调用
  useEffect(() => {
    openPickerRef.current = openPicker;
  }, [openPicker]);

  const closePicker = useCallback(() => {
    Animated.timing(pickerAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setPickerVisible(false);
        pickerExpandedRef.current = false;
        setPickerExpanded(false);
      }
    });
  }, [pickerAnim]);

  // 📐 展开 / 收起嗅探弹窗（半屏 50% ⇄ 全屏 92%）
  const setPickerExpandedState = useCallback((expanded) => {
    if (pickerExpandedRef.current === expanded) return;
    pickerExpandedRef.current = expanded;
    haptic.light();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPickerExpanded(expanded);
  }, []);

  const togglePickerExpanded = useCallback(
    () => setPickerExpandedState(!pickerExpandedRef.current),
    [setPickerExpandedState]
  );

  // 🔍 嗅探按钮：有源直接开菜单；无源则静默深度扫描（命中后由 onMediaFound 自动弹窗）
  const handleSniffPress = useCallback(() => {
    if (sniffedMediaList.length > 0) {
      openPicker();
      return;
    }
    triggerManualSniff(webViewRef);
  }, [sniffedMediaList.length, triggerManualSniff, openPicker]);

  // ▶ 启动影院：支持传入指定片源 URL（默认取列表首项）
  //    📺 同时把当前网页 URL 一起传给影院（用户无感）：
  //       若当前页是 /play/ 剧集播放页，影院可据此抓取整部剧的选集列表
  //    🛡️ P0-3：若存在待续播任务，用户手动选择片源时必须核验身份：
  //       - 选中的片源与任务目标一致 → 保留任务，影院页 seek 续播
  //       - 不一致（用户主动换了别的视频）→ 作废任务，正常播放，绝不套用旧进度
  const handleLaunchCinema = useCallback(
    (url) => {
      const target = typeof url === 'string' && url ? url : sniffedMediaList[0]?.url;
      if (!target) return;
      haptic.heavy();
      Keyboard.dismiss();
      closePicker();
      const pageUrl = actualLoadedUrl.current || currentUrl || null;
      // 🎬 故障 B3：多候选场景下用户从 Picker 选定片源 → 直接完成 Cinema 跳转，
      //    影院页在播放器就绪后自动 seek 到历史进度（任务身份由下方核验保留）。
      //    这里把交接状态标记为 matched，让用户看到「已选定、正在进入影院」。
      if (pendingResume && pendingResume.taskId) {
        setResumeHandoff('matched');
      }
      // 🛡️ 身份核验：仅在任务目标与所选片源一致时保留续播任务
      //    🐞 最终收口（媒体身份语义统一）：
      //       旧实现只构造 mediaKey（ep: 三元组），若页面 URL 不含 /play/x-y-z.html
      //       则退化为 m:<直链>，与历史记录的 ep: 身份永不相等 → 用户手动选源后
      //       任务被误判为「换了别的视频」而作废，续播彻底失效。
      //       现在同时提供 recordKey（与 CDN 无关的「哪一集」）与 mediaKey，
      //       由 isPendingResumeMatch 按三层模型判定。
      if (pendingResume && pendingResume.taskId) {
        const triple = parseEpisodeTriple(pageUrl || '');
        const found = {
          mediaUrl: target,
          pageUrl: pageUrl || '',
          recordKey: buildRecordKey({ mediaUrl: target, pageUrl: pageUrl || '' }),
          mediaKey: buildMediaKey({
            mediaUrl: target,
            pageUrl: pageUrl || '',
            episode: triple || undefined,
          }),
        };
        if (!isPendingResumeMatch(pendingResume, found)) {
          // 用户选了别的视频 → 作废续播任务，避免把旧进度套到新视频
          updatePendingResumeStatus(pendingResume.taskId, RESUME_TASK_STATUS.ABORTED);
        }
      }
      loadUrl(target, pageUrl);
      goCinema();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actualLoadedUrl 为 ref，引用恒定
    [sniffedMediaList, closePicker, loadUrl, goCinema, currentUrl, pendingResume, updatePendingResumeStatus]
  );

  // 📋 复制片源链接
  const handleCopyMediaUrl = useCallback(async (url) => {
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url);
      haptic.success();
    } catch (_) {
      haptic.error();
    }
  }, []);

  // 🧹 清空嗅探列表（数据操作在 Hook 内，这里只负责关闭弹窗）
  const handleClearSniffedMedia = useCallback(() => {
    clearSniffedMedia();
    closePicker();
  }, [clearSniffedMedia, closePicker]);

  // 🕘 历史 / 🏷️ 书签：跳转独立页（阶段 5 拆分）
  const handleOpenHistory = useCallback(() => {
    haptic.light();
    closeMenu();
    router.push('/browser/history');
  }, [closeMenu]);

  const handleOpenBookmarks = useCallback(() => {
    haptic.light();
    closeMenu();
    router.push('/browser/bookmarks');
  }, [closeMenu]);

  // 🎬 视频观看历史入口（V1）
  const handleOpenWatchHistory = useCallback(() => {
    haptic.light();
    closeMenu();
    router.push('/browser/watch-history');
  }, [closeMenu]);

  const handleSaveBookmark = useCallback(async () => {
    haptic.light();
    // ⚠️ ref 引用恒定，不放入依赖数组
    const targetUrl = actualLoadedUrl.current;
    // 🏷️ 直接使用网页自带标题，不做任何自定义命名（空标题时书签页只显示网址）
    const targetTitle = actualLoadedTitle.current;
    // 🔒 仅允许保存 https:// 安全链接（拒绝 http:// 与非法协议）
    if (!isSafeUrl(targetUrl)) {
      Alert.alert('无法收藏', '仅支持收藏 HTTPS 安全链接。');
      closeMenu();
      return;
    }
    if (isBookmarked(targetUrl)) {
      Alert.alert('提示', '该网址已在收藏夹中');
      closeMenu();
      return;
    }
    const result = await toggleBookmark(targetUrl, targetTitle);
    if (!result.ok) {
      Alert.alert('无法收藏', '仅支持收藏 HTTPS 安全链接。');
      closeMenu();
      return;
    }
    haptic.success();
    Alert.alert('收藏成功', '已添加到书签列表');
    closeMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actualLoadedUrl 为 ref，引用恒定
  }, [isBookmarked, toggleBookmark, closeMenu]);

  const handleReload = useCallback(() => {
    closeMenu();
    webViewRef.current?.reload();
  }, [closeMenu]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top', 'bottom']}>
      <View style={[styles.navBar, { borderBottomColor: palette.separator }]}>
        <View style={[styles.urlInputContainer, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
          <Ionicons name="search" size={16} color={palette.textSecondary} style={{ marginRight: 8 }} />
          <TextInput
            style={[styles.urlInput, { color: palette.textPrimary }]}
            value={inputUrl}
            onChangeText={setInputUrl}
            onSubmitEditing={handleSubmitUrl}
            returnKeyType="go"
            selectTextOnFocus
            autoCapitalize="none"
            placeholder="搜索在线电影或输入直链"
            placeholderTextColor={palette.textSecondary}
          />
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
          <Text style={[styles.closeText, { color: palette.primary }]}>取消</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.webContainer}>
        <Animated.View
          pointerEvents="none"
          style={[styles.progressBarTrack, { opacity: progressOpacity, backgroundColor: palette.separator }]}
        >
          <Animated.View style={[styles.progressBarFill, { width: progressWidth }]} />
        </Animated.View>

        {/* 🎬 续播交接状态条（故障 B4）：让用户明确知道程序正在做什么，
            避免「只看到网页、不知道在自动嗅探 / 匹配 / 失败」。
            ⚠️ 非弹窗式：pointerEvents="none"，不拦截触摸、不遮挡操作。 */}
        {resumeHandoff !== 'idle' && (
          <View
            pointerEvents="none"
            style={[
              styles.resumeBanner,
              {
                backgroundColor:
                  resumeHandoff === 'failed'
                    ? 'rgba(255,59,48,0.92)'
                    : resumeHandoff === 'ambiguous'
                      ? 'rgba(255,149,0,0.92)'
                      : 'rgba(0,122,255,0.92)',
              },
            ]}
          >
            <Ionicons
              name={
                resumeHandoff === 'failed'
                  ? 'alert-circle'
                  : resumeHandoff === 'ambiguous'
                    ? 'hand-left'
                    : resumeHandoff === 'matched'
                      ? 'checkmark-circle'
                      : 'sync'
              }
              size={14}
              color="#FFFFFF"
              style={{ marginRight: 6 }}
            />
            <Text style={styles.resumeBannerText} numberOfLines={2}>
              {resumeHandoff === 'sniffing'
                ? '正在自动检测视频源…'
                : resumeHandoff === 'matched'
                  ? '已匹配到上次观看的视频，正在进入影院…'
                  : resumeHandoff === 'ambiguous'
                    ? '检测到多个片源，无法确定上次观看的那一个，可点嗅探按钮重试'
                    : '未自动找到上次的视频，可点嗅探按钮重试'}
            </Text>
          </View>
        )}
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          originWhitelist={['https://*', 'about:*']}
          javaScriptEnabled={true}
          // 🔒 M-4：禁止 WebView 读取本地文件系统，阻断 file:// 越权读取沙箱数据
          allowFileAccess={false}
          // 🔒 M-4：禁止 file:// 页面发起跨域请求（Android 上该开关默认可能为 true）
          allowUniversalAccessFromFileURLs={false}
          // 🔒 M-4：禁止 file:// 页面读取其他 file:// 资源
          allowFileAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          contentMode={isDesktopMode ? 'desktop' : 'mobile'}
          allowsBackForwardNavigationGestures={true}
          injectedJavaScriptBeforeContentLoaded={runBeforeLoad}
          injectedJavaScript={AD_DOM_WATCHER_SCRIPT}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          // 🔄 原生下拉刷新 + iOS 弹性滑动
          pullToRefreshEnabled={true}
          bounces={true}
          onNavigationStateChange={handleNavigationStateChange}
          onLoadStart={handleLoadStart}
          onLoadProgress={handleLoadProgress}
          onLoadEnd={handleLoadEnd}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          scalesPageToFit={isDesktopMode}
          setBuiltInZoomControls={isDesktopMode}
          userAgent={isDesktopMode ? DESKTOP_USER_AGENT : MOBILE_USER_AGENT}
        />
      </View>

      <View style={[styles.bottomBar, { backgroundColor: palette.background, borderTopColor: palette.separator }]}>
        <TouchableOpacity style={styles.bottomBtn} onPress={handleGoBack}>
          <Ionicons name="chevron-back" size={26} color={canGoBack ? palette.primary : palette.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.bottomBtn} onPress={handleGoForward} disabled={!canGoForward}>
          <Ionicons name="chevron-forward" size={26} color={canGoForward ? palette.primary : palette.separator} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.bottomBtn} onPress={handleSniffPress}>
          <Ionicons name={isSniffing ? 'scan' : 'scan-outline'} size={24} color={isSniffing ? palette.primary : palette.success} />
          {sniffedMediaList.length > 0 && (
            <View style={styles.sniffBadge}>
              <Text style={styles.sniffBadgeText}>{sniffedMediaList.length}</Text>
            </View>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.bottomBtn} onPress={openMenu}>
          <Ionicons name="menu" size={28} color={palette.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* 🗂️ 浏览器主菜单（历史/书签已拆为独立页，菜单仅保留入口） */}
      <BrowserMenuModal
        visible={menuVisible}
        onRequestClose={closeMenu}
        isDark={isDark}
        palette={palette}
        menuAnim={menuAnim}
        isDesktopMode={isDesktopMode}
        onToggleDesktopMode={toggleDesktopMode}
        onSaveBookmark={handleSaveBookmark}
        onReload={handleReload}
        isAdBlockEnabled={isAdBlockEnabled}
        blockedAdCount={blockedAdCount}
        onToggleAdBlock={toggleAdBlock}
        bookmarksList={bookmarksList}
        historyList={historyList}
        watchHistoryList={watchList}
        onOpenBookmarks={handleOpenBookmarks}
        onOpenHistory={handleOpenHistory}
        onOpenWatchHistory={handleOpenWatchHistory}
      />

      {/* 🎬 多视频源选择 Bottom Sheet（阶段 4 抽离至 SniffedMediaModal） */}
      <SniffedMediaModal
        visible={pickerVisible}
        onRequestClose={closePicker}
        isDark={isDark}
        palette={palette}
        pickerAnim={pickerAnim}
        sniffedMediaList={sniffedMediaList}
        filteredMediaList={filteredMediaList}
        filterFormat={filterFormat}
        onFilterChange={setFilterFormat}
        formatCounts={formatCounts}
        pickerExpanded={pickerExpanded}
        onToggleExpanded={togglePickerExpanded}
        onExpand={() => setPickerExpandedState(true)}
        onCollapse={() => setPickerExpandedState(false)}
        onClear={handleClearSniffedMedia}
        onPlay={handleLaunchCinema}
        onCopy={handleCopyMediaUrl}
        onRemove={removeMediaItem}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  navBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  urlInputContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', height: 40, borderRadius: 10, paddingHorizontal: 12, borderWidth: 1 },
  urlInput: { flex: 1, fontSize: 16, height: '100%' },
  closeBtn: { marginLeft: 12, paddingVertical: 8 },
  closeText: { fontSize: 16, fontWeight: '500' },
  webContainer: { flex: 1, position: 'relative' },
  webview: { flex: 1, backgroundColor: 'transparent' },
  progressBarTrack: { position: 'absolute', top: 0, left: 0, right: 0, height: 2, zIndex: 20, overflow: 'hidden' },
  progressBarFill: { height: 2, backgroundColor: '#FF2D55' },
  // 🎬 续播交接状态条（故障 B4）：悬浮在网页顶部，不拦截触摸
  resumeBanner: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 30,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  resumeBannerText: { flex: 1, fontSize: 12, fontWeight: '600', color: '#FFFFFF' },
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 50, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
  bottomBtn: { padding: 8 },
  // 🔢 嗅探按钮角标（静默提示数量，不挡屏）
  sniffBadge: { position: 'absolute', top: 2, right: 0, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, backgroundColor: '#FF2D55', alignItems: 'center', justifyContent: 'center' },
  sniffBadgeText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
});
// --- END OF FILE src/app/browser/index.js ---
