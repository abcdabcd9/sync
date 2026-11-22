// --- START OF FILE src/hooks/browser/useBrowserNavigation.js ---
import { useState, useRef, useEffect, useCallback } from 'react';
import { Platform, Keyboard, LayoutAnimation, BackHandler } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { isSafeUrl } from '../../constants/browser';
// 🧭 TASK-P1.3 R0：URL 决策纯函数（行为与内联实现逐字节等价）
import {
  resolveSubmitTarget,
  rewriteDesktopHost,
  shouldSyncInputUrl,
} from './navigationUrlLogic';

/**
 * 🧭 浏览器导航域 Hook（阶段 5 抽离）
 *
 * 职责：
 *  1. 维护 currentUrl / inputUrl / canGoBack / canGoForward / isDesktopMode
 *  2. handleSubmitUrl：http→https 升级、直链视频跳影院、非 URL 走 Bing 搜索
 *  3. handleGoBack / handleGoForward / handleClose
 *  4. Android 硬件返回键拦截（网页内可回退时消费事件）
 *  5. iOS 原生 Stack 右滑手势与 WKWebView 内部手势解耦
 *  6. toggleDesktopMode：m./wap. ⇄ www. 主机名改写 + 重载
 *  7. onNavigationStateChange：同步导航状态 + 兜底写历史
 *
 * ⚠️ 行为与原 browser.js 内联实现 100% 一致。
 */
