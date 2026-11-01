// --- START OF FILE src/services/supabase.js ---
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';

// 从环境变量中安全读取密钥，防御 GitHub 自动化抓取
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase URL or Anon Key. Please check your .env file.');
}

/**
 * 🔒 M-2：Supabase Auth 会话改用 SecureStore（iOS Keychain / Android Keystore）加密存储
 *
 * 背景：
 *   AsyncStorage 在 iOS 上是明文 SQLite 文件、在 Android 上是明文 XML，
 *   设备被 Root / 越狱、或通过 iTunes / adb 备份导出时，access_token 与
 *   refresh_token 会被直接读取，攻击者可长期冒用身份。
 *   SecureStore 底层走系统级加密容器，密钥由硬件安全模块保护。
 *
 * 作用范围（严格限定）：
 *   仅接管 Supabase SDK 的 auth 会话持久化（storageKey = `sb-<ref>-auth-token`）。
 *   其余所有业务缓存（聊天记录、书签、历史、健康数据、主题、账号档案等）
 *   继续走 AsyncStorage，完全不受影响。
 */

// Supabase SDK 默认 storageKey 规则：`sb-${hostname 首段}-auth-token`
// 例：https://pjiyniqtrstcpnodsnqq.supabase.co → sb-pjiyniqtrstcpnodsnqq-auth-token
const AUTH_STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;

// SecureStore 的 key 只允许 [A-Za-z0-9._-]，上面的 key 天然合规；
// 但为防御未来 storageKey 变更引入非法字符，这里做一次归一化兜底。
const toSecureKey = (key) => String(key).replace(/[^\w.-]/g, '_');

/**
 * SecureStore 适配器
 *
 * 相比直接透传，额外做了三件事：
 *   1. key 归一化，避免 SecureStore 抛 "Invalid key"
 *   2. 首次读取时把 AsyncStorage 里的旧明文会话迁移到 SecureStore 并删除明文
 *      —— 否则升级后所有已登录用户会被强制登出
 *   3. SecureStore 不可用（极少数设备 / 模拟器异常）时降级回 AsyncStorage，
 *      保证登录功能不中断，而不是直接崩溃
 */
const SecureStoreAdapter = {
  getItem: async (key) => {
    const secureKey = toSecureKey(key);
    try {
      const value = await SecureStore.getItemAsync(secureKey);
      if (value !== null) return value;

      // 🔁 一次性迁移：旧版本把会话明文存在 AsyncStorage 中
      const legacy = await AsyncStorage.getItem(key);
      if (legacy !== null) {
        await SecureStore.setItemAsync(secureKey, legacy);
        // 迁移成功后立即抹除明文副本，避免双份留存
        await AsyncStorage.removeItem(key);
        return legacy;
      }
      return null;
    } catch (e) {
      console.warn('⚠️ SecureStore 读取失败，降级到 AsyncStorage:', e?.message ?? e);
      return AsyncStorage.getItem(key);
    }
  },

  setItem: async (key, value) => {
    const secureKey = toSecureKey(key);
    try {
      await SecureStore.setItemAsync(secureKey, value);
    } catch (e) {
      console.warn('⚠️ SecureStore 写入失败，降级到 AsyncStorage:', e?.message ?? e);
      await AsyncStorage.setItem(key, value);
    }
  },

  removeItem: async (key) => {
    const secureKey = toSecureKey(key);
    try {
      await SecureStore.deleteItemAsync(secureKey);
    } catch (e) {
      console.warn('⚠️ SecureStore 删除失败:', e?.message ?? e);
    }
    // 无论 SecureStore 是否成功，都清掉 AsyncStorage 中的残留（含迁移前的旧明文）
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // 忽略：AsyncStorage 无该 key 时不会抛错，此处仅防御性兜底
    }
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // 🔒 M-2：仅 Auth 会话走加密存储，业务缓存仍用 AsyncStorage
    storage: SecureStoreAdapter,
    storageKey: AUTH_STORAGE_KEY,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
// --- END OF FILE src/services/supabase.js ---
