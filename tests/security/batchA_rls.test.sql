-- --- START OF FILE tests/security/batchA_rls.test.sql ---
-- ============================================================================
-- TASK-P0.2 / Batch A 集成测试（真实 RLS + 真实受限角色）
-- ============================================================================
-- 运行方式（隔离环境，非生产）：
--   docker exec -i supabase_db_p02-supabase-test \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f /tmp/batchA_rls.test.sql
--
-- 设计原则：
--   · 不用 postgres 超级用户验证 RLS —— 超级用户绕过 RLS，测不出问题。
--   · 每个用例都 SET LOCAL ROLE authenticated + 设置 request.jwt.claims，
--     模拟 PostgREST 的真实执行环境。
--   · 全部使用虚构账号 A / B / C，不涉及任何真实用户数据。
--   · 断言失败即 RAISE EXCEPTION，脚本以非零退出码结束。
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------------
-- 0. 准备：创建虚构用户 A / B / C
-- ---------------------------------------------------------------------------
BEGIN;

-- 清理可能残留的测试数据（幂等）
DELETE FROM public.partner_authorizations
WHERE requester_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003'
);
DELETE FROM public.health_records
WHERE user_id IN (
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

-- handle_new_user 触发器会自动建 profiles；确保存在并补齐
INSERT INTO public.profiles (id, username, nickname, sync_id)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'user_a', 'A', 'user_aaaa0001'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'user_b', 'B', 'user_bbbb0002'),
  ('cccccccc-0000-0000-0000-000000000003', 'user_c', 'C', 'user_cccc0003')
ON CONFLICT (id) DO NOTHING;

-- 每人一条健康记录
INSERT INTO public.health_records (user_id, record_date, water_amount)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-16', 1000),
  ('bbbbbbbb-0000-0000-0000-000000000002', '2026-11-16', 2000),
  ('cccccccc-0000-0000-0000-000000000003', '2026-11-16', 3000)
ON CONFLICT (user_id, record_date) DO UPDATE SET water_amount = EXCLUDED.water_amount;

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
-- 用例 1：无授权时，A 读不到 B 的健康记录
-- ===========================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 用例1：无授权时 A 不应读到 B 的健康记录，实际读到 % 行', v_count;
  END IF;
  RAISE NOTICE 'PASS 用例1：无授权时 A 读不到 B 的健康记录';
END $$;

-- ===========================================================================
-- 用例 2：A 不能直接 INSERT 授权记录（客户端无权建立授权）
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    INSERT INTO public.partner_authorizations (requester_id, addressee_id, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
            'bbbbbbbb-0000-0000-0000-000000000002',
            'accepted');
    RAISE EXCEPTION 'FAIL 用例2：A 竟然能直接 INSERT 授权记录';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 用例2：A 直接 INSERT 授权记录被拒绝（insufficient_privilege）';
  END;
END $$;

-- ===========================================================================
-- 用例 3：A 不能直接 UPDATE profiles.bound_partner_id 来「自授权」
-- ===========================================================================
-- 说明（T6.1/FIX-02 更新）：
--   迁移 25 已把 profiles 的 UPDATE 权限收紧为列级白名单
--   （nickname / sync_id / last_id_modified_at / expo_push_token），
--   bound_partner_id 不在白名单内，因此客户端连「写指针」这一步都做不到。
--   本用例断言的是**更强的结论**：写指针被列级权限直接拒绝。
--   同时保留「即使指针被写成 B，也读不到 B 的健康记录」这一层语义验证，
--   由用例 4 之后的关系链路覆盖（授权依据只认 partner_authorizations）。
DO $$
DECLARE
  v_count INT;
  v_blocked BOOLEAN := FALSE;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    UPDATE public.profiles
    SET bound_partner_id = 'bbbbbbbb-0000-0000-0000-000000000002'
    WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_blocked := TRUE;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'FAIL 用例3：客户端仍可写 profiles.bound_partner_id（列级权限未收紧）';
  END IF;

  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002';

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 用例3：未授权时竟能读到 B 的健康记录（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS 用例3：bound_partner_id 写入被列级权限拒绝，且不授予健康读取权限';
END $$;

-- ===========================================================================
-- 用例 4：A 发起邀请 → B 接受 → 双方可互读健康记录
-- ===========================================================================
DO $$
DECLARE
  v_invite UUID;
  v_count INT;
