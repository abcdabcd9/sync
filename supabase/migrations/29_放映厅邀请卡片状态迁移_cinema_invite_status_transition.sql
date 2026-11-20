-- ============================================================================
-- 29 —— 放映厅邀请卡片状态迁移（cinema invite status transition）
-- ============================================================================
-- 关联任务：TASK-P0.4 / FIX-B / P04-BUG-02
-- 前置迁移：21（消息完整性最小列权限）、28（deleted_by 触发器语义）
--
-- ----------------------------------------------------------------------------
-- 一、问题
-- ----------------------------------------------------------------------------
-- 现象：放映厅邀请卡片发出后，放映结束时卡片状态无法更新为「已失效」，
--       客户端日志报：permission denied for table messages。
--
-- 根因（两条独立约束叠加）：
--   (A) 列级权限：迁移 21 只把
--         text, media_url, thumbnail_url, type, duration, deleted_by, is_read
--       授予 authenticated，**subtype 不在其中**。客户端任何对 subtype 的
--       UPDATE 都会在权限层被拒（permission denied for table messages）。
--   (B) 触发器语义：迁移 28 的 messages_guard_update() §2.2 只允许
--       SYNC_PARTNER_* 之间的转换，且 §2.3 明确禁止
--       「普通消息（subtype IS NULL）升级为系统消息」。
--
-- 关键矛盾：
--   现有邀请卡片在 INSERT 时 **subtype = NULL**（见 src/app/invite_friend.js，
--   只写 type='cinema_invite'，未写 subtype）。因此若照搬「OLD.subtype =
--   'SYNC_CINEMA_INVITE'」的转换规则，对存量卡片永远不成立 —— 规则与数据矛盾。
--
-- ----------------------------------------------------------------------------
-- 二、解决思路（最小、可审计、不放宽整表权限）
-- ----------------------------------------------------------------------------
--   1. 不修改历史迁移 01~28，不触碰既有数据行。
--   2. 仅把 subtype 的 UPDATE 权限授予 **service_role**（SECURITY DEFINER RPC
--      以属主身份执行），**绝不**授予 authenticated —— 客户端仍无法直接改 subtype。
--   3. 新增 SECURITY DEFINER RPC：
--        · end_cinema_invite(uuid)          —— 按消息 id 结束单张卡片
--        · end_cinema_invites_by_room(text) —— 按 roomId 结束该房间全部卡片
--      客户端改为调用 RPC（而非直接 UPDATE subtype）。RPC 内校验
--      「调用者 = 发送方 + 类型 = cinema_invite + 起点 subtype ∈ (NULL,
--      SYNC_CINEMA_INVITE)」，只改 subtype 一列，幂等，返回受影响行数。
--   4. 在 messages_guard_update() 中新增「放映厅卡片生命周期」转换：
--        允许 v_is_server 且
--          ( OLD.subtype IS NULL AND OLD.type = 'cinema_invite'
--            AND NEW.subtype = 'SYNC_CINEMA_ENDED' )
--        或
--          ( OLD.subtype = 'SYNC_CINEMA_INVITE' AND NEW.subtype = 'SYNC_CINEMA_ENDED' )
--      即：**存量卡片（subtype=NULL）与新卡片（subtype=SYNC_CINEMA_INVITE）
--      都能安全转换到 SYNC_CINEMA_ENDED**。
--   5. 该转换只允许「服务端」执行（v_is_server），接收方 / 无关账号 / 普通
--      客户端一律拒绝。
--   6. 除 subtype 外，其余受保护字段（user_id / receiver_id / created_at /
--      group_id / text / type / media_url / thumbnail_url / duration / is_read /
--      deleted_by）的约束**原样保留**，不因本迁移放宽。
--   7. 不改动 messages 表的整表 RLS，不改动整表 UPDATE 授权。
--
-- ----------------------------------------------------------------------------
-- 三、Realtime 双端可见性
-- ----------------------------------------------------------------------------
--   迁移 12/13 已将 messages 加入 Realtime publication；迁移 16 为白名单。
--   本迁移**不新增/不删除**任何 publication 成员，仅改触发器与列权限。
--   双端收到 UPDATE 事件依赖既有 postgres_changes 订阅：
--     · 接收方：useChatMessages 订阅 receiver_id=eq.<me>（UPDATE 可收到）
--     · 发送方：useChatMessages 另有一条 user_id=eq.<me> 的 UPDATE 订阅
--       （单列等值，不使用 OR / 逗号组合过滤语法）
--
-- ----------------------------------------------------------------------------
-- 四、幂等性
-- ----------------------------------------------------------------------------
--   REVOKE / GRANT / CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS 均幂等。
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 列级权限：subtype 仅授予 service_role（不授予 authenticated）
-- ---------------------------------------------------------------------------
-- 说明：迁移 21 已 REVOKE 整表 UPDATE FROM authenticated 并按列重授。
--       这里只对 service_role 追加 subtype 的 UPDATE 权限。
--       service_role 在迁移 21 已拥有 GRANT ALL，此处为显式声明意图 + 幂等兜底。
GRANT UPDATE (subtype) ON public.messages TO service_role;

