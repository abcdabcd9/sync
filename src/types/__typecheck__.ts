/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * 编译期类型验证（TASK-P1.1 R0 — Phase E 重写）
 *
 * 目的：证明 `src/types/*.ts` 真正参与 TypeScript 编译检查，
 *       而不是"空通过"。本文件**不产生任何运行时副作用**：
 *       - 所有断言都在类型层完成
 *       - 导出的常量仅用于避免 "unused" 报错，不会被业务代码引用
 *
 * 断言分三类：
 *   1. 正向断言（Expect<Equal<...>>）：字段类型必须精确等于真实契约。
 *   2. 负向断言（@ts-expect-error）：错误用法必须被编译器拒绝。
 *   3. 存在性断言：关键字段必须存在（keyof 检查）。
 *
 * 若类型契约与真实数据形状不一致，`npx tsc --noEmit` 会在此文件报错。
 */

import type {
  // 基础
  Result,
  AppError,
  PushSendResult,
  // 认证 / 用户
  AuthContextValue,
  OwnerKeyState,
  SignOutResult,
  AuthCredentialsResult,
  ProfileRow,
  NormalizedProfile,
  PartnerAuthorizationRow,
  // 社交
  FriendRow,
  FriendRequestRow,
  FriendAcceptEventRow,
  MomentRow,
  ComplaintRow,
  // 聊天
  MessageRow,
  ChatMessage,
  ChatFavoriteItem,
  ChatPrefs,
  ChatPreview,
  Conversation,
  // 健康
  HealthRecordRow,
  HealthPendingEntry,
  // 影院
  SyncCommandPayload,
  DanmakuPayload,
  EpisodeItem,
  SyncRoomState,
  // 浏览器
  SniffedMedia,
  HistoryEntry,
  Bookmark,
  // 数据库
  Database,
  DatabaseTableName,
  ProfilesRow,
  MessagesRow,
  FriendsRow,
  HealthRecordsRow,
  MomentsRow,
  ComplaintsRow,
  PartnerAuthorizationsRow,
  TranscribeQuotaWindowsRow,
  TranscribeQuotaReservationsRow,
  // RPC
  ClientRpcName,
  InternalRpcName,
  RpcResult,
  // 媒体
  ObjectPath,
  SignedUrl,
  LocalUri,
  UploadResult,
  MediaCacheState,
  MediaCacheKind,
  // 设置
  AppSettings,
  ThemeMode,
  ThemeContextValue,
  SettingsMomentsVisibility,
  // 转写
  TranscribeErrorCode,
  TranscribeSuccessResponse,
  TranscribeErrorResponse,
  // Edge
  SendPushRequest,
  SendPushResponse,
  SendPushSuccessResponse,
  TranscribeAudioResponse,
  EdgeFunctionName,
  // 导航
  ChatRoomParams,
  ContactProfileParams,
  KnownRoutePath,
} from './index';

/* ------------------------------------------------------------------ *
 * 工具类型：编译期相等断言
 * ------------------------------------------------------------------ */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

type Expect<T extends true> = T;

/** 断言某字段存在（keyof 包含） */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

/* ================================================================== *
 * 1. 可空性断言：NOT NULL 列不得为 null
 * ================================================================== */

// —— profiles ——
type _ProfileIdNotNull = Expect<Equal<ProfileRow['id'], string>>;
type _ProfileUsernameNotNull = Expect<Equal<ProfileRow['username'], string>>;
type _ProfileCreatedAtNotNull = Expect<Equal<ProfileRow['created_at'], string>>;
type _ProfileNicknameNullable = Expect<Equal<ProfileRow['nickname'], string | null>>;
type _ProfileMottoNullable = Expect<Equal<ProfileRow['motto'], string | null>>;
type _ProfileSyncIdNullable = Expect<Equal<ProfileRow['sync_id'], string | null>>;

