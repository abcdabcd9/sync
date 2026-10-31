// --- START OF FILE src/components/MessageBubble.js ---
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useSignedMediaUrl, getMemoryCachedSignedUrl, buildPublicStorageUrl } from '../hooks/chat/useSignedMediaUrl';
import { getMemoryLocalMedia, resolveLocalMedia, isLocalUri, normalizeFileUri } from '../services/mediaCache';

const MEDIA_BUBBLE_WIDTH = 135;
const MEDIA_BUBBLE_HEIGHT = 180;

export default React.memo(function MessageBubble({
  item, palette, onPreviewMedia, isPlaying, onToggleAudio, onLongPressMessage, onJoinCinema, onAcceptPartner, onRejectPartner, onResendMessage
}) {
  const isMe = item.isMe;
  let msgType = item.type || 'text';
  let displayText = item.text || '';
  let isCinemaEnded = false;

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

  if (msgType === 'action' && !item.subtype && displayText === '撤回了一条消息' && !isMe) {
    displayText = '对方撤回了一条消息';
  }

  const bubbleRef = useRef(null);
  const [waveStep, setWaveStep] = useState(3);

  const needsMedia = msgType === 'image' || msgType === 'video' || msgType === 'audio';

  const mediaKind = msgType === 'audio' ? 'audio' : msgType === 'video' ? 'video' : 'image';
  const [sandboxUri, setSandboxUri] = useState(() => getMemoryLocalMedia(item.id, mediaKind));
  const [sandboxThumbUri, setSandboxThumbUri] = useState(() => getMemoryLocalMedia(item.id, 'thumb'));

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

  const rawAudioPath = (() => {
    if (msgType !== 'audio' && item.subtype !== 'SYNC_AUDIO') return null;
    const candidates = [item.mediaUrl, item.text];
    for (const raw of candidates) {
      if (typeof raw !== 'string') continue;
      const cleaned = raw.replace(/^\[SYNC_AUDIO\]\s*/i, '').trim();
      if (cleaned) return cleaned;
    }
    return null;
  })();

  const { url: signedMediaUrl } = useSignedMediaUrl(needsMedia ? item.mediaUrl : null);
  const { url: signedThumbUrl } = useSignedMediaUrl(needsMedia ? item.thumbnailUrl : null);
  const { url: signedAudioUrl } = useSignedMediaUrl(rawAudioPath);

  const rawDisplayUri = sandboxUri || item.localUri || item.uri || null;
  const displayUri = (isLocalUri(rawDisplayUri) ? normalizeFileUri(rawDisplayUri) : null)
    || signedMediaUrl
    || item.mediaUrl
    || null;

  const rawDisplayThumbUri = sandboxThumbUri || item.localThumbUri || sandboxUri || item.localUri || item.uri || null;
  const displayThumbUri = (isLocalUri(rawDisplayThumbUri) ? normalizeFileUri(rawDisplayThumbUri) : null)
    || item.thumbnailUrl
    || signedThumbUrl
    || signedMediaUrl
    || item.mediaUrl
    || null;

  const rawVideoPosterLocal = sandboxThumbUri || item.localThumbUri || null;
  const videoPosterUri = signedThumbUrl
    || getMemoryCachedSignedUrl(item.thumbnailUrl)
    || (isLocalUri(rawVideoPosterLocal) ? normalizeFileUri(rawVideoPosterLocal) : null)
    || item.thumbnailUrl
    || null;

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

  const handlePlayAudio = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    let localSandboxPath = sandboxUri || getMemoryLocalMedia(item.id, 'audio');
    if (!localSandboxPath) {
      try {
        localSandboxPath = await resolveLocalMedia(item.id, 'audio');
      } catch (_) {}
    }
    if (!localSandboxPath) {
      localSandboxPath = item.localUri || item.uri || null;
    }

    const isLocalFile = isLocalUri(localSandboxPath);
    const localPlayUri = isLocalFile ? normalizeFileUri(localSandboxPath) : null;

    const cloudPlayUri = signedAudioUrl
      || getMemoryCachedSignedUrl(rawAudioPath)
      || signedMediaUrl
      || buildPublicStorageUrl(rawAudioPath)
      || item.mediaUrl
      || null;

    const audioUri = localPlayUri || cloudPlayUri;

    if (!audioUri) return;
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
            <Ionicons name="alert-circle" size={18} color="#FF3B30" />
          </TouchableOpacity>
        )}
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

  if (msgType === 'partner_invite') {
    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowMe : styles.messageRowOther]}>
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
            <Ionicons name="alert-circle" size={18} color="#FF3B30" />
          </TouchableOpacity>
        )}
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
      {/* ❗ 红色感叹号：居左放置且消除 40px 悬空留白，贴紧气泡外侧并垂直居中 */}
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
          <Ionicons name="alert-circle" size={18} color="#FF3B30" />
        </TouchableOpacity>
      )}

      <View ref={bubbleRef} style={styles.bubbleWrapper}>
        <Pressable 
          android_ripple={{ color: 'rgba(0,0,0,0.15)', borderless: false }} 
          style={({ pressed }) => {
            const isMedia = msgType === 'image' || msgType === 'video';
            return [
              styles.bubble, isMe ? styles.bubbleMe : styles.bubbleOther,
              // 🚨 消除 40px 悬空留白：发送失败时去掉 marginLeft: 40，让感叹号紧贴气泡外壁
              (isMe && isFailed) && { marginLeft: 2 },
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
                  resizeMode="cover"
                  contentFit="cover"
                  transition={0}
                />
              )}
              {msgType === 'video' && (
                <>
                  {videoPosterUri && (
                    <Image
                      source={{ uri: videoPosterUri }}
                      style={styles.bubbleMedia}
                      resizeMode="cover"
                      contentFit="cover"
                      transition={0}
                    />
                  )}
                  <View style={styles.playIconOverlay}><Ionicons name="play-circle" size={54} color="rgba(255, 255, 255, 0.85)" /></View>
                </>
              )}
              {!displayUri && !displayThumbUri && !videoPosterUri && (
                <View style={styles.mediaFallback}>
                  <Ionicons name="image-outline" size={32} color="rgba(255,255,255,0.6)" />
                  <Text style={styles.mediaFallbackText}>图片暂不可用</Text>
                </View>
              )}
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  messageRow: { flexDirection: 'row', marginBottom: 16, alignItems: 'center' }, messageRowMe: { justifyContent: 'flex-end' }, messageRowOther: { justifyContent: 'flex-start' },
  bubbleWrapper: { maxWidth: '75%', overflow: 'hidden', borderRadius: 20 }, bubble: { borderRadius: 20 }, bubbleMe: { marginLeft: 40 }, bubbleOther: { marginRight: 40 },
  failedBadge: { marginRight: 2, alignSelf: 'center', justifyContent: 'center', alignItems: 'center' },
  mediaFallback: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6 },
  mediaFallbackText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '500' },
  messageText: { fontSize: 16, lineHeight: 22 }, audioBubble: { alignItems: 'center', justifyContent: 'space-between', minWidth: 60, height: 22 }, audioDurationText: { fontSize: 16, marginHorizontal: 8, fontWeight: '500' }, 
  bubbleMedia: { width: '100%', height: '100%' }, playIconOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  actionMessageContainer: { alignItems: 'center', marginVertical: 12 }, actionMessageText: { fontSize: 12, color: '#888888', backgroundColor: 'rgba(150,150,150,0.15)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', fontWeight: '500' },
  cinemaCard: { width: 240, padding: 16, borderRadius: 20, borderWidth: 1 }, cinemaCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 }, cinemaCardTitle: { fontSize: 16, fontWeight: 'bold', marginLeft: 8 }, cinemaCardSub: { fontSize: 13, marginBottom: 16 }, cinemaJoinBtn: { paddingVertical: 10, borderRadius: 12, alignItems: 'center' }, cinemaJoinText: { fontSize: 15, fontWeight: 'bold' }, actionBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
});
// --- END OF FILE src/components/MessageBubble.js ---