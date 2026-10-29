// --- START OF FILE src/app/auth.js ---
import React, { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, useColorScheme, ActivityIndicator, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { getPalette } from '../constants/colors';
import { useAuth } from '../hooks/useAuth';

export default function AuthScreen() {
  const isDark = useColorScheme() === 'dark';
  const palette = getPalette(isDark);
  const router = useRouter();
  const { signIn, signUp } = useAuth();

  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const shakeAnim = useRef(new Animated.Value(0)).current;

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

  const handleAuth = async () => {
    if (!email.includes('@') || password.length < 6) {
      triggerErrorShake('请输入有效的邮箱和至少6位密码');
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
        triggerErrorShake(error.message);
      } else if (!data?.user?.id) {
        // 🍎 安全校验：拦截服务端假阳性返回，阻断权限穿透隐患
        triggerErrorShake('服务器未返回有效用户信息，请重试');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        
        if (!isLoginMode && !data?.session) {
          alert('注册成功！请前往邮箱点击验证链接激活账号。');
          toggleMode(); 
        } else {
          router.back(); 
        }
      }
    } catch (err) {
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
                placeholder="密码"
                placeholderTextColor={palette.textSecondary}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />
            </View>
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
  errorText: { color: '#FF3B30', fontSize: 13, textAlign: 'center', marginBottom: 20, fontWeight: '500' },
  mainBtn: { height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 8, marginBottom: 24 },
  mainBtnText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600', letterSpacing: 2 },
  switchBtn: { alignSelf: 'center', padding: 8 },
  switchBtnText: { fontSize: 14, fontWeight: '500' }
});
// --- END OF FILE src/app/auth.js ---