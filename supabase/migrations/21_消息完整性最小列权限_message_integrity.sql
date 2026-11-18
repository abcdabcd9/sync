-- --- START OF FILE supabase/migrations/21_消息完整性最小列权限_message_integrity.sql ---
-- ============================================================================
-- TASK-P0.2 / Batch A2：消息完整性（最小列权限 + 不可变字段保护）
-- ============================================================================
-- 背景（当前 messages 的写入边界过宽）：
--   messages 表对 authenticated 授予了整表 INSERT / UPDATE / DELETE，
--   配合 RLS 只校验「行归属」，导致以下问题：
--
--   1. 发送者可以改写自己消息的任意列，包括：
--        · receiver_id —— 把已发出的消息「转移」给第三方
--        · created_at  —— 伪造时间线
--        · user_id     —— 伪造发送者（RLS 的 WITH CHECK 会拦，但列权限层无保护）
--        · deleted_by  —— 直接把「对方」写进删除列表，让对方看不到消息
--        · is_read     —— 伪造已读状态
--   2. 接收方通过 messages_update_receiver_read 可以更新整行，
--      而不只是 is_read —— 理论上可改写 text / type / media_url。
--   3. 系统消息（subtype = 'SYNC_PARTNER_*'）与普通消息共用同一写入路径，
--      普通发送可以伪造系统卡片。
--
-- 本迁移的加固策略（不改变正常 UX）：
--   A. 列级权限：把整表 UPDATE 降级为「仅允许修改白名单列」。
--   B. 触发器：禁止不可变字段被改写，并按「OLD 行角色」分区校验：
--        · 发送方（OLD.user_id = auth.uid()）：可撤回、可软删除自己
--        · 接收方（OLD.receiver_id = auth.uid()）：只能标记 is_read
--        · 服务端（SECURITY DEFINER，auth.uid() 为 NULL 或函数属主）：
--          允许系统卡片转换（SYNC_PARTNER_ACCEPTED → SYNC_PARTNER_UNBOUND）
--   C. 系统消息只能由 SECURITY DEFINER RPC 写入（见迁移 20 的 accept/unbind）。
--   D. 保留 delete_conversation 的软删除能力（它走 SECURITY DEFINER，不受列权限限制）。
--
-- T6 修订（针对 GPT A04/A05 与 Gemini P0-1）：
--   1. 撤回协议对齐真实客户端：客户端实际发送
--        { type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null }
--      而不是旧触发器要求的 { type: 'recalled', text: '' }。
--      新触发器接受「type 变为 'action' 且 text 为撤回文案」这一真实协议，
--      同时仍然拒绝任意改写内容（不是宽泛 LIKE '%撤回%'，而是精确匹配
--      客户端固定文案集合，避免被滥用为任意改字）。
--   2. 按 OLD 行角色分区：接收方只能改 is_read；发送方才能改内容/撤回/软删除。
--      服务端（auth.uid() IS NULL，即 SECURITY DEFINER 内部调用）保留系统转换。
--   3. 媒体字段：撤回时允许清空（客户端会置 null），其它情况不得替换。
--
-- 幂等性：REVOKE / GRANT / CREATE OR REPLACE / DROP TRIGGER IF EXISTS。
-- 不修改历史迁移，不触碰既有数据行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 列级 UPDATE 权限：收回整表，按角色重授最小列
-- ---------------------------------------------------------------------------
-- 注意：必须先 REVOKE 整表 UPDATE，否则列级 GRANT 无法「减去」列。
REVOKE UPDATE ON public.messages FROM authenticated;

-- 发送者可改的列（内容编辑 / 撤回 / 软删除标记）
-- 注意：这些列的实际取值仍受第 2 节触发器约束，不是「随便改」。
GRANT UPDATE (
  text,
  media_url,
  thumbnail_url,
  type,
  duration,
  deleted_by
) ON public.messages TO authenticated;

-- 接收者需要标记已读
GRANT UPDATE (is_read) ON public.messages TO authenticated;

-- INSERT 保持整表（新消息需要写全部列），由 RLS messages_insert_own 限制 user_id
-- DELETE 保持整表（RLS messages_delete_own 限制只能删自己的行）
-- service_role 保持 ALL（Edge Function / 注销清理需要）
GRANT ALL ON public.messages TO service_role;

