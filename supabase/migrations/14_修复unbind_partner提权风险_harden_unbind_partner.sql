-- --- START OF FILE supabase/migrations/14_修复unbind_partner提权风险_harden_unbind_partner.sql ---
-- ============================================================================
-- 安全审计 #31：修复 unbind_partner 的 SECURITY DEFINER 提权风险
-- ============================================================================
-- 背景：
--   05_双向解绑伴侣RPC_unbind_partner_rpc.sql 定义的 unbind_partner 是
--   SECURITY DEFINER 函数，但**没有固定 search_path**。
--
--   这是 PostgreSQL 官方文档明确列出的经典提权模式：
--     SECURITY DEFINER 函数以函数属主（通常是 postgres）身份执行，
--     若未固定 search_path，函数体内未加 schema 前缀的表名（profiles / messages）
--     会按调用者的 search_path 解析。攻击者只要在自己可写的 schema（例如
--     默认存在的 public，或自建的 schema）里建一张同名表，就能让函数
--     以 postgres 权限去操作攻击者的表，进而提权。
--
--   同一个项目里 09_补齐缺失RPC函数_missing_rpcs.sql 的 delete_my_account
--   就写对了（SECURITY DEFINER + SET search_path = public, auth, pg_temp），
--   本迁移把 unbind_partner 对齐到同一标准。
--
-- 本迁移的 6 处加固：
--   1. SET search_path = public, pg_temp —— 固定解析路径，堵住同名表劫持。
--   2. 函数体内所有表名加 public. 前缀 —— 双保险，即使 search_path 被改也不跑偏。
--   3. REVOKE ALL ... FROM PUBLIC + GRANT EXECUTE ... TO authenticated
--      —— 默认所有角色（含 anon）都能调用，收紧为仅登录用户。
--   4. auth.uid() IS NULL 时抛异常 —— 未登录直接拒绝，不静默成功。
--   5. target_partner_id = auth.uid() 时抛异常 —— 禁止自己解绑自己。
--   6. 函数签名保持不变（target_partner_id UUID -> void），
--      前端 src/app/bind_partner.js:239 的 supabase.rpc 调用方式无需改动。
--
-- 幂等性：
--   CREATE OR REPLACE FUNCTION 可重复执行；REVOKE / GRANT 可重复执行。
--   本迁移**只改函数定义，不触碰 profiles / messages 的任何数据行**。
--
-- 执行方式（二选一）：
--   a) Supabase Dashboard -> SQL Editor -> 粘贴本文件全文执行
--   b) supabase db push
--
-- 执行后自检：
--   SELECT p.proname, p.prosecdef, p.proconfig
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'unbind_partner';
--   期望：prosecdef = true，proconfig 含 search_path=public, pg_temp
--
-- 回滚（如需临时恢复旧行为）：
--   ALTER FUNCTION public.unbind_partner(UUID) RESET search_path;
--   或重跑 05_双向解绑伴侣RPC_unbind_partner_rpc.sql 覆盖回去。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.unbind_partner(target_partner_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  -- 加固 4：未登录直接拒绝，不静默成功
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- 加固 5：禁止自己解绑自己（前端永远传对方 id，不会触发）
  IF target_partner_id = v_uid THEN
    RAISE EXCEPTION 'cannot unbind yourself' USING ERRCODE = '22023';
  END IF;

  -- 1. 双向解绑：清空双方的 bound_partner_id
  --    加固 2：表名显式加 public. 前缀
  UPDATE public.profiles
  SET bound_partner_id = NULL
  WHERE id = v_uid OR id = target_partner_id;

  -- 2. 精准更新两人之间的「同意绑定」历史卡片，改为解除绑定状态
  --    只动 subtype = 'SYNC_PARTNER_ACCEPTED' 且收发双方恰为这两人的消息，
  --    不误伤其他聊天记录。
  UPDATE public.messages
  SET text = '', subtype = 'SYNC_PARTNER_UNBOUND'
  WHERE subtype = 'SYNC_PARTNER_ACCEPTED'
    AND (
      (user_id = v_uid AND receiver_id = target_partner_id)
      OR
      (user_id = target_partner_id AND receiver_id = v_uid)
    );
END;
$$;

-- 加固 3：默认 PUBLIC（含 anon）可执行，收紧为仅 authenticated
REVOKE ALL ON FUNCTION public.unbind_partner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unbind_partner(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 自检（执行后单独跑这一段确认加固生效）
-- ---------------------------------------------------------------------------
-- SELECT p.proname,
--        pg_get_function_arguments(p.oid) AS args,
--        p.prosecdef                      AS security_definer,
--        p.proconfig                      AS config
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname = 'unbind_partner';
--
-- 期望：
--   unbind_partner | target_partner_id uuid | true | {search_path=public, pg_temp}
--
-- 再确认权限：
-- SELECT has_function_privilege('anon',          'public.unbind_partner(uuid)', 'EXECUTE') AS anon_can,
--        has_function_privilege('authenticated', 'public.unbind_partner(uuid)', 'EXECUTE') AS auth_can;
-- 期望：anon_can = false，auth_can = true
-- ---------------------------------------------------------------------------
-- --- END OF FILE supabase/migrations/14_修复unbind_partner提权风险_harden_unbind_partner.sql ---