// —— messages ——
type _MessageIdNotNull = Expect<Equal<MessageRow['id'], string>>;
type _MessageUserIdNotNull = Expect<Equal<MessageRow['user_id'], string>>;
type _MessageCreatedAtNotNull = Expect<Equal<MessageRow['created_at'], string>>;
type _MessageTextNullable = Expect<Equal<MessageRow['text'], string | null>>;
type _MessageSubtypeNullable = Expect<Equal<MessageRow['subtype'], string | null>>;
type _MessageDeletedByArray = Expect<Equal<MessageRow['deleted_by'], string[]>>;
type _MessageDurationNullable = Expect<Equal<MessageRow['duration'], number | null>>;
type _MessageIsReadNullable = Expect<Equal<MessageRow['is_read'], boolean | null>>;

// —— health_records ——
type _HealthRecordDateNotNull = Expect<Equal<HealthRecordRow['record_date'], string>>;
type _HealthWaterNullable = Expect<Equal<HealthRecordRow['water_amount'], number | null>>;
type _HealthUpdatedAtNullable = Expect<Equal<HealthRecordRow['updated_at'], string | null>>;

// —— friends ——
// status 为开放字符串（KnownFriendStatus | (string & {})），断言其可接受任意字符串
type _FriendStatusAcceptsString = Expect<Equal<FriendRow['status'] extends string ? true : false, true>>;
type _FriendStatusAcceptsKnown = Expect<Equal<'accepted' extends FriendRow['status'] ? true : false, true>>;
type _FriendRemarkNullable = Expect<Equal<FriendRow['remark'], string | null>>;
type _FriendIsMutedNullable = Expect<Equal<FriendRow['is_muted'], boolean | null>>;

// —— friend_requests（DEFAULT 但非 NOT NULL）——
type _FriendRequestStatusNullable = Expect<
  Equal<FriendRequestRow['status'] extends string | null ? true : false, true>
>;
type _FriendRequestCreatedAtNullable = Expect<Equal<FriendRequestRow['created_at'], string | null>>;

// —— friend_accept_events ——
type _FriendAcceptRequestIdNullable = Expect<Equal<FriendAcceptEventRow['request_id'], string | null>>;
type _FriendAcceptAcceptedAtNotNull = Expect<Equal<FriendAcceptEventRow['accepted_at'], string>>;

// —— moments（仅 id NOT NULL）——
type _MomentIdNotNull = Expect<Equal<MomentRow['id'], string>>;
type _MomentAuthorNullable = Expect<Equal<MomentRow['author_id'], string | null>>;
type _MomentImagesUnknown = Expect<Equal<MomentRow['images'], unknown>>;
type _MomentVisibilityNullable = Expect<
  Equal<MomentRow['visibility'] extends string | null ? true : false, true>
>;

// —— complaints（仅 id NOT NULL，且无 scope）——
type _ComplaintIdNotNull = Expect<Equal<ComplaintRow['id'], string>>;
type _ComplaintReporterNullable = Expect<Equal<ComplaintRow['reporter_id'], string | null>>;
type _ComplaintHasNoScope = Expect<Equal<HasKey<ComplaintRow, 'scope'>, false>>;

// —— partner_authorizations（CHECK 约束 → 封闭联合）——
type _PartnerAuthStatusClosed = Expect<
  Equal<
    PartnerAuthorizationRow['status'],
    'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired' | 'revoked'
  >
>;

/* ================================================================== *
 * 2. 客户端形态断言（数字时间戳、开放类型等）
 * ================================================================== */

type _ChatMessageIsMeBoolean = Expect<Equal<ChatMessage['isMe'], boolean>>;
type _ChatMessageTimestampNumber = Expect<Equal<ChatMessage['timestamp'], number>>;
type _ChatMessageTypeAcceptsString = Expect<Equal<ChatMessage['type'] extends string ? true : false, true>>;
type _ChatPreviewString = Expect<Equal<ChatPreview, string>>;
type _ConversationHasNoPreview = Expect<Equal<HasKey<Conversation, 'preview'>, false>>;

type _NormalizedSyncIdString = Expect<Equal<NormalizedProfile['sync_id'], string>>;
type _NormalizedNicknameString = Expect<Equal<NormalizedProfile['nickname'], string>>;

