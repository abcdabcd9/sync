// --- START OF FILE src/components/MessageBubble.js ---
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useSignedMediaUrl, getMemoryCachedSignedUrl, buildPublicStorageUrl } from '../hooks/chat/useSignedMediaUrl';
import { getMemoryLocalMedia, resolveLocalMedia, isLocalUri, normalizeFileUri } from '../services/mediaCache';

/**
 * 🖼️ 固定尺寸媒体气泡（彻底消除列表上下抖动）
 *
 * 🚨 铁律：媒体气泡外框尺寸一旦挂载必须 100% 恒定，绝不允许在 onLoad 等
 *    任何回调里 setState 修改宽高。Android 上「先按默认尺寸渲染 → 图片加载完
 *    再改尺寸」会让 FlatList 重新测量行高，表现为整列消息上下跳动 + 图片闪烁。
 *    因此这里统一使用固定 135×180 的框，内部图片 cover 填满，多余部分裁掉。
 * 点击进入全屏预览时才由 InteractiveMediaViewer 用 contain 展示原图全貌。
 */
const MEDIA_BUBBLE_WIDTH = 135;
const MEDIA_BUBBLE_HEIGHT = 180;

export default React.memo(function MessageBubble({
  item, palette, onPreviewMedia, isPlaying, onToggleAudio, onLongPressMessage, onJoinCinema, onAcceptPartner, onRejectPartner, onResendMessage
}) {
  const isMe = item.isMe;
  let msgType = item.type || 'text';
  let displayText = item.text || '';
  let isCinemaEnded = false;

  // 🖼️ 气泡尺寸固定，不随图片加载结果变化（绝无 setState 改尺寸）。

  // 协议消息统一按 subtype 字段判断（text 只承载真实内容）
  if (item.subtype) {
    switch (item.subtype) {
      case 'SYNC_CINEMA_INVITE':
        msgType = 'cinema_invite';
        break;
      case 'SYNC_CINEMA_ENDED':
        msgType = 'cinema_invite';
        isCinemaEnded = true;
        break;
      case 'SYNC_PARTNER_INVITE':
        msgType = 'partner_invite';
        break;
      case 'SYNC_PARTNER_ACCEPTED':
        msgType = 'action';
        displayText = '你们已成为健康搭子！';
        break;
      case 'SYNC_PARTNER_REJECTED':
        msgType = 'action';
        displayText = '已拒绝健康搭子邀请';
        break;
      case 'SYNC_PARTNER_UNBOUND':
        msgType = 'action';
        displayText = '已解除健康守护伴侣关系';
        break;
      case 'SYNC_SYSTEM':
        msgType = 'action';
        break;
      default:
        break;
    }
  }

  // 🚨 P3-22 修复（撤回文案动态区分「你」与「对方」）：
  //   云端只存中立文案「撤回了一条消息」，本地乐观更新写「你撤回了一条消息」。
  //   若渲染到的是中立文案且这条消息不是当前用户发出的（!isMe），
  //   在 UI 上强制显示为「对方撤回了一条消息」，避免对方看到「你撤回了一条消息」。
  if (msgType === 'action' && !item.subtype && displayText === '撤回了一条消息' && !isMe) {
    displayText = '对方撤回了一条消息';
  }

  const bubbleRef = useRef(null);
  const [waveStep, setWaveStep] = useState(3);

  // 🔐 P0-2 / P0-3：数据库只存相对对象路径，渲染时按需换取签名 URL。
  //    历史数据若是完整签名 URL，Hook 内部会直接透传，保证不崩。
  //    注意：必须在本组件内部调用（组件是 React.memo），
  //    不能由父层批量解析，否则会破坏 memo 并导致全列表重渲染。
  //
  // 🚨 修复「发送观影邀请时刷屏 WARN 生成签名 URL 失败: 40.38,-5.76 Object not found」：
  //    历史 type='location' 消息把经纬度写进了 media_url，而本组件对所有类型都无条件
  //    调用 useSignedMediaUrl(item.mediaUrl)，于是把 "40.3881208,-5.7601863" 当成
  //    chat_media 桶内对象路径去 createSignedUrl，必然 404 并打日志。
  //    Hook 不能条件调用，因此这里按消息类型决定「是否真的需要签名」：
  //    只有 image / video / audio 才传真实值，其余一律传 null（Hook 内部直接短路）。
  const needsMedia = msgType === 'image' || msgType === 'video' || msgType === 'audio';

  // 🗄️ 本地沙盒优先（第 0 帧同步读取内存索引，绝不阻塞渲染）。
  //    这是离线可用的根本保证：只要曾经落盘过，断网也 100% 命中本地 file://。
  const mediaKind = msgType === 'audio' ? 'audio' : msgType === 'video' ? 'video' : 'image';
  const [sandboxUri, setSandboxUri] = useState(() => getMemoryLocalMedia(item.id, mediaKind));
  const [sandboxThumbUri, setSandboxThumbUri] = useState(() => getMemoryLocalMedia(item.id, 'thumb'));

  // 内存索引未命中时，异步探测磁盘（不阻塞首帧，命中后仅 setState 一次）
  useEffect(() => {
    if (!needsMedia || !item.id) return;
    let cancelled = false;
    if (!sandboxUri) {
      resolveLocalMedia(item.id, mediaKind).then((uri) => {
        if (!cancelled && uri) setSandboxUri(uri);
      }).catch(() => {});
    }
    if (!sandboxThumbUri && (msgType === 'video' || msgType === 'image')) {
      resolveLocalMedia(item.id, 'thumb').then((uri) => {
        if (!cancelled && uri) setSandboxThumbUri(uri);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [needsMedia, item.id, mediaKind, msgType, sandboxUri, sandboxThumbUri]);

  // 🎙️ 语音对象路径提取（对方发来的语音必须能签名成功）
  //
  // 🚨 核心修复：历史 / 兼容数据里语音的路径可能落在 item.text 上，
  //    且可能带 `[SYNC_AUDIO]` 前缀（协议标记）。若直接把整串拿去 createSignedUrl，
  //    必然 404 → 对方语音「点不动 / 播不出」。
  //    这里统一剥离前缀，并优先取 mediaUrl，其次 text。
  const rawAudioPath = (() => {
    if (msgType !== 'audio') return null;
    const candidates = [item.mediaUrl, item.text];
    for (const raw of candidates) {
      if (typeof raw !== 'string') continue;
      const cleaned = raw.replace(/^\[SYNC_AUDIO\]\s*/i, '').trim();
      if (cleaned) return cleaned;
    }
    return null;
  })();

  // 签名 URL 仅作为「本地缺失时的兜底」，且只对云端对象路径签名（本地 file:// 直接透传）
  const { url: signedMediaUrl } = useSignedMediaUrl(needsMedia ? item.mediaUrl : null);
  const { url: signedThumbUrl } = useSignedMediaUrl(needsMedia ? item.thumbnailUrl : null);
  // 🎙️ 语音专用签名（audioPath 已剥离 [SYNC_AUDIO] 前缀，保证对方语音可签名）
  const { url: signedAudioUrl } = useSignedMediaUrl(rawAudioPath);

  // 🖼️ 渲染优先级（本地绝对优先）：
  //    本地沙盒 file:// → item.localUri → item.uri → 签名 URL → 原始 mediaUrl
  //
  // 🔧 双端路径规范化（Android 关键修复）：
  //    Android 上 documentDirectory 本身已带 `file:///`，若业务层再拼一次 `file://`
  //    会得到 `file://file:///data/user/0/...` 重复前缀。iOS 加载器能容忍，
  //    但 Android 原生 Glide / ExpoImage 会直接报错返回空白。
  //    因此这里统一用 isLocalUri 判定（兼容 content:// / data: / ph://），
  //    并用 normalizeFileUri 清洗为单重 `file:///...` 规范路径。
  const rawDisplayUri = sandboxUri
    || item.localUri
    || item.uri
    || null;
  const displayUri = (isLocalUri(rawDisplayUri) ? normalizeFileUri(rawDisplayUri) : null)
    || signedMediaUrl
    || item.mediaUrl
    || null;

  const rawDisplayThumbUri = sandboxThumbUri
    || item.localThumbUri
    || sandboxUri
    || item.localUri
    || item.uri
    || null;
  const displayThumbUri = (isLocalUri(rawDisplayThumbUri) ? normalizeFileUri(rawDisplayThumbUri) : null)
    || item.thumbnailUrl
    || signedThumbUrl
    || signedMediaUrl
    || item.mediaUrl
    || null;

  // 🎬 视频小气泡封面（对方发来的视频：thumbnailUrl 是云端相对路径，必须签名后才能加载）
  //
  // 🚨 核心修复：旧实现把未签名的相对路径（如 `chats/xxx_thumb.jpg`）直接交给 <Image>，
  //    原生引擎无法解析 → 小气泡封面空白；而全屏能播是因为全屏组件对视频 URL 做了签名。
  //    这里按「可立即渲染优先」解析：
  //      ① signedThumbUrl（Hook 异步签名结果，最权威）
  //      ② getMemoryCachedSignedUrl(item.thumbnailUrl)（第 0 帧同步缓存，Modal/列表秒开）
  //      ③ 沙盒缩略图（自己发送时落盘的本地物理文件，离线可用）
  //      ④ item.localThumbUri（发送时落盘的本地路径）
  //      ⑤ item.thumbnailUrl（最后兜底：历史数据可能已是完整签名 URL）
  //    本地路径统一经 normalizeFileUri 清洗（Android 重复 file:// 前缀会直接空白）。
  const rawVideoPosterLocal = sandboxThumbUri || item.localThumbUri || null;
  const videoPosterUri = signedThumbUrl
    || getMemoryCachedSignedUrl(item.thumbnailUrl)
    || (isLocalUri(rawVideoPosterLocal) ? normalizeFileUri(rawVideoPosterLocal) : null)
    || item.thumbnailUrl
    || null;

  // ❗ 发送失败状态（离线发送 / 上传中断）：展示红色感叹号，点击可重发
  const isFailed = item.status === 'failed' || item.status === 'error';

  useEffect(() => {
    let animInterval;
    if (isPlaying && msgType === 'audio') {
      let currentStep = 1;
      setWaveStep(currentStep);
      animInterval = setInterval(() => {
        currentStep = currentStep >= 3 ? 1 : currentStep + 1;
        setWaveStep(currentStep);
      }, 300);
    } else {
      setWaveStep(3); 
    }
    return () => clearInterval(animInterval);
  }, [isPlaying, msgType]);

  // 🎙️ 语音播放：断网（飞行模式）下 100% 使用本地 file:// 物理文件。
  //
  // 🚨 核心修复：旧实现把「签名 URL / 云端网络 URL」直接交给音频引擎，
  //    飞行模式下音频引擎连不上网络 → 直接抛错 → 语音条点不动。
  //    现在播放前一刻按优先级解析：
  //      ① 沙盒物理文件（resolveLocalMedia 磁盘探测，最权威）
  //      ② item.localUri（发送时落盘的本地路径）
  //      ③ item.uri（历史本地路径）
  //    只要命中且以 file:// 开头，就必定是手机本地物理文件 → 飞行模式零网络播放。
  //    只有本地全部缺失（例如对方发来的语音尚未下载）才回落到签名 URL。
  const handlePlayAudio = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // ① 同步内存索引（0 毫秒）
    let localSandboxPath = sandboxUri || getMemoryLocalMedia(item.id, 'audio');
    // ② 内存未命中 → 磁盘探测沙盒（异步，但只在点击时执行一次）
    if (!localSandboxPath) {
      try {
        localSandboxPath = await resolveLocalMedia(item.id, 'audio');
      } catch (_) {}
    }
    // ③ 沙盒未命中 → 消息自带的本地路径
    if (!localSandboxPath) {
      localSandboxPath = item.localUri || item.uri || null;
    }

    // 🔧 双端兼容：isLocalUri 同时接受 file:// / content:// / data: / ph://，
    //    并用 normalizeFileUri 收敛为单重 file:///（Android 重复前缀会导致音频引擎报错）。
    const isLocalFile = isLocalUri(localSandboxPath);
    const localPlayUri = isLocalFile ? normalizeFileUri(localSandboxPath) : null;

    // 🌐 云端兜底链（本地全部缺失时，例如对方发来的语音尚未落盘）：
    //    ① signedAudioUrl（audioPath 已剥离 [SYNC_AUDIO] 前缀的签名结果，最权威）
    //    ② getMemoryCachedSignedUrl(rawAudioPath)（第 0 帧同步缓存，秒开）
    //    ③ signedMediaUrl（mediaUrl 的签名结果）
    //    ④ buildPublicStorageUrl(rawAudioPath)（公共存储 URL 兜底，避免彻底播不出）
    //    ⑤ item.mediaUrl（历史数据可能已是完整签名 URL）
    const cloudPlayUri = signedAudioUrl
      || getMemoryCachedSignedUrl(rawAudioPath)
      || signedMediaUrl
      || buildPublicStorageUrl(rawAudioPath)
      || item.mediaUrl
      || null;

    const audioUri = localPlayUri || cloudPlayUri;

    if (!audioUri) return;
    // 把「是否为本地物理文件」一并交给上层，便于上层决定是否需要落盘缓存
    onToggleAudio(item.id, audioUri, { isLocal: !!localPlayUri });
  };
  const getAudioIcon = () => {
    if (waveStep === 1) return isMe ? "volume-off-outline" : "volume-off";
    if (waveStep === 2) return isMe ? "volume-low-outline" : "volume-low";
    return isMe ? "volume-high-outline" : "volume-high";
  };

  if (msgType === 'action' || msgType === 'system') return <View style={styles.actionMessageContainer}><Text style={styles.actionMessageText}>{displayText}</Text></View>;

  if (msgType === 'cinema_invite') {
    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowMe : styles.messageRowOther]}>
        <View style={[styles.cinemaCard, { backgroundColor: palette.card, borderColor: isCinemaEnded ? palette.separator : palette.primary }]}>
          <View style={styles.cinemaCardHeader}>
            <Ionicons name="film" size={24} color={isCinemaEnded ? palette.textSecondary : palette.primary} />
            <Text style={[styles.cinemaCardTitle, { color: isCinemaEnded ? palette.textSecondary : palette.textPrimary }]}>邀请同步观影</Text>
          </View>
          <Text style={[styles.cinemaCardSub, { color: palette.textSecondary }]}>{isCinemaEnded ? '本次同步放映已结束' : '发起了一个专属私人放映室'}</Text>
          <TouchableOpacity style={[styles.cinemaJoinBtn, { backgroundColor: isCinemaEnded ? palette.separator : palette.primary }]} onPress={() => onJoinCinema(displayText)} activeOpacity={isCinemaEnded ? 1 : 0.8} disabled={isCinemaEnded}>
            <Text style={[styles.cinemaJoinText, { color: isCinemaEnded ? palette.textSecondary : '#FFFFFF' }]}>{isCinemaEnded ? '已失效' : '点击加入'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // 🗑️ 地图卡片功能已下线：type='location' 的历史消息降级为普通文本气泡，
  //    避免旧数据在列表里变成空白。新消息不会再产生该类型。

  if (msgType === 'partner_invite') {
    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowMe : styles.messageRowOther]}>
        <View style={[styles.cinemaCard, { backgroundColor: palette.card, borderColor: palette.primary }]}>
          <View style={styles.cinemaCardHeader}>
            <Ionicons name="heart" size={24} color={palette.primary} />
            <Text style={[styles.cinemaCardTitle, { color: palette.textPrimary }]}>健康搭子邀请</Text>
          </View>
          <Text style={[styles.cinemaCardSub, { color: palette.textSecondary }]}>{isMe ? '已发送健康守护伴侣邀请，等待对方同意' : '邀请你成为健康守护伴侣，互相监督打卡与喝水！'}</Text>
          {!isMe && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={[styles.actionBtn, { flex: 1, backgroundColor: palette.separator }]} onPress={() => onRejectPartner(item)}><Text style={{ color: palette.textPrimary, textAlign: 'center', fontWeight: 'bold' }}>拒绝</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, { flex: 1, backgroundColor: palette.primary }]} onPress={() => onAcceptPartner(item)}><Text style={{ color: '#FFF', textAlign: 'center', fontWeight: 'bold' }}>同意</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.messageRow, isMe ? styles.messageRowMe : styles.messageRowOther]}>
      <View ref={bubbleRef} style={styles.bubbleWrapper}>
        <Pressable 
          android_ripple={{ color: 'rgba(0,0,0,0.15)', borderless: false }} 
          style={({ pressed }) => {
            const isMedia = msgType === 'image' || msgType === 'video';
            return [
              styles.bubble, isMe ? styles.bubbleMe : styles.bubbleOther, 
              { 
                backgroundColor: isMedia ? 'transparent' : (isMe ? palette.primary : palette.card), 
                borderTopLeftRadius: isMedia ? 16 : 20, borderTopRightRadius: isMedia ? 16 : 20,
                borderBottomRightRadius: isMedia ? 16 : (isMe ? 4 : 20), borderBottomLeftRadius: isMedia ? 16 : (isMe ? 20 : 4), 
                paddingHorizontal: isMedia ? 0 : 16, paddingVertical: isMedia ? 0 : 10,
                opacity: (pressed && Platform.OS === 'ios') ? 0.8 : 1
              }
            ];
          }}
          delayLongPress={250}
          onLongPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            bubbleRef.current.measure((x, y, width, height, pageX, pageY) => { if (onLongPressMessage) onLongPressMessage({ ...item, layout: { pageX, pageY, width, height } }); });
          }}
          onPress={() => { if (msgType === 'audio') handlePlayAudio(); if (msgType === 'image' || msgType === 'video') onPreviewMedia(item); }}
        >
          {msgType === 'text' && <Text style={[styles.messageText, { color: isMe ? '#FFFFFF' : palette.textPrimary }]}>{displayText}</Text>}
          {msgType === 'audio' && (
            <View style={[styles.audioBubble, { flexDirection: isMe ? 'row-reverse' : 'row', width: Math.min(60 + (item.duration || 1) * 8, 220) }]}>
              <Ionicons name={getAudioIcon()} size={22} color={isMe ? '#FFFFFF' : palette.textPrimary} style={isMe ? { transform: [{ rotate: '180deg' }] } : {}} />
              <Text style={[styles.audioDurationText, { color: isMe ? '#FFFFFF' : palette.textPrimary }]}>{`${item.duration || 0}"`}</Text>
            </View>
          )}
          {(msgType === 'image' || msgType === 'video') && (
            <View
              style={{
                width: MEDIA_BUBBLE_WIDTH,
                height: MEDIA_BUBBLE_HEIGHT,
                borderRadius: 12,
                overflow: 'hidden',
                backgroundColor: '#1a1a1a',
              }}
            >
              {msgType === 'image' && displayUri && (
                <Image
                  source={{ uri: displayUri }}
                  style={styles.bubbleMedia}
                  // 🚨 双保险：同时传 resizeMode 与 contentFit。
                  //    气泡内统一 cover 填满圆角框，彻底消除黑色留白。
                  resizeMode="cover"
                  contentFit="cover"
                  // ⚡ Android 淡入闪烁修复：关闭过渡动画
                  transition={0}
                />
              )}
              {msgType === 'video' && (
                <>
                  {videoPosterUri && (
                    <Image
                      source={{ uri: videoPosterUri }}
                      style={styles.bubbleMedia}
                      // 🚨 双保险：缩略图统一 cover 填满气泡
                      resizeMode="cover"
                      contentFit="cover"
                      // ⚡ Android 淡入闪烁修复：关闭过渡动画
                      transition={0}
                    />
                  )}
                  <View style={styles.playIconOverlay}><Ionicons name="play-circle" size={54} color="rgba(255, 255, 255, 0.85)" /></View>
                </>
              )}
              {/* 🚫 连本地路径都没有时，给出明确的占位提示，绝不留下透明空白框 */}
              {!displayUri && !displayThumbUri && !videoPosterUri && (
                <View style={styles.mediaFallback}>
                  <Ionicons name="image-outline" size={32} color="rgba(255,255,255,0.6)" />
                  <Text style={styles.mediaFallbackText}>图片暂不可用</Text>
                </View>
              )}
            </View>
          )}
        </Pressable>

        {/* ❗ 发送失败：红色感叹号（仅发送者侧），点击触发重发 */}
        {isMe && isFailed && (
          <TouchableOpacity
            style={styles.failedBadge}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onResendMessage?.(item);
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="发送失败，点击重发"
          >
            <Ionicons name="alert-circle" size={20} color="#FF3B30" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  messageRow: { flexDirection: 'row', marginBottom: 16, alignItems: 'center' }, messageRowMe: { justifyContent: 'flex-end' }, messageRowOther: { justifyContent: 'flex-start' },
  bubbleWrapper: { maxWidth: '75%', overflow: 'hidden', borderRadius: 20 }, bubble: { borderRadius: 20 }, bubbleMe: { marginLeft: 40 }, bubbleOther: { marginRight: 40 },
  failedBadge: { marginRight: 6, justifyContent: 'center', alignItems: 'center' },
  mediaFallback: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6 },
  mediaFallbackText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '500' },
  messageText: { fontSize: 16, lineHeight: 22 }, audioBubble: { alignItems: 'center', justifyContent: 'space-between', minWidth: 60, height: 22 }, audioDurationText: { fontSize: 16, marginHorizontal: 8, fontWeight: '500' }, 
  bubbleMedia: { width: '100%', height: '100%' }, playIconOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  actionMessageContainer: { alignItems: 'center', marginVertical: 12 }, actionMessageText: { fontSize: 12, color: '#888888', backgroundColor: 'rgba(150,150,150,0.15)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', fontWeight: '500' },
  cinemaCard: { width: 240, padding: 16, borderRadius: 20, borderWidth: 1 }, cinemaCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 }, cinemaCardTitle: { fontSize: 16, fontWeight: 'bold', marginLeft: 8 }, cinemaCardSub: { fontSize: 13, marginBottom: 16 }, cinemaJoinBtn: { paddingVertical: 10, borderRadius: 12, alignItems: 'center' }, cinemaJoinText: { fontSize: 15, fontWeight: 'bold' }, actionBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
});
// --- END OF FILE src/components/MessageBubble.js ---