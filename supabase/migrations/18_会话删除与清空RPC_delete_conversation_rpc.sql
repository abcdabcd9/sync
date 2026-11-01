-- --- START OF FILE supabase/migrations/18_会话删除与清空RPC_delete_conversation_rpc.sql ---
-- ============================================================================
-- 修复「删除该聊天 / 清空聊天记录」无法真正删除云端聊天记录
-- ============================================================================
-- 背景（前端实测反馈）：
--   1. 会话列表长按 →「删除该聊天」：聊天记录不删（窗口消失后重新进入又全部回来）。
--   2. 聊天室右上角「3 个点」→「数据」→「清空聊天记录」：同样无效。
--
-- ⚠️ 语义澄清（重要）：
--   「删除该聊天」= 仅删除聊天记录与列表窗口，**不解除好友关系**。
--   好友仍在「联系人」里，之后从联系人点开即可重新发起聊天。
--   因此本迁移只提供「删消息」的函数，不提供删好友的函数。
--
-- 根因：
--   06_核心表启用RLS基线_enable_all_rls.sql 里 messages 的删除策略是
--
--     CREATE POLICY "messages_delete_own"
--     ON public.messages FOR DELETE TO authenticated
--     USING (auth.uid() = user_id);          -- ← 只能删「自己发出的」消息
--
--   而前端清空会话时用的是
--
--     .delete().or('and(user_id.eq.me,receiver_id.eq.peer),
--                  and(user_id.eq.peer,receiver_id.eq.me)')
--
--   PostgREST 的 DELETE 会先按 RLS 的 USING 过滤出「可删行」，
--   对方发来的那些行（user_id = peer）被静默过滤掉 —— 不报错、也不删除。
--   于是「清空」看起来成功了，实际只删掉自己发的那一半，
--   对方发来的消息仍在，重新进入会话又全部拉回来。
--
-- 本迁移提供 SECURITY DEFINER 函数：
--   delete_conversation(p_partner_id UUID) —— 双向删除两人之间的全部消息
--
-- 安全设计（对齐 14_修复unbind_partner提权风险 的加固标准）：
--   a) SECURITY DEFINER + SET search_path = public, pg_temp
--      —— 固定解析路径，堵住同名表劫持提权。
--   b) 函数体内所有表名显式加 public. 前缀 —— 双保险。
--   c) auth.uid() IS NULL 时抛异常 —— 未登录直接拒绝。
--   d) 禁止把自己当参数传入 —— 防止误删自己与自己之间的伪会话。
--   e) 删除范围严格限定为「auth.uid() 与参数用户之间的双向消息」，
--      绝不接受任意 user_id 条件，杜绝越权删除他人聊天记录。
--   f) REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO authenticated
--      —— 仅登录用户可调用。
--
-- 幂等性：
--   CREATE OR REPLACE FUNCTION 可重复执行；REVOKE / GRANT 可重复执行。
--   函数本身是 DELETE，重复调用第二次删 0 行，无副作用。
--
-- 执行方式（二选一）：
--   a) Supabase Dashboard -> SQL Editor -> 粘贴本文件全文执行
--   b) supabase db push
--
-- 执行后自检：
--   SELECT p.proname, p.prosecdef, p.proconfig
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'delete_conversation';
--   期望：prosecdef = true，proconfig 含 search_path=public, pg_temp
-- ============================================================================

-- ---------------------------------------------------------------------------
-- delete_conversation(p_partner_id UUID)：双向删除两人之间的全部消息
-- ---------------------------------------------------------------------------
-- 前端用法：
--   const { error } = await supabase.rpc('delete_conversation', { p_partner_id: peerId });
--
-- 返回：被删除的消息行数（BIGINT）。前端只看 error 是否为空。
--
-- ⚠️ 不触碰 friends / friend_requests —— 好友关系必须保留。
CREATE OR REPLACE FUNCTION public.delete_conversation(p_partner_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_deleted BIGINT := 0;
BEGIN
  -- 加固 c：未登录直接拒绝，不静默成功
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- 加固 d：参数校验
  IF p_partner_id IS NULL THEN
    RAISE EXCEPTION 'partner id is required' USING ERRCODE = '22023';
  END IF;
  IF p_partner_id = v_uid THEN
    RAISE EXCEPTION 'cannot delete conversation with yourself' USING ERRCODE = '22023';
  END IF;

  -- 加固 e：删除范围严格限定为「我 ↔ 对方」的双向消息
  --         表名显式加 public. 前缀（加固 b）
  DELETE FROM public.messages
  WHERE (user_id = v_uid AND receiver_id = p_partner_id)
     OR (user_id = p_partner_id AND receiver_id = v_uid);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_conversation(UUID) TO authenticated;

-- --- END OF FILE supabase/migrations/18_会话删除与清空RPC_delete_conversation_rpc.sql ---
