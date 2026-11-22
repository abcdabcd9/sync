// --- START OF FILE src/hooks/useAuth.tsx ---
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { supabase, authStorageStatus, AUTH_STORAGE_ERROR, probeAuthStorage } from '../services/supabase';
import { createAutoRefreshController } from '../services/authAutoRefresh';
import type { AppStateLike } from '../services/authAutoRefresh';
import { setSignedUrlOwner } from './chat/useSignedMediaUrl';
import { setProfileCacheOwner } from './profile/useProfileCache';
import { setMediaCacheOwner } from '../services/mediaCache';
import { decideIdentityTransition } from './auth/identityTransitionLogic';
import type {
  AuthContextValue,
  AuthCredentialsResult,
  AuthErrorLike,
  AuthSession,
  AuthUser,
  SignOutResult,
} from '../types/auth';

/**
 * 读取 `e?.code` / `e?.message` 的窄化辅助（仅类型层，无运行时行为）。
 *
 * ⚠️ P1.4 R3-FIX：必须与迁移前 JS 的 `e?.code` / `e?.message` **完全等价**。
 *    迁移前 JS 直接做可选链属性读取，因此：
 *      · 函数对象（`typeof e === 'function'`）同样可以带 code/message，必须能读到；
 *      · 不得引入 `typeof` 过滤或 `key in e` 存在性判断（会改变 Proxy 的 has/get 行为）；
 *      · 不得改变 getter 的读取次数与顺序。
 *    这里只做类型断言，运行时就是一次可选链属性访问。
 */
function readErrField(e: unknown, key: 'code' | 'message'): unknown {
  return (e as { code?: unknown; message?: unknown } | null | undefined)?.[key];
}

/**
 * ⚠️ 与迁移前 `useAuth.js` 严格一致：`createContext()` **不传默认值**。
 *    因此 Provider 之外调用 `useAuth()` 返回 `undefined`（而非抛错），
 *    这是既有运行时契约，不得为「类型正确」而补默认值。
 */
