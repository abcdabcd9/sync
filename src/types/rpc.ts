/**
 * RPC 契约（TASK-P1.1 R0 / Phase C2）
 *
 * ============================================================================
 * 契约来源（逐函数核对签名与返回类型，非猜测）
 * ============================================================================
 *   - get_server_time / delete_my_account：
 *       `supabase/migrations/09_补齐缺失RPC函数_missing_rpcs.sql`
 *   - get_active_partner_id / request_partner / accept_partner_invite /
 *     reject_partner_invite / cancel_partner_invite / revoke_partner_authorization /
 *     unbind_partner：
 *       `supabase/migrations/20_独立健康授权模型_partner_authorizations.sql`
 *       `supabase/migrations/32_修复unbind_partner不写text_fix_unbind_text_guard.sql`
 *   - delete_conversation：
 *       `supabase/migrations/19_会话软删除_仅删我方视角_soft_delete_conversation.sql`
 *   - end_cinema_invite / end_cinema_invites_by_room：
 *       `supabase/migrations/29_放映厅邀请卡片状态迁移_cinema_invite_status_transition.sql`
 *   - transcribe_quota_reserve / transcribe_quota_release / transcribe_quota_cleanup：
 *       `supabase/migrations/24_语音转写配额表与原子预占RPC_transcribe_quota.sql`
 *       `supabase/migrations/26_配额清理改为低频非阻塞_transcribe_quota_cleanup.sql`
 *
 * ============================================================================
 * 分类原则（重要）
 * ============================================================================
 *   1. **客户端可调用**（GRANT EXECUTE TO authenticated）：客户端可通过
 *      `supabase.rpc(...)` 调用。本文件以 `ClientRpc*` 命名。
 *   2. **服务端/内部函数**（仅 GRANT TO service_role，或触发器函数）：
 *      **不得**作为普通客户端 API 暴露。本文件以 `InternalRpc*` 命名，
 *      并明确标注「仅供服务端/迁移脚本」。
 *   3. 触发器函数（RETURNS TRIGGER）不属于 RPC 契约，不在此声明。
 *
 * ============================================================================
 * Schema 版本说明
 * ============================================================================
 *   本文件描述 Sync-Dev（Migrations 00–33 全应用）的 RPC 契约。
 *   生产库尚未应用 Migrations 30–33，但本文件列出的 RPC 均在 00–29 范围内，
 *   两环境签名一致（end_cinema_* 来自 29，生产库已应用）。
 */

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/**
 * Supabase RPC 调用结果（与 `supabase.rpc()` 返回结构对齐）。
 *
 * 说明：`data` 为函数 RETURNS 值；`error` 为 PostgREST 错误对象。
 * 本类型仅描述边界形态，不替代 `@supabase/supabase-js` 自带类型。
 */
export interface RpcResult<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
}

// ===========================================================================
// 一、客户端可调用 RPC（GRANT EXECUTE TO authenticated）
// ===========================================================================

// ---------------------------------------------------------------------------
// get_server_time() → TIMESTAMPTZ
// ---------------------------------------------------------------------------

/**
 * 获取服务器 UTC 时间。
 *
 * 签名：`get_server_time() RETURNS TIMESTAMPTZ`
 * 授权：GRANT EXECUTE TO anon, authenticated
 *
 * 返回：ISO 8601 时间字符串（PostgREST 将 TIMESTAMPTZ 序列化为 string）。
 */
export type ClientRpcGetServerTime = () => Promise<RpcResult<string>>;

// ---------------------------------------------------------------------------
// delete_my_account() → void
// ---------------------------------------------------------------------------

/**
 * 注销当前登录账号（仅删 auth.uid() 自己）。
 *
 * 签名：`delete_my_account() RETURNS void`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 未登录时抛异常（ERRCODE 28000）。
 */
export type ClientRpcDeleteMyAccount = () => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// get_active_partner_id() → UUID | NULL
// ---------------------------------------------------------------------------

/**
 * 获取当前用户的有效搭子 ID。
 *
 * 签名：`get_active_partner_id() RETURNS UUID`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 返回：对方 user_id；无有效关系时为 null。
 */
export type ClientRpcGetActivePartnerId = () => Promise<RpcResult<string | null>>;

// ---------------------------------------------------------------------------
// request_partner(target_user_id UUID) → UUID
// ---------------------------------------------------------------------------

/**
 * 发起搭子邀请。
 *
 * 签名：`request_partner(target_user_id UUID) RETURNS UUID`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 返回：新建的 partner_authorizations.id。
 * 失败场景（抛异常）：
 *   - 未登录（28000）
 *   - target 为空/自己/不存在（22023）
 *   - 已有有效关系（23505）
 */
