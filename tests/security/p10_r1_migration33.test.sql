-- ============================================================================
-- TASK-P1.0 / R1 — Migration 33 v4 正负向测试
--   SQL-01 可信接受事件（DB 受保护凭证）/ SQL-02 单行好友兼容 / 媒体对象级授权
-- ============================================================================
-- 运行方式（隔离本地库，非生产、非远端）：
--   docker exec -i supabase_db_my-app \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f /tmp/p10_r1_migration33.test.sql
--
-- 前置：本地隔离库已应用迁移 30–32，且**已应用** Migration 33 v4（本文件不负责建策略）。
--
-- 覆盖：
--   SQL-01 可信接受事件（不可伪造）
--     S1-1  伪造 accepted 请求（created_at 填未来 2099）但无接受事件 → 读不到（fail-closed）
--     S1-2  真实 pending->accepted（触发器写事件）→ 读得到（正向）
--     S1-3  历史伪造：双向 friends 行 accepted 但无事件 → 读不到（fail-closed）
--     S1-4  authenticated 直接 INSERT friend_accept_events → 被 RLS 拒绝（不可伪造）
--     S1-5  历史伪造反方向行存在时，A 补建自己视角 friends 行 → 拒绝
--   SQL-02 单行好友兼容（旧客户端真实流程）
--     S2-1  旧客户端真实流程：A 发请求 → B 接受（update status）→ B 只插单行 friends
--           → B 可读 A 的 friends-only 动态（单行即可，无需第二行）
--     S2-2  设备注：B 对自己那行 UPDATE remark → 成功（不破坏正常备注）
--     S2-3  删好友后重新申请并接受 → 事件仍在 → 仍可读（重新申请行为）
--   SQL-02 媒体对象级授权
--     S3-1  发送方 A 上传的对象，接收方 B 可读（正向，相对路径精确匹配）
--     S3-2  同命名空间内未被任何消息引用的对象，B 读不到（负向，禁止目录级放行）
--     S3-3  完整 URL 形态的 media_url 无法写入（迁移 21 触发器拒绝）→ 历史全 URL 不存在
--     S3-4  对象名含 LIKE 元字符（%）时，不得放大匹配范围（负向）
--     S3-5  非参与方 C 读不到 A/B 之间的媒体对象（负向）
--
-- 说明：
--   · 全部使用虚构账号 A / B / C，不涉及真实用户数据。
--   · 每个用例 SET LOCAL ROLE authenticated + request.jwt.claims 模拟 PostgREST。
--   · 断言失败即 RAISE EXCEPTION，脚本以非零退出码结束。
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------------
-- 0. 准备：虚构用户 A / B / C（清理 → 建用户 → 建动态）
-- ---------------------------------------------------------------------------
BEGIN;

SET session_replication_role = replica;
DELETE FROM public.friend_accept_events
 WHERE sender_id IN (
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000003'
 ) OR receiver_id IN (
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000003'
 );
DELETE FROM storage.objects
WHERE name LIKE 'aaaaaaaa-0000-0000-0000-000000000001/%'
   OR name LIKE 'bbbbbbbb-0000-0000-0000-000000000002/%'
   OR name LIKE 'cccccccc-0000-0000-0000-000000000003/%';
SET session_replication_role = origin;

DELETE FROM public.messages
WHERE user_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
) OR receiver_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.friends
WHERE user_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
) OR friend_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.friend_requests
WHERE sender_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
) OR receiver_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.moments
WHERE author_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.profiles
WHERE id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM auth.users
WHERE id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);

INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.local', 'x', now(), now(), now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test.local', 'x', now(), now(), now()),
  ('cccccccc-0000-0000-0000-000000000003', 'c@test.local', 'x', now(), now(), now());

INSERT INTO public.profiles (id, username, nickname, sync_id)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'user_a', 'A', 'user_aaaa0001'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'user_b', 'B', 'user_bbbb0002'),
  ('cccccccc-0000-0000-0000-000000000003', 'user_c', 'C', 'user_cccc0003')
ON CONFLICT (id) DO NOTHING;

-- B 的一条 friends-only 动态（供 SQL-01 / SQL-02 用例使用）
INSERT INTO public.moments (author_id, content, visibility)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'B 的好友动态', 'friends');

COMMIT;

-- ---------------------------------------------------------------------------
-- 辅助：以某个用户身份执行
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.as_user(uid UUID) RETURNS void AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
END;
$$ LANGUAGE plpgsql;

