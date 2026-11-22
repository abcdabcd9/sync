// --- START OF FILE src/hooks/chat/useAudioRecorder.js ---
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

export const AUDIO_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

export const buildAudioMode = (allowsRecording) => ({
  allowsRecording,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'mixWithOthers',
  shouldRouteThroughEarpiece: false,
});

export function useAudioRecorder({ targetId, user, saveAndSend, patchMessage }) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const recordStartTimeRef = useRef(0);
  const durationTimerRef = useRef(null);
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

        const audioResult = await uploadToSupabase(tempUri, 'audio', user.id);
        if (!audioResult?.path) {
          // 🚨 离线/上传失败：不弹窗、不删气泡，仅静默挂红感叹号
          console.warn('离线/语音上传失败，已标记为待重发');
          patchMessage?.(msgId, { status: 'failed' });
          return;
        }

        const { error: insertError } = await supabase.from('messages').insert({
          id: msgId,
          user_id: user.id,
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

        sendPushNotification(targetId, '', '[语音消息]', {
          type: 'chat',
          targetId: user.id,
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
// --- END OF FILE src/hooks/chat/useAudioRecorder.js ---