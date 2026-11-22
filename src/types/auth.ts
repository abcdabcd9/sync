/**
 * 认证 / 会话 / 身份契约（TASK-P1.1 R0 — Phase B1 校正）
 *
 * 依据（逐字段核对，非猜测）：
 *   - `src/hooks/useAuth.js` 第 360–471 行 `value` useMemo 的真实形状
 *   - `src/hooks/useAuth.js` 第 387–467 行 `signOut` 的全部 return 分支
 *   - `src/hooks/useOwnerKey.js` 第 30–52 行 ownerKey 生成规则
 *   - `src/services/authStorage.js` 第 22–29 行 `AUTH_STORAGE_ERROR`
 *   - Supabase Auth 的 Session / User 结构（仅取代码中真实读取的字段）
 *
 * 注意：本文件不 import `@supabase/supabase-js`，避免把第三方类型泄漏到
 * 业务契约层；仅声明代码实际读取的字段子集。
 */

import type { AppErrorCode } from './result';

/** Supabase 用户对象中本项目真实使用的字段子集 */
export interface AuthUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  created_at?: string;
  last_sign_in_at?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

/** Supabase 会话对象中本项目真实使用的字段子集 */
export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** Unix 秒级过期时间 */
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  user: AuthUser;
}

/**
 * 身份纪元（authEpoch）。
 *
 * 语义：每次登录 / 登出 / 账号切换都会递增，用于让旧账号的异步任务
 * 识别自己已过期（ownerKey 隔离的核心）。初始值为 0。
 */
export type AuthEpoch = number;

/**
 * ownerKey 字符串。
 *
 * 生成规则（见 `src/hooks/useOwnerKey.js`）：
 *   `${ownerId ?? 'anon'}::${authEpoch ?? 0}`
 * 形如 `"<uuid>::3"` 或 `"anon::0"`。
 */
export type OwnerKey = string;

/** 认证存储故障码（与 `AUTH_STORAGE_ERROR` 一一对应） */
export type AuthStorageErrorCode = Extract<
  AppErrorCode,
  | 'AUTH_STORAGE_UNAVAILABLE'
  | 'AUTH_STORAGE_MIGRATION_FAILED'
  | 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED'
>;

/**
 * 认证存储故障状态（`createAuthStorageStatus().get()` 的返回）。
 *
 * 真实来源：`src/services/authStorage.js` 第 51–56 行
 *   `markFailed(code, cause)` → `{ code, message }`
 *
 * 注意：`message` 的历史运行时契约**不是**严格字符串。
 * 原实现为 `cause?.message ?? String(cause ?? code)`：
 *   - `cause` 为 `null` / `undefined` / 原始值 → `String(...)`，得到字符串；
 *   - `cause` 为对象且 `cause.message` 存在 → **原样返回**该值，
 *     因此当 `cause.message` 为 `0` / `false` 时，`message` 实际是 `number` / `boolean`。
 * 为诚实反映历史契约（不通过强制 `String` 制造类型正确），这里保留 `unknown`。
 * 消费方（`useAuth.js`）仅将其透传给 `setAuthError` 展示，不依赖字符串方法。
 */
export interface AuthStorageFailure {
  code: AuthStorageErrorCode;
  message: unknown;
}

/**
 * 认证错误对象（`authError` / `signOutError` 的真实形态）。
 *
 * 真实来源：`src/hooks/useAuth.js`
 *   - 第 405 行：`{ code: error.code ?? 'AUTH_SIGN_OUT_FAILED', message: ... }`
 *   - 第 419 行：`{ code: failure.code, message: '安全存储删除失败，登出未完成' }`
 *   - 第 455–458 行：`{ code: e?.code ?? 'AUTH_SIGN_OUT_FAILED', message: ... }`
 *   - 第 391 行：`{ code: 'AUTH_SIGN_OUT_IN_PROGRESS', message: '登出正在进行中' }`
 *
 * 注意：`code` 既可能是 `AUTH_STORAGE_*`，也可能是 Supabase Auth 的
 * 错误码（如 `invalid_credentials`）或本模块自定义的 `AUTH_SIGN_OUT_*`，
 * 因此这里**不**收窄为封闭联合，保留 `string` 以匹配真实运行时。
 */
export interface AuthErrorLike {
  code: string;
  message: string;
}

/**
 * `signOut()` 的返回。
 *
 * 真实来源：`src/hooks/useAuth.js` 第 387–467 行，所有分支均返回
 * `{ error: ... }` 对象（**不是** void）：
 *   - 重入：`{ error: { code: 'AUTH_SIGN_OUT_IN_PROGRESS', ... } }`
 *   - SDK 失败：`{ error }`（Supabase 原始 error 对象）
 *   - 存储 UNAVAILABLE：`{ error: { code, message } }`
 *   - 成功：`{ error: null }`
 *   - 异常：`{ error: { code, message } }`
 */
export interface SignOutResult {
  error: AuthErrorLike | null;
}

/**
 * `signIn()` / `signUp()` 的返回。
 *
 * 真实来源：`src/hooks/useAuth.js` 第 375–376 行，直接透传
 * `supabase.auth.signInWithPassword()` / `supabase.auth.signUp()` 的返回值。
 * 该返回值形如 `{ data: { user, session }, error }`，这里只声明本项目
 * 可能读取的字段子集，避免泄漏第三方完整类型。
 */
export interface AuthCredentialsResult {
  data: {
    user: AuthUser | null;
    session: AuthSession | null;
  };
  error: AuthErrorLike | null;
}

/**
 * `useAuth()` 返回的 context value。
 *
 * 字段与 `src/hooks/useAuth.js` 第 360–471 行 `value` 对象严格一致。
 */
export interface AuthContextValue {
  user: AuthUser | null;
  session: AuthSession | null;
  isAuthLoading: boolean;
  /** 安全存储 / 会话恢复失败信息；null 表示无错误 */
  authError: AuthErrorLike | null;
  retrySession: () => Promise<void>;
  /** 当前登录用户 id，未登录为 null */
  ownerId: string | null;
  authEpoch: AuthEpoch;
  /** 身份切换中（登出 / 换号过渡态） */
  isIdentityTransitioning: boolean;
  /** 上次登出失败信息；非 null 时不得跳转登录页 / 不得切号 */
  signOutError: AuthErrorLike | null;
  /** 登录（透传 Supabase signInWithPassword） */
  signIn: (email: string, password: string) => Promise<AuthCredentialsResult>;
  /** 注册（透传 Supabase signUp） */
  signUp: (email: string, password: string) => Promise<AuthCredentialsResult>;
  /** 登出；始终返回 `{ error }` 对象，绝不抛异常 */
  signOut: () => Promise<SignOutResult>;
}

/** `useOwnerKey()` 的返回 */
export interface OwnerKeyState {
  ownerKey: OwnerKey;
  ownerKeyRef: { current: OwnerKey };
  /** 判断某个 ownerKey 是否仍是当前有效的身份 */
  isOwnerKeyCurrent: (key: OwnerKey) => boolean;
}
