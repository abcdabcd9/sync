// --- START OF FILE src/components/ChatRoomInner.js ---
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Keyboard, Modal, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { File, Paths } from 'expo-file-system';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useRouter } from 'expo-router';

import { supabase } from '../services/supabase';
import { useAuth } from '../hooks/useAuth';
import { useHealthData } from '../hooks/useHealthData';
import { useAppTheme } from '../context/ThemeContext';
import { useChatMessages } from '../hooks/chat/useChatMessages';
import { useMediaUpload } from '../hooks/chat/useMediaUpload';
import { useAudioRecorder } from '../hooks/chat/useAudioRecorder';
import { useChatPrefs } from '../hooks/chat/useChatPrefs';
import { useChatFavorites } from '../hooks/chat/useChatFavorites';
import { getSignedUrl, toStoragePath } from '../hooks/chat/useSignedMediaUrl';
import { downloadToSandbox, isLocalUri, normalizeFileUri } from '../services/mediaCache';
import { sendPushNotification } from '../services/pushService';
import MessageBubble from './MessageBubble';
import ChatInputBar from './ChatInputBar';
import InteractiveMediaViewer from './InteractiveMediaViewer';
import ChatContextMenu from './ChatContextMenu';
import { useCinema } from '../hooks/useCinema';

const formatDuration = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