type _ChatFavoriteTimestampNumber = Expect<Equal<ChatFavoriteItem['timestamp'], number>>;
type _ChatFavoriteSavedAtNumber = Expect<Equal<ChatFavoriteItem['savedAt'], number>>;
type _ChatFavoriteMsgIdNullable = Expect<Equal<ChatFavoriteItem['msgId'], string | null>>;
type _ChatFavoritePeerIdNullable = Expect<Equal<ChatFavoriteItem['peerId'], string | null>>;

type _ChatPrefsPinnedArray = Expect<Equal<ChatPrefs['pinned'], string[]>>;
type _ChatPrefsBackgroundsRecord = Expect<Equal<ChatPrefs['backgrounds'], Record<string, string>>>;

type _HealthPendingUpdatedAtNumber = Expect<Equal<HealthPendingEntry['updatedAt'], number>>;
type _HealthPendingRevNumber = Expect<Equal<HealthPendingEntry['rev'], number>>;
type _HealthPendingBootIdString = Expect<Equal<HealthPendingEntry['bootId'], string>>;
type _HealthPendingOpSeqNumber = Expect<Equal<HealthPendingEntry['opSeq'], number>>;
type _HealthPendingOpIdString = Expect<Equal<HealthPendingEntry['opId'], string>>;

type _SyncCommandTypeClosed = Expect<
  Equal<SyncCommandPayload['type'], 'PLAY' | 'PAUSE' | 'FORCE_SYNC' | 'AUTO_SYNC'>
>;
type _SyncCommandUrlNullable = Expect<Equal<SyncCommandPayload['url'], string | null>>;
type _DanmakuTimestampNumber = Expect<Equal<DanmakuPayload['timestamp'], number>>;
type _EpisodeEpisodeIdNumberNullable = Expect<Equal<EpisodeItem['episodeId'], number | null>>;
type _EpisodeVodIdNullable = Expect<Equal<EpisodeItem['vodId'], string | null>>;
type _SyncRoomOwnerKeyString = Expect<Equal<SyncRoomState['ownerKey'], string>>;

type _SniffedMediaHasNoTitle = Expect<Equal<HasKey<SniffedMedia, 'title'>, false>>;
type _SniffedMediaExtString = Expect<Equal<SniffedMedia['ext'], string>>;
type _HistoryTimestampNumber = Expect<Equal<HistoryEntry['timestamp'], number>>;
type _BookmarkHasNoId = Expect<Equal<HasKey<Bookmark, 'id'>, false>>;
type _BookmarkUrlString = Expect<Equal<Bookmark['url'], string>>;

/* ================================================================== *
 * 3. 认证契约断言
 * ================================================================== */

type _AuthOwnerIdNullable = Expect<Equal<AuthContextValue['ownerId'], string | null>>;
type _AuthEpochNumber = Expect<Equal<AuthContextValue['authEpoch'], number>>;
type _AuthHasSignIn = Expect<Equal<HasKey<AuthContextValue, 'signIn'>, true>>;
type _AuthHasSignUp = Expect<Equal<HasKey<AuthContextValue, 'signUp'>, true>>;
type _AuthSignOutReturnsResult = Expect<
  Equal<Awaited<ReturnType<AuthContextValue['signOut']>>, SignOutResult>
>;
type _SignOutErrorNullable = Expect<Equal<SignOutResult['error'], { code: string; message: string } | null>>;
type _AuthCredentialsHasData = Expect<Equal<HasKey<AuthCredentialsResult, 'data'>, true>>;
type _OwnerKeyIsString = Expect<Equal<OwnerKeyState['ownerKey'], string>>;

/* ================================================================== *
 * 4. 数据库统一映射断言
 * ================================================================== */

type _DbHasProfiles = Expect<Equal<HasKey<Database['public']['Tables'], 'profiles'>, true>>;
type _DbHasMessages = Expect<Equal<HasKey<Database['public']['Tables'], 'messages'>, true>>;
type _DbHasFriends = Expect<Equal<HasKey<Database['public']['Tables'], 'friends'>, true>>;
type _DbHasFriendRequests = Expect<Equal<HasKey<Database['public']['Tables'], 'friend_requests'>, true>>;
type _DbHasFriendAcceptEvents = Expect<
  Equal<HasKey<Database['public']['Tables'], 'friend_accept_events'>, true>
