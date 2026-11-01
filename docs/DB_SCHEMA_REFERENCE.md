# 数据库真实结构（从线上 Supabase 导出）

[English](DB_SCHEMA_REFERENCE.en.md) · [中文](DB_SCHEMA_REFERENCE.zh.md)

> 项目 ref：`<your-project-ref>`（Sync，aws-0-eu-west-1）
> 导出方式：Supabase Dashboard → SQL Editor → `information_schema.columns`
> 用途：写 `CREATE TABLE` 迁移脚本时以此为准，**不要凭代码猜**

---

## 注意：0. 严重安全发现（先看这个）

线上 RLS 策略里存在 **6 条「全开」策略**（5 条 `USING (true)` + 1 条 `Enable all for friend_requests`），它们和正确的策略并存。PostgreSQL 的 PERMISSIVE 策略是 **OR 关系**——只要有一条 `true`，其他再严格也没用。

| 表 | 危险策略名 | 命令 | 后果 |
| --- | --- | --- | --- |
| `messages` | `Allow logged-in users to read messages` | SELECT | **任何登录用户能读全库所有聊天记录** |
| `messages` | `Allow logged-in users to update messages` | UPDATE | **任何登录用户能改任何人的消息** |
| `messages` | `Allow logged-in users to delete messages` | DELETE | **任何登录用户能删任何人的消息** |
| `health_records` | `Allow All` | ALL | **任何登录用户能读写所有人的健康数据** |
| `health_records` | `查看打卡记录` | SELECT | 同上，`USING (true)` |
| `friend_requests` | `Enable all for friend_requests` | ALL | **任何登录用户能读写所有人的好友请求** |

这 6 条策略必须删除，否则审计报告里第 2、4、6 条漏洞是**真实可利用**的，不是理论风险。

> **2026-10-31 复核：以上 6 条已全部删除。** 由 [`08_删除7条全开RLS策略_core_rls_policies.sql`](../supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql) 执行，验证结果见第 10 节。

另外还有 **大量重复策略**（同一张表同一命令有 2–3 条），是历史上反复手写 SQL 留下的。重复策略不会导致错误，但会让审计变得极其困难。

---

## 1. `profiles`（11 列）

| 列名 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | uuid | NO | — （主键，引用 `auth.users.id`） |
| `username` | text | NO | — |
| `avatar_url` | text | YES | null |
| `created_at` | timestamptz | NO | `timezone('utc', now())` |
| `expo_push_token` | text | YES | null |
| `bound_partner_id` | uuid | YES | null |
| `sync_id` | varchar | YES | null |
| `nickname` | varchar | YES | null |
| `last_id_modified_at` | timestamptz | YES | null |
| `public_key` | text | YES | null |
| `motto` | text | YES | null |

**注意**：`id` 没有默认值，说明它由 `auth.users` 触发器或客户端显式写入。

---

## 2. `messages`（12 列）

| 列名 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | uuid | NO | `gen_random_uuid()` |
| `created_at` | timestamptz | NO | `timezone('utc', now())` |
| `user_id` | uuid | NO | — |
| `text` | text | YES | null |
| `media_url` | text | YES | null |
| `thumbnail_url` | text | YES | null |
| `type` | text | NO | — |
| `duration` | integer | YES | 0 |
| `receiver_id` | uuid | YES | null |
| `is_read` | boolean | YES | false |
| `group_id` | uuid | YES | null |
| `subtype` | text | YES | null |

**注意**：`group_id` 在代码里没被用到，是预留字段。

---

## 3. `friends`（9 列）

| 列名 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `friend_id` | uuid | NO | — |
| `status` | text | NO | `'accepted'` |
| `created_at` | timestamptz | NO | `timezone('utc', now())` |
| `remark` | varchar | YES | null |
| `is_muted` | boolean | YES | false |
| `is_pinned` | boolean | YES | false |
| `is_hidden` | boolean | YES | false |

**注意**：`is_muted` / `is_pinned` / `is_hidden` 在数据库里有列，但代码里实际用的是 `useChatPrefs` 存在 AsyncStorage 的本地值。这两套是并存的，**没有同步**。

---

## 4. `friend_requests`（5 列）