export type ClientRpcRequestPartner = (targetUserId: string) => Promise<RpcResult<string>>;

// ---------------------------------------------------------------------------
// accept_partner_invite(auth_id UUID) → void
// ---------------------------------------------------------------------------

/**
 * 接受搭子邀请（仅被邀请方）。
 *
 * 签名：`accept_partner_invite(auth_id UUID) RETURNS void`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 失败场景（抛异常）：
 *   - 未登录（28000）
 *   - 邀请不存在（22023）
 *   - 非被邀请方（42501）
 */
export type ClientRpcAcceptPartnerInvite = (authId: string) => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// reject_partner_invite(auth_id UUID) → void
// ---------------------------------------------------------------------------

/**
 * 拒绝搭子邀请（仅被邀请方）。
 *
 * 签名：`reject_partner_invite(auth_id UUID) RETURNS void`
 * 授权：GRANT EXECUTE TO authenticated
 */
export type ClientRpcRejectPartnerInvite = (authId: string) => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// cancel_partner_invite(auth_id UUID) → void
// ---------------------------------------------------------------------------

/**
 * 取消待决邀请（仅申请者）。
 *
 * 签名：`cancel_partner_invite(auth_id UUID) RETURNS void`
 * 授权：GRANT EXECUTE TO authenticated
 */
export type ClientRpcCancelPartnerInvite = (authId: string) => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// revoke_partner_authorization() → void
// ---------------------------------------------------------------------------

/**
 * 撤销有效搭子关系（任一方）。
 *
 * 签名：`revoke_partner_authorization() RETURNS void`
 * 授权：GRANT EXECUTE TO authenticated
 */
export type ClientRpcRevokePartnerAuthorization = () => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// unbind_partner(target_partner_id UUID) → void
// ---------------------------------------------------------------------------

/**
 * 兼容旧签名的解绑（内部走新授权模型）。
 *
 * 签名：`unbind_partner(target_partner_id UUID) RETURNS void`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 语义（migration 32）：只解除「自己与 target 之间」的有效关系；
 * 不存在该关系时不清任何指针。
 */
export type ClientRpcUnbindPartner = (targetPartnerId: string) => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// delete_conversation(p_partner_id UUID) → BIGINT
// ---------------------------------------------------------------------------

/**
 * 软删除会话（仅删我方视角）。
 *
 * 签名：`delete_conversation(p_partner_id UUID) RETURNS BIGINT`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 返回：受影响行数。
 * 失败场景：未登录（28000）、参数非法。
 */
export type ClientRpcDeleteConversation = (partnerId: string) => Promise<RpcResult<number>>;

// ---------------------------------------------------------------------------
// end_cinema_invite(p_message_id UUID) → INTEGER
// ---------------------------------------------------------------------------

/**
 * 结束单条放映厅邀请卡片。
 *
 * 签名：`end_cinema_invite(p_message_id UUID) RETURNS INTEGER`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 返回：更新行数。
 */
export type ClientRpcEndCinemaInvite = (messageId: string) => Promise<RpcResult<number>>;

// ---------------------------------------------------------------------------
// end_cinema_invites_by_room(p_room_id TEXT) → INTEGER
// ---------------------------------------------------------------------------

/**
 * 按房间结束所有放映厅邀请卡片。
 *
 * 签名：`end_cinema_invites_by_room(p_room_id TEXT) RETURNS INTEGER`
 * 授权：GRANT EXECUTE TO authenticated
 *
 * 返回：更新行数。
 */
export type ClientRpcEndCinemaInvitesByRoom = (roomId: string) => Promise<RpcResult<number>>;

// ===========================================================================
// 二、服务端/内部 RPC（仅 service_role，禁止客户端调用）
// ===========================================================================

// ---------------------------------------------------------------------------
// transcribe_quota_reserve(...) → UUID
// ---------------------------------------------------------------------------

/**
 * 原子预占转写配额。
 *
 * 签名：
 *   `transcribe_quota_reserve(
 *      p_user_id UUID,
 *      p_bytes BIGINT,
 *      p_max_requests INTEGER,
 *      p_max_bytes BIGINT,
 *      p_global_max_requests INTEGER,
 *      p_global_max_bytes BIGINT,
 *      p_window_seconds INTEGER DEFAULT 60
 *    ) RETURNS UUID`
 * 授权：**仅 service_role**（REVOKE FROM authenticated）
 *
 * 返回：reservation_id；配额不足时返回 null。
 *
 * ⚠️ 仅供 `transcribe-audio` Edge Function 使用，**不得**暴露给客户端。
 */
