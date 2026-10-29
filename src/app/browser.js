// --- START OF FILE src/app/browser.js ---
import React, { useRef, useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, TextInput, Keyboard, Platform, LayoutAnimation, UIManager, Alert, Animated, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useAppTheme } from '../context/ThemeContext';
import { useCinema } from '../hooks/useCinema';
import { useBrowserHistory } from '../hooks/browser/useBrowserHistory';
import { useBrowserSniffer } from '../hooks/browser/useBrowserSniffer';

// 🧩 UI 弹窗组件（阶段 4 抽离）
import BrowserMenuModal from '../components/browser/BrowserMenuModal';
import SniffedMediaModal from '../components/browser/SniffedMediaModal';

// 🌐 常量与纯工具函数（阶段 1 抽离）
import {
  MOBILE_USER_AGENT,
  DESKTOP_USER_AGENT,
  isSafeUrl,
  isAdUrl,
} from '../constants/browser';

// 🧩 注入脚本（阶段 1 抽离）
import {
  buildBeforeLoadScript,
  AD_DOM_WATCHER_SCRIPT,
  buildAdCleanupScript,
  REMOVE_AD_STYLE_SCRIPT,
} from '../scripts/browser';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function BrowserScreen() {
  const { isDark, colors: palette } = useAppTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const { loadUrl, emitCommand } = useCinema();
  
  const startUrl = params.targetUrl || 'https://nnyy.in/'; 
  
  const webViewRef = useRef(null);
  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [inputUrl, setInputUrl] = useState(startUrl); 
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const [isDesktopMode, setIsDesktopMode] = useState(false);

  // 🕘 历史记录 + 🏷️ 书签收藏（阶段 2 抽离至 useBrowserHistory）
  const {
    historyList,
    addHistory,
    deleteHistory,
    clearHistory,
    bookmarksList,
    toggleBookmark,
    removeBookmark,
    isBookmarked,
  } = useBrowserHistory();

  // 🎬 视频嗅探核心（阶段 3 抽离至 useBrowserSniffer）
  const {
    sniffedMediaList,
    filterFormat,
    setFilterFormat,
    isSniffing,
    filteredMediaList,
    formatCounts,
    handleWebMessage,
    removeMediaItem,
    clearSniffedMedia,
    triggerManualSniff,
  } = useBrowserSniffer();

  // 🛡️ 广告拦截开关（默认开启）与累计拦截计数
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
  const bumpBlockedAdCount = (n = 1) => {
    adCountBatchRef.current += n;
    if (adCountTimerRef.current) return;
    adCountTimerRef.current = setTimeout(() => {
      const delta = adCountBatchRef.current;
      adCountBatchRef.current = 0;
      adCountTimerRef.current = null;
      if (delta > 0) setBlockedAdCount((prev) => prev + delta);
    }, 200);
  };

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnim] = useState(() => new Animated.Value(0));
  const [progressAnim] = useState(() => new Animated.Value(0));
  const [progressOpacity] = useState(() => new Animated.Value(0));

  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnim] = useState(() => new Animated.Value(0));
  // 📐 嗅探弹窗展开态：false = 半屏(50%)，true = 全屏(92%)
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const pickerExpandedRef = useRef(false);

  const [menuTab, setMenuTab] = useState('bookmark'); // 'bookmark' | 'history'

  const actualLoadedUrl = useRef(startUrl);

  // ⏱️ 定时器句柄（卸载时统一清理，避免 setState on unmounted component）
  //    sniffTimerRef 已随嗅探逻辑迁移至 useBrowserSniffer
  const submitTimerRef = useRef(null);
  const launchTimerRef = useRef(null);

  // 🔙 Android 返回键回调读取的最新 canGoBack（避免 effect 频繁重订阅）
  const canGoBackRef = useRef(canGoBack);

  useEffect(() => {
    canGoBackRef.current = canGoBack;
  }, [canGoBack]);

  // 🧹 组件卸载：清理全部定时器 + 停止动画
  useEffect(() => () => {
    if (submitTimerRef.current) { clearTimeout(submitTimerRef.current); submitTimerRef.current = null; }
    if (launchTimerRef.current) { clearTimeout(launchTimerRef.current); launchTimerRef.current = null; }
    if (adCountTimerRef.current) { clearTimeout(adCountTimerRef.current); adCountTimerRef.current = null; }
    menuAnim.stopAnimation();
    pickerAnim.stopAnimation();
    progressAnim.stopAnimation();
    progressOpacity.stopAnimation();
  }, [menuAnim, pickerAnim, progressAnim, progressOpacity]);

  const openMenu = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMenuVisible(true);
    Animated.timing(menuAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  };

  const closeMenu = () => {
    Animated.timing(menuAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMenuVisible(false);
    });
  };

  // 🕘 历史记录 / 🏷️ 书签的读取与持久化已迁移至 useBrowserHistory（阶段 2）
  //    此处仅保留带触感反馈与二次确认的 UI 包装层

  const handleDeleteHistory = (id) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    deleteHistory(id);
  };

  const handleClearHistory = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('清空历史记录', '确定要删除全部浏览历史吗？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => clearHistory(),
      },
    ]);
  };

  // 🕘 点击历史记录：仅让 WebView 加载网页 + 关闭菜单。
  //    ⚠️ 严禁调用 handleLaunchCinema / emitCommand / useCinema.loadUrl，
  //       否则会把网页 URL 塞进影院播放器并唤起 FloatingPlayer 浮层。
  const handleLoadHistory = (url) => {
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该历史链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // 1️⃣ 关闭历史菜单（先播收起动画，动画结束再卸载 Modal）
    closeMenu();
    // 2️⃣ 仅更新 WebView 的 source，不触碰影院播放器
    setInputUrl(url);
    setCurrentUrl(url);
    actualLoadedUrl.current = url;
  };

  // 🧩 注入脚本装配（阶段 1 抽离至 src/scripts/browser）
  //    isDesktopMode 变化时才重建，行为与原内联模板字符串一致
  const runBeforeLoad = useMemo(
    () => buildBeforeLoadScript({ isDesktopMode }),
    [isDesktopMode]
  );

  // 👁️ 实时 DOM 监视器：MutationObserver 秒级销毁动态插入的广告元素
  //    ⚠️ 安全红线：命中保护名单（video / audio / 含 video 的容器）一律跳过
  // 🧩 注入脚本（阶段 1 抽离至 src/scripts/browser，原样引用）
  //    manualSniffScript 已随嗅探逻辑迁移至 useBrowserSniffer（阶段 3）
  const adDomWatcherScript = AD_DOM_WATCHER_SCRIPT;
  const adCleanupScript = useMemo(() => buildAdCleanupScript(), []);

  // 📨 WebView 消息分流（阶段 3）
  //    AD_BLOCKED 属于广告拦截域，留在编排层处理；
  //    其余嗅探协议（VIDEO_FOUND / VIDEO_FOUND_LIST / MANUAL_SNIFF_DONE）交由 useBrowserSniffer
  const onMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      // 🛡️ 网页内拦截上报（覆盖层 / 广告 iframe / 跳转劫持）
      if (data.type === 'AD_BLOCKED') {
        const n = typeof data.count === 'number' && data.count > 0 ? data.count : 1;
        bumpBlockedAdCount(n);
        return;
      }
    } catch (_) {
      return;
    }
    handleWebMessage(event);
  };

  // 🔙 统一返回入口：网页内还有历史 → 先回退网页；已到首页 → 退出浏览器
  const handleGoBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
      return;
    }
    router.back();
  };

  const handleClose = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.back(); };

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
  }, []);

  // 🍎 iOS 原生 Stack 右滑手势与 WKWebView 内部前进/后退手势解耦：
  //    网页内可回退时禁用原生 Stack 手势，避免抢占网页内部右滑；
  //    已到首页时恢复原生手势，允许右滑退出浏览器。
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    navigation.setOptions({ gestureEnabled: !canGoBack });
  }, [canGoBack, navigation]);
  
  const handleSubmitUrl = () => {
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
      loadUrl(target); emitCommand('PLAY', 0, target);
      if (Platform.OS === 'ios') {
        if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
        submitTimerRef.current = setTimeout(() => {
          submitTimerRef.current = null;
          router.replace('/cinema');
        }, 150);
      } else {
        router.replace('/cinema');
      }
      return;
    }

    // 非 http(s) 输入走 Bing 搜索
    if (!/^https:\/\//i.test(target)) {
      target = 'https://cn.bing.com/search?q=' + encodeURIComponent(target);
    }
    setCurrentUrl(target);
    actualLoadedUrl.current = target;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  };

  // ▶ 启动影院：支持传入指定片源 URL（默认取列表首项）
  const handleLaunchCinema = (url) => {
    const target = typeof url === 'string' && url ? url : sniffedMediaList[0]?.url;
    if (!target) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Keyboard.dismiss();
    closePicker();
    loadUrl(target);
    if (Platform.OS === 'ios') {
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
      launchTimerRef.current = setTimeout(() => {
        launchTimerRef.current = null;
        router.replace('/cinema');
      }, 150);
    } else {
      router.replace('/cinema');
    }
  };

  // 📋 复制片源链接
  const handleCopyMediaUrl = async (url) => {
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (_) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // 🧹 清空嗅探列表（数据操作在 Hook 内，这里只负责关闭弹窗）
  const handleClearSniffedMedia = () => {
    clearSniffedMedia();
    closePicker();
  };

  // 🎬 打开 / 关闭多资源选择弹窗（默认半屏）
  //    允许空列表打开：扫描中/无结果时也要能看到菜单与空态提示
  const openPicker = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pickerExpandedRef.current = false;
    setPickerExpanded(false);
    setPickerVisible(true);
    Animated.timing(pickerAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  };

  const closePicker = () => {
    Animated.timing(pickerAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setPickerVisible(false);
        pickerExpandedRef.current = false;
        setPickerExpanded(false);
      }
    });
  };

  // 📐 展开 / 收起嗅探弹窗（半屏 50% ⇄ 全屏 92%）
  const setPickerExpandedState = (expanded) => {
    if (pickerExpandedRef.current === expanded) return;
    pickerExpandedRef.current = expanded;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPickerExpanded(expanded);
  };

  const togglePickerExpanded = () => setPickerExpandedState(!pickerExpandedRef.current);

  // 🖐️ 顶部拖拽条手势已随弹窗迁移至 SniffedMediaModal（阶段 4）
  //    该组件内部用 useMemo 惰性创建 PanResponder，彻底消除 refs-during-render 告警

  // 🗑️ 移除单条嗅探源（卡片横滑触发，逻辑在 Hook 内）
  const handleRemoveSniffedMedia = (id) => {
    removeMediaItem(id);
  };

  // 🔍 触发网页内手动嗅探（注入脚本 + 2s 兜底复位，逻辑在 Hook 内）
  const handleManualSniff = () => {
    triggerManualSniff(webViewRef);
  };

  // 🔍 嗅探按钮：有源直接开菜单；无源先深度扫描，再打开菜单展示结果
  const handleSniffPress = () => {
    if (sniffedMediaList.length > 0) {
      openPicker();
      return;
    }
    handleManualSniff();
    openPicker();
  };

  const toggleDesktopMode = () => {
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
        webViewRef.current.injectJavaScript('window.location.replace(' + JSON.stringify(deskUrl) + '); true;');
      } else {
        webViewRef.current.reload();
      }
    }
  };

  // 🏷️ 书签收藏的持久化已迁移至 useBrowserHistory（阶段 2）
  //    此处仅保留触感反馈与提示弹窗的 UI 包装层
  const handleSaveBookmark = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const targetUrl = actualLoadedUrl.current;
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

    const result = await toggleBookmark(targetUrl);
    if (!result.ok) {
      Alert.alert('无法收藏', '仅支持收藏 HTTPS 安全链接。');
      closeMenu();
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('收藏成功', '已添加到影院书签列表');
    closeMenu();
  };

  const handleDeleteBookmark = async (urlToDelete) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    await removeBookmark(urlToDelete);
  };

  const handleLoadBookmark = (url) => {
    // 🔒 加载前二次校验，防止历史遗留的不安全书签被打开
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该收藏链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputUrl(url); setCurrentUrl(url); actualLoadedUrl.current = url;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    closeMenu();
  };

  // 📊 顶部加载进度条：progress(0~1) 驱动宽度，加载完成后淡出
  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  // 🛡️ 网络级拦截入口：安全协议校验 + 广告域名黑名单
  const handleShouldStartLoad = (req) => {
    const url = req && req.url;
    // 1️⃣ 安全协议校验（https / about）
    if (!isSafeUrl(url)) return false;
    // 2️⃣ 广告域名黑名单（仅开关开启时生效）
    if (isAdBlockEnabledRef.current && isAdUrl(url)) {
      bumpBlockedAdCount(1);
      return false;
    }
    return true;
  };

  // 🛡️ 切换广告拦截开关：关闭时立即移除已注入的隐藏样式，恢复页面原貌
  const toggleAdBlock = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const next = !isAdBlockEnabled;
    setIsAdBlockEnabled(next);
    isAdBlockEnabledRef.current = next;
    if (!next && webViewRef.current) {
      webViewRef.current.injectJavaScript(REMOVE_AD_STYLE_SCRIPT);
    }
  };

  const handleLoadStart = () => {
    progressAnim.setValue(0);
    progressOpacity.setValue(1);
  };

  const handleLoadProgress = ({ nativeEvent }) => {
    const p = typeof nativeEvent.progress === 'number' ? nativeEvent.progress : 0;
    progressOpacity.setValue(1);
    Animated.timing(progressAnim, {
      toValue: p,
      duration: 180,
      useNativeDriver: false,
    }).start();
  };

  const handleLoadEnd = ({ nativeEvent }) => {
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: 120,
      useNativeDriver: false,
    }).start(() => {
      Animated.timing(progressOpacity, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }).start();
    });

    // 🧹 页面加载完成后注入 DOM 级广告清理（开关开启时才执行）
    if (isAdBlockEnabledRef.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(adCleanupScript);
    }

    // 🕘 页面加载完成即写入历史（isSafeUrl 校验 + 去重 + 100 条上限）
    const loadedUrl = nativeEvent?.url || actualLoadedUrl.current;
    if (loadedUrl) addHistory(loadedUrl, nativeEvent?.title);
  };

  // 🎚️ 嗅探弹窗筛选的计数（formatCounts）与过滤列表（filteredMediaList）
  //    以及 FILTER_OPTIONS 均已迁移至 useBrowserSniffer（阶段 3）

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
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}><Text style={[styles.closeText, { color: palette.primary }]}>取消</Text></TouchableOpacity>
      </View>
      
      <View style={styles.webContainer}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.progressBarTrack,
            { opacity: progressOpacity, backgroundColor: palette.separator },
          ]}
        >
          <Animated.View style={[styles.progressBarFill, { width: progressWidth }]} />
        </Animated.View>
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          
          originWhitelist={['https://*', 'about:*']}
          javaScriptEnabled={true}
          setSupportMultipleWindows={false}
          
          contentMode={isDesktopMode ? 'desktop' : 'mobile'}
          allowsBackForwardNavigationGestures={true}
          injectedJavaScriptBeforeContentLoaded={runBeforeLoad}
          injectedJavaScript={adDomWatcherScript}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={handleShouldStartLoad}

          // 🔄 原生下拉刷新 + iOS 弹性滑动
          pullToRefreshEnabled={true}
          bounces={true}
          onNavigationStateChange={(navState) => {
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
          }}
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
        <TouchableOpacity style={styles.bottomBtn} onPress={handleGoBack}><Ionicons name="chevron-back" size={26} color={canGoBack ? palette.primary : palette.textSecondary} /></TouchableOpacity>
        <TouchableOpacity style={styles.bottomBtn} onPress={() => webViewRef.current?.goForward()} disabled={!canGoForward}><Ionicons name="chevron-forward" size={26} color={canGoForward ? palette.primary : palette.separator} /></TouchableOpacity>
        
        <TouchableOpacity style={styles.bottomBtn} onPress={handleSniffPress}>
          <Ionicons name={isSniffing ? "scan" : "scan-outline"} size={24} color={isSniffing ? palette.primary : palette.success} />
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

      {/* 🗂️ 浏览器主菜单（阶段 4 抽离至 BrowserMenuModal） */}
      <BrowserMenuModal
        visible={menuVisible}
        onRequestClose={closeMenu}
        isDark={isDark}
        palette={palette}
        menuAnim={menuAnim}
        isDesktopMode={isDesktopMode}
        onToggleDesktopMode={toggleDesktopMode}
        onSaveBookmark={handleSaveBookmark}
        onReload={() => { closeMenu(); webViewRef.current?.reload(); }}
        isAdBlockEnabled={isAdBlockEnabled}
        blockedAdCount={blockedAdCount}
        onToggleAdBlock={toggleAdBlock}
        menuTab={menuTab}
        onMenuTabChange={setMenuTab}
        bookmarksList={bookmarksList}
        onLoadBookmark={handleLoadBookmark}
        onDeleteBookmark={handleDeleteBookmark}
        historyList={historyList}
        onLoadHistory={handleLoadHistory}
        onDeleteHistory={handleDeleteHistory}
        onClearHistory={handleClearHistory}
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
        onRemove={handleRemoveSniffedMedia}
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
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 50, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
  bottomBtn: { padding: 8 },
  // 🔢 嗅探按钮角标（静默提示数量，不挡屏）
  sniffBadge: { position: 'absolute', top: 2, right: 0, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, backgroundColor: '#FF2D55', alignItems: 'center', justifyContent: 'center' },
  sniffBadgeText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
});
// --- END OF FILE src/app/browser.js ---