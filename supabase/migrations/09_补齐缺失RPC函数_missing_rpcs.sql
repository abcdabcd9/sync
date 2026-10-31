-- --- START OF FILE supabase/migrations/09_补齐缺失RPC函数_missing_rpcs.sql ---
-- ============================================================================
-- 补齐两个缺失的 RPC 函数
-- ============================================================================
-- 代码里在调，但仓库里没有任何迁移定义它们：
--   1. delete_my_account()  → src/app/settings/security.js:111
--   2. get_server_time()    → src/hooks/health/useTimeSync.js:41
--                              src/app/account_info.js:203, 252
--
-- 这两个函数在线上库大概率已存在（否则注销和时空校准早就报错了），
-- 本迁移用 CREATE OR REPLACE 重写，保证仓库与线上一致、可重复执行。
--
-- 幂等性：CREATE OR REPLACE，可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. get_server_time()：返回服务端 UTC 时间
-- ---------------------------------------------------------------------------
-- 用途：防止用户改手机系统时间，伪造「今天已打卡」或刷连续天数。
-- 前端用法：const { data } = await supabase.rpc('get_server_time');
--           new Date(data)  → 与本地 Date.now() 求差得到 offset
--
-- 返回类型选 TIMESTAMPTZ：Supabase 会序列化成 ISO 8601 字符串
-- （如 "2026-10-31T18:24:00.123456+00:00"），new Date() 可直接解析。
--
-- STABLE + SECURITY INVOKER，不读任何表，无泄露风险。
--       允许 anon 调用（登录前也需要校准时间）。
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
  SELECT timezone('utc', now());
$$;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. delete_my_account()：注销当前登录账号
-- ---------------------------------------------------------------------------
-- 用途：src/app/settings/security.js 二次确认后调用，彻底抹除云端数据。
--
-- 设计要点：
--   a) SECURITY DEFINER —— 删除 auth.users 需要高权限，普通 authenticated 角色做不到。
--   b) 必须显式 SET search_path —— SECURITY DEFINER 函数不设 search_path 是经典提权漏洞
--      （攻击者可建同名对象劫持函数内的表引用）。
--   c) 只删 auth.uid() 自己 —— 绝不接受参数，防止删别人账号。
--   d) 未登录时直接抛异常，不静默成功。
--   e) 依赖外键 ON DELETE CASCADE 清理业务数据：
--      profiles / messages / friends / friend_requests / health_records / complaints
--      都引用 profiles(id) 或 auth.users(id) 且带 CASCADE（见 07_补齐5张核心表_create_core_tables.sql）。
--      moments 同理。
--   f) 先清 bound_partner_id，避免搭子那边留下指向已删用户的悬空引用。
--      （虽然 profiles 行会被删，但对方 profiles.bound_partner_id 不会自动清空）
--
-- 返回：void。前端只看 error 是否为空。
CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- 1. 解除搭子绑定（清掉对方指向我的 bound_partner_id）
  UPDATE public.profiles
  SET bound_partner_id = NULL
  WHERE bound_partner_id = v_uid;

  -- 2. 清空自己的推送 token，避免注销过程中还有推送发到这台设备
  UPDATE public.profiles
  SET expo_push_token = NULL
  WHERE id = v_uid;

  -- 3. 删除 auth.users 行 —— 业务表靠 ON DELETE CASCADE 级联清理
  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;

-- 只允许登录用户调用，anon 无权注销
REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. 自检：确认两个函数都已存在且签名正确
-- ---------------------------------------------------------------------------
--   SELECT p.proname,
--          pg_get_function_arguments(p.oid) AS args,
--          pg_get_function_result(p.oid)    AS returns,
--          p.prosecdef                      AS security_definer
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('delete_my_account', 'get_server_time', 'unbind_partner');
--
-- 期望：
--   delete_my_account | (无参数) | void        | true
--   get_server_time   | (无参数) | timestamptz | false
--   unbind_partner    | target_partner_id uuid | void | true

-- --- END OF FILE supabase/migrations/09_补齐缺失RPC函数_missing_rpcs.sql ---
