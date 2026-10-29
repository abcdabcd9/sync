// --- START OF FILE src/app/(tabs)/chat.js ---
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  View, Text, StyleSheet, TouchableOpacity, TextInput, Keyboard,
  Alert, ActivityIndicator, ScrollView, Platform, Modal, Pressable, Dimensions, 
  Animated, useWindowDimensions, PanResponder 
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import ChatRoomInner from '../../components/ChatRoomInner'; 

// 🍎 将数据库里的密语翻译成人类可读的预览文本（按 subtype 协议字段判断）
const formatPreview = (msg) => {
  if (!msg) return '点击进入会话...';
  if (msg.type === 'image') return '[图片]';
  if (msg.type === 'video') return '[视频]';
  if (msg.type === 'audio') return '[语音]';
  if (msg.type === 'cinema_invite') return '[邀请同步观影]';
  if (msg.subtype === 'SYNC_CINEMA_ENDED') return '[本次同步放映已结束]';
  if (msg.subtype === 'SYNC_PARTNER_INVITE') return '[健康搭子邀请]';
  if (msg.subtype === 'SYNC_PARTNER_ACCEPTED') return '你们已成为健康搭子！';
  if (msg.subtype === 'SYNC_PARTNER_REJECTED') return '已拒绝健康搭子邀请';
  if (msg.subtype === 'SYNC_PARTNER_UNBOUND') return '已解除健康守护伴侣关系';
  if (msg.subtype === 'SYNC_SYSTEM') return msg.text || '暂无新消息';
  return msg.text || '暂无新消息';
};

