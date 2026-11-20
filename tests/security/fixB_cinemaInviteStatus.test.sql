-- --- START OF FILE tests/security/fixB_cinemaInviteStatus.test.sql ---
-- ============================================================================
-- TASK-P0.4 / FIX-B —— 放映厅邀请卡片状态转换：真实 PostgreSQL 隔离环境测试
-- ============================================================================
-- 目的（对应 L4 对 FIX-B 的强制要求）：
--   1. 存量卡片（subtype = NULL, type = 'cinema_invite'）可安全转换到
--      'SYNC_CINEMA_ENDED'；
--   2. 新卡片（subtype = 'SYNC_CINEMA_INVITE'）可安全转换到 'SYNC_CINEMA_ENDED'；
--   3. 只有「合法发送方 / 服务端」可执行该转换；
--   4. 接收方、无关账号不得修改；
--   5. 不得修改其它消息类型或受保护字段；
--   6. 不得放宽 messages 整表 RLS / 整表 UPDATE。
--
-- ⚠️ 本测试必须在**真实 PostgreSQL 隔离环境**执行（非 JS stub）：
--      · 推荐：本地 `supabase start` 后的 postgres 容器，或一次性 docker postgres；
--      · 执行前先应用迁移 01~28 + 本草案 29_DRAFT_...sql；
--      · 本文件**不**包含任何生产连接串 / 密钥。
--
-- 运行方式（示例，隔离库）：
--   psql "$ISOLATED_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f tests/security/fixB_cinemaInviteStatus.test.sql
--
-- 判定：全部断言通过 → 输出 'FIX-B ALL PASS'；任一断言失败 → 抛异常、非 0 退出。
--
-- 说明：
--   · 触发器 messages_guard_update() 用 auth.uid() 判定发送方/接收方，
--     因此测试通过 `SET LOCAL request.jwt.claims` 模拟不同登录用户。
--   · v_is_server 判定 current_user ∈ ('postgres','supabase_admin','service_role')，
--     因此「服务端」用例通过 `SET LOCAL ROLE service_role` 模拟。
--   · 所有用例在事务内执行并 ROLLBACK，不污染隔离库。
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. 前置：确认草案已应用（subtype 列权限 + 触发器存在）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema='public' AND table_name='messages'
      AND grantee='service_role' AND privilege_type='UPDATE'
      AND column_name='subtype'
  ) THEN
    RAISE EXCEPTION 'FIX-B 前置失败：service_role 缺少 messages.subtype UPDATE 权限（草案未应用？）';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema='public' AND table_name='messages'
      AND grantee='authenticated' AND privilege_type='UPDATE'
      AND column_name='subtype'
  ) THEN
    RAISE EXCEPTION 'FIX-B 红线失败：authenticated 不应拥有 messages.subtype UPDATE 权限';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.messages'::regclass
      AND tgname='messages_guard_update_trg' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'FIX-B 前置失败：messages_guard_update_trg 触发器不存在';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. 固定测试 UUID（避免与真实数据冲突；全部在事务内 ROLLBACK）
