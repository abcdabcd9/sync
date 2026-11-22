// --- START OF FILE src/hooks/chat/useAudioRecorder.ts ---
import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import {
  useAudioRecorder as useExpoAudioRecorder,
  RecordingPresets,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';

import { supabase } from '../../services/supabase';
import { sendPushNotification } from '../../services/pushService';
import { uploadToSupabase } from './useMediaUpload';
import { persistMedia, resolveLocalMedia } from '../../services/mediaCache';

/** 录音选项：与迁移前 JS 完全一致（HIGH_QUALITY 展开 + 开启电平计量）。 */
export const AUDIO_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

/**
 * 音频会话模式（与迁移前 JS 完全一致，字段顺序不影响语义）。
 *
 * ⚠️ 这里刻意**不**声明本地 `AudioMode` 接口，而是复用 expo-audio 的
 * `AudioMode` 类型：`setAudioModeAsync` 的参数是 `Partial<AudioMode>`，
 * 其中 `interruptionMode` 是字面量联合类型 `InterruptionMode`。
 * 若自定义接口把 `interruptionMode` 写成 `string`，会因类型不兼容而报错；
 * 复用官方类型可保证「零运行时改动」且类型正确。
 */
export const buildAudioMode = (
  allowsRecording: boolean,
): Parameters<typeof setAudioModeAsync>[0] => ({
  allowsRecording,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'mixWithOthers',
  shouldRouteThroughEarpiece: false,
});

/** `useAudioRecorder` 的入参（与迁移前 JS 解构签名严格一致）。 */
export interface AudioRecorderUser {
  id: string;
}

export interface AudioRecorderOptions {
  targetId: string | null | undefined;
  user: AudioRecorderUser | null | undefined;
  saveAndSend: (msg: Record<string, unknown>) => void;
  patchMessage?: (id: string, patch: Record<string, unknown>) => void;
}

export interface AudioRecorderApi {
  isRecording: boolean;
  recordingDuration: number;
  startRecord: () => Promise<void>;
  stopAndSendRecord: () => void;
  cancelRecord: () => void;
  audioRecorder: ReturnType<typeof useExpoAudioRecorder>;
}

export function useAudioRecorder({
  targetId,
  user,
  saveAndSend,
  patchMessage,
}: AudioRecorderOptions): AudioRecorderApi {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const recordStartTimeRef = useRef(0);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorder = useExpoAudioRecorder(AUDIO_OPTIONS);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const startDurationTimer = useCallback(() => {
    clearDurationTimer();
    setRecordingDuration(0);
    durationTimerRef.current = setInterval(() => {
      if (!recordStartTimeRef.current) return;
      setRecordingDuration(Math.floor((Date.now() - recordStartTimeRef.current) / 1000));
    }, 200);
  }, [clearDurationTimer]);

  useEffect(() => {
    if (!user || !targetId) return;
    let cancelled = false;

    const initAudio = async () => {
      try {
        await requestRecordingPermissionsAsync();
        if (cancelled) return;
        if (typeof setAudioModeAsync === 'function') {
          await setAudioModeAsync(buildAudioMode(true));
        }
      } catch (e) {
        console.warn('Audio init warning:', e);
      }
    };
    initAudio();

    return () => {
      cancelled = true;
      if (typeof setAudioModeAsync === 'function') {
        setAudioModeAsync(buildAudioMode(false)).catch(() => {});
      }
    };
  }, [user, targetId]);

  useEffect(() => () => clearDurationTimer(), [clearDurationTimer]);

  const startRecord = useCallback(async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      recordStartTimeRef.current = 0;

      if (Platform.OS === 'ios') {
        try {
          if (typeof setAudioModeAsync === 'function') {
            await setAudioModeAsync(buildAudioMode(true));
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } catch (_) {}
      }

      await recorder.prepareToRecordAsync();
      recordStartTimeRef.current = Date.now();
      recorder.record();

      setIsRecording(true);
      startDurationTimer();
    } catch (e) {
      console.warn('录音引擎启动失败:', e);
      recordStartTimeRef.current = 0;
      setIsRecording(false);
      clearDurationTimer();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [recorder, startDurationTimer, clearDurationTimer]);

  const stopAndSendRecord = useCallback(() => {
    try {
      if (!recordStartTimeRef.current) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      try {
        recorder.stop();
      } catch (_) {}

      const tempUri = recorder.uri;
      const durationSec = Math.round((Date.now() - recordStartTimeRef.current) / 1000);
      recordStartTimeRef.current = 0;

      setIsRecording(false);
      setRecordingDuration(0);
      clearDurationTimer();

      if (durationSec < 1 || !tempUri) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      setTimeout(async () => {
        const msgId = Crypto.randomUUID();

        const localUri = await persistMedia(tempUri, msgId, 'audio');

        saveAndSend({
          id: msgId,
          type: 'audio',
          mediaUrl: localUri || tempUri,
          localUri: localUri || tempUri,
          duration: durationSec,
          isMe: true,
          timestamp: Date.now(),
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        const audioResult = await uploadToSupabase(tempUri, 'audio', user!.id);
        if (!audioResult?.path) {
          // 🚨 离线/上传失败：不弹窗、不删气泡，仅静默挂红感叹号
          console.warn('离线/语音上传失败，已标记为待重发');
          patchMessage?.(msgId, { status: 'failed' });
          return;
        }

        const { error: insertError } = await supabase!.from('messages').insert({
          id: msgId,
          user_id: user!.id,
          receiver_id: targetId,
          type: 'audio',
          media_url: audioResult.path,
          duration: durationSec,
        });

        if (insertError) {
          console.warn('语音消息落库失败，已标记为待重发:', insertError.message);
          patchMessage?.(msgId, { status: 'failed' });
          return;
        }

        const sandboxUri = localUri || (await resolveLocalMedia(msgId, 'audio'));
        patchMessage?.(msgId, {
          remotePath: audioResult.path,
          localUri: sandboxUri || localUri || tempUri,
        });

        // ⚠️ 与迁移前 JS 严格一致：旧实现直接把 targetId 透传下去。
        //    静态类型上 targetId 可能为 null/undefined，但此分支只有在
        //    stopAndSendRecord 真正执行到发送阶段才会到达（此时 targetId 已存在），
        //    这里用非空断言保持零运行时改动，不新增守卫分支。
        sendPushNotification(targetId!, '', '[语音消息]', {
          type: 'chat',
          targetId: user!.id,
        });
      }, 150);
    } catch (e) {
      console.error('停止录音异常:', e);
    }
  }, [recorder, user, targetId, saveAndSend, patchMessage, clearDurationTimer]);

  const cancelRecord = useCallback(() => {
    try {
      recorder.stop();
    } catch (_) {}
    recordStartTimeRef.current = 0;
    setIsRecording(false);
    setRecordingDuration(0);
    clearDurationTimer();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, [recorder, clearDurationTimer]);

  return {
    isRecording,
    recordingDuration,
    startRecord,
    stopAndSendRecord,
    cancelRecord,
    audioRecorder: recorder,
  };
}

export default useAudioRecorder;
// --- END OF FILE src/hooks/chat/useAudioRecorder.ts ---
