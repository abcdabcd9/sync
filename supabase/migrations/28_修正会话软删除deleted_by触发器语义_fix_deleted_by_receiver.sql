-- --- START OF FILE supabase/migrations/28_修正会话软删除deleted_by触发器语义_fix_deleted_by_receiver.sql ---
-- ============================================================================
-- TASK-P0.2 / T7 收尾：修正 messages_guard_update() 的 deleted_by 语义
-- ============================================================================
-- 问题（T07「清空聊天记录」失败）：
--   迁移 19 的 delete_conversation(p_partner_id) 以 SECURITY DEFINER 执行，
--   会把当前用户 UUID 追加到「双向」消息的 deleted_by 数组，
--   以实现「仅清空我方视角」的软删除。
--
--   但迁移 21 的 messages_guard_update() 第 2.7 节只允许「发送方」追加自己：
--       IF NOT (v_is_sender AND ...) THEN RAISE ...
--   于是当 UPDATE 命中「对方发来的消息」时 v_is_sender = false，
--   触发器抛错（ERRCODE 42501），整个 RPC 事务回滚 —— 清空聊天记录失败。
--
-- 本迁移的修正（最小语义放宽，仅限 deleted_by）：
--   允许「发送方 或 接收方」把「自己」的 UUID 追加进 deleted_by。
--   其余所有约束原样保留：
--     · 只能追加自己的 UUID（不能写入他人 UUID）
--     · 只增不减（旧集合必须被新集合包含，不能移除已有标记）
--     · 不能修改 user_id / receiver_id / created_at / group_id
--     · 不能修改 text / type（除撤回协议）
--     · 不能修改 media_url / thumbnail_url（除发送方撤回清空）
--     · 不能修改 duration（除发送方撤回清空）
--     · 不能修改 is_read（除接收方 false → true）
--     · 不绕过 RLS，不改变身份判定，不授予任何新列权限
--
-- 幂等性：CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS。
-- 不修改历史迁移 01~27，不触碰既有数据行，不改变列级 GRANT。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.messages_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_is_sender   BOOLEAN := (v_uid IS NOT NULL AND OLD.user_id = v_uid);
  v_is_receiver BOOLEAN := (v_uid IS NOT NULL AND OLD.receiver_id = v_uid);
  -- 服务端 = 以表属主身份执行（SECURITY DEFINER RPC），而非「auth.uid() 为 NULL」
  v_is_server   BOOLEAN := (current_user IN ('postgres', 'supabase_admin', 'service_role'));
BEGIN
  -- 2.1 身份与归属不可变（对所有角色生效）
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'messages.user_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'messages.receiver_id is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'messages.created_at is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'messages.group_id is immutable' USING ERRCODE = '42501';
  END IF;

  -- 2.2 subtype 只允许「系统卡片生命周期」内的转换，且仅服务端可做。
  IF NEW.subtype IS DISTINCT FROM OLD.subtype THEN
    IF NOT (
      v_is_server
      AND (
        (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_ACCEPTED')
        OR (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_REJECTED')
        OR (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_CANCELLED')
        OR (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_EXPIRED')
        OR (OLD.subtype = 'SYNC_PARTNER_ACCEPTED' AND NEW.subtype = 'SYNC_PARTNER_UNBOUND')
      )
    ) THEN
      RAISE EXCEPTION 'messages.subtype transition not allowed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2.3 普通消息不得被「升级」为系统消息
  IF OLD.subtype IS NULL AND NEW.subtype IS NOT NULL THEN
    RAISE EXCEPTION 'cannot promote a normal message to a system message'
      USING ERRCODE = '42501';
  END IF;

  -- 2.4 内容改写：只允许发送方「撤回」，且必须匹配真实客户端协议。
  IF NEW.text IS DISTINCT FROM OLD.text OR NEW.type IS DISTINCT FROM OLD.type THEN
    IF NOT (
      v_is_sender
      AND NEW.type = 'action'
      AND NEW.text IN ('撤回了一条消息', '你撤回了一条消息')
    ) THEN
      RAISE EXCEPTION 'message content can only be changed by recall'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2.5 媒体字段：撤回时允许清空（客户端置 null），其它情况不得替换。
  IF NEW.media_url IS DISTINCT FROM OLD.media_url THEN
    IF NOT (v_is_sender AND COALESCE(NEW.media_url, '') = '') THEN
      RAISE EXCEPTION 'messages.media_url can only be cleared by the sender on recall'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.thumbnail_url IS DISTINCT FROM OLD.thumbnail_url THEN
    IF NOT (v_is_sender AND COALESCE(NEW.thumbnail_url, '') = '') THEN
      RAISE EXCEPTION 'messages.thumbnail_url can only be cleared by the sender on recall'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2.6 is_read 只允许接收方 false → true
  IF NEW.is_read IS DISTINCT FROM OLD.is_read THEN
    IF NOT (v_is_receiver AND OLD.is_read = false AND NEW.is_read = true) THEN
      RAISE EXCEPTION 'messages.is_read can only be set by the receiver'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2.7 deleted_by：允许「发送方 或 接收方」追加「自己」，不允许移除或写入他人
  --
  -- T07 修正：迁移 19 的 delete_conversation 需要为「双向」消息追加当前用户 UUID，
  --   其中包含对方发来的消息（此时 OLD.user_id <> v_uid，v_is_sender = false）。
  --   因此把角色条件从 v_is_sender 放宽为 (v_is_sender OR v_is_receiver)。
  --   其余约束保持不变：
  --     · 只增不减：OLD.deleted_by <@ NEW.deleted_by
  --     · 新增元素必须全部等于 v_uid（不能写入他人 UUID）
  --   这样既修复了「清空聊天记录」，又不会产生跨用户越权。
  IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    IF NOT (
      (v_is_sender OR v_is_receiver)
      -- 只增不减：旧集合必须被新集合包含
      AND OLD.deleted_by <@ NEW.deleted_by
      -- 新增的每一个元素都必须是当前用户自己
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(NEW.deleted_by) AS x
        WHERE x <> ALL (COALESCE(OLD.deleted_by, ARRAY[]::UUID[]))
          AND x <> v_uid
      )
    ) THEN
      RAISE EXCEPTION 'messages.deleted_by can only be appended by the sender or receiver'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2.8 duration 只允许发送方在撤回时清空，或保持原值
  IF NEW.duration IS DISTINCT FROM OLD.duration THEN
    IF NOT (v_is_sender AND COALESCE(NEW.duration, 0) = 0) THEN
      RAISE EXCEPTION 'messages.duration cannot be modified'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_guard_update_trg ON public.messages;
CREATE TRIGGER messages_guard_update_trg
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.messages_guard_update();

-- ---------------------------------------------------------------------------
-- 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- 1) 触发器存在
-- SELECT tgname FROM pg_trigger
--   WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal;
--
-- 2) 列级 UPDATE 权限未被本迁移改变（仍应只有 7 列）
-- SELECT column_name FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='messages'
--     AND grantee='authenticated' AND privilege_type='UPDATE'
--   ORDER BY column_name;

-- --- END OF FILE supabase/migrations/28_修正会话软删除deleted_by触发器语义_fix_deleted_by_receiver.sql ---
