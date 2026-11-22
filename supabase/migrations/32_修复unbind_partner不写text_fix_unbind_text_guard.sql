-- --- START OF FILE supabase/migrations/32_修复unbind_partner不写text_fix_unbind_text_guard.sql ---
-- ============================================================================
-- P1 R0 / 工作包 A / S3 — 修复 unbind_partner 写 text 触发 messages_guard_update 拒绝
-- ============================================================================
-- 现状（已逐条核实）：
--   迁移 20 的 unbind_partner() 执行：
--     UPDATE public.messages
--     SET text = '', subtype = 'SYNC_PARTNER_UNBOUND'
--     WHERE subtype = 'SYNC_PARTNER_ACCEPTED' AND (...双方...);
--
--   但 messages_guard_update()（迁移 21 §2.4 / 迁移 29 重定义）对 text 的改写
--   仅放行「发送方撤回」且 text ∈ {'撤回了一条消息','你撤回了一条消息'}，
--   且**没有 v_is_server 放行分支**。解绑时 SET text='' 会抛 42501，
--   导致整个 unbind_partner 事务回滚 → 解绑失败。
--
-- 修复方案（最小改动，方案 b）：
--   * 仅将 UPDATE 改为 SET subtype = 'SYNC_PARTNER_UNBOUND'（不触碰 text）。
--   * **不修改** messages_guard_update() 全局触发器（避免放宽全局写边界）。
--   * 保留原函数签名、SECURITY DEFINER、search_path、鉴权边界、身份校验、
--     固定顺序锁、对象级授权查找、静默返回语义、REVOKE/GRANT。
--
-- 为何可行（已核实渲染不依赖 text）：
--   * src/hooks/chat/useChatList.js formatPreview 与
--     src/components/MessageBubble.js 均按 subtype === 'SYNC_PARTNER_UNBOUND'
--     渲染「已解除健康守护伴侣关系」，完全不读取 text。
--   * 历史 SYNC_PARTNER_ACCEPTED 卡片 text 非空，解绑后 subtype 改为 UNBOUND，
--     MessageBubble 先按 subtype 覆盖 displayText，仍显示「已解除…」。
--   * text 为 NULL / '' 时 MessageBubble 不崩溃、不显示空白气泡。
--
-- 幂等性：CREATE OR REPLACE FUNCTION / REVOKE / GRANT 可重复执行。
-- 安全：不输出密钥；不触碰生产库；仅在 Sync-Dev 验证。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.unbind_partner(target_partner_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.partner_authorizations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF target_partner_id IS NULL OR target_partner_id = v_uid THEN
    RAISE EXCEPTION 'invalid target partner' USING ERRCODE = '22023';
  END IF;

  -- 固定顺序锁双方
  PERFORM public.lock_profile_pair(v_uid, target_partner_id);

  -- 只查找「自己与 target 之间」的有效关系（对象级授权）
  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE status = 'accepted'
    AND ((requester_id = v_uid AND addressee_id = target_partner_id)
      OR (requester_id = target_partner_id AND addressee_id = v_uid))
  FOR UPDATE;

  IF NOT FOUND THEN
    -- 不存在「我与 target」的有效关系：不做任何清理，静默返回。
    -- 这防止攻击者通过传任意 id 误清他人绑定。
    RETURN;
  END IF;

  UPDATE public.partner_authorizations
  SET status = 'revoked', responded_at = timezone('utc', now())
  WHERE id = v_row.id;

  -- 仅清理「确实被撤销的这条关系」的双方展示列
  UPDATE public.profiles SET bound_partner_id = NULL
  WHERE id IN (v_row.requester_id, v_row.addressee_id);

  -- 历史卡片状态：仅改 subtype，**不写 text**（S3 修复点）。
  --   旧实现 SET text='' 会被 messages_guard_update() §2.4 拒绝（42501）。
  --   渲染层按 subtype 覆盖文案，不依赖 text，故保留 text 原值安全。
  UPDATE public.messages
  SET subtype = 'SYNC_PARTNER_UNBOUND'
  WHERE subtype = 'SYNC_PARTNER_ACCEPTED'
    AND ((user_id = v_row.requester_id AND receiver_id = v_row.addressee_id)
      OR (user_id = v_row.addressee_id AND receiver_id = v_row.requester_id));
END;
$$;

REVOKE ALL ON FUNCTION public.unbind_partner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unbind_partner(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 自检（执行后手动核对，不自动运行）
-- ---------------------------------------------------------------------------
-- 1) 确认函数仍为 SECURITY DEFINER 且 search_path 固定：
--   SELECT p.proname, p.prosecdef, p.proconfig
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='unbind_partner';
--   期望：prosecdef=true，proconfig 含 search_path=public, pg_temp
--
-- 2) 确认函数体不再写 text（应只 SET subtype）：
--   SELECT prosrc FROM pg_proc
--    WHERE proname='unbind_partner'
--      AND pronamespace='public'::regnamespace;
--   期望：UPDATE public.messages SET subtype = 'SYNC_PARTNER_UNBOUND'（无 text = ''）
--
-- 3) 确认权限：
--   SELECT has_function_privilege('anon','public.unbind_partner(uuid)','EXECUTE') AS anon_can,
--          has_function_privilege('authenticated','public.unbind_partner(uuid)','EXECUTE') AS auth_can;
--   期望：anon_can=false，auth_can=true

-- --- END OF FILE supabase/migrations/32_修复unbind_partner不写text_fix_unbind_text_guard.sql ---
