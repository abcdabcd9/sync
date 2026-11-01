// --- START OF FILE src/app/browser/index.js ---
import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, TextInput, Keyboard, Platform, LayoutAnimation, UIManager, Alert, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useAppTheme } from '../../context/ThemeContext';
import { useCinema } from '../../hooks/useCinema';

// 🧩 领域 Hook（阶段 2~5 抽离）
import { useBrowserHistory } from '../../hooks/browser/useBrowserHistory';
import { useBrowserSniffer } from '../../hooks/browser/useBrowserSniffer';
import { useAdBlocker } from '../../hooks/browser/useAdBlocker';
import { useBrowserProgress } from '../../hooks/browser/useBrowserProgress';
import { useBrowserNavigation } from '../../hooks/browser/useBrowserNavigation';

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
  const params = useLocalSearchParams();
  const { loadUrl, emitCommand } = useCinema();

  const startUrl = params.targetUrl || 'https://www.bing.com';
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
  const {
    historyList, addHistory,
    bookmarksList, toggleBookmark, isBookmarked,
  } = useBrowserHistory();

  // 🎬 视频嗅探核心（阶段 3）
  //    🔇 静默嗅探：未命中时零反馈；命中时由 onMediaFound 自动弹出选择播放源窗口
  //    ⚠️ openPicker 定义在下方，此处用 ref 转发，避免 Hook 调用顺序 / 依赖问题
  const openPickerRef = useRef(null);
  const handleMediaFound = useCallback(() => {
    openPickerRef.current?.();
  }, []);
  const {
    sniffedMediaList, filterFormat, setFilterFormat, isSniffing,
    filteredMediaList, formatCounts, handleWebMessage,
    removeMediaItem, clearSniffedMedia, triggerManualSniff,
  } = useBrowserSniffer({ onMediaFound: handleMediaFound });

  // 🛡️ 广告拦截域（阶段 5）
  const {
    isAdBlockEnabled, blockedAdCount, bumpBlockedAdCount,
    handleShouldStartLoad, runAdCleanup, toggleAdBlock,
  } = useAdBlocker(webViewRef);

  // 🧭 导航域（阶段 5）
  const {
    currentUrl, inputUrl, setInputUrl, canGoBack, canGoForward,
    isDesktopMode, actualLoadedUrl,
    handleSubmitUrl, handleGoBack, handleGoForward, handleClose,
    toggleDesktopMode, handleNavigationStateChange, goCinema,
  } = useBrowserNavigation({ startUrl, webViewRef, loadUrl, emitCommand, addHistory, closeMenu });

  // 📊 加载进度条（阶段 5）：加载完成后注入广告清理 + 写入历史
  //    ⚠️ 回调内读取 actualLoadedUrl.current，故不放入依赖数组（ref 引用恒定）
  const handleLoadFinish = useCallback(
    ({ nativeEvent }) => {
      runAdCleanup();
      const loadedUrl = nativeEvent?.url || actualLoadedUrl.current;
      if (loadedUrl) addHistory(loadedUrl, nativeEvent?.title);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- actualLoadedUrl 为 ref，引用恒定
    [runAdCleanup, addHistory]
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
  const handleLaunchCinema = useCallback(
    (url) => {
      const target = typeof url === 'string' && url ? url : sniffedMediaList[0]?.url;
      if (!target) return;
      haptic.heavy();
      Keyboard.dismiss();
      closePicker();
      loadUrl(target);
      goCinema();
    },
    [sniffedMediaList, closePicker, loadUrl, goCinema]
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

  const handleSaveBookmark = useCallback(async () => {
    haptic.light();
    // ⚠️ ref 引用恒定，不放入依赖数组
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
    haptic.success();
    Alert.alert('收藏成功', '已添加到影院书签列表');
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
        onOpenBookmarks={handleOpenBookmarks}
        onOpenHistory={handleOpenHistory}
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
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 50, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
  bottomBtn: { padding: 8 },
  // 🔢 嗅探按钮角标（静默提示数量，不挡屏）
  sniffBadge: { position: 'absolute', top: 2, right: 0, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, backgroundColor: '#FF2D55', alignItems: 'center', justifyContent: 'center' },
  sniffBadgeText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
});
// --- END OF FILE src/app/browser/index.js ---
