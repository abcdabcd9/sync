// --- START OF FILE src/app/auth.js ---
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Animated, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAppTheme } from '../context/ThemeContext';
import { useAuth } from '../hooks/useAuth';
import { useAccountSwitcher } from '../hooks/useAccountSwitcher';

// 🔒 安全审计 #12：将 Supabase 原始错误映射为友好文案，避免泄露表名/约束名/SQL 细节
const mapAuthError = (error, isLoginMode) => {
  const code = error?.code || '';
  const raw = (error?.message || '').toLowerCase();

  if (code === 'invalid_credentials' || raw.includes('invalid login credentials')) {
    return '登录失败，请检查账号密码';
  }
  if (code === 'email_not_confirmed' || raw.includes('email not confirmed')) {
    return '邮箱尚未验证，请先前往邮箱点击验证链接';
  }
  if (code === 'user_already_exists' || code === 'email_exists' || raw.includes('already registered')) {
    return '该邮箱已被注册，请直接登录';
  }
  if (code === 'weak_password' || raw.includes('password should be at least')) {
    return '密码强度不足，请设置至少 8 位密码';
  }
  if (code === 'over_email_send_rate_limit' || raw.includes('rate limit')) {
    return '操作过于频繁，请稍后再试';
  }
  if (raw.includes('network') || raw.includes('fetch')) {
    return '网络连接失败，请稍后重试';
  }
  return isLoginMode ? '登录失败，请检查账号密码' : '注册失败，请稍后重试';
};