-- ---------------------------------------------------------------------------
-- sender   : 邀请卡片发送方
-- receiver : 邀请卡片接收方
-- stranger : 无关账号
-- 使用固定前缀 00000000-0000-4000-8000-0000000000xx，确保可识别、可清理。
--
-- 用例 1~2 走「服务端直接 UPDATE」（验证触发器 §2.2 放行）；
-- 用例 11~14 走「客户端 RPC end_cinema_invite」（验证真实客户端路径）；
-- 用例 15~18 走「批量 RPC end_cinema_invites_by_room」（验证多卡片场景）。
--
-- ⚠️ 真实 Supabase Schema 中 messages.user_id / receiver_id 均有外键指向
--    profiles(id)，而 profiles.id 又外键指向 auth.users(id)。因此必须先播种
--    auth.users，再播种 profiles，否则 INSERT messages 会因外键失败。
--    这里用 ON CONFLICT DO NOTHING 幂等播种全部测试用户（含 stranger）。
-- ---------------------------------------------------------------------------
-- ⚠️ 真实 Supabase 兼容性说明（P0.4 收尾修正）：
--   真实 Supabase 的 auth.users 上有 on_auth_user_created 触发器，插入 auth.users
--   时会自动创建 public.profiles 行，且其 sync_id = 'user_' || left(uuid::text, 8)。
--   本测试所有 UUID 前 8 位均为 '00000000'，批量插入时触发器会因 sync_id 唯一约束
--   冲突而失败。auth.users 属主为 supabase_auth_admin，postgres 无法 DISABLE TRIGGER，
--   因此改用 session_replication_role = replica 临时绕过用户触发器（超级用户可设），
--   手工播种 profiles（sync_id 唯一），测试结束后恢复为 origin。
--   这是测试夹具（fixture）层面的处理，不改变被测逻辑。
SET session_replication_role = replica;

INSERT INTO auth.users (id, is_sso_user, is_anonymous)
SELECT x, FALSE, FALSE
FROM unnest(ARRAY[
  '00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000b2',
  '00000000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-0000000000b3',
  '00000000-0000-4000-8000-0000000000a4','00000000-0000-4000-8000-0000000000b4',
  '00000000-0000-4000-8000-0000000000d4',
  '00000000-0000-4000-8000-0000000000a5','00000000-0000-4000-8000-0000000000b5',
  '00000000-0000-4000-8000-0000000000a6','00000000-0000-4000-8000-0000000000b6',
  '00000000-0000-4000-8000-0000000000e6',
  '00000000-0000-4000-8000-0000000000a7','00000000-0000-4000-8000-0000000000b7',
  '00000000-0000-4000-8000-0000000000a8','00000000-0000-4000-8000-0000000000b8',
  '00000000-0000-4000-8000-0000000000a9','00000000-0000-4000-8000-0000000000b9',
  '00000000-0000-4000-8000-0000000000aa','00000000-0000-4000-8000-0000000000ba',
  '00000000-0000-4000-8000-0000000000ab','00000000-0000-4000-8000-0000000000bb',
  '00000000-0000-4000-8000-0000000000ac','00000000-0000-4000-8000-0000000000bc',
  '00000000-0000-4000-8000-0000000000ad','00000000-0000-4000-8000-0000000000bd',
  '00000000-0000-4000-8000-0000000000ae','00000000-0000-4000-8000-0000000000be',
  '00000000-0000-4000-8000-0000000000af','00000000-0000-4000-8000-0000000000bf'
]::uuid[]) AS t(x)
ON CONFLICT (id) DO NOTHING;

-- 先补建缺失的 profile（触发器未建时），sync_id 用唯一后缀
INSERT INTO public.profiles (id, username, sync_id)
SELECT x, 'fixb_' || right(x::text, 2), 'fixb_' || right(x::text, 2)
FROM unnest(ARRAY[
  '00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000b2',
  '00000000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-0000000000b3',
  '00000000-0000-4000-8000-0000000000a4','00000000-0000-4000-8000-0000000000b4',
  '00000000-0000-4000-8000-0000000000d4',
  '00000000-0000-4000-8000-0000000000a5','00000000-0000-4000-8000-0000000000b5',
  '00000000-0000-4000-8000-0000000000a6','00000000-0000-4000-8000-0000000000b6',
  '00000000-0000-4000-8000-0000000000e6',
  '00000000-0000-4000-8000-0000000000a7','00000000-0000-4000-8000-0000000000b7',
  '00000000-0000-4000-8000-0000000000a8','00000000-0000-4000-8000-0000000000b8',
  '00000000-0000-4000-8000-0000000000a9','00000000-0000-4000-8000-0000000000b9',
  '00000000-0000-4000-8000-0000000000aa','00000000-0000-4000-8000-0000000000ba',
  '00000000-0000-4000-8000-0000000000ab','00000000-0000-4000-8000-0000000000bb',
  '00000000-0000-4000-8000-0000000000ac','00000000-0000-4000-8000-0000000000bc',
  '00000000-0000-4000-8000-0000000000ad','00000000-0000-4000-8000-0000000000bd',
  '00000000-0000-4000-8000-0000000000ae','00000000-0000-4000-8000-0000000000be',
  '00000000-0000-4000-8000-0000000000af','00000000-0000-4000-8000-0000000000bf'
]::uuid[]) AS t(x)
ON CONFLICT (id) DO NOTHING;

