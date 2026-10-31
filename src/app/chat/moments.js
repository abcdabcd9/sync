// --- START OF FILE src/app/chat/moments.js ---
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { supabase } from '../../services/supabase';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: id, nickname
// 好友动态（L3 独立页）：读取该好友公开发布的动态
//
// 数据来源：moments 表（阶段 6 规划表）。若表尚未创建，查询会失败，
// 此时降级为「暂无动态」空态，不报错、不阻塞页面。
const formatTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function FriendMomentsScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { id, nickname } = useLocalSearchParams();

  const [items, setItems] = useState([]);
  // 没有好友 id 时无需加载 → 初始值直接为 false，避免在 effect 内同步 setState
  const [loading, setLoading] = useState(Boolean(id));
  const [unavailable, setUnavailable] = useState(false);

  // 读取该好友的动态（异步 IIFE，setState 全部在 await 之后）
  // 抽成独立函数，供首次加载与实时刷新共用
  // ⚠️ 空 id 分支不在这里 setState（会在 effect 内同步 setState 触发 lint 报错），
  //    改由下面的 effect 统一处理。
  const loadMoments = React.useCallback(async (isCancelled) => {
    if (!id) return;
    try {
      // 🔒 只读该好友本人的动态，且仅公开可见（visibility = 'all' | 'friends'）
      const { data, error } = await supabase
        .from('moments')
        .select('id, content, images, created_at, visibility')
        .eq('author_id', id)
        .in('visibility', ['all', 'friends'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (isCancelled?.()) return;
      if (error) throw error;
      setItems(data || []);
      setUnavailable(false);
    } catch {
      // 表不存在或网络异常：降级为空态
      if (isCancelled?.()) return;
      setItems([]);
      setUnavailable(true);
    } finally {
      if (!isCancelled?.()) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // 没有好友 id → 无需加载（loading 初始值已为 false，这里不再 setState）
    if (!id) return undefined;
    let cancelled = false;
    // 用 async IIFE 包裹：所有 setState 都发生在 await 之后，
    // 避免 lint 把同步调用 loadMoments() 判定为「effect 内同步 setState」
    (async () => {
      await loadMoments(() => cancelled);
    })();
    return () => { cancelled = true; };
  }, [id, loadMoments]);

  // =========================================================================
  // 朋友圈实时刷新：该好友发布 / 删除 / 修改动态时，本页立刻更新
  // =========================================================================
  // ⚠️ 用 filter author_id=eq.${id} 做服务端过滤，只收该好友的变更，
  //    避免全表广播带来的性能浪费（RLS 仍会逐行校验，不会泄露他人动态）。
  useEffect(() => {
    if (!id) return undefined;

    const channelName = `moments_realtime_${id}_${Date.now()}`;

    supabase
      .getChannels()
      .filter((ch) => ch.topic === `realtime:${channelName}`)
      .forEach((ch) => supabase.removeChannel(ch));

    // 防抖：合并短时间内的多次变更
    let debounceTimer = null;
    const scheduleReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        loadMoments();
      }, 400);
    };

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'moments', filter: `author_id=eq.${id}` },
        scheduleReload
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [id, loadMoments]);

  const handleBack = () => {
    haptic.light();
    if (router.canGoBack()) router.back();
    else router.replace('/chat/contacts');
  };

  const displayName = nickname || '好友';

  return (
    <SettingsPage title={`${displayName} 的动态`}>
      <GroupTitle>{items.length > 0 ? `共 ${items.length} 条动态` : '动态'}</GroupTitle>
      <Group>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={palette.textSecondary} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="images-outline" size={40} color={palette.separator} />
            <Text style={[styles.emptyText, { color: palette.textSecondary }]}>
              {unavailable ? '暂无可见动态' : 'TA 还没有发布动态'}
            </Text>
            <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
              仅展示对方设置为「公开」或「仅好友」的动态
            </Text>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false}>
            {items.map((m, index) => {
              const images = Array.isArray(m.images) ? m.images : [];
              return (
                <View
                  key={m.id}
                  style={[
                    styles.card,
                    index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
                  ]}
                >
                  <Text style={[styles.content, { color: palette.textPrimary }]}>
                    {m.content || '（无文字内容）'}
                  </Text>
                  {images.length > 0 && (
                    <View style={styles.imageRow}>
                      {images.slice(0, 3).map((src, i) => (
                        <View
                          key={`${m.id}_${i}`}
                          style={[styles.imageBox, { backgroundColor: palette.iconBackground }]}
                        >
                          <Ionicons name="image" size={18} color={palette.textSecondary} />
                        </View>
                      ))}
                      {images.length > 3 && (
                        <Text style={[styles.moreText, { color: palette.textSecondary }]}>
                          +{images.length - 3}
                        </Text>
                      )}
                    </View>
                  )}
                  <Text style={[styles.time, { color: palette.textSecondary }]}>
                    {formatTime(m.created_at)}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        )}
      </Group>

      <View style={styles.footer}>
        <TouchableOpacity onPress={handleBack} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="返回">
          <Text style={[styles.footerText, { color: palette.textSecondary }]}>返回联系人资料</Text>
        </TouchableOpacity>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: 40, alignItems: 'center' },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyText: { fontSize: 15, fontWeight: '500', marginTop: 12 },
  emptyHint: { fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 18 },
  card: { paddingHorizontal: 16, paddingVertical: 14 },
  content: { fontSize: 15, lineHeight: 22 },
  imageRow: { flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' },
  imageBox: {
    width: 64,
    height: 64,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: { fontSize: 13, fontWeight: '500' },
  time: { fontSize: 11, marginTop: 10 },
  footer: { alignItems: 'center', paddingTop: 20 },
  footerText: { fontSize: 14 },
});
// --- END OF FILE src/app/chat/moments.js ---
