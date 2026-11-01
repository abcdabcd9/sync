-- --- START OF FILE supabase/migrations/19_会话软删除_仅删我方视角_soft_delete_conversation.sql ---
-- ============================================================================
-- 修正「删除该聊天 / 清空聊天记录」的语义：改为「仅删我方视角」的软删除
-- ============================================================================
-- 背景（前端实测反馈）：
--   迁移 18 提供的 delete_conversation 是**物理双向删除**：
--
--     DELETE FROM public.messages
--     WHERE (user_id = me AND receiver_id = peer)
--        OR (user_id = peer AND receiver_id = me);
--
--   结果：我在自己手机上点「删除该聊天」，**对方手机上的聊天记录也一起没了**。
--   这是严重的产品语义错误 —— 删除会话应当是「我这边看不到」，
--   而不是「双方都看不到」。微信 / iMessage 等主流 IM 都是单边删除。
--
-- ✅ 正确语义：
--   「删除该聊天」= 仅从**我的**会话列表移除窗口 + 仅让**我**看不到这段历史。
--   对方的消息、对方的会话窗口、对方的好友关系全部不受影响。
--   好友关系始终保留（这一点迁移 18 已经做对，本次继续保留）。
--
-- 实现方案：软删除（soft delete）
--   在 messages 表新增 deleted_by UUID[] 列，记录「哪些用户已删除这条消息」。
--   删除会话时，把「我」追加进该会话所有消息的 deleted_by 数组。
--   读取时过滤掉 deleted_by 包含我的行。
--
--   为什么不用物理删除：
--     物理删除无法做到单边 —— 一行消息同时属于双方，删了就是双方都没了。
--     软删除保留物理行，双方各自维护自己的「可见性」，天然支持单边删除。
--
-- 安全设计（对齐迁移 14 / 18 的加固标准）：
--   a) SECURITY DEFINER + SET search_path = public, pg_temp
--   b) 函数体内表名显式 public. 前缀
--   c) auth.uid() IS NULL → RAISE EXCEPTION ERRCODE '28000'
--   d) 参数校验：NULL / 自己 → ERRCODE '22023'
--   e) 只写 deleted_by 数组，**绝不 DELETE 任何行**，绝不触碰 friends
--   f) REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO authenticated
--
-- 幂等性：
--   CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   均可重复执行。deleted_by 用 array_append + 去重，重复调用不会重复追加。
--
-- 执行方式（二选一）：
--   a) Supabase Dashboard -> SQL Editor -> 粘贴本文件全文执行
--   b) supabase db push
--
-- 执行后自检：
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'messages'
--     AND column_name = 'deleted_by';
--   期望：deleted_by | ARRAY
--
--   SELECT p.proname, p.prosecdef, p.proconfig
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'delete_conversation';
--   期望：prosecdef = true，proconfig 含 search_path=public, pg_temp
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 新增 deleted_by 列
-- ---------------------------------------------------------------------------
-- 语义：已把这条消息从自己会话中删除的用户 ID 列表。
--   - 空数组 / NULL  → 双方都可见（默认）
--   - 含 auth.uid()  → 该用户看不到这条消息
--   - 含双方 ID      → 双方都看不到（但物理行仍在，便于审计/恢复）
--
-- 默认值用 '{}'::uuid[] 而非 NULL，避免前端读到 null 需要额外判空。
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS deleted_by UUID[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.messages.deleted_by IS
  '已删除该消息的用户 ID 列表（软删除）。读取时需过滤掉包含当前用户的行。';

-- 加速「排除我删过的消息」这类查询
CREATE INDEX IF NOT EXISTS messages_deleted_by_idx
  ON public.messages USING GIN (deleted_by);

-- ---------------------------------------------------------------------------
-- 2. 重写 delete_conversation：软删除，仅影响调用者自己
-- ---------------------------------------------------------------------------
-- 前端用法（与迁移 18 完全一致，前端无需改调用签名）：
--   const { error } = await supabase.rpc('delete_conversation', { p_partner_id: peerId });
--
-- 返回：本次被标记为「我删除了」的消息行数（BIGINT）。
--
-- ⚠️ 关键：本函数**不执行任何 DELETE**，只把 auth.uid() 追加进 deleted_by。
--    对方的 deleted_by 不受影响 → 对方仍能看到全部历史。
-- ⚠️ 绝不触碰 friends / friend_requests —— 好友关系必须保留。
CREATE OR REPLACE FUNCTION public.delete_conversation(p_partner_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_affected BIGINT := 0;
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

  -- 加固 e：只把「我」追加进 deleted_by，绝不删除物理行
  --         范围严格限定为「我 ↔ 对方」的双向消息
  --         NOT (v_uid = ANY(deleted_by)) 保证幂等：已标记过的行不再重复处理
  UPDATE public.messages
  SET deleted_by = array_append(deleted_by, v_uid)
  WHERE (
          (user_id = v_uid AND receiver_id = p_partner_id)
       OR (user_id = p_partner_id AND receiver_id = v_uid)
        )
    AND NOT (v_uid = ANY(deleted_by));

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_conversation(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. 读取策略说明（无需改 RLS，改在查询层）
-- ---------------------------------------------------------------------------
-- messages 的 SELECT 策略保持原样（双方都能读到彼此的消息行），
-- 「我删过的看不到」由前端查询条件实现：
--
--   .not('deleted_by', 'cs', `{${user.id}}`)
--
-- 即「deleted_by 不包含我」。这样：
--   - 我删了 → 我的查询过滤掉 → 我看不到
--   - 对方没删 → 对方的查询不过滤 → 对方照常看到
--
-- 之所以不写进 RLS：RLS 是行级「能否访问」的硬边界，
-- 而软删除是「用户偏好」，且需要允许用户之后「恢复」。
-- 放在查询层更灵活，也避免 RLS 表达式里做数组运算带来的性能开销。

-- --- END OF FILE supabase/migrations/19_会话软删除_仅删我方视角_soft_delete_conversation.sql ---