export function useBrowserNavigation({
  startUrl,
  webViewRef,
  loadUrl,
  emitCommand,
  addHistory,
  closeMenu,
  onUrlVisited,
}) {
  const router = useRouter();
  const navigation = useNavigation();

  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [inputUrl, setInputUrl] = useState(startUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isDesktopMode, setIsDesktopMode] = useState(false);

  // 真实已加载 URL（WebView 回调中读取，避免闭包过期）
  const actualLoadedUrl = useRef(startUrl);
  // 🏷️ 当前网页自带标题（WebView navState.title），收藏书签时直接复用，不做任何自定义命名
  const actualLoadedTitle = useRef('');
  // 🔙 Android 返回键回调读取的最新 canGoBack（避免 effect 频繁重订阅）
  const canGoBackRef = useRef(canGoBack);

  // ⏱️ 定时器句柄（卸载时统一清理）
  const submitTimerRef = useRef(null);
  const launchTimerRef = useRef(null);

  useEffect(() => {
    canGoBackRef.current = canGoBack;
  }, [canGoBack]);

  // 🧹 组件卸载：清理定时器
  useEffect(
    () => () => {
      if (submitTimerRef.current) {
        clearTimeout(submitTimerRef.current);
        submitTimerRef.current = null;
      }
      if (launchTimerRef.current) {
        clearTimeout(launchTimerRef.current);
        launchTimerRef.current = null;
      }
    },
    []
  );

  // 🔙 统一返回入口：网页内还有历史 → 先回退网页；已到首页 → 退出浏览器
  const handleGoBack = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
      return;
    }
    router.back();
  }, [canGoBack, webViewRef, router]);

  const handleGoForward = useCallback(() => {
    webViewRef.current?.goForward();
  }, [webViewRef]);

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  }, [router]);

  // 📱 安卓系统返回键 / 全面屏返回手势拦截：
  //    网页内可回退时消费事件（阻止退出浏览器），否则放行给系统退出。
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const onHardwareBackPress = () => {
      // 通过 ref 读取最新 canGoBack，避免 effect 因状态变化反复解绑/重绑导致连按漏手势
      if (canGoBackRef.current && webViewRef.current) {
        webViewRef.current.goBack();
        return true; // 拦截：不退出浏览器
      }
      return false; // 放行：系统手势退出浏览器，回到 App 主界面
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBackPress);
    return () => subscription.remove();
  }, [webViewRef]);

  // 🍎 iOS 原生 Stack 右滑手势与 WKWebView 内部前进/后退手势解耦：
  //    网页内可回退时禁用原生 Stack 手势，避免抢占网页内部右滑；
  //    已到首页时恢复原生手势，允许右滑退出浏览器。
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    navigation.setOptions({ gestureEnabled: !canGoBack });
  }, [canGoBack, navigation]);

  // 🔗 跳转影院（iOS 延迟 150ms，规避原生转场与 WebView 卸载竞争）
  //    阶段 5：/cinema 已变为大厅，投屏后进入大厅选择/创建房间
  const goCinema = useCallback(() => {
    if (Platform.OS === 'ios') {
      if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
      submitTimerRef.current = setTimeout(() => {
        submitTimerRef.current = null;
        router.replace('/cinema');
      }, 150);
    } else {
      router.replace('/cinema');
    }
  }, [router]);

  const handleSubmitUrl = useCallback(() => {
    Keyboard.dismiss();
    // 🧭 纯决策：trim / http→https 升级 / 直链视频 / Bing 搜索（见 navigationUrlLogic）
    const decision = resolveSubmitTarget(inputUrl);
    if (decision.kind === 'empty') return;

    if (decision.kind === 'video') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      loadUrl(decision.url);
      emitCommand('PLAY', 0, decision.url);
      goCinema();
      return;
    }

    setCurrentUrl(decision.url);
    actualLoadedUrl.current = decision.url;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [inputUrl, loadUrl, emitCommand, goCinema]);

  // 🖥️ 电脑版 / 移动版切换：改写主机名 + 重载页面让新 UA 生效
  const toggleDesktopMode = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const nextMode = !isDesktopMode;
    closeMenu();

    const targetUrl = actualLoadedUrl.current;
    // 🧭 纯决策：仅改写主机名部分（避免误伤 path / query 中的 "://m." 片段）
    const deskUrl = rewriteDesktopHost(targetUrl, nextMode);

    if (deskUrl !== targetUrl) {
      setCurrentUrl(deskUrl);
      setInputUrl(deskUrl);
      actualLoadedUrl.current = deskUrl;
    }

    setIsDesktopMode(nextMode);

    // 无 key 强挂载后，需主动重载页面让新的 UA / 注入脚本生效（保留历史栈）
    if (webViewRef.current) {
      if (deskUrl !== targetUrl) {
        webViewRef.current.injectJavaScript(
          'window.location.replace(' + JSON.stringify(deskUrl) + '); true;'
        );
      } else {
        webViewRef.current.reload();
      }
    }
  }, [isDesktopMode, closeMenu, webViewRef]);

  // 🔄 WebView 导航状态同步 + SPA 路由兜底写历史
  const handleNavigationStateChange = useCallback(
    (navState) => {
      setCanGoBack(navState.canGoBack);
      setCanGoForward(navState.canGoForward);
      actualLoadedUrl.current = navState.url;
      // 🏷️ 同步网页标题（空标题时保留空串，书签页会退化为只显示网址）
      actualLoadedTitle.current = typeof navState.title === 'string' ? navState.title.trim() : '';
      if (shouldSyncInputUrl(navState.url, inputUrl)) {
        setInputUrl(navState.url);
      }
      // 🕘 单页应用（SPA）路由切换不会触发 onLoadEnd，这里兜底记录
      if (navState.url && !navState.loading) {
        addHistory(navState.url, navState.title);
        // 🕘 记录上次访问网址（供下次打开浏览器时恢复）
        onUrlVisited?.(navState.url);
      }
    },
    [inputUrl, addHistory, onUrlVisited]
  );

  // 🕘 加载历史 / 书签：仅让 WebView 加载网页 + 关闭菜单
  //    ⚠️ 严禁调用 handleLaunchCinema / emitCommand / useCinema.loadUrl，
  //       否则会把网页 URL 塞进影院播放器并唤起 FloatingPlayer 浮层。
  const loadUrlInWebView = useCallback(
    (url) => {
      setInputUrl(url);
      setCurrentUrl(url);
      actualLoadedUrl.current = url;
    },
    []
  );

  // 🔗 外部注入 URL（历史 / 书签页交接）：仅切换 WebView 地址，不触发影院逻辑
  //    ⚠️ 与 loadUrlInWebView 行为一致，独立命名以表达「跨页交接」语义
  //    🐞 修复「注入后返回箭头仍高亮」：注入等于在 WebView 里重新起一个页面，
  //       旧的 canGoBack / canGoForward 属于上一个页面栈，必须立即复位，
  //       否则底部前进/后退按钮会短暂显示为可用（点击无反应）。
  //       真正的状态会在新页面 onNavigationStateChange 回调中重新同步。
  const injectUrl = useCallback(
    (url) => {
      if (!isSafeUrl(url)) return;
      setInputUrl(url);
      setCurrentUrl(url);
      actualLoadedUrl.current = url;
      setCanGoBack(false);
      setCanGoForward(false);
    },
    []
  );

  return {
    // 状态
    currentUrl,
    inputUrl,
    setInputUrl,
    canGoBack,
    canGoForward,
    isDesktopMode,
    actualLoadedUrl,
    actualLoadedTitle,
    // 定时器（供影院跳转复用）
    launchTimerRef,
    // 动作
    handleSubmitUrl,
    handleGoBack,
    handleGoForward,
    handleClose,
    toggleDesktopMode,
    handleNavigationStateChange,
    loadUrlInWebView,
    injectUrl,
    goCinema,
  };
}

export default useBrowserNavigation;
// --- END OF FILE src/hooks/browser/useBrowserNavigation.js ---
