// 文件：src/components/CustomTabBar.js
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme, Platform, Keyboard, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router'; // 👈 增加路由 Hook 用于保底跳转

import { getPalette } from '../constants/colors';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';

export default function CustomTabBar({ state, descriptors, navigation }) {
  const isDark = useColorScheme() === 'dark';
  const palette = getPalette(isDark);
  const slideAnim = useRef(new Animated.Value(0)).current;
  const { user } = useAuth();
  const router = useRouter(); // 👈 初始化 router
  
  // 🍎 全局未读消息数量状态
  const [unreadCount, setUnreadCount] = useState(0);

  const currentRouteName = state.routes[state.index].name;
  const isChatTab = currentRouteName === 'chat';

  // 🍎 全局雷达：自动获取未读数量，并实时监听新消息！
  useEffect(() => {
    if (!user) return;

    const fetchUnread = async () => {
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('receiver_id', user.id)
        .eq('is_read', false);
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

  useEffect(() => {
    if (isChatTab) setUnreadCount(0);
  }, [isChatTab]);

  useEffect(() => {
    Animated.spring(slideAnim, { 
      toValue: isChatTab ? 250 : 0,  
      friction: 7, 
      tension: 50, 
      useNativeDriver: true 
    }).start();
  }, [state.index, isChatTab, slideAnim]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    
    const keyboardShowListener = Keyboard.addListener(showEvent, (e) => {
      Animated.timing(slideAnim, { toValue: 250, duration: e?.duration || 200, useNativeDriver: true }).start();
    });
    
    const keyboardHideListener = Keyboard.addListener(hideEvent, () => {
      if (!isChatTab) {
        Animated.spring(slideAnim, { toValue: 0, friction: 7, tension: 50, useNativeDriver: true }).start();
      }
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
                  // 如果点的是“今日”，强制跳转到 '/'，其他页面跳转到对应的名字
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
                case 'index': iconName = isFocused ? 'today' : 'today-outline'; break;
                case 'space': iconName = isFocused ? 'planet' : 'planet-outline'; break;
                case 'profile': iconName = isFocused ? 'person' : 'person-outline'; break;
                default: iconName = 'ellipse';
              }
              return (
                <Pressable key={route.key} onPress={onPress} style={({ pressed }) => [styles.tabItem, { opacity: pressed ? 0.4 : 1 }]}>
                  <View style={styles.iconContainer}>
                    <Ionicons name={iconName} size={24} color={isFocused ? palette.primary : palette.textSecondary} />
                    {route.name === 'chat' && unreadCount > 0 && (
                      <View style={[styles.badge, { borderColor: Platform.OS === 'ios' ? (isDark ? '#1C1C1E' : '#FFF') : palette.dockBackground }]}>
                        <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
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