-- 恢复会话复制角色（测试夹具收尾）
SET session_replication_role = origin;

-- ===========================================================================
-- 用例 1：存量卡片（subtype = NULL）→ SYNC_CINEMA_ENDED，服务端可执行
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a1';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b1';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c1';
  v_new_sub  TEXT;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-legacy', NULL);

  -- 模拟服务端（Edge Function / SECURITY DEFINER RPC）
  SET LOCAL ROLE service_role;
  UPDATE public.messages SET subtype = 'SYNC_CINEMA_ENDED' WHERE id = v_msg_id;
  RESET ROLE;

  SELECT subtype INTO v_new_sub FROM public.messages WHERE id = v_msg_id;
  IF v_new_sub IS DISTINCT FROM 'SYNC_CINEMA_ENDED' THEN
    RAISE EXCEPTION '用例1失败：存量卡片 NULL→SYNC_CINEMA_ENDED 未生效，实际=%', v_new_sub;
  END IF;
  RAISE NOTICE '用例1 PASS：存量卡片（subtype=NULL）→ SYNC_CINEMA_ENDED';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 2：新卡片（subtype = SYNC_CINEMA_INVITE）→ SYNC_CINEMA_ENDED，服务端可执行
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a2';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b2';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c2';
  v_new_sub  TEXT;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-new', 'SYNC_CINEMA_INVITE');

  SET LOCAL ROLE service_role;
  UPDATE public.messages SET subtype = 'SYNC_CINEMA_ENDED' WHERE id = v_msg_id;
  RESET ROLE;

  SELECT subtype INTO v_new_sub FROM public.messages WHERE id = v_msg_id;
  IF v_new_sub IS DISTINCT FROM 'SYNC_CINEMA_ENDED' THEN
    RAISE EXCEPTION '用例2失败：新卡片 SYNC_CINEMA_INVITE→SYNC_CINEMA_ENDED 未生效，实际=%', v_new_sub;
  END IF;
  RAISE NOTICE '用例2 PASS：新卡片（SYNC_CINEMA_INVITE）→ SYNC_CINEMA_ENDED';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 3：接收方（authenticated）不得修改 subtype —— 必须被拒
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a3';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b3';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c3';
  v_blocked  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-rx', NULL);

  -- 模拟接收方登录
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_receiver, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.messages SET subtype = 'SYNC_CINEMA_ENDED' WHERE id = v_msg_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := TRUE;
  END;
  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION '用例3失败：接收方竟然成功修改了 subtype（应被列权限/触发器拒绝）';
  END IF;
  RAISE NOTICE '用例3 PASS：接收方修改 subtype 被拒';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 4：无关账号（authenticated）不得修改 subtype —— 必须被拒
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a4';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b4';
  v_stranger UUID := '00000000-0000-4000-8000-0000000000d4';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c4';
  v_blocked  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-stranger', NULL);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_stranger, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.messages SET subtype = 'SYNC_CINEMA_ENDED' WHERE id = v_msg_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := TRUE;
  END;
  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION '用例4失败：无关账号竟然成功修改了 subtype';
  END IF;
  RAISE NOTICE '用例4 PASS：无关账号修改 subtype 被拒';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 5：不得把「普通文本消息」升级为系统消息（迁移 28 §2.3 语义保留）
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a5';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b5';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c5';
  v_blocked  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'text', 'hello', NULL);

  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE public.messages SET subtype = 'SYNC_CINEMA_ENDED' WHERE id = v_msg_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := TRUE;
  END;
  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION '用例5失败：普通文本消息被错误升级为系统消息';
  END IF;
  RAISE NOTICE '用例5 PASS：普通文本消息不得升级为系统消息';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 6：不得借 subtype 转换顺带篡改受保护字段（user_id / receiver_id / text）
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a6';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b6';
  v_other    UUID := '00000000-0000-4000-8000-0000000000e6';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c6';
  v_blocked  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-protected', NULL);

  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE public.messages
       SET subtype = 'SYNC_CINEMA_ENDED', receiver_id = v_other
     WHERE id = v_msg_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := TRUE;
  END;
  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION '用例6失败：subtype 转换顺带篡改了 receiver_id（应被 §2.1 拒绝）';
  END IF;
  RAISE NOTICE '用例6 PASS：subtype 转换不得篡改受保护字段';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 7：不得把放映厅卡片转成其它非法 subtype（如 SYNC_PARTNER_ACCEPTED）
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a7';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b7';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c7';
  v_blocked  BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-illegal', NULL);

  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE public.messages SET subtype = 'SYNC_PARTNER_ACCEPTED' WHERE id = v_msg_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := TRUE;
  END;
  RESET ROLE;

  IF NOT v_blocked THEN
    RAISE EXCEPTION '用例7失败：放映厅卡片被非法转换为 SYNC_PARTNER_ACCEPTED';
  END IF;
  RAISE NOTICE '用例7 PASS：放映厅卡片不得转换为其它非法 subtype';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 8：整表 UPDATE 权限未被放宽（authenticated 仍无整表 UPDATE）
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema='public' AND table_name='messages'
      AND grantee='authenticated' AND privilege_type='UPDATE'
  ) THEN
    RAISE EXCEPTION '用例8失败：authenticated 拥有 messages 整表 UPDATE 权限（红线被破坏）';
  END IF;
  RAISE NOTICE '用例8 PASS：authenticated 无 messages 整表 UPDATE 权限';
