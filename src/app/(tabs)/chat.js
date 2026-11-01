// --- START OF FILE src/app/(tabs)/chat.js ---
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { haptic } from '../../constants/haptics';
import { supabase } from '../../services/supabase';
import { useChatList } from '../../hooks/chat/useChatList';
import { useChatPrefs } from '../../hooks/chat/useChatPrefs';
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

  const {
    conversations,
    unreadCounts,
    friendsMap,
    latestMessages,
    lastMsgTimes,
    loading,
    refresh,
    getDisplayName,
  } = useChatList(user);

  // 会话级偏好（置顶 / 隐藏 / 免打扰 / 星标）—— 持久化到 AsyncStorage，按用户隔离
  const prefs = useChatPrefs(user);

  const [selectedChat, setSelectedChat] = useState(null);
  // 「标为已读」后的本地角标清零（仅本次会话有效，刷新后由数据库 is_read 决定）
  const [readIds, setReadIds] = useState([]);
  // 会话长按菜单：与右上角「+」同款视觉（圆角卡片 + 纯文字行，无图标）
  // top 由触点 pageY 计算，弹窗出现在手指下方；left 由触点 pageX 计算，自动贴边
  const [menuConfig, setMenuConfig] = useState({ visible: false, top: 0, left: 0, chat: null });
  // 右上角「+」的小弹窗（联系人 / 添加好友）
  const [plusMenuVisible, setPlusMenuVisible] = useState(false);

  // 列表入场动画（原 subTabSlideAnim 保留，避免视觉回退）
  // ⚠️ 必须用 useState 惰性初始化：useRef(...).current 在渲染期读取 ref，违反 react-hooks/refs
  //
  // ⚠️ 只在「首次进入本 tab」时播放一次，**不能**放在 useFocusEffect 里。
  //    原因：useFocusEffect 在每次页面重新获得焦点时都会执行 —— 包括从二级
  //    聊天页 router.back() 返回时。旧实现每次返回都会：
  //      1) setValue(80) 把列表瞬间推到下方 80px（向下跳）
  //      2) 弹簧回弹到 0，friction=7 / tension=60 是欠阻尼参数，会过冲再回来
  //    视觉上就是「先向下弹簧、再向上弹簧」的抖动。
  //    改用 useEffect（仅挂载时执行一次），返回时列表保持原位不动。
  const [listSlideAnim] = useState(() => new Animated.Value(80));
  const hasPlayedEntryAnimRef = useRef(false);

  useEffect(() => {
    if (hasPlayedEntryAnimRef.current) return;
    hasPlayedEntryAnimRef.current = true;
    Animated.spring(listSlideAnim, {
      toValue: 0,
      friction: 7,
      tension: 60,
      useNativeDriver: true,
    }).start();
  }, [listSlideAnim]);

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

  // ===== 长按菜单的 4 个动作 =====
  // 标为已读：把该会话里「对方发给我且未读」的消息标记为已读
  const handleMarkRead = async (chat) => {
    if (!chat || !user) return;
    haptic.success();
    setReadIds((prev) => (prev.includes(chat.id) ? prev : [...prev, chat.id]));
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('user_id', chat.id)
      .eq('receiver_id', user.id)
      .eq('is_read', false);
    refresh();
  };

  // 置顶该聊天：持久化到 AsyncStorage，列表排序时优先展示 + 背景加深
  const handleTogglePin = (chat) => {
    if (!chat) return;
    haptic.medium();
    prefs.togglePin(chat.id);
  };

  // 不显示该聊天：仅从列表隐藏，不删除任何消息
  // ⚠️ 恢复机制：对方发来消息或我发出消息时，会自动 unhide（见下方 effect）
  const handleHideChat = (chat) => {
    if (!chat) return;
    haptic.medium();
    // 先记录「隐藏那一刻的最新消息时间戳」作为基线，
    // 否则 effect 无法区分「历史消息」与「真正的新消息」。
    markHiddenBaseline(chat.id);
    prefs.hide(chat.id);
  };

  // 删除该聊天：仅删「我方」聊天记录 + 从列表移除窗口
  //
  // ⚠️ 语义（重要，勿改）：
  //    「删除该聊天」= **单边删除**。只让我自己看不到这段历史，
  //    对方手机上的聊天记录、会话窗口、好友关系全部不受影响。
  //    好友关系始终保留，之后可从「联系人」点开重新发起聊天。
  //
  // ⚠️ 历史教训：
  //    迁移 18 的 delete_conversation 是物理双向 DELETE，
  //    导致「我删了 → 对方也没了」，这是错误的产品语义。
  //    迁移 19 已改为软删除：只把 auth.uid() 追加进 messages.deleted_by，
  //    物理行保留，对方照常可见。
  //
  // ✅ 当前实现：
  //    1. RPC delete_conversation → 软删除（仅标记我方已删）
  //    2. 清理本地聊天记录缓存与已删除 ID 列表
  //    3. prefs.clearChat → 移除列表窗口（与「不显示该聊天」同款效果）
  const handleDeleteChat = (chat) => {
    if (!chat) return;
    haptic.warning();
    Alert.alert(
      '删除该聊天',
      `确定要删除与「${getDisplayName(chat)}」的聊天记录吗？\n\n仅从你的设备上删除，对方仍可看到这些消息。好友关系保留，之后可从「联系人」重新发起聊天。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            if (!user?.id) return;
            try {
              const { error: msgErr } = await supabase.rpc('delete_conversation', {
                p_partner_id: chat.id,
              });
              if (msgErr) throw msgErr;

              // 本地缓存清理：聊天记录缓存 + 已删除 ID 列表
              await AsyncStorage.multiRemove([
                `@chatMessages_${user.id}_${chat.id}`,
                `@deletedMsgIds_${user.id}_${chat.id}`,
              ]);
              // 从列表移除窗口（与「不显示该聊天」同款效果：清掉隐藏/置顶标记）
              prefs.clearChat(chat.id);
              if (isTablet && selectedChat?.id === chat.id) setSelectedChat(null);

              haptic.success();
              refresh();
              Alert.alert('已删除', '聊天记录已从你的设备删除，对方不受影响。');
            } catch (e) {
              haptic.error();
              Alert.alert('删除失败', e?.message || '请稍后重试。');
            }
          },
        },
      ]
    );
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

  // 关闭会话长按菜单
  //
  // ⚠️ 只把 visible 置 false，**绝不重置 top / left / chat**。
  //    原因：iOS 的 <Modal animationType="fade"> 在 visible 变 false 后
  //    并不会立刻卸载，而是继续播放约 300ms 的淡出动画。
  //    旧实现同时把 top/left 重置为 0，导致淡出期间菜单卡片被重新布局到
  //    屏幕左上角 —— 视觉上就是「点按钮后弹窗闪一下跑到左上角」。
  //    保留原坐标，淡出动画就会在原地完成，不再跳动。
  const closeActionMenu = () => setMenuConfig((prev) => ({ ...prev, visible: false }));

  // 隐藏恢复机制：只有该会话「产生了新消息」时才取消隐藏
  //
  // ⚠️ 旧实现用 `if (latestMessages[id]) prefs.unhide(id)` 判断，存在致命缺陷：
  //    latestMessages 是 useChatList 每次 fetchAll() 都重新构造的新对象，
  //    即使内容完全没变，对象引用也会变化 → effect 重跑 → 只要该会话历史上
  //    有过任何消息（几乎必然），就会立刻被 unhide。
  //    结果：「不显示该聊天」刚点完就被撤销，看起来完全没生效。
  //
  // ✅ 新实现：记录「隐藏那一刻该会话的最新消息时间戳」作为基线，
  //    只有 lastMsgTimes[id] 严格大于基线（即真的来了新消息）才恢复显示。
  const hiddenBaselineRef = useRef({});

  // 隐藏时写入基线（在 handleHideChat 中调用）
  const markHiddenBaseline = useCallback(
    (id) => {
      hiddenBaselineRef.current[id] = lastMsgTimes[id] || 0;
    },
    [lastMsgTimes]
  );

  useEffect(() => {
    if (!prefs.loaded || prefs.hidden.length === 0) return;
    prefs.hidden.forEach((id) => {
      const baseline = hiddenBaselineRef.current[id];
      const current = lastMsgTimes[id] || 0;
      // 基线缺失（例如冷启动后仍是隐藏态）→ 用当前时间戳补齐，不触发恢复
      if (baseline === undefined) {
        hiddenBaselineRef.current[id] = current;
        return;
      }
      // 只有「时间戳前进」才算真的来了新消息
      if (current > baseline) {
        delete hiddenBaselineRef.current[id];
        prefs.unhide(id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMsgTimes, prefs.loaded, prefs.hidden]);

  // 过滤「不显示」的会话，并把「置顶」的会话排到最前（保持原有相对顺序）
  const visibleConversations = useMemo(() => {
    const list = conversations.filter((c) => c && !prefs.hidden.includes(c.id));
    if (prefs.pinned.length === 0) return list;
    const pinned = list.filter((c) => prefs.pinned.includes(c.id));
    const rest = list.filter((c) => !prefs.pinned.includes(c.id));
    return [...pinned, ...rest];
  }, [conversations, prefs.hidden, prefs.pinned]);

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
      {visibleConversations.length === 0 ? (
        <View style={styles.centerBox}>
          <Ionicons name="chatbubbles-outline" size={64} color={palette.separator} />
          <Text style={[styles.emptyText, { color: palette.textSecondary }]}>暂无聊天会话</Text>
        </View>
      ) : (
        visibleConversations.map((item) => {
          if (!item) return null;
          // 「标为已读」后本地立即清零未读角标，无需等实时推送
          const unreadNum = readIds.includes(item.id) ? 0 : unreadCounts[item.id] || 0;
          return (
            <ConversationRow
              key={item.id}
              item={item}
              displayName={getDisplayName(item)}
              previewText={latestMessages[item.id] || '点击进入会话...'}
              unreadNum={unreadNum}
              isMuted={!!friendsMap[item.id]?.is_muted || prefs.isMuted(item.id)}
              isPinned={prefs.isPinned(item.id)}
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
          位置跟随手指（出现在手指下方，越界自动翻转） */}
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
                // 先取快照再关闭：closeActionMenu 不再清空 chat，
                // 但显式传参可彻底摆脱对状态更新时序的依赖。
                const chat = menuConfig.chat;
                closeActionMenu();
                if (chat) handleMarkRead(chat);
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
                const chat = menuConfig.chat;
                closeActionMenu();
                if (chat) handleTogglePin(chat);
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel="置顶该聊天"
            >
              <Text style={[styles.contextMenuText, { color: palette.textPrimary }]}>
                {menuConfig.chat && prefs.isPinned(menuConfig.chat.id) ? '取消置顶' : '置顶该聊天'}
              </Text>
            </TouchableOpacity>

            <View style={[styles.plusMenuLine, { backgroundColor: palette.separator }]} />

            <TouchableOpacity
              style={styles.contextMenuItem}
              onPress={() => {
                const chat = menuConfig.chat;
                closeActionMenu();
                if (chat) handleHideChat(chat);
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
                const chat = menuConfig.chat;
                closeActionMenu();
                if (chat) handleDeleteChat(chat);
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

      {/* 右上角「+」小弹窗：联系人 / 添加好友
          ⚠️ animationType 用 "none"：iOS 上 Modal 的 fade 关闭动画约 300ms，
             若与 router.push 的页面过渡同时进行，两者会互相阻塞，
             表现为「点了按钮要等一下才跳转」。
             去掉 Modal 动画后，导航可立即开始，跳转明显更快。 */}
      <Modal
        visible={plusMenuVisible}
        transparent
        animationType="none"
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
                // 先导航再关菜单：让页面过渡立即开始，不被 Modal 关闭流程拖慢
                haptic.light();
                router.push('/chat/contacts');
                setPlusMenuVisible(false);
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
                // 先导航再关菜单：让页面过渡立即开始，不被 Modal 关闭流程拖慢
                haptic.light();
                router.push('/chat/search');
                setPlusMenuVisible(false);
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
