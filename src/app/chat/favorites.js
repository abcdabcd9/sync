// --- START OF FILE src/app/chat/favorites.js ---
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { haptic } from '../../constants/haptics';
import { useChatFavorites } from '../../hooks/chat/useChatFavorites';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: 无
// 我的收藏（L3 独立页）：展示所有被「收藏」的聊天消息，可跳回原会话
const TYPE_LABEL = {
  text: '文字',
  image: '图片',
  video: '视频',
  audio: '语音',
};

const TYPE_ICON = {
  text: 'chatbubble-outline',
  image: 'image-outline',
  video: 'videocam-outline',
  audio: 'mic-outline',
};

const formatTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ChatFavoritesScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const favorites = useChatFavorites(user);

  // 长按选中项（用于删除）
  const [activeId, setActiveId] = useState(null);

  const handleOpenSource = useCallback(
    (item) => {
      if (!item?.peerId) return;
      haptic.light();
      router.push({
        pathname: '/chat_room',
        params: { targetId: item.peerId, targetName: item.peerName || '好友' },
      });
    },
    [router]
  );

  const handleRemove = useCallback(
    (item) => {
      haptic.warning();
      Alert.alert('取消收藏', '确定要从收藏中移除这条消息吗？', [
        { text: '取消', style: 'cancel' },
        {
          text: '移除',
          style: 'destructive',
          onPress: () => {
            favorites.removeFavorite(item.id);
            haptic.success();
            setActiveId(null);
          },
        },
      ]);
    },
    [favorites]
  );

  const handleClearAll = useCallback(() => {
    if (favorites.count === 0) return;
    haptic.warning();
    Alert.alert('清空收藏', '确定要清空全部收藏吗？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          favorites.clearFavorites();
          haptic.success();
        },
      },
    ]);
  }, [favorites]);

  const renderPreview = (item) => {
    if (item.type === 'text') return item.text || '（空消息）';
    if (item.type === 'audio') return `语音 ${item.duration || 0}"`;
    return `[${TYPE_LABEL[item.type] || '消息'}]`;
  };

  return (
    <SettingsPage title="我的收藏">
      <GroupTitle>{favorites.count > 0 ? `共 ${favorites.count} 条` : '收藏'}</GroupTitle>
      <Group>
        {favorites.count === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="star-outline" size={40} color={palette.separator} />
            <Text style={[styles.emptyText, { color: palette.textSecondary }]}>
              还没有收藏任何消息
            </Text>
            <Text style={[styles.emptyHint, { color: palette.textSecondary }]}>
              在聊天中长按消息，选择「收藏」即可保存到这里
            </Text>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false}>
            {favorites.items.map((item, index) => (
              <TouchableOpacity
                key={item.id}
                style={[
                  styles.row,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
                  activeId === item.id && { backgroundColor: palette.separator },
                ]}
                onPress={() => handleOpenSource(item)}
                onLongPress={() => {
                  haptic.medium();
                  setActiveId(item.id);
                }}
                delayLongPress={250}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={`收藏消息：${renderPreview(item)}`}
                accessibilityHint="点击回到原会话，长按可移除"
              >
                <View style={[styles.iconBox, { backgroundColor: palette.iconBackground }]}>
                  <Ionicons
                    name={TYPE_ICON[item.type] || 'chatbubble-outline'}
                    size={18}
                    color={palette.primary}
                  />
                </View>
                <View style={styles.textCol}>
                  <Text style={[styles.preview, { color: palette.textPrimary }]} numberOfLines={2}>
                    {renderPreview(item)}
                  </Text>
                  <Text style={[styles.meta, { color: palette.textSecondary }]} numberOfLines={1}>
                    {item.peerName || '未知会话'} · {formatTime(item.savedAt)}
                  </Text>
                </View>
                {activeId === item.id && (
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={() => handleRemove(item)}
                    activeOpacity={0.6}
                    accessibilityRole="button"
                    accessibilityLabel="移除收藏"
                  >
                    <Ionicons name="trash-outline" size={18} color="#FF3B30" />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </Group>

      {favorites.count > 0 && (
        <View style={styles.footerWrap}>
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={handleClearAll}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="清空收藏"
          >
            <Text style={styles.clearText}>清空收藏</Text>
          </TouchableOpacity>
        </View>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 64,
  },
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: { flex: 1 },
  preview: { fontSize: 15, lineHeight: 20 },
  meta: { fontSize: 11, marginTop: 4 },
  removeBtn: { padding: 6 },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyText: { fontSize: 15, fontWeight: '500', marginTop: 12 },
  emptyHint: { fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 18 },
  footerWrap: { paddingHorizontal: 16, paddingTop: 20 },
  clearBtn: {
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,59,48,0.10)',
  },
  clearText: { fontSize: 16, fontWeight: '500', color: '#FF3B30' },
});
// --- END OF FILE src/app/chat/favorites.js ---