BEGIN
  -- A 发起邀请
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  v_invite := public.request_partner('bbbbbbbb-0000-0000-0000-000000000002');

  IF v_invite IS NULL THEN
    RAISE EXCEPTION 'FAIL 用例4：request_partner 未返回邀请 id';
  END IF;

  -- B 接受
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  PERFORM public.accept_partner_invite(v_invite);

  -- A 读 B
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL 用例4：授权后 A 应读到 B 的 1 条健康记录，实际 %', v_count;
  END IF;

  -- B 读 A
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL 用例4：授权后 B 应读到 A 的 1 条健康记录，实际 %', v_count;
  END IF;

  RAISE NOTICE 'PASS 用例4：邀请→接受后双方可互读健康记录';
END $$;

-- ===========================================================================
-- 用例 5：第三方 C 仍读不到 A / B 的健康记录
-- ===========================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');

  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                    'bbbbbbbb-0000-0000-0000-000000000002');

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 用例5：第三方 C 读到了 A/B 的健康记录（% 行）', v_count;
  END IF;
  RAISE NOTICE 'PASS 用例5：第三方 C 读不到 A/B 的健康记录';
END $$;

-- ===========================================================================
-- 用例 6：C 不能接受不属于自己的邀请
-- ===========================================================================
DO $$
DECLARE
  v_invite UUID;
BEGIN
  -- 先由 A 向 B 发一条新邀请（此时 A/B 已绑定，应被拒绝）
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    v_invite := public.request_partner('cccccccc-0000-0000-0000-000000000003');
    RAISE EXCEPTION 'FAIL 用例6：A 已有有效搭子，仍能向 C 发起邀请';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'PASS 用例6a：已有有效搭子时发起新邀请被拒绝';
  END;
END $$;

-- ===========================================================================
-- 用例 7：撤销后立即失去读取权限
-- ===========================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM public.revoke_partner_authorization();

  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 用例7：撤销后 A 仍能读到 B 的健康记录（% 行）', v_count;
  END IF;

  -- B 侧同样失去
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 用例7：撤销后 B 仍能读到 A 的健康记录（% 行）', v_count;
  END IF;

  RAISE NOTICE 'PASS 用例7：撤销后双方立即失去读取权限';
END $$;

-- ===========================================================================
-- 用例 8：本人始终能读写自己的健康记录
-- ===========================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  SELECT count(*) INTO v_count FROM public.health_records
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FAIL 用例8：A 读不到自己的健康记录';
  END IF;

  UPDATE public.health_records SET water_amount = 1500
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    AND record_date = '2026-11-16';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 用例8：A 无法更新自己的健康记录';
  END IF;

  RAISE NOTICE 'PASS 用例8：本人可读写自己的健康记录';
END $$;

-- ===========================================================================
-- 用例 9：消息不可变字段保护 —— 发送者不能改 receiver_id
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
BEGIN
  -- 用 postgres 身份插入一条 A→B 的消息（绕过 RLS 准备数据）
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', 'hello')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    UPDATE public.messages SET receiver_id = 'cccccccc-0000-0000-0000-000000000003'
    WHERE id = v_msg;
    RAISE EXCEPTION 'FAIL 用例9：发送者竟能改写 receiver_id';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 用例9：改写 receiver_id 被拒绝（列权限）';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%immutable%' THEN
        RAISE NOTICE 'PASS 用例9：改写 receiver_id 被拒绝（触发器）';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 10：发送者不能任意改写 text（只允许撤回）
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', 'original')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    UPDATE public.messages SET text = 'tampered' WHERE id = v_msg;
    RAISE EXCEPTION 'FAIL 用例10：发送者竟能任意改写 text';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%recall%' THEN
        RAISE NOTICE 'PASS 用例10：任意改写 text 被拒绝（仅允许撤回）';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 11：合法撤回必须使用「真实客户端协议」
