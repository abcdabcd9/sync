-- --- START OF FILE supabase/migrations/30_收紧好友关系授权_fix_friends_authorization.sql ---
-- ============================================================================
-- P1 R0 / 工作包 A / S1 — 好友关系授权链完整收紧（friends + friend_requests）
-- ============================================================================
-- 背景（S1 是一整条授权链，不是单点）：
--   S1-1 friends_insert_own           仅校验 auth.uid()=user_id，不校验 friend_id
--        → 任意登录用户可凭空建立「与任意人」的好友关系（绕过对方同意）。
--   S1-2 friends_update_participants  USING/WITH CHECK 允许 auth.uid()=friend_id
--        → 可改写 user_id/friend_id（关系「过户」给第三方）；
--        → 且可修改「对方名下」那一行的 remark（他人私密备注被篡改）。
--   S1-3 friend_requests_insert_own   未限制 status 初值
--        → 可直插 status='accepted' 绕过接收方确认。
--   S1-4 friend_requests_update_receiver 未限制合法状态迁移、未锁定身份列
--        → 可置为任意字符串；已处理请求可被任意回退/重新接受。
--   S1-5 身份字段不可变                无触发器
--        → friends.user_id/friend_id、friend_requests.sender_id/receiver_id 可被 UPDATE 改写。
--   S1-6 合法状态集合                  status TEXT 无 CHECK
--        → 任意字符串可写入。
--
-- 修复策略（保留旧客户端直插，不采用 RPC-only）：
--   * 不撤销 authenticated 对 friends / friend_requests 的 INSERT/UPDATE 权限；
--   * 用「RLS 加 EXISTS 校验 + 不可变/迁移触发器 + 状态 CHECK」收紧；
--   * 旧客户端行为（发请求 / 接受 / 设备注 / 删好友）全部保持可用。
--
-- 旧客户端调用形态（已逐条核对源码）：
--   * 发请求：src/app/chat/search.js:107-109
--       insert({ sender_id: me, receiver_id: target })  // 不传 status → DEFAULT 'pending'
--   * 接受：  src/app/chat/contacts.js:29-38
--       update friend_requests set status='accepted' where id=? and receiver_id=me
--       insert friends({ user_id: me, friend_id: sender })
--   * 拒绝：  src/app/chat/contacts.js:53-57  → DELETE（不改 status）
--   * 备注：  src/hooks/chat/useFriendActions.js:87-122
--       update friends set remark where user_id=me and friend_id=?  （仅我方行）
--       命中 0 行时先校验合法关系，再 upsert({ user_id: me, friend_id: ?, remark })
--   * 删好友：src/hooks/chat/useFriendActions.js:28-44  → DELETE（双向）
--
-- 幂等性：DROP POLICY IF EXISTS / DROP TRIGGER IF EXISTS / CREATE OR REPLACE FUNCTION /
--         DO 块内判断约束是否存在，可重复执行。
--
-- 安全：本迁移不输出任何密钥；不触碰生产库；仅在 Sync-Dev 验证。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 历史数据审计与最小清洗（不做无条件批量覆盖）
-- ---------------------------------------------------------------------------
-- 0.1 friend_requests.status 为 NULL 的行：DEFAULT 是 'pending'，NULL 属异常缺省。
--     仅将 NULL 归一为 'pending'（精确范围、可审计、可回滚），并记录条数。
DO $$
DECLARE
  v_null_cnt INT;
BEGIN
  SELECT count(*) INTO v_null_cnt FROM public.friend_requests WHERE status IS NULL;
  IF v_null_cnt > 0 THEN
    RAISE NOTICE '[mig30] friend_requests: % 行 status 为 NULL，归一为 pending', v_null_cnt;
    UPDATE public.friend_requests SET status = 'pending' WHERE status IS NULL;
  END IF;
END $$;

-- 0.2 统计非法状态（非 NULL 且不在合法集合内）：只统计、不覆盖，登记为已知残留。
DO $$
DECLARE
  v_bad_req INT;
  v_bad_frd INT;
BEGIN
  SELECT count(*) INTO v_bad_req
    FROM public.friend_requests
   WHERE status IS NOT NULL AND status NOT IN ('pending','accepted','rejected');
  IF v_bad_req > 0 THEN
    RAISE NOTICE '[mig30] friend_requests: % 行非法 status（保留原值，CHECK 以 NOT VALID 方式仅约束新写入）', v_bad_req;
  END IF;

  SELECT count(*) INTO v_bad_frd
    FROM public.friends
   WHERE status IS NOT NULL AND status NOT IN ('accepted','pending','blocked','rejected');
  IF v_bad_frd > 0 THEN
    RAISE NOTICE '[mig30] friends: % 行非法 status（保留原值，CHECK 以 NOT VALID 方式仅约束新写入）', v_bad_frd;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. friends — 重建全部策略（先删所有历史命名，杜绝 PERMISSIVE OR 叠加绕过）