export default function AuthScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { signIn, signUp } = useAuth();
  const { rememberAccount } = useAccountSwitcher();

  // 🔀 切换账号：/settings/accounts 会带 ?email= 跳过来，预填邮箱省去重复输入
  const params = useLocalSearchParams();
  const presetEmail = typeof params.email === 'string' ? params.email : '';

  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState(presetEmail);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // ⚠️ 必须用 useState 惰性初始化：useRef(new Animated.Value()).current 会在渲染期读 ref，
  //    违反 react-hooks/refs 规则（React 19）
  const [shakeAnim] = useState(() => new Animated.Value(0));

  const triggerErrorShake = (msg) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setErrorMsg(msg);
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true })
    ]).start();
  };

  // 🔒 安全审计 #11：密码强度校验（至少 8 位），返回 null 表示通过
  const validatePassword = (pwd) => {
    if (!pwd) return '请输入密码';
    if (pwd.length < 8) return '密码至少需要 8 位字符';
    if (!/[a-zA-Z]/.test(pwd)) return '密码需包含至少一个字母';
    if (!/\d/.test(pwd)) return '密码需包含至少一个数字';
    return null;
  };

  const handleAuth = async () => {
    if (!email.includes('@')) {
      triggerErrorShake('请输入有效的邮箱地址');
      return;
    }

    // 🔒 安全审计 #11：注册时强制 8 位以上强密码；登录时仅做非空校验（老账号兼容）
    if (!isLoginMode) {
      const pwdError = validatePassword(password);
      if (pwdError) {
        triggerErrorShake(pwdError);
        return;
      }
    } else if (!password) {
      triggerErrorShake('请输入密码');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const { data, error } = isLoginMode 
        ? await signIn(email, password) 
        : await signUp(email, password);

      if (error) {
        // 🔒 安全审计 #12：不再透传 error.message，统一映射为友好文案
        triggerErrorShake(mapAuthError(error, isLoginMode));
      } else if (!data?.user?.id) {
        // 🍎 安全校验：拦截服务端假阳性返回，阻断权限穿透隐患
        triggerErrorShake('服务器未返回有效用户信息，请重试');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // 🔀 记录到本机账号档案，供 /settings/accounts 快速切换
        // 只存 id / 邮箱 / 昵称 / sync_id，绝不存密码或 token
        if (data?.session) {
          await rememberAccount({
            id: data.user.id,
            email: data.user.email || email,
            nickname: data.user.user_metadata?.nickname || '',
            syncId: data.user.user_metadata?.sync_id || '',
          });
        }

        if (!isLoginMode && !data?.session) {
          Alert.alert('注册成功', '请前往邮箱点击验证链接激活账号。');
          toggleMode();
        } else {
          // 登录成功后由根布局守卫接管跳转，此处仅关闭登录弹层
          if (router.canGoBack()) router.back();
          else router.replace('/');
        }
      }
    } catch (_err) {
      triggerErrorShake('网络连接失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsLoginMode(!isLoginMode);
    setErrorMsg('');
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top', 'bottom']}>
      
      <View style={styles.navBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
          <Ionicons name="close" size={28} color={palette.textPrimary} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.content}>
        <Animated.View style={[styles.formCard, { transform: [{ translateX: shakeAnim }] }]}>
          
          <View style={styles.headerBox}>
            <Ionicons name="planet" size={56} color={palette.primary} />
            <Text style={[styles.title, { color: palette.textPrimary }]}>
              {isLoginMode ? '连接Sync' : '创建账号'}
            </Text>
            <Text style={[styles.subtitle, { color: palette.textSecondary }]}>
              {isLoginMode ? '欢迎回来，请输入账号/密码' : '邮箱注册'}
            </Text>
          </View>

          <View style={styles.inputGroup}>
            <View style={[styles.inputWrapper, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
              <Ionicons name="mail" size={20} color={palette.textSecondary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: palette.textPrimary }]}
                placeholder="邮箱"
                placeholderTextColor={palette.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
              />
            </View>

            <View style={[styles.inputWrapper, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
              <Ionicons name="lock-closed" size={20} color={palette.textSecondary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { color: palette.textPrimary }]}
                placeholder={isLoginMode ? '密码' : '密码（至少 8 位，含字母与数字）'}
                placeholderTextColor={palette.textSecondary}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />
            </View>

            {/* 🔒 安全审计 #11：注册态实时密码强度提示 */}
            {!isLoginMode && password.length > 0 && (
              <Text style={[styles.hintText, { color: validatePassword(password) ? '#FF3B30' : '#34C759' }]}>
                {validatePassword(password) || '✓ 密码强度符合要求'}
              </Text>
            )}
          </View>

          {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

          <TouchableOpacity 
            style={[styles.mainBtn, { backgroundColor: palette.primary }]} 
            onPress={handleAuth}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.mainBtnText}>{isLoginMode ? '进 入' : '注 册'}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.switchBtn} onPress={toggleMode} activeOpacity={0.6}>
            <Text style={[styles.switchBtnText, { color: palette.textSecondary }]}>
              {isLoginMode ? '尚未拥有账号？点此创建' : '已有账号？点此登录'}
            </Text>
          </TouchableOpacity>

        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  navBar: { paddingHorizontal: 16, paddingTop: 16, alignItems: 'flex-start' },
  closeBtn: { padding: 8, marginLeft: -8 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  formCard: { paddingBottom: 100 },
  headerBox: { alignItems: 'center', marginBottom: 40 },
  title: { fontSize: 26, fontWeight: '700', marginTop: 16, marginBottom: 8, letterSpacing: 0.5 },
  subtitle: { fontSize: 15, fontWeight: '400' },
  inputGroup: { gap: 16, marginBottom: 24 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 16, paddingHorizontal: 16, borderWidth: 1 },
  inputIcon: { marginRight: 12 },
  input: { flex: 1, fontSize: 16, height: '100%' },
  hintText: { fontSize: 12, fontWeight: '500', marginTop: -8, marginBottom: 8, paddingHorizontal: 4 },
  errorText: { color: '#FF3B30', fontSize: 13, textAlign: 'center', marginBottom: 20, fontWeight: '500' },
  mainBtn: { height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 8, marginBottom: 24 },
  mainBtnText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600', letterSpacing: 2 },
  switchBtn: { alignSelf: 'center', padding: 8 },
  switchBtnText: { fontSize: 14, fontWeight: '500' }
});
// --- END OF FILE src/app/auth.js ---