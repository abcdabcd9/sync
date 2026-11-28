// --- START OF FILE src/hooks/browser/useWatchProgressRecorder.js ---
import { useEffect, useRef } from 'react';

import {
  WATCH_SAVE_THROTTLE_MS,
  WATCH_MIN_PROGRESS_SECONDS,
  isNearEnd,
  secondsToMillis,
} from './watchHistoryLogic';

/**
 * 🎬 播放器观看进度采集器（V1）
 *
 * 职责：把「播放器状态」按节流策略收敛成观看记录，交给 saveWatchRecord 落盘。
 * 不负责：UI、续播、存储 key 管理（分别由 cinema.js / useWatchHistory 负责）。
 *
 * 采集时机（与需求一致）：
 *   1. 播放中：每 WATCH_SAVE_THROTTLE_MS（6s）最多写一次；
 *   2. 暂停：立即写一次（用户主动暂停通常意味着「就停在这」）；
 *   3. 播放结束（playToEnd）：写 completed 状态；
 *   4. 播放源切换 / 组件卸载：尽力写一次（flush）。
 *
 * 不采集：
 *   - 未真正进入播放（position 与 duration 均无效）；
 *   - 进度 < WATCH_MIN_PROGRESS_SECONDS（避免 0:01 也产生记录）；
 *   - 广告 / 嗅探探测结果（调用方只在「确认播放」后才启用本 Hook）。
 *
 * ⚠️ 所有写入都经过 saveWatchRecord 的 owner + authEpoch 校验，
 *    账号切换后的迟到写入会被静默丢弃。
 *
 * @param {object} opts
 * @param {object|null} opts.player expo-video 播放器实例
 * @param {boolean} opts.enabled 是否启用采集（有播放源 + 已确认播放）
 * @param {() => object|null} opts.getMeta 返回当前媒体元信息
 *        { mediaUrl, pageUrl, title, episodeLabel }
 * @param {(input: object) => boolean} opts.saveWatchRecord 来自 useWatchHistory
 */