-- ---------------------------------------------------------------------------
ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friends_select_participants" ON public.friends;
DROP POLICY IF EXISTS "friends_insert_own"          ON public.friends;
DROP POLICY IF EXISTS "friends_update_participants" ON public.friends;
DROP POLICY IF EXISTS "friends_delete_participants" ON public.friends;
-- 历史中文/旧英文命名（迁移 06/08 曾出现），一并清理
DROP POLICY IF EXISTS "Users can view their friends." ON public.friends;
DROP POLICY IF EXISTS "查看自己的好友"               ON public.friends;
DROP POLICY IF EXISTS "Users can add friends."       ON public.friends;
DROP POLICY IF EXISTS "添加好友记录"                 ON public.friends;

-- SELECT：双方均可读（A 需要看到 B 名下那一行）
CREATE POLICY "friends_select_participants"
ON public.friends
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR auth.uid() = friend_id);

-- INSERT（S1-1）：只能以自己为 user_id，且必须存在「已确立的合法关系」。
--   合法关系来源（任一成立即可，避免误伤旧客户端正常路径）：
--     (a) 存在「双方已接受」的好友请求（contacts.js 接受后直插 friends 的主路径）；
--     (b) 已存在「反方向」的 friends 行（对方先建立、我方补建自己视角行；
--         useFriendActions.updateRemark 的 UPSERT 补建路径，且 deleteFriend 会
--         删除 accepted 请求，故不能只依赖 (a)）。
--   两者都要求 friend_id <> user_id，杜绝自建关系与凭空建立关系。
CREATE POLICY "friends_insert_own"
ON public.friends
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND friend_id <> user_id
  AND (
    -- (a) 双方已接受的好友请求
    EXISTS (
      SELECT 1
        FROM public.friend_requests fr
       WHERE fr.status = 'accepted'
         AND (
           (fr.sender_id = auth.uid() AND fr.receiver_id = friends.friend_id)
           OR
           (fr.receiver_id = auth.uid() AND fr.sender_id = friends.friend_id)
         )
    )
    -- (b) 已存在反方向的合法好友行（对方视角已建立）
    OR EXISTS (
      SELECT 1
        FROM public.friends f2
       WHERE f2.user_id = friends.friend_id
         AND f2.friend_id = auth.uid()
    )
  )
);

-- UPDATE（S1-2 + 私密备注保护）：仅允许更新「我方视角」那一行（user_id = 我）。
--   收紧理由：remark 是「个人视角」数据，每方向各一行；
--   原策略允许 auth.uid()=friend_id 更新「对方名下」那一行 → 可篡改他人私密备注。
--   旧客户端 updateRemark 只写 user_id=me 的行，故完全兼容。
--   身份列不可变由 §3 触发器兜底（RLS 无法表达「列不可变」）。
CREATE POLICY "friends_update_own_view"
ON public.friends
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- DELETE：双向解除（deleteFriend 用 or(user_id, friend_id) 双向删除）
CREATE POLICY "friends_delete_participants"
ON public.friends
FOR DELETE
TO authenticated
USING (auth.uid() = user_id OR auth.uid() = friend_id);

-- ---------------------------------------------------------------------------
-- 2. friend_requests — 重建全部策略
-- ---------------------------------------------------------------------------
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friend_requests_select_participants" ON public.friend_requests;
DROP POLICY IF EXISTS "friend_requests_insert_own"          ON public.friend_requests;
DROP POLICY IF EXISTS "friend_requests_update_receiver"     ON public.friend_requests;
DROP POLICY IF EXISTS "friend_requests_delete_participants" ON public.friend_requests;
-- 历史中文/旧英文命名（迁移 08 曾出现），一并清理
DROP POLICY IF EXISTS "Enable all for friend_requests" ON public.friend_requests;
DROP POLICY IF EXISTS "处理收到的请求"                 ON public.friend_requests;
DROP POLICY IF EXISTS "查看自己的请求"                 ON public.friend_requests;
DROP POLICY IF EXISTS "发送请求"                       ON public.friend_requests;
DROP POLICY IF EXISTS "删除请求"                       ON public.friend_requests;

