-- --- START OF FILE supabase/migrations/07_补齐5张核心表_create_core_tables.sql ---
-- ============================================================================
-- 补齐核心表结构（仓库里缺失的 5 张表）
-- ============================================================================
-- 背景：
--   代码里用到了 8 张表，但仓库的迁移脚本只建了 complaints / moments 两张。
--   剩下 5 张（profiles / messages / friends / friend_requests / health_records）
--   一直是「线上手动建的」，仓库里没有任何 CREATE TABLE。
--   这导致：任何人 clone 仓库后，按 README 跑迁移，App 一启动就到处报错。
--
-- 本迁移的作用：
--   用 IF NOT EXISTS 把 5 张表补齐。**对线上已有的库完全无副作用**
--   （表已存在则整段跳过，不会覆盖数据、不会改列）。
--   对全新的空库，则能一次性建出与线上一致的结构。
--
-- 列定义来源：docs/DB_SCHEMA_REFERENCE.md（从线上 information_schema.columns 导出）
--   不要凭代码猜字段，以该文档为准。
--
-- 额外补的约束（代码强依赖，线上可能缺失）：
--   1. friend_requests UNIQUE(sender_id, receiver_id)
--      → src/app/chat/search.js:110 靠 error.code === '23505' 判断「已发过请求」
--      没有这个唯一约束，重复请求会静默插入成功，前端提示逻辑失效。
--   2. health_records UNIQUE(user_id, record_date)
--      → src/hooks/health/useHealthCloud.js:37 用 upsert + onConflict
--      没有这个唯一约束，upsert 会直接报错（42P10），健康数据存不进云端。
--
-- 幂等性：全部 IF NOT EXISTS / DO $$ 包裹，可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles：用户资料（id 引用 auth.users.id，无默认值）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username            TEXT NOT NULL,
  avatar_url          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  expo_push_token     TEXT,
  bound_partner_id    UUID,
  sync_id             VARCHAR,
  nickname            VARCHAR,
  last_id_modified_at TIMESTAMPTZ,
  public_key          TEXT,
  motto               TEXT
);

-- sync_id 是「搜人」的唯一标识，必须唯一（允许 NULL，NULL 不参与唯一性判断）
CREATE UNIQUE INDEX IF NOT EXISTS profiles_sync_id_key
  ON public.profiles (sync_id)
  WHERE sync_id IS NOT NULL;

-- 按 sync_id 精确搜索（src/app/chat/search.js）
CREATE INDEX IF NOT EXISTS profiles_sync_id_idx
  ON public.profiles (sync_id);

-- ---------------------------------------------------------------------------
-- 2. messages：聊天消息
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  text          TEXT,
  media_url     TEXT,
  thumbnail_url TEXT,
  type          TEXT NOT NULL,
  duration      INTEGER DEFAULT 0,
  receiver_id   UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_read       BOOLEAN DEFAULT false,
  group_id      UUID,          -- 早期群聊遗留，当前代码未使用
  subtype       TEXT
);

-- 拉取两人之间的会话（useChatMessages 按 user_id/receiver_id 双向查）
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON public.messages (user_id, receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_receiver_idx
  ON public.messages (receiver_id, created_at DESC);

-- 未读数统计（CustomTabBar / useChatList）
CREATE INDEX IF NOT EXISTS messages_unread_idx
  ON public.messages (receiver_id)
  WHERE is_read = false;

-- ---------------------------------------------------------------------------
-- 3. friends：好友关系（双向各存一行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friends (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  remark     VARCHAR,
  is_muted   BOOLEAN DEFAULT false,   -- 僵尸列：DB 有，代码改用 AsyncStorage
  is_pinned  BOOLEAN DEFAULT false,   -- 同上
  is_hidden  BOOLEAN DEFAULT false    -- 同上
);

-- 同一对好友只能有一行（防止重复添加）
CREATE UNIQUE INDEX IF NOT EXISTS friends_user_friend_key
  ON public.friends (user_id, friend_id);

CREATE INDEX IF NOT EXISTS friends_user_idx
  ON public.friends (user_id);

CREATE INDEX IF NOT EXISTS friends_friend_idx
  ON public.friends (friend_id);

-- ---------------------------------------------------------------------------
-- 4. friend_requests：好友请求
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friend_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT timezone('utc', now())
);

-- 代码强依赖：search.js:110 靠 23505 判断「已发过请求」
CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_sender_receiver_key
  ON public.friend_requests (sender_id, receiver_id);

CREATE INDEX IF NOT EXISTS friend_requests_receiver_idx
  ON public.friend_requests (receiver_id, status);

-- ---------------------------------------------------------------------------
-- 5. health_records：健康打卡（每人每天一行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.health_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  record_date  DATE NOT NULL,
  water_amount INTEGER DEFAULT 0,
  meals_status JSONB DEFAULT '{"早餐": false, "午餐": false, "晚餐": false}'::jsonb,
  updated_at   TIMESTAMPTZ DEFAULT timezone('utc', now())
);

