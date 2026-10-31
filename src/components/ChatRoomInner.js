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

// ===== 微信同款时间格式化（全球时区 / 地区格式自动适配）=====
// 今天 → 14:25 或 2:25 PM / 昨天 → 昨天 14:25 或 Yesterday 2:25 PM
// 7 天内 → 星期三 14:25 或 Wed 2:25 PM / 今年内 → 10月25日 14:25 或 Oct 25 2:25 PM
// 跨年 → 2025年10月25日 14:25 或 Oct 25, 2025 2:25 PM
const formatWeChatTime = (timestamp) => {
  if (!timestamp) return '';
  // 1. 自动转换为手机本地所在时区的时间
  const date = new Date(typeof timestamp === 'number' ? timestamp : String(timestamp));
  if (isNaN(date.getTime())) return '';

  const now = new Date();

  // 判断是否为当地时间的“今天”
  const isToday = date.toDateString() === now.toDateString();

  // 判断是否为当地时间的“昨天”
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  // 自动获取手机系统的 12/24 小时制与本地时间格式 (如 "14:25" 或 "2:25 PM")
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr;
  }

  if (isYesterday) {
    // 自动适配当地语言的“昨天” (如中文“昨天”，英文“Yesterday”)
    try {
      const yesterdayLabel = new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(-1, 'day');
      return `${yesterdayLabel} ${timeStr}`;
    } catch (_e) {
      return `昨天 ${timeStr}`;
    }
  }

  // 7 天以内：自动适配当地语言的星期几 (如中文“星期三”，英文“Wed”)
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 7 && diffDays > 0) {
    const weekdayStr = date.toLocaleDateString([], { weekday: 'short' });
    return `${weekdayStr} ${timeStr}`;
  }

  // 今年以内：自动适配当地月日格式 (如“10月25日” 或 “Oct 25” 或 “25 Oct”)
  const isSameYear = date.getFullYear() === now.getFullYear();
  if (isSameYear) {
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dateStr} ${timeStr}`;
  }

  // 跨年：自动适配当地年月日格式
  const fullDateStr = date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  return `${fullDateStr} ${timeStr}`;
};

export default function ChatRoomInner({ targetId, targetName, isTabletMode = false, onBack }) {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  // 🌐 全局健康上下文：同意搭子邀请后必须同步刷新，否则首页伴侣卡片不更新
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
  // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
  const handleSendText = useCallback(async (text) => {
    if (!user || !targetId) return;
    const msgId = Crypto.randomUUID();
    saveAndSend({ id: msgId, type: 'text', text, isMe: true, timestamp: Date.now() });
    try {
      const { error } = await supabase.from('messages').insert({ id: msgId, user_id: user.id, receiver_id: targetId, type: 'text', text });
      // ❗ 离线/写入失败：标记为 failed，气泡旁显示红色感叹号，可点击重发
      if (error) throw error;
    } catch (e) {
      console.warn('离线状态，消息发送失败，已标记为待重发', e?.message ?? e);
      patchMessage(msgId, { status: 'failed' });
      return;
    }
    sendPushNotification(targetId, '', text, { type: 'chat', targetId: user.id });
  }, [user, targetId, saveAndSend, patchMessage]);

  // ❗ 点击红色感叹号重发：先清除失败标记，再重新走一次发送流程
  const handleResendMessage = useCallback(async (msg) => {
    if (!msg || !user || !targetId) return;
    patchMessage(msg.id, { status: 'sending' });
    try {
      const { error } = await supabase.from('messages').insert({
        id: msg.id,
        user_id: user.id,
        receiver_id: targetId,
        type: msg.type || 'text',
        text: msg.text || '',
        media_url: msg.mediaUrl || null,
        thumbnail_url: msg.thumbnailUrl || null,
        subtype: msg.subtype || null,
      });
      if (error) throw error;
      patchMessage(msg.id, { status: 'sent' });
      if (msg.type === 'text' && msg.text) {
        sendPushNotification(targetId, '', msg.text, { type: 'chat', targetId: user.id });
      }
    } catch (e) {
      console.warn('离线状态，重发仍然失败', e?.message ?? e);
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
    // 🌐 同步刷新全局上下文：写入 partnerId 并拉取对方今日进度，
    //    否则首页伴侣卡片要等冷启动才出现
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

  // ===== 语音播放（与影院播放器互不打断）=====
  //
  // 🚨 断网（飞行模式）播放核心修复：
  //   1. 播放前显式 setAudioModeAsync 解锁扬声器（allowsRecording: false → iOS 切回
  //      .playback 类别，否则录音后残留的 .playAndRecord 会让声音走听筒 / 静音）。
  //   2. 传入的 url 若已是本地 file:// 物理文件（由 MessageBubble 解析），
  //      音频引擎直接读磁盘，飞行模式下零网络、100% 可播。
  //   3. 若传入的仍是网络 URL（本地缺失的对方语音），先尝试静默下载到沙盒再播放，
  //      下载失败（离线）则保持原 URL 由引擎自行处理，绝不崩溃。
  const handleToggleAudio = useCallback(async (id, url, options = {}) => {
    if (playingAudioId === id) {
      globalAudioPlayer.pause();
      setPlayingAudioId(null);
      return;
    }
    if (!url) return;

    // 🔓 解锁扬声器：录音结束后 iOS 音频会话可能仍停留在 playAndRecord，
    //    必须显式切回播放模式，否则飞行模式下播放会静默失败。
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

    // 🗄️ 网络 URL → 尝试静默落盘为本地 file://（离线时失败则保持原 URL）
    //
    // 🔧 双端兼容：用 isLocalUri 判定（兼容 content:// / data: / ph://），
    //    并用 normalizeFileUri 收敛为单重 file:///（Android 重复前缀会让音频引擎报错）。
    //    options.isLocal 由 MessageBubble 传入，表示 url 已是本地物理文件，无需再落盘。
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

      // 🔒 P0-2 / P0-3：数据库只存相对对象路径，保存前必须先换取签名 URL。
      //    - 历史数据若已是完整签名 URL，toStoragePath 会提取路径后重新签名，
      //      避免使用可能已过期的旧 token。
      //    - Asset.create 只接受本地文件路径，必须先把远程签名 URL 下载到缓存再入库。
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

  // ⭐ 收藏：写入本地持久化（AsyncStorage），可在「聊天设置 → 我的收藏」查看
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

  // ===== 右上角「3 个点」：直接跳转聊天设置页（不再弹窗）=====
  const openChatSettings = useCallback(() => {
    if (!targetId) return;
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({
      pathname: '/chat/chat_settings',
      params: { targetId, targetName: targetName || '' },
    });
  }, [router, targetId, targetName]);

  // 🗑️ 地图卡片功能已整体下线：不再从 /chat/location 回传坐标，也不再插入 type='location' 消息。
  //    定位页 src/app/chat/location.js 本身保留（位置能力不删），只是聊天入口已移除。

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { borderBottomColor: palette.chatBorder }]}>
        {!isTabletMode && (
          <TouchableOpacity onPress={onBack} style={styles.backBtn}><Ionicons name="chevron-back" size={28} color={palette.primary} /></TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: palette.textPrimary, marginLeft: isTabletMode ? 16 : 0 }]}>{targetName || '好友'}</Text>
        {/* 右上角「3 个点」：跳转聊天设置页 */}
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
              // 列表为 inverted 倒序渲染：视觉上的「上一条」在数据里是 index + 1
              const prevMsg = messages[index + 1];
              const shouldShowTime = !prevMsg || Math.abs(item.timestamp - prevMsg.timestamp) >= 15 * 60 * 1000;
              return (
                <View>
                  {shouldShowTime && (
                    <View style={styles.timeDividerContainer}>
                      <Text style={styles.timeDividerText}>{formatWeChatTime(item.timestamp)}</Text>
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
            // 🚨 Android 闪烁修复：removeClippedSubviews 会在滚动时把 item 的原生视图
            //    从视图树摘掉再挂回，导致图片/视频气泡反复重新解码 → 肉眼可见的闪烁与抖动。
            //    这里显式关闭，改由 windowSize 控制内存占用。
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
  timeDividerContainer: { alignItems: 'center', marginVertical: 10 },
  timeDividerText: { color: 'rgba(255, 255, 255, 0.45)', fontSize: 12, backgroundColor: 'rgba(0, 0, 0, 0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }
});
// --- END OF FILE src/components/ChatRoomInner.js ---
