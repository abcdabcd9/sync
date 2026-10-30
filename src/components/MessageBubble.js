// --- START OF FILE src/components/MessageBubble.js ---
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, TouchableOpacity, Linking, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useSignedMediaUrl } from '../hooks/chat/useSignedMediaUrl';

/**
 * 📍 解析位置消息里的坐标。
 * 新格式：mediaUrl = "lat,lng"；旧格式（历史数据）：text 里带 maps.google.com 链接。
 */
function parseLocationCoords(item) {
  const raw = typeof item.mediaUrl === 'string' ? item.mediaUrl.trim() : '';
  const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]) };

  const text = typeof item.text === 'string' ? item.text : '';
  const legacy = text.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (legacy) return { lat: Number(legacy[1]), lng: Number(legacy[2]) };
  return null;
}

/** 打开系统地图（iOS 用 Apple Maps，Android 用 geo: 交给用户默认地图） */
async function openInMaps(lat, lng, label) {
  const encoded = encodeURIComponent(label || `${lat},${lng}`);
  const url = Platform.select({
    ios: `http://maps.apple.com/?ll=${lat},${lng}&q=${encoded}`,
    android: `geo:${lat},${lng}?q=${lat},${lng}(${encoded})`,
    default: `https://maps.google.com/?q=${lat},${lng}`,
  });
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      await Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`);
      return;
    }
    await Linking.openURL(url);
  } catch (_) {
    Alert.alert('无法打开地图', '请检查是否安装了地图应用。');
  }
}

export default React.memo(function MessageBubble({ 
  item, palette, onPreviewMedia, isPlaying, onToggleAudio, onLongPressMessage, onJoinCinema, onAcceptPartner, onRejectPartner 
}) {
  const isMe = item.isMe;
  let msgType = item.type || 'text';
  let displayText = item.text || '';
  let isCinemaEnded = false;

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

  const bubbleRef = useRef(null);
  const [waveStep, setWaveStep] = useState(3);

  // 🔐 P0-2 / P0-3：数据库只存相对对象路径，渲染时按需换取签名 URL。
  //    历史数据若是完整签名 URL，Hook 内部会直接透传，保证不崩。
  //    注意：必须在本组件内部调用（组件是 React.memo），
  //    不能由父层批量解析，否则会破坏 memo 并导致全列表重渲染。
  const { url: signedMediaUrl } = useSignedMediaUrl(item.mediaUrl);
  const { url: signedThumbUrl } = useSignedMediaUrl(item.thumbnailUrl);

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

  // 🎙️ 语音播放：把「已签名 URL」传给父层播放器，绝不传相对路径
  const handlePlayAudio = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!signedMediaUrl) return;
    onToggleAudio(item.id, signedMediaUrl);
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

  if (msgType === 'location') {
    const pos = parseLocationCoords(item);
    const label = displayText || (pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : '位置');
    return (
      <View style={[styles.messageRow, isMe ? styles.messageRowMe : styles.messageRowOther]}>
        <Pressable
          style={({ pressed }) => [
            styles.locationCard,
            { backgroundColor: palette.card, borderColor: palette.cardBorder, opacity: pressed ? 0.85 : 1 },
          ]}
          disabled={!pos}
          onPress={() => {
            if (!pos) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            openInMaps(pos.lat, pos.lng, label);
          }}
          onLongPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            bubbleRef.current?.measure((x, y, width, height, pageX, pageY) => {
              if (onLongPressMessage) onLongPressMessage({ ...item, layout: { pageX, pageY, width, height } });
            });
          }}
          delayLongPress={250}
        >
          <View ref={bubbleRef} style={styles.locationHeader}>
            <View style={[styles.locationIconBox, { backgroundColor: palette.iconBackground }]}>
              <Ionicons name="location" size={20} color={palette.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.locationTitle, { color: palette.textPrimary }]} numberOfLines={2}>
                {label}
              </Text>
              <Text style={[styles.locationSub, { color: palette.textSecondary }]} numberOfLines={1}>
                {pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : '坐标不可用'}
              </Text>
            </View>
          </View>
          <View style={[styles.locationMapPreview, { backgroundColor: palette.iconBackground }]}>
            <Ionicons name="map" size={34} color={palette.primary} />
            <Text style={[styles.locationMapHint, { color: palette.textSecondary }]}>
              {pos ? '点击打开地图导航' : '无法打开'}
            </Text>
          </View>
        </Pressable>
      </View>
    );
  }

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
            <View style={styles.mediaWrapper}>
              {msgType === 'image' && signedMediaUrl && (
                <Image source={{ uri: signedMediaUrl }} style={styles.bubbleMedia} contentFit="cover" transition={200} />
              )}
              {msgType === 'video' && (
                <>
                  {(signedThumbUrl || signedMediaUrl) && (
                    <Image source={{ uri: signedThumbUrl || signedMediaUrl }} style={styles.bubbleMedia} contentFit="cover" transition={200} />
                  )}
                  <View style={styles.playIconOverlay}><Ionicons name="play-circle" size={54} color="rgba(255, 255, 255, 0.85)" /></View>
                </>
              )}
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  messageRow: { flexDirection: 'row', marginBottom: 16 }, messageRowMe: { justifyContent: 'flex-end' }, messageRowOther: { justifyContent: 'flex-start' }, 
  bubbleWrapper: { maxWidth: '75%', overflow: 'hidden', borderRadius: 20 }, bubble: { borderRadius: 20 }, bubbleMe: { marginLeft: 40 }, bubbleOther: { marginRight: 40 }, 
  messageText: { fontSize: 16, lineHeight: 22 }, audioBubble: { alignItems: 'center', justifyContent: 'space-between', minWidth: 60, height: 22 }, audioDurationText: { fontSize: 16, marginHorizontal: 8, fontWeight: '500' }, 
  bubbleMedia: { width: 220, height: 300, backgroundColor: '#1c1c1e', borderRadius: 16 }, mediaWrapper: { overflow: 'hidden', borderRadius: 16 }, playIconOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)' }, 
  actionMessageContainer: { alignItems: 'center', marginVertical: 12 }, actionMessageText: { fontSize: 12, color: '#888888', backgroundColor: 'rgba(150,150,150,0.15)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', fontWeight: '500' },
  cinemaCard: { width: 240, padding: 16, borderRadius: 20, borderWidth: 1 }, cinemaCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 }, cinemaCardTitle: { fontSize: 16, fontWeight: 'bold', marginLeft: 8 }, cinemaCardSub: { fontSize: 13, marginBottom: 16 }, cinemaJoinBtn: { paddingVertical: 10, borderRadius: 12, alignItems: 'center' }, cinemaJoinText: { fontSize: 15, fontWeight: 'bold' }, actionBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  locationCard: { width: 240, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  locationHeader: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  locationIconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  locationTitle: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  locationSub: { fontSize: 11, marginTop: 3, letterSpacing: 0.3 },
  locationMapPreview: { height: 96, alignItems: 'center', justifyContent: 'center', gap: 6 },
  locationMapHint: { fontSize: 11, fontWeight: '500' }
});
// --- END OF FILE src/components/MessageBubble.js ---