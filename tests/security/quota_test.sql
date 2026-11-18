-- ===========================================================================
-- Batch B — 语音转写配额 RPC 集成测试（真实隔离数据库）
--
-- 运行：
--   docker exec -i supabase_db_p02-supabase-test \
--     psql "postgresql://postgres:postgres@127.0.0.1:5432/postgres" \
--     -v ON_ERROR_STOP=1 < tests/security/quota_test.sql
--
-- T6/B01 语义变更：配额从「成功计数」改为「尝试计数 + 唯一预占 id」。
--   * transcribe_quota_reserve(...) RETURNS UUID —— 返回预占 id，NULL 表示配额已满
--   * transcribe_quota_release(p_reservation_id, p_user_id) RETURNS BOOLEAN
--       —— 幂等释放，只有 reserved→released 状态迁移成功者才回滚计数
--   * transcribe_quota_cleanup(...) RETURNS INTEGER —— 清理过期窗口与预占
--
-- 覆盖：
--   Q1  首次预占成功并返回非空 reservation id
--   Q2  用户请求数上限生效（第 N+1 次返回 NULL）
--   Q3  用户字节上限生效
--   Q4  全局请求数上限生效（多用户共享）
--   Q5  全局字节上限生效
--   Q6  释放后配额可再次预占
--   Q7  重复释放幂等（第二次返回 false，计数不再回滚）
--   Q8  跨用户释放被拒绝（伪造 id 无副作用）
--   Q9  非法参数抛错（fail-closed）
--   Q10 authenticated / anon 无权执行 RPC
--   Q11 配额表对 authenticated / anon 不可读
--   Q12 清理函数删除过期窗口与过期预占
-- ===========================================================================

\set ON_ERROR_STOP on

BEGIN;

-- 清空配额表，保证可重复运行
DELETE FROM public.transcribe_quota_reservations;
DELETE FROM public.transcribe_quota_windows;

-- ---------------------------------------------------------------------------
-- Q1 首次预占成功并返回非空 reservation id
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID;
BEGIN
  v_rid := public.transcribe_quota_reserve(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000,
    3, 100000, 100, 10000000, 60);
  IF v_rid IS NULL THEN
    RAISE EXCEPTION 'FAIL Q1：首次预占应成功并返回 reservation id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.transcribe_quota_reservations
    WHERE reservation_id = v_rid AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'FAIL Q1：预占记录未落库或状态不是 reserved';
  END IF;
  RAISE NOTICE 'PASS Q1：首次预占成功并落库 reservation id';
END $$;

-- ---------------------------------------------------------------------------
-- Q2 用户请求数上限（max_requests = 3，已用 1，再预占 2 次成功，第 4 次返回 NULL）
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID;
BEGIN
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 3, 100000, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q2：第 2 次预占应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 3, 100000, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q2：第 3 次预占应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 3, 100000, 100, 10000000, 60);
  IF v_rid IS NOT NULL THEN RAISE EXCEPTION 'FAIL Q2：第 4 次预占应被拒绝（返回 NULL）'; END IF;
  RAISE NOTICE 'PASS Q2：用户请求数上限生效';
END $$;

-- ---------------------------------------------------------------------------
-- Q3 用户字节上限（重置后，max_bytes = 2500，每次 1000，第 3 次超限）
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 100, 2500, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q3：第 1 次应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 100, 2500, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q3：第 2 次应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 100, 2500, 100, 10000000, 60);
  IF v_rid IS NOT NULL THEN RAISE EXCEPTION 'FAIL Q3：第 3 次应因字节超限被拒绝'; END IF;
  RAISE NOTICE 'PASS Q3：用户字节上限生效';
END $$;

-- ---------------------------------------------------------------------------
-- Q4 全局请求数上限（global_max_requests = 2，两个用户各 1 次后第 3 次失败）
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 100, 100, 100000, 2, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q4：用户 A 第 1 次应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('bbbbbbbb-0000-0000-0000-000000000002'::uuid, 100, 100, 100000, 2, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q4：用户 B 第 1 次应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 100, 100, 100000, 2, 10000000, 60);
  IF v_rid IS NOT NULL THEN RAISE EXCEPTION 'FAIL Q4：全局第 3 次应被拒绝'; END IF;
  RAISE NOTICE 'PASS Q4：全局请求数上限生效';
