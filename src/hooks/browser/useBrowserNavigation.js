// --- START OF FILE src/hooks/browser/useBrowserNavigation.js ---
import { useState, useRef, useEffect, useCallback } from 'react';
import { Platform, Keyboard, LayoutAnimation, BackHandler } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { isSafeUrl } from '../../constants/browser';

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
    let target = inputUrl.trim();
    if (!target) return;

    // 🔒 安全审计 #25：明文 http:// 一律升级为 https://（必须先于直链视频判断，防止绕过安全层）
    if (/^http:\/\//i.test(target)) {
      target = target.replace(/^http:\/\//i, 'https://');
    }

    const isDirectVideo = /\.(mp4|m3u8)(\?.*)?$/i.test(target);
    if (isDirectVideo) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      loadUrl(target);
      emitCommand('PLAY', 0, target);
      goCinema();
      return;
    }

    // 非 http(s) 输入走 Bing 搜索
    if (!/^https:\/\//i.test(target)) {
      target = 'https://cn.bing.com/search?q=' + encodeURIComponent(target);
    }
    setCurrentUrl(target);
    actualLoadedUrl.current = target;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [inputUrl, loadUrl, emitCommand, goCinema]);

  // 🖥️ 电脑版 / 移动版切换：改写主机名 + 重载页面让新 UA 生效
  const toggleDesktopMode = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const nextMode = !isDesktopMode;
    closeMenu();

    const targetUrl = actualLoadedUrl.current;
    let deskUrl = targetUrl;

    // 仅改写主机名部分（避免误伤 path / query 中的 "://m." 片段）
    if (nextMode) {
      deskUrl = targetUrl.replace(/^(https?:\/\/)(m|wap)\./i, '$1www.');
    } else {
      deskUrl = targetUrl.replace(/^(https?:\/\/)www\./i, '$1m.');
    }

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
      if (isSafeUrl(navState.url) && navState.url !== inputUrl && !navState.url.includes('cn.bing.com')) {
        setInputUrl(navState.url);
      }
      // 🕘 单页应用（SPA）路由切换不会触发 onLoadEnd，这里兜底记录
      if (navState.url && !navState.loading) {
        addHistory(navState.url, navState.title);
      }
    },
    [inputUrl, addHistory]
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

  return {
    // 状态
    currentUrl,
    inputUrl,
    setInputUrl,
    canGoBack,
    canGoForward,
    isDesktopMode,
    actualLoadedUrl,
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
    goCinema,
  };
}

export default useBrowserNavigation;
// --- END OF FILE src/hooks/browser/useBrowserNavigation.js ---