export interface InternalRpcTranscribeQuotaReserveArgs {
  p_user_id: string;
  p_bytes: number;
  p_max_requests: number;
  p_max_bytes: number;
  p_global_max_requests: number;
  p_global_max_bytes: number;
  p_window_seconds?: number;
}

export type InternalRpcTranscribeQuotaReserve = (
  args: InternalRpcTranscribeQuotaReserveArgs
) => Promise<RpcResult<string | null>>;

// ---------------------------------------------------------------------------
// transcribe_quota_release(...) → BOOLEAN
// ---------------------------------------------------------------------------

/**
 * 幂等释放转写配额预占。
 *
 * 签名：`transcribe_quota_release(p_reservation_id UUID, p_user_id UUID) RETURNS BOOLEAN`
 * 授权：**仅 service_role**
 *
 * 返回：是否实际释放（已释放过返回 false）。
 *
 * ⚠️ 仅供 Edge Function 使用。
 */
export interface InternalRpcTranscribeQuotaReleaseArgs {
  p_reservation_id: string;
  p_user_id: string;
}

export type InternalRpcTranscribeQuotaRelease = (
  args: InternalRpcTranscribeQuotaReleaseArgs
) => Promise<RpcResult<boolean>>;

// ---------------------------------------------------------------------------
// transcribe_quota_cleanup(...) → INTEGER
// ---------------------------------------------------------------------------

/**
 * 清理过期配额窗口与预占记录。
 *
 * 签名：
 *   `transcribe_quota_cleanup(
 *      p_window_seconds INTEGER DEFAULT 60,
 *      p_keep_windows INTEGER DEFAULT 2,
 *      p_keep_reservations_seconds INTEGER DEFAULT 3600
 *    ) RETURNS INTEGER`
 * 授权：**仅 service_role**
 *
 * 返回：清理行数。
 *
 * ⚠️ 仅供定时任务/Edge Function 使用。
 */
export interface InternalRpcTranscribeQuotaCleanupArgs {
  p_window_seconds?: number;
  p_keep_windows?: number;
  p_keep_reservations_seconds?: number;
}

export type InternalRpcTranscribeQuotaCleanup = (
  args?: InternalRpcTranscribeQuotaCleanupArgs
) => Promise<RpcResult<number>>;

// ---------------------------------------------------------------------------
// lock_profile_pair(a UUID, b UUID) → void
// ---------------------------------------------------------------------------

/**
 * 固定顺序锁两个 profile 行（防死锁）。
 *
 * 签名：`lock_profile_pair(a UUID, b UUID) RETURNS void`
 * 授权：**仅 service_role**
 *
 * ⚠️ 内部辅助函数，仅供其他 SECURITY DEFINER 函数调用。
 */
export interface InternalRpcLockProfilePairArgs {
  a: string;
  b: string;
}

export type InternalRpcLockProfilePair = (
  args: InternalRpcLockProfilePairArgs
) => Promise<RpcResult<null>>;

// ---------------------------------------------------------------------------
// purge_partner_authorizations_for(target_user_id UUID) → void
// ---------------------------------------------------------------------------

/**
 * 清理某用户的全部搭子授权（账号注销/内部维护用）。
 *
 * 签名：`purge_partner_authorizations_for(target_user_id UUID) RETURNS void`
 * 授权：**仅 service_role**
 *
 * ⚠️ 内部维护函数，不得暴露给客户端。
 */
export type InternalRpcPurgePartnerAuthorizationsFor = (
  targetUserId: string
) => Promise<RpcResult<null>>;

// ===========================================================================
// 三、RPC 名称 → 契约 映射（编译期清单）
// ===========================================================================

/**
 * 客户端可调用 RPC 名称清单。
 *
 * 用途：作为「哪些 RPC 允许客户端调用」的编译期白名单，
 * 防止误把内部函数暴露给客户端。
 */
export type ClientRpcName =
  | 'get_server_time'
  | 'delete_my_account'
  | 'get_active_partner_id'
  | 'request_partner'
  | 'accept_partner_invite'
  | 'reject_partner_invite'
  | 'cancel_partner_invite'
  | 'revoke_partner_authorization'
  | 'unbind_partner'
  | 'delete_conversation'
  | 'end_cinema_invite'
  | 'end_cinema_invites_by_room';

/**
 * 服务端/内部 RPC 名称清单。
 *
 * 用途：明确「这些函数禁止客户端调用」。
 */
export type InternalRpcName =
  | 'transcribe_quota_reserve'
  | 'transcribe_quota_release'
  | 'transcribe_quota_cleanup'
  | 'lock_profile_pair'
  | 'purge_partner_authorizations_for';
