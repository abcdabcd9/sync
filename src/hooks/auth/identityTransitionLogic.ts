/**
 * 身份转移决策（P1.4 R3 — 有界纯逻辑解耦）
 *
 * 从 `src/hooks/useAuth.js` 的 `applySession` 中提取的**纯决策**：
 * 只根据「前一个 owner / 前一个 access_token / 下一个 owner / 下一个
 * access_token / auth 事件名」计算是否需要推进 authEpoch、是否需要
 * 强制下游代际。
 *
 * 严格约束（与迁移前源码逐字等价）：
 *   - 无副作用：不读写 ref、不调用 setState、不触碰任何模块级缓存。
 *   - 无 IO：不 await、不读时钟、不读环境。
 *   - 决策语义与 `applySession` 第 169–175 行完全一致：
 *       ownerChanged = prevOwnerId !== nextOwnerId
 *       isTokenRefresh = event === 'TOKEN_REFRESHED'
 *       tokenRotated = !ownerChanged && !isTokenRefresh && !!nextOwnerId
 *                      && prevAccessToken !== nextAccessToken
 *
 * 副作用（bumpAuthEpoch / setSignedUrlOwner / setProfileCacheOwner /
 * setMediaCacheOwner）仍由调用方 `applySession` 按原顺序执行，
 * 因此本模块的引入不改变任何运行时执行顺序。
 */

/** 身份转移决策输入 */
export interface IdentityTransitionInput {
  /** 上一个已登记的 owner id（`ownerIdRef.current`） */
  prevOwnerId: string | null;
  /** 下一个会话的 owner id（`nextSession?.user?.id ?? null`） */
  nextOwnerId: string | null;
  /** 上一个已登记的 access_token（`sessionRef.current?.access_token ?? null`） */
  prevAccessToken: string | null;
  /** 下一个会话的 access_token（`nextSession?.access_token ?? null`） */
  nextAccessToken: string | null;
  /** Supabase auth 事件名；初始恢复 / 手动调用时为 null */
  event: string | null;
}

/** 身份转移决策结果 */
export interface IdentityTransitionDecision {
  /** owner 是否发生变化（登录 / 登出 / 账号切换） */
  ownerChanged: boolean;
  /** 是否为同账号真实重新登录（A→登出→A，token 变化且非 TOKEN_REFRESHED） */
  tokenRotated: boolean;
  /** 是否需要推进 authEpoch（ownerChanged || tokenRotated） */
  shouldBumpEpoch: boolean;
}

/**
 * 计算身份转移决策。
 *
 * 🛡️ CR-06：正常 JWT 刷新（TOKEN_REFRESHED）不是身份转移。
 *    仅当「非 TOKEN_REFRESHED 事件」且 ownerId 相同但 token 变化时，
 *    才视为「同账号真实重新登录」（A→登出→A）。
 */
export function decideIdentityTransition(
  input: IdentityTransitionInput,
): IdentityTransitionDecision {
  const { prevOwnerId, nextOwnerId, prevAccessToken, nextAccessToken, event } = input;

  const ownerChanged = prevOwnerId !== nextOwnerId;
  const isTokenRefresh = event === 'TOKEN_REFRESHED';
  const tokenRotated =
    !ownerChanged && !isTokenRefresh && !!nextOwnerId && prevAccessToken !== nextAccessToken;

  return {
    ownerChanged,
    tokenRotated,
    shouldBumpEpoch: ownerChanged || tokenRotated,
  };
}
