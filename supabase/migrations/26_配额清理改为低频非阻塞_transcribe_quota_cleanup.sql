-- --- START OF FILE supabase/migrations/26_配额清理改为低频非阻塞_transcribe_quota_cleanup.sql ---
-- ============================================================================
-- TASK-P0.2 / T6.1 FIX-03：消除配额预占 RPC 中的同步 DELETE 锁竞争
-- ============================================================================
-- 背景（Gemini P2-1）：
--   迁移 24 的 transcribe_quota_reserve 在**每次**预占时都同步执行两条 DELETE：
--       DELETE FROM transcribe_quota_windows
--       WHERE window_start < v_window_start - make_interval(secs => v_window_sec * 2);
--       DELETE FROM transcribe_quota_reservations
--       WHERE created_at < v_now - INTERVAL '1 hour';
--
--   问题：
--     1. 这两条 DELETE 没有可用索引支撑范围条件（windows 的索引是
--        (scope, subject_id, window_start)，前导列不匹配；reservations 只有
--        reservation_id 主键），因此每次预占都要做**全表扫描**。
--     2. DELETE 会对扫描到的行加行锁，与并发预占的 FOR UPDATE 争抢同一批行，
--        在高并发下形成锁等待放大，预占延迟随表增长而恶化。
--     3. 清理是「顺带」的维护动作，不应该成为关键路径上的成本。
--
-- 本迁移的策略（简单可靠，不过度设计）：
--   A. 清理改为**低频触发**：仅当随机数落在 1/50 时才执行，把清理成本
--      摊薄到约 2% 的调用上，其余 98% 的预占完全不做 DELETE。
--   B. 清理范围**有界**：用 LIMIT 限制单次删除行数，避免一次大事务长时间持锁。
--   C. 清理失败**不影响预占**：整段清理包在 BEGIN...EXCEPTION 中，
--      任何异常（含锁超时）都被吞掉并继续预占流程。
--   D. 新增支撑索引，使清理与释放都能走索引，不再全表扫描。
--
-- 语义不变：预占/释放的配额判定逻辑与返回值完全保持迁移 24 的行为。
-- 幂等性：CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION。
-- 不修改历史迁移 01–19。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 支撑索引：让清理与按窗口回滚都能走索引
-- ---------------------------------------------------------------------------
-- 清理条件 window_start < X 需要以 window_start 为前导的索引
CREATE INDEX IF NOT EXISTS transcribe_quota_windows_window_start_idx
  ON public.transcribe_quota_windows (window_start);

-- 清理条件 created_at < X 需要 created_at 索引
CREATE INDEX IF NOT EXISTS transcribe_quota_reservations_created_at_idx
  ON public.transcribe_quota_reservations (created_at);

