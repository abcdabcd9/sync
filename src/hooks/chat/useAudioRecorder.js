// --- START OF FILE src/hooks/chat/useAudioRecorder.js ---
import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform, Alert } from 'react-native';
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

/**
 * 🎙️ 录音域 Hook（任务 7 阶段 3）
 *
 * 职责（仅麦克风录音与音频模式，不含图片 / 视频）：
 *   1. 麦克风权限申请（requestRecordingPermissionsAsync）
 *   2. 全局音频模式初始化 / 清理（setAudioModeAsync）
 *   3. 开始 / 停止 / 取消录音（prepareToRecordAsync / record / stop）
 *   4. 录音时长计时（recordingDuration，秒）
 *   5. 语音文件上传云端 + 落库 + 推送通知
 *
 * ⚠️ 音频类型崩溃修复（任务 7 阶段 3 关键）：
 *   旧代码传入 `interruptionModeIOS: 0` / `interruptionModeAndroid: 0`（Number），
 *   在 expo-audio SDK 58 中这两个字段已被移除，且 `interruptionMode` 是
 *   **字符串枚举** `'mixWithOthers' | 'doNotMix' | 'doNotMixPersistent' | 'duckOthers'`。
 *   传入 Number 会在原生层 Record 解析时抛异常 → 红屏崩溃。
 *   同时 `staysActiveInBackground` 已改名为 `shouldPlayInBackground`。
 *
 * 📌 语音播放（useAudioPlayer / handleToggleAudio）不在本 Hook 范围内，
 *    仍保留在 ChatRoomInner.js 中，避免破坏播放与影院混音逻辑。
 */

/** 录音参数：高音质 + 开启电平计量（供 ChatInputBar 波形使用） */
export const AUDIO_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

/**
 * SDK 58 标准音频模式（全部为 String 枚举，绝不传 Number）
 * @param {boolean} allowsRecording 是否允许录音
 */
export const buildAudioMode = (allowsRecording) => ({
  allowsRecording,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'mixWithOthers',
  shouldRouteThroughEarpiece: false,
});

/**
 * @param {object} params
 * @param {string} params.targetId 聊天对象 ID
 * @param {object} params.user 当前登录用户
 * @param {Function} params.saveAndSend useChatMessages 暴露的乐观发送
 * @param {Function} [params.patchMessage] useChatMessages 暴露的乐观消息回填
 */
export function useAudioRecorder({ targetId, user, saveAndSend, patchMessage }) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const recordStartTimeRef = useRef(0);
  const durationTimerRef = useRef(null);
  const recorder = useExpoAudioRecorder(AUDIO_OPTIONS);

  /** 清理时长定时器 */
  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  /** 启动时长计时（每 200ms 刷新一次秒数） */
  const startDurationTimer = useCallback(() => {
    clearDurationTimer();
    setRecordingDuration(0);
    durationTimerRef.current = setInterval(() => {
      if (!recordStartTimeRef.current) return;
      setRecordingDuration(Math.floor((Date.now() - recordStartTimeRef.current) / 1000));
    }, 200);
  }, [clearDurationTimer]);

  // 🎙️ 音频模式初始化（进入聊天室时申请权限 + 开启录音能力）
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

  // 卸载时清理计时器
  useEffect(() => () => clearDurationTimer(), [clearDurationTimer]);

  /** 🎬 开始录音 */
  const startRecord = useCallback(async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      recordStartTimeRef.current = 0;

      // iOS 需要在录音前显式把 session 切到 playAndRecord
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

  /** ⏹️ 停止录音并发送 */
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

      // 过短（< 1 秒）或无文件：视为误触，丢弃
      if (durationSec < 1 || !tempUri) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      setTimeout(async () => {
        const msgId = Crypto.randomUUID();
        saveAndSend({
          id: msgId,
          type: 'audio',
          mediaUrl: tempUri,
          duration: durationSec,
          isMe: true,
          timestamp: Date.now(),
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // 🔒 P0-2 / P0-3：uploadToSupabase 返回 { path, signedUrl }。
        //    数据库只存相对对象路径（永久有效），签名 URL 仅供即时播放，
        //    渲染时由 useSignedMediaUrl 按需重新签名，因此历史语音永不失效。
        const audioResult = await uploadToSupabase(tempUri, 'audio', user.id);
        if (!audioResult?.path) {
          // 上传失败：乐观消息里的本地 URI 无法签名 → 点不动、退出重进就消失。
          // 明确告知用户，而不是静默留一条「幽灵消息」。
          console.warn('语音上传失败，消息未落库');
          Alert.alert('语音发送失败', '语音上传未完成，请检查网络后重试。');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
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
          console.warn('语音消息落库失败:', insertError.message);
          return;
        }

        // 回填乐观消息：本地 file:// → 真实对象路径，保证本次会话内即可播放
        patchMessage?.(msgId, { mediaUrl: audioResult.path });

        // 🔑 标题与发送者昵称全部交由云函数权威解析，前端只传干净的 body 内容
        sendPushNotification(targetId, '', '[语音消息]', {
          type: 'chat',
          targetId: user.id,
        });
      }, 150);
    } catch (e) {
      console.error('停止录音异常:', e);
    }
  }, [recorder, user, targetId, saveAndSend, patchMessage, clearDurationTimer]);

  /** ❌ 取消录音（丢弃，不发送） */
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