>;
type _DbHasHealthRecords = Expect<Equal<HasKey<Database['public']['Tables'], 'health_records'>, true>>;
type _DbHasMoments = Expect<Equal<HasKey<Database['public']['Tables'], 'moments'>, true>>;
type _DbHasComplaints = Expect<Equal<HasKey<Database['public']['Tables'], 'complaints'>, true>>;
type _DbHasPartnerAuth = Expect<
  Equal<HasKey<Database['public']['Tables'], 'partner_authorizations'>, true>
>;
type _DbHasPartnerAuthMembers = Expect<
  Equal<HasKey<Database['public']['Tables'], 'partner_authorization_members'>, true>
>;
type _DbHasQuotaWindows = Expect<
  Equal<HasKey<Database['public']['Tables'], 'transcribe_quota_windows'>, true>
>;
type _DbHasQuotaReservations = Expect<
  Equal<HasKey<Database['public']['Tables'], 'transcribe_quota_reservations'>, true>
>;

// 表名清单恰好 12 张
type _DbTableCount = Expect<
  Equal<
    DatabaseTableName,
    | 'profiles'
    | 'messages'
    | 'friends'
    | 'friend_requests'
    | 'friend_accept_events'
    | 'health_records'
    | 'moments'
    | 'complaints'
    | 'partner_authorizations'
    | 'partner_authorization_members'
    | 'transcribe_quota_windows'
    | 'transcribe_quota_reservations'
  >
>;

// database.ts 的 Row 与领域文件 Row 必须一致（防漂移）
type _ProfilesRowConsistent = Expect<Equal<ProfilesRow, ProfileRow>>;
type _MessagesRowConsistent = Expect<Equal<MessagesRow, MessageRow>>;
type _FriendsRowConsistent = Expect<Equal<FriendsRow, FriendRow>>;
type _HealthRecordsRowConsistent = Expect<Equal<HealthRecordsRow, HealthRecordRow>>;

// 修正 B：health_records.created_at 为可选（Sync-Dev 有、Production 无）
type _HealthRecordsCreatedAtOptional = Expect<
  Equal<HealthRecordsRow['created_at'], string | null | undefined>
>;
// updated_at 在两环境均存在，但可空（DEFAULT 非 NOT NULL）
type _HealthRecordsUpdatedAtNullable = Expect<
  Equal<HealthRecordsRow['updated_at'], string | null>
>;
type _MomentsRowConsistent = Expect<Equal<MomentsRow, MomentRow>>;
type _ComplaintsRowConsistent = Expect<Equal<ComplaintsRow, ComplaintRow>>;
type _PartnerAuthRowConsistent = Expect<Equal<PartnerAuthorizationsRow, PartnerAuthorizationRow>>;

// 配额表（CHECK 约束 → 封闭联合）
type _QuotaWindowsScopeClosed = Expect<Equal<TranscribeQuotaWindowsRow['scope'], 'user' | 'global'>>;
type _QuotaReservationsStatusClosed = Expect<
  Equal<TranscribeQuotaReservationsRow['status'], 'reserved' | 'released'>
>;
type _QuotaReservationsReleasedAtNullable = Expect<
  Equal<TranscribeQuotaReservationsRow['released_at'], string | null>
>;

/* ================================================================== *
 * 5. RPC 白名单断言（内部函数不得混入客户端白名单）
 * ================================================================== */

type _ClientRpcHasGetServerTime = Expect<Equal<HasKey<Record<ClientRpcName, true>, 'get_server_time'>, true>>;
type _ClientRpcHasDeleteConversation = Expect<
  Equal<HasKey<Record<ClientRpcName, true>, 'delete_conversation'>, true>
>;
type _ClientRpcExcludesQuotaReserve = Expect<
  Equal<HasKey<Record<ClientRpcName, true>, 'transcribe_quota_reserve'>, false>
