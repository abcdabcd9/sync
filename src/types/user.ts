/**
 * 用户 / 资料契约（TASK-P1.1 R0）
 *
 * 依据（真实 schema）：
 *   - `supabase/migrations/00000000000000_bootstrap_base_schema.sql` 的 `profiles`
 *   - `supabase/migrations/07_补齐5张核心表_create_core_tables.sql`
 *   - `supabase/migrations/04_SyncID修改频率限制触发器_sync_id_limit_trigger.sql`（nickname/motto）
 *   - `.internal/refactor/tasks/P0/prod-sync/prod_schema_dump.sql`（生产库权威结构 + CHECK 约束）
 *   - `src/hooks/profile/useProfileCache.js#normalizeProfile`（客户端派生字段）
 *
 * 真实 CHECK 约束（生产库）：
 *   - `nickname` 长度 ≤ 20
 *   - `motto`    长度 ≤ 50
 *   - `sync_id`  匹配 `^[A-Za-z0-9_]{3,15}$`
 */

/** 品牌化 SyncId（运行时仍是 string，仅编译期区分） */
export type SyncId = string & { readonly __brand: 'SyncId' };

/** SyncId 的格式约束（与数据库 CHECK 一致） */
export const SYNC_ID_PATTERN = /^[A-Za-z0-9_]{3,15}$/;

/** SyncId 长度上下限（与数据库 CHECK 一致） */
export const SYNC_ID_MIN_LENGTH = 3;
export const SYNC_ID_MAX_LENGTH = 15;

/** nickname 最大长度（与数据库 CHECK 一致） */
export const NICKNAME_MAX_LENGTH = 20;

/** motto 最大长度（与数据库 CHECK 一致） */
export const MOTTO_MAX_LENGTH = 50;

/**
 * `profiles` 表行（数据库原始形态）。
 *
 * 字段可空性严格对应 schema：
 *   - NOT NULL：id / username / created_at
 *   - 其余均可空
 */
export interface ProfileRow {
  id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
  expo_push_token: string | null;
  bound_partner_id: string | null;
  sync_id: string | null;
  nickname: string | null;
  last_id_modified_at: string | null;
  public_key: string | null;
  motto: string | null;
}

/**
 * 客户端规范化后的资料对象（`normalizeProfile` 的返回）。
 *
 * 与 `ProfileRow` 的差异：
 *   - `sync_id` / `nickname` 回退到 `username`
 *   - 额外派生 `bound_partner_nickname`
 */
export interface NormalizedProfile {
  id: string;
  username: string;
  avatar_url: string | null;
  created_at: string;
  expo_push_token: string | null;
  bound_partner_id: string | null;
  sync_id: string;
  nickname: string;
  last_id_modified_at: string | null;
  public_key: string | null;
  motto: string | null;
  /** 伴侣昵称（由关联查询派生，可能为空） */
  bound_partner_nickname: string | null;
}

/** 伴侣绑定状态（客户端展示用） */
export type PartnerStatus = 'none' | 'pending' | 'bound';

/**
 * `partner_authorizations` 表行。
 *
 * 依据 `supabase/migrations/20_独立健康授权模型_partner_authorizations.sql`。
 * status 受 CHECK 约束限制。
 */
export type PartnerAuthorizationStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'revoked';

export interface PartnerAuthorizationRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: PartnerAuthorizationStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  responded_at: string | null;
}

/** `partner_authorization_members` 表行（复合主键） */
export interface PartnerAuthorizationMemberRow {
  authorization_id: string;
  user_id: string;
}
