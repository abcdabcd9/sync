// --- START OF FILE src/hooks/chat/useMediaUpload.js ---
import { useState, useCallback, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File } from 'expo-file-system';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { decode as base64ToArrayBuffer } from 'base64-arraybuffer';
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

/**
 * 🔒 安全审计 #14：私密媒体签名有效期（7 天）
 * chat_media 桶已私有化，任何公开 URL 都无法访问，必须使用带 token 的签名 URL。
 *
 * 📌 P0-2 / P0-3：签名 URL 只用于「即时渲染」，绝不写入数据库。
 *    数据库 messages.media_url / thumbnail_url 只存相对对象路径
 *    （形如 `${user.id}/img_1699999999_123.jpg`），渲染时由
 *    useSignedMediaUrl 按需换取临时签名 URL，因此历史照片永不失效。
 */
export const SIGNED_URL_TTL = 60 * 60 * 24 * 7;

const generateUUID = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

/**
 * 🔒 安全审计 #14：为已上传的私有对象生成临时签名 URL
 * @param {string} fileName 桶内对象路径
 * @param {number} expiresIn 有效期（秒），默认 7 天
 * @returns {Promise<string|null>} 签名 URL，失败返回 null
 */
export async function createSignedMediaUrl(fileName, expiresIn = SIGNED_URL_TTL) {
  if (!fileName) return null;
  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(fileName, expiresIn);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.warn('生成签名 URL 失败:', e);
    return null;
  }
}

/**
 * 上传本地文件到 Supabase Storage。
 *
 * 🔒 安全审计 #14 + P0-2 / P0-3：
 *   - chat_media 桶已私有，getPublicUrl 生成的链接将永久 403。
 *   - 对象路径统一为 `${userId}/${prefix}_${ts}_${rand}.${ext}`，
 *     首段必须是上传者 user_id，供 RLS 用 storage.foldername(name)[1] 精确校验。
 *   - 返回 { path, signedUrl }：
 *       path      → 写入 messages.media_url / thumbnail_url（永久有效）
 *       signedUrl → 仅供「本次会话即时渲染」使用，绝不入库
 *
 * @param {string} uri 本地文件 URI
 * @param {'img'|'vid'|'thumb'|'audio'} prefix 文件名前缀
 * @param {string} userId 上传者 ID（作为对象路径首段）
 * @returns {Promise<{path: string, signedUrl: string|null}|null>} 失败返回 null
 */
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

    // 🍎 正确匹配视频和音频的容错后缀，绝不滥杀无辜全变 JPG
    let ext = uri.split('.').pop()?.split('?')[0];
    if (!ext || ext.length > 5) {
      if (prefix === 'audio') ext = 'm4a';
      else if (prefix === 'vid') ext = 'mp4';
      else ext = 'jpg';
    }

    // ⚠️ 关键修复（RN 上传必须用 ArrayBuffer）：
    //   Supabase 官方文档明确说明 —— 在 React Native 上 `Blob` / `File` / `FormData`
    //   作为 upload body 都「不能按预期工作」（fetch(file://) 在 RN 新架构下会失败，
    //   且 RN 的 Blob 实现无法被 storage-js 正确序列化）。
    //   唯一可靠路径：本地文件 → base64 → ArrayBuffer → upload()。
    //   旧实现用 `fetch(uri).blob()`，在真机上直接抛错并被 catch 吞掉返回 null，
    //   导致图片 / 视频 / 语音全部「发不出去」或「退出重进就消失」。
    const base64 = await readAsStringAsync(safeUri, { encoding: EncodingType.Base64 });
    if (!base64) throw new Error('读取本地文件失败：内容为空');
    const arrayBuffer = base64ToArrayBuffer(base64);
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('读取本地文件失败：字节长度为 0');
    }

    // 🔒 P0-3：对象路径首段 = user_id，供 RLS 精确匹配
    const fileName = `${userId}/${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, arrayBuffer, { contentType: guessContentType(ext) });
    if (error) throw error;

    // 签名 URL 仅用于即时渲染，失败不阻断上传（path 已可用，渲染层会重试签名）
    const signedUrl = await createSignedMediaUrl(fileName, SIGNED_URL_TTL);
    return { path: fileName, signedUrl };
  } catch (e) {
    console.warn('媒体上传失败:', e?.message || e);
    return null;
  }
}

/**
 * 按扩展名推断 MIME（ArrayBuffer 上传时 contentType 必须显式给出，
 * 否则 storage 会默认存成 text/plain，导致图片 / 语音无法渲染或播放）。
 */
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
 * @param {Function} [params.patchMessage] useChatMessages 暴露的乐观消息回填
 */
export function useMediaUpload({ targetId, user, saveAndSend, patchMessage }) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadingRef = useRef(false);

  const pickAndSendMedia = useCallback(async () => {
    if (!user || !targetId) return;
    // 防重入：上传中忽略重复点击
    if (uploadingRef.current) return;

    // 📷 相册权限：iOS 14+ 为「受限访问」，Android 13+ 为 READ_MEDIA_IMAGES / VIDEO。
    //    未申请直接 launchImageLibraryAsync 在部分机型上会静默返回 canceled，
    //    表现为「点了媒体库什么都没发生」。
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('无法访问相册', '请在系统设置中允许 Sync 访问你的照片与视频。');
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
      Alert.alert('打开相册失败', '请稍后重试，或检查系统相册权限。');
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
      // 🖼️ 同时带上真实宽高：MessageBubble 用它一次性算出正确气泡比例，
      //    避免「先按 4:3 渲染 → 图片加载完再跳变」的抖动，
      //    也彻底解决横屏照片被 220×300 竖框裁切的问题。
      const msgId = generateUUID();
      const assetW = Number(asset.width) || 0;
      const assetH = Number(asset.height) || 0;
      saveAndSend({
        id: msgId,
        type: msgType,
        mediaUrl: asset.uri,
        thumbnailUrl: localThumbUri,
        mediaWidth: assetW,
        mediaHeight: assetH,
        isMe: true,
        timestamp: Date.now(),
      });

      // ④ 上传主媒体（0% → 60%）
      setUploadProgress(0.3);
      const mediaResult = await uploadToSupabase(asset.uri, prefix, user.id);
      setUploadProgress(0.6);

      // ⑤ 上传缩略图（60% → 90%）
      let thumbResult = null;
      if (localThumbUri) {
        thumbResult = await uploadToSupabase(localThumbUri, 'thumb', user.id);
      }
      setUploadProgress(0.9);

      // ⑥ 落库
      // 🔒 P0-2 / P0-3：media_url / thumbnail_url 只存「相对对象路径」，
      //    绝不存 7 天签名 URL。渲染时由 useSignedMediaUrl 按需签名，
      //    因此历史照片永不失效。
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

      // ⑥-b 回填乐观消息：把本地 file:// URI 换成真实对象路径，
      //      否则本次会话内图片 / 视频无法渲染（必须退出重进才恢复）。
      patchMessage?.(msgId, {
        mediaUrl: mediaResult.path,
        thumbnailUrl: thumbResult?.path ?? localThumbUri,
      });

      // ⑦ 推送通知
      // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
      const msgLabel = isVideo ? '[视频]' : '[图片]';
      sendPushNotification(targetId, '', msgLabel, {
        type: 'chat',
        targetId: user.id,
      });

      setUploadProgress(1);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      console.warn('媒体发送失败:', e?.message || e);
      Alert.alert('发送失败', '媒体上传未完成，请检查网络后重试。');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      setUploadProgress(0);
    }
  }, [user, targetId, saveAndSend, patchMessage]);

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
