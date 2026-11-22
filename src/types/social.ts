/**
 * 社交契约：好友 / 好友请求 / 好友接受事件 / 动态 / 投诉（TASK-P1.1 R0）
 *
 * 依据（真实 schema，逐列核对）：
 *   - `friends` / `friend_requests`：
 *       bootstrap `00000000000000_bootstrap_base_schema.sql` L116-179
 *       migration `07_补齐5张核心表_create_core_tables.sql` L89-127
 *   - `moments` / `complaints`：migration `06_核心表启用RLS基线_enable_all_rls.sql` L172-205
 *   - `friend_accept_events`：
 *       migration `33_收紧好友动态与媒体对象级授权_tighten_moments_and_media_object_scope.sql` L93-110
 *
 * 关键契约原则（本批次强制）：
 *   1. **DEFAULT ≠ NOT NULL**：`status` / `visibility` / `created_at` 等列虽有 DEFAULT，
 *      但未声明 NOT NULL，因此 Row 类型中必须允许 `null`。
 *   2. **TEXT ≠ 封闭枚举**：`friends.status` / `friend_requests.status` /
 *      `moments.visibility` / `complaints.status` 均为无 CHECK 约束的 TEXT 列，
 *      历史数据可能含非标准值。因此使用「已知值 + 开放字符串」的开放联合类型，
 *      而非封闭字面量联合。
 *   3. **Row / Insert / Update 不是同一类型**：Insert 中带 DEFAULT 的列可省略，
 *      Update 全部可选。
 *   4. **JSONB ≠ 已验证数据模型**：`moments.images` 为 JSONB，客户端按字符串数组使用，
 *      但数据库层不保证元素类型，故 Row 中标注为 `unknown` 派生的宽松形态。
 *
 * 已知差异（只记录，不在本批次修复，超出类型契约范围）：
 *   - 客户端 `src/app/chat/complaint.js` 插入时携带 `scope` 字段，
 *     但 `complaints` 表**没有** `scope` 列（migration 06 与生产库均无）。
 *     因此 `ComplaintInsert` 不包含 `scope`，该差异在类型契约中如实体现。
 */

import type {
  FriendsRow,
  FriendRequestsRow,
  FriendAcceptEventsRow,
  MomentsRow,
  ComplaintsRow,
} from './database';

// ---------------------------------------------------------------------------
// 通用开放字符串辅助
// ---------------------------------------------------------------------------

/**
 * 开放字符串联合：保留已知值的自动补全，同时允许任意其他字符串。
 *
 * 用于建模「数据库为 TEXT、无 CHECK/ENUM 约束」的列，
 * 避免把历史数据或未来新增值错误地排除在类型之外。
 */
type OpenString<Known extends string> = Known | (string & {});

// ---------------------------------------------------------------------------
// friends
// ---------------------------------------------------------------------------

/**
 * 好友关系状态已知值。
 *
 * 数据库：`status TEXT NOT NULL DEFAULT 'accepted'`，**无 CHECK 约束**。
 * 因此对外暴露的 `FriendStatus` 为开放类型。
 */
export type KnownFriendStatus = 'pending' | 'accepted' | 'blocked';

/** 好友关系状态（开放：已知值 + 任意字符串） */
export type FriendStatus = OpenString<KnownFriendStatus>;

/**
 * `friends` 表行（数据库原始形态）。
 *
 * 可空性严格对应 schema：
 *   - NOT NULL：id / user_id / friend_id / status / created_at
 *   - 可空：remark（VARCHAR 无 NOT NULL）
 *   - 可空：is_muted / is_pinned / is_hidden（BOOLEAN DEFAULT false，但无 NOT NULL）
 *
 * 说明：`is_muted` / `is_pinned` / `is_hidden` / `remark` 为历史遗留列
 * （zombie columns），仍存在于 schema 中，故如实声明。
 */
export type FriendRow = FriendsRow;

/** `friends` 插入载荷（带 DEFAULT 的列可省略） */
export interface FriendInsert {
  id?: string;
  user_id: string;
  friend_id: string;
  status?: FriendStatus;
  created_at?: string;
  remark?: string | null;
  is_muted?: boolean | null;
  is_pinned?: boolean | null;
  is_hidden?: boolean | null;
}

/** `friends` 更新载荷（全部可选） */
export type FriendUpdate = Partial<FriendInsert>;

// ---------------------------------------------------------------------------
// friend_requests
// ---------------------------------------------------------------------------

/**
 * 好友请求状态已知值。
 *
 * 数据库：`status TEXT DEFAULT 'pending'`，**无 CHECK 约束**，且**可为 NULL**。
 */
export type KnownFriendRequestStatus = 'pending' | 'accepted' | 'rejected';

/** 好友请求状态（开放：已知值 + 任意字符串） */
export type FriendRequestStatus = OpenString<KnownFriendRequestStatus>;

