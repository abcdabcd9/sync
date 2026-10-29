// --- START OF FILE src/components/InteractiveMediaViewer.js ---
import React, { useRef, useState, useEffect } from 'react';
import { 
  View, StyleSheet, Dimensions, Animated, PanResponder, ScrollView, 
  TouchableWithoutFeedback, Image, FlatList, TouchableOpacity, Platform, Text, Pressable, StatusBar 
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const handleDownloadMedia = async (url, onSuccess, onError) => {
  try {
    // 🍎 核心修复 2：彻底拦截流媒体格式，防止底层崩溃
    if (url.includes('.m3u8')) {
      onError('流媒体(M3U8)无法直接保存到本地');
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const { status } = await requestPermissionsAsync();
    if (status !== 'granted') { onError('相册权限被拒绝'); return; }

    let localUri = url;
    let tempFile = null;
    if (url.startsWith('http')) {
      const fileExt = url.split('.').pop().split('?')[0] || 'mp4';
      const target = new File(Paths.cache, `temp_dl_${Date.now()}.${fileExt}`);

      // SDK 58 标准 API：File.downloadFileAsync 替代已废弃的 FileSystem.downloadAsync
      tempFile = await File.downloadFileAsync(url, target, { idempotent: true });
      localUri = tempFile.uri;
    }

    // SDK 58 标准 API：Asset.create 替代已废弃的 saveToLibraryAsync
    await Asset.create(localUri);

    if (tempFile) {
      try { tempFile.delete(); } catch (e) {}
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSuccess('已成功保存到系统相册');
  } catch (e) {
    console.error("下载失败:", e);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    onError('保存失败');
  }
};

const CustomVideoPlayer = ({ url, isActive, showToast, onSeekingChange }) => {
  const [isPlaying, setIsPlaying] = useState(isActive);
  const [showControls, setShowControls] = useState(false);
  const controlsOpacity = useRef(new Animated.Value(0)).current;
  
  const [progress, setProgress] = useState(0);
  const [timeStr, setTimeStr] = useState({ current: '00:00', duration: '00:00' });
  
  const controlsTimeoutRef = useRef(null);
  const trackWidthRef = useRef(1);
  const isSeeking = useRef(false);
  const seekStartProgress = useRef(0);

  const player = useVideoPlayer(url, (p) => { 
    p.loop = true; 
    if (isActive) p.play();
  });

  useEffect(() => {
    if (isActive) {
      player.play();
      setIsPlaying(true);
      hideControlsImmediate(); 
    } else {
      player.pause();
      setIsPlaying(false);
      hideControlsImmediate();
    }
  }, [isActive, player]);

  useEffect(() => {
    let interval;
    if (isActive && isPlaying) {
      interval = setInterval(() => {
        if (isSeeking.current) return; 
        const cur = player.currentTime || 0;
        const dur = player.duration || 0;
        if (dur > 0) {
          setProgress(cur / dur);
          const format = (secs) => {
            const m = Math.floor(secs / 60);
            const s = Math.floor(secs % 60);
            return `${m}:${s < 10 ? '0' : ''}${s}`;
          };
          setTimeStr({ current: format(cur), duration: format(dur) });
        }
      }, 150);
    }
    return () => clearInterval(interval);
  }, [isActive, isPlaying, player]);

  const hideControlsImmediate = () => {
    Animated.timing(controlsOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => setShowControls(false));
  };

  const resetControlsTimer = () => {
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (!isSeeking.current) hideControlsImmediate();
    }, 3500);
  };

  const toggleControls = () => {
    if (showControls) {
      hideControlsImmediate();
    } else {
      setShowControls(true);
      Animated.timing(controlsOpacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      resetControlsTimer();
    }
  };

  const togglePlay = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (player.playing) {
      player.pause();
      setIsPlaying(false);
    } else {
      player.play();
      setIsPlaying(true);
    }
    resetControlsTimer();
  };

  const seekPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: (e) => {
        onSeekingChange(true); 
        isSeeking.current = true;
        player.pause();
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);

        const touchX = e.nativeEvent.locationX;
        let p = touchX / trackWidthRef.current;
        p = Math.max(0, Math.min(1, p));
        seekStartProgress.current = p;
        setProgress(p);
        player.currentTime = p * (player.duration || 0);
      },
      onPanResponderMove: (e, gestureState) => {
        let p = seekStartProgress.current + (gestureState.dx / trackWidthRef.current);
        p = Math.max(0, Math.min(1, p));
        setProgress(p);
      },
      onPanResponderRelease: () => {
        isSeeking.current = false;
        onSeekingChange(false); 
        player.currentTime = progress * (player.duration || 0);
        if (isPlaying) player.play();
        resetControlsTimer();
      },
      onPanResponderTerminate: () => {
        isSeeking.current = false;
        onSeekingChange(false);
        if (isPlaying) player.play();
        resetControlsTimer();
      }
    })
  ).current;

  return (
    <View style={styles.mediaContainer}>
      <TouchableWithoutFeedback onPress={toggleControls}>
        <View style={StyleSheet.absoluteFill}>
          <VideoView 
            style={styles.fullScreenMedia} 
            player={player} 
            allowsFullscreen={false} 
            nativeControls={false} 
            contentFit="contain" 
          />
          {!isPlaying && !showControls && (
            <View style={styles.purePlayIcon}>
              <Ionicons name="play" size={42} color="rgba(255,255,255,0.8)" style={{ marginLeft: 6 }} />
            </View>
          )}
        </View>
      </TouchableWithoutFeedback>
      
      {showControls && (
        <Animated.View style={[styles.bottomControlBar, { opacity: controlsOpacity }]}>
          <Pressable style={styles.controlBarInner} onPress={(e) => e.stopPropagation()}>
            <TouchableOpacity onPress={togglePlay} style={styles.playPauseBtn} activeOpacity={0.7}>
              <Ionicons name={isPlaying ? "pause" : "play"} size={20} color="#FFFFFF" style={{ marginLeft: isPlaying ? 0 : 2 }} />
            </TouchableOpacity>
            
            <Text style={styles.timeText}>{timeStr.current}</Text>
            
            <View 
              style={styles.progressBarContainer} 
              onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width || 1; }} 
              {...seekPanResponder.panHandlers}
            >
              <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${progress * 100}%` }]} />
                <View style={[styles.progressThumb, { left: `${progress * 100}%` }]} />
              </View>
            </View>
            
            <Text style={styles.timeText}>{timeStr.duration}</Text>

            <TouchableOpacity onPress={() => handleDownloadMedia(url, showToast, showToast)} style={styles.downloadBtnInside} activeOpacity={0.7}>
              <Ionicons name="download-outline" size={20} color="#FFFFFF" />
            </TouchableOpacity>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
};

const CustomImagePlayer = ({ url, isZoomed, setIsZoomed, showToast, onClose }) => {
  const scrollRef = useRef(null);
  const lastTap = useRef(0);
  const tapTimer = useRef(null);

  const handleImagePress = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      clearTimeout(tapTimer.current); 
      if (Platform.OS === 'ios') {
         const responder = scrollRef.current?.getScrollResponder();
         if (isZoomed) {
             responder?.scrollResponderZoomTo({ x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT, animated: true });
             setIsZoomed(false);
         } else {
             responder?.scrollResponderZoomTo({ x: SCREEN_WIDTH/4, y: SCREEN_HEIGHT/4, width: SCREEN_WIDTH/2, height: SCREEN_HEIGHT/2, animated: true });
             setIsZoomed(true);
         }
      } else { 
        setIsZoomed(!isZoomed); 
      }
    } else {
      tapTimer.current = setTimeout(() => { onClose(); }, 300); 
    }
    lastTap.current = now;
  };

  return (
    <View style={styles.mediaContainer}>
      <ScrollView
        ref={scrollRef} contentContainerStyle={styles.mediaContainer}
        maximumZoomScale={3} minimumZoomScale={1} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} bouncesZoom={true}
        onScroll={(e) => { 
          const scale = e.nativeEvent.zoomScale || 1;
          setIsZoomed(scale > 1.05); 
        }} 
        scrollEventThrottle={16}
      >
        <TouchableWithoutFeedback onPress={handleImagePress}>
          <Image source={{ uri: url }} style={[styles.fullScreenMedia, Platform.OS === 'android' && isZoomed && { transform: [{ scale: 2 }] }]} resizeMode="contain" />
        </TouchableWithoutFeedback>
      </ScrollView>

      <TouchableOpacity style={styles.imageFloatingDownload} onPress={() => handleDownloadMedia(url, showToast, showToast)} activeOpacity={0.7}>
        <Ionicons name="download-outline" size={22} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );
};

const GalleryItem = React.memo(({ item, isActive, isZoomed, setIsZoomed, onClose, showToast, onSeekingChange }) => {
  return (
    <View style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}>
      {item.type === 'image' ? (
        <CustomImagePlayer url={item.mediaUrl} isZoomed={isZoomed} setIsZoomed={setIsZoomed} showToast={showToast} onClose={onClose} />
      ) : (
        isActive ? (
          <CustomVideoPlayer url={item.mediaUrl} isActive={isActive} showToast={showToast} onSeekingChange={onSeekingChange} />
        ) : (
          <View style={styles.mediaContainer}>
            <Image source={{ uri: item.thumbnailUrl || item.mediaUrl }} style={styles.fullScreenMedia} resizeMode="contain" />
            <View style={styles.purePlayIcon}>
              <Ionicons name="play" size={42} color="rgba(255,255,255,0.8)" style={{ marginLeft: 6 }} />
            </View>
          </View>
        )
      )}
    </View>
  );
}, (prev, next) => prev.isActive === next.isActive && prev.isZoomed === next.isZoomed); 

export default function InteractiveMediaViewer({ mediaList, initialIndex, onClose }) {
  useEffect(() => {
    StatusBar.setHidden(true, 'fade');
    return () => StatusBar.setHidden(false, 'fade');
  }, []);

  const pan = useRef(new Animated.ValueXY()).current;
  const entryAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(entryAnim, { toValue: 1, friction: 9, tension: 80, useNativeDriver: true }).start();
  }, []);

  const bgOpacity = Animated.multiply(
    pan.y.interpolate({ inputRange: [-SCREEN_HEIGHT/2, 0, SCREEN_HEIGHT/2], outputRange: [0, 1, 0], extrapolate: 'clamp' }),
    entryAnim
  );

  const dragScale = pan.y.interpolate({ inputRange: [-SCREEN_HEIGHT/2, 0, SCREEN_HEIGHT/2], outputRange: [0.75, 1, 0.75], extrapolate: 'clamp' });
  const entryScale = entryAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] });
  
  const [isZoomed, setIsZoomed] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  
  const [isScrubbing, setIsScrubbing] = useState(false);
  const isScrubbingRef = useRef(false);

  const handleSeekingChange = (seeking) => { setIsScrubbing(seeking); isScrubbingRef.current = seeking; };
  
  const [toastMsg, setToastMsg] = useState('');
  const toastAnim = useRef(new Animated.Value(0)).current;

  const smoothClose = (dy, dx, vy) => {
    Animated.parallel([
      Animated.spring(pan, { 
        toValue: { x: dx * 2 || 0, y: dy > 0 ? SCREEN_HEIGHT : -SCREEN_HEIGHT }, 
        velocity: { x: 0, y: vy || 0 }, 
        friction: 20, tension: 100, useNativeDriver: true 
      }),
      Animated.timing(entryAnim, { toValue: 0, duration: 150, useNativeDriver: true })
    ]).start(() => onClose());
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (evt, gestureState) => {
        if (isScrubbingRef.current) return false;
        if (evt.nativeEvent.touches && evt.nativeEvent.touches.length > 1) return false;
        if (isZoomed) return false;

        const isVerticalDrag = Math.abs(gestureState.dy) > Math.abs(gestureState.dx) * 1.5;
        const triggerThreshold = Platform.OS === 'android' ? 35 : 15; 

        return isVerticalDrag && Math.abs(gestureState.dy) > triggerThreshold;
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (evt, gestureState) => {
        if (Math.abs(gestureState.dy) > 100 || Math.abs(gestureState.vy) > 1.2) {
          smoothClose(gestureState.dy, gestureState.dx, gestureState.vy); 
        } else { 
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start(); 
        }
      }
    })
  ).current;

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) setCurrentIndex(viewableItems[0].index);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const showToast = (msg) => {
    setToastMsg(msg);
    toastAnim.setValue(0);
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastAnim, { toValue: 0, duration: 250, useNativeDriver: true })
    ]).start();
  };

  const toastTranslateY = toastAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000000', opacity: bgOpacity }]} />
      
      <Animated.View 
        style={[{ flex: 1 }, { transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: dragScale }, { scale: entryScale }] }]}
        {...panResponder.panHandlers}
      >
        <FlatList
          data={mediaList}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled={true} 
          scrollEnabled={!isScrubbing && !isZoomed} 
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={initialIndex}
          getItemLayout={(data, index) => ({ length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          
          windowSize={3}
          maxToRenderPerBatch={2}
          initialNumToRender={2}
          
          // 🍎 核心修复 3：解除 iOS 平移时的离谱白块 BUG，针对 Android 维持内存回收
          removeClippedSubviews={Platform.OS === 'android'}

          renderItem={({ item, index }) => (
            <View style={{ width: SCREEN_WIDTH }}>
              <GalleryItem 
                item={item} 
                isActive={index === currentIndex} 
                isZoomed={isZoomed} setIsZoomed={setIsZoomed} 
                onClose={() => smoothClose(1, 0, 0)} 
                showToast={showToast} onSeekingChange={handleSeekingChange}
              />
            </View>
          )}
        />
      </Animated.View>

      <Animated.View style={[styles.toastContainer, { opacity: toastAnim, transform: [{ translateY: toastTranslateY }] }]} pointerEvents="none">
        <Ionicons name="checkmark-circle" size={20} color="#34C759" style={{ marginRight: 8 }} />
        <Text style={styles.toastText}>{toastMsg}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  mediaContainer: { flex: 1, width: SCREEN_WIDTH, height: SCREEN_HEIGHT, justifyContent: 'center', alignItems: 'center' },
  fullScreenMedia: { width: '100%', height: '100%' },
  purePlayIcon: { position: 'absolute', width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  bottomControlBar: { position: 'absolute', bottom: Platform.OS === 'ios' ? 44 : 32, alignSelf: 'center', width: SCREEN_WIDTH - 32 },
  controlBarInner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(25,25,25,0.85)', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10 },
  playPauseBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  timeText: { color: '#FFFFFF', fontSize: 13, fontVariant: ['tabular-nums'], width: 42, textAlign: 'center', fontWeight: '500' },
  progressBarContainer: { flex: 1, height: 36, justifyContent: 'center', marginHorizontal: 8 },
  progressBarTrack: { height: 4, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 2, position: 'relative' },
  progressBarFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#FFFFFF', borderRadius: 2 },
  progressThumb: { position: 'absolute', top: -5, width: 14, height: 14, borderRadius: 7, backgroundColor: '#FFFFFF', marginLeft: -7, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 4 },
  downloadBtnInside: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginLeft: 12 },
  imageFloatingDownload: { position: 'absolute', bottom: Platform.OS === 'ios' ? 50 : 36, right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', zIndex: 100 },
  toastContainer: { position: 'absolute', bottom: 120, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(40,40,40,0.95)', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 16, elevation: 10, zIndex: 999 },
  toastText: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' }
});
// --- END OF FILE src/components/InteractiveMediaViewer.js ---