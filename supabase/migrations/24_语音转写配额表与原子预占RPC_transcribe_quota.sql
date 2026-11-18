-- ===========================================================================
-- 24 语音转写配额表与原子预占 RPC
--
-- 背景：
--   transcribe-audio Edge Function 在调用上游（Groq）之前，必须先在数据库内
--   原子地预占配额，防止单用户刷量、全局预算被击穿、并发绕过限额。
--
-- T6/B01 修订要点（相对 T4 版本）：
--   1. 配额语义从「成功计数」改为「尝试计数」。
--      每一次真正发往上游的调用尝试（含重试、含结果不确定的超时）都必须
--      计入预算，否则重试与不确定失败会击穿预算控制。
--   2. 预占改为「唯一预占 id」模型：
--        - 每次 reserve 生成一个 reservation_id（UUID），写入
--          transcribe_quota_reservations 表；
--        - 计数表 transcribe_quota_windows 只做累加，不再依赖调用方回传字节数；
--        - release 必须携带 reservation_id，且只能释放一次（幂等），
--          重复释放 / 伪造 id 一律无副作用。
--   3. 跨窗口安全：reservation 记录其所属窗口起点，release 只回滚该窗口，
--      不会误伤新窗口的计数。
--   4. 清理机制：过期窗口与过期 reservation 在 reserve 时顺带清理，
--      并有独立清理函数供定时任务调用。
--   5. 权限：表/函数仅 service_role；authenticated / anon 一律无权。
--   6. fail-closed：任何异常（表缺失、锁超时、参数非法）都返回 false 或抛错，
--      Edge Function 侧一律按「配额不可用 → 拒绝转写」处理。
--
-- 本迁移提供：
--   - transcribe_quota_windows        配额窗口计数表（按 scope + subject + 窗口起点）
--   - transcribe_quota_reservations   预占记录表（唯一 reservation_id，幂等释放依据）
--   - transcribe_quota_reserve        原子预占（用户窗口 + 全局窗口同时校验），返回 reservation_id
--   - transcribe_quota_release        按 reservation_id 幂等回滚
--   - transcribe_quota_cleanup        清理过期窗口与过期预占记录
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. 配额窗口计数表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transcribe_quota_windows (
  scope        TEXT        NOT NULL,          -- 'user' | 'global'
  subject_id   TEXT        NOT NULL,          -- user_id 或固定 'global'
  window_start TIMESTAMPTZ NOT NULL,
  req_count    INTEGER     NOT NULL DEFAULT 0,
  byte_count   BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT transcribe_quota_windows_pkey PRIMARY KEY (scope, subject_id, window_start),
  CONSTRAINT transcribe_quota_windows_scope_check CHECK (scope IN ('user', 'global')),
  CONSTRAINT transcribe_quota_windows_nonneg CHECK (req_count >= 0 AND byte_count >= 0)
);

CREATE INDEX IF NOT EXISTS transcribe_quota_windows_start_idx
  ON public.transcribe_quota_windows (window_start);

ALTER TABLE public.transcribe_quota_windows ENABLE ROW LEVEL SECURITY;

-- 不建任何策略：默认拒绝。仅 service_role 通过 GRANT 访问。
REVOKE ALL ON public.transcribe_quota_windows FROM PUBLIC;
REVOKE ALL ON public.transcribe_quota_windows FROM anon;
REVOKE ALL ON public.transcribe_quota_windows FROM authenticated;
GRANT ALL ON public.transcribe_quota_windows TO service_role;

-- ---------------------------------------------------------------------------
-- 2. 预占记录表（幂等释放依据）
--    status: 'reserved' | 'released'
--    记录窗口起点，保证 release 只回滚预占所属窗口。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transcribe_quota_reservations (
  reservation_id UUID        NOT NULL PRIMARY KEY,
  user_id        UUID        NOT NULL,
  bytes          BIGINT      NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'reserved',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  released_at    TIMESTAMPTZ,
  CONSTRAINT transcribe_quota_reservations_status_check
    CHECK (status IN ('reserved', 'released')),
  CONSTRAINT transcribe_quota_reservations_bytes_check CHECK (bytes > 0)
);

CREATE INDEX IF NOT EXISTS transcribe_quota_reservations_created_idx
  ON public.transcribe_quota_reservations (created_at);

CREATE INDEX IF NOT EXISTS transcribe_quota_reservations_user_idx
  ON public.transcribe_quota_reservations (user_id, created_at);

ALTER TABLE public.transcribe_quota_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.transcribe_quota_reservations FROM PUBLIC;
REVOKE ALL ON public.transcribe_quota_reservations FROM anon;
REVOKE ALL ON public.transcribe_quota_reservations FROM authenticated;
GRANT ALL ON public.transcribe_quota_reservations TO service_role;

