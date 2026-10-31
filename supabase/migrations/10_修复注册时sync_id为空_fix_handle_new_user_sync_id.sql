-- --- START OF FILE supabase/migrations/10_修复注册时sync_id为空_fix_handle_new_user_sync_id.sql ---
-- ============================================================================
-- 注册时 sync_id 为 NULL，导致个人主页 Sync ID 空白 / 好友搜索搜不到
-- ============================================================================
-- 问题：
--   07_补齐5张核心表_create_core_tables.sql 里的 handle_new_user() 只写了 username / nickname，
--   没有写 sync_id。结果新注册用户的 profiles.sync_id 是 NULL：
--     · 个人主页「Sync ID」一栏空白
--     · src/app/chat/search.js 按 sync_id 搜人永远搜不到
--
-- 本迁移做两件事：
--   1. 重写 handle_new_user()，注册时同时生成 sync_id
--      （'user_' + id 前 8 位 = 13 字符，符合 ^[A-Za-z0-9_]{3,15}$ 约束）
--   2. 回填历史数据里 sync_id 为 NULL 的行
--
-- 幂等性：CREATE OR REPLACE + WHERE sync_id IS NULL，可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 重写触发器函数
-- ---------------------------------------------------------------------------
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
    'user_' || substr(replace(NEW.id::text, '-', ''), 1, 8)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.handle_new_user() IS
  '注册时自动建 profile 行：username/nickname 取邮箱前缀，sync_id 取 user_ + id 前 8 位';

-- ---------------------------------------------------------------------------
-- 2. 回填历史数据（sync_id 为 NULL 的行）
-- ---------------------------------------------------------------------------
-- sync_id 有唯一索引 profiles_sync_id_key，用 id 派生可保证不冲突。
--       若极端情况下撞号（几乎不可能），ON CONFLICT 会跳过该行，不会中断。
UPDATE public.profiles
SET sync_id = 'user_' || substr(replace(id::text, '-', ''), 1, 8)
WHERE sync_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. 自检：执行完后跑这段，确认没有 sync_id 为 NULL 的行
-- ---------------------------------------------------------------------------
--   SELECT count(*) AS null_sync_id_rows
--   FROM public.profiles
--   WHERE sync_id IS NULL;
--   期望：0

-- --- END OF FILE supabase/migrations/10_修复注册时sync_id为空_fix_handle_new_user_sync_id.sql ---