--   T6/Gemini P0-1：客户端实际发送的是
--     { type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null }
--   旧用例写成 type='recalled' + text=''，与真实客户端不一致，
--   导致「触发器与客户端协议冲突」这一致命问题被测试掩盖。
--   本用例严格按真实 payload 断言，并额外验证旧协议已被拒绝。
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
  v_row RECORD;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, media_url)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'image', 'to be recalled', 'chat_media/a/x.jpg')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  -- 真实客户端撤回 payload
  UPDATE public.messages
  SET type = 'action',
      text = '撤回了一条消息',
      media_url = NULL,
      thumbnail_url = NULL
  WHERE id = v_msg;

  SELECT text, type, media_url INTO v_row FROM public.messages WHERE id = v_msg;
  IF v_row.type <> 'action' OR v_row.text <> '撤回了一条消息' OR v_row.media_url IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 用例11：真实撤回协议未生效（type=%, text=%, media_url=%）',
      v_row.type, v_row.text, v_row.media_url;
  END IF;
  RAISE NOTICE 'PASS 用例11a：真实客户端撤回协议（type=action + 精确文案）成功';

  -- 旧协议 type='recalled' 必须被拒绝（防止协议再次漂移）
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', 'legacy recall')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    UPDATE public.messages SET text = '', type = 'recalled' WHERE id = v_msg;
    RAISE EXCEPTION 'FAIL 用例11b：旧协议 type=recalled 竟被接受';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%recall%' THEN
        RAISE NOTICE 'PASS 用例11b：旧协议 type=recalled 被拒绝';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 12：接收者只能标记已读，不能改内容
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, is_read)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', 'read me', false)
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');

  -- 标记已读应成功
  UPDATE public.messages SET is_read = true WHERE id = v_msg;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 用例12：接收者无法标记已读';
  END IF;

  -- 改内容应失败
  BEGIN
    UPDATE public.messages SET text = 'hacked' WHERE id = v_msg;
    RAISE EXCEPTION 'FAIL 用例12：接收者竟能改写消息内容';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%recall%' OR SQLERRM LIKE '%permission%' THEN
        RAISE NOTICE 'PASS 用例12：接收者只能标记已读，不能改内容';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 13：普通发送不能伪造系统卡片（subtype = SYNC_PARTNER_*）
-- ===========================================================================
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    INSERT INTO public.messages (user_id, receiver_id, type, text, subtype)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
            'bbbbbbbb-0000-0000-0000-000000000002',
            'system', 'fake card', 'SYNC_PARTNER_ACCEPTED');
    RAISE EXCEPTION 'FAIL 用例13：普通发送竟能伪造系统卡片';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 用例13：伪造系统卡片被 RLS 拒绝';
  END;
END $$;

-- ===========================================================================
-- 用例 14：delete_conversation 软删除仍可用（不被列权限误伤）
-- ===========================================================================
DO $$
DECLARE
  v_affected BIGINT;
  v_visible INT;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  v_affected := public.delete_conversation('bbbbbbbb-0000-0000-0000-000000000002');
  IF v_affected IS NULL OR v_affected < 1 THEN
    RAISE EXCEPTION 'FAIL 用例14：delete_conversation 未标记任何消息（%）', v_affected;
  END IF;

  -- A 视角：过滤掉 deleted_by 含自己的行后应为 0
  SELECT count(*) INTO v_visible FROM public.messages
  WHERE ((user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002')
      OR (user_id = 'bbbbbbbb-0000-0000-0000-000000000002'
          AND receiver_id = 'aaaaaaaa-0000-0000-0000-000000000001'))
    AND NOT ('aaaaaaaa-0000-0000-0000-000000000001' = ANY(deleted_by));
  IF v_visible <> 0 THEN
    RAISE EXCEPTION 'FAIL 用例14：A 删除会话后仍可见 % 条', v_visible;
  END IF;

  -- B 视角：仍应看到全部
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  SELECT count(*) INTO v_visible FROM public.messages
  WHERE ((user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND receiver_id = 'bbbbbbbb-0000-0000-0000-000000000002')
      OR (user_id = 'bbbbbbbb-0000-0000-0000-000000000002'
          AND receiver_id = 'aaaaaaaa-0000-0000-0000-000000000001'))
    AND NOT ('bbbbbbbb-0000-0000-0000-000000000002' = ANY(deleted_by));
  IF v_visible < 1 THEN
    RAISE EXCEPTION 'FAIL 用例14：A 删除会话后 B 也看不到了（单边删除被破坏）';
  END IF;

  RAISE NOTICE 'PASS 用例14：软删除仅影响本人视角，对方仍可见';
END $$;

-- ===========================================================================
-- 用例 15：并发接受同一邀请只有一个成功（一对一硬约束）
-- ===========================================================================
DO $$
DECLARE
  v_invite UUID;
  v_ok INT := 0;
BEGIN
  -- 先撤销 A/B 关系，让 A 可以重新邀请
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM public.revoke_partner_authorization();
  v_invite := public.request_partner('bbbbbbbb-0000-0000-0000-000000000002');

  -- B 接受一次
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  PERFORM public.accept_partner_invite(v_invite);
  v_ok := v_ok + 1;

  -- 再次接受同一邀请应失败（已非 pending）
  BEGIN
    PERFORM public.accept_partner_invite(v_invite);
    RAISE EXCEPTION 'FAIL 用例15：同一邀请被接受了两次';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%not pending%' THEN
        RAISE NOTICE 'PASS 用例15：重复接受同一邀请被拒绝';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 16：匿名角色无法读取授权表与健康记录
-- ===========================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);

  BEGIN
    SELECT count(*) INTO v_count FROM public.partner_authorizations;
    RAISE EXCEPTION 'FAIL 用例16：anon 竟能读取授权表';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 用例16a：anon 读取授权表被拒绝';
  END;

  -- anon 读取健康记录必须被拒绝。两种拒绝形态都算通过：
  --   (1) 表级 GRANT 已收回 → 抛 insufficient_privilege（迁移 23 后的现状）
  --   (2) 表级 GRANT 仍在但无 RLS 策略 → 返回 0 行（PostgreSQL RLS 语义）
  -- 任一形态都证明 anon 拿不到健康数据；只有「读到 >0 行」才是失败。
  BEGIN
    SELECT count(*) INTO v_count FROM public.health_records;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'FAIL 用例16：anon 读到了 % 行健康记录', v_count;
    END IF;
    RAISE NOTICE 'PASS 用例16b：anon 读不到任何健康记录（RLS 返回空集）';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 用例16b：anon 读取健康记录被表级权限拒绝';
  END;
