// --- START OF FILE src/app/cinema.js ---
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, useWindowDimensions, PanResponder, Animated, TextInput, KeyboardAvoidingView, Keyboard, TouchableWithoutFeedback, Dimensions, StatusBar, BackHandler } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import { BlurView } from 'expo-blur';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { VideoView } from 'expo-video';
import * as Brightness from 'expo-brightness';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useAppTheme } from '../context/ThemeContext';
import { useCinema } from '../hooks/useCinema';
import { useAuth } from '../hooks/useAuth';
import EpisodeDrawer from '../components/cinema/EpisodeDrawer';
import HiddenSnifferWebView from '../components/cinema/HiddenSnifferWebView';

const IS_ANDROID = Platform.OS === 'android';

const DanmakuItem = React.memo(({ text, color, screenWidth }) => {
  const translateX = useRef(new Animated.Value(screenWidth)).current;
  const [top] = useState(() => Math.random() * (Dimensions.get('window').height * 0.15) + 10); 

  useEffect(() => {
    Animated.timing(translateX, { toValue: -screenWidth, duration: 6000 + Math.random() * 2000, useNativeDriver: true }).start();
  }, [screenWidth]);

  return (
    <Animated.View style={[{ position: 'absolute', top, transform: [{ translateX }] }]} pointerEvents="none">
      <Text style={[styles.danmakuText, { color, textShadowColor: 'rgba(0,0,0,0.85)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3 }]}>{text}</Text>
    </Animated.View>
  );
});

export default function CinemaScreen() {
  const { isDark, colors: palette } = useAppTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const { user } = useAuth();
  
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions(); 
  const insets = useSafeAreaInsets();
  
  const {
    player, partnerStatus, emitCommand, setIsMinimized, cinemaRoomId, setCinemaRoomId, danmakuList, emitDanmaku,
    loadUrl, currentUrl,
    // 📺 选集
    episodeList, currentEpisodeIndex, episodeSwitchRequest, requestEpisode, applyEpisodeList,
    episodeListRequest,
  } = useCinema();

  // 🍎 P2-15 修复：房间号使用 useState 惰性初始化，仅在组件首次挂载时生成一次。
  //    旧实现把 roomId 放在 useEffect 里用 Date.now() 生成，任何重渲染/依赖变化
  //    都会重新生成新房间号，导致用户被踢出原房间（异常掉线）。
  //    现在整个组件生命周期内 roomId 绝对唯一且不变。
  // 🍎 补充修复：组件被重新挂载（如从悬浮窗最大化回到影院）时，优先复用上下文中
  //    已存在的 cinemaRoomId，避免生成新房间号 → 重建 Supabase Channel → 触发
  //    partnerStatus 变化 → 广播 PLAY 指令 → 播放器 replaceAsync 导致视频从头开始。
  const [roomId] = useState(() => cinemaRoomId || Crypto.randomUUID());
  const [activeRoomId, setActiveRoomId] = useState(null);

  const [isImmersive, setIsImmersive] = useState(false);

  // 🧰 全屏顶栏「更多工具」工具栏：点击 ⋯ 向左滑出，包含「返回浏览器」等换片入口
  const [toolbarVisible, setToolbarVisible] = useState(false);
  // 🧰 工具栏展开态镜像：供 showUI / hideUI 等非渲染路径同步读取，避免闭包过期
  const toolbarVisibleRef = useRef(false);
  const toolbarAnim = useRef(new Animated.Value(0)).current;

  // 📺 选集悬浮窗开关
  const [showEpisodeDrawer, setShowEpisodeDrawer] = useState(false);
  
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsVisibleRef = useRef(true); 
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const hideTimer = useRef(null);
  
  const [progress, setProgress] = useState(0);
  const progressRef = useRef(0);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(player?.playing || false);

  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [indicatorText, setIndicatorText] = useState('');

  // ⏩ 2X 锁定状态：点按锁定 2 倍速，再点取消（长按仍为临时快进）
  const [speedLocked, setSpeedLocked] = useState(false);
  const speedLockedRef = useRef(false);
  // 长按判定：按住超过该时长视为「长按快进」，否则视为「点按锁定」
  const speedPressTimer = useRef(null);
  const speedLongPressRef = useRef(false);

  const initialVolume = useRef(0.5);
  const initialBrightness = useRef(0.5);
  const initialTime = useRef(0);
  const initialTrackX = useRef(0);
  const trackWidthRef = useRef(1);
  const isScrubbing = useRef(false);
  const wasPlayingRef = useRef(false); 
  const lastTapTime = useRef(0);

  const gestureLock = useRef('none');
  const lastSeekRef = useRef(0);
  const lastBrightnessTime = useRef(0); // 🍎 硬件节流专用 Ref
  // 🔊 音量节流专用 Ref：避免每帧写原生 volume 导致音频欠载 / 破音
  const lastVolumeTime = useRef(0);
  const lastVolumeValue = useRef(-1);

  useEffect(() => {
    // 优先使用邀请链接带入的 roomId；否则使用本组件惰性生成的稳定 roomId。
    // 一旦确定，不再因重渲染而改变，避免意外掉线。
    const targetRoom = params.roomId || roomId;
    if (targetRoom !== cinemaRoomId) {
      setCinemaRoomId(targetRoom);
    }
    setActiveRoomId(targetRoom);
    (async () => { await Brightness.requestPermissionsAsync(); })();
  }, [params.roomId, roomId, cinemaRoomId, setCinemaRoomId]);

  useEffect(() => {
    if (isImmersive) {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      if (IS_ANDROID) StatusBar.setHidden(true, 'fade');
    }
    // 🍎 修复：仅在组件卸载时才重置方向，避免 isImmersive 变化导致的频繁翻转闪烁
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      if (IS_ANDROID) StatusBar.setHidden(false, 'fade');
    };
  }, [isImmersive]);

  // 📱 返回拦截（分层返回）—— 安卓返回键/全面屏左右滑动 + iOS 原生右滑手势 统一语义：
  //    旧行为：全屏时直接 pop 掉 /cinema 路由 → 回到 /browser 里第一集的 /play/ 页面，
  //            用户看到「退到第一集的导航界面」，且播放器被销毁。
  //    新行为（与页面内返回按钮语义一致）：
  //      1) 全屏播放中 → 只退出全屏（回到 2 级放映厅，不离开影院）
  //      2) 选集抽屉打开 → 只关闭抽屉
  //      3) 非全屏 → 最小化到悬浮窗，并真正退出影院路由（回到大厅/上一页）
  //    用 ref 读取最新状态，避免 effect 因状态变化反复解绑/重绑导致连按漏手势。
  const backStateRef = useRef({ isImmersive: false, showEpisodeDrawer: false });
  useEffect(() => {
    backStateRef.current = { isImmersive, showEpisodeDrawer };
  }, [isImmersive, showEpisodeDrawer]);

  // 分层返回的统一处理：返回 true 表示「已消费，不离开影院路由」
  const handleLayeredBack = useCallback(() => {
    const { isImmersive: immersive, showEpisodeDrawer: drawerOpen } = backStateRef.current;
    if (immersive) {
      // 全屏 → 退出全屏，停留在 2 级放映厅
      setIsImmersive(false);
      return true;
    }
    if (drawerOpen) {
      // 关闭抽屉并恢复播放条（直接操作状态，避免前向引用 showUI）
      setShowEpisodeDrawer(false);
      setControlsVisible(true);
      controlsVisibleRef.current = true;
      Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      return true;
    }
    // 非全屏 → 最小化到悬浮窗（保留播放进度），并真正退出影院路由回到大厅
    setIsMinimized(true);
    router.back();
    return true;
  }, [setIsMinimized, controlsOpacity, router]);

  // 🧰 工具栏展开 / 收起（向左滑出动画）
  const handleToggleToolbar = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setToolbarVisible((prev) => {
      const next = !prev;
      toolbarVisibleRef.current = next;
      Animated.timing(toolbarAnim, {
        toValue: next ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      // 🧰 展开时暂停自动隐藏（showUI 会跳过计时）；收起后恢复 5 秒自动隐藏
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (!next) hideTimer.current = setTimeout(hideUI, 5000);
      return next;
    });
  }, [toolbarAnim]);

  // 🌐 全屏顶栏「快速返回浏览器」：换片专用，与「退出」语义区分
  //    1) 最小化到悬浮窗 → 当前视频继续播放，进度不丢
  //    2) 退出全屏 → 恢复竖屏与状态栏
  //    3) 回到浏览器：影院是从浏览器 router.replace('/cinema') 进来的，
  //       栈里影院已替换掉浏览器，router.back() 会直接回到空间页（用户反馈的「回首页」）。
  //       因此这里用 replace 回到浏览器，保证一定落在浏览器页。
  //    ⚠️ 不调用 closePlayer，避免播放进度丢失
  const handleQuickBackToBrowser = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setToolbarVisible(false);
    toolbarVisibleRef.current = false;
    toolbarAnim.setValue(0);
    setIsMinimized(true);
    setIsImmersive(false);
    // 🐞 修复「点浏览器后回到空间首页，而不是浏览器页」：
    //    影院是从浏览器 router.replace('/cinema') 进来的，栈里浏览器已被替换掉，
    //    此时栈为 (tabs) → /cinema。canGoBack() 因下面还有 (tabs) 而返回 true，
    //    于是 router.back() 回到了空间页 —— 这正是用户看到的「只能回到空间首页」。
    //    改用 dismissTo('/browser')：栈中存在 /browser 时回退复用（保留网页状态），
    //    不存在时自动 replace 到 /browser，两种情况都保证落在浏览器页。
    //    极端情况下（dismissTo 不可用）兜底 replace，绝不 back() 到空间页。
    try {
      router.dismissTo('/browser');
    } catch (e) {
      router.replace('/browser');
    }
  }, [setIsMinimized, router, toolbarAnim]);

  // 🤖 安卓：系统返回键 / 全面屏左右滑动返回手势
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', handleLayeredBack);
    return () => subscription.remove();
  }, [handleLayeredBack]);

  // 🍎 iOS：原生 Stack 右滑返回手势 —— 与安卓保持完全一致的分层语义
  //    关键点：手势必须始终「可用」（gestureEnabled: true），否则全屏时用户右滑毫无反应。
  //    真正的分层拦截交给下面的 beforeRemove：全屏时 preventDefault 并退出全屏，
  //    手势回弹到原位，用户看到的就是「右滑 → 回到 2 级放映厅」。
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    navigation.setOptions({ gestureEnabled: true });
  }, [navigation]);

  // 🍎 iOS：拦截原生返回（右滑手势 / 导航栏返回），复用同一套分层逻辑
  //    注意：非全屏时页面内返回按钮已自行 setIsMinimized(true) 再 router.back()，
  //    这里只负责「手势返回」这一条路径，避免重复设置。
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      const { isImmersive: immersive, showEpisodeDrawer: drawerOpen } = backStateRef.current;
      if (immersive || drawerOpen) {
        // 全屏 / 抽屉打开：禁止离开影院路由，改为执行分层返回
        // （全屏 → 退出全屏；抽屉 → 关闭抽屉），手势自动回弹
        e.preventDefault();
        handleLayeredBack();
        return;
      }
      // 非全屏：放行离开影院，但必须先标记最小化，让悬浮窗在离开后出现
      setIsMinimized(true);
    });
    return unsubscribe;
  }, [navigation, handleLayeredBack, setIsMinimized]);

  useEffect(() => {
    let interval;
    if (player && isImmersive) {
      interval = setInterval(() => {
        if (!isScrubbing.current && gestureLock.current === 'none') {
          const cur = player.currentTime || 0;
          const dur = player.duration || 1;
          setCurrentTime(cur); 
          setDuration(dur); durationRef.current = dur;
          setProgress(cur / dur); progressRef.current = cur / dur;
          setIsPlaying(player.playing);
        }
      }, 500);
    }
    return () => clearInterval(interval);
  }, [player, isImmersive]);

  const showUI = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setControlsVisible(true); controlsVisibleRef.current = true;
    Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    // 🧰 工具栏展开时不启动自动隐藏：用户正在挑选「同步 / 浏览器」按钮，
    //    5 秒后突然整层消失会打断操作。收起工具栏后由 handleToggleToolbar 重新计时。
    if (toolbarVisibleRef.current) return;
    hideTimer.current = setTimeout(hideUI, 5000);
  };

  const hideUI = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // 🧰 隐藏控制层时同步收起工具栏，避免工具栏残留在画面上
    setToolbarVisible(false);
    toolbarVisibleRef.current = false;
    toolbarAnim.setValue(0);
    Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
      setControlsVisible(false); controlsVisibleRef.current = false;
    });
  };

  const handleTogglePlay = () => {
    if (!player) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPlaying) {
      player.pause(); setIsPlaying(false); emitCommand('PAUSE', player.currentTime);
    } else {
      player.play(); setIsPlaying(true); emitCommand('PLAY', player.currentTime);
    }
    showUI();
  };

  // ⏩ 统一设置播放速率，避免爆音：
  //    1) 值未变化时直接跳过 —— 反复写 playbackRate 会让原生音频重采样器重建，
  //       在 1.0 ↔ 2.0 之间来回跳变时产生瞬态爆音（用户反馈的「有概率爆音」）。
  //    2) preservesPitch 只在首次设置（其默认值本就是 true），不再每次赋值。
  //    3) 先设速率再 play()，避免音频管线刚启动就被改速率。
  const applyPlaybackRate = useCallback((rate) => {
    if (!player) return;
    if (player.playbackRate === rate) return;
    if (player.preservesPitch !== true) player.preservesPitch = true;
    player.playbackRate = rate;
    if (!player.playing) { player.play(); setIsPlaying(true); }
  }, [player]);

  const formatTime = (sec) => {
  // 🍎 如果是直播流（无穷大或无效），直接显示 LIVE！
  if (!isFinite(sec) || sec <= 0) return 'LIVE'; 
  
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

  const seekPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        if (!player) return;
        if (hideTimer.current) clearTimeout(hideTimer.current);
        gestureLock.current = 'horizontal'; 
        isScrubbing.current = true;
        wasPlayingRef.current = isPlaying; 
        initialTrackX.current = progressRef.current * trackWidthRef.current;
      },
      onPanResponderMove: (evt, gestureState) => {
        if (!player) return;
        let p = (initialTrackX.current + gestureState.dx) / trackWidthRef.current;
        p = Math.max(0, Math.min(1, p));
        progressRef.current = p; setProgress(p); 
        const newTime = p * durationRef.current;
        setCurrentTime(newTime);
        
        const now = Date.now();
        if (now - lastSeekRef.current > 150) {
          player.currentTime = newTime;
          lastSeekRef.current = now;
        }
      },
      onPanResponderRelease: () => {
        if (!player) return;
        gestureLock.current = 'none';
        isScrubbing.current = false;
        
        const newTime = progressRef.current * durationRef.current;
        player.currentTime = newTime; 
        emitCommand('FORCE_SYNC', newTime);
        
        setTimeout(() => {
          if (wasPlayingRef.current) {
            player.play(); setIsPlaying(true); emitCommand('PLAY', newTime);
          }
        }, 50);
        showUI();
      }
    })
  ).current;

  const screenPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        if (!player) return;
        if (hideTimer.current) clearTimeout(hideTimer.current);
        gestureLock.current = 'none';
        initialTime.current = player.currentTime;
        initialVolume.current = player.volume;
        // 🔊 手势开始时同步基准值，避免首次节流判定误跳过
        lastVolumeValue.current = player.volume;
        lastVolumeTime.current = 0;
        try { Brightness.getBrightnessAsync().then(b => initialBrightness.current = b); } catch (e) {}
      },
      onPanResponderMove: (evt, gestureState) => {
        if (!player) return;
        const { dx, dy, x0 } = gestureState;
        const w = Dimensions.get('window').width;
        const h = Dimensions.get('window').height;

        if (gestureLock.current === 'none') {
          if (Math.abs(dx) > 30 || Math.abs(dy) > 30) {
            if (Math.abs(dx) > Math.abs(dy)) {
              gestureLock.current = 'horizontal';
              wasPlayingRef.current = isPlaying;
            } else {
              gestureLock.current = x0 < w / 2 ? 'brightness' : 'volume';
            }
          } else { return; }
        }

        if (gestureLock.current === 'horizontal') {
          const deltaSec = (dx / w) * 180; 
          const newTime = Math.max(0, Math.min(initialTime.current + deltaSec, durationRef.current));
          setCurrentTime(newTime); 
          progressRef.current = newTime / durationRef.current; setProgress(progressRef.current);
          setIndicatorText(`${deltaSec > 0 ? '快进' : '快退'}至 ${formatTime(newTime)}`);
         
          const now = Date.now();
          if (now - lastSeekRef.current > 150) {
            player.currentTime = newTime;
            lastSeekRef.current = now;
          }

        } else if (gestureLock.current === 'brightness') {
          const delta = -(dy / h) * 1.5; 
          let newB = Math.max(0, Math.min(1, initialBrightness.current + delta));
          setIndicatorText(`亮度 ${Math.round(newB * 100)}%`);

          // 🍎 核心修复：对系统硬件 API 增加 150ms 节流阀，解除 Bridge 大塞车
          const now = Date.now();
          if (now - lastBrightnessTime.current > 150) {
            Brightness.setSystemBrightnessAsync(newB).catch(()=>{});
            lastBrightnessTime.current = now;
          }

        } else if (gestureLock.current === 'volume') {
          const delta = -(dy / h) * 1.5;
          let newV = Math.max(0, Math.min(1, initialVolume.current + delta));
          // 指示文字仍实时更新，保证视觉跟手
          setIndicatorText(`音量 ${Math.round(newV * 100)}%`);

          // 🍎 与亮度分支一致：150ms 节流 + 1% 量化去重
          //    每帧直接写 player.volume 会让原生音频管线反复重建 → 断续 / 破音
          const now = Date.now();
          if (now - lastVolumeTime.current > 150) {
            const quantized = Math.round(newV * 100) / 100;
            if (quantized !== lastVolumeValue.current) {
              player.volume = quantized;
              lastVolumeValue.current = quantized;
            }
            lastVolumeTime.current = now;
          }
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (!player) return;
        setIndicatorText('');

        // 🔊 松手补写最终音量：节流窗口可能吞掉最后一帧，保证音量与指示器一致
        if (gestureLock.current === 'volume') {
          const finalV = Math.round(Math.max(0, Math.min(1, player.volume)) * 100) / 100;
          if (finalV !== lastVolumeValue.current) {
            player.volume = finalV;
            lastVolumeValue.current = finalV;
          }
        }

        if (gestureLock.current === 'none') {
          if (Math.abs(gestureState.dx) < 30 && Math.abs(gestureState.dy) < 30) {
            const now = Date.now();
            if (now - lastTapTime.current < 300) { handleTogglePlay(); lastTapTime.current = 0; } 
            else { controlsVisibleRef.current ? hideUI() : showUI(); lastTapTime.current = now; }
          }
        } else if (gestureLock.current === 'horizontal') {
          player.currentTime = progressRef.current * durationRef.current;
          emitCommand('FORCE_SYNC', player.currentTime);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (wasPlayingRef.current) { player.play(); setIsPlaying(true); emitCommand('PLAY', player.currentTime); }
          showUI();
        }
        gestureLock.current = 'none';
      }
    })
  ).current;

  const handleSendDanmaku = () => {
    if (!inputText.trim()) { setShowInput(false); return; }
    emitDanmaku(inputText.trim(), '#0A84FF');
    setInputText(''); setShowInput(false); Keyboard.dismiss(); showUI();
  };

  // ============================================================
  // 📺 隐藏 WebView 嗅探：两种模式
  //    'list'  → 只抓选集列表（投屏后首次进入，不切集、不改播放）
  //    'switch'→ 抓列表 + 嗅探该集 m3u8 并切集播放
  // ============================================================
  const [snifferUrl, setSnifferUrl] = useState(null);
  const snifferUrlRef = useRef(null);
  const snifferModeRef = useRef('switch');
  // 🐞 用 state 传递 mode 给 HiddenSnifferWebView：
  //    ref 变化不触发重渲染，渲染期读 ref.current 既有时序风险也会触发 lint 告警。
  //    与 snifferUrl 同步 setState，保证 WebView 挂载时拿到的 mode 一定正确。
  const [snifferMode, setSnifferMode] = useState('switch');

  // 监听切集请求 → 启动隐藏 WebView 嗅探新集（切集模式）
  //    🐞 修复「关闭影院后重新进入，约 10 秒后自动嗅探并播放上一次的视频」：
  //       请求来自全局 CinemaProvider，影院页卸载不会清空它。若上次在抓取完成前
  //       就关闭了影院，残留请求会在下次挂载时被重新消费 → 重新挂载隐藏 WebView
  //       → 15 秒兜底嗅探命中旧 m3u8 → 自动播放旧视频。
  //       这里加两道闸：① 无当前播放源（currentUrl 为空）时一律忽略；
  //                    ② 用 nonce 记录已消费的请求，同一请求绝不重复消费。
  const consumedSwitchNonceRef = useRef(null);
  useEffect(() => {
    if (!episodeSwitchRequest || !episodeSwitchRequest.url) return;
    // ① 没有正在播放的视频 → 说明影院已被关闭，残留请求必须丢弃
    if (!currentUrl) return;
    // ② 同一 nonce 只消费一次（防止重渲染 / 重新挂载重复触发）
    if (consumedSwitchNonceRef.current === episodeSwitchRequest.nonce) return;
    consumedSwitchNonceRef.current = episodeSwitchRequest.nonce;
    snifferModeRef.current = 'switch';
    setSnifferMode('switch');
    snifferUrlRef.current = episodeSwitchRequest.url;
    setSnifferUrl(episodeSwitchRequest.url);
    // 切集后重置 2X 锁定，避免新集仍以 2 倍速播放
    speedLockedRef.current = false;
    setSpeedLocked(false);
    // 同时把播放速率复位（新源默认 1.0x），避免继承上一集的 2x
    if (player && player.playbackRate !== 1.0) player.playbackRate = 1.0;
  }, [episodeSwitchRequest, player, currentUrl]);

  // 监听首次抓取请求 → 只抓选集列表（列表模式，不切集）
  //    🐞 同上：无播放源时忽略 + nonce 去重，避免残留请求在重新进入影院时复活
  const consumedListNonceRef = useRef(null);
  useEffect(() => {
    if (!episodeListRequest || !episodeListRequest.url) return;
    if (!currentUrl) return;
    if (consumedListNonceRef.current === episodeListRequest.nonce) return;
    consumedListNonceRef.current = episodeListRequest.nonce;
    snifferModeRef.current = 'list';
    setSnifferMode('list');
    snifferUrlRef.current = episodeListRequest.url;
    setSnifferUrl(episodeListRequest.url);
  }, [episodeListRequest, currentUrl]);

  // 嗅探到 m3u8 → 直接播放（走 loadUrl，保持同步广播）
  //    ⚠️ 列表模式下忽略 m3u8，避免首次进入时误切集
  const handleSnifferMediaFound = useCallback(
    (m3u8Url) => {
      if (!m3u8Url) return;
      if (snifferModeRef.current !== 'switch') return;
      loadUrl(m3u8Url);
      // 关闭隐藏 WebView，释放资源
      setSnifferUrl(null);
      snifferUrlRef.current = null;
    },
    [loadUrl]
  );

  // 抓到选集列表 → 写入上下文
  //    列表模式：抓完即关闭隐藏 WebView（不切集）
  //    切集模式：保持挂载，继续等待该集 m3u8
  const handleSnifferEpisodeList = useCallback(
    (episodes) => {
      // 🐞 修复「iOS 选集一直显示正在获取选集…」：
      //    空列表时也必须调用 applyEpisodeList([])，它会清空「一次性」抓取请求
      //    （episodeListRequest / episodeListRequested），避免请求残留导致下次
      //    进入影院时复活。非空列表则正常写入选集上下文。
      applyEpisodeList(episodes, snifferUrlRef.current);
      if (snifferModeRef.current === 'list') {
        setSnifferUrl(null);
        snifferUrlRef.current = null;
      }
    },
    [applyEpisodeList]
  );

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>

      {/* 🕵️ 隐藏嗅探 WebView：仅在切集时挂载，1x1 透明，不影响任何原有操作 */}
      {snifferUrl ? (
        <HiddenSnifferWebView
          key={snifferUrl}
          url={snifferUrl}
          mode={snifferMode}
          onMediaFound={handleSnifferMediaFound}
          onEpisodeList={handleSnifferEpisodeList}
        />
      ) : null}
      
      {!isImmersive && (
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <View style={styles.navBar}>
            <TouchableOpacity style={styles.backBtn} onPress={() => { setIsMinimized(true); router.back(); }}>
              <Ionicons name="chevron-down" size={28} color={palette.textPrimary} />
            </TouchableOpacity>
            <View style={[styles.statusPill, { backgroundColor: partnerStatus.includes('对方') ? (isDark ? 'rgba(52,199,89,0.15)' : 'rgba(52,199,89,0.1)') : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') }]}>
              <View style={[styles.statusDot, { backgroundColor: partnerStatus.includes('对方') ? '#34C759' : palette.textSecondary }]} />
              <Text style={[styles.statusText, { color: partnerStatus.includes('对方') ? (isDark ? '#34C759' : '#248A3D') : palette.textSecondary }]}>{partnerStatus}</Text>
            </View>
            <TouchableOpacity style={styles.inviteBtn} onPress={() => router.push({ pathname: '/invite_friend', params: { roomId: activeRoomId } })}>
              <Ionicons name="paper-plane" size={24} color={palette.primary} />
            </TouchableOpacity>
          </View>

          <View style={styles.cinemaWrapper}>
            <VideoView style={styles.video} player={player} allowsFullscreen={false} nativeControls={true} contentFit="contain" />
          </View>

          <View style={styles.controlPanelWrapper}>
            <BlurView tint={isDark ? "dark" : "light"} intensity={90} style={[styles.controlPanel, { borderColor: palette.cardBorder, maxWidth: 600, alignSelf: 'center', width: '100%' }]}>
              <View style={[styles.panelHeader, { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 }]}>
                <View style={{ width: 24 }} />
                <Text style={[styles.panelTitle, { color: palette.textSecondary }]}>SharePlay 同步控制</Text>
                <TouchableOpacity onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setIsImmersive(true); showUI(); }} style={{ flexDirection: 'row', alignItems: 'center', padding: 4 }}>
                  <Ionicons name="expand" size={20} color={palette.primary} />
                </TouchableOpacity>
              </View>
              <View style={styles.btnRow}>
                <TouchableOpacity style={styles.actionBtnColumn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); player?.pause(); setIsPlaying(false); emitCommand('PAUSE', player?.currentTime || 0); }} activeOpacity={0.7}>
                  <View style={styles.iconFixedWrapper}><View style={[styles.iconCircle, { backgroundColor: palette.separator }]}><Ionicons name="pause" size={22} color={palette.textPrimary} /></View></View>
                  <Text style={[styles.btnText, { color: palette.textPrimary }]}>暂停</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtnColumn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); emitCommand('FORCE_SYNC', player?.currentTime || 0); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }} activeOpacity={0.6}>
                  <View style={styles.iconFixedWrapper}><Ionicons name="sync" size={36} color={palette.primary} /></View>
                  <Text style={[styles.syncText, { color: palette.textSecondary }]}>强制对齐</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtnColumn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); player?.play(); setIsPlaying(true); emitCommand('PLAY', player?.currentTime || 0); }} activeOpacity={0.7}>
                  <View style={styles.iconFixedWrapper}><View style={[styles.iconCircle, { backgroundColor: palette.primary }]}><Ionicons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 4 }} /></View></View>
                  <Text style={[styles.btnText, { color: palette.textPrimary }]}>播放</Text>
                </TouchableOpacity>
              </View>
            </BlurView>
          </View>
        </SafeAreaView>
      )}

      {isImmersive && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: 9999 }]}>
          
          <VideoView style={StyleSheet.absoluteFill} player={player} allowsFullscreen={false} nativeControls={false} contentFit="contain" />

          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {danmakuList.map((dm) => (
              <DanmakuItem key={dm.id} text={dm.text} color={dm.color} screenWidth={SCREEN_WIDTH} />
            ))}
          </View>

          <View style={StyleSheet.absoluteFill} {...screenPanResponder.panHandlers}>
            <View style={{ flex: 1, justifyContent: 'center' }}>
              {indicatorText !== '' && (
                <View style={styles.indicatorBox}><Text style={styles.indicatorText}>{indicatorText}</Text></View>
              )}
            </View>
          </View>

          <Animated.View style={[styles.immersiveTopBar, {
            opacity: controlsOpacity,
            paddingTop: IS_ANDROID ? 16 : Math.max(insets.top, 16),
            paddingLeft: Math.max(insets.left || 0, 32),
            paddingRight: Math.max(insets.right || 0, 32)
          }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
            {/* 左侧固定宽度容器：保证中间状态栏绝对居中 */}
            <View style={styles.immersiveTopSide}>
              <TouchableOpacity style={styles.immersiveIconBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsImmersive(false); }}>
                <Ionicons name="arrow-back" size={IS_ANDROID ? 24 : 26} color="#FFF" />
              </TouchableOpacity>
            </View>

            <View style={styles.immersiveStatusPill}>
              <View style={[styles.immersiveStatusDot, { backgroundColor: partnerStatus.includes('对方') ? '#34C759' : '#8E8E93' }]} />
              <Text style={styles.immersiveStatusText}>{partnerStatus}</Text>
            </View>

            {/* 右侧固定宽度容器：⋯ 更多工具，点击展开/收起下方工具栏（同步 + 浏览器） */}
            <View style={[styles.immersiveTopSide, styles.immersiveTopSideRight]}>
              <TouchableOpacity style={styles.immersiveIconBtn} onPress={handleToggleToolbar}>
                <Ionicons name="ellipsis-horizontal" size={IS_ANDROID ? 22 : 24} color="#FFF" />
              </TouchableOpacity>
            </View>
          </Animated.View>

          {/* 🧰 工具栏：从 ⋯ 下方向左滑出，不占用中间状态栏位置 */}
          <Animated.View
            style={[
              styles.immersiveToolbar,
              {
                // 跟随控制层一起淡出，避免隐藏 UI 后工具栏残留
                opacity: Animated.multiply(toolbarAnim, controlsOpacity),
                paddingTop: IS_ANDROID ? 16 : Math.max(insets.top, 16),
                paddingRight: Math.max(insets.right || 0, 32),
                transform: [
                  {
                    translateX: toolbarAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [24, 0],
                    }),
                  },
                ],
              },
            ]}
            pointerEvents={toolbarVisible && controlsVisible ? 'auto' : 'none'}
          >
            <TouchableOpacity
              style={styles.immersiveToolbarBtn}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); emitCommand('FORCE_SYNC', player?.currentTime || 0); }}
            >
              <Ionicons name="sync" size={IS_ANDROID ? 22 : 24} color="#34C759" />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.immersiveToolbarBtn, styles.immersiveToolbarGap]} onPress={handleQuickBackToBrowser}>
              <Ionicons name="globe-outline" size={IS_ANDROID ? 22 : 24} color="#FFF" />
            </TouchableOpacity>
          </Animated.View>

          <Animated.View style={[styles.immersiveBottomBar, { 
            opacity: controlsOpacity, 
            paddingBottom: Math.max(insets.bottom + 8, 24),
            paddingLeft: Math.max(insets.left || 0, 16),
            paddingRight: Math.max(insets.right || 0, 16)
          }]} pointerEvents={controlsVisible ? 'auto' : 'none'}>
            <BlurView intensity={80} tint="dark" style={[styles.glassDock, IS_ANDROID && { height: 50, paddingHorizontal: 12 }]}>
              
              <TouchableOpacity onPress={handleTogglePlay} style={styles.playBtn}>
                <Ionicons name={isPlaying ? "pause" : "play"} size={IS_ANDROID ? 22 : 26} color="#FFF" />
              </TouchableOpacity>
              
              <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
              
              <View style={styles.progressTrackContainer} onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width || 1; }} {...seekPanResponder.panHandlers}>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                  <View style={[styles.progressThumb, { left: `${progress * 100}%` }]} />
                </View>
              </View>
              
              <Text style={styles.timeText}>{formatTime(duration)}</Text>

              <TouchableOpacity onPress={() => { setShowInput(true); setControlsVisible(false); }} style={styles.dockIconBtn}>
                <Ionicons name="chatbox-ellipses" size={IS_ANDROID ? 20 : 24} color="#FFF" />
              </TouchableOpacity>
              
              <View
                onStartShouldSetResponder={() => true}
                onResponderGrant={() => {
                  if (!player) return;
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                  // 按下即开始计时：超过 250ms 视为「长按快进」，否则视为「点按锁定」
                  speedLongPressRef.current = false;
                  if (speedPressTimer.current) clearTimeout(speedPressTimer.current);
                  speedPressTimer.current = setTimeout(() => {
                    speedLongPressRef.current = true;
                    if (!player) return;
                    applyPlaybackRate(2.0);
                    setIndicatorText('▶▶ 2.0x 快进中');
                    if (hideTimer.current) clearTimeout(hideTimer.current);
                    hideTimer.current = setTimeout(hideUI, 1000);
                  }, 250);
                }}
                onResponderRelease={() => {
                  if (!player) return;
                  if (speedPressTimer.current) { clearTimeout(speedPressTimer.current); speedPressTimer.current = null; }

                  if (speedLongPressRef.current) {
                    // 长按结束：恢复原逻辑（若未锁定则回到 1x）
                    speedLongPressRef.current = false;
                    if (!speedLockedRef.current) {
                      applyPlaybackRate(1.0);
                      setIndicatorText('');
                      emitCommand('FORCE_SYNC', player.currentTime);
                      showUI();
                    }
                    return;
                  }

                  // 点按：切换 2x 锁定（不弹屏幕中间提示，仅按钮高亮）
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  const next = !speedLockedRef.current;
                  speedLockedRef.current = next;
                  setSpeedLocked(next);
                  applyPlaybackRate(next ? 2.0 : 1.0);
                  if (!next) emitCommand('FORCE_SYNC', player.currentTime);
                  showUI();
                }}
                onResponderTerminate={() => {
                  if (!player) return;
                  if (speedPressTimer.current) { clearTimeout(speedPressTimer.current); speedPressTimer.current = null; }
                  // 手势被系统中断：仅回滚长按临时快进，不影响锁定状态
                  if (speedLongPressRef.current) {
                    speedLongPressRef.current = false;
                    if (!speedLockedRef.current) {
                      applyPlaybackRate(1.0);
                      setIndicatorText('');
                      emitCommand('FORCE_SYNC', player.currentTime);
                      showUI();
                    }
                  }
                }}
                style={[styles.dockIconBtn, speedLocked && styles.dockIconBtnActive]}
              >
                <Text style={[styles.speedBtnText, speedLocked && styles.speedBtnTextActive]}>2X</Text>
              </View>

              {/* 📺 选集按钮（位于 2X 右侧，与播放按钮同样无气泡） */}
              <TouchableOpacity
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowEpisodeDrawer((v) => {
                    const next = !v;
                    // 打开选集 → 自动隐藏下方播放条；关闭 → 恢复
                    if (next) hideUI(); else showUI();
                    return next;
                  });
                }}
                style={styles.dockIconBtn}
              >
                <Ionicons name="list" size={IS_ANDROID ? 20 : 24} color="#FFF" />
              </TouchableOpacity>
              
            </BlurView>
          </Animated.View>

          {/* 📺 选集悬浮窗（从右滑入，约 30% 屏宽，半透明） */}
          <EpisodeDrawer
            visible={showEpisodeDrawer}
            episodes={episodeList}
            currentIndex={currentEpisodeIndex}
            onSelect={(index) => {
              setShowEpisodeDrawer(false);
              requestEpisode(index);
            }}
            onClose={() => setShowEpisodeDrawer(false)}
            palette={palette}
            isDark={isDark}
            topInset={insets.top}
            bottomInset={insets.bottom}
          />

          {showInput && (
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.inputOverlay}>
              <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => { setShowInput(false); Keyboard.dismiss(); showUI(); }} />
              <View style={[styles.inputRow, { 
                paddingBottom: Math.max(insets.bottom, 16),
                paddingLeft: Math.max(insets.left || 0, 24),
                paddingRight: Math.max(insets.right || 0, 24)
              }]}>
                <TextInput style={styles.input} autoFocus placeholder="发送弹幕..." placeholderTextColor="#8E8E93" value={inputText} onChangeText={setInputText} onSubmitEditing={handleSendDanmaku} returnKeyType="send" />
                <TouchableOpacity style={styles.sendBtn} onPress={handleSendDanmaku}>
                  <Ionicons name="arrow-up" size={20} color="#FFF" />
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          )}

        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, 
  safe: { flex: 1 }, 
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 50, paddingHorizontal: 16 }, 
  backBtn: { width: 50, alignItems: 'flex-start', justifyContent: 'center' }, 
  statusPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 }, 
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 }, 
  statusText: { fontSize: 13, fontWeight: '600' }, 
  inviteBtn: { width: 50, alignItems: 'flex-end', justifyContent: 'center' }, 
  cinemaWrapper: { flex: 1, justifyContent: 'center', paddingHorizontal: IS_ANDROID ? 16 : 0 }, 
  video: { width: '100%', aspectRatio: 16/9, backgroundColor: '#000000', borderRadius: IS_ANDROID ? 16 : 0 }, 
  controlPanelWrapper: { paddingHorizontal: 16, paddingBottom: IS_ANDROID ? 48 : 32, width: '100%' }, 
  controlPanel: { borderRadius: IS_ANDROID ? 24 : 32, padding: IS_ANDROID ? 20 : 24, overflow: 'hidden', borderWidth: 1 }, 
  panelHeader: { alignItems: 'center', marginBottom: IS_ANDROID ? 16 : 24 }, 
  panelTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 }, 
  btnRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-around', paddingHorizontal: 8 }, 
  actionBtnColumn: { alignItems: 'center', width: 80 }, 
  iconFixedWrapper: { width: IS_ANDROID ? 56 : 64, height: IS_ANDROID ? 56 : 64, justifyContent: 'center', alignItems: 'center', marginBottom: 10 }, 
  iconCircle: { width: '100%', height: '100%', borderRadius: IS_ANDROID ? 28 : 32, justifyContent: 'center', alignItems: 'center' }, 
  btnText: { fontSize: IS_ANDROID ? 14 : 15, fontWeight: '600' }, 
  syncText: { fontSize: 12, fontWeight: '600', marginTop: 2 },

  danmakuText: { fontSize: 20, fontWeight: '900', letterSpacing: 1 },
  indicatorBox: { position: 'absolute', top: '45%', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 24, paddingVertical: 16, borderRadius: 20 },
  indicatorText: { color: '#FFF', fontSize: 20, fontWeight: 'bold' },
  
  immersiveTopBar: { position: 'absolute', top: 0, width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 10 },
  // 顶栏左右两侧固定宽度，保证中间状态栏绝对居中
  immersiveTopSide: { width: 44, alignItems: 'flex-start', justifyContent: 'center' },
  immersiveTopSideRight: { alignItems: 'flex-end' },
  // 统一气泡尺寸：与顶栏图标按钮完全一致（padding 10 + 图标 22/24）
  immersiveIconBtn: { padding: 10, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 24 },
  // 🧰 工具栏：定位在顶栏下方、右侧对齐，纵向排列（同步在上、浏览器在下）
  immersiveToolbar: {
    position: 'absolute',
    top: 0,
    right: 0,
    marginTop: IS_ANDROID ? 56 : 60,
    flexDirection: 'column',
    alignItems: 'flex-end',
    zIndex: 11,
  },
  immersiveToolbarGap: { marginTop: 10 },
  // 与 immersiveIconBtn 完全相同的尺寸，保证气泡大小一致
  immersiveToolbarBtn: {
    padding: 10,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 24,
  },
  immersiveStatusPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  immersiveStatusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  immersiveStatusText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  
  immersiveBottomBar: { position: 'absolute', bottom: 0, width: '100%', alignItems: 'center', zIndex: 10 },
  glassDock: { flexDirection: 'row', alignItems: 'center', width: '92%', height: 64, borderRadius: 32, paddingHorizontal: 20, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  playBtn: { marginRight: 16, padding: 4 },
  timeText: { color: '#FFF', fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600' },
  
  progressTrackContainer: { flex: 1, height: 40, justifyContent: 'center', marginHorizontal: 16 },
  progressTrack: { height: 4, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 2, position: 'relative', justifyContent: 'center' },
  progressFill: { position: 'absolute', left: 0, height: '100%', backgroundColor: '#0A84FF', borderRadius: 2 },
  progressThumb: { position: 'absolute', width: 16, height: 16, backgroundColor: '#FFF', borderRadius: 8, marginLeft: -8, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.6, elevation: 5 },
  
  danmakuBtn: { marginLeft: 10, padding: 8, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20 },
  // 播放条右侧图标按钮：与最左侧播放按钮一致，无气泡背景
  dockIconBtn: { marginLeft: 10, padding: 4 },
  // 2X 锁定态：仅用文字高亮提示，不额外加气泡
  dockIconBtnActive: {},
  speedBtnText: { color: '#FFF', fontWeight: '800', fontSize: 16, fontStyle: 'italic' },
  speedBtnTextActive: { color: '#0A84FF' },

  inputOverlay: { position: 'absolute', width: '100%', height: '100%', justifyContent: 'flex-end', zIndex: 999 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(28,28,30,0.95)', paddingTop: 16 },
  input: { flex: 1, height: 44, backgroundColor: '#3A3A3C', borderRadius: 22, paddingHorizontal: 20, color: '#FFF', fontSize: 16 },
  sendBtn: { marginLeft: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: '#0A84FF', justifyContent: 'center', alignItems: 'center' }
});
// --- END OF FILE src/app/cinema.js ---