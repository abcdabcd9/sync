// --- START OF FILE src/hooks/useAuth.js ---
import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase, authStorageStatus, AUTH_STORAGE_ERROR } from '../services/supabase';

const AuthContext = createContext();

/**
 * 认证状态机（TASK-P0.2 Batch C）
 *
 * 关键约束：
 *   - 安全存储不可用（SecureStore 读写失败）时，**不得**把用户当作「已登出」，
 *     否则会误路由到登录页并让用户以为会话丢失；
 *   - 也不得无限停留在 loading（旧实现 getSession 无 catch，失败即永久 loading）；
 *   - 因此引入显式 `authError` 状态：上层据此展示「安全存储不可用，请重试」，
 *     并冻结会话使用，而不是静默降级或假装成功。
 *
 * C02 / Gemini P1-1 —— 为什么不能只靠 try/catch：
 *   `@supabase/auth-js` 的 `_recoverAndRefresh()` 内部对 `storage.getItem` 的异常
 *   做了 catch 兜底（只 console.error 后 return），因此 `getSession()` 会
 *   **正常 resolve** 出 `{ data: { session: null }, error: null }`。
 *   也就是说适配器抛出的 `AUTH_STORAGE_UNAVAILABLE` 根本到不了这里。
 *   所以每次拿到 SDK 结果后，都必须再查一次 `authStorageStatus`：
 *   只要状态位显示故障，就一律按「安全存储不可用」处理，绝不当作已登出。
 *
 * 故障态的生命周期：
 *   - 由适配器在失败第一现场写入（见 `src/services/authStorage.js`）；
 *   - 只在适配器成功读/写/删时清除；
 *   - **不会被无关的认证事件清除**（例如 SIGNED_OUT / TOKEN_REFRESHED 回调），
 *     否则一次无关事件就能把故障页刷掉，用户又会被静默登出。
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  // null 表示无错误；非 null 表示安全存储/会话恢复失败（含错误码）
  const [authError, setAuthError] = useState(null);

  // 用 ref 保存最新故障态，避免闭包捕获过期值
  const storageFailureRef = useRef(null);

  /** 读取适配器状态位，并同步到 React state。返回是否处于故障态。 */
  const syncStorageFailure = useCallback(() => {
    const failure = authStorageStatus.get();
    storageFailureRef.current = failure;
    if (failure) {
      setAuthError({ code: failure.code, message: failure.message });
      return true;
    }
    return false;
  }, []);

  const applySession = useCallback((nextSession) => {
    setSession(nextSession);
    setUser(nextSession?.user || null);
  }, []);

  // 重新尝试恢复会话（供错误页「重试」按钮调用）
  const retrySession = useCallback(async () => {
    setIsAuthLoading(true);
    setAuthError(null);
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      // C02：SDK 可能吞掉存储异常并返回 session:null，必须复查状态位
      if (syncStorageFailure()) return;
      applySession(data?.session ?? null);
    } catch (e) {
      // 显式失败：保留 authError，不把用户当作已登出
      console.error('🔒 会话恢复失败（安全存储不可用）:', e?.code ?? e?.message ?? e);
      setAuthError({ code: e?.code ?? 'AUTH_SESSION_RESTORE_FAILED', message: e?.message ?? String(e) });
    } finally {
      setIsAuthLoading(false);
    }
  }, [applySession, syncStorageFailure]);

  useEffect(() => {
    let cancelled = false;

    // 1. 初始化时获取当前缓存的会话（必须捕获失败，避免永久 loading）
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) throw error;
        // C02：优先信任适配器状态位 —— GoTrue 会吞掉存储异常
        if (syncStorageFailure()) return;
        applySession(data?.session ?? null);
        setAuthError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error('🔒 会话恢复失败（安全存储不可用）:', e?.code ?? e?.message ?? e);
        setAuthError({ code: e?.code ?? 'AUTH_SESSION_RESTORE_FAILED', message: e?.message ?? String(e) });
      })
      .finally(() => {
        if (!cancelled) setIsAuthLoading(false);
      });

    // 2. 监听全局 Auth 状态变化（登录、登出、Token刷新自动触发）
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return;

      // C02：故障态优先。存储链路故障期间，任何认证事件都不得清除故障页，
      //      否则一次无关的 SIGNED_OUT / TOKEN_REFRESHED 就会把用户静默登出。
      if (syncStorageFailure()) {
        setIsAuthLoading(false);
        return;
      }

      applySession(nextSession);
      // 成功拿到状态变化且存储健康 → 清除历史错误
      setAuthError(null);
      setIsAuthLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [applySession, syncStorageFailure]);

  const value = useMemo(() => ({
    user,
    session,
    isAuthLoading,
    authError,
    retrySession,
    signIn: async (email, password) => await supabase.auth.signInWithPassword({ email, password }),
    signUp: async (email, password) => await supabase.auth.signUp({ email, password }),

    // 🍎 核心安全修复：退出登录前，先将数据库中的设备推送令牌抹除，彻底切断幽灵推送！
    signOut: async () => {
      if (user) {
        await supabase.from('profiles').update({ expo_push_token: null }).eq('id', user.id);
      }
      // C02：登出失败必须显式上报，不能静默当作已登出。
      //      GoTrue 的 signOut 在存储删除失败时同样可能吞异常，
      //      因此这里同时检查返回值与适配器状态位。
      const { error } = await supabase.auth.signOut();
      if (error) {
        setAuthError({ code: error.code ?? 'AUTH_SIGN_OUT_FAILED', message: error.message ?? String(error) });
        return { error };
      }

      // 🔒 T6.1/FIX-04：必须区分「安全副本删除失败」与「明文残留清理失败」。
      //    - UNAVAILABLE：SecureStore 删除失败 → 会话可能仍可被恢复，
      //      登出**未完成**，必须报错并保留故障页。
      //    - LEGACY_CLEANUP_FAILED：安全副本已删除（会话确实已失效），
      //      仅 AsyncStorage 明文残留未清掉 → 登出**已完成**，
      //      不应把用户挡在错误页；只记录状态位供后续清理。
      //    旧实现用 syncStorageFailure() 一刀切，会把「已登出 + 明文残留」
      //    误报为「登出未完成」，用户反复点登出却始终看到失败提示。
      const failure = authStorageStatus.get();
      if (failure && failure.code === AUTH_STORAGE_ERROR.UNAVAILABLE) {
        setAuthError({ code: failure.code, message: '安全存储删除失败，登出未完成' });
        return { error: { code: failure.code, message: '安全存储删除失败，登出未完成' } };
      }
      if (failure && failure.code === AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED) {
        // 登出已生效；明文残留属于待清理项，不阻断流程
        console.warn('🔒 登出已完成，但旧明文副本清理失败（待下次清理）:', failure.message);
      }
      return { error: null };
    },
    // 注：signOut 内部直接读 authStorageStatus.get()（需按错误码分流），
    //     不再依赖 syncStorageFailure，故此处不列入依赖。
  }), [user, session, isAuthLoading, authError, retrySession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
// --- END OF FILE src/hooks/useAuth.js ---