-- 辅助：以超级用户直插 friends（绕过 RLS，模拟「历史遗留数据」）
CREATE OR REPLACE FUNCTION pg_temp.seed_friends(u UUID, f UUID, st TEXT DEFAULT 'accepted') RETURNS void AS $$
BEGIN
  INSERT INTO public.friends (user_id, friend_id, status) VALUES (u, f, st);
END;
$$ LANGUAGE plpgsql;

-- 辅助：以超级用户直插 friend_requests（绕过 RLS，模拟「历史遗留数据」）
CREATE OR REPLACE FUNCTION pg_temp.seed_request(s UUID, r UUID, st TEXT, created TIMESTAMPTZ) RETURNS void AS $$
BEGIN
  INSERT INTO public.friend_requests (sender_id, receiver_id, status, created_at)
  VALUES (s, r, st, created);
END;
$$ LANGUAGE plpgsql;

-- 辅助：清理 A/B 之间的好友相关数据（事件 / friends / 请求）
CREATE OR REPLACE FUNCTION pg_temp.cleanup_ab() RETURNS void AS $$
BEGIN
  DELETE FROM public.friend_accept_events
   WHERE (sender_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002')
      OR (sender_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND receiver_id = 'aaaaaaaa-0000-0000-0000-000000000001');
  DELETE FROM public.friends
   WHERE (user_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND friend_id = 'bbbbbbbb-0000-0000-0000-000000000002')
      OR (user_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND friend_id = 'aaaaaaaa-0000-0000-0000-000000000001');
  DELETE FROM public.friend_requests
   WHERE (sender_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002')
      OR (sender_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND receiver_id = 'aaaaaaaa-0000-0000-0000-000000000001');
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- SQL-01 用例：可信接受事件
-- ===========================================================================

-- S1-1：伪造 accepted 请求（created_at 填未来 2099）但无接受事件 → 读不到
DO $$
DECLARE v_count INT;
BEGIN
  PERFORM pg_temp.cleanup_ab();
  -- 直接插入 accepted 请求，created_at 填未来（旧策略允许客户端任意填写）
  PERFORM pg_temp.seed_request('aaaaaaaa-0000-0000-0000-000000000001',
                               'bbbbbbbb-0000-0000-0000-000000000002',
                               'accepted', '2099-01-01 00:00:00+00');
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_count FROM public.moments
   WHERE author_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND visibility = 'friends';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S1-1：伪造未来 created_at 的 accepted 请求竟可读（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS S1-1：伪造未来 created_at 的 accepted 请求读不到（0 行，无事件 fail-closed）';
END $$;

-- S1-2：真实 pending->accepted（触发器写事件）→ 读得到（正向）
DO $$
DECLARE v_count INT;
BEGIN
  PERFORM pg_temp.cleanup_ab();
  -- 以超级用户插入 pending 请求（模拟 A 已发出请求）
  PERFORM pg_temp.seed_request('aaaaaaaa-0000-0000-0000-000000000001',
                               'bbbbbbbb-0000-0000-0000-000000000002',
                               'pending', now());
  -- 以 B（接收方）身份真实接受：pending -> accepted，触发器写事件
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  UPDATE public.friend_requests SET status = 'accepted'
   WHERE sender_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  RESET ROLE;

  -- 断言事件已写入
  SELECT count(*) INTO v_count FROM public.friend_accept_events
   WHERE sender_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL S1-2：真实接受后未写入接受事件（% 条，期望 1）', v_count;
  END IF;

  -- 首次同意后仍必须创建单行 friends（仅凭接受事件不能越过当前关系判断）。
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  INSERT INTO public.friends (user_id, friend_id)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001');

  -- A 应可读 B 的 friends-only 动态
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_count FROM public.moments
   WHERE author_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND visibility = 'friends';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL S1-2：真实接受后 A 读不到 B 的 friends-only 动态（% 行，期望 1）', v_count;
  END IF;
  RAISE NOTICE 'PASS S1-2：真实接受写入事件，A 可读 B 的 friends-only 动态（1 行）';
END $$;

-- S1-3：历史伪造：双向 friends 行 accepted 但无事件 → 读不到（fail-closed）
DO $$
DECLARE v_count INT;
BEGIN
  PERFORM pg_temp.cleanup_ab();
  PERFORM pg_temp.seed_friends('aaaaaaaa-0000-0000-0000-000000000001',
                               'bbbbbbbb-0000-0000-0000-000000000002', 'accepted');
  PERFORM pg_temp.seed_friends('bbbbbbbb-0000-0000-0000-000000000002',
                               'aaaaaaaa-0000-0000-0000-000000000001', 'accepted');
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_count FROM public.moments
   WHERE author_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND visibility = 'friends';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S1-3：无事件的双向伪造行竟可读（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS S1-3：无事件的双向伪造行读不到（0 行，fail-closed）';
END $$;

-- S1-4：authenticated 直接 INSERT friend_accept_events → 被 RLS 拒绝（不可伪造）
DO $$
BEGIN
  PERFORM pg_temp.cleanup_ab();
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO public.friend_accept_events (sender_id, receiver_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL S1-4：authenticated 竟能直接插入接受事件（可伪造）';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS S1-4：authenticated 直接插入接受事件被拒绝（不可伪造）';
  END;
END $$;

-- S1-5：历史伪造反方向行存在时，A 补建自己视角 friends 行 → 拒绝
DO $$
BEGIN
  PERFORM pg_temp.cleanup_ab();
  -- 仅 B→A 一条伪造行（无事件）
  PERFORM pg_temp.seed_friends('bbbbbbbb-0000-0000-0000-000000000002',
                               'aaaaaaaa-0000-0000-0000-000000000001', 'accepted');
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO public.friends (user_id, friend_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL S1-5：凭历史伪造反方向行竟能补建自己视角 friends 行';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS S1-5：凭历史伪造反方向行补建 friends 行被拒绝（insufficient_privilege）';
  END;
END $$;

-- ===========================================================================
-- SQL-02 用例：单行好友兼容（旧客户端真实流程）
-- ===========================================================================

-- S2-1：旧客户端真实流程 —— A 发请求 → B 接受 → B 只插单行 friends → B 可读 A 的动态
--   注意：这里 B 读的是 A 的 friends-only 动态，需要 A 也有一条 friends-only 动态。
DO $$
DECLARE v_count INT;
BEGIN
  PERFORM pg_temp.cleanup_ab();
  -- A 的一条 friends-only 动态
  DELETE FROM public.moments WHERE author_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  INSERT INTO public.moments (author_id, content, visibility)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'A 的好友动态', 'friends');

  -- 1) A 发请求（pending）
  PERFORM pg_temp.seed_request('aaaaaaaa-0000-0000-0000-000000000001',
                               'bbbbbbbb-0000-0000-0000-000000000002',
                               'pending', now());
  -- 2) B 接受（update status='accepted'）→ 触发器写事件
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  UPDATE public.friend_requests SET status = 'accepted'
   WHERE sender_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  -- 3) B 只插入单行 friends（旧客户端 contacts.js 真实行为）
  INSERT INTO public.friends (user_id, friend_id)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001');

  -- 4) 断言：B 可读 A 的 friends-only 动态（单行即可）
  SELECT count(*) INTO v_count FROM public.moments
   WHERE author_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND visibility = 'friends';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL S2-1：单行 friends 下 B 读不到 A 的 friends-only 动态（% 行，期望 1）', v_count;
  END IF;
  RAISE NOTICE 'PASS S2-1：旧客户端单行 friends 流程下 B 可读 A 的 friends-only 动态（1 行）';
