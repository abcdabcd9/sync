// --- START OF FILE src/hooks/useSyncRoom.js ---
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from '../services/supabase';

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
async function getOrCreateDeviceId() {
  try {
    const saved = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (saved) return saved;

    const fresh = Crypto.randomUUID();
    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch (e) {
    console.warn('⚠️ 设备 ID 持久化失败，本次会话使用临时 ID:', e?.message ?? e);
    return Crypto.randomUUID();
  }
}

export function useSyncRoom(roomId) {
  const [partnerStatus, setPartnerStatus] = useState('等待建立连接...');
  const channelRef = useRef(null);
  const [remoteCommand, setRemoteCommand] = useState(null);

  // 🍎 实时弹幕列表
  const [danmakuList, setDanmakuList] = useState([]);

  // 🔑 持久化设备 ID（异步就绪，null 表示尚未加载完成）
  const [deviceId, setDeviceId] = useState(null);

  // 1️⃣ 启动时加载（或首次生成）设备 ID
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await getOrCreateDeviceId();
      if (!cancelled) setDeviceId(id);
    })();
    return () => { cancelled = true; };
  }, []);

  // 2️⃣ 设备 ID 就绪后才建立 Realtime Channel
  //    必须等 deviceId，否则 presence.key 会是 null，导致自己收到自己的广播
  useEffect(() => {
    if (!roomId || !deviceId) return;

    const channel = supabase.channel(roomId, {
      config: { broadcast: { ack: false }, presence: { key: deviceId } },
    });

    // 监听播放控制信令
    channel.on('broadcast', { event: 'sync_command' }, (payload) => {
      if (payload.payload.senderId !== deviceId) setRemoteCommand(payload.payload);
    });

    // 🍎 监听对方发来的实时弹幕
    channel.on('broadcast', { event: 'danmaku' }, (payload) => {
      if (payload.payload.senderId !== deviceId) {
        // 🛡️ 内存保护：只保留最近 MAX_DANMAKU_COUNT 条
        setDanmakuList(prev => [...prev, payload.payload].slice(-MAX_DANMAKU_COUNT));
      }
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const onlineCount = Object.keys(state).length;
      if (onlineCount > 1) setPartnerStatus('对方已加入房间');
      else setPartnerStatus('等待对方加入...');
    });

    channel.subscribe((status) => { if (status === 'SUBSCRIBED') channel.track({ status: 'watching' }); });
    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [roomId, deviceId]);

  const emitCommand = (type, time = 0, url = null) => {
    if (channelRef.current && deviceId) {
      channelRef.current.send({ type: 'broadcast', event: 'sync_command', payload: { senderId: deviceId, type, time, url } });
    }
  };

  // 🍎 发送弹幕的方法
  const emitDanmaku = (text, color = '#FFFFFF') => {
    if (channelRef.current && deviceId) {
      const msg = { senderId: deviceId, id: Date.now().toString(), text, color, timestamp: Date.now() };
      channelRef.current.send({ type: 'broadcast', event: 'danmaku', payload: msg });
      // 发送后本地也直接展示（同样受上限保护）
      setDanmakuList(prev => [...prev, msg].slice(-MAX_DANMAKU_COUNT));
    }
  };

  return { partnerStatus, remoteCommand, emitCommand, danmakuList, emitDanmaku };
}
// --- END OF FILE src/hooks/useSyncRoom.js ---
