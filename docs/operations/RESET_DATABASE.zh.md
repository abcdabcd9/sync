# 数据库彻底重置（清空所有测试数据）

[English](RESET_DATABASE.en.md) · [中文](RESET_DATABASE.zh.md)

> 用途：把 Supabase 项目恢复到「零数据」状态，但**保留表结构、RLS 策略、触发器、RPC**。
> 执行位置：Supabase Dashboard → SQL Editor
> 注意：**不可恢复**。执行前请确认项目里没有真实用户数据。

---

## 适用场景

清空 `public` schema 的 7 张表**不等于**清空账号。

Supabase 的账号存在两个独立位置：

| 位置 | 存什么 | 清空方式 |
| --- | --- | --- |
| `auth.users` | 登录凭据（邮箱 + 密码哈希） | `delete from auth.users` |
| `public.profiles` 等 7 张表 | 业务数据 | `truncate` |
| `storage.objects` + 桶内文件 | 聊天图片 / 视频 / 语音 | Dashboard 手动删 |

只清 `public` 会出现「此邮箱已注册过」——因为 `auth.users` 里还有记录。

---

## 第 0 步：执行前快照

```sql
select
  (select count(*) from auth.users)              as auth_users,
  (select count(*) from public.profiles)         as profiles,
  (select count(*) from public.messages)         as messages,
  (select count(*) from public.friends)          as friends,
  (select count(*) from public.friend_requests)  as friend_requests,
  (select count(*) from public.health_records)   as health_records,
  (select count(*) from public.complaints)       as complaints,
  (select count(*) from public.moments)          as moments,
  (select count(*) from storage.objects where bucket_id = 'chat_media') as storage_files;
```

记下这 9 个数字，第 4 步要对比。

---

## 第 1 步：清空 `auth.users`

```sql
-- 不可恢复。若 profiles.id 外键为 on delete cascade，会级联删除 profiles
delete from auth.users;
```

**如果报 `permission denied for table users`**，说明 SQL Editor 权限不足，改走 Dashboard：

```text
Dashboard → Authentication → Users
→ 勾选全部 → Delete users
```

---

## 第 2 步：清空 7 张业务表

```sql
truncate table
  public.messages,
  public.friends,
  public.friend_requests,
  public.health_records,
  public.complaints,
  public.moments,
  public.profiles
restart identity cascade;
```

> 用 `truncate ... cascade` 而不是 `delete`：
> - 更快（不写 WAL 逐行日志）
> - 会一并清掉依赖这些表的对象
> - `restart identity` 重置自增序列
>
> 这一步是**兜底**：即使第 1 步的外键不是 `on delete cascade`，这里也能清掉孤儿 profile 行。

---

## 第 3 步：清空 Storage 聊天媒体

**SQL 删不掉实际文件**（`storage.objects` 只是元数据索引，删行后文件仍占空间）。必须走 Dashboard：

```text
Dashboard → Storage → chat_media 桶
→ 全选所有 uuid 命名的用户目录
→ Delete
```

> 不推荐用 `delete from storage.objects where bucket_id = 'chat_media'`：
> 会留下孤儿文件，白白占用配额，且无法通过 Dashboard 再看到它们。

---

## 第 4 步：验证全空

```sql
select
  (select count(*) from auth.users)              as auth_users,
  (select count(*) from public.profiles)         as profiles,
  (select count(*) from public.messages)         as messages,
  (select count(*) from public.friends)          as friends,
  (select count(*) from public.friend_requests)  as friend_requests,
  (select count(*) from public.health_records)   as health_records,
  (select count(*) from public.complaints)       as complaints,
  (select count(*) from public.moments)          as moments,
  (select count(*) from storage.objects where bucket_id = 'chat_media') as storage_files;
```

 **9 个数字必须全是 0**

---

## 第 5 步：确认结构未被破坏

清数据不影响结构，但确认一下更稳。

### 5.1 表（应为 7 张）

```sql
select c.relname from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

预期：`complaints` / `friend_requests` / `friends` / `health_records` / `messages` / `moments` / `profiles`

### 5.2 触发器（应为 3 个）

```sql
select tgname from pg_trigger
where not tgisinternal
  and tgrelid::regclass::text in
    ('public.profiles', 'public.health_records', 'auth.users')
order by tgname;
```

预期：`health_records_touch_updated_at` / `on_auth_user_created` / `trg_enforce_sync_id_change_limit`

### 5.3 RPC（应为 3 个）

```sql
select proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('delete_my_account', 'get_server_time', 'unbind_partner')
order by proname;
```

预期：`delete_my_account` / `get_server_time` / `unbind_partner`

### 5.4 RLS 仍启用（应为 7 行 true）

```sql
select c.relname, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

---

## 第 6 步：清 App 本地缓存

App 里存了旧账号的 session token 和 AsyncStorage 缓存，不清会「自动登录」到已删除的账号。

**模拟器 / 真机**：

```text
长按 App 图标 → 删除 App → 重新 npx expo start 装一次
```

**或者**（如果 App 还能进）：设置 → 退出登录。

---

## 清完之后

从**全新邮箱**注册，即可完整验证 B-5 流程 1（注册 → `handle_new_user()` 自动建 profile）。

---

## 附：只想删某个测试账号（不重置全部）

```sql
-- 把 <email> 换成目标邮箱
delete from auth.users where email = '<email>';
```

`profiles` 若为 `on delete cascade` 会自动清；否则手动补一刀：

```sql
delete from public.profiles
where id not in (select id from auth.users);
```
