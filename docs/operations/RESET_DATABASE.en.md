# Full database reset (wipe all test data)

[中文版](RESET_DATABASE.zh.md) · [English](RESET_DATABASE.en.md)

> Purpose: bring the Supabase project back to a "zero data" state while **keeping the table structure, RLS policies, triggers and RPCs**.
> Where to run it: Supabase Dashboard → SQL Editor
> Warning: **this cannot be undone.** Before you start, make sure the project has no real user data.

---

## When to use this

Truncating the 7 tables in the `public` schema is **not** the same as wiping accounts.

Supabase stores accounts in two separate places:

| Location | What's in it | How to clear it |
| --- | --- | --- |
| `auth.users` | Login credentials (email + password hash) | `delete from auth.users` |
| `public.profiles` and the other 6 tables | Business data | `truncate` |
| `storage.objects` + the files in the bucket | Chat images / videos / voice | Delete manually in the Dashboard |

Clearing only `public` leaves you with "this email is already registered" — because the row in `auth.users` is still there.

---

## Step 0: Snapshot before you start

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

Write down these 9 numbers — you'll compare against them in step 4.

---

## Step 1: Clear `auth.users`

```sql
-- Cannot be undone. If profiles.id has an on delete cascade foreign key, profiles get deleted too
delete from auth.users;
```

**If you get `permission denied for table users`**, the SQL Editor doesn't have enough privileges. Use the Dashboard instead:

```text
Dashboard → Authentication → Users
→ Select all → Delete users
```

---

## Step 2: Clear the 7 business tables

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

> Use `truncate ... cascade` rather than `delete`:
> - It's faster (no row-by-row WAL logging)
> - It also clears objects that depend on these tables
> - `restart identity` resets the auto-increment sequences
>
> This step is a **safety net**: even if the foreign key in step 1 isn't `on delete cascade`, this still clears orphan profile rows.

---

## Step 3: Clear chat media in Storage

**SQL can't delete the actual files** (`storage.objects` is only a metadata index — deleting rows leaves the files taking up space). You have to use the Dashboard:

```text
Dashboard → Storage → chat_media bucket
→ Select all the uuid-named user folders
→ Delete
```

> Don't use `delete from storage.objects where bucket_id = 'chat_media'`:
> it leaves orphan files that eat your quota and can no longer be seen in the Dashboard.

---

## Step 4: Verify everything is empty

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

 **All 9 numbers must be 0**

---

## Step 5: Confirm the structure is intact

Clearing data doesn't affect the structure, but it's worth confirming.

### 5.1 Tables (should be 7)

```sql
select c.relname from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

Expected: `complaints` / `friend_requests` / `friends` / `health_records` / `messages` / `moments` / `profiles`

### 5.2 Triggers (should be 3)

```sql
select tgname from pg_trigger
where not tgisinternal
  and tgrelid::regclass::text in
    ('public.profiles', 'public.health_records', 'auth.users')
order by tgname;
```

Expected: `health_records_touch_updated_at` / `on_auth_user_created` / `trg_enforce_sync_id_change_limit`

### 5.3 RPCs (should be 3)

```sql
select proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('delete_my_account', 'get_server_time', 'unbind_partner')
order by proname;
```

Expected: `delete_my_account` / `get_server_time` / `unbind_partner`

### 5.4 RLS still enabled (should be 7 rows of true)

```sql
select c.relname, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

---

## Step 6: Clear the app's local cache

The app still holds the old account's session token and AsyncStorage cache. If you don't clear them, it will "auto-login" into an account that no longer exists.

**Simulator / physical device**:

```text
Long-press the app icon → Delete App → run npx expo start again to reinstall
```

**Or** (if the app still opens): Settings → Sign out.

---

## After the reset

Sign up with a **brand-new email** and you can walk through B-5 flow 1 end to end (sign up → `handle_new_user()` creates the profile automatically).

---

## Appendix: deleting just one test account (without a full reset)

```sql
-- Replace <email> with the target email
delete from auth.users where email = '<email>';
```

If `profiles` has `on delete cascade`, it's cleaned up automatically; otherwise, do it by hand:

```sql
delete from public.profiles
where id not in (select id from auth.users);
```