-- ---------------------------------------------------------------------------
-- 3. 原子预占
--    返回 UUID = 预占成功，调用方必须保存该 id 以便失败时释放
--    返回 NULL = 用户或全局配额已满
--    抛错      = 参数非法 / 存储异常（调用方按 fail-closed 处理）
-- ---------------------------------------------------------------------------
-- T6/B01：返回类型由 BOOLEAN 改为 UUID，CREATE OR REPLACE 无法变更返回类型，
-- 必须先 DROP。签名与旧版完全一致，DROP 后立即重建，不影响已授权角色。
DROP FUNCTION IF EXISTS public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER);

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

  -- 顺带清理过期窗口（保留最近 2 个窗口，避免表无限增长）
  DELETE FROM public.transcribe_quota_windows
  WHERE window_start < v_window_start - make_interval(secs => v_window_sec * 2);

  -- 顺带清理过期预占记录（保留最近 1 小时，避免表无限增长）
  DELETE FROM public.transcribe_quota_reservations
  WHERE created_at < v_now - INTERVAL '1 hour';

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

-- ---------------------------------------------------------------------------
-- 4. 幂等释放
--    仅当 reservation 存在、属于该用户、且状态为 'reserved' 时才回滚，
--    并把状态置为 'released'。重复调用 / 伪造 id / 跨用户 id 均无副作用。
--    绝不因释放失败而抛错给调用方（尽力而为）。
-- ---------------------------------------------------------------------------
-- T6/B01：释放签名由 (uuid, bigint, integer) 改为 (uuid, uuid)，同样需先 DROP。
DROP FUNCTION IF EXISTS public.transcribe_quota_release(UUID, BIGINT, INTEGER);

CREATE OR REPLACE FUNCTION public.transcribe_quota_release(
  p_reservation_id UUID,
  p_user_id        UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bytes        BIGINT;
  v_window_start TIMESTAMPTZ;
  v_now          TIMESTAMPTZ := timezone('utc', now());
BEGIN
  IF p_reservation_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- 原子地把 reserved → released，只有抢到状态迁移的调用者才回滚计数
  UPDATE public.transcribe_quota_reservations
  SET status = 'released',
      released_at = v_now
  WHERE reservation_id = p_reservation_id
    AND user_id = p_user_id
    AND status = 'reserved'
  RETURNING bytes, window_start INTO v_bytes, v_window_start;

  IF v_bytes IS NULL THEN
    -- 不存在 / 已释放 / 不属于该用户 → 幂等无副作用
    RETURN false;
  END IF;

  UPDATE public.transcribe_quota_windows
  SET req_count = GREATEST(req_count - 1, 0),
      byte_count = GREATEST(byte_count - v_bytes, 0),
      updated_at = v_now
  WHERE scope = 'user' AND subject_id = p_user_id::text AND window_start = v_window_start;

  UPDATE public.transcribe_quota_windows
  SET req_count = GREATEST(req_count - 1, 0),
      byte_count = GREATEST(byte_count - v_bytes, 0),
      updated_at = v_now
  WHERE scope = 'global' AND subject_id = 'global' AND window_start = v_window_start;

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. 清理函数（供定时任务调用；reserve 内部也会顺带清理）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transcribe_quota_cleanup(
  p_window_seconds INTEGER DEFAULT 60,
  p_keep_windows   INTEGER DEFAULT 2,
  p_keep_reservations_seconds INTEGER DEFAULT 3600
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_sec INTEGER := GREATEST(COALESCE(p_window_seconds, 60), 1);
  v_keep_win   INTEGER := GREATEST(COALESCE(p_keep_windows, 2), 1);
  v_keep_res   INTEGER := GREATEST(COALESCE(p_keep_reservations_seconds, 3600), 60);
  v_now        TIMESTAMPTZ := timezone('utc', now());
  v_epoch      BIGINT := floor(extract(epoch FROM v_now));
  v_window_start TIMESTAMPTZ := to_timestamp((v_epoch / v_window_sec) * v_window_sec);
  v_deleted    INTEGER := 0;
BEGIN
  DELETE FROM public.transcribe_quota_windows
  WHERE window_start < v_window_start - make_interval(secs => v_window_sec * v_keep_win);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.transcribe_quota_reservations
  WHERE created_at < v_now - make_interval(secs => v_keep_res);

  RETURN v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. 权限：仅 service_role
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transcribe_quota_reserve(UUID, BIGINT, INTEGER, BIGINT, INTEGER, BIGINT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.transcribe_quota_release(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transcribe_quota_release(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.transcribe_quota_release(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transcribe_quota_release(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.transcribe_quota_cleanup(INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transcribe_quota_cleanup(INTEGER, INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.transcribe_quota_cleanup(INTEGER, INTEGER, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transcribe_quota_cleanup(INTEGER, INTEGER, INTEGER) TO service_role;
