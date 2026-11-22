// --- START OF FILE src/hooks/useCinema.js ---
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Platform, AppState } from 'react-native';
import { useVideoPlayer } from 'expo-video';
import { setAudioModeAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useSyncRoom } from './useSyncRoom';
import { useOwnerKey } from './useOwnerKey';
import { supabase } from '../services/supabase';

const CinemaContext = createContext();

// 🍎 iOS 防盗链修复：m3u8 在 WebView 里能播（带 Referer / Cookie），
//    但 expo-video 的原生播放器（iOS AVPlayer）直接请求时不带 Referer，
//    被 CDN 以 HTTP 403 Forbidden 拒绝（CoreMediaErrorDomain -12660）。
//    这里把播放源包装成 VideoSourceObject，附带 Referer（剧集播放页）与移动 UA，
//    让原生播放器请求带上与 WebView 一致的头部，绕过防盗链。
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 说明：expo-video 的 VideoSourceObject.headers 会把头部随「视频请求」一起发送
//      （官方文档：Only for Android/iOS — Specifies headers sent with the video request）。
//      这里附加 Referer（剧集播放页）+ 移动 UA + Origin，绕过常见 CDN 的防盗链校验。
//      注：Cookie 需要原生 CookieManager（@react-native-cookies/cookies）才能读取，
//      本项目未安装该原生依赖，故不注入 Cookie，避免引入需重新构建的依赖。
function buildVideoSource(url, referer) {
  if (!url) return null;
  // 仅对 http(s) 媒体源附加头部；本地/空源原样返回
  if (!/^https?:/i.test(url)) return url;
  const headers = { 'User-Agent': MOBILE_UA };
  if (referer && /^https?:/i.test(referer)) {
    headers.Referer = referer;
    // 部分 CDN 校验 Origin，一并带上（取 referer 的 origin）
    try { headers.Origin = new URL(referer).origin; } catch (_e) {}
  }
  return { uri: url, headers };
}