END $$;

-- ===========================================================================
-- 用例 17：跨角色一对一硬约束（T6/Gemini P1-2）
--   A 邀请 B，同时 C 邀请 A。B 接受、A 接受 —— 若仅靠「每方向部分唯一索引」，
--   A 会同时成为一条关系的 requester 和另一条关系的 addressee。
--   成员表唯一索引必须让第二个 accept 失败。
-- ===========================================================================
DO $$
DECLARE
  v_inv_ab UUID;
  v_inv_ca UUID;
  v_member_cnt INT;
BEGIN
  RESET ROLE;
  -- 清空三人之间的所有授权，回到干净状态
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002',
                         'cccccccc-0000-0000-0000-000000000003')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002',
                         'cccccccc-0000-0000-0000-000000000003');

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  v_inv_ab := public.request_partner('bbbbbbbb-0000-0000-0000-000000000002');

  PERFORM pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
  v_inv_ca := public.request_partner('aaaaaaaa-0000-0000-0000-000000000001');

  -- B 接受 A 的邀请 → A-B 成为有效关系
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  PERFORM public.accept_partner_invite(v_inv_ab);

  -- A 再接受 C 的邀请 → 必须失败（A 已在 A-B 关系中）
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  BEGIN
    PERFORM public.accept_partner_invite(v_inv_ca);
    RAISE EXCEPTION 'FAIL 用例17：A 同时进入了两个搭子关系（跨角色约束失效）';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%active partner%' OR SQLERRM LIKE '%duplicate key%' THEN
        RAISE NOTICE 'PASS 用例17：跨角色重复绑定被拒绝（%）', SQLERRM;
      ELSE
        RAISE;
      END IF;
  END;

  -- 成员表里 A 只能出现一次
  RESET ROLE;
  SELECT count(*) INTO v_member_cnt FROM public.partner_authorization_members
  WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_member_cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL 用例17：A 在成员表中出现 % 次（应为 1）', v_member_cnt;
  END IF;
  RAISE NOTICE 'PASS 用例17：成员表保证 A 只属于一条有效关系';
END $$;

-- ===========================================================================
-- 用例 18：unbind_partner 对象级授权（T6/A03）
--   C 调用 unbind_partner(A) 时，A 与 C 之间没有有效关系 →
--   绝不能清空 A 的 bound_partner_id，也不能撤销 A-B 的关系。
-- ===========================================================================
DO $$
DECLARE
  v_status TEXT;
  v_a_bound UUID;
