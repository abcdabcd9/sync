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
import { useMediaUpload, uploadToSupabase } from '../hooks/chat/useMediaUpload';
import { useAudioRecorder } from '../hooks/chat/useAudioRecorder';
import { useChatPrefs } from '../hooks/chat/useChatPrefs';
import { useChatFavorites } from '../hooks/chat/useChatFavorites';
import { getSignedUrl, toStoragePath } from '../hooks/chat/useSignedMediaUrl';
import { downloadToSandbox, isLocalUri, normalizeFileUri, resolveLocalMedia } from '../services/mediaCache';
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

  // ❗ 点击红色感叹号重发：幂等重发（先查后插，绝不覆盖云端已有消息）
  // 说明：authenticated 角色对 messages 表只有部分列的 UPDATE 权限，
  // 且 PostgreSQL 的 ON CONFLICT DO UPDATE 会校验冲突分支中所有引用列的权限，
  // 因此这里禁止使用 upsert（会因 user_id/receiver_id/subtype 无 UPDATE 权限而报 42501）。
  const handleResendMessage = useCallback(async (msg) => {
    if (!msg || !user || !targetId) return;
    patchMessage(msg.id, { status: 'sending' });
    try {
      // ===== 媒体消息：重发前必须先拿到「有效的远程对象路径」 =====
      // 铁律：messages.media_url / thumbnail_url 只允许存 Storage 相对路径，
      //       绝不允许把 file:// / content:// 等本地 URI 落库（对端永远读不到）。
      const isMediaMsg = msg.type === 'image' || msg.type === 'video'
        || msg.type === 'audio' || msg.subtype === 'SYNC_AUDIO';

      // 只接受「非本地 URI」的已有值作为可复用远程路径
      const reusableRemote = (v) => (typeof v === 'string' && v && !isLocalUri(v) ? v : null);

      let mediaUrl = reusableRemote(msg.mediaUrl) || reusableRemote(msg.remotePath);
      let thumbnailUrl = reusableRemote(msg.thumbnailUrl) || reusableRemote(msg.remoteThumbPath);

      if (isMediaMsg && !mediaUrl) {
        // 1) 定位本地文件：内存/磁盘沙盒优先，其次消息上记录的本地 URI
        const mediaKind = msg.type === 'video' ? 'video' : (msg.type === 'audio' ? 'audio' : 'image');
        let localPath = null;
        try {
          localPath = await resolveLocalMedia(msg.id, mediaKind);
        } catch (_) {}
        if (!localPath) {
          const candidate = msg.localUri || msg.uri;
          if (isLocalUri(candidate)) localPath = candidate;
        }

        // 2) 本地文件已丢失（系统清理临时目录 / 用户清缓存）→ 明确告知，不伪造成功
        if (!localPath) {
          throw new Error('MEDIA_LOCAL_MISSING');
        }

        // 3) 用与正常发送完全一致的 ArrayBuffer 上传通道补传
        const prefix = msg.type === 'video' ? 'vid' : (msg.type === 'audio' ? 'audio' : 'img');
        const uploaded = await uploadToSupabase(localPath, prefix, user.id);
        if (!uploaded?.path) {
          throw new Error('MEDIA_UPLOAD_FAILED');
        }
        mediaUrl = uploaded.path;

        // 4) 视频/图片缩略图：本地有则一并补传；失败不影响主媒体可读性
        if (!thumbnailUrl && (msg.type === 'video' || msg.type === 'image')) {
          let localThumb = null;
          try {
            localThumb = await resolveLocalMedia(msg.id, 'thumb');
          } catch (_) {}
          if (!localThumb && isLocalUri(msg.localThumbUri)) localThumb = msg.localThumbUri;
          if (localThumb) {
            const thumbUploaded = await uploadToSupabase(localThumb, 'thumb', user.id);
            if (thumbUploaded?.path) thumbnailUrl = thumbUploaded.path;
          }
        }
      }

      // 1) 先查云端是否已存在该 UUID（应对「请求已到达但响应丢失」的场景）
      const { data: existing, error: selectErr } = await supabase
        .from('messages')
        .select('id, user_id, receiver_id, type, text, media_url, thumbnail_url, duration')
        .eq('id', msg.id)
        .maybeSingle();

      if (selectErr) throw selectErr;

      if (existing) {
        // 2) 已存在：严格校验归属与内容，绝不篡改云端已有消息
        const sameOwner = existing.user_id === user.id && existing.receiver_id === targetId;
        const sameType = (existing.type || 'text') === (msg.type || 'text');
        const sameText = (existing.text || '') === (msg.text || '');
        if (!sameOwner || !sameType || !sameText) {
          throw new Error('云端已存在同 ID 但内容不一致的消息，已中止重发以避免覆盖');
        }
        // 云端已有行：以云端 media_url 为准。若云端存的是本地 URI（历史脏数据），
        // 则用本次补传得到的有效远程路径覆盖本地展示，但绝不写回数据库。
        const cloudMedia = reusableRemote(existing.media_url) || mediaUrl;
        const cloudThumb = reusableRemote(existing.thumbnail_url) || thumbnailUrl;
        // 媒体消息若云端行没有任何可读远程路径，视为「看似成功但不可读」，保持失败态
        if (isMediaMsg && !cloudMedia) {
          throw new Error('MEDIA_REMOTE_INVALID');
        }
        patchMessage(msg.id, {
          status: 'sent',
          mediaUrl: cloudMedia,
          thumbnailUrl: cloudThumb,
          remotePath: cloudMedia,
          remoteThumbPath: cloudThumb,
          resendBlocked: null,
          duration: existing.duration ?? msg.duration,
        });
        return;
      }

      // 3) 不存在：执行纯 INSERT（仅插入，不触发任何 UPDATE 分支）
      const { error: insertErr } = await supabase.from('messages').insert({
        id: msg.id,
        user_id: user.id,
        receiver_id: targetId,
        type: msg.type || 'text',
        text: msg.text || '',
        media_url: mediaUrl,
        thumbnail_url: thumbnailUrl,
        subtype: msg.subtype || null,
        duration: msg.duration || 0, // ⚡ 重发必须带上语音时长，否则会显示 0 秒
      });

      if (insertErr) {
        // 4) 唯一键冲突（23505）：说明并发/竞态下已被写入，重新读取并校验，不重复插入
        if (insertErr.code === '23505') {
          const { data: raced, error: raceErr } = await supabase
            .from('messages')
            .select('id, user_id, receiver_id, type, text, media_url, thumbnail_url, duration')
            .eq('id', msg.id)
            .maybeSingle();
          if (raceErr) throw raceErr;
          if (!raced) throw insertErr;
          const sameOwner = raced.user_id === user.id && raced.receiver_id === targetId;
          const sameType = (raced.type || 'text') === (msg.type || 'text');
          const sameText = (raced.text || '') === (msg.text || '');
          if (!sameOwner || !sameType || !sameText) {
            throw new Error('并发写入的消息内容不一致，已中止重发以避免覆盖');
          }
          const racedMedia = reusableRemote(raced.media_url) || mediaUrl;
          const racedThumb = reusableRemote(raced.thumbnail_url) || thumbnailUrl;
          if (isMediaMsg && !racedMedia) {
            throw new Error('MEDIA_REMOTE_INVALID');
          }
          patchMessage(msg.id, {
            status: 'sent',
            mediaUrl: racedMedia,
            thumbnailUrl: racedThumb,
            remotePath: racedMedia,
            remoteThumbPath: racedThumb,
            resendBlocked: null,
            duration: raced.duration ?? msg.duration,
          });
          return;
        }
        throw insertErr;
      }

      // 5) 仅在确认持久化成功后标记为已发送
      patchMessage(msg.id, {
        status: 'sent',
        mediaUrl,
        thumbnailUrl,
        remotePath: mediaUrl,
        remoteThumbPath: thumbnailUrl,
        resendBlocked: null,
        duration: msg.duration,
      });
      if (msg.type === 'text' && msg.text) {
        sendPushNotification(targetId, '', msg.text, { type: 'chat', targetId: user.id });
      }
    } catch (e) {
      const code = e?.message || '';
      console.warn('重发依然失败，保持失败状态', code);
      // 本地媒体文件已被系统清理：明确告知无法重发，引导重新选择/录制
      if (code === 'MEDIA_LOCAL_MISSING') {
        patchMessage(msg.id, {
          status: 'failed',
          resendBlocked: 'local_missing',
        });
        Alert.alert(
          '无法重发',
          '原始媒体文件已从本机清理，无法再次上传。请重新选择或重新录制后发送。',
        );
        return;
      }
      if (code === 'MEDIA_UPLOAD_FAILED') {
        patchMessage(msg.id, { status: 'failed', resendBlocked: null });
        Alert.alert('重发失败', '媒体上传未成功，请检查网络后重试。');
        return;
      }
      if (code === 'MEDIA_REMOTE_INVALID') {
        patchMessage(msg.id, { status: 'failed', resendBlocked: 'remote_invalid' });
        Alert.alert('无法重发', '云端媒体对象不可用，请重新选择或重新录制后发送。');
        return;
      }
      patchMessage(msg.id, { status: 'failed' });
    }
  }, [user, targetId, patchMessage]);

  const handleAcceptPartner = async (msg) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // 🔒 授权关系只能由服务端 RPC 建立（partner_authorizations 表对客户端只读）。
    //    T6/A02：卡片消息 id 即授权记录 id（bind_partner 用 request_partner 返回值作为卡片 id），
    //    因此这里直接把 msg.id 作为 auth_id 传入，卡片与授权事实一一对应。
    const { error: bindError } = await supabase.rpc('accept_partner_invite', {
      auth_id: msg.id,
    });
    if (bindError) {
      console.error('绑定健康搭子失败:', bindError);
      Alert.alert('绑定失败', '请检查网络后重试');
      return;
    }

    // T6/A08：accept 对「过期邀请」不抛错而是把状态落库为 expired 并返回。
    //   这里回查授权状态，区分「成功」与「已过期」，避免把过期当成绑定成功。
    const { data: authRow } = await supabase
      .from('partner_authorizations')
      .select('status')
      .eq('id', msg.id)
      .single();
    if (authRow?.status !== 'accepted') {
      Alert.alert('邀请已失效', '该邀请已过期或被取消，请让对方重新发起邀请。');
      return;
    }

    // T6.1/FIX-01：卡片 subtype 已由 accept_partner_invite 在同一事务内改为
    //   SYNC_PARTNER_ACCEPTED，客户端不再写任何 SYNC_PARTNER_* 字段。
    //   这里只补一条普通系统提示消息（subtype 为 NULL，属正常业务写入）。
    await supabase.from('messages').insert({ id: Crypto.randomUUID(), user_id: user.id, receiver_id: targetId, type: 'system', text: '我已同意你的健康搭子邀请，互相监督吧！' });
    sendPushNotification(targetId, '', '已同意成为你的健康搭子！', { type: 'chat', targetId: user.id });
    await refreshPartner(targetId);
  };

  const handleRejectPartner = async (msg) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // 🔒 拒绝走服务端 RPC（状态机在服务端）。
    //    T6.1/FIX-01：卡片 subtype 由 reject_partner_invite 在同一事务内改为
    //    SYNC_PARTNER_REJECTED。旧实现在 RPC 返回后由客户端再 UPDATE messages，
    //    会被迁移 21 的列权限/触发器拒绝（客户端不能改 subtype），
    //    导致卡片永远停在「待处理」。现在客户端不再直写。
    const { error: rejectError } = await supabase.rpc('reject_partner_invite', {
      auth_id: msg.id,
    });
    if (rejectError) {
      console.error('拒绝搭子邀请失败:', rejectError);
      Alert.alert('操作失败', '请检查网络后重试');
      return;
    }
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