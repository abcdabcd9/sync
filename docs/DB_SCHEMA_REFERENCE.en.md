# Real database structure (exported from the live Supabase project)

[中文版](DB_SCHEMA_REFERENCE.zh.md) · [English](DB_SCHEMA_REFERENCE.en.md)

> Project ref: `<your-project-ref>` (Sync, aws-0-eu-west-1)
> How it was exported: Supabase Dashboard → SQL Editor → `information_schema.columns`
> Purpose: this is the source of truth when writing `CREATE TABLE` migrations. **Don't guess from the code.**

---

## Warning: 0. Critical security findings (read this first)

The live RLS policies contained **6 "wide open" policies** (5 with `USING (true)` plus 1 `Enable all for friend_requests`), sitting alongside the correct ones. PostgreSQL PERMISSIVE policies are combined with **OR** — as long as one of them is `true`, the stricter ones don't matter.

| Table | Dangerous policy | Command | Impact |
| --- | --- | --- | --- |
| `messages` | `Allow logged-in users to read messages` | SELECT | **Any logged-in user can read every chat message in the database** |
| `messages` | `Allow logged-in users to update messages` | UPDATE | **Any logged-in user can edit anyone's messages** |
| `messages` | `Allow logged-in users to delete messages` | DELETE | **Any logged-in user can delete anyone's messages** |
| `health_records` | `Allow All` | ALL | **Any logged-in user can read and write everyone's health data** |
| `health_records` | `查看打卡记录` | SELECT | Same as above, `USING (true)` |
| `friend_requests` | `Enable all for friend_requests` | ALL | **Any logged-in user can read and write everyone's friend requests** |

These 6 policies had to be dropped. Otherwise findings 2, 4 and 6 in the audit report are **actually exploitable**, not theoretical risk.

> **Verified 2026-10-31: all 6 have been dropped.** Done by [`08_删除7条全开RLS策略_core_rls_policies.sql`](../supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql); see section 10 for the verification results.

There were also **a lot of duplicate policies** (2–3 per table per command), left over from hand-writing SQL over and over. Duplicates don't cause bugs, but they make auditing extremely painful.

---

## 1. `profiles` (11 columns)

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | NO | — (primary key, references `auth.users.id`) |
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

**Note**: `id` has no default, which means it's written either by an `auth.users` trigger or explicitly by the client.

---

## 2. `messages` (12 columns)

| Column | Type | Nullable | Default |
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

**Note**: `group_id` isn't used anywhere in the code — it's a reserved column.

---

## 3. `friends` (9 columns)

| Column | Type | Nullable | Default |
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

**Note**: `is_muted` / `is_pinned` / `is_hidden` exist as columns, but the code actually uses the local values that `useChatPrefs` stores in AsyncStorage. The two sets coexist and are **not synced**.

---

## 4. `friend_requests` (5 columns)

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | NO | `gen_random_uuid()` |
| `sender_id` | uuid | NO | — |
| `receiver_id` | uuid | NO | — |
| `status` | text | YES | `'pending'` |
| `created_at` | timestamptz | YES | `timezone('utc', now())` |

**Note**: `search.js:110` relies on `error.code === '23505'` (unique constraint violation) to detect "request already sent". So `(sender_id, receiver_id)` **must have a unique constraint**, otherwise sending twice inserts duplicate rows.

---

## 5. `health_records` (6 columns)

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `record_date` | date | NO | — |
| `water_amount` | integer | YES | 0 |
| `meals_status` | jsonb | YES | `{"早餐": false, "午餐": false, "晚餐": false}` |
| `updated_at` | timestamptz | YES | `timezone('utc', now())` |

**Note**: `useHealthCloud.js:37` uses `onConflict: 'user_id, record_date'`, so `(user_id, record_date)` **must have a unique constraint**.

---

## 6. `chat_media`

**There is no `.from('chat_media')` table query anywhere in the code** — only `supabase.storage.from('chat_media')`.

So `chat_media` is a **Storage bucket name**, not a table name. Creating tables doesn't need it, but you do need to create the bucket and its policies.

---

## 7. Tables that exist but are out of scope here

| Table | Where it comes from |
| --- | --- |
| `complaints` | `CREATE TABLE IF NOT EXISTS` in `06_核心表启用RLS基线_enable_all_rls.sql` |
| `moments` | Same file |

---

## 8. RPCs still to be added

| Function | Called from | What it does |
| --- | --- | --- |
| `delete_my_account` | `src/app/settings/security.js:111` | Deletes the account |
| `get_server_time` | `src/hooks/health/useTimeSync.js:41`, `src/app/account_info.js:203,252` | Returns server time, so a client can't cheat by changing its clock |

Already defined: `unbind_partner`, `enforce_sync_id_change_limit`

---

## 9. Full inventory of live RLS policies (exported 2026-10-31)

### 9.1 `profiles` (6 policies, all SELECT ones are `true`)

