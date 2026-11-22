/**
 * 数据库统一类型入口（TASK-P1.1 R0 / Phase C1）
 *
 * ============================================================================
 * Schema 版本说明（重要，请勿忽略）
 * ============================================================================
 *
 * 本文件描述的是 **Sync-Dev 数据库**（`yfalidyhfqzdwclkveoh`）在
 * **Migrations 00–33 全部应用后**的结构。
 *
 * 生产数据库（`pjiyniqtrstcpnodsnqq`）**尚未应用 Migrations 30–33**，
 * 因此以下对象在生产环境可能不存在或结构不同：
 *   - `friend_accept_events`（migration 33 新建）
 *   - `moments` / `chat_media` 的对象级授权收紧（migration 33，仅策略变化，列不变）
 *   - `friends` 授权收紧（migration 30，仅策略变化，列不变）
 *
 * **另有一处列级差异（已逐环境核对）**：
 *   - `health_records.created_at`：Sync-Dev **存在**（bootstrap 建出），
 *     Production **不存在**（历史库未执行该分支，见 `prod_vs_local_diff.sql`
 *     `DROP COLUMN "created_at"`）。该列在本文件中建模为**可选**，详见
 *     `HealthRecordsRow` 注释。
 *
 * 结论：**本文件不能声称同时精确代表两个环境**。凡涉及 30–33 新增对象或
 * `health_records.created_at`，使用方必须显式判断目标环境。其余列级结构
 * （Row/Insert/Update）在 00–29 范围内两环境一致。
 *
 * ============================================================================
 * 契约来源（逐列核对，非猜测）
 * ============================================================================
 *   - profiles / friends / friend_requests / messages / health_records：
 *       `supabase/migrations/00000000000000_bootstrap_base_schema.sql`
 *       `supabase/migrations/07_补齐5张核心表_create_core_tables.sql`
 *   - moments / complaints：
 *       `supabase/migrations/06_核心表启用RLS基线_enable_all_rls.sql`
 *   - partner_authorizations / partner_authorization_members：
 *       `supabase/migrations/20_独立健康授权模型_partner_authorizations.sql`
 *   - transcribe_quota_windows / transcribe_quota_reservations：
 *       `supabase/migrations/24_语音转写配额表与原子预占RPC_transcribe_quota.sql`
 *   - friend_accept_events：
 *       `supabase/migrations/33_收紧好友动态与媒体对象级授权_tighten_moments_and_media_object_scope.sql`
 *   - health_records.updated_at：
 *       `supabase/migrations/22_修复health_records更新触发器缺列_fix_touch_updated_at.sql`
 *
 * ============================================================================
 * 建模原则（与 Phase B 一致）
 * ============================================================================
 *   1. DEFAULT ≠ NOT NULL：有 DEFAULT 但无 NOT NULL 的列，Row 中允许 null。
 *   2. TEXT ≠ 封闭枚举：无 CHECK 约束的 TEXT 列使用开放字符串类型。
 *   3. 有 CHECK 约束的列（partner_authorizations.status、
 *      transcribe_quota_*.status/scope）使用封闭字面量联合。
 *   4. Row / Insert / Update 分离：Insert 中带 DEFAULT 的列可省略；Update 全可选。
 *   5. JSONB 列（meals_status、images）不假设元素类型，保留宽松形态。
 *
 * 本文件是**唯一**的数据库表结构权威来源。领域类型文件（chat.ts / social.ts /
 * health.ts / user.ts）中的 Row 类型应视为本文件的领域视图，不得独立漂移。
 */

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

/** 开放字符串联合：保留已知值补全，同时允许任意其他字符串 */
type OpenString<Known extends string> = Known | (string & {});

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

/**
 * `profiles` 表行。
 *
 * NOT NULL：id / username / created_at
 * 可空：其余全部
 *
 * 真实 CHECK（生产库）：nickname ≤ 20、motto ≤ 50、sync_id 匹配 `^[A-Za-z0-9_]{3,15}$`
 */