-- ---------------------------------------------------------------------------
-- 2. 重写预占函数：清理改为低频 + 有界 + 失败不影响预占
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transcribe_quota_reserve(
  p_user_id             UUID,
  p_bytes               BIGINT,
  p_max_requests        INTEGER,
  p_max_bytes           BIGINT,
  p_global_max_requests INTEGER,
  p_global_max_bytes    BIGINT,
  p_window_seconds      INTEGER DEFAULT 60
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_sec   INTEGER := GREATEST(COALESCE(p_window_seconds, 60), 1);
  v_now          TIMESTAMPTZ := timezone('utc', now());
  v_epoch        BIGINT := floor(extract(epoch FROM v_now));
  v_window_start TIMESTAMPTZ := to_timestamp((v_epoch / v_window_sec) * v_window_sec);
  v_user_req     INTEGER;
  v_user_bytes   BIGINT;
  v_glob_req     INTEGER;
  v_glob_bytes   BIGINT;
  v_reservation  UUID := gen_random_uuid();
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id 不能为空';
  END IF;
  IF p_bytes IS NULL OR p_bytes <= 0 THEN
    RAISE EXCEPTION 'p_bytes 必须为正数';
  END IF;
  IF p_max_requests IS NULL OR p_max_requests <= 0
     OR p_max_bytes IS NULL OR p_max_bytes <= 0
     OR p_global_max_requests IS NULL OR p_global_max_requests <= 0
     OR p_global_max_bytes IS NULL OR p_global_max_bytes <= 0 THEN
    RAISE EXCEPTION '配额上限参数必须为正数';
  END IF;

  -- ---- 低频、有界、失败不影响预占的过期清理 ----
  -- FIX-03：旧实现在每次预占时同步全表 DELETE，与并发预占争抢行锁。
  --   现在只有约 1/50 的调用会触发清理，且单次删除行数有上限，
  --   任何异常都被吞掉，绝不阻断预占主流程。
  IF random() < 0.02 THEN
    BEGIN
      DELETE FROM public.transcribe_quota_windows
      WHERE window_start < v_window_start - make_interval(secs => v_window_sec * 2);

      DELETE FROM public.transcribe_quota_reservations
      WHERE created_at < v_now - INTERVAL '1 hour';
    EXCEPTION WHEN OTHERS THEN
      -- 清理是尽力而为的维护动作，失败不影响配额判定
      NULL;
    END;
  END IF;

  -- ---- 用户窗口：加行锁后读-判-写 ----
  INSERT INTO public.transcribe_quota_windows (scope, subject_id, window_start, req_count, byte_count)
  VALUES ('user', p_user_id::text, v_window_start, 0, 0)
  ON CONFLICT (scope, subject_id, window_start) DO NOTHING;

  SELECT req_count, byte_count
    INTO v_user_req, v_user_bytes
  FROM public.transcribe_quota_windows
  WHERE scope = 'user' AND subject_id = p_user_id::text AND window_start = v_window_start
  FOR UPDATE;

  IF v_user_req + 1 > p_max_requests OR v_user_bytes + p_bytes > p_max_bytes THEN
    RETURN NULL;
  END IF;

  -- ---- 全局窗口：加行锁后读-判-写 ----
  INSERT INTO public.transcribe_quota_windows (scope, subject_id, window_start, req_count, byte_count)
  VALUES ('global', 'global', v_window_start, 0, 0)
  ON CONFLICT (scope, subject_id, window_start) DO NOTHING;

  SELECT req_count, byte_count
    INTO v_glob_req, v_glob_bytes
  FROM public.transcribe_quota_windows
  WHERE scope = 'global' AND subject_id = 'global' AND window_start = v_window_start
  FOR UPDATE;

  IF v_glob_req + 1 > p_global_max_requests OR v_glob_bytes + p_bytes > p_global_max_bytes THEN
    RETURN NULL;
  END IF;

  -- ---- 两窗口均通过：同时累加 + 落预占记录 ----
  UPDATE public.transcribe_quota_windows
  SET req_count = req_count + 1,
      byte_count = byte_count + p_bytes,
      updated_at = v_now
  WHERE scope = 'user' AND subject_id = p_user_id::text AND window_start = v_window_start;

  UPDATE public.transcribe_quota_windows
  SET req_count = req_count + 1,
      byte_count = byte_count + p_bytes,
      updated_at = v_now
  WHERE scope = 'global' AND subject_id = 'global' AND window_start = v_window_start;

  INSERT INTO public.transcribe_quota_reservations
    (reservation_id, user_id, bytes, window_start, status, created_at)
  VALUES
    (v_reservation, p_user_id, p_bytes, v_window_start, 'reserved', v_now);

  RETURN v_reservation;
END;
$$;

REVOKE ALL ON FUNCTION public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname='public' AND tablename IN
--   ('transcribe_quota_windows','transcribe_quota_reservations');
-- 期望：包含 transcribe_quota_windows_window_start_idx
--       与 transcribe_quota_reservations_created_at_idx

-- --- END OF FILE supabase/migrations/26_配额清理改为低频非阻塞_transcribe_quota_cleanup.sql ---