/**
 * `friend_requests` 表行。
 *
 * 可空性：
 *   - NOT NULL：id / sender_id / receiver_id
 *   - 可空：status（TEXT DEFAULT 'pending'，无 NOT NULL）
 *   - 可空：created_at（TIMESTAMPTZ DEFAULT，无 NOT NULL）
 */
export type FriendRequestRow = FriendRequestsRow;

/** `friend_requests` 插入载荷 */
export interface FriendRequestInsert {
  id?: string;
  sender_id: string;
  receiver_id: string;
  status?: FriendRequestStatus | null;
  created_at?: string | null;
}

/** `friend_requests` 更新载荷 */
export type FriendRequestUpdate = Partial<FriendRequestInsert>;

// ---------------------------------------------------------------------------
// friend_accept_events（migration 33）
// ---------------------------------------------------------------------------

/**
 * `friend_accept_events` 表行。
 *
 * 可空性：
 *   - NOT NULL：id / sender_id / receiver_id / accepted_at
 *   - 可空：request_id（uuid，无 NOT NULL）
 *
 * 约束：`CHECK (sender_id <> receiver_id)`；`UNIQUE (sender_id, receiver_id)`。
 */
export type FriendAcceptEventRow = FriendAcceptEventsRow;

/** `friend_accept_events` 插入载荷 */
export interface FriendAcceptEventInsert {
  id?: string;
  sender_id: string;
  receiver_id: string;
  request_id?: string | null;
  accepted_at?: string;
}

// ---------------------------------------------------------------------------
// moments
// ---------------------------------------------------------------------------

/**
 * 动态可见性已知值。
 *
 * 数据库：`visibility TEXT DEFAULT 'all'`，**无 CHECK 约束**，且**可为 NULL**。
 * 客户端常量 `src/constants/settings.js#MOMENTS_VISIBILITY` 提供 UI 选项，
 * 但数据库层不强制。
 */
export type KnownMomentVisibility = 'all' | 'friends' | 'private';

/** 动态可见性（开放：已知值 + 任意字符串） */
export type MomentVisibility = OpenString<KnownMomentVisibility>;

/**
 * `moments` 表行。
 *
 * 可空性：
 *   - NOT NULL：id
 *   - 可空：author_id（UUID DEFAULT auth.uid()，无 NOT NULL）
 *   - 可空：content（TEXT）
 *   - 可空：images（JSONB DEFAULT '[]'，无 NOT NULL）
 *   - 可空：visibility（TEXT DEFAULT 'all'，无 NOT NULL）
 *   - 可空：created_at（TIMESTAMPTZ DEFAULT，无 NOT NULL）
 *
 * `images` 说明：数据库为 JSONB，客户端按字符串数组使用，
 * 但数据库层不保证元素类型，故 Row 中保留 `unknown` 派生的宽松形态。
 */
export type MomentRow = MomentsRow;

/** `moments` 插入载荷 */
export interface MomentInsert {
  id?: string;
  author_id?: string | null;
  content?: string | null;
  images?: unknown;
  visibility?: MomentVisibility | null;
  created_at?: string | null;
}

/** `moments` 更新载荷 */
export type MomentUpdate = Partial<MomentInsert>;

// ---------------------------------------------------------------------------
// complaints
// ---------------------------------------------------------------------------

/**
 * 投诉状态已知值。
 *
 * 数据库：`status TEXT DEFAULT 'pending'`，**无 CHECK 约束**，且**可为 NULL**。
 */
export type KnownComplaintStatus = 'pending' | 'reviewing' | 'resolved' | 'rejected';

/** 投诉状态（开放：已知值 + 任意字符串） */
export type ComplaintStatus = OpenString<KnownComplaintStatus>;

/**
 * `complaints` 表行（migration 06 权威结构）。
 *
 * 列：id, reporter_id, target_id, reason, content, status, created_at
 * **无 `scope` 列**。
 *
 * 可空性：
 *   - NOT NULL：id
 *   - 可空：reporter_id（UUID DEFAULT auth.uid()，无 NOT NULL）
 *   - 可空：target_id（UUID）
 *   - 可空：reason（TEXT）
 *   - 可空：content（TEXT）
 *   - 可空：status（TEXT DEFAULT 'pending'，无 NOT NULL）
 *   - 可空：created_at（TIMESTAMPTZ DEFAULT clock_timestamp()，无 NOT NULL）
 */
export type ComplaintRow = ComplaintsRow;

/**
 * 投诉插入载荷（对应客户端实际 insert）。
 *
 * 说明：客户端当前会附带 `scope`，但数据库无此列。此处**不声明** `scope`，
 * 以数据库真实契约为准；该不一致已记录在任务文档中，不在本批次修复。
 */
export interface ComplaintInsert {
  id?: string;
  reporter_id?: string | null;
  target_id?: string | null;
  reason?: string | null;
  content?: string | null;
  status?: ComplaintStatus | null;
  created_at?: string | null;
}

/** `complaints` 更新载荷 */
export type ComplaintUpdate = Partial<ComplaintInsert>;
