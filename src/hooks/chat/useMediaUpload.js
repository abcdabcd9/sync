// --- START OF FILE src/hooks/chat/useMediaUpload.js ---
import { useState, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File } from 'expo-file-system';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { decode as base64ToArrayBuffer } from 'base64-arraybuffer';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';

import { supabase } from '../../services/supabase';
import { sendPushNotification } from '../../services/pushService';
import { persistMedia, resolveLocalMedia } from '../../services/mediaCache';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50MB
const STORAGE_BUCKET = 'chat_media';

export const SIGNED_URL_TTL = 60 * 60 * 24 * 7;

/**
 * 🔧 存储路径清洗归一化。
 *
 * createSignedUrl 只接受「桶内相对路径」（形如 `${userId}/${filename}`）。
 * 一旦传入带桶名前缀或完整 URL 的字符串，Supabase 会把它当作不存在的对象，
 * 直接抛 `StorageApiError: Object not found`。
 *
 * 常见脏输入来源：
 *   - 历史数据里存了完整签名 URL：`https://xxx.supabase.co/storage/v1/object/sign/chat_media/u/f.jpg?token=...`
 *   - 历史数据里存了带桶名前缀的路径：`chat_media/u/f.jpg`
 *   - 本地文件 URI（file:// / content:// / ph://）—— 不是桶内对象，返回空串
 *
 * @param {string|null|undefined} pathOrUrl
 * @returns {string} 纯相对路径；无法解析时返回空串
 */
export function cleanStoragePath(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return '';
  const trimmed = pathOrUrl.trim();
  if (!trimmed) return '';

  // 本地文件 URI 不是桶内对象路径，不能拿去签名
  if (/^(file|content|ph|assets-library|data|blob):/i.test(trimmed)) return '';

  // 1. 完整 Supabase URL：截取 /chat_media/ 之后的相对路径（剥离 query / hash）
  if (trimmed.includes(`/${STORAGE_BUCKET}/`)) {
    const tail = trimmed.split(`/${STORAGE_BUCKET}/`).pop() || '';
    return tail.split(/[?#]/)[0];
  }

  // 2. 带桶名前缀的相对路径：剥离 `chat_media/`
  return trimmed.replace(new RegExp(`^${STORAGE_BUCKET}/`), '');
}

export async function createSignedMediaUrl(fileName, expiresIn = SIGNED_URL_TTL) {
  // 🔧 签名前必须先归一化路径，否则会因前缀/完整 URL 触发 Object not found
  const objectPath = cleanStoragePath(fileName);
  if (!objectPath) return null;
  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(objectPath, expiresIn);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.warn('生成签名 URL 失败:', e);
    return null;
  }
}

export async function uploadToSupabase(uri, prefix, userId) {
  if (!uri) return null;
  if (!userId) {
    console.warn('媒体上传失败: 缺少 userId，无法生成带用户命名空间的对象路径');
    return null;
  }
  try {
    let safeUri = uri;
    if (Platform.OS === 'ios' && !safeUri.startsWith('file://')) {
      safeUri = 'file://' + safeUri;
    }

    let ext = uri.split('.').pop()?.split('?')[0];
    if (!ext || ext.length > 5) {
      if (prefix === 'audio') ext = 'm4a';
      else if (prefix === 'vid') ext = 'mp4';
      else ext = 'jpg';
    }

    const base64 = await readAsStringAsync(safeUri, { encoding: EncodingType.Base64 });
    if (!base64) throw new Error('读取本地文件失败：内容为空');
    const arrayBuffer = base64ToArrayBuffer(base64);
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('读取本地文件失败：字节长度为 0');
    }

    const fileName = `${userId}/${prefix}_${Date.now()}_${Crypto.randomUUID()}.${ext}`;

    // 🔐 RLS 对齐校验：chat_media 的存储策略要求
    //    (storage.foldername(name))[1] = auth.uid()::text
    //    即对象路径第一段必须严格等于当前用户 id，否则上传会被拒绝。
    if (!fileName.startsWith(`${userId}/`)) {
      throw new Error(`非法对象路径（未以 userId 开头）: ${fileName}`);
    }

    // 🔍 诊断日志 a：上传前
    console.log(`[Storage Upload] 开始上传，目标桶: ${STORAGE_BUCKET}, 路径: ${fileName}`);

    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, arrayBuffer, { contentType: guessContentType(ext) });

    // 🔍 诊断日志 b：上传后
    console.log(`[Storage Upload] 上传结果: ${error ? error.message : '成功'}`);
    if (error) throw error;

    const signedUrl = await createSignedMediaUrl(fileName, SIGNED_URL_TTL);
    return { path: fileName, signedUrl };
  } catch (e) {
    console.warn('媒体上传失败:', e?.message || e);
    return null;
  }
}

