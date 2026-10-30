// --- START OF FILE src/app/_layout.js ---
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { HealthProvider, useHealthData } from '../hooks/useHealthData';
import { CinemaProvider } from '../hooks/useCinema';
import { AuthProvider, useAuth } from '../hooks/useAuth';
import { ThemeProvider, useAppTheme } from '../context/ThemeContext';
import FloatingPlayer from '../components/FloatingPlayer';
import { usePushNotifications } from '../hooks/usePushNotifications';

// 🔒 安全审计 #10：无需登录即可访问的公开路由白名单
const PUBLIC_ROUTES = new Set(['auth']);

function RootNavigation() {
  const { isInitialized } = useHealthData();
  // 🎨 统一主题控制权：跟随系统 / 强制浅色 / 强制深色
  const { colors: palette } = useAppTheme();

  // 🔒 安全审计 #10：全局登录态守卫
  const { user, isAuthLoading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  usePushNotifications();

  const currentRoute = segments[0];
  const isPublicRoute = PUBLIC_ROUTES.has(currentRoute);

  useEffect(() => {
    // 会话恢复中或健康数据初始化中，暂不做任何跳转，避免误拦截
    if (isAuthLoading || !isInitialized) return;

    if (!user && !isPublicRoute) {
      // 未登录访问私密页面（/chat_room、/account_info、/bind_partner 等）→ 强制拦截
      router.replace('/auth');
    } else if (user && isPublicRoute) {
      // 已登录仍停留在登录页 → 送回主界面，避免重复登录
      router.replace('/');
    }
  }, [user, isAuthLoading, isInitialized, isPublicRoute, router]);

  if (!isInitialized) return <View style={{ flex: 1, backgroundColor: palette.background }} />;

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <Stack screenOptions={{ headerShown: false, gestureEnabled: true, gestureDirection: 'horizontal', contentStyle: { backgroundColor: 'transparent' } }}>
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="auth" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        {/* settings 及其子路由（settings/notifications 等）统一走 Stack 默认动画，保证一级/二级跳转观感一致 */}
        <Stack.Screen name="settings" />
        <Stack.Screen name="browser" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="cinema" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
      <FloatingPlayer />
    </View>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <HealthProvider>
          <CinemaProvider>
            <RootNavigation />
          </CinemaProvider>
        </HealthProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
// --- END OF FILE src/app/_layout.js ---