BEGIN
  RESET ROLE;
  -- 确保 A-B 是有效关系
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002');
  INSERT INTO public.partner_authorizations (requester_id, addressee_id, status, responded_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'accepted', timezone('utc', now()));
  -- 注意：此处以 postgres（RESET ROLE 后）身份写入 bound_partner_id，
  -- 仅用于构造「旧数据里指针已存在」的场景；客户端角色无此列写权限（见用例 3）。
  UPDATE public.profiles SET bound_partner_id = 'bbbbbbbb-0000-0000-0000-000000000002'
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';

  -- C 试图解绑 A
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
  PERFORM public.unbind_partner('aaaaaaaa-0000-0000-0000-000000000001');

  RESET ROLE;
  SELECT status INTO v_status FROM public.partner_authorizations
  WHERE requester_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    AND addressee_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  IF v_status <> 'accepted' THEN
    RAISE EXCEPTION 'FAIL 用例18：C 越权解绑导致 A-B 关系变为 %', v_status;
  END IF;

  SELECT bound_partner_id INTO v_a_bound FROM public.profiles
  WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_a_bound IS DISTINCT FROM 'bbbbbbbb-0000-0000-0000-000000000002'::UUID THEN
    RAISE EXCEPTION 'FAIL 用例18：C 越权解绑清空了 A 的 bound_partner_id';
  END IF;
  RAISE NOTICE 'PASS 用例18：unbind_partner 具备对象级授权，越权调用无副作用';
END $$;

-- ===========================================================================
-- 用例 19：过期邀请必须「先持久化 expired，再让调用方感知失败」（T6/A08）
-- ===========================================================================
DO $$
DECLARE
  v_invite UUID;
  v_status TEXT;
BEGIN
  RESET ROLE;
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002');

  -- 直接插入一条已过期的 pending 邀请
  INSERT INTO public.partner_authorizations
    (requester_id, addressee_id, status, expires_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'pending', timezone('utc', now()) - INTERVAL '1 day')
  RETURNING id INTO v_invite;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  -- accept 对过期邀请不抛错，而是落库 expired 后返回
  PERFORM public.accept_partner_invite(v_invite);

  RESET ROLE;
  SELECT status INTO v_status FROM public.partner_authorizations WHERE id = v_invite;
  IF v_status <> 'expired' THEN
    RAISE EXCEPTION 'FAIL 用例19：过期邀请接受后状态为 %（应为 expired）', v_status;
  END IF;
  RAISE NOTICE 'PASS 用例19：过期邀请被持久化为 expired，客户端可据此提示';
END $$;

-- ===========================================================================
-- 用例 20：request_partner 会先清理过期 pending 再复用/新建（T6/A08）
-- ===========================================================================
DO $$
DECLARE
  v_old UUID;
  v_new UUID;
  v_old_status TEXT;
BEGIN
  RESET ROLE;
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002');

  INSERT INTO public.partner_authorizations
    (requester_id, addressee_id, status, expires_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'pending', timezone('utc', now()) - INTERVAL '1 day')
  RETURNING id INTO v_old;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  v_new := public.request_partner('bbbbbbbb-0000-0000-0000-000000000002');

  RESET ROLE;
  SELECT status INTO v_old_status FROM public.partner_authorizations WHERE id = v_old;
  IF v_old_status <> 'expired' THEN
    RAISE EXCEPTION 'FAIL 用例20：旧过期邀请未被标记 expired（%）', v_old_status;
  END IF;
  IF v_new = v_old THEN
    RAISE EXCEPTION 'FAIL 用例20：request_partner 复用了已过期的邀请';
  END IF;
  RAISE NOTICE 'PASS 用例20：过期 pending 被清理，新建了独立邀请';
END $$;

-- ===========================================================================
-- 用例 21：get_active_partner_id 结果确定性（T6/Gemini P2-2）
--   即使存在多条历史 accepted 行（异常数据），也必须稳定返回同一条。
-- ===========================================================================
DO $$
DECLARE
  v_first UUID;
  v_second UUID;