export default function ChatMainScreen() {
  const { isDark, colors: palette } = useAppTheme();
  
  const router = useRouter();
  const { user, isAuthLoading } = useAuth();
  
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const [activeTab, setActiveTab] = useState('messages');
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]); 
  const [unreadCounts, setUnreadCounts] = useState({}); 
  const [friendsMap, setFriendsMap] = useState({}); 

  // 🍎 新增：用于存储每条会话的“最新消息内容”和“最新时间”
  const [latestMessages, setLatestMessages] = useState({});
  const [lastMsgTimes, setLastMsgTimes] = useState({});

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selectedChat, setSelectedChat] = useState(null);

  const [menuConfig, setMenuConfig] = useState({ visible: false, top: 0, chat: null });
  const subTabSlideAnim = useRef(new Animated.Value(100)).current;

  const edgeSwipeResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        const { pageX } = evt.nativeEvent;
        if (
          Platform.OS === 'ios' && 
          pageX < 40 && 
          gestureState.dx > 10 && 
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy)
        ) {
          return true;
        }
        return false;
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (gestureState.dx > 50 || gestureState.vx > 0.5) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.navigate('/'); 
        }
      },
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  useFocusEffect(
    useCallback(() => {
      subTabSlideAnim.setValue(80); 
      Animated.spring(subTabSlideAnim, { toValue: 0, friction: 7, tension: 60, useNativeDriver: true }).start();
    }, [subTabSlideAnim])
  );

  const fetchFriendsAndData = async () => {
    if (!user) return;
    try {
      let allFriendIds = new Set();
      const fMap = {};
      const { data: fData } = await supabase.from('friends').select('*').or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
      if (fData) {
        fData.forEach(r => {
          const fid = r.user_id === user.id ? r.friend_id : r.user_id;
          allFriendIds.add(fid);
          if (r.user_id === user.id) { fMap[fid] = r; }
        });
      }

      const { data: reqData } = await supabase.from('friend_requests').select('*').or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);
      let pendingReceived = [];
      let pendingSent = [];

      if (reqData) {
        reqData.forEach(r => {
          if (r.status === 'accepted') {
            allFriendIds.add(r.sender_id === user.id ? r.receiver_id : r.sender_id);
          } else if (r.status === 'pending') {
            if (r.receiver_id === user.id) pendingReceived.push(r);
            if (r.sender_id === user.id) pendingSent.push(r);
          }
        });
      }

      const uniqueFriendIds = [...allFriendIds];
      if (uniqueFriendIds.length > 0) {
        const { data: profilesData } = await supabase.from('profiles').select('id, username, nickname, sync_id').in('id', uniqueFriendIds);
        setFriends(profilesData || []);
        setFriendsMap(fMap);
      } else { setFriends([]); }

      if (pendingReceived.length > 0) {
        const senderIds = pendingReceived.map(r => r.sender_id);
        const { data: pData } = await supabase.from('profiles').select('id, username, nickname').in('id', senderIds);
        setRequests(pendingReceived.map(req => ({ ...req, sender_profile: pData?.find(p => p.id === req.sender_id) })));
      } else { setRequests([]); }

      // 获取未读数量
      const { data: unreadData } = await supabase.from('messages').select('user_id').eq('receiver_id', user.id).eq('is_read', false);
      if (unreadData) {
        const counts = {};
        unreadData.forEach(msg => { counts[msg.user_id] = (counts[msg.user_id] || 0) + 1; });
        setUnreadCounts(counts);
      }

      // 🍎 新增：批量抓取所有人最近的消息，用来渲染真正的预览内容
      const { data: recentMsgs } = await supabase
        .from('messages')
        .select('*')
        .or(`user_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(200);
        
      const latestMap = {};
      const timeMap = {};
      if (recentMsgs) {
        recentMsgs.forEach(msg => {
          const partnerId = msg.user_id === user.id ? msg.receiver_id : msg.user_id;
          if (!latestMap[partnerId]) {
            latestMap[partnerId] = formatPreview(msg);
            timeMap[partnerId] = new Date(msg.created_at).getTime();
          }
        });
      }
      setLatestMessages(latestMap);
      setLastMsgTimes(timeMap);

    } catch (e) {} finally { setLoading(false); }
  };

  useFocusEffect(useCallback(() => { fetchFriendsAndData(); }, [user]));

  // 🍎 新增：全局消息实时监听雷达 (无需刷新，列表自动变化)
  useEffect(() => {
    if (!user) return;
    // ⚠️ 频道名必须唯一：effect 依赖 user 对象引用，重跑时若复用固定名，
    //    supabase.channel() 会返回已 subscribe 的旧实例，再 .on() 会直接抛错。
    const channelName = `chat_list_realtime_${user.id}_${Date.now()}`;
    supabase.getChannels()
      .filter((ch) => ch.topic === `realtime:${channelName}`)
      .forEach((ch) => supabase.removeChannel(ch));

    // ✅ 所有 .on() 必须在 .subscribe() 之前链式完成
    const channel = supabase.channel(channelName)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        if (msg.user_id === user.id || msg.receiver_id === user.id) {
          const partnerId = msg.user_id === user.id ? msg.receiver_id : msg.user_id;
          
          // 更新最新消息和时间，自动触发顶置排序
          setLatestMessages(prev => ({ ...prev, [partnerId]: formatPreview(msg) }));
          setLastMsgTimes(prev => ({ ...prev, [partnerId]: new Date(msg.created_at).getTime() }));
          
          // 如果我是接收方，未读数字加一
          if (msg.receiver_id === user.id) {
            setUnreadCounts(prev => ({ ...prev, [partnerId]: (prev[partnerId] || 0) + 1 }));
          }
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const msg = payload.new;
        // 如果对方撤回了消息，动态预览也会瞬间变成本次的操作
        if (msg.user_id === user.id || msg.receiver_id === user.id) {
          const partnerId = msg.user_id === user.id ? msg.receiver_id : msg.user_id;
          setLatestMessages(prev => ({ ...prev, [partnerId]: formatPreview(msg) }));
        }
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [user]);

  // 🔒 安全审计 #16：搜索防抖节流
  // 用户每敲一个字符都会触发 onChangeText，若直接查询 Supabase 的 sync_id，
  // 会形成高频碰撞查询（可被用于枚举 Sync ID）。这里用 500ms 防抖 + 在途请求去重，
  // 保证同一时间最多只有一个查询，且只在用户停止输入后才真正发起。
  const searchTimerRef = useRef(null);
  const searchInFlightRef = useRef(false);
  const lastQueriedRef = useRef('');

  // 组件卸载时清理定时器，避免内存泄漏与卸载后 setState
  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);

  const handleSearchAdd = async () => {
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

    Keyboard.dismiss(); setIsSearching(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
    if (targetUser.id === user.id) { Alert.alert('提示', '不能添加自己哦'); return; }
    if (friends.find(f => f.id === targetUser.id)) { Alert.alert('提示', '已经是好友了'); return; }

    const targetName = targetUser.nickname || targetUser.username;
    Alert.alert('找到用户', `向 [${targetName}] 发送好友请求？`, [
      { text: '取消', style: 'cancel' },
      { text: '发送请求', onPress: async () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // 🔒 安全审计 #7：sender_id 强制绑定当前登录用户，杜绝伪造发送者
          if (!user?.id) return;
          const { error } = await supabase.from('friend_requests').insert({ sender_id: user.id, receiver_id: targetUser.id });
          if (error && error.code === '23505') Alert.alert('提示', '请求已发送，等待对方通过。');
          else if (error) Alert.alert('发送失败', '好友请求发送失败，请稍后重试。');
          else { Alert.alert('发送成功', '好友请求已发送，等待对方通过。'); setSearchQuery(''); lastQueriedRef.current = ''; fetchFriendsAndData(); }
      }}
    ]);
  };

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

  const handleAcceptRequest = async (request) => {
    // 🔒 安全审计 #6/#7：归属校验，只能处理「发给自己的」好友请求
    if (!user || !request || request.receiver_id !== user.id) return;
    if (!request.sender_id || request.sender_id === user.id) return;

    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await supabase
        .from('friend_requests')
        .update({ status: 'accepted' })
        .eq('id', request.id)
        .eq('receiver_id', user.id);
      // 🔒 安全审计 #7：friends 关系必须包含当前用户自身，禁止代他人建立关系
      await supabase
        .from('friends')
        .insert({ user_id: user.id, friend_id: request.sender_id })
        .select('id');
      fetchFriendsAndData();
    } catch (e) {}
  };

  const handleRejectRequest = async (request) => {
    // 🔒 安全审计 #6：归属校验，只能删除「发给自己的」好友请求
    if (!user || !request || request.receiver_id !== user.id) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await supabase
      .from('friend_requests')
      .delete()
      .eq('id', request.id)
      .eq('receiver_id', user.id);
    fetchFriendsAndData();
  };

  const getDisplayName = (item) => {
    if (!item) return '未知';
    const rel = friendsMap[item.id];
    return rel?.remark || item.nickname || item.username;
  };

  const openChatRoom = (item) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const displayName = getDisplayName(item);
    
    if (isTablet) {
      setSelectedChat({ id: item.id, name: displayName });
    } else {
      router.push({ pathname: '/chat_room', params: { targetId: item.id, targetName: displayName } });
    }
  };

  const openContactProfile = (item) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const rel = friendsMap[item.id];
    router.push({ pathname: '/contact_profile', params: { id: item.id, sync_id: item.sync_id, nickname: item.nickname, username: item.username, remark: rel?.remark || '' } });
  };

  const handleLongPress = (item, evt) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const touchY = evt.nativeEvent.pageY;
    const { height: SCREEN_HEIGHT } = Dimensions.get('window');
    let topPosition = touchY < (SCREEN_HEIGHT / 2) ? touchY : touchY - 180;
    setMenuConfig({ visible: true, top: topPosition, chat: item });
  };

  const closeActionMenu = () => setMenuConfig({ visible: false, top: 0, chat: null });

  const renderMessagesView = () => {
    // 🍎 新增：根据最新消息时间，动态排序好友列表 (新消息自动跑到最前面！)
    const sortedFriends = [...friends].sort((a, b) => {
      const timeA = lastMsgTimes[a.id] || 0;
      const timeB = lastMsgTimes[b.id] || 0;
      return timeB - timeA;
    });

    return (
      <ScrollView contentContainerStyle={{ paddingHorizontal: 0, paddingTop: 8, paddingBottom: 100 }} showsVerticalScrollIndicator={false}>
        {sortedFriends.length === 0 ? (
          <View style={styles.centerBox}>
            <Ionicons name="chatbubbles-outline" size={64} color={palette.separator} />
            <Text style={{ color: palette.textSecondary, marginTop: 16 }}>暂无聊天会话</Text>
          </View>
        ) : (
          sortedFriends.map(item => {
            if (!item) return null;
            const unreadNum = unreadCounts[item.id] || 0; 
            const isMuted = friendsMap[item.id]?.is_muted;
            const displayName = getDisplayName(item);
            const isSelected = isTablet && selectedChat?.id === item.id;
            
            // 获取对应的动态真实预览内容
            const previewText = latestMessages[item.id] || '点击进入会话...';

            return (
              <TouchableOpacity 
                key={item.id} 
                style={[styles.messageItemRow, isSelected && { backgroundColor: isDark ? '#1C1C1E' : '#F2F2F7' }]} 
                onPress={() => openChatRoom(item)} 
                onLongPress={(e) => handleLongPress(item, e)} 
                activeOpacity={0.6}
              >
                <View style={styles.avatarArea}>
                  <View style={[styles.avatar, { backgroundColor: palette.primary }]}>
                    <Text style={styles.avatarText}>{displayName.substring(0, 2).toUpperCase()}</Text>
                    {unreadNum > 0 && !isMuted && <View style={styles.badgeContainer}><Text style={styles.badgeText}>{unreadNum > 99 ? '99+' : unreadNum}</Text></View>}
                    {unreadNum > 0 && isMuted && <View style={styles.mutedBadgeContainer} />}
                  </View>
                </View>
                <View style={[styles.contentArea, { borderBottomColor: isSelected ? 'transparent' : palette.separator }]}>
                  <View style={styles.textContainer}>
                    <Text style={[styles.contactName, { color: palette.textPrimary }]} numberOfLines={1}>{displayName}</Text>
                    
                    {/* 🍎 修复：这里现在绑定了真实的动态预览，如果有未读数，会加前缀 */}
                    <Text style={[styles.contactSub, { color: palette.textSecondary }]} numberOfLines={1}>
                      {unreadNum > 0 ? `[${unreadNum}条] ${previewText}` : previewText}
                    </Text>
                    
                  </View>
                  <View style={styles.rightInfo}>
                    {isMuted && <Ionicons name="notifications-off" size={14} color={palette.textSecondary} />}
                  </View>
                </View>
              </TouchableOpacity>
            )
          })
        )}
      </ScrollView>
    );
  };

  const renderContactsView = () => (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 0, paddingTop: 8, paddingBottom: 100 }} showsVerticalScrollIndicator={false}>
      <View style={[styles.searchContainer, { backgroundColor: palette.card, borderColor: palette.cardBorder, marginBottom: 24, marginHorizontal: 16 }]}>
        <Ionicons name="search" size={20} color={palette.textSecondary} style={{ marginRight: 8 }} />
        <TextInput style={[styles.searchInput, { color: palette.textPrimary }]} placeholder="通过 Sync ID 搜索添加好友" placeholderTextColor={palette.textSecondary} value={searchQuery} onChangeText={handleSearchChange} onSubmitEditing={handleSearchAdd} returnKeyType="search" autoCapitalize="none" autoCorrect={false} maxLength={15} />
        {isSearching && <ActivityIndicator size="small" color={palette.textSecondary} />}
      </View>

      {requests.length > 0 && (
        <View style={{ marginBottom: 24, paddingHorizontal: 16 }}>
          <Text style={[styles.sectionHeader, { color: palette.textSecondary }]}>新朋友请求</Text>
          {requests.map(req => {
             const displayName = req.sender_profile?.nickname || req.sender_profile?.username;
             return (
               <View key={req.id} style={[styles.requestCard, { backgroundColor: palette.card, borderColor: palette.primary }]}>
                 <View style={[styles.avatarRound, { backgroundColor: palette.iconBackground }]}><Text style={styles.avatarTextRound}>{displayName?.substring(0, 2).toUpperCase()}</Text></View>
                 <Text style={[styles.contactNameReq, { color: palette.textPrimary, flex: 1 }]} numberOfLines={1}>{displayName}</Text>
                 <View style={{ flexDirection: 'row', gap: 8 }}>
                   <TouchableOpacity style={[styles.actionBtn, { backgroundColor: palette.separator }]} onPress={() => handleRejectRequest(req)}><Text style={{ color: palette.textPrimary, fontSize: 14, fontWeight: '600' }}>拒绝</Text></TouchableOpacity>
                   <TouchableOpacity style={[styles.actionBtn, { backgroundColor: palette.primary }]} onPress={() => handleAcceptRequest(req)}><Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>同意</Text></TouchableOpacity>
                 </View>
               </View>
             );
          })}
        </View>
      )}

      <Text style={[styles.sectionHeader, { color: palette.textSecondary, marginLeft: 16, marginTop: 8 }]}>所有联系人</Text>
      {friends.length === 0 && <Text style={{ color: palette.textSecondary, textAlign: 'center', marginTop: 20 }}>暂无好友</Text>}
      {friends.map(item => {
        if (!item) return null;
        const displayName = getDisplayName(item);
        return (
          <TouchableOpacity key={item.id} style={styles.contactItemRow} onPress={() => openContactProfile(item)} activeOpacity={0.6}>
            <View style={styles.avatarAreaContact}><View style={[styles.avatarContact, { backgroundColor: palette.iconBackground }]}><Text style={styles.avatarTextContact}>{displayName.substring(0, 2).toUpperCase()}</Text></View></View>
            <View style={[styles.contentAreaContact, { borderBottomColor: palette.separator }]}><View style={styles.textContainer}><Text style={[styles.contactNameList, { color: palette.textPrimary }]} numberOfLines={1}>{displayName}</Text></View></View>
          </TouchableOpacity>
        )
      })}
    </ScrollView>
  );

  if (!isAuthLoading && !user) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: palette.background, justifyContent: 'center', alignItems: 'center' }]} edges={['top']}>
        <Text style={{ color: palette.textPrimary, fontSize: 18, fontWeight: '600' }}>请先登录体验云端通讯</Text>
      </SafeAreaView>
    );
  }
  
  const MasterColumn = (
    <View style={[{ flex: 1 }, isTablet && { width: 350, flex: 'none', borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: palette.separator }]}>
      <View style={[styles.header, { borderBottomColor: palette.chatBorder }]}>
        
        <TouchableOpacity 
          style={styles.headerBackBtn}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.navigate('/'); 
          }}
        >
          <Ionicons name="chevron-back" size={28} color={palette.primary} />
        </TouchableOpacity>

        <Text style={[styles.headerTitle, { color: palette.textPrimary }]}>{activeTab === 'messages' ? '消息' : '通讯录'}</Text>
      </View>
      
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={palette.textSecondary} /></View>
      ) : (
        <View style={{ flex: 1 }}>{activeTab === 'messages' ? renderMessagesView() : renderContactsView()}</View>
      )}

      <Animated.View style={[styles.floatingDockPositioner, { bottom: Platform.OS === 'ios' ? 34 : 24, transform: [{ translateY: subTabSlideAnim }] }]} pointerEvents="box-none">
        <View style={styles.floatingDockShadow} pointerEvents="auto">
          <BlurView tint={isDark ? "dark" : "light"} intensity={90} style={[styles.floatingDockPill, { borderColor: palette.cardBorder }]}>
            <TouchableOpacity style={styles.dockBtn} activeOpacity={0.6} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setActiveTab('messages'); }}>
              <Ionicons name={activeTab === 'messages' ? "chatbubble" : "chatbubble-outline"} size={22} color={activeTab === 'messages' ? palette.primary : palette.textSecondary} />
              <Text style={[styles.dockText, { color: activeTab === 'messages' ? palette.primary : palette.textSecondary }]}>消息</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dockBtn} activeOpacity={0.6} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setActiveTab('contacts'); }}>
              <Ionicons name={activeTab === 'contacts' ? "people" : "people-outline"} size={24} color={activeTab === 'contacts' ? palette.primary : palette.textSecondary} />
              <Text style={[styles.dockText, { color: activeTab === 'contacts' ? palette.primary : palette.textSecondary }]}>联系人</Text>
            </TouchableOpacity>
          </BlurView>
        </View>
      </Animated.View>
    </View>
  );

  return (
    <SafeAreaView 
      style={[styles.container, { backgroundColor: palette.background }]} 
      edges={['top']}
      {...edgeSwipeResponder.panHandlers}
    >
      
      {isTablet ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          {MasterColumn}
          <View style={{ flex: 1, backgroundColor: isDark ? '#000' : '#FFF' }}>
            {selectedChat ? (
              <ChatRoomInner 
                targetId={selectedChat.id} 
                targetName={selectedChat.name} 
                isTabletMode={true} 
              />
            ) : (
              <View style={styles.centerBox}>
                <Ionicons name="chatbubbles-outline" size={80} color={palette.separator} />
                <Text style={{ color: palette.textSecondary, marginTop: 16, fontSize: 18 }}>请在左侧选择一个联系人开始聊天</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        MasterColumn
      )}

      <Modal visible={menuConfig.visible} transparent animationType="none" onRequestClose={closeActionMenu}>
        <Pressable style={styles.invisibleOverlay} onPress={closeActionMenu}>
          <View style={[styles.contextMenuContainer, { backgroundColor: isDark ? '#1C1C1E' : '#F9F9F9', top: menuConfig.top }]}>
            <TouchableOpacity style={styles.contextMenuItem} onPress={() => { closeActionMenu(); alert('已读开发中'); }}><Text style={[styles.contextText, { color: palette.textPrimary }]}>标为已读</Text></TouchableOpacity>
            <View style={[styles.menuLine, { backgroundColor: palette.separator }]} />
            <TouchableOpacity style={styles.contextMenuItem} onPress={() => { closeActionMenu(); alert('置顶开发中'); }}><Text style={[styles.contextText, { color: palette.textPrimary }]}>置顶该聊天</Text></TouchableOpacity>
            <View style={[styles.menuLine, { backgroundColor: palette.separator }]} />
            <TouchableOpacity style={styles.contextMenuItem} onPress={() => { closeActionMenu(); alert('隐藏开发中'); }}><Text style={[styles.contextText, { color: palette.textPrimary }]}>不显示该聊天</Text></TouchableOpacity>
            <View style={[styles.menuLine, { backgroundColor: palette.separator }]} />
            <TouchableOpacity style={styles.contextMenuItem} onPress={() => { closeActionMenu(); alert('删除开发中'); }}><Text style={[styles.contextText, { color: '#FF3B30' }]}>删除该聊天</Text></TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, 
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth }, 
  headerBackBtn: { position: 'absolute', left: 12, padding: 4, zIndex: 10 },
  headerTitle: { fontSize: 17, fontWeight: '600' }, 
  searchContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 42, borderRadius: 8, borderWidth: 1 }, 
  searchInput: { flex: 1, fontSize: 15, height: '100%' }, 
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' }, 
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { fontSize: 13, marginBottom: 8, fontWeight: '500' },
  messageItemRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  avatarArea: { paddingVertical: 12, paddingRight: 14, justifyContent: 'center' },
  avatar: { width: 46, height: 46, borderRadius: 10, justifyContent: 'center', alignItems: 'center', position: 'relative' }, 
  avatarText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' }, 
  contentArea: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 66, borderBottomWidth: StyleSheet.hairlineWidth },
  contactItemRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  avatarAreaContact: { paddingVertical: 10, paddingRight: 14, justifyContent: 'center' },
  avatarContact: { width: 41, height: 41, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }, 
  avatarTextContact: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' }, 
  contentAreaContact: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth },
  contactNameList: { fontSize: 16, fontWeight: '500', flexShrink: 1 },
  // 🔒 安全审计 #18：minWidth: 0 + flexShrink 让超长昵称在 flex 布局中真正被压缩，
  //    配合 numberOfLines={1} 实现弹性截断，防止长文本撑爆布局
  textContainer: { flex: 1, minWidth: 0, justifyContent: 'center' },
  contactName: { fontSize: 16, fontWeight: '500', marginBottom: 4, flexShrink: 1 },
  contactSub: { fontSize: 13, flexShrink: 1 },
  rightInfo: { alignItems: 'flex-end', marginLeft: 8, flexShrink: 0 },
  requestCard: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, marginBottom: 10, borderWidth: 1 },
  actionBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, flexShrink: 0 },
  avatarRound: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 12, flexShrink: 0 },
  avatarTextRound: { color: '#FFFFFF', fontSize: 15, fontWeight: 'bold' },
  contactNameReq: { fontSize: 16, fontWeight: '600', marginBottom: 2, flexShrink: 1, minWidth: 0 },
  badgeContainer: { position: 'absolute', top: -5, right: -5, backgroundColor: '#FF3B30', minWidth: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: '#FFFFFF', paddingHorizontal: 4 },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: 'bold' },
  mutedBadgeContainer: { position: 'absolute', top: -2, right: -2, backgroundColor: '#FF3B30', width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: '#FFFFFF' },
  floatingDockPositioner: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 100 },
  floatingDockShadow: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 16, elevation: 12 },
  floatingDockPill: { flexDirection: 'row', alignItems: 'center', width: 160, height: 48, borderRadius: 24, borderWidth: 1, overflow: 'hidden' },
  dockBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 2 },
  dockText: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  invisibleOverlay: { flex: 1, backgroundColor: 'transparent' }, 
  contextMenuContainer: { position: 'absolute', right: 24, width: 140, borderRadius: 0, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(150,150,150,0.3)', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 10, elevation: 4 },
  contextMenuItem: { paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  contextText: { fontSize: 15, fontWeight: '400', textAlign: 'center' },
  menuLine: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(150,150,150,0.1)' }
});
// --- END OF FILE src/app/(tabs)/chat.js ---