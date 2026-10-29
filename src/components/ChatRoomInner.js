// --- START OF FILE src/components/ChatRoomInner.js ---
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Keyboard, Modal, ActivityIndicator, TouchableOpacity, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { useAudioPlayer } from 'expo-audio';
import { useRouter } from 'expo-router';

import { supabase } from '../services/supabase';
import { useAuth } from '../hooks/useAuth';
import { useAppTheme } from '../context/ThemeContext';
import { useChatMessages } from '../hooks/chat/useChatMessages';
import { useMediaUpload } from '../hooks/chat/useMediaUpload';
import { useAudioRecorder } from '../hooks/chat/useAudioRecorder';
import { sendPushNotification } from '../services/pushService';
import MessageBubble from './MessageBubble';
import ChatInputBar from './ChatInputBar';
import InteractiveMediaViewer from './InteractiveMediaViewer';
import ChatContextMenu from './ChatContextMenu';
import { useCinema } from '../hooks/useCinema';

const generateUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

const formatDuration = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

export default function ChatRoomInner({ targetId, targetName, isTabletMode = false, onBack }) {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();

  // ===== 三大领域 Hook（消息 / 媒体 / 录音）=====
  const { messages, loading, messagesRef, saveAndSend, revokeMessage, deleteMessage } = useChatMessages(targetId, user);
  const { uploading, uploadProgress, pickAndSendMedia } = useMediaUpload({ targetId, user, saveAndSend });
  const { isRecording, recordingDuration, startRecord, stopAndSendRecord, cancelRecord, audioRecorder } = useAudioRecorder({ targetId, user, saveAndSend });

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
    setIsTransitioning(true);
    const timer = setTimeout(() => setIsTransitioning(false), 300);
    return () => clearTimeout(timer);
  }, [targetId]);

  // ===== 文本发送 / 搭子邀请 =====
  const handleSendText = useCallback(async (text) => {
    if (!user || !targetId) return;
    const msgId = generateUUID();
    saveAndSend({ id: msgId, type: 'text', text, isMe: true, timestamp: Date.now() });
    await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: targetId, type: 'text', text });
    sendPushNotification(targetId, '新消息', text, { type: 'chat', targetId: user.id, targetName: 'TA' });
  }, [user, targetId, saveAndSend]);

  const handleAcceptPartner = async (msg) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await supabase.from('profiles').update({ bound_partner_id: targetId }).eq('id', user.id);
    await supabase.from('messages').update({ type: 'system', text: '你们已成为健康搭子！', subtype: 'SYNC_PARTNER_ACCEPTED' }).eq('id', msg.id);
    await supabase.from('messages').insert({ id: generateUUID(), user_id: user.id, receiver_id: targetId, type: 'system', text: '我已同意你的健康搭子邀请，互相监督吧！' });
    sendPushNotification(targetId, '邀请通过', 'TA 已同意成为你的健康搭子！', { type: 'chat', targetId: user.id });
  };

  const handleRejectPartner = async (msg) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await supabase.from('messages').update({ type: 'system', text: '已拒绝健康搭子邀请', subtype: 'SYNC_PARTNER_REJECTED' }).eq('id', msg.id);
  };

  const handleNudge = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    handleSendText('向对方发送了震动提醒');
  }, [handleSendText]);

  // ===== 语音播放（与影院播放器互不打断）=====
  const handleToggleAudio = useCallback((id, url) => {
    if (playingAudioId === id) {
      globalAudioPlayer.pause();
      setPlayingAudioId(null);
      return;
    }
    wasCinemaPlayingRef.current = cinemaPlayer ? cinemaPlayer.playing : false;
    setPlayingAudioId(id);
    globalAudioPlayer.replace(url);
    globalAudioPlayer.play();
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

  const handleSaveToAlbum = async (url) => {
    try {
      const { status } = await requestPermissionsAsync();
      if (status === 'granted') {
        await Asset.create(url);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e) {
      console.warn('保存到相册失败:', e);
    }
    setActionMessage(null);
  };

  const handleFavorite = () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setActionMessage(null); };
  const handleDelete = useCallback(async (id) => { setActionMessage(null); await deleteMessage(id); }, [deleteMessage]);
  const handleRecallMsg = useCallback(async (id) => { setActionMessage(null); await revokeMessage(id); }, [revokeMessage]);

  const handleStartCall = useCallback((type) => {
    Keyboard.dismiss();
    Alert.alert(
      type === 'video' ? '视频连麦' : '语音连麦',
      '请直接使用微信与好友拨打电话，我们的电影和音频混音系统已全面升级，微信通话期间，电影播放将自动共存，绝不中断！'
    );
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { borderBottomColor: palette.chatBorder }]}>
        {!isTabletMode && (
          <TouchableOpacity onPress={onBack} style={styles.backBtn}><Ionicons name="chevron-back" size={28} color={palette.primary} /></TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: palette.textPrimary, marginLeft: isTabletMode ? 16 : 0 }]}>{targetName || '聊天'}</Text>
        <View style={{ width: 28 }} />
      </View>

      {(isTransitioning || loading) ? (
        <View style={styles.loadingContainer}><ActivityIndicator size="small" color={palette.textSecondary} /></View>
      ) : (
        <View style={styles.chatArea}>
          {uploading && (
            <View style={[styles.uploadBar, { backgroundColor: palette.chatBorder }]}>
              <View style={[styles.uploadBarFill, { width: `${Math.round(uploadProgress * 100)}%`, backgroundColor: palette.primary }]} />
              <Text style={[styles.uploadBarText, { color: palette.textSecondary }]}>正在上传 {Math.round(uploadProgress * 100)}%</Text>
            </View>
          )}
          {isRecording && (
            <View style={[styles.uploadBar, { backgroundColor: palette.chatBorder }]}>
              <Text style={[styles.uploadBarText, { color: palette.primary }]}>🎙️ 正在录音 {formatDuration(recordingDuration)}</Text>
            </View>
          )}
          <FlatList
            ref={flatListRef} data={messages} keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <MessageBubble
                item={item} palette={palette} onPreviewMedia={handleOpenMedia}
                isPlaying={playingAudioId === item.id} onToggleAudio={handleToggleAudio} onAudioFinish={handleAudioFinish}
                onLongPressMessage={handleLongPressMessage} onJoinCinema={(roomId) => router.push({ pathname: '/cinema', params: { roomId } })}
                onAcceptPartner={handleAcceptPartner} onRejectPartner={handleRejectPartner}
              />
            )}
            inverted contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} keyboardDismissMode="on-drag"
            onScrollBeginDrag={dismissAllPanels} onTouchStart={dismissAllPanels} keyboardShouldPersistTaps="handled"
            initialNumToRender={15} maxToRenderPerBatch={10} windowSize={3}
            removeClippedSubviews={Platform.OS === 'android'}
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
  chatArea: { flex: 1, position: 'relative' }, listContent: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 60 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  uploadBar: { height: 22, justifyContent: 'center', overflow: 'hidden' },
  uploadBarFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  uploadBarText: { fontSize: 11, textAlign: 'center', fontWeight: '500' }
});
// --- END OF FILE src/components/ChatRoomInner.js ---
