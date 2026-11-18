// --- START OF FILE src/app/_layout.js ---
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { HealthProvider, useHealthData } from '../hooks/useHealthData';
import { CinemaProvider } from '../hooks/useCinema';
import { BrowserSessionProvider } from '../context/BrowserSessionContext';
import { AuthProvider, useAuth } from '../hooks/useAuth';
import { ThemeProvider, useAppTheme } from '../context/ThemeContext';
import FloatingPlayer from '../components/FloatingPlayer';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { isSupabaseConfigured, supabaseConfigErrors } from '../services/supabase';

// 🔒 安全审计 #10：无需登录即可访问的公开路由白名单
const PUBLIC_ROUTES = new Set(['auth']);

function RootNavigation() {
  const { isInitialized } = useHealthData();
  // 🎨 统一主题控制权：跟随系统 / 强制浅色 / 强制深色
  const { colors: palette } = useAppTheme();

  // 🔒 安全审计 #10：全局登录态守卫
  const { user, isAuthLoading, authError, retrySession } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  usePushNotifications();

  const currentRoute = segments[0];
  const isPublicRoute = PUBLIC_ROUTES.has(currentRoute);

  useEffect(() => {
    // 会话恢复中或健康数据初始化中，暂不做任何跳转，避免误拦截
    if (isAuthLoading || !isInitialized) return;
    // 🔒 Batch C：安全存储不可用时不得误判为「已登出」而跳登录页，
    //    由下方 AuthStorageErrorView 接管展示与重试。
    if (authError) return;

    if (!user && !isPublicRoute) {
      // 未登录访问私密页面（/chat_room、/account_info、/bind_partner 等）→ 强制拦截
      router.replace('/auth');
    } else if (user && isPublicRoute) {
      // 已登录仍停留在登录页 → 送回主界面，避免重复登录
      router.replace('/');
    }
  }, [user, isAuthLoading, isInitialized, isPublicRoute, router, authError]);

  if (!isInitialized) return <View style={{ flex: 1, backgroundColor: palette.background }} />;

  // 🔒 Batch C：安全存储不可用 → 显式失败页（冻结会话使用，提供重试）
  if (authError) {
    return <AuthStorageErrorView code={authError.code} onRetry={retrySession} palette={palette} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <Stack screenOptions={{ headerShown: false, gestureEnabled: true, gestureDirection: 'horizontal', contentStyle: { backgroundColor: 'transparent' } }}>
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="auth" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        {/* settings 及其子路由（settings/notifications 等）统一走 Stack 默认动画，保证一级/二级跳转观感一致 */}
        <Stack.Screen name="settings" />
        {/* 浏览器（阶段 5 拆分）：主页 + 历史 + 书签 */}
        <Stack.Screen name="browser/index" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="browser/history" />
        <Stack.Screen name="browser/bookmarks" />
        <Stack.Screen name="cinema" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
      <FloatingPlayer />
    </View>
  );
}

/**
 * 配置错误页（纯展示，不依赖任何 Provider / 导航 / 主题 / 认证上下文）
 * 仅在 Supabase 配置校验失败时渲染，用于替代整棵业务 Provider 树。
 */
/**
 * 安全存储不可用错误页（TASK-P0.2 Batch C）
 *
 * 触发条件：SecureStore 读写失败导致会话无法恢复/持久化。
 * 行为：冻结会话使用（不进入业务页面、不误跳登录页），提供「重试」。
 * 不提供「以明文继续」选项 —— 这是本次加固的核心约束。
 */
function AuthStorageErrorView({ code, onRetry, palette }) {
  const [retrying, setRetrying] = React.useState(false);
  const handleRetry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <View style={[styles.configErrorContainer, { backgroundColor: palette?.background ?? '#000000' }]}>
      <Text style={styles.configErrorTitle}>无法安全读取登录状态</Text>
      <Text style={styles.configErrorText}>
        设备的安全存储（钥匙串 / Keystore）暂时不可用，为避免以明文保存登录凭证，应用已暂停登录状态的使用。请重试；若持续失败，请重启设备后再试。
      </Text>
      {code ? <Text style={styles.configErrorCode}>错误码：{code}</Text> : null}
      <Text
        style={styles.retryButton}
        onPress={retrying ? undefined : handleRetry}
        accessibilityRole="button"
      >
        {retrying ? '正在重试…' : '重试'}
      </Text>
    </View>
  );
}

function ConfigErrorView() {
  return (
    <View style={styles.configErrorContainer}>
      <Text style={styles.configErrorTitle}>应用配置异常</Text>
      <Text style={styles.configErrorText}>
        应用配置异常，暂时无法连接服务。请检查应用配置后重新启动。
      </Text>
      {supabaseConfigErrors.length > 0 ? (
        <Text style={styles.configErrorCode}>
          错误码：{supabaseConfigErrors.join(', ')}
        </Text>
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  // 🛡️ 启动期防御：配置校验失败时，在任何业务 Provider / hook 挂载之前直接拦截。
  //    不创建 Supabase Client、不读写认证存储、不发网络请求、不进入登录页。
  if (!isSupabaseConfigured) {
    return <ConfigErrorView />;
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <HealthProvider>
          <CinemaProvider>
            <BrowserSessionProvider>
              <RootNavigation />
            </BrowserSessionProvider>
          </CinemaProvider>
        </HealthProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  configErrorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: '#000000',
  },
  configErrorTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  configErrorText: {
    color: '#CCCCCC',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  configErrorCode: {
    color: '#888888',
    fontSize: 12,
    marginTop: 16,
  },
  retryButton: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    marginTop: 24,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#2F6FED',
    textAlign: 'center',
  },
});
// --- END OF FILE src/app/_layout.js ---
