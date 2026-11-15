// --- START OF FILE src/app/cinema.js ---
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, useWindowDimensions, PanResponder, Animated, TextInput, KeyboardAvoidingView, Keyboard, TouchableWithoutFeedback, Dimensions, StatusBar, BackHandler, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import { BlurView } from 'expo-blur';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { VideoView } from 'expo-video';
// ⏳ useEvent：订阅 expo-video 播放器事件（用于读取 status 判断是否正在加载）
// 🐞 useEventListener：回调式订阅（playToEnd 无参数，useEvent 返回值恒为 undefined，无法用作触发信号）
import { useEvent, useEventListener } from 'expo';
import * as Brightness from 'expo-brightness';
import * as ScreenOrientation from 'expo-screen-orientation';
// 💡 屏幕常亮：播放中禁止息屏（expo-keep-awake 是 expo 自带模块，无需额外安装）
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useAppTheme } from '../context/ThemeContext';
import { useCinema } from '../hooks/useCinema';
import { useAuth } from '../hooks/useAuth';
import EpisodeDrawer from '../components/cinema/EpisodeDrawer';
import HiddenSnifferWebView from '../components/cinema/HiddenSnifferWebView';

const IS_ANDROID = Platform.OS === 'android';

// 🐞 模块级「最近一次使用的影院房间号」：
//    影院页被卸载（最小化 → router.back()）后重新挂载时，CinemaProvider 里的
//    cinemaRoomId 可能已被清空（closePlayer）或尚未写入（首次 effect 未跑完）。
//    若此时生成新 UUID，会重建 Supabase Channel → presence 重新 sync →
//    partnerStatus 变化 → 广播 PLAY → 播放器被 replaceAsync/seek 到 0。
//    用模块级变量记住上一次的房间号，保证同一次 App 会话内房间号稳定不变。
let lastCinemaRoomId = null;

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
    // 🎚️ 拖动进度条开关（拖动期间屏蔽同步漂移检测）
    setScrubbing,
    // 📺 选集
    episodeList, currentEpisodeIndex, episodeSwitchRequest, requestEpisode, applyEpisodeList,
    episodeListRequest,
    // 📺 自动下一集：复用已有的 playNextEpisode（内部已做边界判断）
    playNextEpisode,
  } = useCinema();

  // 🍎 P2-15 修复：房间号使用 useState 惰性初始化，仅在组件首次挂载时生成一次。
  //    旧实现把 roomId 放在 useEffect 里用 Date.now() 生成，任何重渲染/依赖变化
  //    都会重新生成新房间号，导致用户被踢出原房间（异常掉线）。
  //    现在整个组件生命周期内 roomId 绝对唯一且不变。
  // 🍎 补充修复：组件被重新挂载（如从悬浮窗最大化回到影院）时，优先复用上下文中
  //    已存在的 cinemaRoomId，避免生成新房间号 → 重建 Supabase Channel → 触发
  //    partnerStatus 变化 → 广播 PLAY 指令 → 播放器 replaceAsync 导致视频从头开始。
  // 🐞 安卓补充修复：重新挂载时 cinemaRoomId 可能为 null（例如从「空间 → 放映厅」
  //    直接进入，或 Provider 刚被重建），此时若生成新 UUID，会与「最小化前」的房间
  //    不一致 → 重建 Channel → presence 重新 sync → partnerStatus 变化 →
  //    useCinema 里 partnerStatus 的 effect 广播 PLAY(currentTime) 到新房间，
  //    同时旧房间的残留指令也可能被消费 → 播放器被 replaceAsync/seek 到 0。
  //    这里把「最近一次使用的房间号」持久化到模块级变量，重新挂载时优先复用，
  //    保证同一次 App 会话内房间号稳定不变。
  const [roomId] = useState(() => cinemaRoomId || lastCinemaRoomId || Crypto.randomUUID());
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

  // 📊 缓存进度（秒）：expo-video 的 player.bufferedPosition
  //    - iOS：返回「包含 currentTime 的 loadedTimeRanges 区间」的末尾；无 item 时 -1，当前点未缓存时 0
  //    - Android：ExoPlayer 的前向 bufferedPosition；无 item 时 -1，STATE_BUFFERING 时 0
  //    两端都只给「一个前向点」，拿不到完整区间列表，所以只能画「当前点 → 已缓存点」这一段。
  //    -1 / 0 一律归一化为 0（= 不画缓存条），避免出现「缓存条从 0 开始」的错误视觉。
  const [bufferedTime, setBufferedTime] = useState(0);
  // 缓存条刷新阈值：变化超过 0.5s 才 setState，避免每 500ms 都触发一次无谓重渲染
  const bufferedRef = useRef(0);
  // 🕒 松手 seek 时若目标落在缓存区外，立即弹「正在加载中」（跳过 400ms 延迟）
  //    这是一个「一次性强制显示」标记，由 seek 时置 true，status 离开 loading 时清掉。
  const [forceLoadingHint, setForceLoadingHint] = useState(false);

  // ⏳ 播放器加载状态：expo-video 的 status 只有 'idle' | 'loading' | 'readyToPlay' | 'error'。
  //    'loading' 覆盖了「首次打开 / 拖动 seek 后重新拉流 / 网络抖动缓冲」三种情况，
  //    正好对应「画面卡住但没坏」的场景 —— 用它驱动屏幕正中央的「正在加载中」提示，
  //    避免用户以为软件卡死。
  //    useEvent 会在 statusChange 事件到达时自动触发重渲染，无需轮询。
  const playerStatusEvent = useEvent(player, 'statusChange', { status: player?.status ?? 'idle' });
  const playerStatus = playerStatusEvent?.status ?? 'idle';
  // 🕒 延迟显示：短于 400ms 的加载（例如 2X 切换时的瞬时缓冲）不弹提示，
  //    否则提示会一闪而过，反而显得界面在抖动。
  //    实现上只用一个「已确认加载」的标记：定时器到点才置 true，
  //    状态离开 loading 时由 effect 的清理函数取消定时器，
  //    渲染时再用 playerStatus === 'loading' 兜底判断，
  //    这样 effect 体内不会同步 setState（避免级联渲染告警）。
  const [loadingConfirmed, setLoadingConfirmed] = useState(false);
  useEffect(() => {
    if (playerStatus !== 'loading') return undefined;
    const timer = setTimeout(() => setLoadingConfirmed(true), 400);
    return () => {
      clearTimeout(timer);
      setLoadingConfirmed(false);
    };
  }, [playerStatus]);
  // 🕒 强制标记的生命周期：一旦离开 loading 就清掉，避免下次加载被误判为「缓存外」
  useEffect(() => {
    if (playerStatus === 'loading') return undefined;
    if (!forceLoadingHint) return undefined;
    const timer = setTimeout(() => setForceLoadingHint(false), 0);
    return () => clearTimeout(timer);
  }, [playerStatus, forceLoadingHint]);
  // 缓存区外 seek → forceLoadingHint 为 true 时立即显示，不等 400ms
  const showLoadingHint = playerStatus === 'loading' && (loadingConfirmed || forceLoadingHint);

  const [inputText, setInputText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [indicatorText, setIndicatorText] = useState('');

  // 💬 弹幕开关：默认开启（保持原有行为不变），关闭后不再渲染任何弹幕
  const [danmakuEnabled, setDanmakuEnabled] = useState(true);

  // 📺 自动连播开关：默认开启（保持原有行为不变）。
  //    关闭后片尾不再自动跳集，用户仍可用「下一集」按钮手动切换。
  const [autoNextEnabled, setAutoNextEnabled] = useState(true);
  const autoNextEnabledRef = useRef(true);

  // 🎚️ 音量/亮度手势的竖向反馈条：{ type: 'volume' | 'brightness', value: 0~1 }
  //    仅在手势进行中显示，松手/中断后置 null。纯展示层，不拦截手势。
  const [gestureHud, setGestureHud] = useState(null);

  // 🧰 底栏「更多」菜单：把弹幕输入 / 2X / 选集 / 弹幕开关收进一个弹出层，
  //    解决底栏图标过多过杂的问题。纯 UI 状态，不改变任何功能逻辑。
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  // 菜单展开态镜像：供 showUI 等非渲染路径同步读取，避免闭包过期
  const moreMenuVisibleRef = useRef(false);
  useEffect(() => { moreMenuVisibleRef.current = showMoreMenu; }, [showMoreMenu]);

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
  // 🐞 大跨度 seek 后的播放兜底重试定时器（HLS 重新拉流期间 play() 会被原生侧丢弃）
  const resumeRetryTimer = useRef(null);

  const gestureLock = useRef('none');
  const lastBrightnessTime = useRef(0); // 🍎 硬件节流专用 Ref
  // 🔊 音量节流专用 Ref：避免每帧写原生 volume 导致音频欠载 / 破音
  const lastVolumeTime = useRef(0);
  const lastVolumeValue = useRef(-1);

  useEffect(() => {
    // 优先使用邀请链接带入的 roomId；否则使用本组件惰性生成的稳定 roomId。
    // 一旦确定，不再因重渲染而改变，避免意外掉线。
    const targetRoom = params.roomId || roomId;
    // 🐞 记住本次使用的房间号，供下次重新挂载时复用（见文件顶部 lastCinemaRoomId 说明）
    lastCinemaRoomId = targetRoom;
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

  // 🐞 修复「安卓：最小化后点悬浮窗 / 点放映厅卡回到影院，进度条全部清空并从 0 重播」：
  //    旧实现只在「沉浸式全屏」时轮询进度，非全屏（2 级放映厅）时 progress/currentTime
  //    完全靠事件驱动。影院页重新挂载后这些 state 全部回到初始值（0），而播放器
  //    其实还在原位置继续播 —— 于是进度条显示 0、时间显示 00:00，看起来像「重新开始」。
  //    这里把轮询条件从 isImmersive 放宽为「只要有 player 就跑」，并在挂载后
  //    立即用播放器真实位置做一次同步，保证重新进入影院时进度条立刻回到正确位置。
  useEffect(() => {
    let interval;
    if (player) {
      // 立即同步一次（不等 500ms），避免重新挂载后出现「进度条空一帧」
      const syncOnce = () => {
        if (isScrubbing.current || gestureLock.current !== 'none') return;
        const cur = player.currentTime || 0;
        const dur = player.duration || 1;
        setCurrentTime(cur);
        setDuration(dur); durationRef.current = dur;
        setProgress(cur / dur); progressRef.current = cur / dur;
        setIsPlaying(player.playing);
      };
      syncOnce();
      interval = setInterval(() => {
        if (!isScrubbing.current && gestureLock.current === 'none') {
          const cur = player.currentTime || 0;
          const dur = player.duration || 1;
          setCurrentTime(cur);
          setDuration(dur); durationRef.current = dur;
          setProgress(cur / dur); progressRef.current = cur / dur;
          setIsPlaying(player.playing);

          // 📊 缓存进度：复用同一个 500ms 轮询，不新增定时器。
          //    -1（无媒体）/ 0（当前点未缓存）统一归一化为 0 → 不画缓存条。
          //    变化不足 0.5s 时不 setState，避免无谓重渲染。
          //    ⚠️ 拖动期间（isScrubbing）整个分支被跳过，缓存条不会跟着手指乱跳。
          let buf = 0;
          try {
            const raw = player.bufferedPosition;
            if (typeof raw === 'number' && isFinite(raw) && raw > 0) {
              buf = Math.min(raw, dur);
            }
          } catch (_e) {
            buf = 0;
          }
          if (Math.abs(buf - bufferedRef.current) > 0.5 || (buf === 0 && bufferedRef.current !== 0)) {
            bufferedRef.current = buf;
            setBufferedTime(buf);
          }
        }
      }, 500);
    }
    return () => clearInterval(interval);
  }, [player]);

  // 💡 屏幕常亮：仅在「沉浸式全屏 + 正在播放」时激活，其余情况立即释放。
  //    用固定 tag，保证多次激活/释放不会叠加锁；卸载时兜底释放。
  //    注意：deactivateKeepAwake 在未激活时调用是安全的（原生侧幂等）。
  useEffect(() => {
    const KEEP_AWAKE_TAG = 'cinema-playback';
    if (isImmersive && isPlaying) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [isImmersive, isPlaying]);

  // 📺 播放结束自动下一集：
  //    - 用 useEventListener 回调式订阅 expo-video 的 playToEnd（播放到片尾时触发一次）
  //      🐞 不能用 useEvent：playToEnd 事件没有参数，useEvent 的返回值恒为 undefined，
  //         写成 `if (!playToEndEvent) return` 会导致 effect 永远提前返回 → 自动连播完全失效。
  //    - 仅在「有下一集」时自动切换；最后一集播完保持原样（停在片尾），不弹任何东西
  //    - 切换走已有的 playNextEpisode → requestEpisode → 隐藏 WebView 重新嗅探，
  //      不新增任何播放/同步逻辑，避免与现有同步机制冲突
  //    - 用 ref 做一次性防抖：playToEnd 在个别机型上可能连发，避免连续跳两集
  const autoNextGuardRef = useRef(false);
  // 回调里读取最新的选集状态，避免闭包过期（useEventListener 内部已用 ref 保存最新回调）
  const autoNextStateRef = useRef({ index: -1, total: 0 });
  useEffect(() => {
    autoNextStateRef.current = { index: currentEpisodeIndex, total: episodeList.length };
  }, [currentEpisodeIndex, episodeList.length]);

  useEventListener(player, 'playToEnd', () => {
    if (autoNextGuardRef.current) return;
    // 📺 自动连播开关关闭时，片尾不做任何动作（用户可手动点「下一集」）
    if (!autoNextEnabledRef.current) return;
    const { index, total } = autoNextStateRef.current;
    // 边界判断：只有确实存在下一集才自动切换
    if (index < 0 || index >= total - 1) return;
    autoNextGuardRef.current = true;
    playNextEpisode();
    // 800ms 后解锁：足够覆盖一次切集请求，又不会长期锁死后续的片尾事件
    setTimeout(() => { autoNextGuardRef.current = false; }, 800);
  });

  const showUI = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setControlsVisible(true); controlsVisibleRef.current = true;
    Animated.timing(controlsOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    // 🧰 工具栏展开时不启动自动隐藏：用户正在挑选「同步 / 浏览器」按钮，
    //    5 秒后突然整层消失会打断操作。收起工具栏后由 handleToggleToolbar 重新计时。
    if (toolbarVisibleRef.current) return;
    // 🧰 「更多」菜单展开时同样不自动隐藏，否则菜单会跟着底栏一起消失
    if (moreMenuVisibleRef.current) return;
    hideTimer.current = setTimeout(hideUI, 5000);
  };

  const hideUI = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // 🧰 隐藏控制层时同步收起工具栏，避免工具栏残留在画面上
    setToolbarVisible(false);
    toolbarVisibleRef.current = false;
    toolbarAnim.setValue(0);
    // 🧰 同时收起「更多」菜单，避免菜单悬空在无底栏的画面上
    setShowMoreMenu(false);
    Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
      setControlsVisible(false); controlsVisibleRef.current = false;
    });
  };

  const handleTogglePlay = () => {
    if (!player) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // 🐞 用户手动暂停/播放时，取消 seek 后的兜底重试，
    //    否则「拖完立刻点暂停」会在 800ms 后被强行恢复播放。
    if (resumeRetryTimer.current) { clearTimeout(resumeRetryTimer.current); resumeRetryTimer.current = null; }
    wasPlayingRef.current = !isPlaying;
    if (isPlaying) {
      player.pause(); setIsPlaying(false); emitCommand('PAUSE', player.currentTime);
    } else {
      player.play(); setIsPlaying(true); emitCommand('PLAY', player.currentTime);
    }
    showUI();
  };

  // ⏩ 统一设置播放速率（幂等，且绝不触发多余的原生写入）
  //
  //    🐞 修复「点按 2X / 长按 2X / 结束 2X 时画面停顿一下」：
  //    根因在 expo-video 原生实现里 ——
  //      · iOS  VideoPlayer.swift 的 `playbackRate.didSet` 会【无条件】执行
  //        `ref.rate = playbackRate`，即使新旧值相同。写 rate 会让 AVPlayer 的
  //        timeControlStatus 短暂进入 .waitingToPlayAtSpecifiedRate，
  //        VideoPlayerObserver 随即把 status 置为 .loading → 画面卡一帧到几百毫秒。
  //      · Android VideoModule.kt 的 playbackRate setter 每次都新建
  //        PlaybackParameters 并赋给 ExoPlayer，会重建音频 SonicAudioProcessor
  //        并重新评估缓冲 → 短暂 STATE_BUFFERING。
  //      · iOS `preservesPitch.didSet` 会重设 audioTimePitchAlgorithm
  //        (.spectral ↔ .varispeed)，这是更重的音频管线重建。
  //    因此这里做三件事：
  //      1) 速率相同 → 直接 return，一次原生写入都不发（旧实现已做，保留）。
  //      2) preservesPitch 只在【确实为 false】时才写，且只写一次（用 ref 记住），
  //         避免每次切速率都重建音频管线。
  //      3) 不再在改速率后调用 play() —— 播放中改速率本来就会继续播；
  //         暂停态改速率也不需要自动起播（由调用方显式决定），
  //         避免「改速率 + play()」两次原生调用叠加造成二次卡顿。
  //
  //    🐞 第二版修复「点按 2X 时【按下】和【松手】各卡顿一次」：
  //    按下卡顿来自 onResponderGrant 里的 Haptics.impactAsync(Heavy)。
  //    iOS 上 Heavy 触感会触发 CoreHaptics 引擎启动（首次约 30~80ms），
  //    且与 AVPlayer 的音频会话争抢，表现为按下瞬间画面顿一下。
  //    松手卡顿来自松手时连续三次原生调用：setSpeedLocked(重渲染) +
  //    playbackRate 写入 + Haptics(Light)。这里把触感降级为 Selection
  //    （最轻、无引擎启动开销），并把速率写入延后到下一帧，
  //    让「按钮高亮」先渲染完成，避免同一帧内 JS 渲染与原生写速率叠加。
  const pitchFixedRef = useRef(false);
  const applyPlaybackRate = useCallback((rate) => {
    if (!player) return;
    // 1) 幂等：值没变就什么都不做（关键，避免原生 didSet 无条件写 rate）
    if (player.playbackRate === rate) return;
    // 2) preservesPitch 默认就是 true，只有被外部改成 false 时才需要纠正一次
    if (!pitchFixedRef.current && player.preservesPitch !== true) {
      player.preservesPitch = true;
      pitchFixedRef.current = true;
    }
    // 3) 只写速率，不附带 play()
    player.playbackRate = rate;
  }, [player]);

  // ⏩ 延后一帧写速率：让 React 先把「2X 高亮」渲染出来，
  //    避免同一帧内「重渲染 + 原生写 rate」叠加导致掉帧。
  //    用 requestAnimationFrame 而非 setTimeout(0)，保证在下一帧绘制前执行。
  const applyPlaybackRateDeferred = useCallback((rate) => {
    if (!player) return;
    if (player.playbackRate === rate) return;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => applyPlaybackRate(rate));
    } else {
      setTimeout(() => applyPlaybackRate(rate), 16);
    }
  }, [player, applyPlaybackRate]);

  const formatTime = (sec) => {
  // 🍎 如果是直播流（无穷大或无效），直接显示 LIVE！
  if (!isFinite(sec) || sec <= 0) return 'LIVE'; 
  
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
};

  // 🎚️ 进度条拖动（方案 A：拖动期间只更新 UI，松手才真正 seek 一次）
  //    旧实现每 150ms 写一次 player.currentTime，对 HLS 而言每次都是一次完整的
  //    网络 seek（重新拉取 ts 分片 + 解析），拖动 3 秒会产生约 20 次 seek 请求，
  //    播放器永远追不上 → 表现为「拖动后加载极慢 / 转圈」。
  //    新实现：拖动中只改本地进度状态（画面停在拖动前的帧），松手时一次性 seek，
  //    网络 seek 次数从 ~20 次降到 1 次。
  const seekPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        if (!player) return;
        if (hideTimer.current) clearTimeout(hideTimer.current);
        gestureLock.current = 'horizontal';
        isScrubbing.current = true;
        // 🎚️ 通知同步层：拖动期间屏蔽漂移检测，避免把用户 seek 误判为播放漂移
        setScrubbing(true);
        // 🐞 必须读 player.playing 实时值，不能读 isPlaying state：
        //    拖动期间 500ms 轮询被 isScrubbing 跳过，state 可能已过期（例如刚被同步层
        //    暂停/恢复过），导致松手后误判为「本来就没在播」→ 大跨度拖动后停在暂停态。
        wasPlayingRef.current = player.playing;
        initialTrackX.current = progressRef.current * trackWidthRef.current;
        // 拖动期间暂停，释放解码器，避免「边播边 seek」双重负载
        if (player.playing) player.pause();
      },
      onPanResponderMove: (evt, gestureState) => {
        if (!player) return;
        let p = (initialTrackX.current + gestureState.dx) / trackWidthRef.current;
        p = Math.max(0, Math.min(1, p));
        progressRef.current = p; setProgress(p);
        // 仅更新 UI 时间显示，绝不写 player.currentTime
        setCurrentTime(p * durationRef.current);
      },
      onPanResponderRelease: () => {
        if (!player) return;
        gestureLock.current = 'none';
        isScrubbing.current = false;
        
        const newTime = progressRef.current * durationRef.current;
        // 📊 缓存判定：目标点落在缓存区外 → 必然要拉流，立即弹「正在加载中」；
        //    落在缓存区内 → 大概率很快，不强制弹（仍走 400ms 延迟兜底）。
        //    注意 bufferedRef 在拖动期间不刷新，这里读到的是「按下前」的缓存位置，
        //    正是我们需要的基准（拖动本身不会改变缓存）。
        const isBuffered = bufferedRef.current > 0 && newTime <= bufferedRef.current + 0.5;
        if (!isBuffered) setForceLoadingHint(true);
        // 全程唯一一次真实 seek
        player.currentTime = newTime;
        emitCommand('FORCE_SYNC', newTime);
        
        // 🐞 松手后恢复播放：大跨度 seek（跨很多分钟）时 HLS 需要重新拉取分片，
        //    紧跟 seek 同步调用 play() 会被原生侧丢弃（player 仍在 buffering），
        //    表现为「拖远了就停在暂停态」。这里改为「立即 play + 800ms 兜底重试」，
        //    重试时若用户已手动暂停（wasPlayingRef 被置 false）则不再强行播放。
        if (wasPlayingRef.current) {
          player.play(); setIsPlaying(true); emitCommand('PLAY', newTime);
          if (resumeRetryTimer.current) clearTimeout(resumeRetryTimer.current);
          resumeRetryTimer.current = setTimeout(() => {
            if (!player) return;
            if (!wasPlayingRef.current) return;
            if (!player.playing) { player.play(); setIsPlaying(true); }
          }, 800);
        }
        // 🎚️ 解除拖动标记：放在 seek 之后，让轮询以新位置为基准重新计算漂移
        setScrubbing(false);
        showUI();
      },
      // 🛡️ 手势被系统中断（来电 / 下拉通知 / 切后台）：必须兜底恢复播放，
      //    否则 player 会一直停在 Grant 里 pause() 的暂停状态。
      onPanResponderTerminate: () => {
        gestureLock.current = 'none';
        isScrubbing.current = false;
        if (player && wasPlayingRef.current && !player.playing) {
          player.play();
          setIsPlaying(true);
        }
        // 🛡️ 无条件兜底解除拖动标记
        setScrubbing(false);
      },
      // 🛡️ 手势被其他组件抢走（如父级 ScrollView）：同样需要兜底
      onPanResponderTerminationRequest: () => true
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
              // 🐞 与进度条拖动一致：读 player.playing 实时值，避免 state 过期导致松手不恢复播放
              wasPlayingRef.current = player.playing;
              // 🎚️ 进入横向快进：通知同步层屏蔽漂移检测
              setScrubbing(true);
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
          // 🎚️ 方案 A：滑动过程中只更新 UI 与指示器，不写 player.currentTime。
          //    真正的 seek 统一在 onPanResponderRelease 的 horizontal 分支执行一次，
          //    避免 HLS 在滑动期间被反复打断导致加载极慢。

        } else if (gestureLock.current === 'brightness') {
          const delta = -(dy / h) * 1.5;
          let newB = Math.max(0, Math.min(1, initialBrightness.current + delta));
          // 🎚️ 竖向反馈条已包含图标 + 百分比，屏幕中间的指示块不再重复显示
          setGestureHud({ type: 'brightness', value: newB });

          // 🍎 核心修复：对系统硬件 API 增加 150ms 节流阀，解除 Bridge 大塞车
          const now = Date.now();
          if (now - lastBrightnessTime.current > 150) {
            Brightness.setSystemBrightnessAsync(newB).catch(()=>{});
            lastBrightnessTime.current = now;
          }

        } else if (gestureLock.current === 'volume') {
          const delta = -(dy / h) * 1.5;
          let newV = Math.max(0, Math.min(1, initialVolume.current + delta));
          // 🎚️ 竖向反馈条已包含图标 + 百分比，屏幕中间的指示块不再重复显示
          setGestureHud({ type: 'volume', value: newV });

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
        // 🎚️ 手势结束：收起竖向反馈条（无论哪个分支都必须收起）
        setGestureHud(null);

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
          // 🎚️ 方案 A：滑动全程唯一一次真实 seek
          const targetTime = progressRef.current * durationRef.current;
          // 📊 与进度条拖动一致：目标落在缓存区外 → 立即弹「正在加载中」
          const isBuffered = bufferedRef.current > 0 && targetTime <= bufferedRef.current + 0.5;
          if (!isBuffered) setForceLoadingHint(true);
          player.currentTime = targetTime;
          emitCommand('FORCE_SYNC', targetTime);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (wasPlayingRef.current) {
            player.play(); setIsPlaying(true); emitCommand('PLAY', targetTime);
            // 🐞 大跨度快进同样需要兜底重试（原因见进度条拖动分支）
            if (resumeRetryTimer.current) clearTimeout(resumeRetryTimer.current);
            resumeRetryTimer.current = setTimeout(() => {
              if (!player) return;
              if (!wasPlayingRef.current) return;
              if (!player.playing) { player.play(); setIsPlaying(true); }
            }, 800);
          }
          // 解除拖动标记：放在 seek 之后，让轮询以新位置为基准
          setScrubbing(false);
          showUI();
        }
        gestureLock.current = 'none';
        // 🛡️ 无条件兜底：任何分支结束都必须解除拖动标记，
        //    否则 isScrubbingRef 卡在 true 会让同步漂移检测永久失效。
        setScrubbing(false);
      },
      // 🛡️ 手势被系统中断：兜底恢复播放并解除拖动标记
      onPanResponderTerminate: () => {
        if (gestureLock.current === 'horizontal') {
          if (player && wasPlayingRef.current && !player.playing) {
            player.play();
            setIsPlaying(true);
          }
        }
        gestureLock.current = 'none';
        setIndicatorText('');
        // 🎚️ 手势中断：同样收起竖向反馈条
        setGestureHud(null);
        // 🛡️ 无条件兜底解除拖动标记
        setScrubbing(false);
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

          {/* 💬 弹幕层：受 danmakuEnabled 开关控制，关闭时整层不渲染（不影响已收到的数据） */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {danmakuEnabled && danmakuList.map((dm) => (
              <DanmakuItem key={dm.id} text={dm.text} color={dm.color} screenWidth={SCREEN_WIDTH} />
            ))}
          </View>

          {/* ⏳ 加载提示：屏幕正中央，纯展示层（pointerEvents="none" 不拦截任何手势） */}
          {showLoadingHint && (
            <View style={styles.loadingOverlay} pointerEvents="none">
              <View style={styles.loadingBox}>
                <ActivityIndicator size="large" color="#FFFFFF" />
                <Text style={styles.loadingText}>正在加载中</Text>
              </View>
            </View>
          )}

          <View style={StyleSheet.absoluteFill} {...screenPanResponder.panHandlers}>
            <View style={{ flex: 1, justifyContent: 'center' }}>
              {indicatorText !== '' && (
                <View style={styles.indicatorBox}><Text style={styles.indicatorText}>{indicatorText}</Text></View>
              )}
            </View>
          </View>

          {/* 🎚️ 音量/亮度竖向反馈条：左侧=亮度，右侧=音量，纯展示不拦截手势 */}
          {gestureHud && (
            <View
              style={[
                styles.gestureHudWrap,
                gestureHud.type === 'brightness' ? styles.gestureHudLeft : styles.gestureHudRight,
              ]}
              pointerEvents="none"
            >
              <Ionicons
                name={gestureHud.type === 'brightness' ? 'sunny' : 'volume-high'}
                size={20}
                color="rgba(255,255,255,0.9)"
                style={{ marginBottom: 10 }}
              />
              <View style={styles.gestureHudTrack}>
                <View style={[styles.gestureHudFill, { height: `${Math.round(gestureHud.value * 100)}%` }]} />
              </View>
              <Text style={styles.gestureHudText}>{Math.round(gestureHud.value * 100)}%</Text>
            </View>
          )}

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
                  {/* 📊 缓存条：从当前播放点画到已缓存点（前向缓存）。
                      仅当 bufferedTime 有效且确实领先当前进度时才渲染，
                      避免出现「缓存条从 0 开始」或「负宽度」的错误视觉。
                      层级在 progressFill 之下，不遮挡蓝色已播放条。 */}
                  {bufferedTime > 0 && duration > 0 && bufferedTime > currentTime + 0.2 && (
                    <View
                      style={[
                        styles.progressBuffered,
                        {
                          left: `${progress * 100}%`,
                          width: `${Math.max(0, Math.min(1, bufferedTime / duration) - progress) * 100}%`,
                        },
                      ]}
                    />
                  )}
                  <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                  <View style={[styles.progressThumb, { left: `${progress * 100}%` }]} />
                </View>
              </View>
              
              <Text style={styles.timeText}>{formatTime(duration)}</Text>

              {/* 💬 发送弹幕（从「更多」菜单移回底栏） */}
              <TouchableOpacity onPress={() => { setShowInput(true); setControlsVisible(false); }} style={styles.dockIconBtn}>
                <Ionicons name="chatbox-ellipses" size={IS_ANDROID ? 20 : 24} color="#FFF" />
              </TouchableOpacity>

              {/* ⏩ 2X 倍速（从「更多」菜单移回底栏）：点按锁定/取消，长按临时快进 */}
              <View
                onStartShouldSetResponder={() => true}
                onResponderGrant={() => {
                  if (!player) return;
                  Haptics.selectionAsync();
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
                    speedLongPressRef.current = false;
                    if (!speedLockedRef.current) {
                      applyPlaybackRate(1.0);
                      setIndicatorText('');
                      showUI();
                    }
                    return;
                  }

                  Haptics.selectionAsync();
                  const next = !speedLockedRef.current;
                  speedLockedRef.current = next;
                  setSpeedLocked(next);
                  applyPlaybackRateDeferred(next ? 2.0 : 1.0);
                  if (next && !player.playing) {
                    player.play();
                    setIsPlaying(true);
                    emitCommand('PLAY', player.currentTime);
                  }
                  showUI();
                }}
                onResponderTerminate={() => {
                  if (!player) return;
                  if (speedPressTimer.current) { clearTimeout(speedPressTimer.current); speedPressTimer.current = null; }
                  if (speedLongPressRef.current) {
                    speedLongPressRef.current = false;
                    if (!speedLockedRef.current) {
                      applyPlaybackRate(1.0);
                      setIndicatorText('');
                      showUI();
                    }
                  }
                }}
                style={[styles.dockIconBtn, speedLocked && styles.dockIconBtnActive]}
              >
                <Text style={[styles.speedBtnText, speedLocked && styles.speedBtnTextActive]}>2X</Text>
              </View>

              {/* 🧰 更多：仅保留「选集 / 弹幕开关 / 自动连播」三项 */}
              <TouchableOpacity
                onPress={() => {
                  Haptics.selectionAsync();
                  setShowMoreMenu((v) => !v);
                  showUI();
                }}
                style={styles.dockIconBtn}
              >
                <Ionicons name="ellipsis-horizontal" size={IS_ANDROID ? 20 : 24} color="#FFF" />
              </TouchableOpacity>
              
            </BlurView>
          </Animated.View>

          {/* 🧰 更多菜单：从底栏上方弹出，点击遮罩关闭 */}
          {showMoreMenu && (
            <View style={styles.moreMenuOverlay}>
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={() => setShowMoreMenu(false)}
              />
              <View style={[styles.moreMenu, { paddingBottom: Math.max(insets.bottom + 8, 24) }]}>
                <BlurView intensity={80} tint="dark" style={styles.moreMenuCard}>
                  {/* 📺 选集 */}
                  <TouchableOpacity
                    style={styles.moreMenuItem}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setShowMoreMenu(false);
                      setShowEpisodeDrawer(true);
                      hideUI();
                    }}
                  >
                    <Ionicons name="list" size={22} color="#FFF" />
                    <Text style={styles.moreMenuLabel}>选集</Text>
                  </TouchableOpacity>

                  {/* 💬 弹幕开关 */}
                  <TouchableOpacity
                    style={styles.moreMenuItem}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setDanmakuEnabled((v) => !v);
                    }}
                  >
                    <Ionicons
                      name={danmakuEnabled ? 'chatbubbles' : 'chatbubbles-outline'}
                      size={22}
                      color={danmakuEnabled ? '#FFF' : 'rgba(255,255,255,0.45)'}
                    />
                    <Text style={styles.moreMenuLabel}>
                      {danmakuEnabled ? '弹幕已开启' : '弹幕已关闭'}
                    </Text>
                  </TouchableOpacity>

                  {/* 📺 自动连播开关 */}
                  <TouchableOpacity
                    style={styles.moreMenuItem}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setAutoNextEnabled((v) => {
                        autoNextEnabledRef.current = !v;
                        return !v;
                      });
                    }}
                  >
                    <Ionicons
                      name={autoNextEnabled ? 'infinite' : 'remove-circle-outline'}
                      size={22}
                      color={autoNextEnabled ? '#FFF' : 'rgba(255,255,255,0.45)'}
                    />
                    <Text style={styles.moreMenuLabel}>
                      {autoNextEnabled ? '自动连播已开启' : '自动连播已关闭'}
                    </Text>
                  </TouchableOpacity>
                </BlurView>
              </View>
            </View>
          )}

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

  // ⏳ 加载提示：铺满全屏并绝对居中（横竖屏都居中），纯展示不拦截手势
  //    🐞 修复「提示跑到屏幕最上方」：
  //    父容器是 `StyleSheet.absoluteFill` 的 View，但该父级没有显式定位基准，
  //    在部分 RN 版本下 absoluteFillObject 展开后缺少 top/left 的可靠基准，
  //    导致 flex 居中失效、内容贴顶。这里显式写死 top/left/right/bottom: 0，
  //    并补上 flexDirection: 'column'，保证垂直方向也参与居中计算。
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  loadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 28,
    paddingVertical: 22,
    borderRadius: 18,
    minWidth: 140,
  },
  loadingText: { color: '#FFF', fontSize: 15, fontWeight: '600', marginTop: 12, letterSpacing: 0.5 },
  
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
  // 📊 缓存条：比轨道亮、比蓝色已播放条暗，视觉上明确区分「已缓存但未播放」
  progressBuffered: { position: 'absolute', height: '100%', backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 2 },
  progressFill: { position: 'absolute', left: 0, height: '100%', backgroundColor: '#0A84FF', borderRadius: 2 },
  progressThumb: { position: 'absolute', width: 16, height: 16, backgroundColor: '#FFF', borderRadius: 8, marginLeft: -8, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.6, elevation: 5 },
  
  // 🎚️ 音量/亮度竖向反馈条：纯展示层，绝对定位在屏幕两侧中部
  //    宽度固定 56，高度 180，内部 track 撑满剩余空间
  gestureHudWrap: {
    position: 'absolute',
    top: '50%',
    marginTop: -110,
    width: 56,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 28,
    paddingVertical: 14,
    zIndex: 30,
  },
  gestureHudLeft: { left: 24 },
  gestureHudRight: { right: 24 },
  gestureHudTrack: {
    flex: 1,
    width: 6,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 3,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  gestureHudFill: {
    width: '100%',
    backgroundColor: '#FFF',
    borderRadius: 3,
  },
  gestureHudText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },

  // 🧰 更多菜单：底栏上方弹出的卡片，纯展示层
  moreMenuOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
  },
  moreMenu: {
    paddingHorizontal: 16,
    paddingRight: 24,
    marginBottom: 76,
  },
  moreMenuCard: {
    minWidth: 210,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  moreMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  moreMenuLabel: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 12,
  },
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