| 列名 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | uuid | NO | `gen_random_uuid()` |
| `sender_id` | uuid | NO | — |
| `receiver_id` | uuid | NO | — |
| `status` | text | YES | `'pending'` |
| `created_at` | timestamptz | YES | `timezone('utc', now())` |

**注意**：代码里 `search.js:110` 依赖 `error.code === '23505'`（唯一约束冲突）来判断「请求已发送」。所以 `(sender_id, receiver_id)` 上**必须有唯一约束**，否则重复发送会插入多条。

---

## 5. `health_records`（6 列）

| 列名 | 类型 | 可空 | 默认值 |
| --- | --- | --- | --- |
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `record_date` | date | NO | — |
| `water_amount` | integer | YES | 0 |
| `meals_status` | jsonb | YES | `{"早餐": false, "午餐": false, "晚餐": false}` |
| `updated_at` | timestamptz | YES | `timezone('utc', now())` |

**注意**：`useHealthCloud.js:37` 用 `onConflict: 'user_id, record_date'`，所以 `(user_id, record_date)` 上**必须有唯一约束**。

---

## 6. `chat_media`

**代码里没有 `.from('chat_media')` 的表查询**，只有 `supabase.storage.from('chat_media')`。

所以 `chat_media` 是 **Storage 桶名**，不是表名。建表时不需要它，但需要建桶 + 桶策略。

---

## 7. 已存在但不在本次范围的表

| 表 | 来源 |
| --- | --- |
| `complaints` | `06_核心表启用RLS基线_enable_all_rls.sql` 里 `CREATE TABLE IF NOT EXISTS` |
| `moments` | 同上 |

---

## 8. 待补的 RPC

| 函数名 | 调用位置 | 作用 |
| --- | --- | --- |
| `delete_my_account` | `src/app/settings/security.js:111` | 注销账号 |
| `get_server_time` | `src/hooks/health/useTimeSync.js:41`、`src/app/account_info.js:203,252` | 获取服务端时间，防客户端改时间作弊 |

已定义：`unbind_partner`、`enforce_sync_id_change_limit`

---

## 9. 线上 RLS 策略全表（2026-10-31 导出）

### 9.1 `profiles`（6 条，SELECT 全为 `true`）

| 策略名 | 角色 | 命令 | USING | WITH CHECK | 评价 |
| --- | --- | --- | --- | --- | --- |
| `Public profiles are viewable by everyone.` | public | SELECT | `true` | — | 设计如此（搜人需要） |
| `profiles_select_all` | authenticated | SELECT | `true` | — | 重复 |
| `允许查看所有人资料` | public | SELECT | `true` | — | 重复 |
| `Users can insert their own profile.` | public | INSERT | — | `auth.uid() = id` | 正确 |
| `Users can update own profile.` | public | UPDATE | `auth.uid() = id` | — | 正确 |
| `profiles_update_own` | authenticated | UPDATE | `auth.uid() = id` | `auth.uid() = id` | 重复 |

**结论**：SELECT 全开是有意为之（好友搜索要读别人的 nickname/sync_id），可接受。但 `expo_push_token`、`public_key` 也一起暴露了，理想做法是建只含公开字段的 view。

---

### 9.2 `messages`（12 条，其中 4 条是灾难）

| 策略名 | 角色 | 命令 | USING | WITH CHECK | 评价 |
| --- | --- | --- | --- | --- | --- |
| `Allow logged-in users to read messages` | public | SELECT | `auth.role() = 'authenticated'` | — | 严重：全库可读 |
| `Allow logged-in users to update messages` | public | UPDATE | `auth.role() = 'authenticated'` | — | 严重：全库可改 |
| `Allow logged-in users to delete messages` | public | DELETE | `auth.role() = 'authenticated'` | — | 严重：全库可删 |
| `Allow logged-in users to insert messages` | public | INSERT | — | `auth.role() = 'authenticated'` | 注意：可冒充他人发消息 |
| `messages_select_participants` | authenticated | SELECT | `uid = user_id OR uid = receiver_id` | — | 正确 |
| `只看相关的消息` | public | SELECT | 同上 | — | 重复 |
| `messages_insert_own` | authenticated | INSERT | — | `uid = user_id` | 正确 |
| `只能发送自己的消息` | public | INSERT | — | `uid = user_id` | 重复 |
| `messages_update_own` | authenticated | UPDATE | `uid = user_id` | `uid = user_id` | 正确 |
| `允许修改自己的消息` | public | UPDATE | `uid = user_id` | — | 重复（缺 WITH CHECK） |
| `messages_update_receiver_read` | authenticated | UPDATE | `uid = receiver_id` | `uid = receiver_id` | 正确（标记已读） |
| `messages_delete_own` | authenticated | DELETE | `uid = user_id` | — | 正确 |

