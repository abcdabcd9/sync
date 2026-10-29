// --- START OF FILE src/app/chat_room.js ---
import React, { useState, useEffect } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAppTheme } from '../context/ThemeContext';
import { supabase } from '../services/supabase';
import ChatRoomInner from '../components/ChatRoomInner';

// 🔒 无效标题黑名单：空 / 纯数字 / 通用占位词，一律视为「需要自我修复」
const INVALID_TITLE_TOKENS = new Set(['聊天', '新消息', 'TA', 'ta', 'Ta', '未知用户', '用户', 'undefined', 'null']);
const isInvalidTitle = (v) => {
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return true; // 纯数字（如 '1'）
  return INVALID_TITLE_TOKENS.has(s);
};

/** 从 profiles 行解析展示名：nickname → username（邮箱取 @ 前）→ null */
const pickDisplayName = (row) => {
  const nick = typeof row?.nickname === 'string' ? row.nickname.trim() : '';
  if (!isInvalidTitle(nick)) return nick;

  const uname = typeof row?.username === 'string' ? row.username.trim() : '';
  if (uname) {
    const localPart = uname.includes('@') ? uname.split('@')[0] : uname;
    if (!isInvalidTitle(localPart)) return localPart;
  }
  return null;
};

export default function ChatRoomScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { targetId, targetName } = useLocalSearchParams();

  // 标题自我修复：路由参数无效时，按 targetId 反查 profiles 拿真实昵称
  const [resolvedName, setResolvedName] = useState(() => (isInvalidTitle(targetName) ? '' : targetName));

  useEffect(() => {
    // 路由参数变化时先同步一次（有效则直接用）
    if (!isInvalidTitle(targetName)) {
      setResolvedName(targetName);
      return undefined;
    }

    if (!targetId) {
      setResolvedName('');
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('nickname, username')
          .eq('id', targetId)
          .maybeSingle();

        if (cancelled) return;
        if (error || !data) {
          setResolvedName('');
          return;
        }
        setResolvedName(pickDisplayName(data) || '');
      } catch (_) {
        if (!cancelled) setResolvedName('');
      }
    })();

    return () => { cancelled = true; };
  }, [targetId, targetName]);

  // 最终展示名：修复成功用真实昵称，否则用中性占位（绝不显示「聊天」或数字）
  const displayName = resolvedName || '好友';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top']}>
      <ChatRoomInner
        targetId={targetId}
        targetName={displayName}
        isTabletMode={false}
        onBack={() => router.back()}
      />
    </SafeAreaView>
  );
}
// --- END OF FILE src/app/chat_room.js ---
