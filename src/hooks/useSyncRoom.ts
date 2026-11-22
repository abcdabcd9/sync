// --- START OF FILE src/hooks/useSyncRoom.ts ---
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from '../services/supabase';
import { useOwnerKey } from './useOwnerKey';
import type {
  DanmakuPayload,
  PlaybackCommandType,
  SyncCommandPayload,
  SyncRoomState,
} from '../types/cinema';

/**
 * 🎬 放映室实时同步 Hook
 *
 * 职责：
 *   1. 通过 Supabase Realtime Channel 同步播放控制信令（broadcast: sync_command）
 *   2. 同步实时弹幕（broadcast: danmaku）
 *   3. 通过 presence 感知对方是否在线
 *
 * ⚠️ 最高指令：本文件只修复「设备 ID 持久化」与「弹幕内存保护」，
 *    绝不改动 broadcast / presence 的事件名、payload 结构与订阅流程。
 *
 * ⚠️ P1.4 R5 迁移约束（零行为变更）：
 *   · `emitCommand` / `emitDanmaku` 必须保持**普通函数**（每次渲染新引用），
 *     不得改为 useCallback / useMemo —— useCinema 的 AppState Effect 对回调身份敏感。
 *   · Effect 依赖数组、订阅注册顺序、守卫顺序（先 ownerKey 后 senderId）逐字保持。
 *   · `Date.now()` 采样次数与顺序保持（emitDanmaku 内两次独立调用）。
 */

// 弹幕最大保留条数（防止长时间播放导致数组无限增长 → 内存泄露）
const MAX_DANMAKU_COUNT = 100;

// 设备 ID 持久化 key
const DEVICE_ID_STORAGE_KEY = '@sync_device_id';

/**
 * 读取（或首次生成）持久化的设备 ID
 *
 * - 使用 expo-crypto 的 randomUUID() 生成加密级 UUIDv4（RFC4122）
 * - 首次启动生成后落盘，之后每次启动直接读取，保证重启后 ID 唯一且不变
 * - 读写异常时降级为「本次会话临时 UUID」，不阻塞放映室功能
 */
async function getOrCreateDeviceId(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (saved) return saved;

    const fresh = Crypto.randomUUID();
    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch (e) {
    console.warn(
      '⚠️ 设备 ID 持久化失败，本次会话使用临时 ID:',
      (e as { message?: unknown } | null | undefined)?.message ?? e
    );
    return Crypto.randomUUID();
  }
}

/**
 * Realtime broadcast 回调载荷（Supabase `channel.on('broadcast', ...)` 的入参形态）。
 * 仅声明本文件实际读取的字段，避免引入 `any`。
 */
interface BroadcastMessage<T> {
  payload: T;
}

