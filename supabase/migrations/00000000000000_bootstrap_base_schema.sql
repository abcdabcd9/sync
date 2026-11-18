-- --- START OF FILE supabase/bootstrap/00_bootstrap_base_schema.sql ---
-- ============================================================================
-- Bootstrap：为历史迁移 01–06 提供「最小必要」基础结构
-- ============================================================================
-- 为什么需要这个脚本？
--   仓库的迁移序列 01–27 中，01–06 会直接操作 profiles / messages /
--   health_records / friends 等表，但这 5 张核心表的 CREATE TABLE 直到
--   07 才出现（07 的注释也说明了：这些表历史上是「线上手动建的」）。
--   因此在一个全新的空库上按 01→27 顺序执行，01–06 必然失败。
--
-- 本脚本的定位：
--   只补齐「让 01–06 能成功执行」所必需的最小结构（表 + 列 + 主键 + 外键）。
--   索引、函数、触发器、GRANT、Realtime 发布等一律不在此创建，
--   全部交给 07 及后续迁移按原设计完成，避免与历史迁移产生重复/冲突。
--
-- 与 07 的关系（关键）：
--   07 中所有 CREATE TABLE 均为 IF NOT EXISTS，且索引/函数/GRANT/发布
--   是彼此独立的语句。因此本脚本先建表后，07 仍会正常创建索引、
--   touch_updated_at()、handle_new_user()、GRANT 与 publication，
--   不会因为表已存在而跳过这些内容。
--
-- 幂等性：
--   全部使用 CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，
--   可重复执行。列定义与 07 完全一致，保证 07 的 IF NOT EXISTS 命中后
--   结构不产生偏差。
--
-- 执行顺序：
--   本脚本必须在 01 之前执行，且只在「全新空库」上执行一次。
--   已存在数据的库（如生产）不应执行本脚本。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 前置检查：确认运行在 Supabase 兼容环境（auth.users 必须存在）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION
      'Bootstrap 中止：未找到 auth.users。本脚本必须在 Supabase 环境（含 auth schema）中执行。';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. profiles：用户资料
--    01–06 依赖的列：
--      04 → sync_id, last_id_modified_at, nickname, motto
--      05 → id, bound_partner_id
--      06 → id, bound_partner_id
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

-- 防御：若表已存在但缺列（例如更早的手工建表），补齐 01–06 所需列。
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username            TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url          TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ DEFAULT timezone('utc', now());
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS expo_push_token     TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS bound_partner_id    UUID;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS sync_id             VARCHAR;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nickname            VARCHAR;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_id_modified_at TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS public_key          TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS motto               TEXT;

-- ---------------------------------------------------------------------------
-- 2. messages：聊天消息
--    01–06 依赖的列：
--      01 → subtype
--      02 → media_url, thumbnail_url, user_id, receiver_id
--      05 → text, subtype, user_id, receiver_id
--      06 → user_id, receiver_id, is_read
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
  group_id      UUID,
  subtype       TEXT
);

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ DEFAULT timezone('utc', now());
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS user_id       UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS text          TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_url     TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS type          TEXT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS duration      INTEGER DEFAULT 0;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS receiver_id   UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS is_read       BOOLEAN DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS group_id      UUID;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS subtype       TEXT;

-- ---------------------------------------------------------------------------
-- 3. friends：好友关系
--    06 依赖的列：user_id, friend_id
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friends (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  remark     VARCHAR,
  is_muted   BOOLEAN DEFAULT false,
  is_pinned  BOOLEAN DEFAULT false,
  is_hidden  BOOLEAN DEFAULT false
);

ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS friend_id  UUID;
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS status     TEXT DEFAULT 'accepted';
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT timezone('utc', now());
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS remark     VARCHAR;
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS is_muted   BOOLEAN DEFAULT false;
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS is_pinned  BOOLEAN DEFAULT false;
ALTER TABLE public.friends ADD COLUMN IF NOT EXISTS is_hidden  BOOLEAN DEFAULT false;

-- ---------------------------------------------------------------------------
-- 4. health_records：健康打卡
--    06 依赖的列：user_id
--    22 依赖的列：created_at（迁移 22 第 40 行回填语句
--                 `COALESCE(updated_at, created_at, now())` 直接引用该列，
--                 而 07 的建表定义里并没有 created_at —— 这是历史迁移
--                 22 自身的缺陷，在任何环境执行都会报 42703。
--                 按「不改历史迁移」的约束，在 Bootstrap 中补出该列，
--                 使 22 能正常通过。列定义与 07 注释所述线上实际结构一致。）
--    注意：updated_at 由 07 建表时定义、22 再补 IF NOT EXISTS，此处不建。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.health_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  record_date  DATE NOT NULL,
  water_amount INTEGER DEFAULT 0,
  meals_status JSONB DEFAULT '{"早餐": false, "午餐": false, "晚餐": false}'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT timezone('utc', now())
);

ALTER TABLE public.health_records ADD COLUMN IF NOT EXISTS user_id      UUID;
ALTER TABLE public.health_records ADD COLUMN IF NOT EXISTS record_date  DATE;
ALTER TABLE public.health_records ADD COLUMN IF NOT EXISTS water_amount INTEGER DEFAULT 0;
ALTER TABLE public.health_records ADD COLUMN IF NOT EXISTS meals_status JSONB DEFAULT '{"早餐": false, "午餐": false, "晚餐": false}'::jsonb;
ALTER TABLE public.health_records ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ DEFAULT timezone('utc', now());

-- ---------------------------------------------------------------------------
-- 5. friend_requests：好友请求
--    01–06 未直接依赖，但 06 的 moments 策略与 08 的策略均引用 friends；
--    此处一并建出，保证 07 的 IF NOT EXISTS 命中后结构一致。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friend_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT timezone('utc', now())
);

ALTER TABLE public.friend_requests ADD COLUMN IF NOT EXISTS sender_id   UUID;
ALTER TABLE public.friend_requests ADD COLUMN IF NOT EXISTS receiver_id UUID;
ALTER TABLE public.friend_requests ADD COLUMN IF NOT EXISTS status      TEXT DEFAULT 'pending';
ALTER TABLE public.friend_requests ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT timezone('utc', now());

-- ---------------------------------------------------------------------------
-- 6. 完成提示
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE 'Bootstrap 完成：profiles / messages / friends / health_records / friend_requests 基础结构已就绪，可继续执行 01–27。';
END
$$;

-- --- END OF FILE supabase/bootstrap/00_bootstrap_base_schema.sql ---
