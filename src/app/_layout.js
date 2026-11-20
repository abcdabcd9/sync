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

/**
 * 🛡️ P0.3 iOS-02 修复：路由决策纯函数（单一事实来源）
 *
 * 背景（真机验收缺陷）：
 *   旧实现把「路由跳转」与「白屏占位」都挂在同一个前置条件 `isInitialized`
 *   （= useHealthData → useHealthStorage.isLoaded）上：
 *     · 守卫：`if (isAuthLoading || !isInitialized) return;` → 未登录时
 *       isInitialized 恒为 false，守卫永远提前 return，永不跳 /auth；
 *     · 白屏：`if (!isInitialized) return <View .../>;` → 渲染纯背景色空 View。
 *   而退出登录后 userId=null，useHealthStorage.load() 命中 `!k` 分支，
 *   永久 setIsLoaded(false) → isInitialized 永远无法回到 true。
 *   结果：白屏 View 永久驻留、跳转逻辑永久被跳过 —— 确定性死锁。
 *
 * 修复原则（最小、语义正确）：
 *   · 「未登录 → 去登录页」是**鉴权**决策，与「健康数据是否加载完成」无关，
 *     绝不能因 isInitialized=false 而阻塞；
 *   · 「已登录但健康数据未就绪」才需要占位，避免闪现私人页 / 展示其他账号数据；
 *   · authError 存在时由安全错误页接管，绝不误跳登录页。
 *
 * 返回值：null（不跳转）| '/auth'（去登录页）| '/'（回主界面）
 *
 * 该函数为纯函数，便于在纯 Node 环境做回归测试（见
 * tests/security/ios02WhiteScreen.test.mjs）。
 */
export function computeAuthRedirect({ user, isAuthLoading, authError, isInitialized, isPublicRoute }) {
  // ① 会话确认中：不做任何跳转，避免误拦截 / 闪现私人页
  if (isAuthLoading) return null;
  // ② 安全存储故障：由 AuthStorageErrorView 接管展示与重试，绝不误判为已登出
  if (authError) return null;
  // ③ 未登录：无论健康数据是否就绪，都必须去登录页（修复白屏死锁的核心）
  if (!user) {
    return isPublicRoute ? null : '/auth';
  }
  // ④ 已登录但健康数据未就绪：先不跳转（避免闪现私人页 / 错误账号数据）
  if (!isInitialized) return null;
  // ⑤ 已登录却停留在公开页（登录页）→ 送回主界面，避免重复登录
  if (isPublicRoute) return '/';
  return null;
}

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

  // 🛡️ P0.3 iOS-02 修复：路由决策统一由纯函数 computeAuthRedirect 给出。
  //    关键点：未登录（!user）时**不再**受 isInitialized 阻塞，直接跳 /auth，
  //    从而打破「白屏占位」与「跳转守卫」共用 isInitialized 造成的死锁。
  const redirectTarget = computeAuthRedirect({
    user,
    isAuthLoading,
    authError,
    isInitialized,
    isPublicRoute,
  });

  useEffect(() => {
    // 仅在确有跳转目标时执行；此时下方渲染分支保证 Stack（导航器）已挂载，
    // 满足「不得在导航器未挂载时调用 router.replace()」的约束。
    if (redirectTarget) {
      router.replace(redirectTarget);
    }
  }, [redirectTarget, router]);

  // 🔒 Batch C：安全存储不可用 → 显式失败页（冻结会话使用，提供重试）。
  //    此分支 redirectTarget 恒为 null（computeAuthRedirect 已对 authError 返回 null），
  //    故不会在错误页状态下触发跳转。
  if (authError) {
    return <AuthStorageErrorView code={authError.code} onRetry={retrySession} palette={palette} />;
  }

  // 🛡️ P0.3 iOS-02 修复：仅在「会话确认中」或「已登录但健康数据未就绪」时占位。
  //    这两种状态下 redirectTarget 恒为 null（见 computeAuthRedirect），
  //    因此占位期间不会调用 router.replace()，不存在「导航器未挂载即跳转」的问题。
  //    未登录（!user）不再落入此分支 → 会渲染下方 Stack 并跳转 /auth，彻底消除白屏。
  if (isAuthLoading || (user && !isInitialized)) {
    return <View style={{ flex: 1, backgroundColor: palette.background }} />;
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