// ⏱️ 兼容提取消息时间戳（同时兼容本地 timestamp 与数据库 created_at）
const getMsgTime = (msg) => {
  if (!msg) return 0;
  if (typeof msg.timestamp === 'number' && msg.timestamp > 0) return msg.timestamp;
  if (msg.timestamp) {
    const t = new Date(msg.timestamp).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (msg.created_at) {
    const t = new Date(msg.created_at).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return 0;
};

// ===== 微信同款时间格式化 =====
const formatWeChatTime = (rawTime) => {
  if (!rawTime) return '';
  const date = new Date(typeof rawTime === 'number' ? rawTime : String(rawTime));
  const time = date.getTime();
  if (isNaN(time) || time <= 0) return '';

  const now = new Date();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  const isToday = date.toDateString() === now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return timeStr;
  if (isYesterday) return `昨天 ${timeStr}`;

  const diffDays = Math.floor((now.getTime() - time) / (1000 * 60 * 60 * 24));
  if (diffDays < 7 && diffDays > 0) {
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${days[date.getDay()]} ${timeStr}`;
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${month}月${day}日 ${timeStr}`;
  }

  return `${date.getFullYear()}年${month}月${day}日 ${timeStr}`;
};

export default function ChatRoomInner({ targetId, targetName, isTabletMode = false, onBack }) {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { refreshPartner } = useHealthData();

  // ===== 三大领域 Hook（消息 / 媒体 / 录音）=====
  const { messages, loading, messagesRef, saveAndSend, patchMessage, revokeMessage, deleteMessage } = useChatMessages(targetId, user);
  const { uploading, uploadProgress, pickAndSendMedia } = useMediaUpload({ targetId, user, saveAndSend, patchMessage, deleteMessage });
  const { isRecording, recordingDuration, startRecord, stopAndSendRecord, cancelRecord, audioRecorder } = useAudioRecorder({ targetId, user, saveAndSend, patchMessage });

  // ===== 会话偏好（背景） + 收藏 =====
  const prefs = useChatPrefs(user);
  const favorites = useChatFavorites(user);
  const backgroundKey = prefs.getBackground(targetId);
  const chatBackgroundColor = backgroundKey === 'light'
    ? '#F2F2F7'
    : backgroundKey === 'dark'
      ? '#111111'
      : palette.background;

  // ===== 本地 UI 状态 =====
  const { player: cinemaPlayer } = useCinema();
  const wasCinemaPlayingRef = useRef(false);
  const [isTransitioning, setIsTransitioning] = useState(true);
  const [previewState, setPreviewState] = useState({ visible: false, index: 0, mediaList: [] });
  const [actionMessage, setActionMessage] = useState(null);
  const [playingAudioId, setPlayingAudioId] = useState(null);

  const globalAudioPlayer = useAudioPlayer(null);
  const flatListRef = useRef(null);
  const chatInputRef = useRef(null);

  useEffect(() => () => {
    try { globalAudioPlayer?.pause(); globalAudioPlayer?.replace(null); } catch (_) {}
  }, [globalAudioPlayer]);

  useEffect(() => {
    const timer = setTimeout(() => setIsTransitioning(false), 300);
    return () => clearTimeout(timer);
  }, [targetId]);

  // ===== 文本发送 / 搭子邀请 =====
  const handleSendText = useCallback(async (text) => {
    if (!user || !targetId) return;
    const msgId = Crypto.randomUUID();
    saveAndSend({ id: msgId, type: 'text', text, isMe: true, timestamp: Date.now() });
    try {
      const { error } = await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: targetId, type: 'text', text });
      if (error) throw error;
    } catch (e) {
      console.warn('离线/发送失败，已标记为待重发', e?.message ?? e);
      patchMessage(msgId, { status: 'failed' });
      return;
    }
    sendPushNotification(targetId, '', text, { type: 'chat', targetId: user.id });
  }, [user, targetId, saveAndSend, patchMessage]);

  // ❗ 点击红色感叹号重发：重新发送并更新云端与本地状态
  const handleResendMessage = useCallback(async (msg) => {
    if (!msg || !user || !targetId) return;
    patchMessage(msg.id, { status: 'sending' });
    try {
      let mediaUrl = msg.mediaUrl || null;
      let thumbnailUrl = msg.thumbnailUrl || null;

      const localPath = msg.localUri || msg.uri;
      if (localPath && typeof localPath === 'string' && localPath.startsWith('file://') && (!mediaUrl || mediaUrl.startsWith('file://'))) {
        try {
          const fileExt = localPath.split('.').pop()?.split('?')[0]?.toLowerCase() || 'bin';
          const storagePath = `${user.id}/${msg.id}.${fileExt}`;
          const mimeType = msg.type === 'audio' || msg.subtype === 'SYNC_AUDIO'
            ? 'audio/m4a'
            : (msg.type === 'video' ? 'video/mp4' : 'image/jpeg');

          const { error: uploadErr } = await supabase.storage.from('chat_media').upload(storagePath, {
            uri: localPath,
            type: mimeType,
            name: `${msg.id}.${fileExt}`,
          }, { upsert: true });

          if (!uploadErr) {
            mediaUrl = storagePath;
          }
        } catch (_upErr) {
          console.warn('重发补传媒体文件失败，继续尝试使用现有信息重发');
        }
      }

      const { error } = await supabase.from('messages').upsert({
        id: msg.id,
        user_id: user.id,
        receiver_id: targetId,
        type: msg.type || 'text',
        text: msg.text || '',
        media_url: mediaUrl,
        thumbnail_url: thumbnailUrl,
        subtype: msg.subtype || null,
        duration: msg.duration || 0, // ⚡ 核心修复：重发时必须带上语音时长！否则数据库会覆盖为 null 导致 0 秒
      });

      if (error) throw error;

      patchMessage(msg.id, { status: 'sent', mediaUrl, thumbnailUrl, duration: msg.duration });
      if (msg.type === 'text' && msg.text) {
        sendPushNotification(targetId, '', msg.text, { type: 'chat', targetId: user.id });
      }
    } catch (e) {
      console.warn('重发依然失败，保持失败状态', e?.message ?? e);
      patchMessage(msg.id, { status: 'failed' });
    }
  }, [user, targetId, patchMessage]);

  const handleAcceptPartner = async (msg) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const { error: bindError } = await supabase.from('profiles').update({ bound_partner_id: targetId }).eq('id', user.id);
    if (bindError) {
      console.error('绑定健康搭子失败:', bindError);
      Alert.alert('绑定失败', '请检查网络后重试');
      return;
    }
    await supabase.from('messages').update({ type: 'system', text: '你们已成为健康搭子！', subtype: 'SYNC_PARTNER_ACCEPTED' }).eq('id', msg.id);
    await supabase.from('messages').insert({ id: Crypto.randomUUID(), user_id: user.id, receiver_id: targetId, type: 'system', text: '我已同意你的健康搭子邀请，互相监督吧！' });
    sendPushNotification(targetId, '', '已同意成为你的健康搭子！', { type: 'chat', targetId: user.id });
    await refreshPartner(targetId);
  };

  const handleRejectPartner = async (msg) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await supabase.from('messages').update({ type: 'system', text: '已拒绝健康搭子邀请', subtype: 'SYNC_PARTNER_REJECTED' }).eq('id', msg.id);
  };

  const handleNudge = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    handleSendText('向对方发送了震动提醒');
  }, [handleSendText]);

  // ===== 语音播放 =====
  const handleToggleAudio = useCallback(async (id, url, options = {}) => {
    if (playingAudioId === id) {
      globalAudioPlayer.pause();
      setPlayingAudioId(null);
      return;
    }
    if (!url) return;

    try {
      if (typeof setAudioModeAsync === 'function') {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: 'mixWithOthers',
          shouldRouteThroughEarpiece: false,
        });
      }
    } catch (e) {
      console.warn('语音播放前设置音频模式失败(忽略):', e?.message ?? e);
    }

    let playUri = url;
    const alreadyLocal = options.isLocal || isLocalUri(url);
    if (alreadyLocal) {
      playUri = normalizeFileUri(url) || url;
    } else {
      try {
        const local = await downloadToSandbox(url, id, 'audio');
        if (local) playUri = normalizeFileUri(local) || local;
      } catch (_) {}
    }

    wasCinemaPlayingRef.current = cinemaPlayer ? cinemaPlayer.playing : false;
    setPlayingAudioId(id);
    try {
      globalAudioPlayer.replace(playUri);
      globalAudioPlayer.play();
    } catch (e) {
      console.warn('语音播放失败:', e?.message ?? e);
      setPlayingAudioId(null);
      return;
    }
    if (wasCinemaPlayingRef.current) {
      setTimeout(() => { if (cinemaPlayer && !cinemaPlayer.playing) cinemaPlayer.play(); }, 250);
    }
  }, [globalAudioPlayer, playingAudioId, cinemaPlayer]);

  useEffect(() => {
    if (!globalAudioPlayer || !playingAudioId) return undefined;
    let ticks = 0;
    let playStarted = false;
    const interval = setInterval(() => {
      ticks++;
      const cur = globalAudioPlayer.currentTime || 0;
      const dur = globalAudioPlayer.duration || 0;
      if (cur > 0.05 && dur > 0) playStarted = true;
      if (playStarted && (!globalAudioPlayer.playing || cur >= dur - 0.15)) {
        globalAudioPlayer.pause();
        setPlayingAudioId(null);
        if (wasCinemaPlayingRef.current && cinemaPlayer && !cinemaPlayer.playing) cinemaPlayer.play();
      }
      if (!playStarted && ticks > 35) {
        setPlayingAudioId(null);
        globalAudioPlayer.pause();
      }
    }, 100);
    return () => clearInterval(interval);
  }, [globalAudioPlayer, playingAudioId, cinemaPlayer]);

  const handleAudioFinish = useCallback(() => setPlayingAudioId(null), []);
  const dismissAllPanels = () => { Keyboard.dismiss(); chatInputRef.current?.closePanels(); };

  // ===== 长按菜单 / 全屏预览 =====
  const handleOpenMedia = useCallback((tappedItem) => {
    Keyboard.dismiss();
    const mediaMessages = messagesRef.current.filter((m) => m.type === 'image' || m.type === 'video').reverse();
    const index = mediaMessages.findIndex((m) => m.id === tappedItem.id);
    if (index !== -1) setPreviewState({ visible: true, index, mediaList: mediaMessages });
  }, [messagesRef]);

  const handleLongPressMessage = useCallback((msg) => { Keyboard.dismiss(); setActionMessage(msg); }, []);

  const handleCopy = async (text) => {
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setActionMessage(null);
  };

  const handleSaveToAlbum = async (rawValue) => {
    try {
      if (!rawValue) return;
      const { status } = await requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('无法保存', '请在系统设置中允许访问相册。');
        return;
      }

      const storagePath = toStoragePath(rawValue);
      const url = storagePath ? await getSignedUrl(storagePath) : null;
      if (!url) {
        Alert.alert('保存失败', '媒体地址无效或已失效，请稍后重试。');
        return;
      }

      let localUri = url;
      let tempFile = null;
      if (url.startsWith('http')) {
        const pathOnly = url.split('?')[0].split('#')[0];
        const rawExt = pathOnly.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
        const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : 'jpg';
        const target = new File(Paths.cache, `save_${Date.now()}.${ext}`);
        tempFile = await File.downloadFileAsync(url, target, { idempotent: true });
        localUri = tempFile.uri;
      }

      await Asset.create(localUri);
      if (tempFile) { try { tempFile.delete(); } catch (_) {} }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('已保存', '媒体已保存到系统相册。');
    } catch (e) {
      console.warn('保存到相册失败:', e);
      Alert.alert('保存失败', '媒体保存失败，请稍后重试。');
    } finally {
      setActionMessage(null);
    }
  };

  const handleFavorite = useCallback(() => {
    const msg = actionMessage;
    if (!msg) { setActionMessage(null); return; }
    const added = favorites.addFavorite(msg, { peerId: targetId, peerName: targetName || '' });
    if (added) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('已收藏', '这条消息已经在你的收藏里了。');
    }
    setActionMessage(null);
  }, [actionMessage, favorites, targetId, targetName]);
  const handleDelete = useCallback(async (id) => { setActionMessage(null); await deleteMessage(id); }, [deleteMessage]);
  const handleRecallMsg = useCallback(async (id) => { setActionMessage(null); await revokeMessage(id); }, [revokeMessage]);

  const handleStartCall = useCallback((type) => {
    Keyboard.dismiss();
    Alert.alert(
      type === 'video' ? '视频连麦' : '语音连麦',
      '请直接使用微信与好友拨打电话，我们的电影和音频混音系统已全面升级，微信通话期间，电影播放将自动共存，绝不中断！'
    );
  }, []);

  const openChatSettings = useCallback(() => {
    if (!targetId) return;
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({
      pathname: '/chat/chat_settings',
      params: { targetId, targetName: targetName || '' },
    });
  }, [router, targetId, targetName]);

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { borderBottomColor: palette.chatBorder }]}>
        {!isTabletMode && (
          <TouchableOpacity onPress={onBack} style={styles.backBtn}><Ionicons name="chevron-back" size={28} color={palette.primary} /></TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: palette.textPrimary, marginLeft: isTabletMode ? 16 : 0 }]}>{targetName || '好友'}</Text>
        <TouchableOpacity
          onPress={openChatSettings}
          style={styles.headerActionBtn}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="聊天设置"
          accessibilityHint="打开聊天设置页面"
        >
          <Ionicons name="ellipsis-horizontal" size={24} color={palette.primary} />
        </TouchableOpacity>
      </View>

      {(isTransitioning || loading) ? (
        <View style={styles.loadingContainer}><ActivityIndicator size="small" color={palette.textSecondary} /></View>
      ) : (
        <View style={[styles.chatArea, { backgroundColor: chatBackgroundColor }]}>
          {uploading && (
            <View style={[styles.uploadBar, { backgroundColor: palette.chatBorder }]}>
              <View style={[styles.uploadBarFill, { width: `${Math.round(uploadProgress * 100)}%`, backgroundColor: palette.primary }]} />
              <Text style={[styles.uploadBarText, { color: palette.textSecondary }]}>正在上传 {Math.round(uploadProgress * 100)}%</Text>
            </View>
          )}
          {isRecording && (
            <View style={[styles.uploadBar, { backgroundColor: palette.chatBorder }]}>
              <Text style={[styles.uploadBarText, { color: palette.primary }]}>正在录音 {formatDuration(recordingDuration)}</Text>
            </View>
          )}
          <FlatList
            ref={flatListRef} data={messages} keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => {
              const itemTime = getMsgTime(item);
              const prevMsg = messages[index + 1];
              const prevTime = getMsgTime(prevMsg);

              const shouldShowTime = !prevMsg || (itemTime > 0 && prevTime > 0 && Math.abs(itemTime - prevTime) >= 15 * 60 * 1000);
              const timeText = shouldShowTime && itemTime > 0 ? formatWeChatTime(itemTime) : '';

              return (
                <View>
                  {!!timeText && (
                    <View style={styles.timeDividerContainer}>
                      <Text 
                        style={[styles.timeDividerText, { color: palette.textSecondary }]} 
                        includeFontPadding={false}
                      >
                        {timeText}
                      </Text>
                    </View>
                  )}
                  <MessageBubble
                    item={item} palette={palette} onPreviewMedia={handleOpenMedia}
                    isPlaying={playingAudioId === item.id} onToggleAudio={handleToggleAudio} onAudioFinish={handleAudioFinish}
                    onLongPressMessage={handleLongPressMessage} onJoinCinema={(roomId) => router.push({ pathname: '/cinema', params: { roomId } })}
                    onAcceptPartner={handleAcceptPartner} onRejectPartner={handleRejectPartner}
                    onResendMessage={handleResendMessage}
                  />
                </View>
              );
            }}
            inverted contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag"
            onScrollBeginDrag={dismissAllPanels} onTouchStart={dismissAllPanels} keyboardShouldPersistTaps="handled"
            initialNumToRender={15} maxToRenderPerBatch={10} windowSize={3}
            removeClippedSubviews={false}
            updateCellsBatchingPeriod={50}
          />
          <ChatInputBar
            ref={chatInputRef} palette={palette} isChatLoaded={true} onSendText={handleSendText}
            onStartRecord={() => { setPlayingAudioId(null); startRecord(); }} onStopRecord={stopAndSendRecord} onCancelRecord={cancelRecord}
            onPickMedia={pickAndSendMedia} onNudge={handleNudge} audioRecorder={audioRecorder}
            onStartCall={handleStartCall}
          />
        </View>
      )}

      <Modal visible={previewState.visible} transparent={true} animationType="none" onRequestClose={() => setPreviewState((p) => ({ ...p, visible: false }))}>
        {previewState.visible && (
          <InteractiveMediaViewer
            mediaList={previewState.mediaList}
            initialIndex={previewState.index}
            onClose={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setPreviewState((p) => ({ ...p, visible: false })); }}
          />
        )}
      </Modal>
      <ChatContextMenu actionMessage={actionMessage} onClose={() => setActionMessage(null)} onCopy={handleCopy} onSave={handleSaveToAlbum} onFavorite={handleFavorite} onDelete={handleDelete} onRecall={handleRecallMsg} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  backBtn: { padding: 4, marginLeft: -8 }, headerTitle: { fontSize: 17, fontWeight: '600' },
  headerActionBtn: { padding: 4, marginRight: -4 },
  chatArea: { flex: 1, position: 'relative' }, listContent: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 60 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  uploadBar: { height: 22, justifyContent: 'center', overflow: 'hidden' },
  uploadBarFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  uploadBarText: { fontSize: 11, textAlign: 'center', fontWeight: '500' },
  timeDividerContainer: { alignItems: 'center', justifyContent: 'center', marginVertical: 10, width: '100%' },
  timeDividerText: { fontSize: 12, includeFontPadding: false, textAlign: 'center', fontWeight: '500' },
});
// --- END OF FILE src/components/ChatRoomInner.js ---