-- 代码强依赖：useHealthCloud.js:37 用 upsert + onConflict: 'user_id, record_date'
--    没有这个唯一约束，upsert 会报 42P10，健康数据无法上云。
CREATE UNIQUE INDEX IF NOT EXISTS health_records_user_date_key
  ON public.health_records (user_id, record_date);

CREATE INDEX IF NOT EXISTS health_records_date_idx
  ON public.health_records (record_date DESC);

-- ---------------------------------------------------------------------------
-- 6. 自动维护 updated_at（health_records 用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS health_records_touch_updated_at ON public.health_records;
CREATE TRIGGER health_records_touch_updated_at
  BEFORE UPDATE ON public.health_records
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 7. 新用户注册时自动建 profile 行
-- ---------------------------------------------------------------------------
-- 说明：profiles.id 没有默认值，说明线上是靠触发器或客户端写入的。
--       这里补一个触发器，保证 auth.users 新增时 profiles 一定有对应行，
--       否则 messages / friends 的外键会因 profile 缺失而插入失败。
--
-- 三个字段的生成规则：
--   username / nickname → 邮箱前缀（如 alice@x.com → alice），用户可在 account_info 页改
--   sync_id             → 'user_' || id 前 8 位（共 13 字符，符合
--                          profiles_sync_id_format_check 的 ^[A-Za-z0-9_]{3,15}$）
--
-- sync_id 必须在这里生成：它是「搜人」的唯一凭证，留 NULL 会导致
--    个人主页 Sync ID 一栏空白、好友搜索无法命中。见 docs/DB_SCHEMA_REFERENCE.md。
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
    'user_' || substr(NEW.id::text, 1, 8)
  );

  INSERT INTO public.profiles (id, username, nickname, sync_id)
  VALUES (
    NEW.id,
    v_base,
    v_base,
    -- sync_id 用 id 派生，保证唯一且符合格式约束（3-15 位字母数字下划线）
    'user_' || substr(replace(NEW.id::text, '-', ''), 1, 8)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 在 auth.users 上建触发器需要较高权限。
--    Supabase 迁移默认以 postgres 角色执行，通常没问题；
--    但若在受限环境（如自建库、CI 只读角色）执行，这里会报权限错误。
--    用 DO 块包裹，权限不足时只告警、不中断整个迁移
--    （其余建表语句已经生效，profile 行可由客户端兜底写入）。
DO $$
BEGIN
  DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
  CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING '无法在 auth.users 上创建触发器（权限不足），请手动在 Dashboard 创建，或由客户端兜底写入 profiles 行。';
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. 表级权限（GRANT）—— 极易遗漏，漏了 App 全线 permission denied
-- ---------------------------------------------------------------------------
-- PostgreSQL 的访问控制是两层的：
--     第 1 层：表级权限（GRANT SELECT / INSERT / UPDATE / DELETE）
--     第 2 层：行级安全（RLS 策略）
--   两层都必须通过。只建 RLS 不 GRANT，查询会在第 1 层就被拒绝，
--   RLS 根本没机会执行，前端只会看到 "permission denied for table xxx"。
--
--   Supabase Dashboard 手动建表会自动补 GRANT，但用 SQL 脚本建表不会。
--   所以脚本里必须显式写。
--
--   完整版见 11_补齐7张表GRANT授权_grant_table_privileges.sql（含序列权限与自检 SQL）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friends         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friend_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.health_records  TO authenticated;

GRANT SELECT ON public.profiles TO anon;

GRANT ALL ON public.profiles        TO service_role;
GRANT ALL ON public.messages        TO service_role;
GRANT ALL ON public.friends         TO service_role;
GRANT ALL ON public.friend_requests TO service_role;
GRANT ALL ON public.health_records  TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Realtime publication —— 漏了它，实时刷新会静默失效
-- ---------------------------------------------------------------------------
-- Supabase 的访问控制其实是三层的：
--     第 1 层：表级权限（GRANT）
--     第 2 层：行级安全（RLS）
--     第 3 层：Realtime publication
--   Realtime 服务只广播「被加入 publication 的表」的变更。
--   项目初始化时 publication `supabase_realtime` 是空的，
--   Dashboard 点开关加表 = ALTER PUBLICATION ... ADD TABLE，
--   而 SQL 脚本 CREATE TABLE 不会自动加入。
--
--   漏了这层：订阅能成功建立，但永远收不到事件 —— 不报错，只是不刷新。
--   代码依赖：useChatList / useChatMessages / CustomTabBar（messages）、
--             useHealthCloud（health_records）。
--
--   完整版见 12_开启Realtime实时刷新_enable_realtime_publication.sql（含幂等 DO 块与自检）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'health_records'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.health_records;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. chat_media：Storage 桶（不是表）
-- ---------------------------------------------------------------------------
-- 代码里 supabase.storage.from('chat_media') 用的是 Storage 桶，不是数据库表。
-- 桶本身无法用 SQL 迁移创建（需走 Storage API / Dashboard），
-- 但桶的访问策略可以在这里补。详见 03_聊天媒体桶私有化_private_chat_media_bucket.sql。
-- 此处仅做存在性提示，不重复创建。

-- --- END OF FILE supabase/migrations/07_补齐5张核心表_create_core_tables.sql ---