END $$;

-- ===========================================================================
-- 用例 9：RLS 仍启用（未因本迁移被关闭）
-- ===========================================================================
DO $$
DECLARE
  v_rls BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class WHERE oid = 'public.messages'::regclass;
  IF v_rls IS NOT TRUE THEN
    RAISE EXCEPTION '用例9失败：messages 表 RLS 未启用';
  END IF;
  RAISE NOTICE '用例9 PASS：messages 表 RLS 仍启用';
END $$;

-- ===========================================================================
-- 用例 10：Realtime publication 未被本迁移改动（messages 仍在 publication 中）
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE schemaname='public' AND tablename='messages'
  ) THEN
    RAISE EXCEPTION '用例10失败：messages 不在 Realtime publication 中';
  END IF;
  RAISE NOTICE '用例10 PASS：messages 仍在 Realtime publication 中';
END $$;

-- ===========================================================================
-- 用例 11：RPC end_cinema_invite —— 发送方调用，存量卡片（NULL）→ ENDED
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a8';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b8';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c8';
  v_rows     INTEGER;
  v_new_sub  TEXT;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-rpc-legacy', NULL);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sender, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invite(v_msg_id) INTO v_rows;
  RESET ROLE;

  SELECT subtype INTO v_new_sub FROM public.messages WHERE id = v_msg_id;
  IF v_rows <> 1 OR v_new_sub IS DISTINCT FROM 'SYNC_CINEMA_ENDED' THEN
    RAISE EXCEPTION '用例11失败：RPC 存量卡片转换异常 rows=% sub=%', v_rows, v_new_sub;
  END IF;
  RAISE NOTICE '用例11 PASS：RPC 发送方结束存量卡片（rows=1）';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 12：RPC end_cinema_invite —— 发送方调用，新卡片（INVITE）→ ENDED
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000a9';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000b9';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000c9';
  v_rows     INTEGER;
  v_new_sub  TEXT;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-rpc-new', 'SYNC_CINEMA_INVITE');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sender, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invite(v_msg_id) INTO v_rows;
  RESET ROLE;

  SELECT subtype INTO v_new_sub FROM public.messages WHERE id = v_msg_id;
  IF v_rows <> 1 OR v_new_sub IS DISTINCT FROM 'SYNC_CINEMA_ENDED' THEN
    RAISE EXCEPTION '用例12失败：RPC 新卡片转换异常 rows=% sub=%', v_rows, v_new_sub;
  END IF;
  RAISE NOTICE '用例12 PASS：RPC 发送方结束新卡片（rows=1）';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 13：RPC end_cinema_invite —— 接收方调用必须无效（返回 0，且数据不变）