-- SELECT：收发双方可读
CREATE POLICY "friend_requests_select_participants"
ON public.friend_requests
FOR SELECT
TO authenticated
USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- INSERT（S1-3）：只能以自己为 sender_id，禁止自请求，status 初值必须为 pending。
--   旧客户端不传 status → DEFAULT 'pending'，WITH CHECK 在默认值应用后求值，成立。
CREATE POLICY "friend_requests_insert_own"
ON public.friend_requests
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = sender_id
  AND sender_id <> receiver_id
  AND status = 'pending'
);

-- UPDATE（S1-4）：仅接收方可处理；USING 校验 OLD.status='pending'（只能处理待处理请求），
--   WITH CHECK 校验 NEW.status ∈ {accepted,rejected}（合法迁移）。
--   「已处理请求不可回退/重新接受」由 §4 迁移触发器兜底（RLS 无法完整表达 OLD→NEW 语义）。
CREATE POLICY "friend_requests_update_receiver"
ON public.friend_requests
FOR UPDATE
TO authenticated
USING (auth.uid() = receiver_id AND status = 'pending')
WITH CHECK (auth.uid() = receiver_id AND status IN ('accepted','rejected'));

-- DELETE：收发双方可删（旧客户端「拒绝」走 DELETE）
CREATE POLICY "friend_requests_delete_participants"
ON public.friend_requests
FOR DELETE
TO authenticated
USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- ---------------------------------------------------------------------------
-- 3. 身份字段不可变触发器（S1-5）
-- ---------------------------------------------------------------------------
-- friends：user_id / friend_id 不可变
CREATE OR REPLACE FUNCTION public.friends_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.friend_id IS DISTINCT FROM OLD.friend_id THEN
    RAISE EXCEPTION 'friends 身份列不可变（user_id/friend_id）'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS friends_guard_update_trg ON public.friends;
CREATE TRIGGER friends_guard_update_trg
  BEFORE UPDATE ON public.friends
  FOR EACH ROW
  EXECUTE FUNCTION public.friends_guard_update();

-- friend_requests：sender_id / receiver_id 不可变 + 合法状态迁移（S1-4/S1-5）
CREATE OR REPLACE FUNCTION public.friend_requests_guard_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_is_server BOOLEAN := current_user IN ('postgres','supabase_admin','service_role');
BEGIN
  -- 身份列永远不可变（含服务端，避免破坏引用完整性）
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'friend_requests 身份列不可变（sender_id/receiver_id）'
      USING ERRCODE = '42501';
  END IF;

  -- 状态迁移：仅允许 pending -> accepted / rejected；已处理请求不可回退/重新接受。
  --   服务端（postgres/supabase_admin/service_role）允许维护性修正。
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_is_server THEN
    IF NOT (OLD.status = 'pending' AND NEW.status IN ('accepted','rejected')) THEN
      RAISE EXCEPTION 'friend_requests 非法状态迁移：% -> %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS friend_requests_guard_update_trg ON public.friend_requests;
CREATE TRIGGER friend_requests_guard_update_trg
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.friend_requests_guard_update();

-- ---------------------------------------------------------------------------
-- 4. 合法状态集合 CHECK（S1-6，NOT VALID：仅约束新写入，不覆盖历史非法值）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'friend_requests_status_check'
       AND conrelid = 'public.friend_requests'::regclass
  ) THEN
    ALTER TABLE public.friend_requests
      ADD CONSTRAINT friend_requests_status_check
      CHECK (status IN ('pending','accepted','rejected')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'friends_status_check'
       AND conrelid = 'public.friends'::regclass
  ) THEN
    ALTER TABLE public.friends
      ADD CONSTRAINT friends_status_check
      CHECK (status IN ('accepted','pending','blocked','rejected')) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. 自检（执行后手动核对，不自动运行）
-- ---------------------------------------------------------------------------
-- 5.1 列出 friends / friend_requests 全部策略（应各 4 条，无 USING(true)）：
--   SELECT tablename, policyname, cmd, qual, with_check
--     FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('friends','friend_requests')
--    ORDER BY tablename, cmd;
--
-- 5.2 列出触发器（应含 friends_guard_update_trg / friend_requests_guard_update_trg）：
--   SELECT tgname, tgrelid::regclass
--     FROM pg_trigger
--    WHERE NOT tgisinternal
--      AND tgrelid IN ('public.friends'::regclass,'public.friend_requests'::regclass);
--
-- 5.3 列出 CHECK 约束（NOT VALID 的 convalidated=false）：
--   SELECT conname, convalidated
--     FROM pg_constraint
--    WHERE conrelid IN ('public.friends'::regclass,'public.friend_requests'::regclass)
--      AND contype='c';

-- --- END OF FILE supabase/migrations/30_收紧好友关系授权_fix_friends_authorization.sql ---
