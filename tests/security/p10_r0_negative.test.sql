-- --- START OF FILE tests/security/p10_r0_negative.test.sql ---
-- ============================================================================
-- TASK-P1.0 / R0 安全修复 — 负面测试矩阵（N1–N17 的 DB 侧用例）
-- ============================================================================
-- 运行方式（隔离本地库，非生产、非远端）：
--   docker exec -i supabase_db_my-app \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f /tmp/p10_r0_negative.test.sql
--
-- 覆盖：
--   N1  friends 直插（无 accepted 请求）→ 拒绝（S1-1）
--   N2  直插 friends 后读 B 的 friends-only moments → 0 行（S1-1）
--   N3  A 向 chat_media/B/... 上传 → 拒绝（S2-a）
--   N4  A 向 chat_media/A/... 上传 → 成功（S2-a 正向）
--   N5  unbind_partner(B)（存在 accepted 关系）→ 成功，subtype=SYNC_PARTNER_UNBOUND（S3）
--   N6  unbind_partner(B)（无关系）→ 静默返回，不清指针（S3 既有语义）
--   N7  A 直接 UPDATE messages.text（非撤回）→ 拒绝（S3 回归，触发器未放宽）
--   N10 C3/S4：profiles.bound_partner_id 列读取（未实施 → 登记残留，不判失败）
--   N11 friend_requests 直插 status='accepted' → 拒绝（S1-3）
--   N12 receiver UPDATE status='whatever' → 拒绝（S1-4）
--   N13 UPDATE friends.friend_id=C（过户）→ 拒绝（S1-5 不可变触发器）
--   N14 直插 messages.media_url='B_uid/secret.jpg' → 拒绝（S2-b 写侧触发器）
--
-- 说明：
--   · 全部使用虚构账号 A / B / C，不涉及真实用户数据。
--   · 每个用例 SET LOCAL ROLE authenticated + request.jwt.claims 模拟 PostgREST。
--   · 断言失败即 RAISE EXCEPTION，脚本以非零退出码结束。
--   · N8/N9/N15/N16/N17 为客户端生命周期用例，由 tests/security/*.test.mjs 覆盖。
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------------
-- 0. 准备：虚构用户 A / B / C
-- ---------------------------------------------------------------------------
BEGIN;

-- 清理可能残留的测试存储对象（幂等，避免唯一约束冲突）
-- storage.objects 有保护触发器禁止直接 DELETE；本地隔离库临时以 replica 角色绕过。
SET session_replication_role = replica;
DELETE FROM storage.objects
WHERE name LIKE 'aaaaaaaa-0000-0000-0000-000000000001/%'
   OR name LIKE 'bbbbbbbb-0000-0000-0000-000000000002/%';
SET session_replication_role = origin;
DELETE FROM public.partner_authorizations
WHERE requester_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
) OR addressee_id IN (
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
DELETE FROM public.messages
WHERE user_id IN (
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

-- B 的一条 friends-only 动态（供 N2 使用）
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

-- ===========================================================================
-- N1：A 直插 friends{user_id:A, friend_id:B}（无 accepted 请求）→ 拒绝
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO public.friends (user_id, friend_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL N1：A 竟能在无 accepted 请求时直插 friends';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS N1：无 accepted 请求直插 friends 被拒绝（insufficient_privilege）';
  END;
END $$;

-- ===========================================================================
-- N2：A 直插 friends 后读 B 的 friends-only moments → 0 行
-- ===========================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_count FROM public.moments
  WHERE author_id = 'bbbbbbbb-0000-0000-0000-000000000002'
    AND visibility = 'friends';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL N2：A 未建立合法好友关系却读到 B 的 friends-only 动态（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS N2：A 读不到 B 的 friends-only 动态（0 行）';
END $$;

-- ===========================================================================
-- N3：A 向 chat_media/B/... 上传 → 拒绝（foldername 校验）
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('chat_media', 'bbbbbbbb-0000-0000-0000-000000000002/secret.jpg',
            'aaaaaaaa-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL N3：A 竟能向 chat_media/B/... 上传';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS N3：A 向 chat_media/B/... 上传被拒绝（insufficient_privilege）';
  END;
END $$;

-- ===========================================================================
-- N4：A 向 chat_media/A/... 上传 → 成功（正向）
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  INSERT INTO storage.objects (bucket_id, name, owner)
  VALUES ('chat_media', 'aaaaaaaa-0000-0000-0000-000000000001/mine.jpg',
          'aaaaaaaa-0000-0000-0000-000000000001');
  RAISE NOTICE 'PASS N4：A 向 chat_media/A/... 上传成功';
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL N4：A 向自己的命名空间上传被误拒：%', SQLERRM;
END $$;

-- ===========================================================================
-- N5：unbind_partner(B)（存在 accepted 关系）→ 成功，subtype=SYNC_PARTNER_UNBOUND
-- ===========================================================================
DO $$
DECLARE
  v_subtype TEXT;
BEGIN
  -- unbind_partner 的授权依据是 partner_authorizations（accepted），
  -- 且只迁移 subtype='SYNC_PARTNER_ACCEPTED' 的历史卡片。
  -- 先以超级用户建立：accepted 授权 + 一条 SYNC_PARTNER_ACCEPTED 卡片。
  INSERT INTO public.partner_authorizations (requester_id, addressee_id, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002', 'accepted');
  INSERT INTO public.messages (user_id, receiver_id, type, subtype, text)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002', 'action',
          'SYNC_PARTNER_ACCEPTED', '已绑定搭子');

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM public.unbind_partner('bbbbbbbb-0000-0000-0000-000000000002');

  SELECT subtype INTO v_subtype FROM public.messages
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002'
    AND subtype = 'SYNC_PARTNER_UNBOUND'
  ORDER BY created_at DESC LIMIT 1;

  IF v_subtype IS DISTINCT FROM 'SYNC_PARTNER_UNBOUND' THEN
    RAISE EXCEPTION 'FAIL N5：unbind_partner 未写入 SYNC_PARTNER_UNBOUND 卡片';
  END IF;
  RAISE NOTICE 'PASS N5：unbind_partner 成功写入 SYNC_PARTNER_UNBOUND';
END $$;

-- ===========================================================================
-- N6：unbind_partner(B)（无关系）→ 静默返回，不清任何指针
-- ===========================================================================
DO $$
DECLARE
  v_before UUID;
  v_after UUID;
BEGIN
  -- 清理 A/B 关系，制造「无关系」场景（含 N5 建立的 accepted 授权）
  DELETE FROM public.partner_authorizations
  WHERE (requester_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND addressee_id = 'bbbbbbbb-0000-0000-0000-000000000002')
     OR (requester_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND addressee_id = 'aaaaaaaa-0000-0000-0000-000000000001');
  DELETE FROM public.friends
  WHERE (user_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND friend_id = 'bbbbbbbb-0000-0000-0000-000000000002')
     OR (user_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND friend_id = 'aaaaaaaa-0000-0000-0000-000000000001');
  DELETE FROM public.friend_requests
  WHERE (sender_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002')
     OR (sender_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND receiver_id = 'aaaaaaaa-0000-0000-0000-000000000001');

  SELECT bound_partner_id INTO v_before FROM public.profiles
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM public.unbind_partner('bbbbbbbb-0000-0000-0000-000000000002');

  SELECT bound_partner_id INTO v_after FROM public.profiles
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';

  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'FAIL N6：无关系时 unbind_partner 改动了 bound_partner_id（% → %）', v_before, v_after;
  END IF;
  RAISE NOTICE 'PASS N6：无关系时 unbind_partner 静默返回，未清指针';
END $$;

-- ===========================================================================
-- N7：A 直接 UPDATE messages.text（非撤回）→ 拒绝（触发器未放宽）
-- ===========================================================================
DO $$
DECLARE
  v_msg_id UUID;
BEGIN
  -- 超级用户插入一条 A 发给 B 的普通文本消息
  INSERT INTO public.messages (user_id, receiver_id, type, text)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002', 'text', '原始内容')
  RETURNING id INTO v_msg_id;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    UPDATE public.messages SET text = '被篡改' WHERE id = v_msg_id;
    RAISE EXCEPTION 'FAIL N7：A 竟能直接改写 messages.text';
  EXCEPTION
    WHEN OTHERS THEN
      -- 触发器抛出的异常（raise_exception / check_violation）均视为拒绝
      IF SQLERRM LIKE 'FAIL N7%' THEN RAISE; END IF;
      RAISE NOTICE 'PASS N7：直接改写 messages.text 被拒绝（%）', SQLERRM;
  END;
END $$;

-- ===========================================================================
-- N10：C3/S4 — profiles.bound_partner_id 列读取（未实施 → 登记残留）
-- ===========================================================================
DO $$
DECLARE
  v_readable BOOLEAN := FALSE;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    PERFORM bound_partner_id FROM public.profiles
    WHERE bound_partner_id IS NOT NULL LIMIT 1;
    v_readable := TRUE;
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_readable := FALSE;
  END;
  IF v_readable THEN
    RAISE NOTICE 'N10（已知残留，C3/S4 未纳入 R0）：bound_partner_id 仍可被 authenticated 读取，登记为待加固项';
  ELSE
    RAISE NOTICE 'N10：bound_partner_id 读取已被列级权限拒绝（C3/S4 已生效）';
  END IF;
END $$;

-- ===========================================================================
-- N11：friend_requests 直插 status='accepted' → 拒绝（S1-3）
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO public.friend_requests (sender_id, receiver_id, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000003', 'accepted');
    RAISE EXCEPTION 'FAIL N11：A 竟能直插 status=accepted 的 friend_request';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS N11：直插 status=accepted 被拒绝（insufficient_privilege）';
  END;
END $$;

-- ===========================================================================
-- N12：receiver UPDATE status='whatever' → 拒绝（S1-4）
-- ===========================================================================
DO $$
DECLARE
  v_req_id UUID;
BEGIN
  -- 超级用户建立一条 pending 请求 A→B
  INSERT INTO public.friend_requests (sender_id, receiver_id, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002', 'pending')
  RETURNING id INTO v_req_id;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  BEGIN
    UPDATE public.friend_requests SET status = 'whatever' WHERE id = v_req_id;
    RAISE EXCEPTION 'FAIL N12：receiver 竟能把 status 改成非法值 whatever';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'FAIL N12%' THEN RAISE; END IF;
      RAISE NOTICE 'PASS N12：非法状态迁移被拒绝（%）', SQLERRM;
  END;
END $$;

-- ===========================================================================
-- N13：UPDATE friends.friend_id=C（过户）→ 拒绝（S1-5 不可变触发器）
-- ===========================================================================
DO $$
BEGIN
  -- 超级用户建立 A↔B 合法关系（先清掉 N12 残留的 A→B 请求，避免唯一约束冲突）
  DELETE FROM public.friend_requests
  WHERE sender_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  DELETE FROM public.friends
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    AND friend_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  INSERT INTO public.friend_requests (sender_id, receiver_id, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002', 'accepted');
  INSERT INTO public.friends (user_id, friend_id)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    UPDATE public.friends
    SET friend_id = 'cccccccc-0000-0000-0000-000000000003'
    WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND friend_id = 'bbbbbbbb-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'FAIL N13：A 竟能把好友关系过户给 C';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'FAIL N13%' THEN RAISE; END IF;
      RAISE NOTICE 'PASS N13：好友关系过户被拒绝（%）', SQLERRM;
  END;
END $$;

-- ===========================================================================
-- N14：直插 messages.media_url='B_uid/secret.jpg' → 拒绝（S2-b 写侧触发器）
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO public.messages (user_id, receiver_id, type, media_url)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'image',
            'bbbbbbbb-0000-0000-0000-000000000002/secret.jpg');
    RAISE EXCEPTION 'FAIL N14：A 竟能引用 B 命名空间的媒体';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'FAIL N14%' THEN RAISE; END IF;
      RAISE NOTICE 'PASS N14：引用他人命名空间媒体被拒绝（%）', SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 清理测试数据
-- ---------------------------------------------------------------------------
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
DELETE FROM public.messages
WHERE user_id IN (
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
SET session_replication_role = replica;
DELETE FROM storage.objects
WHERE name LIKE 'aaaaaaaa-0000-0000-0000-000000000001/%'
   OR name LIKE 'bbbbbbbb-0000-0000-0000-000000000002/%';
SET session_replication_role = origin;

\echo '===== N1–N17 DB 侧负面测试全部通过 ====='
-- --- END OF FILE tests/security/p10_r0_negative.test.sql ---