export function CinemaProvider({ children }) {
  const [currentUrl, setCurrentUrl] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  // 📺 选集上下文：由隐藏 WebView 抓取整部剧的选集列表后写入
  //    episodeList: [{ url, label, vodId, sourceId, episodeId }]
  //    episodePageUrl: 当前正在嗅探的剧集播放页（用于判断是否同一部剧）
  const [episodeList, setEpisodeList] = useState([]);
  const [episodePageUrl, setEpisodePageUrl] = useState(null);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(-1);
  // 🔄 切集请求：{ url, index, nonce } —— 由 cinema 页监听并驱动隐藏 WebView 重新嗅探
  const [episodeSwitchRequest, setEpisodeSwitchRequest] = useState(null);
  // 🚀 首次抓取请求：{ url, nonce } —— 投屏后自动抓一次选集列表（不切集，只抓列表）
  const [episodeListRequested, setEpisodeListRequested] = useState(false);
  const [episodeListRequest, setEpisodeListRequest] = useState(null);

  const [cinemaRoomId, setCinemaRoomId] = useState(null);
  // 🆔 R1-D3：useSyncRoom 返回的 ownerKey 是「数据所属身份」（dataOwnerKey），
  //    用于消费端渲染期遮罩；与下方 useOwnerKey() 的「当前渲染身份」是两个不同概念。
  const { partnerStatus, remoteCommand, emitCommand, danmakuList, emitDanmaku, ownerKey: dataOwnerKey } = useSyncRoom(cinemaRoomId);

  // 🆔 C2：身份作用域令牌（当前渲染身份）。切号时清空放映厅全部内存态。
  //    注意：清理 effect 必须用「当前身份」检测切换，不能用 dataOwnerKey（它滞后一帧）。
  const { ownerKey } = useOwnerKey();

  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.muted = false;
    p.staysActiveInBackground = true;
    p.preservesPitch = true;
    // 🎚️ 放宽 seek 精度：默认 tolerance 为 0（精确 seek），每次拖动都要让解码器
    //    重新对齐到关键帧，即使数据已在本地缓存也可能停顿几十到几百毫秒。
    //    设为 ±0.5s 后，播放器可以就近跳到关键帧，拖动明显更快；
    //    代价是落点有 ±0.5s 误差 —— 追剧场景完全可接受。
    //    注意：这是「加速 seek」的唯一有效杠杆，缓存条本身不改变 seek 速度。
    p.seekTolerance = { toleranceBefore: 0.5, toleranceAfter: 0.5 };
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
      } catch (_e) {}
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
  // 🎚️ 用户正在拖动进度条 / 屏幕横向快进中。
  //    拖动期间 currentTime 会被人为跳变，若轮询照常计算漂移，会把「用户主动 seek」
  //    误判成「播放漂移」并广播 AUTO_SYNC，导致对方画面乱跳。
  //    这里用 ref 让轮询循环即时读取（不触发重渲染），并在拖动期间跳过漂移判定。
  const isScrubbingRef = useRef(false);
  // 供 cinema 页调用的开关（稳定引用，避免每次渲染新建函数）
  const setScrubbing = useCallback((v) => { isScrubbingRef.current = !!v; }, []);
  // 🍎 记录当前剧集播放页，供 remoteCommand 重载时作为 Referer
  const episodePageUrlRef = useRef(null);
  const SYNC_THRESHOLD = 2.5;

  useEffect(() => { currentUrlRef.current = currentUrl; }, [currentUrl]);
  useEffect(() => { episodePageUrlRef.current = episodePageUrl; }, [episodePageUrl]);

  // 🐞 修复「安卓：重新进入影院时进度条清空 / 从 0 重播」：
  //    旧实现只要 partnerStatus 变成「已加入」就无条件广播 PLAY(currentTime)。
  //    影院页重新挂载 → 房间号若发生变化会重建 Channel → presence 重新 sync →
  //    partnerStatus 从「等待」变「已加入」→ 这里广播一次 PLAY。
  //    若此时 player.currentTime 尚未就绪（原生侧刚 attach 新 VideoView，读回 0），
  //    就会把 0 广播出去；对端/本端消费后 seek 到 0 → 表现为「进度条清空、从头播放」。
  //    这里加两道保护：
  //      ① 只在「确实有有效播放位置」时才广播（currentTime > 0 或 duration 未知）；
  //      ② 用 ref 记录已广播过的房间状态，同一状态不重复广播。
  const lastPartnerBroadcastRef = useRef(null);
  useEffect(() => {
    if (!partnerStatus.includes('已加入') || !currentUrlRef.current || !player) return;
    if (lastPartnerBroadcastRef.current === partnerStatus) return;
    lastPartnerBroadcastRef.current = partnerStatus;
    const t = player.currentTime;
    // 位置无效（NaN / 负数）时不广播，避免把 0 当成「从头开始」的指令发出去
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return;
    emitCommand(player.playing ? 'PLAY' : 'PAUSE', t, currentUrlRef.current);
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

      // 🎚️ 用户正在拖动进度条 / 屏幕横向快进：
      //    此时 currentTime 是人为主观跳变，不是播放漂移。
      //    只刷新基准值（避免松手瞬间被误判为巨大漂移），绝不广播 AUTO_SYNC。
      if (isScrubbingRef.current) {
        lastVideoTime.current = currentVideoTime;
        lastPlayingState.current = currentPlaying;
        return;
      }

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

  // 🐞 修复「最小化后点悬浮窗/影院卡回到影院，视频从 0 秒重播」：
  //    remoteCommand 由 useSyncRoom 持有（CinemaProvider 内），影院页卸载后仍残留。
  //    影院页重新挂载时本 effect 会以「同一条旧指令」再次执行，若其 url 与当前
  //    播放源不一致就会 replaceAsync → 从 0:00 重播。
  //    这里用「指令对象引用」去重：同一条指令只处理一次，重新挂载后不会重放。
  const handledRemoteCommandRef = useRef(null);

  useEffect(() => {
    if (!remoteCommand) return;
    // 同一条指令只消费一次（防止影院页重新挂载 / 重渲染时重复执行）
    if (handledRemoteCommandRef.current === remoteCommand) return;
    handledRemoteCommandRef.current = remoteCommand;
    isHandlingRemote.current = true;
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    
    const { type, time, url } = remoteCommand;
    const now = Date.now();

    // 🛡️ 防误重载：指令携带的 url 与「当前播放源」一致时，说明只是同步信令，
    //    绝不能 replaceAsync（否则视频从头开始）。此处先于 loadedUri 判断，
    //    避免播放器尚未就绪（loadedUri 为 null）时误走重载分支。
    if (url && url === currentUrlRef.current) {
      if (!player) return;
      const safeTime = isNaN(time) ? 0 : time;
      if (type === 'PLAY') {
        if (!player.playing) { player.play(); setIsPlaying(true); }
      } else if (type === 'PAUSE') {
        if (player.playing) { player.pause(); setIsPlaying(false); }
      }
      if (Math.abs(player.currentTime - safeTime) > SYNC_THRESHOLD) {
        player.currentTime = safeTime;
        lastVideoTime.current = safeTime;
        seekLockTimer.current = now;
      }
      silenceTimer.current = setTimeout(() => { isHandlingRemote.current = false; }, 1200);
      return;
    }

    if (url && url !== currentUrlRef.current) {
      // 🛡️ 防误重载：若播放器当前已加载的正是该源（例如影院页重新挂载后
      //    收到自己/对方携带同一 URL 的指令），只做时间同步，绝不 replaceAsync，
      //    否则视频会从头开始播放。
      const loadedUri = player?.currentSource?.uri ?? null;
      if (loadedUri && loadedUri === url) {
        currentUrlRef.current = url;
        setCurrentUrl(url);
        if (!player) return;
        const safeTime = isNaN(time) ? 0 : time;
        if (type === 'PLAY') {
          if (!player.playing) { player.play(); setIsPlaying(true); }
        } else if (type === 'PAUSE') {
          if (player.playing) { player.pause(); setIsPlaying(false); }
        }
        if (Math.abs(player.currentTime - safeTime) > SYNC_THRESHOLD) {
          player.currentTime = safeTime;
          lastVideoTime.current = safeTime;
          seekLockTimer.current = now;
        }
        silenceTimer.current = setTimeout(() => { isHandlingRemote.current = false; }, 1200);
        return;
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCurrentUrl(url);
      // 🍎 附带 Referer / UA，绕过 iOS 原生播放器的防盗链 403
      if (player) player.replaceAsync(buildVideoSource(url, episodePageUrlRef.current));
      
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

  // 📺 loadUrl(url, pageUrl?)
  //    pageUrl：该 m3u8 对应的「剧集播放页」URL（如 /play/392563-36-700596.html）
  //    传入后影院可据此启动隐藏 WebView 抓取整部剧的选集列表
  const loadUrl = useCallback((url, pageUrl = null) => {
    // 🐞 修复「安卓：最小化后点悬浮窗 / 点放映厅卡回到影院，进度条清空并从 0 重播」：
    //    影院页重新挂载时若再次走到 loadUrl（例如从浏览器/放映厅卡重新投屏同一片源），
    //    旧实现无条件 replaceAsync → 原生 ExoPlayer 重建 MediaItem → 位置归零。
    //    这里加一道「同源短路」：目标 URL 与当前播放源一致、且播放器已加载该源时，
    //    只做状态同步（取消最小化 + 恢复播放），绝不 replaceAsync。
    const loadedUri = player?.currentSource?.uri ?? null;
    const isSameSource = !!url && url === currentUrlRef.current && (!loadedUri || loadedUri === url);
    if (isSameSource) {
      if (pageUrl) setEpisodePageUrl(pageUrl);
      setIsMinimized(false);
      if (player && !player.playing) { player.play(); setIsPlaying(true); }
      return;
    }
    setCurrentUrl(url);
    if (pageUrl) {
      setEpisodePageUrl(pageUrl);
      // 换剧/换集 → 清空旧选集列表，等待隐藏 WebView 重新抓取
      setEpisodeList([]);
      setCurrentEpisodeIndex(-1);
      // 🚀 首次抓取：投屏时自动抓一次选集列表（不切集，只抓列表）
      //    由 cinema 页监听 episodeListRequest 并挂载隐藏 WebView
      setEpisodeListRequested(true);
      setEpisodeListRequest({ url: pageUrl, nonce: Date.now() });
    }
    // 🍎 附带 Referer / UA，绕过 iOS 原生播放器的防盗链 403
    //    referer 优先用本次传入的 pageUrl，其次用当前剧集页
    const source = buildVideoSource(url, pageUrl || episodePageUrlRef.current);
    if (Platform.OS === 'ios') {
      if(player) player.pause();
      setTimeout(() => {
        if(player) player.replaceAsync(source);
        setIsMinimized(false);
        setTimeout(() => { if(player) { player.play(); setIsPlaying(true); } }, 1000);
      }, 50);
    } else {
      if(player) player.replaceAsync(source);
      setIsMinimized(false);
      setTimeout(() => { if(player) { player.play(); setIsPlaying(true); } }, 800);
    }
  }, [player]);

  const closePlayer = useCallback(async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if(player) { player.pause(); player.replaceAsync(null); }
    setCurrentUrl(null); setIsMinimized(false); setIsPlaying(false);
    // 🐞 修复「关闭影院后重新进入，约 10 秒后自动嗅探并播放上一次的视频」：
    //    loadUrl(url, pageUrl) 会写入 episodeListRequest / episodeSwitchRequest，
    //    这两个请求是「一次性」的，但此前只在 applyEpisodeList 成功时才清空。
    //    若用户在隐藏 WebView 抓取完成前就关闭影院（或抓取失败），请求会残留在
    //    CinemaProvider（全局 Context，不随影院页卸载而销毁）里。
    //    下次进入影院时 cinema.js 的监听 effect 读到旧请求 → 重新挂载隐藏 WebView
    //    → 15 秒兜底手动嗅探命中旧 m3u8 → 自动播放上次的视频。
    //    这里在关闭播放器时一并清空所有选集/嗅探请求，彻底切断残留链路。
    setEpisodeList([]);
    setEpisodePageUrl(null);
    setCurrentEpisodeIndex(-1);
    setEpisodeSwitchRequest(null);
    setEpisodeListRequested(false);
    setEpisodeListRequest(null);
    if (cinemaRoomId) {
      // 🍎 P2-16 / FIX-B 修复：邀请卡片的 type 固定为 'cinema_invite'（见 invite_friend.js），
      //    text 字段写入的是放映厅 roomId。
      //
      //    ⚠️ 关键：客户端（authenticated）**没有** messages.subtype 的 UPDATE 权限
      //    （迁移 21 的列级授权 + 迁移 28 的触发器共同限制），直接 UPDATE subtype
      //    会报 `permission denied for table messages`。
      //    因此改为调用受控的 SECURITY DEFINER RPC `end_cinema_invite(uuid)`：
      //      · RPC 内校验「调用者=发送方 + type=cinema_invite + 起点 subtype 合法」；
      //      · 只改 subtype 一列，幂等，返回受影响行数。
      //
      //    🔒 L4 第五批修正 1：**禁止**「最近一条邀请卡片」兜底。
      //       旧兜底会误结束其它放映厅的邀请（用户可能同时有多个未结束的邀请卡片），
      //       属于越权副作用。
      //
      //    🔒 L4 第六批第 2 项：同一 roomId 可能对应**多张**邀请卡片 ——
      //       invite_friend.js 每次点击「邀请」都生成新的 msgId 并插入新消息，
      //       而 text 始终是同一个 roomId。因此必须结束该 roomId 下**全部**
      //       合法邀请卡片，不能只更新 limit(1) 的任意一张。
      //
      //    改为调用批量 RPC `end_cinema_invites_by_room(p_room_id)`：
      //      · RPC 内限定 user_id = auth.uid() + type='cinema_invite' + text=roomId
      //      · 只处理 subtype ∈ (NULL, 'SYNC_CINEMA_INVITE') 的行
      //      · 只改 subtype 一列，幂等，返回受影响行数
      //      · 接收方/无关账号调用影响 0 行（无越权）
      //    全程 try/catch，任何异常都不向外抛出，避免未捕获异常导致后续状态更新中断。
      try {
        const { error: rpcErr } = await supabase.rpc('end_cinema_invites_by_room', {
          p_room_id: cinemaRoomId,
        });
        if (rpcErr) throw rpcErr;
      } catch (e) {
        // 静默降级：关闭房间的本地状态清理不应因数据库匹配失败而中断
        console.warn('⚠️ closePlayer 更新邀请卡片状态失败（已忽略）:', e?.message ?? e);
      }
    }
    setCinemaRoomId(null);
  }, [player, cinemaRoomId]);

  // 🆔 C2-①：身份切换清理 —— ownerKey 变化（切号 / 同账号重新登录）时，
  //    立即关闭播放器并清空放映厅全部内存态，避免 B 看到 A 的片源/弹幕/房间。
  //    注意：closePlayer 内部会调用 end_cinema_invites_by_room RPC，
  //    切号瞬间旧会话可能已失效，因此这里只做本地状态清理，不依赖 RPC 成功。
  const prevOwnerKeyRef = useRef(ownerKey);
  useEffect(() => {
    if (prevOwnerKeyRef.current === ownerKey) return;
    prevOwnerKeyRef.current = ownerKey;
    // 本地强制清理（不等待 RPC）
    try {
      if (player) { player.pause(); player.replaceAsync(null); }
    } catch (_e) {}
    setCurrentUrl(null);
    setIsMinimized(false);
    setIsPlaying(false);
    setEpisodeList([]);
    setEpisodePageUrl(null);
    setCurrentEpisodeIndex(-1);
    setEpisodeSwitchRequest(null);
    setEpisodeListRequested(false);
    setEpisodeListRequest(null);
    setCinemaRoomId(null);
    // 重置同步基准，避免新账号首帧误判漂移
    lastVideoTime.current = null;
    lastPlayingState.current = false;
    lastPartnerBroadcastRef.current = null;
    handledRemoteCommandRef.current = null;
  }, [ownerKey, player]);

  const togglePlay = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!player) return;
    if (player.playing) { player.pause(); setIsPlaying(false); } else { player.play(); setIsPlaying(true); }
  }, [player]);

  // 📺 写入选集列表（隐藏 WebView 抓取完成后调用）
  const applyEpisodeList = useCallback((list, pageUrl) => {
    // 🐞 无论列表是否为空，都必须清空「一次性」抓取请求：
    //    空列表（容器未渲染 / 抓取失败）时若不清空，episodeListRequest 会一直残留，
    //    影院页每次重新挂载都会重新挂载隐藏 WebView → 兜底嗅探 → 误播旧视频。
    setEpisodeListRequested(false);
    setEpisodeListRequest(null);
    if (!Array.isArray(list) || list.length === 0) return;
    setEpisodeList(list);
    if (pageUrl) setEpisodePageUrl(pageUrl);
    // 根据当前播放页定位当前集索引
    const idx = pageUrl ? list.findIndex((ep) => ep.url === pageUrl) : -1;
    setCurrentEpisodeIndex(idx);
  }, []);

  // 📺 请求切换到指定集：驱动隐藏 WebView 重新嗅探该集播放页
  const requestEpisode = useCallback((index) => {
    if (index < 0 || index >= episodeList.length) return;
    const ep = episodeList[index];
    if (!ep) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentEpisodeIndex(index);
    setEpisodeSwitchRequest({ url: ep.url, index, nonce: Date.now() });
  }, [episodeList]);

  // 📺 上一集 / 下一集
  const playPrevEpisode = useCallback(() => {
    if (currentEpisodeIndex > 0) requestEpisode(currentEpisodeIndex - 1);
  }, [currentEpisodeIndex, requestEpisode]);

  const playNextEpisode = useCallback(() => {
    if (currentEpisodeIndex >= 0 && currentEpisodeIndex < episodeList.length - 1) {
      requestEpisode(currentEpisodeIndex + 1);
    }
  }, [currentEpisodeIndex, episodeList.length, requestEpisode]);

  // 📺 清空选集上下文（关闭播放器时）
  const clearEpisodes = useCallback(() => {
    setEpisodeList([]);
    setEpisodePageUrl(null);
    setCurrentEpisodeIndex(-1);
    setEpisodeSwitchRequest(null);
  }, []);

  const value = {
    player, currentUrl, isMinimized, setIsMinimized, partnerStatus, emitCommand,
    loadUrl, closePlayer, isPlaying, togglePlay, cinemaRoomId, setCinemaRoomId,
    danmakuList, emitDanmaku,
    // 🆔 C2-④ / R1-D3：暴露「数据所属身份」dataOwnerKey，供放映厅在
    //    dataOwnerKey !== 当前身份 时渲染遮罩而非播放器（切号首帧即生效）。
    ownerKey: dataOwnerKey,
    // 🎚️ 拖动进度条开关：拖动期间屏蔽漂移检测，避免误发 AUTO_SYNC
    setScrubbing,
    // 📺 选集相关
    episodeList, episodePageUrl, currentEpisodeIndex, episodeSwitchRequest,
    episodeListRequested, episodeListRequest,
    applyEpisodeList, requestEpisode, playPrevEpisode, playNextEpisode, clearEpisodes,
  };
  return <CinemaContext.Provider value={value}>{children}</CinemaContext.Provider>;
}
export function useCinema() { return useContext(CinemaContext); }
// --- END OF FILE src/hooks/useCinema.js ---