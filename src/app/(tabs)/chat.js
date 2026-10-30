// --- START OF FILE src/app/(tabs)/chat.js ---
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Modal,
  Pressable,
  Animated,
  useWindowDimensions,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { haptic } from '../../constants/haptics';
import { useChatList } from '../../hooks/chat/useChatList';
import ConversationRow from '../../components/chat/ConversationRow';
import ChatRoomInner from '../../components/ChatRoomInner';

// params: 无（tab 页）
// 聊天页（纯 IM 化）：只保留「消息列表」。
// 联系人 → /chat/contacts，搜索加友 → /chat/search（L3 页面）。
// 数据层（好友 / 未读 / 最新消息 / 实时监听）全部在 useChatList 中，逻辑与原实现一致。
export default function ChatMainScreen() {
  const { isDark, colors: palette } = useAppTheme();
  const router = useRouter();
  const { user, isAuthLoading } = useAuth();

  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const { conversations, unreadCounts, friendsMap, latestMessages, loading, getDisplayName } =
    useChatList(user);

  const [selectedChat, setSelectedChat] = useState(null);
  // 会话长按菜单：与右上角「+」同款小弹窗（贴右上角、圆角卡片、图标+文字行）
  // 只保留 visible + chat，不再需要按触点计算 top（统一锚定右上角）
  const [menuConfig, setMenuConfig] = useState({ visible: false, chat: null });
  // 右上角「+」的小弹窗（联系人 / 添加好友）
  const [plusMenuVisible, setPlusMenuVisible] = useState(false);

  // 列表入场动画（原 subTabSlideAnim 保留，避免视觉回退）
  // ⚠️ 必须用 useState 惰性初始化：useRef(...).current 在渲染期读取 ref，违反 react-hooks/refs
  const [listSlideAnim] = useState(() => new Animated.Value(80));

  useFocusEffect(
    useCallback(() => {
      listSlideAnim.setValue(80);
      Animated.spring(listSlideAnim, {
        toValue: 0,
        friction: 7,
        tension: 60,
        useNativeDriver: true,
      }).start();
    }, [listSlideAnim])
  );

  // 一级 tab 页不再保留 iOS 边缘右滑返回首页手势：
  // 底栏常驻，用户直接点底栏切换即可，避免与列表横向滚动/长按冲突。

  const openChatRoom = (item) => {
    haptic.light();
    const displayName = getDisplayName(item);
    if (isTablet) {
      setSelectedChat({ id: item.id, name: displayName });
    } else {
      router.push({ pathname: '/chat_room', params: { targetId: item.id, targetName: displayName } });
    }
  };

  // 长按会话：打开与「+」同款的小弹窗（不再按触点定位）
  const handleLongPress = (item) => {
    haptic.heavy();
    setMenuConfig({ visible: true, chat: item });
  };

  const closeActionMenu = () => setMenuConfig({ visible: false, chat: null });

  if (!isAuthLoading && !user) {
    return (
      <SafeAreaView
        style={[styles.container, styles.authGate, { backgroundColor: palette.background }]}
        edges={['top']}
      >
        <Text style={[styles.authGateText, { color: palette.textPrimary }]}>
          请先登录体验云端通讯
        </Text>
      </SafeAreaView>
    );
  }

  const renderMessagesView = () => (
    <ScrollView
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
    >
      {conversations.length === 0 ? (
        <View style={styles.centerBox}>
          <Ionicons name="chatbubbles-outline" size={64} color={palette.separator} />
          <Text style={[styles.emptyText, { color: palette.textSecondary }]}>暂无聊天会话</Text>
        </View>
      ) : (
        conversations.map((item) => {
          if (!item) return null;
          const unreadNum = unreadCounts[item.id] || 0;
          return (
            <ConversationRow
              key={item.id}
              item={item}
              displayName={getDisplayName(item)}
              previewText={latestMessages[item.id] || '点击进入会话...'}
              unreadNum={unreadNum}
              isMuted={!!friendsMap[item.id]?.is_muted}
              isSelected={isTablet && selectedChat?.id === item.id}
              onPress={() => openChatRoom(item)}
              onLongPress={() => handleLongPress(item)}
            />
          );
        })
      )}
    </ScrollView>
  );

  const MasterColumn = (
    <View
      style={[
        styles.masterColumn,
        isTablet && { width: 350, flex: 'none', borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: palette.separator },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: palette.chatBorder }]}>
        {/* 一级 tab 页不显示返回箭头：底栏常驻，用户可直接切 tab */}
        <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>消息</Text>

        {/* 右上角「+」：弹出小菜单（联系人 / 添加好友） */}
        <TouchableOpacity
          style={styles.headerActionBtn}
          onPress={() => {
            haptic.light();
            setPlusMenuVisible(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="更多操作"
          accessibilityHint="打开联系人菜单"
        >
          <Ionicons name="add" size={28} color={palette.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={palette.textSecondary} />
        </View>
      ) : (
        <Animated.View style={[styles.flex, { transform: [{ translateY: listSlideAnim }] }]}>
          {renderMessagesView()}
        </Animated.View>
      )}
    </View>
  );

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: palette.background }]}
      edges={['top']}
    >
      {isTablet ? (
        <View style={styles.tabletRow}>
          {MasterColumn}
          <View style={[styles.flex, { backgroundColor: isDark ? '#000' : '#FFF' }]}>
            {selectedChat ? (
              <ChatRoomInner
                targetId={selectedChat.id}
                targetName={selectedChat.name}
                isTabletMode={true}
              />
            ) : (
              <View style={styles.centerBox}>
                <Ionicons name="chatbubbles-outline" size={80} color={palette.separator} />
                <Text style={[styles.tabletHint, { color: palette.textSecondary }]}>
                  请在左侧选择一个联系人开始聊天
                </Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        MasterColumn
      )}

      {/* 会话长按菜单：与右上角「+」完全同款的小弹窗（贴右上角 / 圆角卡片 / 图标+文字行）
          功能项仍为占位，与原实现保持一致 */}
      <Modal
        visible={menuConfig.visible}
        transparent
        animationType="fade"
        onRequestClose={closeActionMenu}
      >
        <Pressable style={styles.plusOverlay} onPress={closeActionMenu}>
          <View
            style={[
              styles.plusMenu,
              { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', borderColor: palette.cardBorder },
            ]}
          >
            <TouchableOpacity
              style={styles.plusMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('已读开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="标为已读"
            >
              <Ionicons name="checkmark-done-outline" size={20} color={palette.primary} />
              <Text style={[styles.plusMenuText, { color: palette.textPrimary }]}>标为已读</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.plusMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('置顶开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="置顶该聊天"
            >
              <Ionicons name="arrow-up-circle-outline" size={20} color={palette.primary} />
              <Text style={[styles.plusMenuText, { color: palette.textPrimary }]}>置顶该聊天</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.plusMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('隐藏开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="不显示该聊天"
            >
              <Ionicons name="eye-off-outline" size={20} color={palette.primary} />
              <Text style={[styles.plusMenuText, { color: palette.textPrimary }]}>不显示该聊天</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.plusMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('删除开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="删除该聊天"
            >
              <Ionicons name="trash-outline" size={20} color="#FF3B30" />
              <Text style={[styles.plusMenuText, { color: '#FF3B30' }]}>删除该聊天</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* 右上角「+」小弹窗：联系人 / 添加好友 */}
      <Modal
        visible={plusMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPlusMenuVisible(false)}
      >
        <Pressable style={styles.plusOverlay} onPress={() => setPlusMenuVisible(false)}>
          <View
            style={[
              styles.plusMenu,
              { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', borderColor: palette.cardBorder },
            ]}
          >
            <TouchableOpacity
              style={styles.plusMenuItem}
              onPress={() => {
                setPlusMenuVisible(false);
                haptic.light();
                router.push('/chat/contacts');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="联系人"
            >
              <Ionicons name="people-outline" size={20} color={palette.primary} />
              <Text style={[styles.plusMenuText, { color: palette.textPrimary }]}>联系人</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.plusMenuItem}
              onPress={() => {
                setPlusMenuVisible(false);
                haptic.light();
                router.push('/chat/search');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="添加好友"
            >
              <Ionicons name="person-add-outline" size={20} color={palette.primary} />
              <Text style={[styles.plusMenuText, { color: palette.textPrimary }]}>添加好友</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  masterColumn: { flex: 1 },
  tabletRow: { flex: 1, flexDirection: 'row' },
  authGate: { justifyContent: 'center', alignItems: 'center' },
  authGateText: { fontSize: 18, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerActionBtn: { position: 'absolute', right: 12, padding: 4, zIndex: 10 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  listContent: { paddingTop: 8, paddingBottom: 100 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { marginTop: 16 },
  tabletHint: { marginTop: 16, fontSize: 18 },
  // 右上角小弹窗（「+」菜单 与 会话长按菜单 共用同一套样式）
  plusOverlay: { flex: 1, backgroundColor: 'transparent' },
  plusMenu: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 96 : 72,
    right: 16,
    width: 180,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  plusMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingHorizontal: 16 },
  plusMenuText: { fontSize: 16, fontWeight: '500' },
  plusMenuLine: { height: StyleSheet.hairlineWidth },
});
// --- END OF FILE src/app/(tabs)/chat.js ---
