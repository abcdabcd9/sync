// 文件：src/components/CustomTabBar.js
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, Keyboard, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router'; // 👈 增加路由 Hook 用于保底跳转

import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';

export default function CustomTabBar({ state, descriptors, navigation }) {
  const { isDark, colors: palette } = useAppTheme();
  // ⚠️ useState 惰性初始化：useRef(...).current 在渲染期读取 ref，违反 react-hooks/refs
  const [slideAnim] = useState(() => new Animated.Value(0));
  const { user } = useAuth();
  const router = useRouter(); // 👈 初始化 router

  // 🍎 全局未读消息数量状态
  const [unreadCount, setUnreadCount] = useState(0);

  const currentRouteName = state.routes[state.index].name;
  const isChatTab = currentRouteName === 'chat';

  // 进入聊天 tab 时角标归零。
  // ⚠️ 不在 effect 里同步 setState（react-hooks/set-state-in-effect），
  //    改为派生值：聊天 tab 下角标恒为 0，其余 tab 显示真实未读数。
  const displayUnread = isChatTab ? 0 : unreadCount;

  // 🍎 全局雷达：自动获取未读数量，并实时监听新消息！
  useEffect(() => {
    if (!user) return;

    const fetchUnread = async () => {
      // ⚠️ 软删除过滤：deleted_by 包含当前用户的消息不计入未读角标。
      //    否则「删除该聊天」后，对方发来的旧未读消息仍会让底栏显示红点，
      //    但点进会话却看不到任何消息（因为 useChatMessages 已过滤）。
      //    与 useChatMessages / useChatList 的过滤条件保持一致（单边删除语义）。
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('receiver_id', user.id)
        .eq('is_read', false)
        .not('deleted_by', 'cs', `{${user.id}}`);
      if (count !== null) setUnreadCount(count);
    };
    fetchUnread();

    const channel = supabase.channel('global_unread_radar')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${user.id}` }, (payload) => {
        if (!isChatTab) {
          setUnreadCount(prev => prev + 1);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); 
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, isChatTab]);

  // 底栏在所有 tab 常驻显示。
  // 旧逻辑在聊天 tab 把底栏下移 250px 隐藏（因为当时聊天页自带浮动 Dock），
  // 阶段 4 已移除聊天页 Dock，底栏必须常驻，否则用户无法切回其他 tab。
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      friction: 7,
      tension: 50,
      useNativeDriver: true,
    }).start();
  }, [state.index, slideAnim]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    
    const keyboardShowListener = Keyboard.addListener(showEvent, (e) => {
      Animated.timing(slideAnim, { toValue: 250, duration: e?.duration || 200, useNativeDriver: true }).start();
    });
    
    const keyboardHideListener = Keyboard.addListener(hideEvent, () => {
      Animated.spring(slideAnim, { toValue: 0, friction: 7, tension: 50, useNativeDriver: true }).start();
    });

    return () => { keyboardShowListener?.remove(); keyboardHideListener?.remove(); };
  }, [slideAnim, isChatTab]);

  const TabContainer = Platform.OS === 'ios' ? BlurView : View;
  const tabContainerProps = Platform.OS === 'ios' 
    ? { tint: isDark ? 'dark' : 'light', intensity: 100, style: styles.blurView } 
    : { style: [styles.blurView, { backgroundColor: isDark ? 'rgba(28,28,30,0.95)' : 'rgba(250,250,250,0.95)' }] };

  return (
    <Animated.View style={[styles.dockPositioner, { transform: [{ translateY: slideAnim }] }]}>
      <View style={[styles.shadowLayer, { shadowColor: palette.dockShadow }, Platform.OS === 'android' && styles.androidNoShadow]}>
        <View style={[styles.glassClipping, { borderColor: palette.dockBorder, backgroundColor: Platform.OS === 'android' ? palette.dockBackground : 'transparent' }]}>
          
          <TabContainer {...tabContainerProps}>
            {state.routes.map((route, index) => {
              const { options } = descriptors[route.key];
              const isFocused = state.index === index;
              
              // 👇 核心修复：使用了可选链操作符，并增加了 router 保底机制
              const onPress = () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                const event = navigation?.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!isFocused && (!event || !event.defaultPrevented)) {
                  // 如果点的是“首页”，强制跳转到 '/'，其他页面跳转到对应的名字
                  if (route.name === 'index') {
                    router.navigate('/');
                  } else {
                    router.navigate(`/${route.name}`);
                  }
                }
              };

              let iconName;
              switch (route.name) {
                case 'chat': iconName = isFocused ? 'chatbubble-ellipses' : 'chatbubble-ellipses-outline'; break;
                case 'index': iconName = isFocused ? 'home' : 'home-outline'; break;
                case 'space': iconName = isFocused ? 'planet' : 'planet-outline'; break;
                case 'profile': iconName = isFocused ? 'person' : 'person-outline'; break;
                default: iconName = 'ellipse';
              }
              return (
                <Pressable key={route.key} onPress={onPress} style={({ pressed }) => [styles.tabItem, { opacity: pressed ? 0.4 : 1 }]}>
                  <View style={styles.iconContainer}>
                    <Ionicons name={iconName} size={24} color={isFocused ? palette.primary : palette.textSecondary} />
                    {route.name === 'chat' && displayUnread > 0 && (
                      <View style={[styles.badge, { borderColor: Platform.OS === 'ios' ? (isDark ? '#1C1C1E' : '#FFF') : palette.dockBackground }]}>
                        <Text style={styles.badgeText}>{displayUnread > 99 ? '99+' : displayUnread}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.tabText, { color: isFocused ? palette.primary : palette.textSecondary }]}>{options.title}</Text>
                </Pressable>
              );
            })}
          </TabContainer>

        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dockPositioner: { position: 'absolute', bottom: Platform.OS === 'ios' ? 34 : 24, left: 32, right: 32, height: 64 },
  shadowLayer: { flex: 1, borderRadius: 32, shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.15, shadowRadius: 24 },
  androidNoShadow: { elevation: 0 },
  glassClipping: { flex: 1, borderRadius: 32, overflow: 'hidden', borderWidth: 1.5 },
  blurView: { flex: 1, flexDirection: 'row' },
  tabItem: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 4 },
  iconContainer: { position: 'relative' },
  tabText: { fontSize: 10, fontWeight: '600', marginTop: 4 },
  badge: {
    position: 'absolute', top: -4, right: -10, backgroundColor: '#FF3B30',
    minWidth: 16, height: 16, borderRadius: 8, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1.5, paddingHorizontal: 4
  },
  badgeText: { color: '#FFF', fontSize: 9, fontWeight: 'bold' }
});