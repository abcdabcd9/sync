// --- START OF FILE src/components/InteractiveMediaViewer.js ---
import React, { useRef, useState, useEffect, useMemo } from 'react';
import { 
  View, StyleSheet, Dimensions, Animated, PanResponder, ScrollView, 
  TouchableWithoutFeedback, Image, FlatList, TouchableOpacity, Platform, Text, Pressable, StatusBar 
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useSignedMediaUrl, getMemoryCachedSignedUrl, buildPublicStorageUrl } from '../hooks/chat/useSignedMediaUrl';
import { getMemoryLocalMedia, resolveLocalMedia, isLocalUri, normalizeFileUri, downloadToSandbox } from '../services/mediaCache';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * 🔒 安全审计 #14：从签名 URL 中推断真实文件扩展名
 *
 * Supabase 私有桶的签名 URL 形如：
 *   https://xxx.supabase.co/storage/v1/object/sign/chat_media/img_123.jpg?token=eyJ...
 * 路径部分仍保留原始文件名，因此先剥离 query/hash 再取扩展名；
 * 若扩展名非法（含 token 片段、过长、非字母数字），回退到 fallback。
 */
const inferFileExt = (url, fallback = 'jpg') => {
  try {
    const pathOnly = url.split('?')[0].split('#')[0];
    const raw = pathOnly.split('/').pop() || '';
    const ext = raw.includes('.') ? raw.split('.').pop().toLowerCase() : '';
    if (ext && /^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch (_) {}
  return fallback;
};

const handleDownloadMedia = async (url, onSuccess, onError) => {
  try {
    if (!url) { onError('媒体地址无效'); return; }

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
    // 🔒 安全审计 #14：签名 URL 同样是 http(s) 远程地址，走下载分支即可正常保存；
    //    扩展名需从「剥离 token 后的路径」推断，避免生成 xxx.jpg?token=... 的非法文件名。
    if (url.startsWith('http')) {
      const fileExt = inferFileExt(url, 'jpg');
      const target = new File(Paths.cache, `temp_dl_${Date.now()}.${fileExt}`);

      // SDK 58 标准 API：File.downloadFileAsync 替代已废弃的 FileSystem.downloadAsync
      tempFile = await File.downloadFileAsync(url, target, { idempotent: true });
      localUri = tempFile.uri;
    }

    // SDK 58 标准 API：Asset.create 替代已废弃的 saveToLibraryAsync
    await Asset.create(localUri);

    if (tempFile) {
      try { tempFile.delete(); } catch (_) {}
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSuccess('已成功保存到系统相册');
  } catch (e) {
    console.error("下载失败:", e);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    onError('保存失败');
  }
};

const CustomVideoPlayer = ({ url, posterUrl, isActive, showToast, onSeekingChange }) => {
  // ⚡ 性能优化：视频播放器按需懒加载。
  //    只有当前激活卡片（isActive === true）才真正挂载 VideoPlayerCore，
  //    非激活卡片只渲染缩略图封面，避免打开弹窗时后台同时创建多个播放器卡爆 JS 线程。
  if (!isActive) {
    return <View style={styles.mediaContainer} />;
  }
  return <VideoPlayerCore url={url} posterUrl={posterUrl} isActive={isActive} showToast={showToast} onSeekingChange={onSeekingChange} />;
};

const VideoPlayerCore = ({ url, posterUrl, isActive, showToast, onSeekingChange }) => {
  // 🔧 双端路径兜底清洗：视频源同样必须收敛为单重 file:///（Android 重复前缀会直接黑屏）。
  const safeVideoUrl = normalizeFileUri(url) || url;
  const safePosterUrl = normalizeFileUri(posterUrl) || posterUrl;

  const [isPlaying, setIsPlaying] = useState(isActive);
  // ⚡ 视频封面占位：缓冲期间先显示封面图，真正开始播放后才隐藏，避免纯黑屏等待。
  //    封面源与视频源相同时（本地视频 / 秒开源）不叠加，避免重复解码拖慢首帧。
  const [posterVisible, setPosterVisible] = useState(!!safePosterUrl && safePosterUrl !== safeVideoUrl);
  const [showControls, setShowControls] = useState(false);
  const [controlsOpacity] = useState(() => new Animated.Value(0));
  
  const [progress, setProgress] = useState(0);
  const [timeStr, setTimeStr] = useState({ current: '00:00', duration: '00:00' });
  
  const controlsTimeoutRef = useRef(null);
  const trackWidthRef = useRef(1);
  const isSeeking = useRef(false);
  const seekStartProgress = useRef(0);
  // 🚨 P3-27 修复（拖动进度条闭包陷阱）：
  //   seekPanResponder 由 useMemo 创建且依赖仅 [player]，回调闭包捕获的是创建时的
  //   progress / isPlaying 值（恒为初始值 0 / 初始播放态），松手时会把播放器 seek 回 0。
  //   这里用 ref 镜像最新值，回调内只读 ref，彻底消除过时闭包。
  const progressRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const player = useVideoPlayer(safeVideoUrl, (p) => {
    p.loop = true;
    if (isActive) p.play();
  });

  useEffect(() => {
    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
    Animated.timing(controlsOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => setShowControls(false));
  }, [isActive, player, controlsOpacity]);

  // ⚡ 监听播放器状态：真正开始播放（playing === true）时才隐藏封面
  useEffect(() => {
    const sub = player.addListener('playingChange', ({ isPlaying: playing }) => {
      if (playing) setPosterVisible(false);
    });
    return () => {
      try { sub?.remove?.(); } catch (_) {}
    };
  }, [player]);

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

  const seekPanResponder = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs
    const panResponder = PanResponder.create({
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
        progressRef.current = p;
        setProgress(p);
        // eslint-disable-next-line react-hooks/immutability
        player.currentTime = p * (player.duration || 0);
      },
      onPanResponderMove: (e, gestureState) => {
        let p = seekStartProgress.current + (gestureState.dx / trackWidthRef.current);
        p = Math.max(0, Math.min(1, p));
        progressRef.current = p;
        setProgress(p);
      },
      onPanResponderRelease: () => {
        isSeeking.current = false;
        onSeekingChange(false);
        // 🚨 P3-27：不读取闭包中的 progress，改用始终最新的 progressRef.current
        //    （onPanResponderMove 已把最终比例写入 ref），避免松手时 seek 回旧值。
        const finalProgress = Math.max(0, Math.min(1, progressRef.current));
        // eslint-disable-next-line react-hooks/immutability
        player.currentTime = finalProgress * (player.duration || 0);
        if (isPlayingRef.current) player.play();
        resetControlsTimer();
      },
      onPanResponderTerminate: () => {
        isSeeking.current = false;
        onSeekingChange(false);
        if (isPlayingRef.current) player.play();
        resetControlsTimer();
      },
    });
    return panResponder;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

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
          {/* ⚡ 封面占位层：视频缓冲期间显示，开始播放后卸载，第 0 毫秒绝不黑屏 */}
          {posterVisible && safePosterUrl && (
            <Image
              source={{ uri: safePosterUrl }}
              style={[StyleSheet.absoluteFill, styles.fullScreenMedia]}
              resizeMode="contain"
              contentFit="contain"
              transition={0}
              cachePolicy="memory-disk"
            />
          )}
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

const CustomImagePlayer = ({ url, placeholderUrl, isZoomed, setIsZoomed, showToast, onClose }) => {
  const scrollRef = useRef(null);
  const lastTap = useRef(0);
  const tapTimer = useRef(null);
  // ⚡ 性能优化：高清原图加载完成前，先用聊天框现成缩略图占位，
  //    保证 Modal 打开的第 0 毫秒就有图，绝不留纯黑屏等待。
  const [highResLoaded, setHighResLoaded] = useState(false);

  // 🔧 双端路径兜底清洗：即使上游漏了规范化，这里也保证交给原生引擎的
  //    一定是单重 `file:///...`（Android Glide 遇 `file://file:///` 直接空白）。
  //    content:// / data: / http(s) 原样透传，绝不改写。
  const safeUrl = normalizeFileUri(url) || url;
  const safePlaceholder = normalizeFileUri(placeholderUrl) || placeholderUrl;

  // 🚨 分层渲染铁律：底层小图必须「无条件」渲染，绝不因任何判断被隐藏。
  //    上一版用 `placeholderIsSame` 判断「占位源 == 主图源」就隐藏占位层，
  //    结果当秒开源恰好等于主图源时占位层被彻底卸载，组件只能死等 10MB 高清大图
  //    网络下载 → 3~5 秒纯黑屏。此处彻底废弃该条件。
  //    小图地址优先级：占位源（缩略图 / 同步缓存）> 主图源，保证永远有值可渲染。
  const thumbUri = safePlaceholder || safeUrl;
  // 仅当「小图地址」与「高清地址」确实是同一张图时，才跳过重复叠加解码（纯性能优化，
  // 不影响可见性：此时高清层本身就是那张小图，第 0 帧照样有画面）。
  const thumbIsSameAsHighRes = !!thumbUri && thumbUri === safeUrl;
  // 底层小图渲染条件：有地址 + 高清未就绪 + 不是同一张图（避免重复解码）
  const showThumbLayer = !!thumbUri && !highResLoaded && !thumbIsSameAsHighRes;

  // 🖼️ 全屏看图（彻底解决拉伸 / 裁剪）：
  //    不做任何 JS 尺寸手算（不读 naturalSize、不调 Image.getSize、不写 scale 公式）。
  //    容器固定为整屏 + 居中 + 纯黑背景，图片固定 100% x 100% 并强制 contain，
  //    完全交给 iOS / Android 原生渲染引擎等比缩放：
  //      · 电脑 1080p 横图 → 居中显示，左右贴边或留极小边，上下自然露出黑边；
  //      · 竖长图 → 上下留黑边，整张图 100% 完整可见；
  //      · 绝不 cover 截断、绝不拉伸变形、绝不切角裁边。
  const handleImagePress = () => {
    const now = Date.now();
    // 双击判定窗口 250ms（原 300ms 偏长，容易把两次单击误判成双击）
    if (now - lastTap.current < 250) {
      // 🚨 关键修复：第一击挂载的「单击关闭」定时器必须在此彻底清除，
      //    否则双击放大后定时器仍会触发 onClose()，导致预览被误关。
      if (tapTimer.current) {
        clearTimeout(tapTimer.current);
        tapTimer.current = null;
      }
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
      tapTimer.current = setTimeout(() => {
        tapTimer.current = null;
        onClose();
      }, 250);
    }
    lastTap.current = now;
  };

  return (
    <View style={styles.imageStage}>
      <ScrollView
        ref={scrollRef}
        // ⚠️ Android 关键修复：contentContainerStyle 里绝不能用 `flex: 1`。
        //    ScrollView 的内容容器在 Android 上高度由内容决定，`flex: 1` 会解析为 0，
        //    导致图片被压成 0 高度 → 全屏预览「完全看不到东西」（iOS 无此问题）。
        //    这里改用显式整屏宽高 + 居中，两端行为一致。
        contentContainerStyle={styles.imageScrollContent}
        maximumZoomScale={3} minimumZoomScale={1} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} bouncesZoom={true}
        onScroll={(e) => {
          const scale = e.nativeEvent.zoomScale || 1;
          setIsZoomed(scale > 1.05);
        }}
        scrollEventThrottle={16}
      >
        <TouchableWithoutFeedback onPress={handleImagePress}>
          <View style={styles.imageFull}>
            {/* 底层小图秒开层：第 0 毫秒无条件呈现（高清未就绪时），onLoad 后卸载 */}
            {showThumbLayer && (
              <Image
                source={{ uri: thumbUri }}
                style={[StyleSheet.absoluteFill, styles.imageFull]}
                resizeMode="contain"
                contentFit="contain"
                transition={0}
                cachePolicy="memory-disk"
              />
            )}
            <Image
              source={{ uri: safeUrl }}
              style={[
                styles.imageFull,
                Platform.OS === 'android' && isZoomed && { transform: [{ scale: 2 }] },
              ]}
              // 🚨 双保险：expo-image 认 contentFit，RN 原生 Image 认 resizeMode。
              //    两个都显式传入，杜绝某些平台/版本忽略 contentFit 后降级为 cover 顶满裁剪。
              resizeMode="contain"
              contentFit="contain"
              // ⚡ 关闭淡入动画，避免加载时闪烁 / 黑屏过渡
              transition={0}
              cachePolicy="memory-disk"
              onLoad={() => setHighResLoaded(true)}
            />
          </View>
        </TouchableWithoutFeedback>
      </ScrollView>

      <TouchableOpacity style={styles.imageFloatingDownload} onPress={() => handleDownloadMedia(safeUrl, showToast, showToast)} activeOpacity={0.7}>
        <Ionicons name="download-outline" size={22} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );
};

const GalleryItem = React.memo(function GalleryItem({ item, isActive, isZoomed, setIsZoomed, onClose, showToast, onSeekingChange }) {
  // 🔐 P0-2 / P0-3：数据库只存相对对象路径，渲染时按需换取签名 URL。
  //    必须在本组件内部解析（组件是 React.memo），不能由父层批量解析，
  //    否则会破坏 memo 并导致整个画廊重渲染。
  //    历史数据若是完整签名 URL，Hook 内部会直接透传，保证不崩。
  const { url: signedMediaUrl } = useSignedMediaUrl(item.mediaUrl);
  const { url: signedThumbUrl } = useSignedMediaUrl(item.thumbnailUrl);

  // 🗄️ 本地沙盒优先（第 0 帧同步读取内存索引，绝不阻塞渲染）。
  //    离线时签名 URL 必然为 null，但沙盒 file:// 仍可 100% 渲染。
  const mediaKind = item.type === 'video' ? 'video' : item.type === 'audio' ? 'audio' : 'image';
  const [sandboxUri, setSandboxUri] = useState(() => getMemoryLocalMedia(item.id, mediaKind));
  const [sandboxThumbUri, setSandboxThumbUri] = useState(() => getMemoryLocalMedia(item.id, 'thumb'));

  // 内存索引未命中时异步探测磁盘（不阻塞首帧，命中后仅 setState 一次）
  useEffect(() => {
    if (!item.id) return;
    let cancelled = false;
    if (!sandboxUri) {
      resolveLocalMedia(item.id, mediaKind).then((uri) => {
        if (!cancelled && uri) setSandboxUri(uri);
      }).catch(() => {});
    }
    if (!sandboxThumbUri) {
      resolveLocalMedia(item.id, 'thumb').then((uri) => {
        if (!cancelled && uri) setSandboxThumbUri(uri);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [item.id, mediaKind, sandboxUri, sandboxThumbUri]);

  // ⚡ 0.0 毫秒首帧秒开算法（同步内存缓存）
  //    ⚠️ 诊断：相对路径（如 chats/123.jpg）直接交给 expo-image，iOS 原生引擎会
  //    陷入约 3 秒的网络等待后才失败/回退 —— 这是图片秒开的最大元凶。
  //    ⚠️ iOS 的 ph:// / assets-library:// 是相册原生句柄，expo-image 无法直接加载，
  //    会卡约 5 秒后超时黑屏 —— getMemoryCachedSignedUrl 内部已对它们返回 null。
  //
  //    🚀 核心：这张图在聊天列表（MessageBubble）里刚刚渲染过，签名 URL 早已写入
  //    模块级 LRU 缓存。这里在「渲染函数第 0 帧」同步读取，无需等 useEffect 的
  //    异步 createSignedUrl，因此 Modal 打开的第 0 毫秒就能拿到可渲染地址。
  const instantUrl = getMemoryCachedSignedUrl(item.mediaUrl)
    || getMemoryCachedSignedUrl(item.thumbnailUrl)
    || getMemoryCachedSignedUrl(item.uri)
    || getMemoryCachedSignedUrl(item.url);

  // 🖼️ 首选渲染源（断网 / 飞行模式下 100% 本地物理文件）
  //
  // 🚨 核心修复 ①（iOS）：旧实现把「签名 URL / 云端网络 URL」排在前面，
  //    飞行模式下 signedMediaUrl 为 null，iOS 拿到空地址 → 全屏预览直接空白。
  //    现在严格按「本地物理文件优先」解析：
  //      ① 沙盒物理文件（resolveLocalMedia 磁盘探测，最权威）
  //      ② item.localUri（发送时落盘的本地路径）
  //      ③ item.uri（历史本地路径）
  //    只有本地全部缺失（对方发来且尚未下载）才回落到签名 URL / 原始 mediaUrl。
  //
  // 🚨 核心修复 ②（Android）：Android 上 documentDirectory 本身已带 `file:///`，
  //    若业务层再拼一次 `file://` 会得到 `file://file:///data/user/0/...` 重复前缀。
  //    iOS 加载器能容忍，但 Android 原生 Glide / ExpoImage 会直接报错返回空白。
  //    因此这里统一用 isLocalUri 判定（兼容 content:// / data: / ph://），
  //    并用 normalizeFileUri 清洗为单重 `file:///...` 规范路径。
  const rawLocalPath = sandboxUri || item.localUri || item.uri || null;
  const isLocalFile = isLocalUri(rawLocalPath);
  // 规范化后的本地路径（file:// 收敛为单重前缀；content:// 原样保留）
  const localSandboxPath = isLocalFile ? normalizeFileUri(rawLocalPath) : null;

  // 🎬 视频 / 图片云端兜底链（本地全部缺失时，例如对方发来的视频尚未落盘）：
  //    ① signedMediaUrl（Hook 异步签名结果，最权威）
  //    ② instantUrl（第 0 帧同步缓存，Modal 秒开）
  //    ③ buildPublicStorageUrl(item.mediaUrl)（公共存储 URL 兜底，避免彻底打不开）
  //    ④ item.mediaUrl（历史数据可能已是完整签名 URL）
  const cloudMediaUri = signedMediaUrl
    || instantUrl
    || buildPublicStorageUrl(item.mediaUrl)
    || item.mediaUrl
    || null;

  const primaryUri = isLocalFile ? localSandboxPath : cloudMediaUri;

  // 🎬 对方视频「后台静默落盘 → 本地秒播」闭环
  //
  // 背景：对方首次发来的视频在本地沙盒中并不存在，只能在线播放（受网络波动影响）。
  //      这里在「视频卡片被激活（isActive）」时，后台静默把云端视频下载到沙盒
  //      `chat_media/video/${item.id}.mp4`（downloadToSandbox 内部使用
  //      Paths.document 跨平台适配，绝不硬编码 iOS / Android 绝对路径）。
  //      下载成功后立刻把播放源切换为本地 file:// 物理文件 → 双端 100% 稳定秒播；
  //      下次打开或飞行模式下也会直接命中沙盒，达成 100% 离线播放。
  //
  // 🚨 UI 锁死：本逻辑只影响「播放源字符串」，不触碰任何样式 / 尺寸 / contain 比例。
  const [offlineVideoUri, setOfflineVideoUri] = useState(null);

  useEffect(() => {
    if (item.type !== 'video' || !item.id) return undefined;
    // 已是本地物理文件：无需下载
    if (isLocalFile) return undefined;
    // 非激活卡片不触发下载（避免打开弹窗时并发下载多个视频）
    if (!isActive) return undefined;
    // 没有可用的云端地址（离线且无缓存）：跳过
    if (!cloudMediaUri || !/^https?:\/\//i.test(cloudMediaUri)) return undefined;

    let cancelled = false;
    downloadToSandbox(cloudMediaUri, item.id, 'video')
      .then((localUri) => {
        if (cancelled || !localUri) return;
        const normalized = normalizeFileUri(localUri);
        if (normalized) setOfflineVideoUri(normalized);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [item.type, item.id, isActive, isLocalFile, cloudMediaUri]);

  // 🎬 最终播放源：本地沙盒（含刚下载完成的）绝对优先，其次云端地址
  const videoPlayUri = isLocalFile
    ? localSandboxPath
    : (offlineVideoUri || cloudMediaUri);

  // 即时占位源：本地沙盒缩略图 → localThumbUri → 本地主图 → 同步缓存 → 已签名缩略图
  // 🎬 视频封面兜底：对方发来的视频 thumbnailUrl 是云端相对路径，签名未回调时
  //    用 buildPublicStorageUrl 拼公共地址，避免封面彻底空白。
  const rawThumbPath = sandboxThumbUri || item.localThumbUri || null;
  const placeholderUrl = (isLocalUri(rawThumbPath) ? normalizeFileUri(rawThumbPath) : null)
    || (isLocalFile ? localSandboxPath : null)
    || instantUrl
    || signedThumbUrl
    || buildPublicStorageUrl(item.thumbnailUrl)
    || null;

  // 🚀 0.0 秒首帧：Modal 打开瞬间就把占位图挂上去（不等签名 URL 返回）。
  //    用「本地沙盒 > 同步缓存 > 已签名缩略图 > 首选源」的顺序，保证第 0 帧必有画面。
  const instantPoster = placeholderUrl || primaryUri;

  return (
    <View style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}>
      {item.type === 'image' ? (
        primaryUri ? (
          <CustomImagePlayer
            url={primaryUri}
            placeholderUrl={instantPoster}
            isZoomed={isZoomed}
            setIsZoomed={setIsZoomed}
            showToast={showToast}
            onClose={onClose}
          />
        ) : (
          <View style={styles.mediaContainer} />
        )
      ) : (
        isActive ? (
          videoPlayUri ? (
            <CustomVideoPlayer
              url={videoPlayUri}
              posterUrl={instantPoster}
              isActive={isActive}
              showToast={showToast}
              onSeekingChange={onSeekingChange}
            />
          ) : (
            <View style={styles.mediaContainer} />
          )
        ) : (
          <View style={styles.mediaContainer}>
            {instantPoster && (
              <Image
                source={{ uri: instantPoster }}
                style={styles.fullScreenMedia}
                resizeMode="contain"
                contentFit="contain"
                transition={0}
                cachePolicy="memory-disk"
              />
            )}
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

  const [pan] = useState(() => new Animated.ValueXY());
  const [entryAnim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.spring(entryAnim, { toValue: 1, friction: 9, tension: 80, useNativeDriver: true }).start();
  }, [entryAnim]);

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
  const [toastAnim] = useState(() => new Animated.Value(0));

  // 关闭去重：避免动画期间重复触发（双击 / 手势连击）
  const closingRef = useRef(false);

  const smoothClose = (dy, dx, vy) => {
    if (closingRef.current) return;
    closingRef.current = true;

    // ⚡ 零延迟退出：第 0 毫秒立即触发震动反馈，绝不放在动画结束回调里
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // ⚡ 极速解封：动画启动的同时立刻同步解封界面状态，
    //    让聊天界面瞬间恢复可操作（不等动画结束回调）。
    setIsZoomed(false);
    setIsScrubbing(false);
    isScrubbingRef.current = false;

    // 干脆利落的 150ms 退出动画（原生驱动，不阻塞 JS 线程）
    Animated.parallel([
      Animated.timing(pan, {
        toValue: { x: dx * 2 || 0, y: dy > 0 ? SCREEN_HEIGHT : -SCREEN_HEIGHT },
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(entryAnim, { toValue: 0, duration: 150, useNativeDriver: true })
    ]).start(() => onClose());
  };

  // eslint-disable-next-line react-hooks/refs
  const [panResponder] = useState(() =>
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
      },
    })
  );

  const [onViewableItemsChanged] = useState(
    () => ({ viewableItems }) => {
      if (viewableItems.length > 0) setCurrentIndex(viewableItems[0].index);
    }
  );
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 50 }));

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
          initialNumToRender={1}

          // ⚠️ Android 全屏预览空白的关键根因：
          //    removeClippedSubviews 会在 item 被判定「移出可视区」时把原生视图
          //    从视图树摘掉。本组件外层是 StyleSheet.absoluteFill + transform 动画，
          //    Android 的裁剪计算会误判所有 item 都不可见 → 全部被摘掉 → 一片黑。
          //    iOS 上该属性默认 false，所以 iOS 一直正常。
          //    这里统一关闭，改用 windowSize 控制内存（3 屏，足够）。
          removeClippedSubviews={false}

          renderItem={({ item, index }) => (
            <View style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}>
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
  // 图片舞台：整屏 + 居中 + 纯黑背景，交给原生引擎做 contain 等比缩放
  imageStage: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  // 图片 ScrollView 的内容容器：显式尺寸，绝不用 flex（Android 会解析为 0）
  imageScrollContent: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, justifyContent: 'center', alignItems: 'center' },
  // 图片本体：100% 铺满容器，配合 contentFit="contain" 由原生等比缩放，绝不裁切
  imageFull: { width: '100%', height: '100%' },
  fullScreenMedia: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
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