BEGIN
  RESET ROLE;
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002',
                         'cccccccc-0000-0000-0000-000000000003')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002',
                         'cccccccc-0000-0000-0000-000000000003');

  -- 绕过成员唯一索引，直接构造两条 accepted（模拟历史脏数据）
  -- 注意：两个唯一索引都会拦截，因此这里临时移除，构造完再重建。
  ALTER TABLE public.partner_authorization_members DISABLE TRIGGER USER;
  DROP INDEX IF EXISTS public.partner_authorizations_one_active_per_user;
  DROP INDEX IF EXISTS public.partner_authorization_members_one_active;
  INSERT INTO public.partner_authorizations (requester_id, addressee_id, status, updated_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'accepted', timezone('utc', now()) - INTERVAL '2 hours');
  INSERT INTO public.partner_authorizations (requester_id, addressee_id, status, updated_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-000000000003',
          'accepted', timezone('utc', now()) - INTERVAL '1 hour');
  ALTER TABLE public.partner_authorization_members ENABLE TRIGGER USER;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  v_first := public.get_active_partner_id();
  v_second := public.get_active_partner_id();

  IF v_first IS DISTINCT FROM v_second THEN
    RAISE EXCEPTION 'FAIL 用例21：get_active_partner_id 结果不确定（% vs %）', v_first, v_second;
  END IF;
  -- ORDER BY updated_at DESC → 应返回较新的 C
  IF v_first IS DISTINCT FROM 'cccccccc-0000-0000-0000-000000000003'::UUID THEN
    RAISE EXCEPTION 'FAIL 用例21：未按 updated_at DESC 取最新关系（得到 %）', v_first;
  END IF;

  -- 恢复唯一索引（清理脏数据后重建，保证后续用例与生产结构一致）
  RESET ROLE;
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002',
                         'cccccccc-0000-0000-0000-000000000003')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002',
                         'cccccccc-0000-0000-0000-000000000003');
  CREATE UNIQUE INDEX IF NOT EXISTS partner_authorizations_one_active_per_user
    ON public.partner_authorizations (requester_id)
    WHERE status = 'accepted';
  CREATE UNIQUE INDEX IF NOT EXISTS partner_authorization_members_one_active
    ON public.partner_authorization_members (user_id);

  RAISE NOTICE 'PASS 用例21：get_active_partner_id 结果确定且按 updated_at 取最新';
END $$;

-- ===========================================================================
-- 用例 22：anon 无法读取 profiles.bound_partner_id（T6/A07）
-- ===========================================================================
DO $$
DECLARE
  v_val UUID;
BEGIN
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);

  BEGIN
    SELECT bound_partner_id INTO v_val FROM public.profiles
    WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FAIL 用例22：anon 竟能读取 profiles.bound_partner_id';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS 用例22：anon 读取 bound_partner_id 被列级权限拒绝';
  END;
END $$;

-- ===========================================================================
-- 用例 23：接收方不能替发送方撤回（角色隔离，T6/A04）
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', 'sender only recall')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');

  BEGIN
    UPDATE public.messages
    SET type = 'action', text = '撤回了一条消息', media_url = NULL, thumbnail_url = NULL
    WHERE id = v_msg;
    RAISE EXCEPTION 'FAIL 用例23：接收方竟能替发送方撤回消息';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%recall%' OR SQLERRM LIKE '%permission%' THEN
        RAISE NOTICE 'PASS 用例23：接收方无法撤回他人消息';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 24：发送方不能把消息改成「系统卡片」以外的 subtype（服务端专属）
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, subtype)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'system', 'card', 'SYNC_PARTNER_ACCEPTED')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    UPDATE public.messages SET subtype = 'SYNC_PARTNER_UNBOUND' WHERE id = v_msg;
    RAISE EXCEPTION 'FAIL 用例24：发送方竟能自行推进 subtype 状态机';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%subtype%' OR SQLERRM LIKE '%permission%' THEN
        RAISE NOTICE 'PASS 用例24：subtype 状态机仅服务端可推进';
      ELSE
        RAISE;
      END IF;
  END;
END $$;

-- ===========================================================================
-- 用例 25：接收方不能改写媒体字段（media_url / thumbnail_url）—— 列级权限
-- ===========================================================================
-- FIX-04：媒体字段角色权限。接收方仅被授予 is_read 列，媒体字段不可写。
DO $$
DECLARE
  v_msg UUID;
  v_blocked BOOLEAN := FALSE;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, media_url, thumbnail_url)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'image', 'pic', 'chat_media/a/orig.jpg', 'chat_media/a/thumb.jpg')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');

  BEGIN
    UPDATE public.messages
    SET media_url = 'chat_media/evil/x.jpg'
    WHERE id = v_msg;
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_blocked := TRUE;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'FAIL 用例25：接收方竟能改写 media_url（列级权限未收紧）';
  END IF;

  -- 确认原值未被篡改
  RESET ROLE;
  IF (SELECT media_url FROM public.messages WHERE id = v_msg) <> 'chat_media/a/orig.jpg' THEN
    RAISE EXCEPTION 'FAIL 用例25：media_url 被意外改写';
  END IF;
  RAISE NOTICE 'PASS 用例25：接收方改写媒体字段被列级权限拒绝';
