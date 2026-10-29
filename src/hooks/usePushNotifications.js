// --- START OF FILE src/hooks/usePushNotifications.js ---
import { useEffect, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { supabase } from '../services/supabase';
import { useAuth } from './useAuth';

// 🍎 核心修复：使用最新的 shouldShowBanner 替代被废弃的 shouldShowAlert
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, 
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function usePushNotifications() {
  const { user } = useAuth();
  const router = useRouter();
  console.log('🔴 推送雷达正在运行，当前用户状态:', user ? '已登录' : '未登录');
  const notificationListener = useRef();
  const responseListener = useRef();

  useEffect(() => {
    if (user) {
      console.log('开始获取 Push Token...');
      registerForPushNotificationsAsync()
        .then(async (token) => {
          if (token) {
            console.log('✅ 成功拿到 Token:', token);
            // 尝试存入 Supabase 并捕获错误
            const { error } = await supabase.from('profiles').update({ expo_push_token: token }).eq('id', user.id);
            if (error) {
              Alert.alert('数据库报错', '存入Token失败: ' + error.message);
            } else {
              console.log('✅ Token 已成功保存到数据库！');
            }
          } else {
            console.log('❌ 获取到的 Token 是空的');
          }
        })
        .catch(err => {
          Alert.alert('获取Token崩溃', err.message);
        });
    }

    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      console.log('收到前台通知');
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      if (data?.type === 'chat' && data?.targetId) {
        router.push({
          pathname: '/chat_room',
          params: { targetId: data.targetId, targetName: data.targetName || '聊天' }
        });
      }
    });

    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [user]);
}

async function registerForPushNotificationsAsync() {
  let token;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      Alert.alert('警告', '用户拒绝了通知权限，无法推送');
      return null;
    }

    const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
    if (!projectId) {
      Alert.alert('配置错误', '找不到 Project ID，请检查 app.json');
      return null;
    }

    try {
      token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch (e) {
      Alert.alert('FCM 引擎报错', '底层报错信息: ' + e.message);
      console.log('FCM 引擎报错:', e);
    }
  } else {
    Alert.alert('提示', '模拟器无法获取推送 Token');
  }
  return token;
}
// --- END OF FILE src/hooks/usePushNotifications.js ---