>;
type _InternalRpcHasQuotaReserve = Expect<
  Equal<HasKey<Record<InternalRpcName, true>, 'transcribe_quota_reserve'>, true>
>;
type _InternalRpcHasLockProfilePair = Expect<
  Equal<HasKey<Record<InternalRpcName, true>, 'lock_profile_pair'>, true>
>;
type _RpcResultHasData = Expect<Equal<HasKey<RpcResult<string>, 'data'>, true>>;

/* ================================================================== *
 * 6. 媒体地址品牌化断言（四种地址不可互换）
 * ================================================================== */

type _ObjectPathNotSignedUrl = Expect<Equal<ObjectPath extends SignedUrl ? true : false, false>>;
type _SignedUrlNotLocalUri = Expect<Equal<SignedUrl extends LocalUri ? true : false, false>>;
type _UploadResultPathObjectPath = Expect<Equal<UploadResult['path'], ObjectPath>>;
type _UploadResultSignedUrlNullable = Expect<Equal<UploadResult['signedUrl'], SignedUrl | null>>;
type _MediaCacheKindClosed = Expect<Equal<MediaCacheKind, 'audio' | 'image' | 'video' | 'thumb'>>;
type _MediaCacheStateHasStatus = Expect<Equal<HasKey<MediaCacheState, 'status'>, true>>;

/* ================================================================== *
 * 7. 设置 / 主题断言
 * ================================================================== */

type _AppSettingsHasLanguage = Expect<Equal<HasKey<AppSettings, 'language'>, true>>;
type _AppSettingsLanguageClosed = Expect<Equal<AppSettings['language'], 'zh' | 'en'>>;
type _AppSettingsMomentsVisibility = Expect<
  Equal<AppSettings['momentsVisibility'], SettingsMomentsVisibility>
>;
type _SettingsMomentsUsesSelf = Expect<Equal<SettingsMomentsVisibility, 'all' | 'friends' | 'self'>>;
type _ThemeModeClosed = Expect<Equal<ThemeMode, 'system' | 'light' | 'dark'>>;
type _ThemeContextHasColors = Expect<Equal<HasKey<ThemeContextValue, 'colors'>, true>>;

/* ================================================================== *
 * 8. 转写 / Edge 边界断言
 * ================================================================== */

type _TranscribeErrorCodeClosed = Expect<
  Equal<
    TranscribeErrorCode,
    | 'METHOD_NOT_ALLOWED'
    | 'UNAUTHORIZED'
    | 'NOT_CONFIGURED'
    | 'INVALID_INPUT'
    | 'PAYLOAD_TOO_LARGE'
    | 'UNSUPPORTED_FORMAT'
    | 'QUOTA_EXCEEDED'
    | 'QUOTA_UNAVAILABLE'
    | 'UPSTREAM_TIMEOUT'
    | 'UPSTREAM_ERROR'
    | 'INTERNAL_ERROR'
  >
>;
type _TranscribeSuccessHasText = Expect<Equal<TranscribeSuccessResponse['text'], string>>;
type _TranscribeErrorHasCode = Expect<Equal<TranscribeErrorResponse['error']['code'], TranscribeErrorCode>>;
type _SendPushRequestAllOptional = Expect<Equal<SendPushRequest, {
  targetUserId?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}>>;
type _EdgeFunctionNameClosed = Expect<Equal<EdgeFunctionName, 'send-push' | 'transcribe-audio'>>;

// 修正 A：send-push 成功响应 ticketId 必须可空（源码 `ticket?.id ?? null`）
type _SendPushSuccessTicketIdNullable = Expect<
  Equal<Extract<SendPushSuccessResponse, { ok: true; ticketId: unknown }>['ticketId'], string | null>
>;
// 成功响应联合必须同时包含「正常发送」与「skipped」两种形态
type _SendPushSuccessHasSkipped = Expect<
  Equal<Extract<SendPushSuccessResponse, { skipped: true }>['reason'], string>
>;

/* ================================================================== *
 * 9. 导航参数断言
 * ================================================================== */

