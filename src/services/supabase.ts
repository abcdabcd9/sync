// --- START OF FILE src/services/supabase.ts ---
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import { parseSupabaseConfig } from './supabaseConfig';
import type { ConfigErrorCode } from './supabaseConfig';
import {
  AUTH_STORAGE_ERROR,
  createAuthStorageStatus,
  createSecureStoreAdapter,
} from './authStorage';

// 重新导出错误码，保持既有 import 路径（`from '../services/supabase'`）兼容。
export { AUTH_STORAGE_ERROR };

/**
 * 认证存储故障状态位（C02 / Gemini P1-1）
 *
 * `@supabase/auth-js` 的 `_recoverAndRefresh()` 会 catch 掉 `storage.getItem`
 * 抛出的异常（只 console.error 后 return），导致 `getSession()` 正常 resolve
 * 出 `session: null`。上层无法通过 try/catch 感知故障，因此改为主动查询本状态位。
 */
export const authStorageStatus = createAuthStorageStatus();

// 从环境变量读取 Supabase 公开客户端配置。
// 注意：EXPO_PUBLIC_* 会被 Expo 在打包时内联进客户端产物，属于"公开配置"，
// 并非秘密存储；真正的访问控制依赖数据库 RLS 与密钥轮换，切勿在此放置
// 服务端私密密钥（如 service_role key）。
// 另：必须直接读取静态属性 process.env.EXPO_PUBLIC_*，Expo 才能做静态替换；
// 不要改为动态取值（如 process.env[name]）。
const supabaseUrl: string | undefined = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey: string | undefined = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// 🛡️ 启动期防御（B-Lite / Guarded Null）：
//   在创建 Supabase Client 之前，先对配置做纯同步静态校验。
//   - 校验失败：不创建任何客户端（supabase = null），不读写认证存储、不发网络请求；
//     由 RootLayout 在挂载业务 Provider 之前拦截并展示配置错误页。
//   - 校验通过：按既有方式创建唯一客户端，行为与修复前完全一致。
//   这样既避免了模块顶层 new URL(undefined) 抛 TypeError 导致的白屏闪退，
//   也避免了"占位客户端"污染/清除真实登录态的风险。
const config = parseSupabaseConfig(supabaseUrl, supabaseAnonKey);

// isSupabaseConfigured 仅表示"已通过本地配置校验"，不代表网络连通或认证有效。
export const isSupabaseConfigured: boolean = config.ok;

// 仅含固定错误码（不含任何真实配置值），供诊断/错误页可选展示。
export const supabaseConfigErrors: ConfigErrorCode[] = config.ok ? [] : config.errors;

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
// 注意：storageKey 由 parseSupabaseConfig 在配置校验通过后计算，
// 正常有效配置下与旧表达式逐字节一致，不会导致已登录用户被登出。
// 配置无效时 config.storageKey 不存在，此处不会执行到（见下方条件构造）。
const AUTH_STORAGE_KEY: string | null = config.ok ? config.storageKey : null;

/**
 * 认证会话安全存储适配器（TASK-P0.2 Batch C）
 *
 * 实现已抽到 ./authStorage，通过依赖注入接收 SecureStore / AsyncStorage，
 * 使测试可以直接执行真实实现（C03），而不是复刻一份逻辑。
 * 这里只负责注入生产环境的原生模块。
 */
const SecureStoreAdapter = createSecureStoreAdapter({
  secureStore: SecureStore,
  asyncStorage: AsyncStorage,
  status: authStorageStatus,
});

// 仅在配置校验通过时创建唯一客户端；配置无效时导出 null，
// 由 RootLayout 在挂载业务 Provider 之前拦截。
// 异常分支绝不调用 createClient：不构造 SDK、不读写认证存储、不发网络请求。
export const supabase: SupabaseClient | null = config.ok
  ? createClient(config.url, config.key, {
      auth: {
        // 🔒 M-2：仅 Auth 会话走加密存储，业务缓存仍用 AsyncStorage
        storage: SecureStoreAdapter,
        // 此处 config.ok 已收窄为成功分支，config.storageKey 为 string，
        // 与旧表达式逐字节一致（AUTH_STORAGE_KEY 在成功分支下同值）。
        storageKey: config.storageKey,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

/**
 * 🍎 BUG-02（iOS-01 残留）— SecureStore 可用性探测。
 *
 * 背景：iOS 解锁后 Keychain 存在短暂不可用窗口（`User interaction is not allowed`）。
 *   若在 `AppState 'active'` 事件里**立即** `startAutoRefresh()`，首个自动刷新 tick
 *   会读 SecureStore 并抛错，用户可见 `SecureStore getValueWithKeyAsync failed`。
 *
 * 本函数只做**只读探测**：尝试读取 auth storage key。
 *   · 读取成功（含返回 null）→ Keychain 已解锁可用 → resolve(true)；
 *   · 读取抛错（Keychain 锁定 / 交互不允许）→ resolve(false)，由调用方延迟重试。
 *
 * 约束：
 *   · 不写、不删、不降级明文；不改变凭证存储方式；
 *   · 不吞异常：探测失败返回 false（不抛），由控制器决定重试节奏；
 *   · 配置无效（supabase 为 null / 无 storageKey）时直接返回 true（无凭证可读，不阻塞）。
 */
export async function probeAuthStorage(): Promise<boolean> {
  if (!config.ok || !AUTH_STORAGE_KEY) return true;
  try {
    // 直接读底层 SecureStore（与适配器同一 key 归一化规则），只读不写。
    await SecureStore.getItemAsync(AUTH_STORAGE_KEY);
    return true;
  } catch {
    // Keychain 暂不可用（锁定 / 交互不允许）→ 交由控制器延迟重试。
    return false;
  }
}
// --- END OF FILE src/services/supabase.ts ---
