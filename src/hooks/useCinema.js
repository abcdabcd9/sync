// --- START OF FILE src/hooks/useCinema.js ---
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Platform, AppState } from 'react-native';
import { useVideoPlayer } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useSyncRoom } from './useSyncRoom';
import { supabase } from '../services/supabase';

const CinemaContext = createContext();

export function CinemaProvider({ children }) {
  const [currentUrl, setCurrentUrl] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false); 
  const [isPlaying, setIsPlaying] = useState(false);

  const [cinemaRoomId, setCinemaRoomId] = useState(null);
  const { partnerStatus, remoteCommand, emitCommand, danmakuList, emitDanmaku } = useSyncRoom(cinemaRoomId);

  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.muted = false;
    p.staysActiveInBackground = true; 
    p.preservesPitch = true; 
  });

  useEffect(() => {
    const setupAudioMixing = async () => {
      try {
        if (typeof setAudioModeAsync === 'function') {
          // 🍎 全局底层约束：SDK 58 要求 interruptionMode 为字符串枚举（传 Number 会红屏崩溃）
          // 'mixWithOthers' = 一切音频完全共存（电影 / 语音 / 微信通话互不打断）
          await setAudioModeAsync({
            playsInSilentMode: true,
            shouldPlayInBackground: true,
            interruptionMode: 'mixWithOthers',
            shouldRouteThroughEarpiece: false,
            allowsRecording: true,
          });
        }
      } catch (e) {}
    };
    setupAudioMixing();
  }, []);

  const isHandlingRemote = useRef(false);
  const silenceTimer = useRef(null);
  const lastPlayingState = useRef(false);
  const lastVideoTime = useRef(null);
  const lastForceSyncTime = useRef(0);
  const seekLockTimer = useRef(0); 
  const currentUrlRef = useRef(null);
  const SYNC_THRESHOLD = 2.5; 

  useEffect(() => { currentUrlRef.current = currentUrl; }, [currentUrl]);

  useEffect(() => {
    if (partnerStatus.includes('已加入') && currentUrlRef.current && player) {
      emitCommand(player.playing ? 'PLAY' : 'PAUSE', player.currentTime, currentUrlRef.current);
    }
  }, [partnerStatus]);

  // 🔋 500ms 进度漂移检测轮询
  //    仅在 App 处于前台（active）时运行；切后台/切屏立即暂停，回前台自动恢复。
  //    定时器句柄放在 ref 中，便于 AppState 回调与卸载清理统一管理。
  const pollTimerRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    // 幂等：已在运行则不重复创建，避免定时器叠加
    if (pollTimerRef.current) return;
    if (!player || !currentUrl) return;

    pollTimerRef.current = setInterval(() => {
      if (!player) return;
      const currentVideoTime = player.currentTime;
      const currentPlaying = player.playing;

      if (isHandlingRemote.current) {
        lastVideoTime.current = currentVideoTime;
        lastPlayingState.current = currentPlaying;
        return;
      }

      if (currentPlaying !== lastPlayingState.current) {
        lastPlayingState.current = currentPlaying;
        setIsPlaying(currentPlaying);
        emitCommand(currentPlaying ? 'PLAY' : 'PAUSE', currentVideoTime, currentUrl);
      }

      if (lastVideoTime.current !== null) {
        const videoDelta = currentVideoTime - lastVideoTime.current;
        const expectedDelta = currentPlaying ? 0.5 : 0;
        if (Math.abs(videoDelta - expectedDelta) > SYNC_THRESHOLD) {
          const now = Date.now();
          if (now - lastForceSyncTime.current > 2000) {
            emitCommand('AUTO_SYNC', currentVideoTime, currentUrl);
            lastForceSyncTime.current = now;
          }
        }
      }
      lastVideoTime.current = currentVideoTime;
    }, 500);
  }, [player, currentUrl, emitCommand]);

  // 1️⃣ 播放源/播放器变化时，按当前前后台状态决定是否启动轮询
  useEffect(() => {
    if (!currentUrl || !player) {
      stopPolling();
      return;
    }
    if (AppState.currentState === 'active') startPolling();
    else stopPolling();
    return () => stopPolling();
  }, [player, currentUrl, startPolling, stopPolling]);

  // 2️⃣ 监听前后台切换：后台暂停轮询，前台恢复
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        startPolling();
      } else {
        // 'background' | 'inactive'（iOS 切屏/来电/下拉通知中心）一律暂停
        stopPolling();
      }
    });
    return () => {
      subscription?.remove();
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  useEffect(() => {
    if (!remoteCommand) return;
    isHandlingRemote.current = true;
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    
    const { type, time, url } = remoteCommand;
    const now = Date.now();

    if (url && url !== currentUrlRef.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCurrentUrl(url); 
      if (player) player.replaceAsync(url);
      
      setTimeout(() => {
        if (player) {
          const safeTime = isNaN(time) ? 0 : time;
          player.currentTime = safeTime;
          if (type === 'PLAY') { player.play(); setIsPlaying(true); }
          lastVideoTime.current = safeTime; 
          isHandlingRemote.current = false; 
          seekLockTimer.current = Date.now(); 
        }
      }, 1000); 
      return; 
    }

    if (!player) return;
    const safeTime = isNaN(time) ? 0 : time;
    const diff = Math.abs(player.currentTime - safeTime);
    const needsSync = diff > SYNC_THRESHOLD;
    const isSeekLocked = (now - seekLockTimer.current) < 3000;

    if (type === 'PLAY') {
      if (!player.playing) { player.play(); setIsPlaying(true); }
      if (needsSync && !isSeekLocked) { player.currentTime = safeTime; lastVideoTime.current = safeTime; seekLockTimer.current = now; }
    } else if (type === 'PAUSE') {
      if (player.playing) { player.pause(); setIsPlaying(false); }
      if (needsSync && !isSeekLocked) { player.currentTime = safeTime; lastVideoTime.current = safeTime; seekLockTimer.current = now; }
    } else if (type === 'FORCE_SYNC') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      player.currentTime = safeTime; lastVideoTime.current = safeTime; seekLockTimer.current = now;
    } else if (type === 'AUTO_SYNC') {
      if (needsSync && !isSeekLocked) { player.currentTime = safeTime; lastVideoTime.current = safeTime; seekLockTimer.current = now; }
    }
    silenceTimer.current = setTimeout(() => { isHandlingRemote.current = false; }, 1200);
  }, [remoteCommand]);

  const loadUrl = useCallback((url) => {
    setCurrentUrl(url);
    if (Platform.OS === 'ios') {
      if(player) player.pause();
      setTimeout(() => {
        if(player) player.replaceAsync(url); 
        setIsMinimized(false);
        setTimeout(() => { if(player) { player.play(); setIsPlaying(true); } }, 1000);
      }, 50);
    } else {
      if(player) player.replaceAsync(url); 
      setIsMinimized(false);
      setTimeout(() => { if(player) { player.play(); setIsPlaying(true); } }, 800);
    }
  }, [player]);

  const closePlayer = useCallback(async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if(player) { player.pause(); player.replaceAsync(null); }
    setCurrentUrl(null); setIsMinimized(false); setIsPlaying(false);
    if (cinemaRoomId) {
      try { await supabase.from('messages').update({ subtype: 'SYNC_CINEMA_ENDED' }).eq('type', 'cinema_invite').eq('text', cinemaRoomId); } catch(e) {}
    }
    setCinemaRoomId(null);
  }, [player, cinemaRoomId]);

  const togglePlay = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!player) return;
    if (player.playing) { player.pause(); setIsPlaying(false); } else { player.play(); setIsPlaying(true); }
  }, [player]);

  const value = { player, currentUrl, isMinimized, setIsMinimized, partnerStatus, emitCommand, loadUrl, closePlayer, isPlaying, togglePlay, cinemaRoomId, setCinemaRoomId, danmakuList, emitDanmaku };
  return <CinemaContext.Provider value={value}>{children}</CinemaContext.Provider>;
}
export function useCinema() { return useContext(CinemaContext); }
// --- END OF FILE src/hooks/useCinema.js ---