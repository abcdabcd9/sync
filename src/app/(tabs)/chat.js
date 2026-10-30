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
  Dimensions,
  Animated,
  useWindowDimensions,
  PanResponder,
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
  const [menuConfig, setMenuConfig] = useState({ visible: false, top: 0, chat: null });

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

  // iOS 边缘右滑返回首页（原逻辑保留）
  // ⚠️ 同样用 useState 惰性初始化，避免渲染期读取 ref
  const [edgeSwipeResponder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const { pageX } = evt.nativeEvent;
        return (
          Platform.OS === 'ios' &&
          pageX < 40 &&
          gestureState.dx > 10 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy)
        );
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dx > 50 || gestureState.vx > 0.5) {
          haptic.light();
          router.navigate('/');
        }
      },
      onPanResponderTerminationRequest: () => false,
    })
  );

  const openChatRoom = (item) => {
    haptic.light();
    const displayName = getDisplayName(item);
    if (isTablet) {
      setSelectedChat({ id: item.id, name: displayName });
    } else {
      router.push({ pathname: '/chat_room', params: { targetId: item.id, targetName: displayName } });
    }
  };

  const handleLongPress = (item, evt) => {
    haptic.heavy();
    const touchY = evt.nativeEvent.pageY;
    const { height: SCREEN_HEIGHT } = Dimensions.get('window');
    const topPosition = touchY < SCREEN_HEIGHT / 2 ? touchY : touchY - 180;
    setMenuConfig({ visible: true, top: topPosition, chat: item });
  };

  const closeActionMenu = () => setMenuConfig({ visible: false, top: 0, chat: null });

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
              onLongPress={(e) => handleLongPress(item, e)}
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
        <TouchableOpacity
          style={styles.headerBackBtn}
          onPress={() => {
            haptic.light();
            router.navigate('/');
          }}
          accessibilityRole="button"
          accessibilityLabel="返回首页"
        >
          <Ionicons name="chevron-back" size={28} color={palette.primary} />
        </TouchableOpacity>

        <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>消息</Text>

        {/* 右上角「+」：进入联系人页（新朋友请求 + 所有联系人 + 搜索入口） */}
        <TouchableOpacity
          style={styles.headerActionBtn}
          onPress={() => {
            haptic.light();
            router.push('/chat/contacts');
          }}
          accessibilityRole="button"
          accessibilityLabel="联系人"
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
      {...edgeSwipeResponder.panHandlers}
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

      {/* 会话长按菜单（功能项仍为占位，与原实现保持一致） */}
      <Modal visible={menuConfig.visible} transparent animationType="none" onRequestClose={closeActionMenu}>
        <Pressable style={styles.invisibleOverlay} onPress={closeActionMenu}>
          <View
            style={[
              styles.contextMenuContainer,
              { backgroundColor: isDark ? '#1C1C1E' : '#F9F9F9', top: menuConfig.top },
            ]}
          >
            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('已读开发中');
              }}
            >
              <Text style={[styles.contextText, { color: palette.textPrimary }]}>标为已读</Text>
            </TouchableOpacity>
            <View style={[styles.menuLine, { backgroundColor: palette.separator }]} />
            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('置顶开发中');
              }}
            >
              <Text style={[styles.contextText, { color: palette.textPrimary }]}>置顶该聊天</Text>
            </TouchableOpacity>
            <View style={[styles.menuLine, { backgroundColor: palette.separator }]} />
            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('隐藏开发中');
              }}
            >
              <Text style={[styles.contextText, { color: palette.textPrimary }]}>不显示该聊天</Text>
            </TouchableOpacity>
            <View style={[styles.menuLine, { backgroundColor: palette.separator }]} />
            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('删除开发中');
              }}
            >
              <Text style={[styles.contextText, styles.contextTextDanger]}>删除该聊天</Text>
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
  headerBackBtn: { position: 'absolute', left: 12, padding: 4, zIndex: 10 },
  headerActionBtn: { position: 'absolute', right: 12, padding: 4, zIndex: 10 },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  listContent: { paddingTop: 8, paddingBottom: 100 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyText: { marginTop: 16 },
  tabletHint: { marginTop: 16, fontSize: 18 },
  invisibleOverlay: { flex: 1, backgroundColor: 'transparent' },
  contextMenuContainer: {
    position: 'absolute',
    right: 24,
    width: 140,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(150,150,150,0.3)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  contextMenuItem: { paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  contextText: { fontSize: 15, fontWeight: '400', textAlign: 'center' },
  contextTextDanger: { color: '#FF3B30' },
  menuLine: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(150,150,150,0.1)' },
});
// --- END OF FILE src/app/(tabs)/chat.js ---
