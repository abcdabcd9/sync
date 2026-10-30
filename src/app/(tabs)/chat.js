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
  Dimensions,
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
  // 会话长按菜单：与右上角「+」同款视觉（圆角卡片 + 纯文字行，无图标）
  // top 由触点 pageY 计算，弹窗出现在手指下方；left 由触点 pageX 计算，自动贴边
  const [menuConfig, setMenuConfig] = useState({ visible: false, top: 0, left: 0, chat: null });
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

  // 长按会话：弹窗出现在手指下方（跟随触点），并自动贴边不超出屏幕
  const handleLongPress = (item, evt) => {
    haptic.heavy();
    const { pageX, pageY } = evt.nativeEvent;
    const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
    // 菜单宽度按最长文案「不显示该聊天」自适应（6 字 × 16px + 左右内边距 32 + 边框）
    const MENU_W = 148;
    const MENU_H = 4 * 46 + 3 * StyleSheet.hairlineWidth; // 4 行 × 行高 + 3 条分隔线
    const GAP = 8; // 手指与弹窗的间距

    // 水平：默认左边缘对齐触点，右侧越界则向左翻转
    let left = pageX;
    if (left + MENU_W > SCREEN_W - 8) left = SCREEN_W - MENU_W - 8;
    if (left < 8) left = 8;

    // 垂直：默认出现在手指下方；下方空间不足则上移到手指上方
    let top = pageY + GAP;
    if (top + MENU_H > SCREEN_H - 8) top = pageY - MENU_H - GAP;
    if (top < 8) top = 8;

    setMenuConfig({ visible: true, top, left, chat: item });
  };

  const closeActionMenu = () => setMenuConfig({ visible: false, top: 0, left: 0, chat: null });

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

      {/* 会话长按菜单：与「+」同款视觉（圆角卡片 + 纯文字行，无图标）
          位置跟随手指（出现在手指下方，越界自动翻转）；功能项仍为占位 */}
      <Modal
        visible={menuConfig.visible}
        transparent
        animationType="fade"
        onRequestClose={closeActionMenu}
      >
        <Pressable style={styles.plusOverlay} onPress={closeActionMenu}>
          <View
            style={[
              styles.contextMenu,
              {
                backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
                borderColor: palette.cardBorder,
                top: menuConfig.top,
                left: menuConfig.left,
              },
            ]}
          >
            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('已读开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="标为已读"
            >
              <Text style={[styles.contextMenuText, { color: palette.textPrimary }]}>标为已读</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('置顶开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="置顶该聊天"
            >
              <Text style={[styles.contextMenuText, { color: palette.textPrimary }]}>置顶该聊天</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('隐藏开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="不显示该聊天"
            >
              <Text style={[styles.contextMenuText, { color: palette.textPrimary }]}>不显示该聊天</Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                closeActionMenu();
                alert('删除开发中');
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="删除该聊天"
            >
              <Text style={[styles.contextMenuText, styles.contextMenuTextDanger]}>删除该聊天</Text>
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
  // 右上角「+」小弹窗：贴右上角，宽度按最长文案「添加好友」自适应（不留白）
  plusOverlay: { flex: 1, backgroundColor: 'transparent' },
  plusMenu: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 96 : 72,
    right: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  plusMenuItem: { paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  plusMenuText: { fontSize: 16, fontWeight: '500' },
  plusMenuLine: { height: StyleSheet.hairlineWidth },
  // 会话长按菜单：与「+」同款视觉，位置由触点计算（跟随手指）
  contextMenu: {
    position: 'absolute',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  contextMenuItem: { paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  contextMenuText: { fontSize: 16, fontWeight: '500', textAlign: 'center' },
  contextMenuTextDanger: { color: '#FF3B30' },
});
// --- END OF FILE src/app/(tabs)/chat.js ---