export interface ProfilesRow {
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

export interface ProfilesInsert {
  id: string; // 引用 auth.users(id)，必须显式提供
  username: string;
  avatar_url?: string | null;
  created_at?: string;
  expo_push_token?: string | null;
  bound_partner_id?: string | null;
  sync_id?: string | null;
  nickname?: string | null;
  last_id_modified_at?: string | null;
  public_key?: string | null;
  motto?: string | null;
}

export type ProfilesUpdate = Partial<Omit<ProfilesInsert, 'id'>>;

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/**
 * `messages` 表行。
 *
 * NOT NULL：id / created_at / user_id / type / deleted_by
 * 可空（有 DEFAULT 但无 NOT NULL）：duration / is_read
 * 可空：text / media_url / thumbnail_url / receiver_id / group_id / subtype
 *
 * 依据：migration 07 L59-72（duration INTEGER DEFAULT 0、is_read BOOLEAN DEFAULT false，
 * 均**无 NOT NULL**）+ migration 19（deleted_by UUID[] NOT NULL DEFAULT '{}'）。
 *
 * 注意：`type` 与 `subtype` 均为无 CHECK 约束的 TEXT 列，
 * 因此使用开放字符串类型（详见 chat.ts 的 KnownMessageType/Subtype）。
 */
export interface MessagesRow {
  id: string;
  created_at: string;
  user_id: string;
  text: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  type: string;
  duration: number | null;
  receiver_id: string | null;
  is_read: boolean | null;
  group_id: string | null;
  subtype: string | null;
  deleted_by: string[];
}

export interface MessagesInsert {
  id?: string;
  created_at?: string;
  user_id: string;
  text?: string | null;
  media_url?: string | null;
  thumbnail_url?: string | null;
  type: string;
  duration?: number | null;
  receiver_id?: string | null;
  is_read?: boolean | null;
  group_id?: string | null;
  subtype?: string | null;
  deleted_by?: string[];
}

export type MessagesUpdate = Partial<Omit<MessagesInsert, 'id'>>;

// ---------------------------------------------------------------------------
// friends
// ---------------------------------------------------------------------------

/** `friends.status` 已知值（TEXT NOT NULL DEFAULT 'accepted'，无 CHECK） */
export type KnownFriendsStatus = 'pending' | 'accepted' | 'blocked';
export type FriendsStatus = OpenString<KnownFriendsStatus>;

/**
 * `friends` 表行。
 *
 * NOT NULL：id / user_id / friend_id / status / created_at
 * 可空：remark / is_muted / is_pinned / is_hidden
 */
export interface FriendsRow {
  id: string;
  user_id: string;
  friend_id: string;
  status: FriendsStatus;
  created_at: string;
  remark: string | null;
  is_muted: boolean | null;
  is_pinned: boolean | null;
  is_hidden: boolean | null;
}

export interface FriendsInsert {
  id?: string;
  user_id: string;
  friend_id: string;
  status?: FriendsStatus;
  created_at?: string;
  remark?: string | null;
  is_muted?: boolean | null;
  is_pinned?: boolean | null;
  is_hidden?: boolean | null;
}

export type FriendsUpdate = Partial<Omit<FriendsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// friend_requests
// ---------------------------------------------------------------------------

/** `friend_requests.status` 已知值（TEXT DEFAULT 'pending'，无 CHECK，可空） */
export type KnownFriendRequestsStatus = 'pending' | 'accepted' | 'rejected';
export type FriendRequestsStatus = OpenString<KnownFriendRequestsStatus>;

/**
 * `friend_requests` 表行。
 *
 * NOT NULL：id / sender_id / receiver_id
 * 可空：status / created_at
 */
export interface FriendRequestsRow {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: FriendRequestsStatus | null;
  created_at: string | null;
}

export interface FriendRequestsInsert {
  id?: string;
  sender_id: string;
  receiver_id: string;
  status?: FriendRequestsStatus | null;
  created_at?: string | null;
}

export type FriendRequestsUpdate = Partial<Omit<FriendRequestsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// friend_accept_events（migration 33 — 生产库可能不存在）
// ---------------------------------------------------------------------------

/**
 * `friend_accept_events` 表行。
 *
 * NOT NULL：id / sender_id / receiver_id / accepted_at
 * 可空：request_id
 *
 * 约束：CHECK (sender_id <> receiver_id)；UNIQUE (sender_id, receiver_id)
 *
 * ⚠️ 该表由 migration 33 创建，**生产库尚未应用**。
 */
export interface FriendAcceptEventsRow {
  id: string;
  sender_id: string;
  receiver_id: string;
  request_id: string | null;
  accepted_at: string;
}

export interface FriendAcceptEventsInsert {
  id?: string;
  sender_id: string;
  receiver_id: string;
  request_id?: string | null;
  accepted_at?: string;
}

export type FriendAcceptEventsUpdate = Partial<Omit<FriendAcceptEventsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// health_records
// ---------------------------------------------------------------------------

/**
 * `health_records` 表行。
 *
 * ============================================================================
 * ⚠️ 环境差异（重要，已逐环境核对，非猜测）
 * ============================================================================
 * 两个环境的列结构**确实不同**，本类型以 **Sync-Dev 最终有效 Schema** 为准：
 *
 *   - **Sync-Dev**（`yfalidhqzdwclkveoh`，Migrations 00–33 全应用）：
 *       id / user_id / record_date / water_amount / meals_status /
 *       **created_at** / updated_at
 *       证据：`.internal/refactor/tasks/P0/prod-sync/local_rebuilt_schema.sql`
 *             L1113-1121（同时含 created_at 与 updated_at）
 *
 *   - **Production**（`pjiyniqtrstcpnodsnqq`，仅 00–29）：
 *       id / user_id / record_date / water_amount / meals_status / updated_at
 *       **无 created_at**
 *       证据：`.internal/refactor/tasks/P0/prod-sync/prod_schema_dump.sql`
 *             L267-274；`prod_vs_local_diff.sql` L131-132
 *             `ALTER TABLE health_records DROP COLUMN "created_at"`
 *             （即 local 有、prod 无）
 *
 * 来源链：
 *   - Bootstrap `00_bootstrap_base_schema.sql` L148-155 建表含 created_at
 *   - Migration 07 L132-139 建表含 updated_at（IF NOT EXISTS，对已存在表跳过）
 *   - Migration 22 补 updated_at（幂等 ADD COLUMN IF NOT EXISTS）
 *   → Sync-Dev 由 bootstrap 建出 created_at，再由 07/22 补 updated_at，故两者并存。
 *   → 生产库历史上未执行 bootstrap 的 created_at 分支，故只有 updated_at。
 *
 * 建模决策：`created_at` 建模为 **可选**（`created_at?: string | null`），
 * 使同一类型可安全用于两个环境——生产环境该字段为 `undefined`。
 * 使用方若需读取 created_at，必须先判断目标环境。
 *
 * NOT NULL：id / user_id / record_date
 * 可空：water_amount / meals_status / created_at / updated_at
 *
 * 唯一约束：(user_id, record_date) — useHealthCloud upsert onConflict 依赖。
 *
 * `meals_status` 为 JSONB，默认 `{"早餐": false, "午餐": false, "晚餐": false}`，
 * 但数据库层不保证键集合或值类型，故保留宽松形态。
 */
export interface HealthRecordsRow {
  id: string;
  user_id: string;
  record_date: string;
  water_amount: number | null;
  meals_status: unknown;
  /** Sync-Dev 存在；Production 不存在（见上方环境差异说明） */
  created_at?: string | null;
  updated_at: string | null;
}

export interface HealthRecordsInsert {
  id?: string;
  user_id: string;
  record_date: string;
  water_amount?: number | null;
  meals_status?: unknown;
  /** Sync-Dev 存在；Production 不存在 */
  created_at?: string | null;
  updated_at?: string | null;
}

export type HealthRecordsUpdate = Partial<Omit<HealthRecordsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// moments
// ---------------------------------------------------------------------------

/** `moments.visibility` 已知值（TEXT DEFAULT 'all'，无 CHECK，可空） */
export type KnownMomentsVisibility = 'all' | 'friends' | 'private';
export type MomentsVisibility = OpenString<KnownMomentsVisibility>;

/**
 * `moments` 表行。
 *
 * NOT NULL：id
 * 可空：author_id / content / images / visibility / created_at
 */
export interface MomentsRow {
  id: string;
  author_id: string | null;
  content: string | null;
  images: unknown;
  visibility: MomentsVisibility | null;
  created_at: string | null;
}

export interface MomentsInsert {
  id?: string;
  author_id?: string | null;
  content?: string | null;
  images?: unknown;
  visibility?: MomentsVisibility | null;
  created_at?: string | null;
}

export type MomentsUpdate = Partial<Omit<MomentsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// complaints
// ---------------------------------------------------------------------------

/** `complaints.status` 已知值（TEXT DEFAULT 'pending'，无 CHECK，可空） */
export type KnownComplaintsStatus = 'pending' | 'reviewing' | 'resolved' | 'rejected';
export type ComplaintsStatus = OpenString<KnownComplaintsStatus>;

/**
 * `complaints` 表行。
 *
 * NOT NULL：id
 * 可空：reporter_id / target_id / reason / content / status / created_at
 *
 * **无 `scope` 列**（客户端 complaint.js 携带 scope 属已知差异，不在本批次修复）。
 */
export interface ComplaintsRow {
  id: string;
  reporter_id: string | null;
  target_id: string | null;
  reason: string | null;
  content: string | null;
  status: ComplaintsStatus | null;
  created_at: string | null;
}

export interface ComplaintsInsert {
  id?: string;
  reporter_id?: string | null;
  target_id?: string | null;
  reason?: string | null;
  content?: string | null;
  status?: ComplaintsStatus | null;
  created_at?: string | null;
}

export type ComplaintsUpdate = Partial<Omit<ComplaintsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// partner_authorizations
// ---------------------------------------------------------------------------

/**
 * `partner_authorizations.status`。
 *
 * 该列**有 CHECK 约束**（migration 20 L78-79），因此使用封闭字面量联合。
 */
export type PartnerAuthorizationsStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'revoked';

/**
 * `partner_authorizations` 表行。
 *
 * NOT NULL：id / requester_id / addressee_id / status / created_at / updated_at
 * 可空：expires_at / responded_at
 *
 * 约束：CHECK (requester_id <> addressee_id)
 */
export interface PartnerAuthorizationsRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: PartnerAuthorizationsStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  responded_at: string | null;
}