**必须删除**：前 4 条 `Allow logged-in users to ...`。

---

### 9.3 `health_records`（5 条，其中 2 条是灾难）

| 策略名 | 角色 | 命令 | USING | WITH CHECK | 评价 |
| --- | --- | --- | --- | --- | --- |
| `Allow All` | public | ALL | `true` | `true` | 严重：全库读写 |
| `查看打卡记录` | public | SELECT | `true` | — | 严重：全库可读 |
| `health_records_manage_own` | authenticated | ALL | `uid = user_id` | `uid = user_id` | 正确 |
| `更新自己的打卡` | public | ALL | `uid = user_id` | — | 重复（缺 WITH CHECK） |
| `health_records_select_own_or_partner` | authenticated | SELECT | 自己 OR 绑定的搭子 | — | 正确（搭子功能依赖它） |

**必须删除**：`Allow All`、`查看打卡记录`。

---

### 9.4 `friends`（8 条，逻辑正确但重复）

| 策略名 | 角色 | 命令 | USING | WITH CHECK |
| --- | --- | --- | --- | --- |
| `Users can view their friends.` | public | SELECT | `uid = user_id OR uid = friend_id` | — |
| `查看自己的好友` | public | SELECT | 同上 | — |
| `friends_select_participants` | authenticated | SELECT | 同上 | — |
| `Users can add friends.` | public | INSERT | — | `uid = user_id` |
| `添加好友记录` | public | INSERT | — | `uid = user_id` |
| `friends_insert_own` | authenticated | INSERT | — | `uid = user_id` |
| `friends_update_participants` | authenticated | UPDATE | `uid = user_id OR uid = friend_id` | 同上 |
| `friends_delete_participants` | authenticated | DELETE | `uid = user_id OR uid = friend_id` | — |

**结论**：逻辑正确，同一命令有 2–3 条重复。可清理，不影响安全。

---

### 9.5 `friend_requests`（5 条，其中 1 条是灾难）

| 策略名 | 角色 | 命令 | USING | WITH CHECK | 评价 |
| --- | --- | --- | --- | --- | --- |
| `Enable all for friend_requests` | public | ALL | `true` | `true` | 严重：全库读写 |
| `查看自己的请求` | public | SELECT | `uid = sender_id OR uid = receiver_id` | — | 正确 |
| `发送请求` | public | INSERT | — | `uid = sender_id` | 正确 |
| `处理收到的请求` | public | UPDATE | `uid = receiver_id OR uid = sender_id` | — | 注意：发送方也能改状态 |
| `删除请求` | public | DELETE | `uid = sender_id OR uid = receiver_id` | — | 正确 |

**必须删除**：`Enable all for friend_requests`。

**建议收紧**：`处理收到的请求` 的 USING 含 `sender_id`，意味着发送方可以自己把 `status` 改成 `accepted`，绕过对方同意。应改为只允许 `receiver_id`。

---

### 9.6 `complaints`（1 条，正确）

| 策略名 | 角色 | 命令 | USING | WITH CHECK |
| --- | --- | --- | --- | --- |
| `complaints_insert_own` | authenticated | INSERT | — | `auth.uid() = reporter_id` |

**缺 SELECT 策略**：用户提交投诉后看不到自己的记录。如果投诉只给管理员看，那没问题。

---

### 9.7 `moments`（2 条，质量最高）

| 策略名 | 角色 | 命令 | USING | WITH CHECK |
| --- | --- | --- | --- | --- |
| `moments_manage_own` | authenticated | ALL | `auth.uid() = author_id` | `auth.uid() = author_id` |
| `moments_select_visible` | authenticated | SELECT | 自己 OR `visibility='all'` OR 好友可见 | — |