END $$;

-- ---------------------------------------------------------------------------
-- Q5 全局字节上限（global_max_bytes = 1500，每次 1000，第 2 次失败）
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 100, 100000, 100, 1500, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q5：第 1 次应成功'; END IF;
  v_rid := public.transcribe_quota_reserve('bbbbbbbb-0000-0000-0000-000000000002'::uuid, 1000, 100, 100000, 100, 1500, 60);
  IF v_rid IS NOT NULL THEN RAISE EXCEPTION 'FAIL Q5：全局字节超限应被拒绝'; END IF;
  RAISE NOTICE 'PASS Q5：全局字节上限生效';
END $$;

-- ---------------------------------------------------------------------------
-- Q6 释放后配额可再次预占
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID; v_ok BOOLEAN;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 1, 100000, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q6：首次应成功'; END IF;
  IF public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 1, 100000, 100, 10000000, 60) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL Q6：达上限应拒绝';
  END IF;
  v_ok := public.transcribe_quota_release(v_rid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL Q6：首次释放应返回 true'; END IF;
  IF public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 1, 100000, 100, 10000000, 60) IS NULL THEN
    RAISE EXCEPTION 'FAIL Q6：释放后应可再次预占';
  END IF;
  RAISE NOTICE 'PASS Q6：释放后配额可再次预占';
END $$;

-- ---------------------------------------------------------------------------
-- Q7 重复释放幂等（第二次返回 false，计数不再回滚）
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID; v_ok BOOLEAN; v_req INT;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 10, 100000, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q7：预占应成功'; END IF;
  v_ok := public.transcribe_quota_release(v_rid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL Q7：首次释放应返回 true'; END IF;
  v_ok := public.transcribe_quota_release(v_rid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid);
  IF v_ok IS NOT FALSE THEN RAISE EXCEPTION 'FAIL Q7：重复释放应返回 false（幂等）'; END IF;
  SELECT req_count INTO v_req
  FROM public.transcribe_quota_windows
  WHERE scope = 'user' AND subject_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF v_req IS NOT NULL AND v_req < 0 THEN
    RAISE EXCEPTION 'FAIL Q7：重复释放把计数减成负数 req=%', v_req;
  END IF;
  RAISE NOTICE 'PASS Q7：重复释放幂等，计数不为负';
END $$;

-- ---------------------------------------------------------------------------
-- Q8 跨用户释放被拒绝（伪造 id 无副作用）
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rid UUID; v_ok BOOLEAN; v_status TEXT;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;
  v_rid := public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 10, 100000, 100, 10000000, 60);
  IF v_rid IS NULL THEN RAISE EXCEPTION 'FAIL Q8：预占应成功'; END IF;
  -- 用户 B 试图释放用户 A 的预占
  v_ok := public.transcribe_quota_release(v_rid, 'bbbbbbbb-0000-0000-0000-000000000002'::uuid);
  IF v_ok IS NOT FALSE THEN RAISE EXCEPTION 'FAIL Q8：跨用户释放应返回 false'; END IF;
  SELECT status INTO v_status FROM public.transcribe_quota_reservations WHERE reservation_id = v_rid;
  IF v_status IS DISTINCT FROM 'reserved' THEN
    RAISE EXCEPTION 'FAIL Q8：跨用户释放不应改变预占状态（当前 %）', v_status;
  END IF;
  RAISE NOTICE 'PASS Q8：跨用户释放被拒绝且无副作用';
END $$;

-- ---------------------------------------------------------------------------
-- Q9 非法参数抛错（fail-closed）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM public.transcribe_quota_reserve(NULL, 1000, 10, 100000, 100, 10000000, 60);
    RAISE EXCEPTION 'FAIL Q9：NULL 用户应抛错';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 0, 10, 100000, 100, 10000000, 60);
    RAISE EXCEPTION 'FAIL Q9：零字节应抛错';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 0, 100000, 100, 10000000, 60);
    RAISE EXCEPTION 'FAIL Q9：零上限应抛错';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'PASS Q9：非法参数抛错（fail-closed）';