| Policy | Role | Command | USING | WITH CHECK | Verdict |
| --- | --- | --- | --- | --- | --- |
| `Public profiles are viewable by everyone.` | public | SELECT | `true` | — | Intentional (needed for user search) |
| `profiles_select_all` | authenticated | SELECT | `true` | — | Duplicate |
| `允许查看所有人资料` | public | SELECT | `true` | — | Duplicate |
| `Users can insert their own profile.` | public | INSERT | — | `auth.uid() = id` | Correct |
| `Users can update own profile.` | public | UPDATE | `auth.uid() = id` | — | Correct |
| `profiles_update_own` | authenticated | UPDATE | `auth.uid() = id` | `auth.uid() = id` | Duplicate |

**Verdict**: SELECT being wide open is deliberate (friend search needs to read other people's nickname/sync_id), so it's acceptable. But `expo_push_token` and `public_key` get exposed along with it. The ideal fix is a view containing only the public fields.

---

### 9.2 `messages` (12 policies, 4 of them are a disaster)

| Policy | Role | Command | USING | WITH CHECK | Verdict |
| --- | --- | --- | --- | --- | --- |
| `Allow logged-in users to read messages` | public | SELECT | `auth.role() = 'authenticated'` | — | Critical: whole database readable |
| `Allow logged-in users to update messages` | public | UPDATE | `auth.role() = 'authenticated'` | — | Critical: whole database writable |
| `Allow logged-in users to delete messages` | public | DELETE | `auth.role() = 'authenticated'` | — | Critical: whole database deletable |
| `Allow logged-in users to insert messages` | public | INSERT | — | `auth.role() = 'authenticated'` | Warning: can send messages impersonating others |
| `messages_select_participants` | authenticated | SELECT | `uid = user_id OR uid = receiver_id` | — | Correct |
| `只看相关的消息` | public | SELECT | Same as above | — | Duplicate |
| `messages_insert_own` | authenticated | INSERT | — | `uid = user_id` | Correct |
| `只能发送自己的消息` | public | INSERT | — | `uid = user_id` | Duplicate |
| `messages_update_own` | authenticated | UPDATE | `uid = user_id` | `uid = user_id` | Correct |
| `允许修改自己的消息` | public | UPDATE | `uid = user_id` | — | Duplicate (missing WITH CHECK) |
| `messages_update_receiver_read` | authenticated | UPDATE | `uid = receiver_id` | `uid = receiver_id` | Correct (marking as read) |
| `messages_delete_own` | authenticated | DELETE | `uid = user_id` | — | Correct |

**Must drop**: the first 4 `Allow logged-in users to ...` policies.

---

### 9.3 `health_records` (5 policies, 2 of them are a disaster)

| Policy | Role | Command | USING | WITH CHECK | Verdict |
| --- | --- | --- | --- | --- | --- |
| `Allow All` | public | ALL | `true` | `true` | Critical: whole database readable and writable |
| `查看打卡记录` | public | SELECT | `true` | — | Critical: whole database readable |
| `health_records_manage_own` | authenticated | ALL | `uid = user_id` | `uid = user_id` | Correct |
| `更新自己的打卡` | public | ALL | `uid = user_id` | — | Duplicate (missing WITH CHECK) |
| `health_records_select_own_or_partner` | authenticated | SELECT | Self OR bound partner | — | Correct (the partner feature depends on it) |

**Must drop**: `Allow All`, `查看打卡记录`.

---

### 9.4 `friends` (8 policies, logic correct but duplicated)

| Policy | Role | Command | USING | WITH CHECK |
| --- | --- | --- | --- | --- |
| `Users can view their friends.` | public | SELECT | `uid = user_id OR uid = friend_id` | — |
| `查看自己的好友` | public | SELECT | Same as above | — |
| `friends_select_participants` | authenticated | SELECT | Same as above | — |
| `Users can add friends.` | public | INSERT | — | `uid = user_id` |
| `添加好友记录` | public | INSERT | — | `uid = user_id` |
| `friends_insert_own` | authenticated | INSERT | — | `uid = user_id` |
| `friends_update_participants` | authenticated | UPDATE | `uid = user_id OR uid = friend_id` | Same as above |
| `friends_delete_participants` | authenticated | DELETE | `uid = user_id OR uid = friend_id` | — |

**Verdict**: logic is correct, with 2–3 duplicates per command. Safe to clean up, no security impact.

---

### 9.5 `friend_requests` (5 policies, 1 of them is a disaster)

| Policy | Role | Command | USING | WITH CHECK | Verdict |
| --- | --- | --- | --- | --- | --- |
| `Enable all for friend_requests` | public | ALL | `true` | `true` | Critical: whole database readable and writable |
| `查看自己的请求` | public | SELECT | `uid = sender_id OR uid = receiver_id` | — | Correct |
| `发送请求` | public | INSERT | — | `uid = sender_id` | Correct |
| `处理收到的请求` | public | UPDATE | `uid = receiver_id OR uid = sender_id` | — | Warning: the sender can also change the status |
| `删除请求` | public | DELETE | `uid = sender_id OR uid = receiver_id` | — | Correct |

**Must drop**: `Enable all for friend_requests`.

**Should tighten**: the USING clause of `处理收到的请求` includes `sender_id`, which means the sender can set `status` to `accepted` themselves and skip the other side's approval. It should only allow `receiver_id`.

---

### 9.6 `complaints` (1 policy, correct)

| Policy | Role | Command | USING | WITH CHECK |
| --- | --- | --- | --- | --- |
| `complaints_insert_own` | authenticated | INSERT | — | `auth.uid() = reporter_id` |

**Missing a SELECT policy**: after submitting a complaint, users can't see their own record. If complaints are meant to be admin-only, that's fine.

---

### 9.7 `moments` (2 policies, the highest quality of the lot)

| Policy | Role | Command | USING | WITH CHECK |
| --- | --- | --- | --- | --- |
| `moments_manage_own` | authenticated | ALL | `auth.uid() = author_id` | `auth.uid() = author_id` |
| `moments_select_visible` | authenticated | SELECT | Self OR `visibility='all'` OR friends-only | — |

---

### 9.8 `groups` / `group_members` (no longer exist)

**Verified 2026-10-31: these two tables no longer exist in the live database.**

They did exist when this document was first exported (section 10 of the same document), but were dropped during later cleanup. How it was verified:

```sql
SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;
-- Only 7 rows: complaints / friend_requests / friends /
--              health_records / messages / moments / profiles
```

Code-side cross-check (`grep` across all of `src/`):

- Calls to `.from('groups')` / `.from('group_members')`: **0**
- Occurrences of the `group_id` field name in `src/`: **0**

**Verdict**: these two tables were leftovers from an early group-chat feature. The feature was cut, the code has zero references, and the tables are gone. The `messages.group_id` column is still there (a legacy column the code neither reads nor writes). If group chat ever comes back, design it fresh — don't resurrect these two tables.

---

## 10. RLS enabled status (verified 2026-10-31)

| Table | `rls_enabled` | `rls_forced` |
| --- | --- | --- |
| `complaints` | true | false |
| `friend_requests` | true | false |
| `friends` | true | false |
| `health_records` | true | false |
| `messages` | true | false |
| `moments` | true | false |
| `profiles` | true | false |

**Verdict: RLS is enabled on all 7 tables.**

> The original export also had `groups` / `group_members` (9 tables in total); they've since been dropped.
> See section 9.8 for the verification method and the code-side evidence.

`rls_forced = false` is normal — `FORCE ROW LEVEL SECURITY` only applies to the **table owner**, and Supabase's `postgres` role bypasses RLS anyway. Clients connect as `authenticated` / `anon`, so they're unaffected.

Note: **"RLS is enabled" does not mean "the data is safe"**: RLS can be on and still be completely undermined by a PERMISSIVE "wide open" policy — which is as good as off. Section 9 documents exactly that state.

> **Verified 2026-10-31: the undermined state has been fixed.** Every dangerous policy listed in section 9 was dropped by
> [`08_删除7条全开RLS策略_core_rls_policies.sql`](../supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql),
> and the two "wide open" policies on the Storage side were dropped by
> [`02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql`](../supabase/migrations/02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql) and
> [`03_聊天媒体桶私有化_private_chat_media_bucket.sql`](../supabase/migrations/03_聊天媒体桶私有化_private_chat_media_bucket.sql).
> Live verification: the `public` schema only has `profiles_select_all` left (kept on purpose, for looking people up by sync_id),
> and there are **0** "wide open" policies on `storage.objects`.

---

## 11. Fix priorities (updated 2026-10-31)

| Priority | Action | Impact | Status |
| --- | --- | --- | --- |
| P0 | Drop the 4 `Allow logged-in users to ...` policies on `messages` | Stops the whole chat history from leaking | Done |
| P0 | Drop `Allow All` and `查看打卡记录` on `health_records` | Stops health data from leaking | Done |
| P0 | Drop `Enable all for friend_requests` on `friend_requests` | Stops friend requests from being tampered with | Done |
| P0 | Drop `Allow logged-in users to read/upload media` on `storage.objects` | Stops all chat media from leaking | Done |
| P1 | Tighten `friend_requests.处理收到的请求` by removing `sender_id` | Stops people from approving their own requests | Done |
| P2 | Clean up duplicate policies (keep 1 per table per command) | Makes auditing possible | Done |
| P3 | Create a public-fields view for `profiles`, hiding `expo_push_token` / `public_key` | Shrinks the sensitive-data surface | Not done (optional) |

> P0 / P1 / P2 were handled by [`08_删除7条全开RLS策略_core_rls_policies.sql`](../supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql)
> and [`02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql`](../supabase/migrations/02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql).
> Live verification is in section 10.
>
> P3 was **deliberately** skipped: `profiles_select_all` is kept so that "look people up by sync_id" keeps working
> (see [`src/app/chat/search.js`](../src/app/chat/search.js)). Fully hiding the sensitive fields would mean
> creating a separate `profiles_public` view and rewiring every read path — that's a follow-up optimisation.