function guessContentType(ext) {
  switch (String(ext || '').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'gif':
      return 'image/gif';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'm4v':
      return 'video/x-m4v';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'caf':
      return 'audio/x-caf';
    default:
      return 'application/octet-stream';
  }
}

function getLocalFileSize(uri) {
  try {
    const info = new File(uri).info();
    return typeof info?.size === 'number' ? info.size : null;
  } catch (_) {
    return null;
  }
}

export function useMediaUpload({ targetId, user, saveAndSend, patchMessage, deleteMessage }) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadingRef = useRef(false);

  const pickAndSendMedia = useCallback(async () => {
    if (!user || !targetId) return;
    if (uploadingRef.current) return;

    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        // 注：这是相册权限弹窗，非发送失败弹窗，保留
        console.warn('无相册权限');
        return;
      }
    } catch (e) {
      console.warn('申请相册权限失败:', e?.message || e);
    }

    let result;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.6,
        videoMaxDuration: 120,
      });
    } catch (e) {
      console.warn('打开相册失败:', e?.message || e);
      return;
    }

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];

    const size = getLocalFileSize(asset.uri);
    if (size && size > MAX_MEDIA_BYTES) {
      console.warn('文件过大');
      return;
    }

    const isVideo = asset.type === 'video';
    const msgType = isVideo ? 'video' : 'image';
    const prefix = isVideo ? 'vid' : 'img';

    uploadingRef.current = true;
    setUploading(true);
    setUploadProgress(0);

    const msgId = Crypto.randomUUID();
    let optimisticInserted = false;

    try {
      let localThumbUri = null;
      if (isVideo) {
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 500 });
          localThumbUri = uri;
        } catch (_) {}
      }

      const sandboxMediaUri = await persistMedia(asset.uri, msgId, isVideo ? 'video' : 'image');
      const sandboxThumbUri = localThumbUri
        ? await persistMedia(localThumbUri, msgId, 'thumb')
        : null;

      const assetW = Number(asset.width) || 0;
      const assetH = Number(asset.height) || 0;
      const localMediaUri = sandboxMediaUri || asset.uri;
      const localThumbFinal = sandboxThumbUri || localThumbUri;
      
      saveAndSend({
        id: msgId,
        type: msgType,
        mediaUrl: localMediaUri,
        localUri: localMediaUri,
        thumbnailUrl: localThumbFinal,
        localThumbUri: localThumbFinal,
        mediaWidth: assetW,
        mediaHeight: assetH,
        isMe: true,
        timestamp: Date.now(),
      });
      optimisticInserted = true;

      setUploadProgress(0.3);
      const mediaResult = await uploadToSupabase(asset.uri, prefix, user.id);
      setUploadProgress(0.6);

      let thumbResult = null;
      if (localThumbUri) {
        thumbResult = await uploadToSupabase(localThumbUri, 'thumb', user.id);
      }
      setUploadProgress(0.9);

      if (!mediaResult?.path) throw new Error('media upload failed');

      const { error: insertError } = await supabase.from('messages').insert({
        id: msgId,
        user_id: user.id,
        receiver_id: targetId,
        type: msgType,
        media_url: mediaResult.path,
        thumbnail_url: thumbResult?.path ?? null,
      });
      if (insertError) throw insertError;

      const sandboxMedia = sandboxMediaUri || (await resolveLocalMedia(msgId, isVideo ? 'video' : 'image'));
      const sandboxThumb = sandboxThumbUri || (await resolveLocalMedia(msgId, 'thumb'));
      patchMessage?.(msgId, {
        remotePath: mediaResult.path,
        remoteThumbPath: thumbResult?.path ?? null,
        localUri: sandboxMedia || localMediaUri,
        localThumbUri: sandboxThumb || localThumbFinal,
      });

      const msgLabel = isVideo ? '[视频]' : '[图片]';
      sendPushNotification(targetId, '', msgLabel, {
        type: 'chat',
        targetId: user.id,
      });

      setUploadProgress(1);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      console.warn('离线/发送失败，已标记为待重发', e?.message || e);
      // 🚨 彻底移除弹窗与删除！静默标记为 failed，供用户点击感叹号重试
      if (optimisticInserted) {
        patchMessage?.(msgId, { status: 'failed' });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      setUploadProgress(0);
    }
  }, [user, targetId, saveAndSend, patchMessage, deleteMessage]);

  return {
    uploading,
    uploadProgress,
    pickAndSendMedia,
    uploadToSupabase,
    createSignedMediaUrl,
  };
}

export default useMediaUpload;
// --- END OF FILE src/hooks/chat/useMediaUpload.js ---