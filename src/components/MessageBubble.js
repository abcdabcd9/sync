// --- START OF FILE src/components/MessageBubble.js ---
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useSignedMediaUrl } from '../hooks/chat/useSignedMediaUrl';

/**
 * 🖼️ 气泡内媒体尺寸计算（修复「横屏照片被裁切 / 自动放大」）
 *
 * 旧实现固定 `width: 220, height: 300` + `contentFit="cover"`：
 *   - 竖屏照片被拉伸成 220×300 的竖长条；
 *   - 横屏照片（如电脑桌面截图）被 cover 裁掉左右两侧，只剩中间一块。
 * 新实现：按图片真实宽高比计算气泡尺寸，并改用 `contentFit="contain"`，
 * 保证「原图比例完整显示、不裁切、不放大」。
 *
 * 约束：
 *   - 最大宽 220（与旧版一致，不破坏气泡布局）
 *   - 最大高 300（避免超长竖图撑爆屏幕）
 *   - 最小边 80（避免极端长条图变成一条线）
 */
const MEDIA_MAX_W = 220;
const MEDIA_MAX_H = 300;
const MEDIA_MIN_SIDE = 80;

function computeMediaSize(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) {
    // 尺寸未知（本地 URI 尚未加载）：退回一个中性的 4:3 横屏框，
    // 比旧的 220×300 竖框更接近手机照片的真实比例。
    return { width: MEDIA_MAX_W, height: Math.round((MEDIA_MAX_W * 3) / 4) };
  }
  const ratio = w / h;
  let outW = MEDIA_MAX_W;
  let outH = Math.round(MEDIA_MAX_W / ratio);
  if (outH > MEDIA_MAX_H) {
    outH = MEDIA_MAX_H;
    outW = Math.round(MEDIA_MAX_H * ratio);
  }
  // 极端长条图兜底
  if (outW < MEDIA_MIN_SIDE) outW = MEDIA_MIN_SIDE;
  if (outH < MEDIA_MIN_SIDE) outH = MEDIA_MIN_SIDE;
  return { width: outW, height: outH };
}

export default React.memo(function MessageBubble({
  item, palette, onPreviewMedia, isPlaying, onToggleAudio, onLongPressMessage, onJoinCinema, onAcceptPartner, onRejectPartner
}) {
  const isMe = item.isMe;
  let msgType = item.type || 'text';
  let displayText = item.text || '';
  let isCinemaEnded = false;

  // 🖼️ 媒体真实尺寸：优先用消息里已存的宽高（发送时写入），
  //    否则等 expo-image 的 onLoad 回调补上，再重算气泡尺寸。
  const [mediaSize, setMediaSize] = useState(() => {
    const w = Number(item.mediaWidth) || 0;
    const h = Number(item.mediaHeight) || 0;
    return computeMediaSize(w, h);
  });

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
  //
  // 🚨 修复「发送观影邀请时刷屏 WARN 生成签名 URL 失败: 40.38,-5.76 Object not found」：
  //    历史 type='location' 消息把经纬度写进了 media_url，而本组件对所有类型都无条件
  //    调用 useSignedMediaUrl(item.mediaUrl)，于是把 "40.3881208,-5.7601863" 当成
  //    chat_media 桶内对象路径去 createSignedUrl，必然 404 并打日志。
  //    Hook 不能条件调用，因此这里按消息类型决定「是否真的需要签名」：
  //    只有 image / video / audio 才传真实值，其余一律传 null（Hook 内部直接短路）。
  const needsMedia = msgType === 'image' || msgType === 'video' || msgType === 'audio';
  const { url: signedMediaUrl } = useSignedMediaUrl(needsMedia ? item.mediaUrl : null);
  const { url: signedThumbUrl } = useSignedMediaUrl(needsMedia ? item.thumbnailUrl : null);

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
            <View style={[styles.mediaWrapper, { width: mediaSize.width, height: mediaSize.height }]}>
              {msgType === 'image' && signedMediaUrl && (
                <Image
                  source={{ uri: signedMediaUrl }}
                  style={styles.bubbleMedia}
                  contentFit="contain"
                  transition={200}
                  onLoad={(e) => {
                    const src = e?.source || {};
                    if (src.width && src.height) {
                      const next = computeMediaSize(src.width, src.height);
                      setMediaSize((prev) => (
                        prev.width === next.width && prev.height === next.height ? prev : next
                      ));
                    }
                  }}
                />
              )}
              {msgType === 'video' && (
                <>
                  {(signedThumbUrl || signedMediaUrl) && (
                    <Image
                      source={{ uri: signedThumbUrl || signedMediaUrl }}
                      style={styles.bubbleMedia}
                      contentFit="contain"
                      transition={200}
                      onLoad={(e) => {
                        const src = e?.source || {};
                        if (src.width && src.height) {
                          const next = computeMediaSize(src.width, src.height);
                          setMediaSize((prev) => (
                            prev.width === next.width && prev.height === next.height ? prev : next
                          ));
                        }
                      }}
                    />
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
  bubbleMedia: { width: '100%', height: '100%', backgroundColor: '#1c1c1e', borderRadius: 16 }, mediaWrapper: { overflow: 'hidden', borderRadius: 16 }, playIconOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  actionMessageContainer: { alignItems: 'center', marginVertical: 12 }, actionMessageText: { fontSize: 12, color: '#888888', backgroundColor: 'rgba(150,150,150,0.15)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden', fontWeight: '500' },
  cinemaCard: { width: 240, padding: 16, borderRadius: 20, borderWidth: 1 }, cinemaCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 }, cinemaCardTitle: { fontSize: 16, fontWeight: 'bold', marginLeft: 8 }, cinemaCardSub: { fontSize: 13, marginBottom: 16 }, cinemaJoinBtn: { paddingVertical: 10, borderRadius: 12, alignItems: 'center' }, cinemaJoinText: { fontSize: 15, fontWeight: 'bold' }, actionBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
});
// --- END OF FILE src/components/MessageBubble.js ---