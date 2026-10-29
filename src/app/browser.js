// --- START OF FILE src/app/browser.js ---
import React, { useRef, useState, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, TextInput, useColorScheme, ActivityIndicator, Keyboard, Platform, LayoutAnimation, UIManager, Modal, FlatList, Alert, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context'; 
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router'; 
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getPalette } from '../constants/colors';
import { useCinema } from '../hooks/useCinema';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

export default function BrowserScreen() {
  const isDark = useColorScheme() === 'dark';
  const palette = getPalette(isDark);
  const router = useRouter();
  const params = useLocalSearchParams();
  const { loadUrl, emitCommand } = useCinema(); 
  
  const startUrl = params.targetUrl || 'https://nnyy.in/'; 
  
  const webViewRef = useRef(null);
  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [inputUrl, setInputUrl] = useState(startUrl); 
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(true);
  const [capturedUrl, setCapturedUrl] = useState(null);
  const [isSniffing, setIsSniffing] = useState(false);

  const [isDesktopMode, setIsDesktopMode] = useState(false);
  const [savedUrls, setSavedUrls] = useState([]);

  const [menuVisible, setMenuVisible] = useState(false);
  const menuAnim = useRef(new Animated.Value(0)).current;

  const actualLoadedUrl = useRef(startUrl);

  const openMenu = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMenuVisible(true);
    Animated.timing(menuAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  };

  const closeMenu = () => {
    Animated.timing(menuAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => setMenuVisible(false));
  };

  useEffect(() => {
    const loadBookmarks = async () => {
      try {
        const cached = await AsyncStorage.getItem('@browser_bookmarks');
        if (cached !== null) {
          setSavedUrls(JSON.parse(cached));
        } else {
          const defaultBookmarks = ['https://nnyy.in/'];
          setSavedUrls(defaultBookmarks);
          await AsyncStorage.setItem('@browser_bookmarks', JSON.stringify(defaultBookmarks));
        }
      } catch (e) {}
    };
    loadBookmarks();
  }, []);

  const runBeforeLoad = `
    window.open = function() { return null; }; 
    window.alert = function() { return null; }; 
    window.confirm = function() { return null; }; 
    
    (function() {
      if (window.__safe_sniffer_installed) return;
      window.__safe_sniffer_installed = true;

      window.__sniffed_urls = window.__sniffed_urls || new Set();

      var videoRegex = /\\.(m3u8|mp4|flv|mkv|mov)(\\?|$)/i;
      
      var getAbsoluteUrl = function(url) {
        try { return new URL(url, window.location.href).href; } catch(e) { return url; }
      };
      
      var recordSilent = function(url) {
        if (!url || typeof url !== 'string') return;
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        
        if (videoRegex.test(url)) {
          window.__sniffed_urls.add(getAbsoluteUrl(url));
        }
      };

      var origOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(method, url) {
        recordSilent(url);
        return origOpen.apply(this, arguments);
      };

      var origFetch = window.fetch;
      window.fetch = function() {
        var arg = arguments[0];
        var url = '';
        if (typeof arg === 'string') url = arg;
        else if (arg && arg.url) url = arg.url;
        recordSilent(url);
        return origFetch.apply(this, arguments);
      };

      var origSrcDesc = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'src');
      if (origSrcDesc && origSrcDesc.set) {
        Object.defineProperty(window.HTMLMediaElement.prototype, 'src', {
          get: origSrcDesc.get,
          set: function(val) {
            recordSilent(val);
            return origSrcDesc.set.call(this, val);
          }
        });
      }
    })();

    ${isDesktopMode ? `
      Object.defineProperty(window, 'innerWidth', { get: function() { return 1024; } });
      Object.defineProperty(window, 'outerWidth', { get: function() { return 1024; } });
      var meta = document.querySelector('meta[name="viewport"]');
      if (meta) { 
        meta.content = 'width=1024, initial-scale=1.0, maximum-scale=2.0'; 
      } else {
        meta = document.createElement('meta');
        meta.name = 'viewport';
        meta.content = 'width=1024, initial-scale=1.0, maximum-scale=2.0';
        document.head.appendChild(meta);
      }
    ` : ''}
    true;
  `;

  const manualSniffScript = `
    (function() {
      var found = false;
      var getAbsUrl = function(url) {
        try { return new URL(url, window.location.href).href; } catch(e) { return url; }
      };

      var checkAndSend = function(src) {
        if (found) return;
        if (src && !src.startsWith('blob:') && src.startsWith('http') && /\\.(m3u8|mp4|flv|mkv|mov)(\\?|$)/i.test(src)) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'VIDEO_FOUND', url: getAbsUrl(src) }));
          found = true;
        }
      };

      if (window.__sniffed_urls && window.__sniffed_urls.size > 0) {
        window.__sniffed_urls.forEach(function(url) {
          checkAndSend(url);
        });
      }
      
      if (!found) {
        var videos = document.querySelectorAll('video, source');
        for (var i = 0; i < videos.length; i++) {
          checkAndSend(videos[i].src || videos[i].getAttribute('src') || videos[i].getAttribute('data-src'));
        }
      }
      
      if (!found) {
        var htmlContent = document.documentElement.innerHTML;
        var videoRegex = /(https?:\\/\\/[^"\\'\\s]+\\.(m3u8|mp4)[^"\\'\\s]*)/gi;
        var match;
        while ((match = videoRegex.exec(htmlContent)) !== null) {
          checkAndSend(match[0]);
          if (found) break;
        }
      }

      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'MANUAL_SNIFF_DONE', found: found }));
    })();
    true;
  `;

  const onMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'VIDEO_FOUND' && data.url) {
        if (capturedUrl !== data.url) {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setCapturedUrl(data.url);
          setIsSniffing(false); 
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } else if (data.type === 'MANUAL_SNIFF_DONE') {
        setIsSniffing(false);
        if (!data.found && !capturedUrl) {
          Alert.alert('嗅探反馈', '未发现真实的视频地址。\n\n💡 提示：如果网页中出现了视频，请先点击一下网页里的“播放”按钮缓冲一秒钟，然后再点底部扫描图标！');
        }
      }
    } catch (e) {}
  };

  const handleClose = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.back(); };
  
  const handleSubmitUrl = () => {
    Keyboard.dismiss();
    let target = inputUrl.trim();
    if (!target) return;

    const isDirectVideo = /\.(mp4|m3u8)(\?.*)?$/i.test(target);
    if (isDirectVideo) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      loadUrl(target); emitCommand('PLAY', 0, target);
      if (Platform.OS === 'ios') setTimeout(() => { router.replace('/cinema'); }, 150); else router.replace('/cinema');
      return; 
    }

    if (!target.startsWith('http')) target = 'https://cn.bing.com/search?q=' + encodeURIComponent(target);
    setCurrentUrl(target);
    actualLoadedUrl.current = target; 
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCapturedUrl(null); 
  };

  const handleLaunchCinema = () => {
    if (!capturedUrl) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Keyboard.dismiss();
    loadUrl(capturedUrl); 
    if (Platform.OS === 'ios') setTimeout(() => { router.replace('/cinema'); }, 150);
    else router.replace('/cinema');
  };

  const handleManualSniff = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setIsSniffing(true);
    if (webViewRef.current) webViewRef.current.injectJavaScript(manualSniffScript);
    setTimeout(() => setIsSniffing(false), 2000); 
  };

  const toggleDesktopMode = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const nextMode = !isDesktopMode;
    closeMenu();

    const targetUrl = actualLoadedUrl.current;
    let deskUrl = targetUrl;
    
    if (nextMode) deskUrl = targetUrl.replace('://m.', '://www.').replace('://wap.', '://www.');
    else deskUrl = targetUrl.replace('://www.', '://m.');

    if (deskUrl !== targetUrl) {
      setCurrentUrl(deskUrl);
      setInputUrl(deskUrl);
      actualLoadedUrl.current = deskUrl;
    }
    
    setIsDesktopMode(nextMode);
  };

  const handleSaveBookmark = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const targetUrl = actualLoadedUrl.current;
    if (!targetUrl.startsWith('http')) return;
    
    if (savedUrls.includes(targetUrl)) { Alert.alert('提示', '该网址已在收藏夹中'); closeMenu(); return; }
    const newUrls = [targetUrl, ...savedUrls];
    setSavedUrls(newUrls);
    await AsyncStorage.setItem('@browser_bookmarks', JSON.stringify(newUrls));
    
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('收藏成功', '已添加到影院书签列表');
    closeMenu();
  };

  const handleDeleteBookmark = async (urlToDelete) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const newUrls = savedUrls.filter(url => url !== urlToDelete);
    setSavedUrls(newUrls);
    await AsyncStorage.setItem('@browser_bookmarks', JSON.stringify(newUrls));
  };

  const handleLoadBookmark = (url) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputUrl(url); setCurrentUrl(url); actualLoadedUrl.current = url;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCapturedUrl(null); closeMenu();
  };

  const overlayOpacity = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const menuTranslateY = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [400, 0] });

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
        {loading && <View style={[styles.loadingOverlay, { backgroundColor: palette.background }]}><ActivityIndicator size="large" color={palette.primary} /></View>}
        <WebView 
          ref={webViewRef} 
          key={isDesktopMode ? 'desktop' : 'mobile'} 
          source={{ uri: currentUrl }} 
          style={styles.webview} 
          
          originWhitelist={['*']}
          javaScriptEnabled={true}
          setSupportMultipleWindows={false}
          
          contentMode={isDesktopMode ? 'desktop' : 'mobile'} 

          injectedJavaScriptBeforeContentLoaded={runBeforeLoad} 
          onMessage={onMessage} 
          onShouldStartLoadWithRequest={(req) => req.url.startsWith('http') || req.url.startsWith('about:')} 
          onNavigationStateChange={(navState) => { 
            setCanGoBack(navState.canGoBack); 
            setCanGoForward(navState.canGoForward); 
            actualLoadedUrl.current = navState.url;
            if (navState.url.startsWith('http') && navState.url !== inputUrl && !navState.url.includes('cn.bing.com')) { 
              setInputUrl(navState.url); 
              if (capturedUrl) setCapturedUrl(null);
            } 
          }} 
          onLoadEnd={() => setLoading(false)} 
          allowsInlineMediaPlayback={true} 
          mediaPlaybackRequiresUserAction={false} 
          
          scalesPageToFit={isDesktopMode}
          setBuiltInZoomControls={isDesktopMode}
          userAgent={isDesktopMode ? DESKTOP_USER_AGENT : MOBILE_USER_AGENT} 
        />
        
        {capturedUrl && (
          <View style={styles.floatingActionWrapper}>
            <TouchableOpacity onPress={handleLaunchCinema} activeOpacity={0.8}>
              <BlurView tint={isDark ? "dark" : "light"} intensity={85} style={[styles.floatingActionBox, { borderColor: palette.cardBorder }]}>
                <View style={[styles.floatingActionIcon, { backgroundColor: palette.separator }]}><Ionicons name="film" size={20} color={palette.textPrimary} /></View>
                <View style={styles.floatingTextGroup}><Text style={[styles.floatingTitle, { color: palette.textPrimary }]}>已捕获超清片源</Text><Text style={[styles.floatingSub, { color: palette.textSecondary }]}>点击进入影院并同步</Text></View>
                <Ionicons name="arrow-forward-circle" size={36} color={palette.primary} />
              </BlurView>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={[styles.bottomBar, { backgroundColor: palette.background, borderTopColor: palette.separator }]}>
        <TouchableOpacity style={styles.bottomBtn} onPress={() => webViewRef.current?.goBack()} disabled={!canGoBack}><Ionicons name="chevron-back" size={26} color={canGoBack ? palette.primary : palette.separator} /></TouchableOpacity>
        <TouchableOpacity style={styles.bottomBtn} onPress={() => webViewRef.current?.goForward()} disabled={!canGoForward}><Ionicons name="chevron-forward" size={26} color={canGoForward ? palette.primary : palette.separator} /></TouchableOpacity>
        
        <TouchableOpacity style={styles.bottomBtn} onPress={handleManualSniff}>
          <Ionicons name={isSniffing ? "scan" : "scan-outline"} size={24} color={isSniffing ? palette.primary : palette.success} />
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.bottomBtn} onPress={openMenu}>
          <Ionicons name="menu" size={28} color={palette.textPrimary} />
        </TouchableOpacity>
      </View>

      <Modal visible={menuVisible} transparent animationType="none" onRequestClose={closeMenu}>
        <View style={styles.modalWrapper}>
          <Animated.View style={[styles.modalOverlay, { opacity: overlayOpacity }]} />
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeMenu} activeOpacity={1} />
          
          <Animated.View style={[styles.menuContainer, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', transform: [{ translateY: menuTranslateY }] }]}>
            <View style={styles.menuDragHandle} />
            <Text style={[styles.menuSectionTitle, { color: palette.textSecondary }]}>浏览器选项</Text>
            
            <View style={styles.menuActionRow}>
              <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={toggleDesktopMode} activeOpacity={0.7}>
                <Ionicons name={isDesktopMode ? "phone-portrait" : "desktop"} size={24} color={palette.primary} />
                <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>{isDesktopMode ? '切回手机' : '电脑版'}</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={handleSaveBookmark} activeOpacity={0.7}>
                <Ionicons name="bookmark" size={24} color={palette.success} />
                <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>收藏本页</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={() => { closeMenu(); webViewRef.current?.reload(); }} activeOpacity={0.7}>
                <Ionicons name="refresh" size={24} color={palette.textSecondary} />
                <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>刷新</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.menuSectionTitle, { color: palette.textSecondary, marginTop: 16 }]}>影院书签</Text>
            
            <FlatList
              data={savedUrls}
              keyExtractor={(item, index) => index.toString()}
              style={styles.bookmarkList}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => (
                <View style={[styles.bookmarkItem, { borderBottomColor: palette.separator }]}>
                  <TouchableOpacity style={styles.bookmarkContent} onPress={() => handleLoadBookmark(item)}>
                    <Ionicons name="globe-outline" size={20} color={palette.textSecondary} style={{ marginRight: 12 }} />
                    <Text style={[styles.bookmarkText, { color: palette.textPrimary }]} numberOfLines={1}>{item}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.bookmarkDeleteBtn} onPress={() => handleDeleteBookmark(item)}>
                    <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                  </TouchableOpacity>
                </View>
              )}
            />
          </Animated.View>
        </View>
      </Modal>

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
  loadingOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', zIndex: 10 }, 
  floatingActionWrapper: { position: 'absolute', bottom: 20, left: 16, right: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.25, shadowRadius: 16, elevation: 10 }, 
  floatingActionBox: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 24, overflow: 'hidden', borderWidth: 1 }, 
  floatingActionIcon: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' }, 
  floatingTextGroup: { flex: 1, marginLeft: 12 }, 
  floatingTitle: { fontSize: 16, fontWeight: '600' }, 
  floatingSub: { fontSize: 12, marginTop: 2 }, 
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 50, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth }, 
  bottomBtn: { padding: 8 },
  
  modalWrapper: { flex: 1, justifyContent: 'flex-end' },
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.1)' },
  menuContainer: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 12, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 20 },
  menuDragHandle: { width: 40, height: 5, backgroundColor: 'rgba(150,150,150,0.3)', borderRadius: 3, alignSelf: 'center', marginBottom: 16 },
  menuSectionTitle: { fontSize: 13, fontWeight: '600', marginBottom: 12, marginLeft: 4 },
  menuActionRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, 
  menuActionBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, borderRadius: 16 },
  menuActionText: { fontSize: 12, fontWeight: '500', marginTop: 8 },
  bookmarkList: { marginTop: 8, maxHeight: 250 },
  bookmarkItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  bookmarkContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  bookmarkText: { fontSize: 15, flex: 1 },
  bookmarkDeleteBtn: { padding: 8, marginLeft: 8 }
});
// --- END OF FILE src/app/browser.js ---