---

### 9.8 `groups` / `group_members`（已不存在）

**2026-10-31 复核结论：这两张表在线上已不存在。**

当初导出时（同一份文档第 10 节）确实有这两张表，但后续清理时已删除。复核方式：

```sql
SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
-- 结果只有 7 张：complaints / friend_requests / friends /
--                health_records / messages / moments / profiles
```

代码侧同步复核（`grep` 全量扫描 `src/`）：

- `.from('groups')` / `.from('group_members')` 调用数：**0**
- `group_id` 字段名在 `src/` 中出现次数：**0**

**结论**：这两张表是早期群聊功能的遗留，功能已砍、代码零引用、表已删除。`messages.group_id` 列仍保留（历史遗留列，代码不读不写），未来真要做群聊时再重新设计，不要复活这两张表。

---

## 10. RLS 启用状态（2026-10-31 复核）

| 表 | `rls_enabled` | `rls_forced` |
| --- | --- | --- |
| `complaints` | true | false |
| `friend_requests` | true | false |
| `friends` | true | false |
| `health_records` | true | false |
| `messages` | true | false |
| `moments` | true | false |
| `profiles` | true | false |

**结论：7 张表 RLS 全部已启用。**

> 早期导出时还有 `groups` / `group_members` 两张表（共 9 张），后续已删除。
> 复核方式与代码侧证据见第 9.8 节。

`rls_forced = false` 是正常的 —— `FORCE ROW LEVEL SECURITY` 只对**表 owner** 生效，Supabase 的 `postgres` 角色本来就不走 RLS，客户端走的是 `authenticated` / `anon` 角色，不受影响。

注意：**「RLS 已启用」≠「数据安全」**：RLS 开着但被 PERMISSIVE 的「全开」策略架空，等于没开。第 9 节记录的就是这种状态。

> **2026-10-31 复核：架空问题已修复。** 第 9 节列出的危险策略已由
> [`08_删除7条全开RLS策略_core_rls_policies.sql`](../supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql) 全部删除，
> Storage 侧的两条「全开」策略由
> [`02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql`](../supabase/migrations/02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql) 与
> [`03_聊天媒体桶私有化_private_chat_media_bucket.sql`](../supabase/migrations/03_聊天媒体桶私有化_private_chat_media_bucket.sql) 删除。
> 线上验证结果：`public` schema 仅剩 `profiles_select_all`（有意保留，用于按 sync_id 搜人），
> `storage.objects` 上「全开」策略 **0 条**。

---

## 11. 修复优先级（2026-10-31 更新）

| 优先级 | 动作 | 影响 | 状态 |
| --- | --- | --- | --- |
| P0 | 删除 `messages` 的 4 条 `Allow logged-in users to ...` | 阻止全库聊天记录泄露 | 已完成 |
| P0 | 删除 `health_records` 的 `Allow All`、`查看打卡记录` | 阻止健康数据泄露 | 已完成 |
| P0 | 删除 `friend_requests` 的 `Enable all for friend_requests` | 阻止好友请求被任意篡改 | 已完成 |
| P0 | 删除 `storage.objects` 的 `Allow logged-in users to read/upload media` | 阻止全库聊天媒体泄露 | 已完成 |
| P1 | 收紧 `friend_requests.处理收到的请求`，去掉 `sender_id` | 阻止自己批准自己的请求 | 已完成 |
| P2 | 清理重复策略（每表每命令保留 1 条） | 便于审计 | 已完成 |
| P3 | `profiles` 建公开字段 view，隐藏 `expo_push_token` / `public_key` | 减少敏感信息暴露面 | 未做（可选） |

> P0 / P1 / P2 由 [`08_删除7条全开RLS策略_core_rls_policies.sql`](../supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql)
> 与 [`02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql`](../supabase/migrations/02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql) 完成，
> 线上验证见第 10 节。
>
> P3 未做是**有意为之**：`profiles_select_all` 保留是为了让「按 sync_id 搜人」功能可用
> （见 [`src/app/chat/search.js`](../src/app/chat/search.js)）。要彻底隐藏敏感字段，
> 需要额外建一个 `profiles_public` view 并改造所有读取路径，属于后续优化项。