export interface PartnerAuthorizationsInsert {
  id?: string;
  requester_id: string;
  addressee_id: string;
  status?: PartnerAuthorizationsStatus;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
  responded_at?: string | null;
}

export type PartnerAuthorizationsUpdate = Partial<Omit<PartnerAuthorizationsInsert, 'id'>>;

// ---------------------------------------------------------------------------
// partner_authorization_members
// ---------------------------------------------------------------------------

/**
 * `partner_authorization_members` 表行（复合主键）。
 *
 * NOT NULL：authorization_id / user_id
 *
 * ⚠️ 该表 RLS 默认拒绝，客户端不可见、不可写；仅 service_role 访问。
 * 类型仅供服务端/迁移脚本使用，**不得**作为客户端查询结果类型。
 */
export interface PartnerAuthorizationMembersRow {
  authorization_id: string;
  user_id: string;
}

export interface PartnerAuthorizationMembersInsert {
  authorization_id: string;
  user_id: string;
}

export type PartnerAuthorizationMembersUpdate = Partial<PartnerAuthorizationMembersInsert>;

// ---------------------------------------------------------------------------
// transcribe_quota_windows
// ---------------------------------------------------------------------------

/** `transcribe_quota_windows.scope`（CHECK 约束：'user' | 'global'） */
export type TranscribeQuotaWindowsScope = 'user' | 'global';