--
-- L4 第五批修正 2：RPC 查询同时限定 id 与 user_id = auth.uid()，
-- 未命中统一 RETURN 0（不再抛异常），避免通过异常/返回值探测消息存在性。
-- 因此本用例断言：返回 0 + subtype 保持原值。
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000aa';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000ba';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000ca';
  v_rows     INTEGER;
  v_new_sub  TEXT;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-rpc-rx', NULL);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_receiver, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invite(v_msg_id) INTO v_rows;
  RESET ROLE;

  SELECT subtype INTO v_new_sub FROM public.messages WHERE id = v_msg_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '用例13失败：接收方调用 RPC 应返回 0，实际=%', v_rows;
  END IF;
  IF v_new_sub IS NOT NULL THEN
    RAISE EXCEPTION '用例13失败：接收方调用后 subtype 被改写为 %', v_new_sub;
  END IF;
  RAISE NOTICE '用例13 PASS：接收方调用 RPC 返回 0 且数据未变';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 14：RPC end_cinema_invite —— 幂等（已 ENDED 再调用返回 0，不报错）
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000ab';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000bb';
  v_msg_id   UUID := '00000000-0000-4000-8000-0000000000cb';
  v_rows     INTEGER;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_msg_id, v_sender, v_receiver, 'cinema_invite', 'room-rpc-idem', 'SYNC_CINEMA_ENDED');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sender, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invite(v_msg_id) INTO v_rows;
  RESET ROLE;

  IF v_rows <> 0 THEN
    RAISE EXCEPTION '用例14失败：幂等调用应返回 0，实际=%', v_rows;
  END IF;
  RAISE NOTICE '用例14 PASS：RPC 幂等（已 ENDED 返回 0）';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 15：批量 RPC end_cinema_invites_by_room —— 发送方一次结束同 roomId 多张卡片