// roomId 允许 null：调用方（useCinema）在未进入放映厅时传入 null，
// 原 JS 实现以 `if (!roomId || !deviceId) return;` 提前返回，行为不变。
export function useSyncRoom(roomId: string | null): SyncRoomState {
  const [partnerStatus, setPartnerStatus] = useState<string>('等待建立连接...');
  const channelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null);
  const [remoteCommand, setRemoteCommand] = useState<SyncCommandPayload | null>(null);

  // 🍎 实时弹幕列表
  const [danmakuList, setDanmakuList] = useState<DanmakuPayload[]>([]);

  // 🔑 持久化设备 ID（异步就绪，null 表示尚未加载完成）
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // 🆔 C2：身份作用域令牌。切号时旧 channel 回调一律丢弃，并强制重建 channel。
  const { ownerKey, isOwnerKeyCurrent } = useOwnerKey();

  // 🆔 R1-D3：数据所属身份（dataOwnerKey）。
  //    这是「当前 state 里的 danmakuList / partnerStatus / remoteCommand 属于哪个账号」的真实标记，
  //    与「当前渲染身份 ownerKey」是两个不同概念：
  //      · 切号瞬间（首帧）：ownerKey 已是 B，但 state 仍是 A 的数据 → dataOwnerKey 必须仍为 A，
  //        消费端据此在渲染期遮蔽，绝不依赖后续 useEffect 清理。
  //      · 清理 effect 执行后：state 已清空，dataOwnerKey 同步更新为 B，遮罩解除。
  //    若直接返回 ownerKey（当前身份），消费端比较恒等，遮罩永不触发 —— 这是 R1-D3 的原始缺陷。
  const [dataOwnerKey, setDataOwnerKey] = useState<string>(ownerKey);

  // 🆔 R1-D3：切号瞬间清理「账号相关」的残留 state。
  //    remoteCommand 仅在 SUBSCRIBED 时清空，danmakuList / partnerStatus 此前从不重置，
  //    导致切号后新账号首帧仍消费旧账号的弹幕与在线状态。
  //    用 ref 记录上一次 ownerKey，仅在真实切换时执行一次，避免每次渲染重复 setState。
  const prevOwnerKeyRef = useRef<string>(ownerKey);
  useEffect(() => {
    if (prevOwnerKeyRef.current === ownerKey) return;
    prevOwnerKeyRef.current = ownerKey;
    setRemoteCommand(null);
    setDanmakuList([]);
    setPartnerStatus('等待建立连接...');
    // 数据已清空，归属切换到新身份，遮罩解除。
    setDataOwnerKey(ownerKey);
  }, [ownerKey]);

  // 1️⃣ 启动时加载（或首次生成）设备 ID
  useEffect(() => {
    let cancelled = false;
    // 🆔 C2-②：捕获本次加载的 ownerKey 快照，身份变化后不写 state
    const ownerKeySnapshot = ownerKey;
    (async () => {
      const id = await getOrCreateDeviceId();
      if (!cancelled && isOwnerKeyCurrent(ownerKeySnapshot)) setDeviceId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerKey, isOwnerKeyCurrent]);

  // 2️⃣ 设备 ID 就绪后才建立 Realtime Channel
  //    必须等 deviceId，否则 presence.key 会是 null，导致自己收到自己的广播
  useEffect(() => {
    if (!roomId || !deviceId) return;

    // 🆔 C2-③：捕获本次订阅的 ownerKey 快照，回调内比对
    const ownerKeySnapshot = ownerKey;

    const channel = supabase!.channel(roomId, {
      config: { broadcast: { ack: false }, presence: { key: deviceId } },
    });

    // 监听播放控制信令
    channel.on('broadcast', { event: 'sync_command' }, (payload: BroadcastMessage<SyncCommandPayload>) => {
      // 🆔 C2-③：旧订阅回调保护（在 deviceId 比对之外追加 ownerKey 守卫）
      if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
      if (payload.payload.senderId !== deviceId) setRemoteCommand(payload.payload);
    });

    // 🍎 监听对方发来的实时弹幕
    channel.on('broadcast', { event: 'danmaku' }, (payload: BroadcastMessage<DanmakuPayload>) => {
      // 🆔 C2-③：旧订阅回调保护
      if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
      if (payload.payload.senderId !== deviceId) {
        // 🛡️ 内存保护：只保留最近 MAX_DANMAKU_COUNT 条
        setDanmakuList((prev) => [...prev, payload.payload].slice(-MAX_DANMAKU_COUNT));
      }
    });

    channel.on('presence', { event: 'sync' }, () => {
      // 🆔 C2-③：旧订阅回调保护
      if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
      const state = channel.presenceState();
      const onlineCount = Object.keys(state).length;
      if (onlineCount > 1) setPartnerStatus('对方已加入房间');
      else setPartnerStatus('等待对方加入...');
    });

    channel.subscribe((status: string) => {
      // 🆔 C2-③：旧订阅回调保护
      if (!isOwnerKeyCurrent(ownerKeySnapshot)) return;
      if (status === 'SUBSCRIBED') {
        channel.track({ status: 'watching' });
        // 🐞 修复「最小化后点悬浮窗/影院卡回到影院，视频从 0 秒重播」：
        //    remoteCommand 是「一次性」的远端指令，但此前从不重置。
        //    影院页卸载（最小化 → router.back()）时本 Hook 仍存活于 CinemaProvider，
        //    残留的 remoteCommand 会在影院页重新挂载时被 useCinema 的 effect 再次消费，
        //    若指令里的 url 与当前播放源不一致就会 replaceAsync → 从头播放。
        //    订阅成功（新房间连接就绪）时清空旧指令，保证重新挂载的影院页不会重放。
        setRemoteCommand(null);
      }
    });
    channelRef.current = channel;

    return () => {
      supabase!.removeChannel(channel);
      channelRef.current = null;
    };
    // 🆔 C2：ownerKey 纳入依赖 —— 切号时强制重建 channel，旧 channel 回调失效
  }, [roomId, deviceId, ownerKey, isOwnerKeyCurrent]);

  const emitCommand = (type: PlaybackCommandType, time: number = 0, url: string | null = null): void => {
    if (channelRef.current && deviceId) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'sync_command',
        payload: { senderId: deviceId, type, time, url },
      });
    }
  };

  // 🍎 发送弹幕的方法
  const emitDanmaku = (text: string, color: string = '#FFFFFF'): void => {
    if (channelRef.current && deviceId) {
      const msg: DanmakuPayload = {
        senderId: deviceId,
        id: Date.now().toString(),
        text,
        color,
        timestamp: Date.now(),
      };
      channelRef.current.send({ type: 'broadcast', event: 'danmaku', payload: msg });
      // 发送后本地也直接展示（同样受上限保护）
      setDanmakuList((prev) => [...prev, msg].slice(-MAX_DANMAKU_COUNT));
    }
  };

  // 🆔 R1-D3：对外暴露「数据所属身份」dataOwnerKey，而非当前渲染身份。
  //    消费端（cinema.js）用它和 useOwnerKey().ownerKey（当前身份）比较，
  //    切号首帧即可发现不一致并遮蔽旧数据。
  return { partnerStatus, remoteCommand, emitCommand, danmakuList, emitDanmaku, ownerKey: dataOwnerKey };
}
// --- END OF FILE src/hooks/useSyncRoom.ts ---