END $$;

-- ---------------------------------------------------------------------------
-- Q10 authenticated / anon 无权执行 RPC
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 10, 100000, 100, 10000000, 60);
    RAISE EXCEPTION 'FAIL Q10：authenticated 竟能执行预占 RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.transcribe_quota_reserve('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1000, 10, 100000, 100, 10000000, 60);
    RAISE EXCEPTION 'FAIL Q10：anon 竟能执行预占 RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  RAISE NOTICE 'PASS Q10：authenticated / anon 无权执行配额 RPC';
END $$;

-- ---------------------------------------------------------------------------
-- Q11 配额表对 authenticated / anon 不可读
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT count(*) INTO v_count FROM public.transcribe_quota_windows;
    RAISE EXCEPTION 'FAIL Q11：authenticated 竟能读取配额窗口表';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    SELECT count(*) INTO v_count FROM public.transcribe_quota_reservations;
    RAISE EXCEPTION 'FAIL Q11：authenticated 竟能读取预占表';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_count FROM public.transcribe_quota_windows;
    RAISE EXCEPTION 'FAIL Q11：anon 竟能读取配额窗口表';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    SELECT count(*) INTO v_count FROM public.transcribe_quota_reservations;
    RAISE EXCEPTION 'FAIL Q11：anon 竟能读取预占表';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  RAISE NOTICE 'PASS Q11：配额表对 authenticated / anon 不可读';
END $$;

-- ---------------------------------------------------------------------------
-- Q12 清理函数删除过期窗口与过期预占
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_deleted INT; v_old_win TIMESTAMPTZ; v_new_win TIMESTAMPTZ;
BEGIN
  DELETE FROM public.transcribe_quota_reservations;
  DELETE FROM public.transcribe_quota_windows;

  -- 构造一个很旧的窗口（10 个窗口周期前）和一个当前窗口
  v_old_win := to_timestamp((floor(extract(epoch FROM timezone('utc', now()))) / 60) * 60) - INTERVAL '10 minutes';
  v_new_win := to_timestamp((floor(extract(epoch FROM timezone('utc', now()))) / 60) * 60);

  INSERT INTO public.transcribe_quota_windows (scope, subject_id, window_start, req_count, byte_count)
  VALUES ('user', 'aaaaaaaa-0000-0000-0000-000000000001', v_old_win, 1, 100),
         ('user', 'aaaaaaaa-0000-0000-0000-000000000001', v_new_win, 1, 100);

  -- 构造一条很旧的预占记录（2 小时前）
  INSERT INTO public.transcribe_quota_reservations
    (reservation_id, user_id, bytes, window_start, status, created_at)
  VALUES (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 100, v_old_win, 'released',
          timezone('utc', now()) - INTERVAL '2 hours');

  v_deleted := public.transcribe_quota_cleanup(60, 2, 3600);
  IF v_deleted IS NULL OR v_deleted < 1 THEN
    RAISE EXCEPTION 'FAIL Q12：清理函数应至少删除 1 条过期记录（实际 %）', v_deleted;
  END IF;

  IF EXISTS (SELECT 1 FROM public.transcribe_quota_windows WHERE window_start = v_old_win) THEN
    RAISE EXCEPTION 'FAIL Q12：过期窗口未被清理';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.transcribe_quota_windows WHERE window_start = v_new_win) THEN
    RAISE EXCEPTION 'FAIL Q12：当前窗口不应被清理';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.transcribe_quota_reservations
    WHERE created_at < timezone('utc', now()) - INTERVAL '1 hour'
  ) THEN
    RAISE EXCEPTION 'FAIL Q12：过期预占记录未被清理';
  END IF;

  RAISE NOTICE 'PASS Q12：清理函数删除过期窗口与过期预占，保留当前数据';
END $$;

-- 清理
DELETE FROM public.transcribe_quota_reservations;
DELETE FROM public.transcribe_quota_windows;

ROLLBACK;

\echo '=== Batch B 配额集成测试全部通过 ==='
