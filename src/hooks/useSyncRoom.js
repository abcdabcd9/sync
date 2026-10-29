// --- START OF FILE src/hooks/useSyncRoom.js ---
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../services/supabase';

const DEVICE_ID = Math.random().toString(36).substring(2, 10);

export function useSyncRoom(roomId) {
  const [partnerStatus, setPartnerStatus] = useState('等待建立连接...');
  const channelRef = useRef(null);
  const [remoteCommand, setRemoteCommand] = useState(null);
  
  // 🍎 新增：实时弹幕列表
  const [danmakuList, setDanmakuList] = useState([]);

  useEffect(() => {
    if (!roomId) return; 

    const channel = supabase.channel(roomId, {
      config: { broadcast: { ack: false }, presence: { key: DEVICE_ID } },
    });

    // 监听播放控制信令
    channel.on('broadcast', { event: 'sync_command' }, (payload) => {
      if (payload.payload.senderId !== DEVICE_ID) setRemoteCommand(payload.payload);
    });

    // 🍎 监听对方发来的实时弹幕
    channel.on('broadcast', { event: 'danmaku' }, (payload) => {
      if (payload.payload.senderId !== DEVICE_ID) {
        setDanmakuList(prev => [...prev, payload.payload]);
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

    return () => { supabase.removeChannel(channel); };
  }, [roomId]);

  const emitCommand = (type, time = 0, url = null) => {
    if (channelRef.current) {
      channelRef.current.send({ type: 'broadcast', event: 'sync_command', payload: { senderId: DEVICE_ID, type, time, url } });
    }
  };

  // 🍎 新增：发送弹幕的方法
  const emitDanmaku = (text, color = '#FFFFFF') => {
    if (channelRef.current) {
      const msg = { senderId: DEVICE_ID, id: Date.now().toString(), text, color, timestamp: Date.now() };
      channelRef.current.send({ type: 'broadcast', event: 'danmaku', payload: msg });
      // 发送后本地也直接展示
      setDanmakuList(prev => [...prev, msg]);
    }
  };

  return { partnerStatus, remoteCommand, emitCommand, danmakuList, emitDanmaku };
}
// --- END OF FILE src/hooks/useSyncRoom.js ---