-- 防御性断言：确保 authenticated 仍然**没有** subtype 的 UPDATE 权限。
-- （若历史环境误授，这里显式收回，保证「客户端不能改 subtype」这条红线。）
REVOKE UPDATE (subtype) ON public.messages FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. SECURITY DEFINER RPC：end_cinema_invite(p_message_id)
-- ---------------------------------------------------------------------------
-- 为什么需要 RPC：
--   客户端（authenticated）**没有** subtype 的 UPDATE 权限（这是红线，不能放开）。
--   因此客户端不能直接 UPDATE messages.subtype，必须通过一个受控的
--   SECURITY DEFINER 函数，由函数属主执行转换。
--
-- 安全设计：
--   a) SECURITY DEFINER + 收紧的 search_path（pg_catalog, pg_temp），
--      函数体内所有对象引用显式限定 schema，防止 search_path 劫持提权。
--   b) 只允许「合法发送方」调用：查询同时限定 id 与 user_id = auth.uid()，
--      未命中统一 RETURN 0 —— 不区分「消息不存在」「不是我的消息」
--      「不是邀请卡片」，避免通过返回值探测其它消息的存在性。
--   c) 只允许 type='cinema_invite' 且 subtype ∈ (NULL, 'SYNC_CINEMA_INVITE')
--      的行转换到 'SYNC_CINEMA_ENDED'；其它类型 / 其它 subtype 一律拒绝。
--   d) 只改 subtype 一列，绝不触碰 user_id / receiver_id / text / created_at 等。
--   e) 幂等：已是 SYNC_CINEMA_ENDED 时直接返回 0，不报错、不重复写。
--   f) 返回受影响行数（0 表示未命中 / 无权限 / 已结束），供客户端判断。
--
-- 注意：函数以属主身份执行，触发器内 v_is_server 为 TRUE，因此 §3 新增的
--       放映厅转换分支会放行；但函数自身已做「发送方 + 类型 + 目标 subtype」
--       三重校验，触发器是第二道防线。
CREATE OR REPLACE FUNCTION public.end_cinema_invite(p_message_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_row     public.messages%ROWTYPE;
  v_updated INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- 同时限定 id 与 user_id：非本人消息与不存在的消息走同一条路径，
  -- 统一 RETURN 0，不泄露「该 id 是否存在」。
  SELECT * INTO v_row
    FROM public.messages
   WHERE id = p_message_id
     AND user_id = v_uid;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- 只处理放映厅邀请卡片（非邀请卡片同样 RETURN 0，不抛异常、不泄露类型）
  IF v_row.type IS DISTINCT FROM 'cinema_invite' THEN
    RETURN 0;
  END IF;

  -- 幂等：已结束则直接返回
  IF v_row.subtype = 'SYNC_CINEMA_ENDED' THEN
    RETURN 0;
  END IF;

  -- 只允许 NULL 或 SYNC_CINEMA_INVITE 作为起点；其它 subtype 一律拒绝
  IF v_row.subtype IS NOT NULL AND v_row.subtype <> 'SYNC_CINEMA_INVITE' THEN
    RETURN 0;
  END IF;

  UPDATE public.messages
     SET subtype = 'SYNC_CINEMA_ENDED'
   WHERE id = p_message_id
     AND user_id = v_uid
     AND type = 'cinema_invite'
     AND (subtype IS NULL OR subtype = 'SYNC_CINEMA_INVITE');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2b. 批量版本：end_cinema_invites_by_room(p_room_id TEXT)
-- ---------------------------------------------------------------------------
-- 为什么需要批量版本：
--   同一放映厅 roomId 可能对应**多张**邀请卡片 —— invite_friend.js 每次点击
--   「邀请」都会生成新的 msgId 并插入一条新消息，而 text 始终是同一个 roomId。
--   因此「关闭放映厅」时必须结束该 roomId 下**全部**合法邀请卡片，
--   不能只更新任意一张（否则其它好友的卡片会永远停留在「邀请中」）。
--
-- 安全设计（与单条版本一致，仅把「按 id」换成「按 roomId + 发送方」）：
--   a) SECURITY DEFINER + 收紧 search_path（pg_catalog, pg_temp），对象全限定。
--   b) 只处理 user_id = auth.uid() 的行 —— 接收方/无关账号调用影响 0 行。
--   c) 只处理 type='cinema_invite' 且 subtype ∈ (NULL, 'SYNC_CINEMA_INVITE') 的行。
--   d) 只改 subtype 一列。
--   e) 幂等：已 ENDED 的行不在 WHERE 条件内，重复调用返回 0。
--   f) 返回受影响行数。
CREATE OR REPLACE FUNCTION public.end_cinema_invites_by_room(p_room_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_updated INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_room_id IS NULL OR btrim(p_room_id) = '' THEN
    RETURN 0;
  END IF;

  UPDATE public.messages
     SET subtype = 'SYNC_CINEMA_ENDED'
   WHERE user_id = v_uid
     AND type = 'cinema_invite'
     AND text = p_room_id
     AND (subtype IS NULL OR subtype = 'SYNC_CINEMA_INVITE');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2c. 函数执行权限
-- ---------------------------------------------------------------------------
-- 必须**显式**撤销 anon 与 PUBLIC 的执行权，不能仅依赖「默认没有」。
-- PostgreSQL 中新建函数默认对 PUBLIC 授予 EXECUTE，因此：
--   1) REVOKE ALL ... FROM PUBLIC   —— 收回默认的 PUBLIC 执行权
--   2) REVOKE ALL ... FROM anon     —— 显式声明（幂等，防历史环境误授）
--   3) GRANT EXECUTE ... TO authenticated —— 只给登录用户
REVOKE ALL ON FUNCTION public.end_cinema_invite(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_cinema_invite(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.end_cinema_invite(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.end_cinema_invites_by_room(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_cinema_invites_by_room(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.end_cinema_invites_by_room(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. 重写 messages_guard_update()：在 §2.2 增加放映厅卡片生命周期转换
-- ---------------------------------------------------------------------------
-- 与迁移 28 的差异**仅限** §2.2 的允许转换集合：
--   新增 (OLD.subtype IS NULL AND OLD.type='cinema_invite' AND NEW.subtype='SYNC_CINEMA_ENDED')
--   新增 (OLD.subtype = 'SYNC_CINEMA_INVITE' AND NEW.subtype = 'SYNC_CINEMA_ENDED')
-- 其余所有分支（2.1 / 2.3~2.8）逐字保留迁移 28 的语义。
CREATE OR REPLACE FUNCTION public.messages_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_is_sender   BOOLEAN := (v_uid IS NOT NULL AND OLD.user_id = v_uid);
  v_is_receiver BOOLEAN := (v_uid IS NOT NULL AND OLD.receiver_id = v_uid);
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
  --     本迁移新增：放映厅邀请卡片 → 已结束（兼容存量 subtype=NULL 的卡片）。
  IF NEW.subtype IS DISTINCT FROM OLD.subtype THEN
    IF NOT (
      v_is_server
      AND (
        -- 健康搭子邀请生命周期（迁移 28 原有）
        (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_ACCEPTED')
        OR (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_REJECTED')
        OR (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_CANCELLED')
        OR (OLD.subtype = 'SYNC_PARTNER_INVITE'   AND NEW.subtype = 'SYNC_PARTNER_EXPIRED')
        OR (OLD.subtype = 'SYNC_PARTNER_ACCEPTED' AND NEW.subtype = 'SYNC_PARTNER_UNBOUND')
        -- 放映厅邀请卡片生命周期（本迁移新增）
        -- (a) 存量卡片：subtype 为 NULL，但 type 明确是 cinema_invite
        OR (OLD.subtype IS NULL
            AND OLD.type = 'cinema_invite'
            AND NEW.subtype = 'SYNC_CINEMA_ENDED')
        -- (b) 新卡片：subtype 已是 SYNC_CINEMA_INVITE
        OR (OLD.subtype = 'SYNC_CINEMA_INVITE'
            AND NEW.subtype = 'SYNC_CINEMA_ENDED')
      )
    ) THEN
      RAISE EXCEPTION 'messages.subtype transition not allowed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2.3 普通消息不得被「升级」为系统消息
  --     注意：放映厅存量卡片（subtype=NULL, type='cinema_invite'）的
  --     NULL → SYNC_CINEMA_ENDED 已在 2.2 被显式放行，因此这里必须排除该情形，
  --     否则 2.3 会把 2.2 刚放行的合法转换再次拒绝。
  IF OLD.subtype IS NULL AND NEW.subtype IS NOT NULL THEN
    IF NOT (
      v_is_server
      AND OLD.type = 'cinema_invite'
      AND NEW.subtype = 'SYNC_CINEMA_ENDED'
    ) THEN
      RAISE EXCEPTION 'cannot promote a normal message to a system message'
        USING ERRCODE = '42501';
    END IF;
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
  IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    IF NOT (
      (v_is_sender OR v_is_receiver)
      AND OLD.deleted_by <@ NEW.deleted_by
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
      RAISE EXCEPTION 'messages.duration can only be cleared by the sender on recall'
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

COMMIT;

-- ============================================================================
-- 五、执行后自检（人工 / 隔离环境）
-- ============================================================================
-- 5.0 函数执行权限核实：
--   必须确认 PUBLIC / anon / authenticated 三者的**实际**权限，
--   不能仅凭「模拟环境通过」判定安全。
--
-- 5.0.1 查看两个函数的完整 ACL（proacl）：
--   SELECT p.proname, p.proacl
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('end_cinema_invite', 'end_cinema_invites_by_room');
--   期望：proacl 中**不出现** =X（PUBLIC）与 anon=X，只出现 authenticated=X
--
-- 5.0.2 逐角色展开（应只返回 authenticated 两行）：
--   SELECT p.proname, r.rolname AS grantee, a.privilege_type
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   CROSS JOIN LATERAL aclexplode(p.proacl) a
--   JOIN pg_roles r ON r.oid = a.grantee
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('end_cinema_invite', 'end_cinema_invites_by_room')
--   ORDER BY p.proname, grantee;
--
-- 5.0.3 直接断言 anon 无执行权（应返回 0 行）：
--   SELECT p.proname
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   CROSS JOIN LATERAL aclexplode(p.proacl) a
--   JOIN pg_roles r ON r.oid = a.grantee
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('end_cinema_invite', 'end_cinema_invites_by_room')
--     AND r.rolname IN ('anon', 'public')
--     AND a.privilege_type = 'EXECUTE';
--
-- 5.0.4 直接断言 PUBLIC 无执行权（proacl 不含 grantee=0）：
--   SELECT p.proname
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   CROSS JOIN LATERAL aclexplode(p.proacl) a
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('end_cinema_invite', 'end_cinema_invites_by_room')
--     AND a.grantee = 0
--     AND a.privilege_type = 'EXECUTE';
--   期望返回 0 行。
--
-- 5.1 确认 authenticated 仍无 subtype UPDATE 权限（应返回 0 行）：
--   SELECT column_name, privilege_type
--   FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='messages'
--     AND grantee='authenticated' AND privilege_type='UPDATE'
--     AND column_name='subtype';
--
-- 5.2 确认 service_role 拥有 subtype UPDATE 权限（应返回 1 行）：
--   SELECT column_name, privilege_type
--   FROM information_schema.column_privileges
--   WHERE table_schema='public' AND table_name='messages'
--     AND grantee='service_role' AND privilege_type='UPDATE'
--     AND column_name='subtype';
--
-- 5.3 触发器存在性：
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal;
--   期望包含 messages_guard_update_trg
-- ============================================================================