type _ChatRoomTargetIdString = Expect<Equal<ChatRoomParams['targetId'], string>>;
type _ChatRoomTargetNameOptional = Expect<Equal<ChatRoomParams['targetName'], string | undefined>>;
type _ContactProfileIdString = Expect<Equal<ContactProfileParams['id'], string>>;
type _KnownRouteHasChatRoom = Expect<Equal<HasKey<Record<KnownRoutePath, true>, '/chat_room'>, true>>;

/* ================================================================== *
 * 10. 判别联合断言
 * ================================================================== */

type _ResultOkData = Expect<Equal<Extract<Result<number>, { ok: true }>['data'], number>>;
type _PushSuccessNoStatus = Expect<
  Equal<HasKey<Extract<PushSendResult, { ok: true }>, 'status'>, false>
>;
type _PushFailureStatusOptional = Expect<
  Equal<Extract<PushSendResult, { ok: false }>['status'], number | undefined>
>;
type _AppErrorCodeString = Expect<Equal<AppError['code'] extends string ? true : false, true>>;

/* ================================================================== *
 * 11. 负向断言：以下用法必须被编译器拒绝
 * ================================================================== */

// 11.1 不能把 null 赋给 NOT NULL 字段
// @ts-expect-error — ProfileRow.id 是 string，不接受 null
const _negProfileId: ProfileRow['id'] = null;

// 11.2 不能把字符串赋给数字时间戳
// @ts-expect-error — ChatMessage.timestamp 是 number
const _negChatTimestamp: ChatMessage['timestamp'] = '2024-01-01';

// 11.3 不能把数字赋给字符串时间戳
// @ts-expect-error — HistoryEntry.timestamp 是 number
const _negHistoryTimestamp: HistoryEntry['timestamp'] = '1700000000000';

// 11.4 不能访问不存在的字段（complaints 无 scope）
// @ts-expect-error — ComplaintRow 没有 scope 字段
const _negComplaintScope: ComplaintRow['scope'] = 'x';

// 11.5 不能访问不存在的字段（Bookmark 无 id）
// @ts-expect-error — Bookmark 没有 id 字段
const _negBookmarkId: Bookmark['id'] = 'x';

// 11.6 不能把任意字符串赋给封闭枚举（ThemeMode）
// @ts-expect-error — ThemeMode 是封闭联合
const _negThemeMode: ThemeMode = 'blue';

// 11.7 不能把内部 RPC 名当作客户端 RPC 名
// @ts-expect-error — transcribe_quota_reserve 不在 ClientRpcName 中
const _negClientRpc: ClientRpcName = 'transcribe_quota_reserve';

// 11.8 不能把 SignedUrl 当作 ObjectPath（品牌化隔离）
// @ts-expect-error — SignedUrl 不能赋给 ObjectPath
const _negObjectPath: ObjectPath = '' as SignedUrl;

// 11.9 不能把 'private' 当作设置里的朋友圈可见范围（设置用 'self'）
// @ts-expect-error — SettingsMomentsVisibility 不含 'private'
const _negSettingsVisibility: SettingsMomentsVisibility = 'private';

// 11.10 不能把未知错误码赋给转写错误码
// @ts-expect-error — TranscribeErrorCode 是封闭联合
const _negTranscribeCode: TranscribeErrorCode = 'SOMETHING_ELSE';

// 11.11 不能把 send-push 成功响应的 ticketId 当作必然存在的 string
// （源码 `ticket?.id ?? null`，可能为 null）
// @ts-expect-error — ticketId 是 string | null，不能赋给 string
const _negTicketIdString: string = ({} as Extract<SendPushSuccessResponse, { ok: true; ticketId: unknown }>).ticketId;

// 11.12 不能把 health_records.created_at 当作必然存在的 string
// （Production 无该列，Sync-Dev 可空）
// @ts-expect-error — created_at 是 string | null | undefined
const _negHealthCreatedAtString: string = ({} as HealthRecordsRow).created_at;

/* ================================================================== *
 * 12. 运行时占位导出（避免 unused 报错；无副作用）
 * ================================================================== */

/** 编译期断言全部通过时该常量类型为 true */
export const TYPE_CONTRACTS_OK: true = true;
