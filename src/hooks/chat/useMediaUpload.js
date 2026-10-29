// --- START OF FILE src/hooks/chat/useMediaUpload.js ---
import { useState, useCallback, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';

import { supabase } from '../../services/supabase';
import { sendPushNotification } from '../../services/pushService';

/**
 * 🖼️ 媒体上传域 Hook（任务 7 阶段 2）
 *
 * 职责（仅图片 / 视频，不含任何麦克风录音与音频播放）：
 *   1. 打开系统相册选择图片 / 视频（expo-image-picker 标准 API）
 *   2. 视频首帧缩略图生成（expo-video-thumbnails）
 *   3. 上传文件到 Supabase Storage `chat_media` 桶
 *   4. 乐观发送 + 落库 + 推送通知（复用 useChatMessages 的 saveAndSend）
 *
 * ⚠️ 最高指令：本文件严禁触碰麦克风录音、语音播放与录音权限代码（阶段 3 处理）。
 *    音频上传仍由 ChatRoomInner.js 直接调用本 Hook 暴露的 uploadToSupabase。
 *
 * 📌 任务 8：已移除 `expo-media-library/legacy` 依赖，改用 SDK 58 标准 API。
 *    - `FileSystem.getInfoAsync` → `new File(uri).info()`（同步，返回 { exists, size }）
 *    - `ImagePicker.MediaTypeOptions` → `mediaTypes: ['images', 'videos']`
 */

const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50MB
const STORAGE_BUCKET = 'chat_media';

const generateUUID = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

/**
 * 上传本地文件到 Supabase Storage，返回 publicUrl（失败返回 null）
 * @param {string} uri 本地文件 URI
 * @param {'img'|'vid'|'thumb'|'audio'} prefix 文件名前缀
 */
export async function uploadToSupabase(uri, prefix) {
  if (!uri) return null;
  try {
    let safeUri = uri;
    if (Platform.OS === 'ios' && !safeUri.startsWith('file://')) {
      safeUri = 'file://' + safeUri;
    }
    const response = await fetch(safeUri);
    const blob = await response.blob();

    // 🍎 正确匹配视频和音频的容错后缀，绝不滥杀无辜全变 JPG
    let ext = uri.split('.').pop()?.split('?')[0];
    if (!ext || ext.length > 5) {
      if (prefix === 'audio') ext = 'm4a';
      else if (prefix === 'vid') ext = 'mp4';
      else ext = 'jpg';
    }

    const fileName = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, blob, { contentType: blob.type || 'application/octet-stream' });
    if (error) throw error;

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
    return urlData.publicUrl;
  } catch (_) {
    return null;
  }
}

/**
 * 读取本地文件字节大小（SDK 58 标准 API，同步）
 * @returns {number|null} 字节数，读取失败返回 null
 */
function getLocalFileSize(uri) {
  try {
    const info = new File(uri).info();
    return typeof info?.size === 'number' ? info.size : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} params
 * @param {string} params.targetId 聊天对象 ID
 * @param {object} params.user 当前登录用户
 * @param {Function} params.saveAndSend useChatMessages 暴露的乐观发送
 */
export function useMediaUpload({ targetId, user, saveAndSend }) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadingRef = useRef(false);

  const pickAndSendMedia = useCallback(async () => {
    if (!user || !targetId) return;
    // 防重入：上传中忽略重复点击
    if (uploadingRef.current) return;

    let result;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.6,
        videoMaxDuration: 120,
      });
    } catch (e) {
      console.warn('打开相册失败:', e);
      return;
    }

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];

    // ① 体积校验（50MB）
    const size = getLocalFileSize(asset.uri);
    if (size && size > MAX_MEDIA_BYTES) {
      Alert.alert('文件过大', '请发送小于 50MB 的媒体文件。');
      return;
    }

    const isVideo = asset.type === 'video';
    const msgType = isVideo ? 'video' : 'image';
    const prefix = isVideo ? 'vid' : 'img';

    uploadingRef.current = true;
    setUploading(true);
    setUploadProgress(0);

    try {
      // ② 视频首帧缩略图
      let localThumbUri = null;
      if (isVideo) {
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 500 });
          localThumbUri = uri;
        } catch (_) {}
      }

      // ③ 乐观发送（本地 URI 立即可见）
      const msgId = generateUUID();
      saveAndSend({
        id: msgId,
        type: msgType,
        mediaUrl: asset.uri,
        thumbnailUrl: localThumbUri,
        isMe: true,
        timestamp: Date.now(),
      });

      // ④ 上传主媒体（0% → 60%）
      setUploadProgress(0.3);
      const cloudMediaUrl = await uploadToSupabase(asset.uri, prefix);
      setUploadProgress(0.6);

      // ⑤ 上传缩略图（60% → 90%）
      let cloudThumbUrl = null;
      if (localThumbUri) {
        cloudThumbUrl = await uploadToSupabase(localThumbUri, 'thumb');
      }
      setUploadProgress(0.9);

      // ⑥ 落库
      await supabase.from('messages').insert({
        id: msgId,
        user_id: user.id,
        receiver_id: targetId,
        type: msgType,
        media_url: cloudMediaUrl,
        thumbnail_url: cloudThumbUrl,
      });

      // ⑦ 推送通知
      const msgLabel = isVideo ? '[视频]' : '[图片]';
      sendPushNotification(targetId, '新消息', msgLabel, {
        type: 'chat',
        targetId: user.id,
        targetName: 'TA',
      });

      setUploadProgress(1);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      console.warn('媒体发送失败:', e);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      setUploadProgress(0);
    }
  }, [user, targetId, saveAndSend]);

  return {
    uploading,
    uploadProgress,
    pickAndSendMedia,
    uploadToSupabase,
  };
}

export default useMediaUpload;
// --- END OF FILE src/hooks/chat/useMediaUpload.js ---
