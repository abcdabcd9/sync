// --- START OF FILE src/app/cinema.js ---
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, useWindowDimensions, PanResponder, Animated, TextInput, KeyboardAvoidingView, Keyboard, TouchableWithoutFeedback, Dimensions, StatusBar } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import { useRouter, useLocalSearchParams } from 'expo-router'; 
import { VideoView } from 'expo-video';
import * as Brightness from 'expo-brightness';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useAppTheme } from '../context/ThemeContext';
import { useCinema } from '../hooks/useCinema';
import { useAuth } from '../hooks/useAuth';

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
  const params = useLocalSearchParams();
  const { user } = useAuth();
  
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions(); 
  const insets = useSafeAreaInsets();
  
  const { player, partnerStatus, emitCommand, setIsMinimized, cinemaRoomId, setCinemaRoomId, danmakuList, emitDanmaku } = useCinema();
  const [activeRoomId, setActiveRoomId] = useState(null);

  const [isImmersive, setIsImmersive] = useState(false);
  
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

  useEffect(() => {
    if (params.roomId && params.roomId !== cinemaRoomId) {
      setActiveRoomId(params.roomId);
      setCinemaRoomId(params.roomId);
    } else if (!cinemaRoomId) {
      const newRoom = `room_${user?.id}_${Date.now().toString().slice(-6)}`;
      setActiveRoomId(newRoom);
      setCinemaRoomId(newRoom);
    } else {
      setActiveRoomId(cinemaRoomId);
    }
    (async () => { await Brightness.requestPermissionsAsync(); })();
  }, [params.roomId, user]);

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
    hideTimer.current = setTimeout(hideUI, 5000);
  };

  const hideUI = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
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
          player.volume = newV;
          setIndicatorText(`音量 ${Math.round(newV * 100)}%`);
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (!player) return;
        setIndicatorText('');

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

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      
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
            <TouchableOpacity style={styles.immersiveIconBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsImmersive(false); }}>
              <Ionicons name="arrow-back" size={IS_ANDROID ? 24 : 26} color="#FFF" />
            </TouchableOpacity>
            
            <View style={styles.immersiveStatusPill}>
              <View style={[styles.immersiveStatusDot, { backgroundColor: partnerStatus.includes('对方') ? '#34C759' : '#8E8E93' }]} />
              <Text style={styles.immersiveStatusText}>{partnerStatus}</Text>
            </View>

            <TouchableOpacity style={styles.immersiveIconBtn} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); emitCommand('FORCE_SYNC', player?.currentTime || 0); }}>
              <Ionicons name="sync" size={IS_ANDROID ? 22 : 24} color="#34C759" />
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

              <TouchableOpacity onPress={() => { setShowInput(true); setControlsVisible(false); }} style={styles.danmakuBtn}>
                <Ionicons name="chatbox-ellipses" size={IS_ANDROID ? 20 : 24} color="#FFF" />
              </TouchableOpacity>
              
              <View
                onStartShouldSetResponder={() => true}
                onResponderGrant={() => {
                  if (!player) return;
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                  if (!player.playing) { player.play(); setIsPlaying(true); }
                  player.preservesPitch = true;
                  player.playbackRate = 2.0;
                  setIndicatorText('▶▶ 2.0x 快进中');
                  
                  if (hideTimer.current) clearTimeout(hideTimer.current);
                  hideTimer.current = setTimeout(hideUI, 1000);
                }}
                onResponderRelease={() => {
                  if (!player) return;
                  if (player.playbackRate === 2.0) {
                    player.playbackRate = 1.0;
                    setIndicatorText('');
                    emitCommand('FORCE_SYNC', player.currentTime);
                    showUI(); 
                  }
                }}
                onResponderTerminate={() => {
                  if (!player) return;
                  if (player.playbackRate === 2.0) {
                    player.playbackRate = 1.0;
                    setIndicatorText('');
                    emitCommand('FORCE_SYNC', player.currentTime);
                    showUI();
                  }
                }}
                style={[styles.danmakuBtn, { backgroundColor: 'transparent', paddingLeft: 8, paddingRight: 4 }]}
              >
                <Text style={styles.speedBtnText}>2X</Text>
              </View>
              
            </BlurView>
          </Animated.View>

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
  immersiveIconBtn: { padding: 10, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 24 },
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
  speedBtnText: { color: '#FFF', fontWeight: '800', fontSize: 16, fontStyle: 'italic' }, 

  inputOverlay: { position: 'absolute', width: '100%', height: '100%', justifyContent: 'flex-end', zIndex: 999 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(28,28,30,0.95)', paddingTop: 16 },
  input: { flex: 1, height: 44, backgroundColor: '#3A3A3C', borderRadius: 22, paddingHorizontal: 20, color: '#FFF', fontSize: 16 },
  sendBtn: { marginLeft: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: '#0A84FF', justifyContent: 'center', alignItems: 'center' }
});
// --- END OF FILE src/app/cinema.js ---