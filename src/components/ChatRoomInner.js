// --- START OF FILE src/components/ChatRoomInner.js ---
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Keyboard, useColorScheme, Modal, ActivityIndicator, TouchableOpacity, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Clipboard from 'expo-clipboard';
import * as MediaLibrary from 'expo-media-library/legacy'; 
import * as FileSystem from 'expo-file-system';
import { useAudioRecorder, RecordingPresets, setAudioModeAsync, requestRecordingPermissionsAsync, useAudioPlayer } from 'expo-audio'; 
import { useRouter } from 'expo-router';

import { supabase } from '../services/supabase';
import { useAuth } from '../hooks/useAuth';
import { getPalette } from '../constants/colors';
import { sendPushNotification } from '../services/pushService';
import MessageBubble from './MessageBubble';
import ChatInputBar from './ChatInputBar';
import InteractiveMediaViewer from './InteractiveMediaViewer';
import ChatContextMenu from './ChatContextMenu';
import { useCinema } from '../hooks/useCinema';

const generateUUID = () => { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16); }); };
const AUDIO_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

const uploadToSupabase = async (uri, prefix) => {
  if (!uri) return null;
  try {
    let safeUri = uri;
    if (Platform.OS === 'ios' && !safeUri.startsWith('file://')) {
      safeUri = 'file://' + safeUri;
    }
    const response = await fetch(safeUri);
    const blob = await response.blob();
    
    // 🍎 核心修复 4：正确匹配视频和音频的容错后缀，绝不滥杀无辜全变 JPG
    let ext = uri.split('.').pop()?.split('?')[0];
    if (!ext || ext.length > 5) {
      if (prefix === 'audio') ext = 'm4a';
      else if (prefix === 'vid') ext = 'mp4';
      else ext = 'jpg';
    }
    
    const fileName = `${prefix}_${Date.now()}_${Math.floor(Math.random()*1000)}.${ext}`;
    const { error } = await supabase.storage.from('chat_media').upload(fileName, blob, { contentType: blob.type || 'application/octet-stream' });
    if (error) throw error;
    const { data: urlData } = supabase.storage.from('chat_media').getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (e) { return null; }
};

const formatDbMsg = (row, currentUserId) => ({
  id: row.id, type: row.type, subtype: row.subtype ?? null,
  // ⚠️ 只有「撤回」类 action 才覆写文案；带 subtype 的协议消息必须保留真实 text
  text: (row.type === 'action' && !row.subtype)
    ? (row.user_id === currentUserId ? '你撤回了一条消息' : '对方撤回了一条消息')
    : row.text,
  mediaUrl: row.media_url, thumbnailUrl: row.thumbnail_url, duration: row.duration || 0,
  isMe: row.user_id === currentUserId, timestamp: new Date(row.created_at).getTime()
});

export default function ChatRoomInner({ targetId, targetName, isTabletMode = false, onBack }) {
  const palette = getPalette(useColorScheme() === 'dark');
  const router = useRouter();
  const { user } = useAuth();
  
  const { player: cinemaPlayer } = useCinema();
  const wasCinemaPlayingRef = useRef(false);
  
  const CACHE_MSG_KEY = `@chatMessages_${targetId}`;
  const CACHE_DEL_KEY = `@deletedMsgIds_${targetId}`;

  const [isTransitioning, setIsTransitioning] = useState(true);
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const [previewState, setPreviewState] = useState({ visible: false, index: 0, mediaList: [] }); 
  const [actionMessage, setActionMessage] = useState(null);
  const [playingAudioId, setPlayingAudioId] = useState(null);

  const globalAudioPlayer = useAudioPlayer(null); 
  const flatListRef = useRef(null);
  const chatInputRef = useRef(null); 
  const recordStartTimeRef = useRef(0);
  const audioRecorder = useAudioRecorder(AUDIO_OPTIONS);

  useEffect(() => { return () => { try { if (globalAudioPlayer) { globalAudioPlayer.pause(); globalAudioPlayer.replace(null); } } catch (e) {} }; }, [globalAudioPlayer]);

  useEffect(() => {
    setIsTransitioning(true);
    const timer = setTimeout(() => setIsTransitioning(false), 300);
    return () => clearTimeout(timer);
  }, [targetId]);

  useEffect(() => {
    if (!user || !targetId) return;
    const initAudio = async () => { 
      try { 
        await requestRecordingPermissionsAsync(); 
        if (typeof setAudioModeAsync === 'function') {
          await setAudioModeAsync({ 
            allowsRecording: true, 
            playsInSilentMode: true,
            staysActiveInBackground: true,
            interruptionModeIOS: 0,
            interruptionModeAndroid: 0 
          }); 
        }
      } catch (e) {
        console.warn("Audio init warning:", e);
      } 
    };
    initAudio();

    const fetchMessages = async () => {
      try { const cachedStr = await AsyncStorage.getItem(CACHE_MSG_KEY); if (cachedStr) setMessages(JSON.parse(cachedStr)); } catch (e) {}
      const { data } = await supabase.from('messages').select('*').or(`and(user_id.eq.${user.id},receiver_id.eq.${targetId}),and(user_id.eq.${targetId},receiver_id.eq.${user.id})`).order('created_at', { ascending: false }).limit(50);
      if (data) {
        const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
        const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
        const mergedMessages = data.map(r => formatDbMsg(r, user.id)).filter(m => !deletedIds.includes(m.id));
        setMessages(mergedMessages);
        AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(mergedMessages.slice(0, 300)));
      }
      await supabase.from('messages').update({ is_read: true }).eq('user_id', targetId).eq('receiver_id', user.id).eq('is_read', false);
    };
    fetchMessages();

    const sortedIds = [user.id, targetId].sort().join('_');
    const channelName = `chat_${sortedIds}`;
    const channel = supabase.channel(channelName);
    
    channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
        const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId) || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
        if (!isRelevant) return;
        const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY);
        const deletedIds = deletedStr ? JSON.parse(deletedStr) : [];
        if (deletedIds.includes(payload.new.id)) return;

        const newMsg = formatDbMsg(payload.new, user.id);
        setMessages(prev => {
          if (prev.find(m => m.id === newMsg.id)) return prev;
          if (!newMsg.isMe) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return [newMsg, ...prev];
        });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const isRelevant = (payload.new.user_id === user.id && payload.new.receiver_id === targetId) || (payload.new.user_id === targetId && payload.new.receiver_id === user.id);
        if (!isRelevant) return;
        const updatedMsg = formatDbMsg(payload.new, user.id);
        setMessages(prev => prev.map(m => m.id === updatedMsg.id ? updatedMsg : m));
      }).subscribe();

    return () => { 
      supabase.removeChannel(channel); 
      if (typeof setAudioModeAsync === 'function') {
        setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, staysActiveInBackground: true }).catch(()=>{}); 
      }
    };
  }, [user, targetId]);

  const saveAndSend = useCallback((newMsg) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMessages((prev) => { const updated = [newMsg, ...prev]; AsyncStorage.setItem(CACHE_MSG_KEY, JSON.stringify(updated.slice(0, 300))); return updated; });
  }, [targetId, CACHE_MSG_KEY]);

  const handleSendText = useCallback(async (text) => {
    if (!user || !targetId) return;
    const msgId = generateUUID();
    saveAndSend({ id: msgId, type: 'text', text, isMe: true, timestamp: Date.now() });
    await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: targetId, type: 'text', text });
    sendPushNotification(targetId, "新消息", text, { type: 'chat', targetId: user.id, targetName: 'TA' });
  }, [user, targetId, saveAndSend]);

  const handleAcceptPartner = async (msg) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await supabase.from('profiles').update({ bound_partner_id: targetId }).eq('id', user.id);
    await supabase.from('messages').update({ type: 'system', text: '你们已成为健康搭子！', subtype: 'SYNC_PARTNER_ACCEPTED' }).eq('id', msg.id);
    const sysMsgId = generateUUID();
    await supabase.from('messages').insert({ id: sysMsgId, user_id: user.id, receiver_id: targetId, type: 'system', text: '我已同意你的健康搭子邀请，互相监督吧！' });
    sendPushNotification(targetId, "邀请通过", "TA 已同意成为你的健康搭子！", { type: 'chat', targetId: user.id });
  };
  const handleRejectPartner = async (msg) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); await supabase.from('messages').update({ type: 'system', text: '已拒绝健康搭子邀请', subtype: 'SYNC_PARTNER_REJECTED' }).eq('id', msg.id); };

  const handleStartRecord = useCallback(async () => { 
    try { 
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); 
      setPlayingAudioId(null); 
      recordStartTimeRef.current = 0; 

      if (Platform.OS === 'ios') {
        try {
          if (typeof setAudioModeAsync === 'function') {
            await setAudioModeAsync({ 
              allowsRecording: true, 
              playsInSilentMode: true,
              staysActiveInBackground: true,
              interruptionModeIOS: 0,
            });
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } catch (modeErr) {}
      }

      await audioRecorder.prepareToRecordAsync(); 
      recordStartTimeRef.current = Date.now(); 
      audioRecorder.record(); 
    } catch (e) {
      console.warn("录音引擎启动失败:", e);
      recordStartTimeRef.current = 0; 
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } 
  }, [audioRecorder]);

  const handleStopRecord = useCallback(() => {
    try {
      if (!recordStartTimeRef.current) { 
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); 
        return; 
      }
      
      try { audioRecorder.stop(); } catch(e){} 

      const tempUri = audioRecorder.uri;
      const durationSec = Math.round((Date.now() - recordStartTimeRef.current) / 1000);
      recordStartTimeRef.current = 0; 

      if (durationSec < 1 || !tempUri) { 
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); 
        return; 
      }

      setTimeout(async () => {
        const msgId = generateUUID();
        saveAndSend({ id: msgId, type: 'audio', mediaUrl: tempUri, duration: durationSec, isMe: true, timestamp: Date.now() });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        
        const cloudUrl = await uploadToSupabase(tempUri, 'audio');
        if (cloudUrl) {
          await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: targetId, type: 'audio', media_url: cloudUrl, duration: durationSec });
          sendPushNotification(targetId, "新消息", "[语音消息]", { type: 'chat', targetId: user.id, targetName: 'TA' });
        }
      }, 150);
    } catch (e) {
      console.error("停止录音异常:", e);
    }
  }, [audioRecorder, user, targetId, saveAndSend]);

  const handleCancelRecord = useCallback(() => { 
    try { audioRecorder.stop(); } catch (e) {}
    recordStartTimeRef.current = 0; 
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); 
  }, [audioRecorder]);

  const handlePickMedia = useCallback(async () => {
    let result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.6, videoMaxDuration: 120 });
    if (!result.canceled) {
      const asset = result.assets[0];
      try { const fileInfo = await FileSystem.getInfoAsync(asset.uri); if (fileInfo.size > 50 * 1024 * 1024) { Alert.alert('文件过大', '请发送小于 50MB 的媒体文件。'); return; } } catch(e) {}
      const prefix = asset.type === 'video' ? 'vid' : 'img';
      let localThumbUri = null;
      if (asset.type === 'video') { try { const { uri } = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 500 }); localThumbUri = uri; } catch(e) {} }
      const msgId = generateUUID();
      saveAndSend({ id: msgId, type: asset.type === 'video' ? 'video' : 'image', mediaUrl: asset.uri, thumbnailUrl: localThumbUri, isMe: true, timestamp: Date.now() });
      const cloudMediaUrl = await uploadToSupabase(asset.uri, prefix);
      let cloudThumbUrl = null;
      if (localThumbUri) cloudThumbUrl = await uploadToSupabase(localThumbUri, 'thumb');
      await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: targetId, type: asset.type === 'video' ? 'video' : 'image', media_url: cloudMediaUrl, thumbnail_url: cloudThumbUrl });
      const msgLabel = asset.type === 'video' ? '[视频]' : '[图片]';
      sendPushNotification(targetId, "新消息", msgLabel, { type: 'chat', targetId: user.id, targetName: 'TA' });
    }
  }, [user, targetId, saveAndSend]);

  const handleNudge = useCallback(() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); handleSendText('向对方发送了震动提醒'); }, [handleSendText]);
  
  const handleToggleAudio = useCallback((id, url) => { 
    if (playingAudioId === id) { 
      globalAudioPlayer.pause(); 
      setPlayingAudioId(null); 
    } else { 
      wasCinemaPlayingRef.current = cinemaPlayer ? cinemaPlayer.playing : false;

      setPlayingAudioId(id); 
      globalAudioPlayer.replace(url); 
      globalAudioPlayer.play(); 
      
      if (wasCinemaPlayingRef.current) {
        setTimeout(() => {
          if (cinemaPlayer && !cinemaPlayer.playing) {
            cinemaPlayer.play();
          }
        }, 250);
      }
    } 
  }, [globalAudioPlayer, playingAudioId, cinemaPlayer]);

  useEffect(() => { 
    let interval;
    let ticks = 0;
    if (globalAudioPlayer && playingAudioId) { 
      let playStarted = false;
      interval = setInterval(() => {
        ticks++;
        const cur = globalAudioPlayer.currentTime || 0;
        const dur = globalAudioPlayer.duration || 0;
        
        if (cur > 0.05 && dur > 0) {
          playStarted = true;
        }
        
        if (playStarted && (!globalAudioPlayer.playing || cur >= dur - 0.15)) {
          globalAudioPlayer.pause(); 
          setPlayingAudioId(null);
          
          if (wasCinemaPlayingRef.current && cinemaPlayer && !cinemaPlayer.playing) {
             cinemaPlayer.play();
          }
        }
        
        if (!playStarted && ticks > 35) {
          setPlayingAudioId(null);
          globalAudioPlayer.pause();
        }
      }, 100);
    } 
    return () => clearInterval(interval);
  }, [globalAudioPlayer, playingAudioId, cinemaPlayer]);

  const handleAudioFinish = useCallback(() => setPlayingAudioId(null), []);
  const dismissAllPanels = () => { Keyboard.dismiss(); chatInputRef.current?.closePanels(); };

  const handleOpenMedia = useCallback((tappedItem) => { Keyboard.dismiss(); const mediaMessages = messagesRef.current.filter(m => m.type === 'image' || m.type === 'video').reverse(); const index = mediaMessages.findIndex(m => m.id === tappedItem.id); if (index !== -1) setPreviewState({ visible: true, index: index, mediaList: mediaMessages }); }, []);
  const handleLongPressMessage = useCallback((msg) => { Keyboard.dismiss(); setActionMessage(msg); }, []);
  const handleCopy = async (text) => { await Clipboard.setStringAsync(text); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setActionMessage(null); };
  const handleSaveToAlbum = async (url) => { const { status } = await MediaLibrary.requestPermissionsAsync(); if (status === 'granted') { await MediaLibrary.saveToLibraryAsync(url); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } setActionMessage(null); };
  const handleFavorite = () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); setActionMessage(null); };
  const handleDelete = useCallback(async (id) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); setMessages(prev => prev.filter(m => m.id !== id)); setActionMessage(null); const deletedStr = await AsyncStorage.getItem(CACHE_DEL_KEY); const deletedIds = deletedStr ? JSON.parse(deletedStr) : []; deletedIds.push(id); await AsyncStorage.setItem(CACHE_DEL_KEY, JSON.stringify(deletedIds)); }, [targetId, CACHE_DEL_KEY]);
  const handleRecallMsg = useCallback(async (id) => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setActionMessage(null); setMessages(prev => prev.map(m => m.id === id ? { ...m, type: 'action', text: '你撤回了一条消息', mediaUrl: null, thumbnailUrl: null } : m)); await supabase.from('messages').update({ type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null }).eq('id', id); }, []);

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

      {isTransitioning ? (
        <View style={styles.loadingContainer}><ActivityIndicator size="small" color={palette.textSecondary} /></View>
      ) : (
        <View style={styles.chatArea}>
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
            onStartRecord={handleStartRecord} onStopRecord={handleStopRecord} onCancelRecord={handleCancelRecord} 
            onPickMedia={handlePickMedia} onNudge={handleNudge} audioRecorder={audioRecorder}
            onStartCall={handleStartCall}
          />
        </View>
      )}

      <Modal visible={previewState.visible} transparent={true} animationType="none" onRequestClose={() => setPreviewState({ ...previewState, visible: false })}>
        {previewState.visible && (
          <InteractiveMediaViewer 
            mediaList={previewState.mediaList} 
            initialIndex={previewState.index} 
            onClose={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setPreviewState({ ...previewState, visible: false }); }} 
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
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' }
});
// --- END OF FILE src/components/ChatRoomInner.js ---