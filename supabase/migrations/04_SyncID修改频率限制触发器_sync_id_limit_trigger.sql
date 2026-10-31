-- ============================================================================
-- 安全审计 #17：Sync ID 修改频率限制下沉到服务端 Trigger
-- ============================================================================
-- 背景：
--   旧实现仅在 account_info.js 前端校验「365 天内只能改一次 Sync ID」。
--   攻击者可直接调用 PostgREST（supabase.from('profiles').update(...)）绕过前端，
--   无限次修改 Sync ID 进行身份伪装 / 撞号 / 骚扰。
--
-- 目标：
--   在 profiles 表上挂 BEFORE UPDATE 触发器，服务端权威判定：
--     · NEW.sync_id 与 OLD.sync_id 不同（确实修改了 Sync ID）
--     · 且 OLD.last_id_modified_at 距今未满 365 天
--   → 直接 RAISE EXCEPTION，事务回滚，前端收到 23514 类错误。
--   若已满 365 天（或从未修改过），自动把 NEW.last_id_modified_at 设为 NOW()，
--   客户端传入的任何时间戳一律被覆盖，杜绝篡改。
--
-- 兼容性：
--   · 仅当 sync_id 真正发生变化时才触发限制，修改 nickname / motto 等字段不受影响。
--   · 使用 clock_timestamp() 而非 now()，避免同一事务内多次调用返回相同值。
--   · SECURITY DEFINER + 固定 search_path，防止 search_path 注入。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 触发器函数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_sync_id_change_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last_modified timestamptz;
  v_now           timestamptz := clock_timestamp();
  v_interval      interval    := interval '365 days';
BEGIN
  -- ① 未修改 Sync ID（含 NULL → NULL、值相同）→ 直接放行，不触碰时间戳
  IF NEW.sync_id IS NOT DISTINCT FROM OLD.sync_id THEN
    -- 保险：禁止客户端伪造 last_id_modified_at
    NEW.last_id_modified_at := OLD.last_id_modified_at;
    RETURN NEW;
  END IF;

  -- ② 修改了 Sync ID → 检查冷却期
  v_last_modified := OLD.last_id_modified_at;

  IF v_last_modified IS NOT NULL AND (v_now - v_last_modified) < v_interval THEN
    RAISE EXCEPTION 'Sync ID 每年仅可修改一次'
      USING ERRCODE = '23514', -- check_violation，前端可据此映射友好提示
            HINT    = 'Sync ID can only be changed once every 365 days.';
  END IF;

  -- ③ 冷却期已满（或首次修改）→ 服务端权威写入当前时间，忽略客户端传值
  NEW.last_id_modified_at := v_now;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_sync_id_change_limit() IS
  '安全审计 #17：服务端强制 Sync ID 每 365 天仅可修改一次，并权威写入 last_id_modified_at';

-- ---------------------------------------------------------------------------
-- 2. 绑定触发器（BEFORE UPDATE，逐行）
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_enforce_sync_id_change_limit ON public.profiles;

CREATE TRIGGER trg_enforce_sync_id_change_limit
BEFORE UPDATE OF sync_id, last_id_modified_at
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_sync_id_change_limit();

-- ---------------------------------------------------------------------------
-- 3. 数据完整性兜底：sync_id 格式与长度约束（与前端 #18 校验保持一致）
-- ---------------------------------------------------------------------------
-- 说明：若已有历史数据不满足约束，ALTER TABLE 会失败。
--       可先执行下方「清洗语句」再添加约束。
-- ---------------------------------------------------------------------------
-- 清洗语句（按需手动执行）：
--   UPDATE public.profiles
--   SET sync_id = 'user_' || substr(replace(id::text, '-', ''), 1, 8)
--   WHERE sync_id IS NULL
--      OR sync_id !~ '^[A-Za-z0-9_]{3,15}$';
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_sync_id_format_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_sync_id_format_check
      CHECK (sync_id IS NULL OR sync_id ~ '^[A-Za-z0-9_]{3,15}$');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 数据完整性兜底：nickname / motto 长度约束（与前端 #18 校验保持一致）
-- ---------------------------------------------------------------------------
-- 【新增】：确保列存在，防止下方添加约束时因找不到列而报错
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nickname text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS motto text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_nickname_length_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_nickname_length_check
      CHECK (nickname IS NULL OR char_length(nickname) <= 20);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_motto_length_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_motto_length_check
      CHECK (motto IS NULL OR char_length(motto) <= 50);
  END IF;
END;
$$;

-- ============================================================================
-- 回滚说明：
--   DROP TRIGGER IF EXISTS trg_enforce_sync_id_change_limit ON public.profiles;
--   DROP FUNCTION IF EXISTS public.enforce_sync_id_change_limit();
--   ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_sync_id_format_check;
--   ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_nickname_length_check;
--   ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_motto_length_check;
-- ============================================================================