const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** `AuthProvider` 的 props（迁移前为隐式 `{ children }`） */
export interface AuthProviderProps {
  children?: ReactNode;
}

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
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  // null 表示无错误；非 null 表示安全存储/会话恢复失败（含错误码）
  const [authError, setAuthError] = useState<AuthErrorLike | null>(null);

  // 用 ref 保存最新故障态，避免闭包捕获过期值
  const storageFailureRef = useRef<{ code: string; message: unknown } | null>(null);

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

  // ==========================================================================
  // 🔢 TASK-P0.3 / B5-R3：认证事件失效序号（authEventSeq）
  //
  // 为什么需要它（与 authEpoch 的区别）：
  //   · authEpoch 表达「身份代际」——只在**真实身份转移**时自增
  //     （owner 变化 / 同账号重新登录）。它刻意**不**为 TOKEN_REFRESHED 推进。
  //   · 但「认证事件的发生顺序」比「身份代际」更细：
  //       - 原本无 owner 时收到 SIGNED_OUT：owner 仍是 null，epoch 不变，
  //         可它确实是一个**更新的、被采纳的认证事件**；
  //       - 同账号 TOKEN_REFRESHED：epoch 不变，但它同样晚于更早的 getSession()。
  //     仅靠 epoch 比对无法判定「某个异步会话读取结果是否已被更晚的认证事件取代」。
  //
  // 语义（严格单调递增，只增不减，同步读写，不触发渲染）：
  //   · 任何**被采纳**的认证事件（onAuthStateChange 中通过既有安全过滤之后）
  //     都会自增一次；
  //   · signOut() 确认成功时自增一次（其 SIGNED_OUT 事件被 CR-08 过滤掉，
  //     由 signOut 自身掌控终态，故在此处补记）；
  //   · 异步会话读取（初始化 getSession / retrySession）在**发起时**快照该序号，
  //     结果回来时若序号已变化，说明期间有更晚的认证事件被采纳，
  //     本次结果属于已被取代的旧快照，必须整体丢弃（含 catch / finally）。
  //
  // 优先级约定（避免两套状态机冲突）：
  //   authEventSeq 只用于「异步读取结果是否过期」的判定；
  //   authEpoch 仍只用于「身份作用域数据隔离」。
  //   二者互不替代：序号变化**不**推进 epoch，epoch 推进时序号也必然已推进。
  // ==========================================================================
  const authEventSeqRef = useRef(0);

  /** 推进认证事件失效序号（同步、幂等安全）。返回新序号。 */
  const bumpAuthEventSeq = useCallback(() => {
    authEventSeqRef.current += 1;
    return authEventSeqRef.current;
  }, []);

  // 当前身份 ownerId 的 ref 镜像（供异步回调同步比对，避免闭包过期）
  const ownerIdRef = useRef<string | null>(null);

  // 当前 session 的 ref 镜像（用于检测同账号 token 轮换）
  const sessionRef = useRef<AuthSession | null>(null);

  // 身份转移进行中标记：登出/切换期间为 true，用于 UI 冻结旧账号敏感数据
  const [isIdentityTransitioning, setIsIdentityTransitioning] = useState(false);

  // 🛡️ X-07：登出重入锁（同步、ref）。
  //    state 的 isIdentityTransitioning 是异步更新的，连续两次 signOut 时第二次
  //    读到的仍是旧值，无法阻止重入。用 ref 做同步锁，确保同一时刻只有一次登出在跑。
  const signOutInFlightRef = useRef(false);

  // 登出失败显式状态：非 null 表示上次登出未完成（不得跳转登录页 / 不得切号）
  const [signOutError, setSignOutError] = useState<AuthErrorLike | null>(null);

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
      setAuthError({ code: failure.code, message: failure.message as string });
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
   * @param nextSession
   * @param event Supabase auth 事件名（SIGNED_IN / TOKEN_REFRESHED / ...）
   *
   * ⚠️ 同步执行：不 await 任何网络/磁盘操作，避免阻塞 GoTrue 事件队列。
   */
  const applySession = useCallback(
    (nextSession: AuthSession | null, event: string | null = null) => {
      const nextUser = nextSession?.user || null;
      const nextOwnerId = nextUser?.id ?? null;
      const prevOwnerId = ownerIdRef.current;
      const prevAccessToken = sessionRef.current?.access_token ?? null;
      const nextAccessToken = nextSession?.access_token ?? null;

      // 🛡️ CR-06：身份转移决策已提取为纯函数（无副作用、无 IO），
      //    决策语义与迁移前逐字等价；副作用仍在本函数内按原顺序执行。
      const { ownerChanged, tokenRotated, shouldBumpEpoch } = decideIdentityTransition({
        prevOwnerId,
        nextOwnerId,
        prevAccessToken,
        nextAccessToken,
        event,
      });

      if (shouldBumpEpoch) {
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
        // 🗄️ B2：沙盒媒体写入闸门同步登记身份（仅作迟到写回校验，不改索引键）。
        setMediaCacheOwner(nextOwnerId);
      } else if (tokenRotated) {
        setSignedUrlOwner(nextOwnerId, true);
        setProfileCacheOwner(nextOwnerId, true);
        setMediaCacheOwner(nextOwnerId, true);
      }

      ownerIdRef.current = nextOwnerId;
      sessionRef.current = nextSession ?? null;
      setSession(nextSession);
      setUser(nextUser);
    },
    [bumpAuthEpoch],
  );

  // 重新尝试恢复会话（供错误页「重试」按钮调用）
  const retrySession = useCallback(async () => {
    // 🛡️ B5-R3 / L4-FINAL-01：发起时快照认证事件序号。
    //    getSession() 可能长时间挂起；期间若发生更晚的认证事件（如 B 登录），
    //    本次重试结果即属于已被取代的旧快照，必须整体丢弃 —— 包括
    //    不得 applySession（否则回滚 user 并推进 epoch）、不得写 authError、
    //    不得改 isAuthLoading（否则会覆盖新会话的 loading 终态）。
    const retrySeqSnapshot = authEventSeqRef.current;
    const isStale = () => authEventSeqRef.current !== retrySeqSnapshot;

    setIsAuthLoading(true);
    setAuthError(null);
    try {
      const { data, error } = await supabase!.auth.getSession();
      if (isStale()) return;
      if (error) throw error;
      // C02：SDK 可能吞掉存储异常并返回 session:null，必须复查状态位
      if (syncStorageFailure()) return;
      applySession((data?.session ?? null) as AuthSession | null);
    } catch (e) {
      if (isStale()) return;
      // 显式失败：保留 authError，不把用户当作已登出
      console.error('🔒 会话恢复失败（安全存储不可用）:', readErrField(e, 'code') ?? readErrField(e, 'message') ?? e);
      setAuthError({
        code: (readErrField(e, 'code') as string | undefined) ?? 'AUTH_SESSION_RESTORE_FAILED',
        message: (readErrField(e, 'message') as string | undefined) ?? String(e),
      });
    } finally {
      if (!isStale()) setIsAuthLoading(false);
    }
  }, [applySession, syncStorageFailure]);

  useEffect(() => {
    let cancelled = false;

    // 🛡️ B5-R3 / L4-FINAL-02：初始化 getSession() 的「陈旧结果守卫」。
    //    getSession() 是异步的；在其挂起期间，onAuthStateChange 可能已派发
    //    一次更新的认证事件。仅比对 authEpoch 不足以覆盖全部情形：
    //      · B 登录 → epoch 推进，可检测；
    //      · 原本无 owner 时收到 SIGNED_OUT → owner 仍为 null、epoch 不变，
    //        但它是**更新的、被采纳的认证事件**，旧 init 结果必须失效；
    //      · 同账号 TOKEN_REFRESHED → epoch 不变，同样晚于更早的 getSession()。
    //    因此改用「认证事件失效序号」快照：任何被采纳的认证事件都会自增序号。
    //    then / catch / finally 三处均受该守卫约束，避免旧请求覆盖新会话的
    //    user / authError / isAuthLoading 终态。
    const initSeqSnapshot = authEventSeqRef.current;
    const isInitStale = () => authEventSeqRef.current !== initSeqSnapshot;

    // 1. 初始化时获取当前缓存的会话（必须捕获失败，避免永久 loading）
    supabase!.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        // 🛡️ B5-R3：若挂起期间已有更晚的认证事件被采纳，本次结果属于旧快照，丢弃。
        if (isInitStale()) return;
        if (error) throw error;
        // C02：优先信任适配器状态位 —— GoTrue 会吞掉存储异常
        if (syncStorageFailure()) return;
        applySession((data?.session ?? null) as AuthSession | null);
        setAuthError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 🛡️ B5-R3：旧请求的失败不得覆盖新会话的错误状态。
        if (isInitStale()) return;
        console.error('🔒 会话恢复失败（安全存储不可用）:', readErrField(e, 'code') ?? readErrField(e, 'message') ?? e);
        setAuthError({
          code: (readErrField(e, 'code') as string | undefined) ?? 'AUTH_SESSION_RESTORE_FAILED',
          message: (readErrField(e, 'message') as string | undefined) ?? String(e),
        });
      })
      .finally(() => {
        if (cancelled) return;
        // 🛡️ B5-R3：旧请求的完成不得覆盖新会话的 loading 终态。
        if (isInitStale()) return;
        setIsAuthLoading(false);
      });

    // 2. 监听全局 Auth 状态变化（登录、登出、Token刷新自动触发）
    //    🛡️ CR-06：把 event 透传给 applySession，用于区分「正常 token 刷新」
    //    与「真实身份转移」，避免把每次 TOKEN_REFRESHED 都当作新会话。
    const { data: { subscription } } = supabase!.auth.onAuthStateChange((event, nextSession) => {
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

      // 🛡️ B5-R3：任何**被采纳**的认证事件都推进失效序号（在全部安全过滤之后）。
      //    这样即使该事件不推进 authEpoch（如无 owner 时的 SIGNED_OUT、
      //    同账号 TOKEN_REFRESHED），也能使更早的 getSession()/retrySession()
      //    结果失效，避免旧异步快照回滚当前身份。
      bumpAuthEventSeq();

      applySession(nextSession as AuthSession | null, event);
      // 成功拿到状态变化且存储健康 → 清除历史错误
      setAuthError(null);
      setIsAuthLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [applySession, syncStorageFailure, bumpAuthEventSeq]);

  // ==========================================================================
  // 🔄 P0.3 iOS-01：Supabase Auth 自动刷新生命周期（AppState 驱动）
  //
  // 缺陷根因（真实 SDK 探针 P1–P9 已复现）：
  //   `@supabase/auth-js` 在非浏览器环境（React Native）的
  //   `_handleVisibilityChange()` 分支为 `if (autoRefreshToken) startAutoRefresh()`，
  //   即「假定永远在前台」，ticker 一旦启动就永不停。
  //   App 长时间切后台 → iOS 锁定 Keychain → `SecureStore.getItemAsync` 抛错 →
  //   适配器置位 AUTH_STORAGE_UNAVAILABLE → 每次 tick 都打印
  //   `Auto refresh tick failed with error.`（用户可见的稳定报错）。
  //
  // 修复（Supabase 官方 RN 推荐做法，不关闭自动刷新）：
  //   · 唯一一个 AppState 监听器；
  //   · 'active' → startAutoRefresh()；'background'/'inactive' → stopAutoRefresh()；
  //   · 冷启动按当前状态初始化；重复切换幂等；卸载时移除监听并停止 ticker。
  //
  // 约束：
  //   · 不修改凭证存储方式（storage / storageKey / persistSession 均不动）；
  //   · 不绕过 AUTH_STORAGE_UNAVAILABLE 检测（本 effect 不触碰 authStorageStatus）；
  //   · 不吞异常（控制器 onError 会 console.error 上报）。
  // ==========================================================================
  useEffect(() => {
    // 配置无效时 supabase 为 null，RootLayout 已提前拦截，这里做防御性跳过。
    if (!supabase?.auth) return undefined;

    const controller = createAutoRefreshController({
      auth: supabase.auth,
      // 迁移前 JS 直接传 RN 的 AppState；其 `currentState` 类型为
      // `string | null | undefined`，而控制器只读 `currentState` 做分支判断。
      // 这里仅做类型断言，运行时对象与迁移前完全一致。
      appState: AppState as unknown as AppStateLike,
      // 🍎 BUG-02（iOS-01 残留）：进入 active 时先探测 SecureStore 是否可用，
      //    避免 iOS 解锁后 Keychain 短暂锁定窗口内立即 startAutoRefresh()
      //    导致首个 tick 读 SecureStore 抛 `User interaction is not allowed`。
      //    探测失败由控制器延迟重试，期间不启动 ticker（不产生失败 tick）。
      probeStorage: probeAuthStorage,
    });
    controller.start();

    return () => {
      controller.dispose();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
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
    // 迁移前 JS 直接透传 SDK 返回值；这里仅做类型断言以匹配本地契约，
    // 运行时返回值对象与迁移前逐字段一致（不复制、不改造）。
    signIn: async (email: string, password: string) =>
      (await supabase!.auth.signInWithPassword({ email, password })) as unknown as AuthCredentialsResult,
    signUp: async (email: string, password: string) =>
      (await supabase!.auth.signUp({ email, password })) as unknown as AuthCredentialsResult,

    // 🍎 核心安全修复：退出登录前，先将数据库中的设备推送令牌抹除，彻底切断幽灵推送！
    //
    // 🛡️ TASK-P0.3 / B1-A 登出失败安全：
    //   · 登出开始即置 isIdentityTransitioning=true，冻结旧账号敏感 UI；
    //   · 任何失败分支都**不得**推进 authEpoch、不得清空 user、不得删除本地持久化文件，
    //     并显式写入 signOutError，供上层展示失败态 + 重试入口；
    //   · 只有确认登出成功（会话确实失效）才推进 authEpoch 并清空 signOutError。
    //   · 绝不在本函数内删除聊天历史磁盘缓存 / 媒体沙盒 / 离线待发原件 /
    //     无主历史健康数据 / 无主历史浏览器记录（正常登出不做破坏性清理）。
    signOut: async (): Promise<SignOutResult> => {
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
          await supabase!.from('profiles').update({ expo_push_token: null }).eq('id', user.id);
        }
        // C02：登出失败必须显式上报，不能静默当作已登出。
        //      GoTrue 的 signOut 在存储删除失败时同样可能吞异常，
        //      因此这里同时检查返回值与适配器状态位。
        const { error } = await supabase!.auth.signOut();
        if (error) {
          // ⚠️ P1.4 R3-FIX：内部规范化 failure 与对外透传 error 是**两个不同用途**。
          //    · failure：写入 authError / signOutError 状态，供 UI 展示（code/message 兜底）；
          //    · error：原样返回给调用方，必须保持 SDK 原始对象引用与全部附加字段
          //      （status / name / detail 等），不得克隆、重建或删字段。
          const failure = { code: error.code ?? 'AUTH_SIGN_OUT_FAILED', message: error.message ?? String(error) };
          setAuthError(failure);
          setSignOutError(failure);
          // 仅类型层断言：运行时就是原样返回同一个 SDK error 对象。
          return { error: error as unknown as AuthErrorLike };
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
        // 🛡️ B5-R3：登出成功同样是一个「被采纳的认证事件」。
        //    其 SIGNED_OUT 事件已被 CR-08 过滤（signOut 在途时忽略），
        //    故在此补记失效序号，确保更早的 getSession()/retrySession() 结果失效。
        bumpAuthEventSeq();
        // 🆔 B1-D / B1-E：同步清空下游模块级缓存并推进其代际
        setSignedUrlOwner(null);
        setProfileCacheOwner(null);
        // 🗄️ B2：沙盒写入闸门同步失效（不删除磁盘文件，保留合法离线缓存）
        setMediaCacheOwner(null);
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
          code: (readErrField(e, 'code') as string | undefined) ?? 'AUTH_SIGN_OUT_FAILED',
          message: (readErrField(e, 'message') as string | undefined) ?? String(e),
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
    // 🛡️ B5-R3：signOut 成功路径调用 bumpAuthEventSeq()，需列入依赖。
  }), [user, session, isAuthLoading, authError, retrySession, bumpAuthEpoch, bumpAuthEventSeq, authEpoch, isIdentityTransitioning, signOutError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
// --- END OF FILE src/hooks/useAuth.tsx ---
