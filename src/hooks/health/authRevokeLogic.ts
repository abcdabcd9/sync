// --- START OF FILE src/hooks/health/authRevokeLogic.ts ---
/**
 * TASK-P0.2 / T6.2 — FIX-05 Realtime 授权撤销决策逻辑（纯函数，零依赖）
 *
 * 为什么单独成文件：
 *   `useHealthCloud.js` 依赖 React / AsyncStorage / supabase，无法在纯 Node
 *   环境下直接 import 做单元测试。把「是否相关」「是否撤销」这两个纯决策
 *   抽到本文件，既让生产代码与测试共用同一份实现，又避免为测试引入 React
 *   渲染环境。本文件不 import 任何模块，可被 Node 直接加载。
 *
 * 关键约束（FIX-05）：
 *   · **绝不读取 `payload.old.status`** —— 本表未设置 REPLICA IDENTITY FULL，
 *     payload.old 只含主键，读 status 恒为 undefined，会静默丢弃撤销事件。
 *   · 一切以服务端权威复验（get_active_partner_id）结果为准。
 */

/** Realtime 事件负载（仅声明本模块实际读取的字段） */
export interface AuthEventPayload {
  new?: {
    requester_id?: string | null;
    addressee_id?: string | null;
    [key: string]: unknown;
  } | null;
  old?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** get_active_partner_id 复验结果 */
export interface AuthRevokeRpcResult {
  data?: string | null;
  error?: unknown;
}

/** 授权复验协调器 */
export interface RevokeVerifier {
  trigger: () => Promise<void>;
  isVerifying: () => boolean;
}

/**
 * 判断一条 partner_authorizations 的 UPDATE 事件是否与本端当前搭子相关，
 * 需要触发服务端权威复验。
 *
 * @param payload Realtime 事件负载
 * @param pId 当前搭子 id
 * @returns 是否需要向服务端复验
 */
export function isAuthEventRelevant(
  payload: AuthEventPayload | null | undefined,
  pId: string | null | undefined
): boolean {
  if (!pId) return false;
  const next = (payload && payload.new) || {};
  return (
    next.requester_id === pId ||
    next.addressee_id === pId ||
    // payload.new 缺少双方字段时无法排除相关性 → 保守交给服务端复验兜底
    (next.requester_id === undefined && next.addressee_id === undefined)
  );
}

/**
 * 根据服务端权威复验结果，决定是否应撤销本地搭子状态。
 *
 *   · 复验出错（网络异常）→ 保持现状，返回 false（绝不因抖动误删搭子）。
 *   · 服务端仍返回同一 pId → 授权仍有效，返回 false。
 *   · 服务端返回 null 或不同 id → 授权已撤销/变更，返回 true。
 *
 * @param rpcResult get_active_partner_id 结果
 * @param pId 当前搭子 id
 * @returns 是否应触发 onRevoked
 */
export function shouldRevokeOnAuthChange(
  rpcResult: AuthRevokeRpcResult | null | undefined,
  pId: string | null | undefined
): boolean {
  if (!rpcResult || rpcResult.error) return false;
  const activeId = rpcResult.data || null;
  return activeId !== pId;
}

/**
 * 创建「授权复验协调器」，封装 verifying / pending 状态机（T6.2 收尾）。
 *
 * 为什么需要它（竞争缺陷）：
 *   复验 RPC 是异步的。若在复验进行中又收到新事件，旧实现直接 `return` 丢弃，
 *   但当前这次复验的 RPC 可能早于「新事件所代表的状态变更」发出，其返回结果
 *   无法反映最新状态 —— 于是撤销可能被漏掉。
 *
 *   正确语义：复验期间收到新事件 → 标记 pending；当前复验结束后若 pending，
 *   立即再复验一次，直到没有新事件为止（合并连续事件，但绝不丢弃最后一次）。
 *
 * 该协调器与 React 无关，可被 Node 直接测试；生产代码在 useHealthCloud 中
 * 用它包裹真实的 get_active_partner_id 复验。
 *
 * @param deps.verify 执行一次服务端权威复验（返回 get_active_partner_id 结果）
 * @param deps.onResult 每次复验完成后的回调（用于决策是否撤销）
 * @param deps.isStale 代际是否已失效（账号切换/主动解绑）；返回 true 时丢弃结果且不再复验
 */
export function createRevokeVerifier({
  verify,
  onResult,
  isStale = () => false,
}: {
  verify: () => Promise<AuthRevokeRpcResult>;
  onResult: (rpcResult: AuthRevokeRpcResult) => void;
  isStale?: () => boolean;
}): RevokeVerifier {
  let verifying = false;
  let pending = false;

  const run = async (): Promise<void> => {
    if (isStale()) return;
    if (verifying) {
      // 复验进行中：记录「结束后需再复验」，不丢弃该事件
      pending = true;
      return;
    }
    verifying = true;
    try {
      const rpcResult = await verify();
      // 复验往返期间代际可能变化 → 丢弃过期结果
      if (isStale()) return;
      onResult(rpcResult);
    } finally {
      verifying = false;
      // 复验期间收到过新事件 → 立即再复验一次，直到没有新事件为止
      if (pending) {
        pending = false;
        // 不 await：保持与事件回调一致的 fire-and-forget 语义。
        // 但必须挂 catch —— 补充复验是独立 Promise，若 verify() 抛错而无人
        // 接管，会产生 unhandledRejection（Node 下可能直接终止进程）。
        // 这里吞掉异常：状态机已复位，下一次事件仍可正常触发复验。
        run().catch(() => {});
      }
    }
  };

  return {
    trigger: run,
    isVerifying: () => verifying,
  };
}
// --- END OF FILE src/hooks/health/authRevokeLogic.ts ---