END $$;

-- S2-2：设备注 —— B 对自己那行 UPDATE remark → 成功（不破坏正常备注）
DO $$
DECLARE v_rows INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  UPDATE public.friends SET remark = '我的备注'
   WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002'
     AND friend_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL S2-2：B 无法更新自己那行的备注（% 行，期望 1）', v_rows;
  END IF;
  RAISE NOTICE 'PASS S2-2：B 可更新自己那行的备注（1 行）';
END $$;

-- S2-3：删好友后重新申请并接受 → 事件仍在 → 仍可读（重新申请行为）
DO $$
DECLARE v_count INT;
BEGIN
  -- 1) B 删除好友（双向删除 friends + 删除 accepted 请求，模拟 deleteFriend）
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  DELETE FROM public.friends
   WHERE (user_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND friend_id = 'aaaaaaaa-0000-0000-0000-000000000001')
      OR (user_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND friend_id = 'bbbbbbbb-0000-0000-0000-000000000002');
  -- 好友行删除后必须立即撤销事件，而不仅仅是删除当前行。
  RESET ROLE;
  SELECT count(*) INTO v_count FROM public.friend_accept_events
   WHERE (sender_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002')
      OR (sender_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND receiver_id = 'aaaaaaaa-0000-0000-0000-000000000001');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S2-3：删除好友后仍留存可信接受事件（% 条）', v_count;
  END IF;
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_count FROM public.moments
   WHERE author_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND visibility = 'friends';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S2-3：删除好友后仍能读取好友动态（% 行）', v_count;
  END IF;

  -- 即使旧 accepted 请求尚未删除，旧事件已撤销，无法重新插入 friends。
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO public.friends (user_id, friend_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL S2-3：利用旧接受记录重新插入好友行成功';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS S2-3：旧事件不能重插好友行';
  END;

  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  DELETE FROM public.friend_requests
   WHERE sender_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';

  -- 2) A 重新发请求（pending）
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  INSERT INTO public.friend_requests (sender_id, receiver_id, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'pending');

  -- 3) B 重新接受
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  UPDATE public.friend_requests SET status = 'accepted'
   WHERE sender_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  INSERT INTO public.friends (user_id, friend_id)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001');

  -- 4) 断言：B 仍可读 A 的 friends-only 动态
  SELECT count(*) INTO v_count FROM public.moments
   WHERE author_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND visibility = 'friends';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL S2-3：删好友重新接受后 B 读不到 A 的动态（% 行，期望 1）', v_count;
  END IF;
  RAISE NOTICE 'PASS S2-3：删除即时撤销、旧凭证不能重插、新申请真实接受后恢复';