/**
 * `transcribe_quota_windows` 表行（复合主键 scope/subject_id/window_start）。
 *
 * NOT NULL：全部列
 *
 * ⚠️ 该表 RLS 默认拒绝，仅 service_role 访问。仅供服务端使用。
 */
export interface TranscribeQuotaWindowsRow {
  scope: TranscribeQuotaWindowsScope;
  subject_id: string;
  window_start: string;
  req_count: number;
  byte_count: number;
  updated_at: string;
}

export interface TranscribeQuotaWindowsInsert {
  scope: TranscribeQuotaWindowsScope;
  subject_id: string;
  window_start: string;
  req_count?: number;
  byte_count?: number;
  updated_at?: string;
}

export type TranscribeQuotaWindowsUpdate = Partial<TranscribeQuotaWindowsInsert>;

// ---------------------------------------------------------------------------
// transcribe_quota_reservations
// ---------------------------------------------------------------------------

/** `transcribe_quota_reservations.status`（CHECK 约束：'reserved' | 'released'） */
export type TranscribeQuotaReservationsStatus = 'reserved' | 'released';

/**
 * `transcribe_quota_reservations` 表行。
 *
 * NOT NULL：reservation_id / user_id / bytes / window_start / status / created_at
 * 可空：released_at
 *
 * 约束：CHECK (bytes > 0)
 *
 * ⚠️ 该表 RLS 默认拒绝，仅 service_role 访问。仅供服务端使用。
 */
