// --- START OF FILE src/hooks/usePushNotifications.ts ---
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
// SDK 58：AndroidImportance 是独立导出的枚举，不在 Notifications 命名空间下
import { AndroidImportance } from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { supabase } from '../services/supabase';
import { useAuth } from './useAuth';

// 🍎 前台通知展示（P3-24 修复）
// 说明：SDK 58 中 shouldShowAlert 已废弃，由 shouldShowBanner + shouldShowList 取代。
//   旧实现两者均为 false，导致应用在前台时通知被完全抑制 —— 用户停留在非聊天页面
//   （如首页、健康、空间）时收不到任何横幅提示，容易错过消息。
//   现在开启前台横幅 + 通知中心条目，保证前台也能及时感知新消息。
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** 通知 data 载荷（云函数写入，字段可能缺失） */
interface PushNotificationData {
  type?: string;
  targetId?: string;
  targetName?: string;
}

export function usePushNotifications(): void {
  // ⚠️ 与迁移前 JS 严格一致：旧实现直接解构 useAuth() 的返回值。
  //    useAuth() 的静态类型为 `AuthContextValue | undefined`（Provider 之外为 undefined），
  //    这里用非空断言保持与旧实现相同的运行时行为（不新增任何守卫分支）。
  const { user } = useAuth()!;
  const router = useRouter();

  const notificationListener = useRef<{ remove: () => void } | undefined>(undefined);
  const responseListener = useRef<{ remove: () => void } | undefined>(undefined);
  // 🛡️ 防止同一用户重复注册 Token（StrictMode 双调用 / 重复挂载）
  const registeredUserIdRef = useRef<string | null>(null);

  // 用 userId 字符串作为依赖，避免 user 对象引用变化引发无谓重跑
  const userId = user?.id ?? null;

  useEffect(() => {
    // 1️⃣ Token 注册：每个用户只执行一次
    if (userId && registeredUserIdRef.current !== userId) {
      // ⚠️ 注意：标记必须在「注册成功」之后才写入。
      //    旧实现在发起注册前就置位，一旦本次注册失败（如 Android 缺 FCM 配置、
      //    权限被拒、网络异常），同一用户在本进程内永远不会重试 —— 表现为
      //    「重新登录后 Token 依然为空」。现在改为成功后置位，失败则允许下次重试。
      registerForPushNotificationsAsync()
        .then(async (token) => {
          // 🛡️ 严格非空校验：只有拿到「有效非空字符串」才写库。
          //    模拟器 / 权限被拒 / 缺 projectId / 获取失败时，上游一律返回 null，
          //    此处必须短路，绝不能用 null 覆盖云端已有的有效 Token
          //    （否则真机上已注册的推送会被模拟器登录清空，导致收不到消息）。
          //    额外覆盖 ''、'   '、非字符串等边界值。
          if (!token || typeof token !== 'string' || token.trim() === '') {
            console.log('[Push] 检测到 Token 为空（如模拟器环境），跳过 Supabase Token 更新，保留现有 Token');
            return;
          }
          const { error } = await supabase!
            .from('profiles')
            .update({ expo_push_token: token })
            .eq('id', userId);
          if (error) {
            console.warn('⚠️ Push Token 写入失败:', error.message);
            return;
          }
          // ✅ 仅在「Token 已成功落库」后才标记该用户已完成注册
          registeredUserIdRef.current = userId;
        })
        .catch((err) => {
          console.warn('⚠️ 获取 Push Token 失败:', (err as { message?: string } | null | undefined)?.message ?? err);
        });
    }

    // 2️⃣ 前台通知监听
    notificationListener.current = Notifications.addNotificationReceivedListener(() => {
      // 前台收到通知时系统已按 handler 展示，无需额外处理
    });

    // 3️⃣ 点击通知跳转
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as PushNotificationData | null | undefined;
      if (data?.type === 'chat' && data?.targetId) {
        // 🔑 targetName 由云函数权威写入（真实昵称）；缺失时留空，
        //    交给 chat_room.js 按 targetId 反查 profiles 自我修复，绝不传「聊天」或数字
        const name = typeof data.targetName === 'string' ? data.targetName.trim() : '';
        router.push({
          pathname: '/chat_room',
          params: { targetId: data.targetId, targetName: name },
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

async function registerForPushNotificationsAsync(): Promise<string | null> {
  let token: string | undefined;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: AndroidImportance.MAX,
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
    const res = await Notifications.getExpoPushTokenAsync({ projectId });
    token = res.data;
  } catch (e) {
    console.warn('⚠️ 获取 Expo Push Token 失败:', (e as { message?: string } | null | undefined)?.message ?? e);
    return null;
  }

  // ⚠️ 与迁移前 JS 严格一致：直接返回 token（可能为 undefined）。
  //    返回类型仍声明为 Promise<string | null>，由调用方按 falsy 处理。
  return token as string;
}
// --- END OF FILE src/hooks/usePushNotifications.ts ---
