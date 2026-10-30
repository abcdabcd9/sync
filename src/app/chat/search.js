// --- START OF FILE src/app/chat/search.js ---
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import { haptic } from '../../constants/haptics';
import SettingsPage from '../../components/settings/SettingsPage';

// params: 无
// 搜索加友：输入 Sync ID → 查找用户 → 发送好友请求
// 逻辑原样迁移自原 src/app/(tabs)/chat.js 的 handleSearchAdd / handleSearchChange
export default function ChatSearchScreen() {
  const { colors: palette } = useAppTheme();
  const { user } = useAuth();

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  // 🔒 安全审计 #16：搜索防抖节流
  // 用户每敲一个字符都会触发 onChangeText，若直接查询 Supabase 的 sync_id，
  // 会形成高频碰撞查询（可被用于枚举 Sync ID）。这里用 500ms 防抖 + 在途请求去重，
  // 保证同一时间最多只有一个查询，且只在用户停止输入后才真正发起。
  const searchTimerRef = useRef(null);
  const searchInFlightRef = useRef(false);
  const lastQueriedRef = useRef('');

  // 组件卸载时清理定时器，避免内存泄漏与卸载后 setState
  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    },
    []
  );

  const handleSearchAdd = useCallback(async () => {
    const keyword = searchQuery.trim();
    if (!keyword) return;

    // 输入长度不足 3 位（与 sync_id 最小长度一致）时不发起查询，进一步降低碰撞面
    if (keyword.length < 3) {
      Alert.alert('提示', 'Sync ID 至少 3 个字符，请继续输入。');
      return;
    }

    // 在途请求去重：上一次查询尚未返回时直接忽略，防止连点/连敲造成并发查询
    if (searchInFlightRef.current) return;
    // 同一关键词不重复查询
    if (keyword === lastQueriedRef.current) return;

    Keyboard.dismiss();
    setIsSearching(true);
    haptic.light();
    searchInFlightRef.current = true;
    lastQueriedRef.current = keyword;

    let foundUsers = null;
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, nickname')
        .eq('sync_id', keyword)
        .limit(1);
      foundUsers = data;
    } finally {
      searchInFlightRef.current = false;
      setIsSearching(false);
    }

    if (!foundUsers || foundUsers.length === 0) {
      // 查询失败/无结果时允许用户用同一关键词重试
      lastQueriedRef.current = '';
      Alert.alert('未找到用户', '请确认对方的 Sync ID 是否正确');
      return;
    }

    const targetUser = foundUsers[0];
    if (targetUser.id === user?.id) {
      Alert.alert('提示', '不能添加自己哦');
      return;
    }

    // 已是好友则不再发送请求
    const { data: existing } = await supabase
      .from('friends')
      .select('id')
      .or(
        `and(user_id.eq.${user.id},friend_id.eq.${targetUser.id}),and(user_id.eq.${targetUser.id},friend_id.eq.${user.id})`
      )
      .limit(1);
    if (existing && existing.length > 0) {
      Alert.alert('提示', '已经是好友了');
      return;
    }

    const targetName = targetUser.nickname || targetUser.username;
    Alert.alert('找到用户', `向 [${targetName}] 发送好友请求？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '发送请求',
        onPress: async () => {
          haptic.success();
          // 🔒 安全审计 #7：sender_id 强制绑定当前登录用户，杜绝伪造发送者
          if (!user?.id) return;
          const { error } = await supabase
            .from('friend_requests')
            .insert({ sender_id: user.id, receiver_id: targetUser.id });
          if (error && error.code === '23505') {
            Alert.alert('提示', '请求已发送，等待对方通过。');
          } else if (error) {
            Alert.alert('发送失败', '好友请求发送失败，请稍后重试。');
          } else {
            Alert.alert('发送成功', '好友请求已发送，等待对方通过。');
            setSearchQuery('');
            lastQueriedRef.current = '';
          }
        },
      },
    ]);
  }, [searchQuery, user]);

  // 🔒 安全审计 #16：输入监听走 500ms 防抖，避免逐字符触发 Supabase 查询
  const handleSearchChange = (text) => {
    setSearchQuery(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    // 关键词变化后允许重新查询同一 Sync ID
    if (text.trim() !== lastQueriedRef.current) lastQueriedRef.current = '';
    if (!text.trim()) return;
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      handleSearchAdd();
    }, 500);
  };

  return (
    <SettingsPage title="添加好友">
      <Text style={[styles.intro, { color: palette.textSecondary }]}>
        输入对方的 Sync ID 即可查找并发送好友请求。Sync ID 可在「个人资料」页查看。
      </Text>

      <View style={[styles.searchBox, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
        <Ionicons name="search" size={20} color={palette.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={[styles.searchInput, { color: palette.textPrimary }]}
          placeholder="输入 Sync ID"
          placeholderTextColor={palette.textSecondary}
          value={searchQuery}
          onChangeText={handleSearchChange}
          onSubmitEditing={handleSearchAdd}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={15}
          autoFocus
        />
        {isSearching && <ActivityIndicator size="small" color={palette.textSecondary} />}
      </View>

      <TouchableOpacity
        style={[styles.submitBtn, { backgroundColor: palette.primary }]}
        onPress={handleSearchAdd}
        disabled={isSearching}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel="搜索"
      >
        <Text style={styles.submitText}>{isSearching ? '搜索中…' : '搜索'}</Text>
      </TouchableOpacity>

      <Text style={[styles.hint, { color: palette.textSecondary }]}>
        为保护隐私，Sync ID 至少 3 个字符才会发起查询；连续输入时会自动防抖，避免高频请求。
      </Text>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 13, lineHeight: 20, marginBottom: 16, paddingHorizontal: 4 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
  },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, fontSize: 16, height: '100%' },
  submitBtn: {
    marginTop: 16,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 16, paddingHorizontal: 4 },
});
// --- END OF FILE src/app/chat/search.js ---