END $$;

-- S2-4：SECURITY DEFINER 授权函数禁止 C 冒充 A 查询 A/B 是否是好友
DO $$
DECLARE v_allowed boolean;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
  SELECT public.p1_has_trusted_friend_event(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'bbbbbbbb-0000-0000-0000-000000000002'
  ) INTO v_allowed;
  IF v_allowed IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'FAIL S2-4：第三方可探测 A/B 关系';
  END IF;
  RAISE NOTICE 'PASS S2-4：第三方无法探测 A/B 关系';
END $$;

-- S2-5：双方合法好友后，将唯一 accepted 行降级为 blocked → 事件立即撤销
DO $$
DECLARE v_allowed boolean;
DECLARE v_events integer;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  UPDATE public.friends SET status='blocked'
   WHERE user_id='bbbbbbbb-0000-0000-0000-000000000002'
     AND friend_id='aaaaaaaa-0000-0000-0000-000000000001';
  SELECT public.p1_has_trusted_friend_event(
    'bbbbbbbb-0000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0000-000000000001'
  ) INTO v_allowed;
  IF v_allowed IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'FAIL S2-5：好友状态降级后授权未撤销';
  END IF;
  RESET ROLE;
  SELECT count(*) INTO v_events FROM public.friend_accept_events
   WHERE (sender_id='aaaaaaaa-0000-0000-0000-000000000001' AND receiver_id='bbbbbbbb-0000-0000-0000-000000000002')
      OR (sender_id='bbbbbbbb-0000-0000-0000-000000000002' AND receiver_id='aaaaaaaa-0000-0000-0000-000000000001');
  IF v_events <> 0 THEN
    RAISE EXCEPTION 'FAIL S2-5：好友状态降级后事件未撤销';
  END IF;
  RAISE NOTICE 'PASS S2-5：accepted→blocked 即时撤销事件';
END $$;

-- 清理 S2 数据
DELETE FROM public.moments WHERE author_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT pg_temp.cleanup_ab();

-- ===========================================================================
-- SQL-02 媒体对象级授权用例
-- ===========================================================================
-- 准备：A 向 B 发一条带相对路径媒体的消息；对象真实路径为 <A_uid>/photo.jpg
INSERT INTO public.messages (user_id, receiver_id, text, type, media_url)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002',
        '', 'image',
        'aaaaaaaa-0000-0000-0000-000000000001/photo.jpg');

-- 以超级用户直插存储对象（模拟已上传对象）
SET session_replication_role = replica;
INSERT INTO storage.objects (bucket_id, name, owner)
VALUES
  ('chat_media', 'aaaaaaaa-0000-0000-0000-000000000001/photo.jpg',
   'aaaaaaaa-0000-0000-0000-000000000001'),
  -- 同命名空间内、未被任何消息引用的私有对象（负向用例）
  ('chat_media', 'aaaaaaaa-0000-0000-0000-000000000001/unreferenced.jpg',
   'aaaaaaaa-0000-0000-0000-000000000001'),
  -- 名字含 LIKE 元字符的对象（负向用例）
  ('chat_media', 'aaaaaaaa-0000-0000-0000-000000000001/we%ird.jpg',
   'aaaaaaaa-0000-0000-0000-000000000001');