export interface TranscribeQuotaReservationsRow {
  reservation_id: string;
  user_id: string;
  bytes: number;
  window_start: string;
  status: TranscribeQuotaReservationsStatus;
  created_at: string;
  released_at: string | null;
}

export interface TranscribeQuotaReservationsInsert {
  reservation_id: string;
  user_id: string;
  bytes: number;
  window_start: string;
  status?: TranscribeQuotaReservationsStatus;
  created_at?: string;
  released_at?: string | null;
}

export type TranscribeQuotaReservationsUpdate = Partial<
  Omit<TranscribeQuotaReservationsInsert, 'reservation_id'>
>;

// ---------------------------------------------------------------------------
// 统一 Database 映射
// ---------------------------------------------------------------------------

/**
 * 数据库表名 → { Row, Insert, Update } 的统一映射。
 *
 * 用途：为未来 Supabase 客户端泛型（`createClient<Database>`）预留结构，
 * 也可作为「表是否已建模」的编译期清单。
 *
 * 注意：本批次**不**接入 Supabase 客户端泛型（避免影响现有 JS 运行时），
 * 仅作为类型契约清单存在。
 */
export interface Database {
  public: {
    Tables: {
      profiles: { Row: ProfilesRow; Insert: ProfilesInsert; Update: ProfilesUpdate };
      messages: { Row: MessagesRow; Insert: MessagesInsert; Update: MessagesUpdate };
      friends: { Row: FriendsRow; Insert: FriendsInsert; Update: FriendsUpdate };
      friend_requests: {
        Row: FriendRequestsRow;
        Insert: FriendRequestsInsert;
        Update: FriendRequestsUpdate;
      };
      friend_accept_events: {
        Row: FriendAcceptEventsRow;
        Insert: FriendAcceptEventsInsert;
        Update: FriendAcceptEventsUpdate;
      };
      health_records: {
        Row: HealthRecordsRow;
        Insert: HealthRecordsInsert;
        Update: HealthRecordsUpdate;
      };
      moments: { Row: MomentsRow; Insert: MomentsInsert; Update: MomentsUpdate };
      complaints: { Row: ComplaintsRow; Insert: ComplaintsInsert; Update: ComplaintsUpdate };
      partner_authorizations: {
        Row: PartnerAuthorizationsRow;
        Insert: PartnerAuthorizationsInsert;
        Update: PartnerAuthorizationsUpdate;
      };
      partner_authorization_members: {
        Row: PartnerAuthorizationMembersRow;
        Insert: PartnerAuthorizationMembersInsert;
        Update: PartnerAuthorizationMembersUpdate;
      };
      transcribe_quota_windows: {
        Row: TranscribeQuotaWindowsRow;
        Insert: TranscribeQuotaWindowsInsert;
        Update: TranscribeQuotaWindowsUpdate;
      };
      transcribe_quota_reservations: {
        Row: TranscribeQuotaReservationsRow;
        Insert: TranscribeQuotaReservationsInsert;
        Update: TranscribeQuotaReservationsUpdate;
      };
    };
  };
}

/** 已建模的表名清单（编译期可枚举） */
export type DatabaseTableName = keyof Database['public']['Tables'];