--
-- L4 第六批第 2 项：同一 roomId 可能对应多张邀请卡片（每次「邀请」插入新消息，
-- text 始终是同一 roomId）。批量 RPC 必须结束该 roomId 下**全部**合法卡片。
-- 本用例插入 3 张同 roomId 卡片（2 张 NULL + 1 张 INVITE），断言一次调用 rows=3。
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000ac';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000bc';
  v_m1 UUID := '00000000-0000-4000-8000-0000000000c1';
  v_m2 UUID := '00000000-0000-4000-8000-0000000000c2';
  v_m3 UUID := '00000000-0000-4000-8000-0000000000c3';
  v_rows     INTEGER;
  v_ended    INTEGER;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype) VALUES
    (v_m1, v_sender, v_receiver, 'cinema_invite', 'room-batch', NULL),
    (v_m2, v_sender, v_receiver, 'cinema_invite', 'room-batch', NULL),
    (v_m3, v_sender, v_receiver, 'cinema_invite', 'room-batch', 'SYNC_CINEMA_INVITE');

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sender, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invites_by_room('room-batch') INTO v_rows;
  RESET ROLE;

  SELECT count(*) INTO v_ended FROM public.messages
   WHERE id IN (v_m1, v_m2, v_m3) AND subtype = 'SYNC_CINEMA_ENDED';
  IF v_rows <> 3 OR v_ended <> 3 THEN
    RAISE EXCEPTION '用例15失败：批量结束异常 rows=% ended=%（期望 3/3）', v_rows, v_ended;
  END IF;
  RAISE NOTICE '用例15 PASS：批量 RPC 一次结束同 roomId 全部 3 张卡片';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 16：批量 RPC —— 接收方调用影响 0 行（无越权）
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000ad';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000bd';
  v_m1 UUID := '00000000-0000-4000-8000-0000000000c4';
  v_rows     INTEGER;
  v_ended    INTEGER;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_m1, v_sender, v_receiver, 'cinema_invite', 'room-batch-rx', NULL);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_receiver, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invites_by_room('room-batch-rx') INTO v_rows;
  RESET ROLE;

  SELECT count(*) INTO v_ended FROM public.messages
   WHERE id = v_m1 AND subtype = 'SYNC_CINEMA_ENDED';
  IF v_rows <> 0 OR v_ended <> 0 THEN
    RAISE EXCEPTION '用例16失败：接收方批量调用应影响 0 行，实际 rows=% ended=%', v_rows, v_ended;
  END IF;
  RAISE NOTICE '用例16 PASS：接收方调用批量 RPC 影响 0 行';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 17：批量 RPC —— 只影响指定 roomId，不误伤其它放映厅的卡片
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000ae';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000be';
  v_mine UUID := '00000000-0000-4000-8000-0000000000c5';
  v_other UUID := '00000000-0000-4000-8000-0000000000c6';
  v_rows     INTEGER;
  v_other_sub TEXT;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype) VALUES
    (v_mine,  v_sender, v_receiver, 'cinema_invite', 'room-target', NULL),
    (v_other, v_sender, v_receiver, 'cinema_invite', 'room-untouched', NULL);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sender, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invites_by_room('room-target') INTO v_rows;
  RESET ROLE;

  SELECT subtype INTO v_other_sub FROM public.messages WHERE id = v_other;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '用例17失败：应只结束 1 张，实际 rows=%', v_rows;
  END IF;
  IF v_other_sub IS NOT NULL THEN
    RAISE EXCEPTION '用例17失败：误伤了其它 roomId 的卡片（subtype=%）', v_other_sub;
  END IF;
  RAISE NOTICE '用例17 PASS：批量 RPC 只影响指定 roomId';
END $$;
ROLLBACK;

-- ===========================================================================
-- 用例 18：批量 RPC —— 幂等（重复调用返回 0）+ 空 roomId 返回 0
-- ===========================================================================
BEGIN;
DO $$
DECLARE
  v_sender   UUID := '00000000-0000-4000-8000-0000000000af';
  v_receiver UUID := '00000000-0000-4000-8000-0000000000bf';
  v_m1 UUID := '00000000-0000-4000-8000-0000000000c7';
  v_first  INTEGER;
  v_second INTEGER;
  v_empty  INTEGER;
BEGIN
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_m1, v_sender, v_receiver, 'cinema_invite', 'room-batch-idem', NULL);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_sender, 'role', 'authenticated')::text, TRUE);
  SET LOCAL ROLE authenticated;
  SELECT public.end_cinema_invites_by_room('room-batch-idem') INTO v_first;
  SELECT public.end_cinema_invites_by_room('room-batch-idem') INTO v_second;
  SELECT public.end_cinema_invites_by_room('') INTO v_empty;
  RESET ROLE;

  IF v_first <> 1 OR v_second <> 0 OR v_empty <> 0 THEN
    RAISE EXCEPTION '用例18失败：幂等/空值异常 first=% second=% empty=%', v_first, v_second, v_empty;
  END IF;
  RAISE NOTICE '用例18 PASS：批量 RPC 幂等（重复=0）且空 roomId=0';
END $$;
ROLLBACK;

\echo 'FIX-B ALL PASS'
-- --- END OF FILE tests/security/fixB_cinemaInviteStatus.test.sql ---
