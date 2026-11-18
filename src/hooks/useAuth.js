// --- START OF FILE src/hooks/useAuth.js ---
import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase, authStorageStatus, AUTH_STORAGE_ERROR } from '../services/supabase';
import { setSignedUrlOwner } from './chat/useSignedMediaUrl';
import { setProfileCacheOwner } from './profile/useProfileCache';

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

  // ==========================================================================
  // 🆔 TASK-P0.3 / B1-A：身份代际（authEpoch）
  //
  // 目的：为「账号作用域数据隔离」提供一个**同步可读、单调递增**的身份令牌。
  //   任何异步操作（云端请求、磁盘读写、签名 URL）在发起时快照 epoch，
  //   在写回 state / 缓存前比对 epoch；不一致即说明身份已切换，结果必须丢弃。
  //
  // 为什么不能只比较 userId：
  //   · A → 登出 → A 重新登录：userId 相同，但旧请求属于「上一个会话」，
  //     必须失效（否则旧 token 下的结果会污染新会话）。
  //   · A → B → A：userId 回到 A，但中间 B 的数据绝不能残留。
  //   因此 epoch 在**每一次真实身份转移**时自增，与 userId 是否相同无关。
  //
  // 双轨维护（与 useHealthCloud.authGeneration 同构）：
  //   · authEpochRef：供异步回调同步读取，零延迟、不触发重渲染。
  //   · authEpoch（state）：供 React 依赖数组使用，驱动订阅/加载重建。
  //
  // ⚠️ 绝不在认证回调里 await 任何 Supabase 查询或磁盘清理：
  //    认证回调必须同步完成，否则会阻塞 GoTrue 事件队列并引发状态雪崩。
  // ==========================================================================
  const authEpochRef = useRef(0);
  const [authEpoch, setAuthEpoch] = useState(0);

  // 当前身份 ownerId 的 ref 镜像（供异步回调同步比对，避免闭包过期）
  const ownerIdRef = useRef(null);

  // 当前 session 的 ref 镜像（用于检测同账号 token 轮换）
  const sessionRef = useRef(null);

  // 身份转移进行中标记：登出/切换期间为 true，用于 UI 冻结旧账号敏感数据
  const [isIdentityTransitioning, setIsIdentityTransitioning] = useState(false);

  // 🛡️ X-07：登出重入锁（同步、ref）。
  //    state 的 isIdentityTransitioning 是异步更新的，连续两次 signOut 时第二次
  //    读到的仍是旧值，无法阻止重入。用 ref 做同步锁，确保同一时刻只有一次登出在跑。
  const signOutInFlightRef = useRef(false);

  // 登出失败显式状态：非 null 表示上次登出未完成（不得跳转登录页 / 不得切号）
  const [signOutError, setSignOutError] = useState(null);

  /**
   * 推进身份代际（同步、幂等安全）。
   * 每次真实身份转移调用一次；返回新的 epoch。
   */
  const bumpAuthEpoch = useCallback(() => {
    authEpochRef.current += 1;
    const next = authEpochRef.current;
    setAuthEpoch(next);
    return next;
  }, []);

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

  /**
   * 应用一次会话快照，并在「真实身份转移」时同步推进 authEpoch。
   *
   * 身份转移判定（任一成立即视为转移）：
   *   1. ownerId 发生变化（A → B，或 A → null，或 null → A）
   *   2. 同一 ownerId 但**真实重新登录**（A → 登出 → A 重新登录）——
   *      旧会话的在途结果必须失效。
   *
   * 🛡️ CR-06：**正常 JWT 刷新（TOKEN_REFRESHED）不是身份转移**。
   *    旧实现只要 access_token 变化就 bumpAuthEpoch + 强制下游代际，
   *    把每次 token 自动刷新都当成新会话，导致合法的在途业务请求被误判失效。
   *    修复：只有「owner 变化」或「明确的新登录事件（SIGNED_IN / USER_UPDATED
   *    且 owner 相同但 token 变化）」才推进代际；TOKEN_REFRESHED 仅更新 token，
   *    不推进代际、不强制下游失效。
   *
   * @param {object|null} nextSession
   * @param {string} [event] Supabase auth 事件名（SIGNED_IN / TOKEN_REFRESHED / ...）
   *
   * ⚠️ 同步执行：不 await 任何网络/磁盘操作，避免阻塞 GoTrue 事件队列。
   */
  const applySession = useCallback((nextSession, event = null) => {
    const nextUser = nextSession?.user || null;
    const nextOwnerId = nextUser?.id ?? null;
    const prevOwnerId = ownerIdRef.current;
    const prevAccessToken = sessionRef.current?.access_token ?? null;
    const nextAccessToken = nextSession?.access_token ?? null;

    const ownerChanged = prevOwnerId !== nextOwnerId;
    // 🛡️ CR-06：正常 token 刷新不算身份转移。
    //    仅当「非 TOKEN_REFRESHED 事件」且 ownerId 相同但 token 变化时，
    //    才视为「同账号真实重新登录」（A→登出→A）。
    const isTokenRefresh = event === 'TOKEN_REFRESHED';
    const tokenRotated =
      !ownerChanged && !isTokenRefresh && !!nextOwnerId && prevAccessToken !== nextAccessToken;

    if (ownerChanged || tokenRotated) {
      // 同步推进代际（ref 立即生效，供在途异步回调比对）
      bumpAuthEpoch();
    }

    // 🆔 B1-D / B1-E：同步登记下游模块级缓存的身份 owner。
    //    · owner 变化时，这些模块会自增内部代际并清空缓存/inflight，
    //      使旧账号的缓存内容与在途 Promise 结果对新账号不可消费。
    //    · 同步执行，不 await 任何 IO。
    //
    // 🆔 X-05 / CR-06：仅「真实重新登录」（tokenRotated）才强制下游代际；
    //    正常 TOKEN_REFRESHED 不触碰下游代际，避免误伤合法在途请求。
    if (ownerChanged) {
      setSignedUrlOwner(nextOwnerId);
      setProfileCacheOwner(nextOwnerId);
    } else if (tokenRotated) {
      setSignedUrlOwner(nextOwnerId, true);
      setProfileCacheOwner(nextOwnerId, true);
    }

    ownerIdRef.current = nextOwnerId;
    sessionRef.current = nextSession ?? null;
    setSession(nextSession);
    setUser(nextUser);
  }, [bumpAuthEpoch]);

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
    //    🛡️ CR-06：把 event 透传给 applySession，用于区分「正常 token 刷新」
    //    与「真实身份转移」，避免把每次 TOKEN_REFRESHED 都当作新会话。
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;

      // C02：故障态优先。存储链路故障期间，任何认证事件都不得清除故障页，
      //      否则一次无关的 SIGNED_OUT / TOKEN_REFRESHED 就会把用户静默登出。
      if (syncStorageFailure()) {
        setIsAuthLoading(false);
        return;
      }

      // 🛡️ CR-08：登出进行中（signOut() 尚未完成其 authStorageStatus 失败检查）时，
      //    GoTrue 可能先派发 SIGNED_OUT 事件。若此时直接 applySession(null)，
      //    会在「存储删除失败 → 登出未完成」的情况下提前清空 user / 推进代际，
      //    与 signOut() 后续的失败分支冲突（用户被静默登出）。
      //    修复：登出进行中忽略 SIGNED_OUT 事件，由 signOut() 自身在确认成功后
      //    统一推进代际与清空状态；失败时保留会话与故障页。
      if (signOutInFlightRef.current && event === 'SIGNED_OUT') {
        return;
      }

      applySession(nextSession, event);
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
    // 🆔 TASK-P0.3 / B1-A：身份作用域令牌（供下游数据隔离使用）
    //   ownerId：当前账号 id（未登录为 null）
    //   authEpoch：身份代际，每次真实身份转移自增（含同账号重新登录）
    //   isIdentityTransitioning：登出/切换进行中，UI 应冻结旧账号敏感数据
    //   signOutError：上次登出失败信息（非 null 时不得跳转登录页 / 不得切号）
    ownerId: user?.id ?? null,
    authEpoch,
    isIdentityTransitioning,
    signOutError,
    signIn: async (email, password) => await supabase.auth.signInWithPassword({ email, password }),
    signUp: async (email, password) => await supabase.auth.signUp({ email, password }),

    // 🍎 核心安全修复：退出登录前，先将数据库中的设备推送令牌抹除，彻底切断幽灵推送！
    //
    // 🛡️ TASK-P0.3 / B1-A 登出失败安全：
    //   · 登出开始即置 isIdentityTransitioning=true，冻结旧账号敏感 UI；
    //   · 任何失败分支都**不得**推进 authEpoch、不得清空 user、不得删除本地持久化文件，
    //     并显式写入 signOutError，供上层展示失败态 + 重试入口；
    //   · 只有确认登出成功（会话确实失效）才推进 authEpoch 并清空 signOutError。
    //   · 绝不在本函数内删除聊天历史磁盘缓存 / 媒体沙盒 / 离线待发原件 /
    //     无主历史健康数据 / 无主历史浏览器记录（正常登出不做破坏性清理）。
    signOut: async () => {
      // 🛡️ X-07：同步重入锁。连续两次调用时，第二次直接返回，不重复执行
      //    profiles 更新 / supabase.auth.signOut()（此时已无会话，会报错或抛异常）。
      if (signOutInFlightRef.current) {
        return { error: { code: 'AUTH_SIGN_OUT_IN_PROGRESS', message: '登出正在进行中' } };
      }
      signOutInFlightRef.current = true;
      setIsIdentityTransitioning(true);
      setSignOutError(null);
      try {
        if (user) {
          await supabase.from('profiles').update({ expo_push_token: null }).eq('id', user.id);
        }
        // C02：登出失败必须显式上报，不能静默当作已登出。
        //      GoTrue 的 signOut 在存储删除失败时同样可能吞异常，
        //      因此这里同时检查返回值与适配器状态位。
        const { error } = await supabase.auth.signOut();
        if (error) {
          const failure = { code: error.code ?? 'AUTH_SIGN_OUT_FAILED', message: error.message ?? String(error) };
          setAuthError(failure);
          setSignOutError(failure);
          return { error };
        }

        // 🔒 T6.1/FIX-04：必须区分「安全副本删除失败」与「明文残留清理失败」。
        //    - UNAVAILABLE：SecureStore 删除失败 → 会话可能仍可被恢复，
        //      登出**未完成**，必须报错并保留故障页。
        //    - LEGACY_CLEANUP_FAILED：安全副本已删除（会话确实已失效），
        //      仅 AsyncStorage 明文残留未清掉 → 登出**已完成**，
        //      不应把用户挡在错误页；只记录状态位供后续清理。
        const failure = authStorageStatus.get();
        if (failure && failure.code === AUTH_STORAGE_ERROR.UNAVAILABLE) {
          const err = { code: failure.code, message: '安全存储删除失败，登出未完成' };
          setAuthError(err);
          setSignOutError(err);
          return { error: err };
        }
        if (failure && failure.code === AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED) {
          // 登出已生效；明文残留属于待清理项，不阻断流程
          console.warn('🔒 登出已完成，但旧明文副本清理失败（待下次清理）:', failure.message);
        }

        // ✅ 登出确认成功：推进身份代际，使所有旧账号在途异步结果失效。
        //    注意：此处只失效内存态，不删除任何磁盘持久化数据。
        bumpAuthEpoch();
        // 🆔 B1-D / B1-E：同步清空下游模块级缓存并推进其代际
        setSignedUrlOwner(null);
        setProfileCacheOwner(null);
        ownerIdRef.current = null;
        sessionRef.current = null;
        // 🛡️ CR-08：登出成功路径必须显式清空 user/session。
        //    因为 onAuthStateChange 中「signOut 在途时忽略 SIGNED_OUT」的守卫
        //    会丢弃 GoTrue 派发的登出事件，若此处不清空，user 将永远停留在
        //    旧账号（登出后仍显示已登录）。由 signOut() 自身掌控终态。
        setSession(null);
        setUser(null);
        setSignOutError(null);
        return { error: null };
      } catch (e) {
        // 🛡️ X-07：任何未预期异常（profiles 更新失败、RLS 拒绝、网络错误等）
        //    都必须被捕获并显式上报，绝不能向上抛出变成 unhandled rejection。
        //    失败分支不推进 authEpoch、不清空 user、不删除本地数据。
        const err = {
          code: e?.code ?? 'AUTH_SIGN_OUT_FAILED',
          message: e?.message ?? String(e),
        };
        console.error('🔒 登出失败:', err.code, err.message);
        setAuthError(err);
        setSignOutError(err);
        return { error: err };
      } finally {
        signOutInFlightRef.current = false;
        setIsIdentityTransitioning(false);
      }
    },
    // 注：signOut 内部直接读 authStorageStatus.get()（需按错误码分流），
    //     不再依赖 syncStorageFailure，故此处不列入依赖。
  }), [user, session, isAuthLoading, authError, retrySession, bumpAuthEpoch, authEpoch, isIdentityTransitioning, signOutError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
// --- END OF FILE src/hooks/useAuth.js ---
