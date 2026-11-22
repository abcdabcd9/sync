# src/types —— 类型契约目录（TASK-P1.1 R0 已落地）

> 本目录自 P1.1 R0 起**已包含真实 `.ts` 类型文件**，并通过 `tsconfig.json`
> 纳入 TypeScript 编译检查（`npx tsc --noEmit` 会实际检查这些文件）。

## 分层架构（Phase D）

```
基础        result
身份/认证    auth、user
领域        social、chat、health、cinema、browser、push
数据层      database（12 张表 Row/Insert/Update）、rpc（客户端/内部 RPC）
存储/媒体    media、cache
设置/主题    settings
服务边界    transcription、edge
导航        navigation
```

`index.ts` 是唯一统一出口，只做 re-export，无运行时代码。

## 当前文件

| 文件 | 内容 |
|---|---|
| `result.ts` | `Result` / `OkResult` / `ErrResult` / `AppError` / `AppErrorCode` / `PushSendResult` |
| `auth.ts` | `AuthUser` / `AuthSession` / `AuthEpoch` / `OwnerKey` / `AuthContextValue` / `OwnerKeyState` / `SignOutResult` / `AuthCredentialsResult` / `AuthStorageFailure` |
| `user.ts` | `ProfileRow` / `NormalizedProfile` / `SyncId` / `PartnerStatus` / `PartnerAuthorizationRow` / `PartnerAuthorizationMemberRow` |
| `social.ts` | `FriendRow` / `FriendRequestRow` / `FriendAcceptEventRow` / `MomentRow` / `ComplaintRow`（Row 均别名自 `database.ts`） |
| `chat.ts` | `MessageRow`（别名自 `database.ts`）/ `ChatMessage` / `ChatPreview` / `Conversation` / `ChatFavoriteItem` / `ChatPrefs` |
| `health.ts` | `HealthDayRecord` / `HealthRecordRow`（别名自 `database.ts`）/ `HealthPendingEntry` / `StreakState` |
| `cinema.ts` | `SyncCommandPayload` / `DanmakuPayload` / `EpisodeItem` / `SyncRoomState` / `PlaybackCommandType` |
| `browser.ts` | `HistoryEntry` / `Bookmark` / `SniffedMedia` |
| `push.ts` | `PushErrorCategory` / `SendPushNotification` / `NotificationPermissionStatus` / `UsePushNotificationsResult` |
| `cache.ts` | `MediaCacheIdentity` / `OwnerScopedCacheEntry` / 各缓存键构造函数 |
| `database.ts` | **数据库权威来源**：12 张表 `Row`/`Insert`/`Update` + `Database` 映射 + Schema 版本说明 |
| `rpc.ts` | 客户端可调用 RPC（`ClientRpc*`）与内部 RPC（`InternalRpc*`）+ 名称白名单 |
| `media.ts` | 品牌化地址类型（`ObjectPath`/`SignedUrl`/`PublicUrl`/`LocalUri`）/ `UploadResult` / `MediaCacheState` / 缓存操作签名 |
| `settings.ts` | `AppSettings` / `ThemeMode` / `ThemeColors` / `ThemeContextValue` / 设置选项类型 |
| `transcription.ts` | `TranscribeErrorCode`（封闭）/ 成功/失败响应 / 配额领域视图 / `TranscribeLimits` |
| `edge.ts` | `send-push` 与 `transcribe-audio` 的 HTTP 边界请求/响应类型（复用既有枚举） |
| `navigation.ts` | 跨模块共享路由参数类型（`ChatRoomParams` 等）+ `KnownRoutePath` |
| `index.ts` | 统一 re-export 出口 |
| `__typecheck__.ts` | 编译期断言（正向 + 负向 + 存在性，无运行时副作用） |

## 契约来源

所有类型均基于**真实 schema 与真实客户端代码**定义，未发明字段：

- 数据库：`supabase/migrations/*.sql`、`supabase/bootstrap/00_bootstrap_base_schema.sql`、
  生产库权威结构 `.internal/refactor/tasks/P0/prod-sync/prod_schema_dump.sql`
- 客户端：`src/hooks/**`、`src/services/**`、`src/app/**` 中实际读写的字段
- 云函数：`supabase/functions/send-push`、`supabase/functions/transcribe-audio`

## 建模原则（强制）

1. **DEFAULT ≠ NOT NULL**：有 DEFAULT 但无 NOT NULL 的列，Row 中允许 `null`。
2. **TEXT ≠ 封闭枚举**：无 CHECK 约束的 TEXT 列使用开放字符串（`Known | (string & {})`）。
3. **有 CHECK 约束的列**（`partner_authorizations.status`、`transcribe_quota_*.status/scope`）使用封闭字面量联合。
4. **Row / Insert / Update 分离**：Insert 中带 DEFAULT 的列可省略；Update 全可选。
5. **JSONB 不假设元素类型**：`meals_status` / `images` 保留 `unknown`。
6. **database.ts 是唯一权威**：领域文件中的 Row 类型必须别名自 `database.ts`，不得独立漂移
   （`__typecheck__.ts` 用 `Equal<ProfilesRow, ProfileRow>` 等断言强制校验）。

## Schema 版本说明（重要）

`database.ts` 描述的是 **Sync-Dev 数据库**（Migrations 00–33 全应用）的结构。
生产库（`pjiyniqtrstcpnodsnqq`）**尚未应用 Migrations 30–33**，因此：

- `friend_accept_events`（migration 33 新建）在生产库可能不存在；
- `friends` / `moments` / `chat_media` 的对象级授权收紧（30/33）仅策略变化，列不变。

**本目录不能声称同时精确代表两个环境**；涉及 30–33 新增对象时，使用方须显式判断目标环境。

## 已知差异（只记录，不在本批次修复）

1. `src/app/chat/complaint.js` 插入时携带 `scope` 字段，但 `complaints` 表无此列。
   类型契约以数据库为准，`ComplaintInsert` 不含 `scope`。
2. 生产库 `health_records` 无 `created_at`（仅 `updated_at`），
   `HealthRecordsRow` 以生产库为准，不声明 `created_at`。
3. 设置中的 `momentsVisibility`（`'all'|'friends'|'self'`）与数据库
   `moments.visibility`（`'all'|'friends'|'private'`）是**不同概念**，不得合并。

## tsconfig 覆盖与未来扩围（Phase F）

当前 `tsconfig.json` 的 `include` 仅覆盖 `src/types/**`，确保本批次类型契约
独立可编译，且不因既有 JS 业务代码（`checkJs=false`）产生噪声。

**未来启动 JS→TS 迁移时**，需按模块逐步扩大 `include`，例如：

```jsonc
"include": [
  "src/types/**/*.ts",
  "src/hooks/**/*.ts",
  "src/services/**/*.ts",
  "src/app/**/*.tsx"
]
```

扩围前必须先完成对应模块的类型契约评审，避免一次性引入大量隐式 `any`。

## 后续迁移顺序建议

1. `constants/` → 加 `as const`
2. `services/` → 绑定 Supabase 生成类型（可接入 `database.ts#Database`）
3. `hooks/` → 加返回类型
4. `components/` → 加 Props 类型
5. `app/` → 改 `.tsx`，加路由参数类型（复用 `navigation.ts`）