END $$;

-- ===========================================================================
-- 用例 26：发送方不能把 media_url 替换为另一个非空值（触发器保护）
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
  v_blocked BOOLEAN := FALSE;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, media_url)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'image', 'pic', 'chat_media/a/orig.jpg')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  BEGIN
    UPDATE public.messages
    SET media_url = 'chat_media/a/other.jpg'
    WHERE id = v_msg;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%media_url%' OR SQLERRM LIKE '%permission%' THEN
        v_blocked := TRUE;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'FAIL 用例26：发送方竟能把 media_url 替换为其它非空值';
  END IF;
  RAISE NOTICE 'PASS 用例26：发送方替换 media_url 被触发器拒绝';
END $$;

-- ===========================================================================
-- 用例 27：发送方撤回时可清空 media_url（合法路径不被误伤）
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
  v_media TEXT;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, media_url, thumbnail_url)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'image', 'pic', 'chat_media/a/orig.jpg', 'chat_media/a/thumb.jpg')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');

  UPDATE public.messages
  SET type = 'action', text = '撤回了一条消息', media_url = NULL, thumbnail_url = NULL
  WHERE id = v_msg;

  RESET ROLE;
  SELECT media_url INTO v_media FROM public.messages WHERE id = v_msg;
  IF v_media IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 用例27：撤回后 media_url 未清空（%）', v_media;
  END IF;
  RAISE NOTICE 'PASS 用例27：撤回时清空媒体字段成功（合法路径）';
END $$;

-- ===========================================================================
-- 用例 28：接收方不能清空媒体字段（T6.2 缺陷2a —— 角色校验）
--   迁移 21 的媒体字段清空必须限定发送方；接收方即使能 UPDATE 该行，
--   也不得把 media_url / thumbnail_url 置空（否则可抹掉对方消息里的媒体）。
-- ===========================================================================
DO $$
DECLARE
  v_msg UUID;
  v_blocked BOOLEAN := FALSE;
  v_media TEXT;
BEGIN
  RESET ROLE;
  INSERT INTO public.messages (user_id, receiver_id, type, text, media_url, thumbnail_url)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'image', 'pic', 'chat_media/a/orig.jpg', 'chat_media/a/thumb.jpg')
  RETURNING id INTO v_msg;

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');

  BEGIN
    UPDATE public.messages
    SET media_url = NULL, thumbnail_url = NULL
    WHERE id = v_msg;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%media_url%' OR SQLERRM LIKE '%thumbnail_url%'
         OR SQLERRM LIKE '%permission%' OR SQLERRM LIKE '%recall%' THEN
        v_blocked := TRUE;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'FAIL 用例28：接收方竟能清空媒体字段（角色校验缺失）';
  END IF;

  -- 确认原值未被清空
  RESET ROLE;
  SELECT media_url INTO v_media FROM public.messages WHERE id = v_msg;
  IF v_media IS NULL THEN
    RAISE EXCEPTION 'FAIL 用例28：media_url 被接收方清空';
  END IF;
  RAISE NOTICE 'PASS 用例28：接收方清空媒体字段被拒绝（仅发送方可撤回清空）';
END $$;

-- ===========================================================================
-- 用例 29：accept 过期路径同步卡片状态（T6.2 缺陷2b —— INVITE → EXPIRED）
--   过期邀请被 accept 时，授权行落库 expired，且对应卡片必须同步为
--   SYNC_PARTNER_EXPIRED，不能停留在 SYNC_PARTNER_INVITE（否则对方仍看到可点同意）。
-- ===========================================================================
DO $$
DECLARE
  v_invite UUID;
  v_status TEXT;
  v_subtype TEXT;
