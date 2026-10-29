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

  const notificationListener = useRef();
  const responseListener = useRef();
  // 🛡️ 防止同一用户重复注册 Token（StrictMode 双调用 / 重复挂载）
  const registeredUserIdRef = useRef(null);

  // 用 userId 字符串作为依赖，避免 user 对象引用变化引发无谓重跑
  const userId = user?.id ?? null;

  useEffect(() => {
    // 1️⃣ Token 注册：每个用户只执行一次
    if (userId && registeredUserIdRef.current !== userId) {
      registeredUserIdRef.current = userId;

      registerForPushNotificationsAsync()
        .then(async (token) => {
          if (!token) return;
          const { error } = await supabase
            .from('profiles')
            .update({ expo_push_token: token })
            .eq('id', userId);
          if (error) {
            console.warn('⚠️ Push Token 写入失败:', error.message);
          }
        })
        .catch((err) => {
          console.warn('⚠️ 获取 Push Token 失败:', err?.message ?? err);
        });
    }

    // 2️⃣ 前台通知监听
    notificationListener.current = Notifications.addNotificationReceivedListener(() => {
      // 前台收到通知时系统已按 handler 展示，无需额外处理
    });

    // 3️⃣ 点击通知跳转
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (data?.type === 'chat' && data?.targetId) {
        router.push({
          pathname: '/chat_room',
          params: { targetId: data.targetId, targetName: data.targetName || '聊天' },
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
  }, [userId, router]);
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

  if (!Device.isDevice) {
    // 模拟器无法获取真实 Token，静默跳过（不弹窗打扰开发）
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    // 用户拒绝权限属正常选择，不弹窗
    return null;
  }

  const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
  if (!projectId) {
    console.warn('⚠️ 找不到 EAS Project ID，请检查 app.json');
    return null;
  }

  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (e) {
    console.warn('⚠️ 获取 Expo Push Token 失败:', e?.message ?? e);
  }

  return token;
}
// --- END OF FILE src/hooks/usePushNotifications.js ---
