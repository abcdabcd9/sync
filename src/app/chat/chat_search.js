// --- START OF FILE src/app/chat/chat_search.js ---
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: targetId, targetName
// 查找聊天记录（L3 独立页）
export default function ChatSearchScreen() {
  const { colors: palette } = useAppTheme();
  const { user } = useAuth();
  const { targetId, targetName } = useLocalSearchParams();

  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw || !user || !targetId) return;
    setSearching(true);
    setSearched(true);
    try {
      // 🔒 归属校验：只查「我参与的」这段会话
      const { data } = await supabase
        .from('messages')
        .select('id, text, type, created_at, user_id')
        .or(
          `and(user_id.eq.${user.id},receiver_id.eq.${targetId}),and(user_id.eq.${targetId},receiver_id.eq.${user.id})`
        )
        .ilike('text', `%${kw}%`)
        .order('created_at', { ascending: false })
        .limit(50);
      setResults(data || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [keyword, user, targetId]);

  return (
    <SettingsPage title="查找聊天记录">
      <GroupTitle>{targetName ? `与「${targetName}」的聊天` : '聊天记录'}</GroupTitle>
      <Group>
        <View style={styles.searchRow}>
          <View
            style={[
              styles.inputWrap,
              { backgroundColor: palette.background, borderColor: palette.cardBorder },
            ]}
          >
            <Ionicons name="search" size={16} color={palette.textSecondary} />
            <TextInput
              style={[styles.input, { color: palette.textPrimary }]}
              placeholder="输入关键词"
              placeholderTextColor={palette.textSecondary}
              value={keyword}
              onChangeText={setKeyword}
              onSubmitEditing={handleSearch}
              returnKeyType="search"
              autoFocus
            />
          </View>
        </View>
      </Group>

      <GroupTitle>结果</GroupTitle>
      <Group>
        {searching && (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>搜索中...</Text>
        )}
        {!searching && searched && results.length === 0 && (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>没有找到相关记录</Text>
        )}
        {!searching && !searched && (
          <Text style={[styles.hint, { color: palette.textSecondary }]}>
            输入关键词后按回车开始搜索
          </Text>
        )}
        {results.map((m, index) => (
          <View
            key={m.id}
            style={[
              styles.resultRow,
              index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
            ]}
          >
            <Text style={[styles.resultText, { color: palette.textPrimary }]} numberOfLines={2}>
              {m.text || '[非文本消息]'}
            </Text>
            <Text style={[styles.resultTime, { color: palette.textSecondary }]}>
              {new Date(m.created_at).toLocaleString('zh-CN')}
            </Text>
          </View>
        ))}
      </Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  searchRow: { paddingHorizontal: 16, paddingVertical: 12 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    height: 38,
  },
  input: { flex: 1, fontSize: 15, padding: 0 },
  hint: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 14 },
  resultRow: { paddingHorizontal: 16, paddingVertical: 12 },
  resultText: { fontSize: 14 },
  resultTime: { fontSize: 11, marginTop: 4 },
});
// --- END OF FILE src/app/chat/chat_search.js ---