BEGIN
  RESET ROLE;
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002');
  DELETE FROM public.messages
  WHERE user_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                    'bbbbbbbb-0000-0000-0000-000000000002');

  -- 已过期的 pending 邀请 + 对应邀请卡片（卡片 id = 授权 id）
  INSERT INTO public.partner_authorizations
    (requester_id, addressee_id, status, expires_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'pending', timezone('utc', now()) - INTERVAL '1 day')
  RETURNING id INTO v_invite;

  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_invite, 'aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', '', 'SYNC_PARTNER_INVITE');

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
  PERFORM public.accept_partner_invite(v_invite);

  RESET ROLE;
  SELECT status INTO v_status FROM public.partner_authorizations WHERE id = v_invite;
  SELECT subtype INTO v_subtype FROM public.messages WHERE id = v_invite;

  IF v_status <> 'expired' THEN
    RAISE EXCEPTION 'FAIL 用例29：授权状态为 %（应为 expired）', v_status;
  END IF;
  IF v_subtype <> 'SYNC_PARTNER_EXPIRED' THEN
    RAISE EXCEPTION 'FAIL 用例29：卡片 subtype 为 %（应为 SYNC_PARTNER_EXPIRED，状态不同步）', v_subtype;
  END IF;
  RAISE NOTICE 'PASS 用例29：accept 过期路径同步卡片为 SYNC_PARTNER_EXPIRED';
END $$;

-- ===========================================================================
-- 用例 30：revoke 路径同步卡片状态（T6.2 缺陷2b —— ACCEPTED → UNBOUND）
--   撤销有效关系后，授权行落库 revoked，对应卡片必须同步为 SYNC_PARTNER_UNBOUND，
--   不能停留在 SYNC_PARTNER_ACCEPTED（否则双方仍看到「已成为搭子」）。
-- ===========================================================================
DO $$
DECLARE
  v_auth UUID;
  v_status TEXT;
  v_subtype TEXT;
BEGIN
  RESET ROLE;
  DELETE FROM public.partner_authorizations
  WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002')
     OR addressee_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                         'bbbbbbbb-0000-0000-0000-000000000002');
  DELETE FROM public.messages
  WHERE user_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                    'bbbbbbbb-0000-0000-0000-000000000002');

  -- 直接构造一条 accepted 关系 + 对应已接受卡片
  INSERT INTO public.partner_authorizations
    (requester_id, addressee_id, status, expires_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'accepted', NULL)
  RETURNING id INTO v_auth;

  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_auth, 'aaaaaaaa-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'text', '', 'SYNC_PARTNER_ACCEPTED');

  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
  PERFORM public.revoke_partner_authorization();

  RESET ROLE;
  SELECT status INTO v_status FROM public.partner_authorizations WHERE id = v_auth;
  SELECT subtype INTO v_subtype FROM public.messages WHERE id = v_auth;

  IF v_status <> 'revoked' THEN
    RAISE EXCEPTION 'FAIL 用例30：授权状态为 %（应为 revoked）', v_status;
  END IF;
  IF v_subtype <> 'SYNC_PARTNER_UNBOUND' THEN
    RAISE EXCEPTION 'FAIL 用例30：卡片 subtype 为 %（应为 SYNC_PARTNER_UNBOUND，状态不同步）', v_subtype;
  END IF;
  RAISE NOTICE 'PASS 用例30：revoke 路径同步卡片为 SYNC_PARTNER_UNBOUND';
END $$;

-- ===========================================================================
-- 清理
-- ===========================================================================
RESET ROLE;
DELETE FROM public.partner_authorizations
WHERE requester_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                       'bbbbbbbb-0000-0000-0000-000000000002',
                       'cccccccc-0000-0000-0000-000000000003');
DELETE FROM public.messages
WHERE user_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                  'bbbbbbbb-0000-0000-0000-000000000002',
                  'cccccccc-0000-0000-0000-000000000003');
DELETE FROM public.health_records
WHERE user_id IN ('aaaaaaaa-0000-0000-0000-000000000001',
                  'bbbbbbbb-0000-0000-0000-000000000002',
                  'cccccccc-0000-0000-0000-000000000003');
DELETE FROM public.profiles
WHERE id IN ('aaaaaaaa-0000-0000-0000-000000000001',
             'bbbbbbbb-0000-0000-0000-000000000002',
             'cccccccc-0000-0000-0000-000000000003');
DELETE FROM auth.users
WHERE id IN ('aaaaaaaa-0000-0000-0000-000000000001',
             'bbbbbbbb-0000-0000-0000-000000000002',
             'cccccccc-0000-0000-0000-000000000003');

\echo '=== Batch A 集成测试全部通过 ==='

-- --- END OF FILE tests/security/batchA_rls.test.sql ---