-- ---------------------------------------------------------------------------
-- 2. 不可变字段与合法转换的触发器（按 OLD 行角色分区）
-- ---------------------------------------------------------------------------
-- 该触发器对所有 UPDATE 生效（包括 SECURITY DEFINER 函数）。
-- 角色判定：
--   v_is_sender   := OLD.user_id = auth.uid()
--   v_is_receiver := OLD.receiver_id = auth.uid()
--   v_is_server   := 当前执行角色是表属主（postgres）
--
-- T6.1/FIX-01 修正（关键）：
--   旧实现用 auth.uid() IS NULL 判定「服务端」。实测（真实 JWT claims 下）
--   SECURITY DEFINER 函数内部 auth.uid() **仍然返回调用者的 sub**，
--   并不会变成 NULL。因此旧判定在 RPC 内恒为 false，导致
--   accept_partner_invite 无法把卡片 INVITE → ACCEPTED（会被本触发器拒绝）。
--
--   改为按「当前执行角色」判定：SECURITY DEFINER 函数以属主 postgres 执行，
--   此时 current_user = 'postgres'；而客户端直连时 current_user = 'authenticated'。
--   这样既能放行服务端系统卡片转换，又不会给客户端任何额外权限
--   （客户端无法把 current_user 变成 postgres）。
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
  --
  -- T6.1/FIX-01：卡片生命周期由服务端 RPC 与授权记录在同一事务内推进，
  --   因此这里必须放行完整的合法转换集合，否则 accept/reject/cancel/unbind
  --   会在触发器处失败（旧实现只放行 ACCEPTED → UNBOUND）。
  --   允许的转换（全部要求 v_is_server）：
  --     SYNC_PARTNER_INVITE   → SYNC_PARTNER_ACCEPTED
  --     SYNC_PARTNER_INVITE   → SYNC_PARTNER_REJECTED
  --     SYNC_PARTNER_INVITE   → SYNC_PARTNER_CANCELLED
  --     SYNC_PARTNER_INVITE   → SYNC_PARTNER_EXPIRED   （T6.2 缺陷2b：过期路径）
  --     SYNC_PARTNER_ACCEPTED → SYNC_PARTNER_UNBOUND
  --   客户端（authenticated）永远不满足 v_is_server，无法伪造任何转换。
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
  --     真实客户端撤回 payload（useChatMessages.revokeMessage）：
  --       type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null
  --     本地乐观更新文案为「你撤回了一条消息」，但落库文案是「撤回了一条消息」。
  --     这里精确匹配这两个固定文案，而不是宽泛 LIKE '%撤回%'，
  --     避免被滥用为任意改字。
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
  --
  -- T6.2 收尾缺陷2a：清空媒体字段必须**限定发送方**（撤回场景）。
  --   旧实现只判断「新值为空则放行」，未校验角色 —— 只要 RLS 允许 UPDATE
  --   该行，任何角色（含接收方）都能把 media_url / thumbnail_url 清空，
  --   造成「接收方抹掉对方消息里的媒体」的越权副作用。
  --   正确语义：媒体字段的任何变更（替换或清空）都只允许发送方在撤回时发生。
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

  -- 2.7 deleted_by 只允许发送方追加自己，不允许移除或写入他人
  --
  -- T6/A04 修正：PostgreSQL 没有 uuid[] - uuid[] 运算符，
  -- 原写法 (NEW.deleted_by - OLD.deleted_by) 会在运行期报
  -- "operator does not exist: uuid[] - uuid[]"。
  -- 这里改用 unnest + NOT EXISTS 表达「新增元素集合 ⊆ {v_uid}」。
  IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    IF NOT (
      v_is_sender
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
      RAISE EXCEPTION 'messages.deleted_by can only be appended by the sender'
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
-- 3. 普通发送不得写入系统 subtype（INSERT 侧约束）
-- ---------------------------------------------------------------------------
-- 客户端 INSERT 时若带 subtype，只允许普通业务 subtype 白名单；
-- 系统卡片（SYNC_PARTNER_*）只能由 SECURITY DEFINER RPC 写入。
DROP POLICY IF EXISTS messages_insert_own ON public.messages;

CREATE POLICY messages_insert_own
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (
      subtype IS NULL
      OR subtype NOT LIKE 'SYNC\_PARTNER\_%'
    )
  );

-- 说明：SECURITY DEFINER 函数（如 accept_partner_invite / unbind_partner）
-- 以函数属主身份执行，不受上述 RLS 限制，因此系统卡片仍可正常写入。

-- ---------------------------------------------------------------------------
-- 4. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT column_name, privilege_type
-- FROM information_schema.column_privileges
-- WHERE table_schema='public' AND table_name='messages'
--   AND grantee='authenticated' AND privilege_type='UPDATE'
-- ORDER BY column_name;
-- 期望：仅 text / media_url / thumbnail_url / type / duration / deleted_by / is_read
--
-- SELECT tgname FROM pg_trigger
--   WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal;
-- 期望：包含 messages_guard_update_trg

-- --- END OF FILE supabase/migrations/21_消息完整性最小列权限_message_integrity.sql ---