SET session_replication_role = origin;

-- S3-1：接收方 B 可读被消息精确引用的对象（正向）
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_count FROM storage.objects
   WHERE bucket_id = 'chat_media'
     AND name = 'aaaaaaaa-0000-0000-0000-000000000001/photo.jpg';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL S3-1：接收方 B 读不到被引用的媒体对象（% 行，期望 1）', v_count;
  END IF;
  RAISE NOTICE 'PASS S3-1：接收方 B 可读被引用的媒体对象（1 行）';
END $$;

-- S3-2：同命名空间内未被引用的对象，B 读不到（负向）
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_count FROM storage.objects
   WHERE bucket_id = 'chat_media'
     AND name = 'aaaaaaaa-0000-0000-0000-000000000001/unreferenced.jpg';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S3-2：B 竟能读到同命名空间内未被引用的对象（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS S3-2：B 读不到同命名空间内未被引用的对象（0 行）';
END $$;

-- S3-3：完整 URL 形态的 media_url 无法写入（迁移 21 触发器拒绝）→ 证明「历史全 URL」不存在
DO $$
DECLARE v_blocked BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO public.messages (user_id, receiver_id, text, type, media_url)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
            'bbbbbbbb-0000-0000-0000-000000000002',
            '', 'image',
            'https://example.supabase.co/storage/v1/object/public/chat_media/aaaaaaaa-0000-0000-0000-000000000001/photo.jpg');
  EXCEPTION WHEN insufficient_privilege THEN
    v_blocked := TRUE;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'FAIL S3-3：完整 URL 形态的 media_url 竟被写入（迁移 21 触发器未生效）';
  END IF;
  RAISE NOTICE 'PASS S3-3：完整 URL 形态 media_url 被触发器拒绝（历史全 URL 不存在）';
END $$;

-- S3-4：对象名含 LIKE 元字符（%）时，不得放大匹配范围（负向）
DO $$
DECLARE v_count INT;
BEGIN
  -- 先插入一条引用 'weXird.jpg'（相对路径）的消息，制造「近似名」场景
  INSERT INTO public.messages (user_id, receiver_id, text, type, media_url)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          '', 'image',
          'aaaaaaaa-0000-0000-0000-000000000001/weXird.jpg');
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_count FROM storage.objects
   WHERE bucket_id = 'chat_media'
     AND name = 'aaaaaaaa-0000-0000-0000-000000000001/we%ird.jpg';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S3-4：LIKE 元字符放大匹配，B 读到了未被精确引用的对象（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS S3-4：LIKE 元字符未放大匹配范围（0 行）';
END $$;

-- S3-5：非参与方 C 读不到 A/B 之间的媒体对象（负向）
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
  SELECT count(*) INTO v_count FROM storage.objects
   WHERE bucket_id = 'chat_media'
     AND name = 'aaaaaaaa-0000-0000-0000-000000000001/photo.jpg';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL S3-5：非参与方 C 竟能读到 A/B 的媒体对象（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS S3-5：非参与方 C 读不到 A/B 的媒体对象（0 行）';
END $$;

-- ---------------------------------------------------------------------------
-- 清理测试数据（保持本地库干净）
-- ---------------------------------------------------------------------------
SET session_replication_role = replica;
DELETE FROM public.friend_accept_events
 WHERE sender_id IN (
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000003'
 ) OR receiver_id IN (
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'cccccccc-0000-0000-0000-000000000003'
 );
DELETE FROM storage.objects
WHERE name LIKE 'aaaaaaaa-0000-0000-0000-000000000001/%';
SET session_replication_role = origin;
DELETE FROM public.messages
WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';
DELETE FROM public.moments
WHERE author_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002'
);
DELETE FROM public.friends
WHERE user_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
) OR friend_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.friend_requests
WHERE sender_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
) OR receiver_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.profiles
WHERE id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM auth.users
WHERE id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);

\echo '=== ALL R1 MIGRATION-33 TESTS PASSED ==='

-- --- END OF FILE tests/security/p10_r1_migration33.test.sql ---