export function useWatchProgressRecorder({ player, enabled, getMeta, saveWatchRecord }) {
  // 🧠 最近一次已落盘的「进度秒数」，用于节流判定与去重
  const lastSavedSecRef = useRef(-1);
  // 🧠 最近一次落盘时间戳
  const lastSavedAtRef = useRef(0);
  // 🧠 最近一次落盘时的媒体身份（换源后必须重置节流基准）
  const lastMediaUrlRef = useRef('');
  // 🧠 上一次观察到的 playing 状态（用于检测「播放 → 暂停」跳变）
  const lastPlayingRef = useRef(false);
  // 🧠 组件是否已卸载（避免卸载后仍写盘）
  const unmountedRef = useRef(false);

  // 回调与元信息用 ref 承载，避免 effect 因闭包变化频繁重建
  const getMetaRef = useRef(getMeta);
  useEffect(() => {
    getMetaRef.current = getMeta;
  }, [getMeta]);
  const saveRef = useRef(saveWatchRecord);
  useEffect(() => {
    saveRef.current = saveWatchRecord;
  }, [saveWatchRecord]);

  // 🧹 卸载标记 + 卸载时尽力 flush 一次
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      // 卸载时同步读取播放器位置并落盘（尽力而为，失败静默）
      try {
        if (!player) return;
        const pos = Number(player.currentTime);
        const dur = Number(player.duration);
        if (!Number.isFinite(pos) || pos < WATCH_MIN_PROGRESS_SECONDS) return;
        const meta = getMetaRef.current?.();
        if (!meta) return;
        saveRef.current?.({
          ...meta,
          positionMillis: secondsToMillis(pos),
          durationMillis: Number.isFinite(dur) ? secondsToMillis(dur) : 0,
          completed: isNearEnd(pos, dur),
          lastWatchedAt: Date.now(),
        });
      } catch (_e) {}
    };
  }, [player]);

  // 🔁 主采集循环：500ms 采样，按节流策略决定是否落盘
  useEffect(() => {
    if (!enabled || !player) return undefined;

    const tick = () => {
      if (unmountedRef.current) return;
      let pos = 0;
      let dur = 0;
      let playing = false;
      try {
        pos = Number(player.currentTime);
        dur = Number(player.duration);
        playing = !!player.playing;
      } catch (_e) {
        return;
      }
      if (!Number.isFinite(pos) || pos < 0) return;

      const meta = getMetaRef.current?.();
      if (!meta) return;

      // 🔄 换源检测：媒体 URL 变化 → 重置节流基准，保证新视频立刻能写
      const mediaUrl = meta.mediaUrl || '';
      if (mediaUrl !== lastMediaUrlRef.current) {
        lastMediaUrlRef.current = mediaUrl;
        lastSavedSecRef.current = -1;
        lastSavedAtRef.current = 0;
      }

      const now = Date.now();
      const posSec = Math.floor(pos);
      const wasPlaying = lastPlayingRef.current;
      lastPlayingRef.current = playing;

      // ① 进度过短：不产生记录（但暂停时仍允许写，避免「刚看 3 秒就退出」丢记录）
      const tooShort = posSec < WATCH_MIN_PROGRESS_SECONDS;

      // ② 暂停跳变：立即写一次
      const justPaused = wasPlaying && !playing;

      // ③ 节流窗口
      const throttled = now - lastSavedAtRef.current < WATCH_SAVE_THROTTLE_MS;

      // ④ 进度无变化（同一秒内重复采样）：跳过
      const sameSecond = posSec === lastSavedSecRef.current;

      const shouldWrite = justPaused || (!throttled && !sameSecond);
      if (!shouldWrite) return;
      if (tooShort && !justPaused) return;

      lastSavedSecRef.current = posSec;
      lastSavedAtRef.current = now;

      saveRef.current?.({
        ...meta,
        positionMillis: secondsToMillis(pos),
        durationMillis: Number.isFinite(dur) && dur > 0 ? secondsToMillis(dur) : 0,
        completed: isNearEnd(pos, dur),
        lastWatchedAt: now,
      });
    };

    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [enabled, player]);

  /**
   * 📺 播放结束时调用（由 cinema.js 的 playToEnd 监听触发）。
   * 写入 completed=true，使下次点击历史从头播放。
   */
  const markCompleted = () => {
    if (unmountedRef.current) return;
    const meta = getMetaRef.current?.();
    if (!meta) return;
    let pos = 0;
    let dur = 0;
    try {
      pos = Number(player?.currentTime) || 0;
      dur = Number(player?.duration) || 0;
    } catch (_e) {}
    lastSavedSecRef.current = Math.floor(pos);
    lastSavedAtRef.current = Date.now();
    saveRef.current?.({
      ...meta,
      positionMillis: secondsToMillis(pos),
      durationMillis: Number.isFinite(dur) && dur > 0 ? secondsToMillis(dur) : 0,
      completed: true,
      lastWatchedAt: Date.now(),
    });
  };

  /**
   * 💾 立即落盘一次（供「切集 / 退出影院」等场景主动调用）。
   */
  const flush = () => {
    if (unmountedRef.current) return;
    const meta = getMetaRef.current?.();
    if (!meta) return;
    let pos = 0;
    let dur = 0;
    try {
      pos = Number(player?.currentTime) || 0;
      dur = Number(player?.duration) || 0;
    } catch (_e) {}
    if (!Number.isFinite(pos) || pos < WATCH_MIN_PROGRESS_SECONDS) return;
    lastSavedSecRef.current = Math.floor(pos);
    lastSavedAtRef.current = Date.now();
    saveRef.current?.({
      ...meta,
      positionMillis: secondsToMillis(pos),
      durationMillis: Number.isFinite(dur) && dur > 0 ? secondsToMillis(dur) : 0,
      completed: isNearEnd(pos, dur),
      lastWatchedAt: Date.now(),
    });
  };

  return { markCompleted, flush };
}

export default useWatchProgressRecorder;
// --- END OF FILE src/hooks/browser/useWatchProgressRecorder.js ---
