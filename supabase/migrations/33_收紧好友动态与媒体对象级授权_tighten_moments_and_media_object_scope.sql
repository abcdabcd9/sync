-- --- START OF FILE supabase/migrations/33_收紧好友动态与媒体对象级授权_tighten_moments_and_media_object_scope.sql ---
-- ============================================================================
-- P1 R1 / 集中返工 — 修复 GPT-R0-01（好友动态授权）与 GPT-R0-05（媒体对象级授权）
-- 版本：v4（最终执行前集中修正，未执行到任何远端库）
-- ============================================================================
-- 背景（R1 独立裁决结论，见 .internal/refactor/tasks/TASK-P1.0/R1_ADJUDICATION.md）：
--
--   R1-D1（GPT-R0-01，BLOCKER）：
--     · 迁移 06 的 moments_select_visible 的 friends 分支只判断「存在 friends 行」，
--       完全不校验 f.status；
--     · 迁移 07 中 friends.status 默认 'accepted'，因此任何新建/历史遗留的 friends 行
--       默认即视为「已接受好友」；
--     · 迁移 30 的 friends_insert_own 分支 (b) 允许「只要存在反方向一行」即可补建自己视角行，
--       而该反方向行可能来自历史伪造数据。
--     → 历史伪造/非法 friends 行仍可读取他人 friends-only 动态。
--
--   R1-D5（GPT-R0-05，MAJOR）：
--     · 迁移 31 的 chat_media_participants_select 分支 ③ 以
--         (storage.foldername(name))[1] = m.user_id::text
--       做命名空间闸门，但对象匹配仍用 `m.media_url LIKE '%/' || name` 后缀匹配。
--       只要「我」与发送方存在任意一条 messages 行，该发送方命名空间内的**其他对象**
--       也可能被后缀匹配命中 → 命名空间级授权宽于对象级授权。
--
-- ============================================================================
-- v4 修正要点（GPT 最终执行前审查意见，逐条落实）
-- ============================================================================
--
-- 【SQL-01】不可信的好友确认时间 → 改用 DB 受保护的「接受事件」凭证
--   问题（GPT 指出，已核实）：
--     · v2/v3 用 `friend_requests.created_at >= p1_trusted_friend_since()` 作为可信判据；
--     · 但迁移 30 之前的 INSERT 策略**不约束 created_at**（客户端可任意填写），
--       且历史行可被直接写成 status='accepted'；
--     · 因此「created_at 晚于某时间点」**不能**证明关系真实 —— 伪造者只需把
--       created_at 填成未来时间即可绕过。这是 v2/v3 的根本缺陷。
--   修正（不再依赖任何客户端可写字段）：
--     · 新增表 public.friend_accept_events，记录「接收方真实接受请求」这一事件；
--     · 由 BEFORE UPDATE 触发器在 `pending -> accepted` 迁移时写入，
--       accepted_at 取**服务端 now()**，sender/receiver 取 OLD 行（身份列不可变）；
--     · 该表 RLS 开启且**不授予 authenticated 任何 INSERT/UPDATE/DELETE 策略**，
--       仅 SECURITY DEFINER 触发器函数（以表 owner 身份）可写 → 客户端无法伪造/篡改；
--     · **不回填**任何历史 accepted 行 → 历史关系无事件凭证 → fail-closed；
--     · 授权判据改为「可信事件 + 当前至少一条 accepted 好友行」，
--       与 created_at 无关；好友删除会撤销凭证。
--   → 满足：不依赖用户可控字段；凭证来源真实可信；不可客户端伪造；不回填历史；
--     历史不可证关系继续 fail-closed。
--
-- 【SQL-02】正常好友的单行兼容性 → 授权只依赖「接受事件」，不要求双向 friends 行
--   问题（GPT 指出，已核实）：
--     · 真实客户端 contacts.js 接受请求后**只插入一行** friends
--       `{ user_id: 接收方, friend_id: 发送方 }`；
--     · v2/v3 的 moments 策略要求「双向对称 friends 行同时存在」→ 正常接受后
--       只有一行 → 读不到 friends-only 动态（误伤合法好友）。
--   修正：
--     · moments 授权改为「存在可信接受事件（sender/receiver 与双方一致）」，
--       **不再要求 friends 行数量或方向**；
--     · friends_insert_own 同样只要求「存在可信接受事件」；
--     · 接受事件由接收方真实 UPDATE 产生，天然证明「双方同意」；
--     · 历史伪造 friends 行（无事件）仍不可用 → 不重新放行伪造关系。
--   → 满足：单行即可正常访问；不手工预插第二行；授权可证明同意；删除即时撤销。
--
-- 【SQL-02 媒体】严格对象级精确匹配（沿用 v3 结论，不变）
--   事实基础（已核实）：
--     · chat_media 对象真实路径为 `<uid>/<filename>`，包含 '/'；
--     · 迁移 02 已把所有历史完整 URL 回填为相对路径；
--     · 迁移 21 的 messages_guard_media_ownership 触发器禁止写入首段非 user_id 的 media_url；
--     → messages.media_url / thumbnail_url 不可能是完整 URL；「历史全 URL 兼容」是伪需求。
--   → 仅 `m.media_url = storage.objects.name` / `m.thumbnail_url = storage.objects.name`
--     精确匹配 + 命名空间闸门，无任何 LIKE，无通配符放大风险。
--
-- 兼容性（已核实）：
--   · 旧客户端接受好友：contacts.js 先 update friend_requests.status='accepted'
--     （触发接受事件写入），再 insert friends（单行）→ 事件已存在 → 授权成立。
--   · 旧客户端设备注：useFriendActions.updateRemark 先 UPDATE 我方行；命中 0 行时
--     校验「任一方向 friends 行」后 UPSERT。若反方向行是历史伪造行，R1 后将被拒绝
--     （这正是要关闭的伪造路径）；正常好友（有接受事件）不受影响。
--   · 媒体读取：useSignedMediaUrl 走 createSignedUrl，对象名即 messages.media_url
--     的相对路径，精确匹配成立。
--
-- 幂等性：DROP POLICY IF EXISTS / DROP TRIGGER IF EXISTS / CREATE TABLE IF NOT EXISTS /
--         CREATE OR REPLACE FUNCTION / CREATE INDEX IF NOT EXISTS。
-- 安全：不输出密钥；不触碰生产库；仅在本地隔离库验证。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 可信凭证：friend_accept_events（DB 受保护的「接受事件」）
-- ---------------------------------------------------------------------------
-- 设计要点：
--   · 只记录「接收方把 pending 请求改为 accepted」这一真实事件；
--   · accepted_at 由服务端 now() 写入，客户端不可指定；
--   · 表 RLS 开启，且**不创建任何 authenticated 的写策略** → 客户端无法 INSERT/UPDATE/DELETE；
--   · 触发器函数 SECURITY DEFINER，以表 owner 身份写入，绕过 RLS；
--   · 不回填历史数据。
CREATE TABLE IF NOT EXISTS public.friend_accept_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id    uuid NOT NULL,
  receiver_id  uuid NOT NULL,
  request_id   uuid,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friend_accept_events_pair_chk CHECK (sender_id <> receiver_id)
);

-- 同一对 (sender,receiver) 只保留一条事件即可（幂等去重，避免重复接受产生多条）。
CREATE UNIQUE INDEX IF NOT EXISTS friend_accept_events_pair_key
  ON public.friend_accept_events (sender_id, receiver_id);

-- 反向查询索引（按接收方/发送方任一方向命中）
CREATE INDEX IF NOT EXISTS friend_accept_events_receiver_idx
  ON public.friend_accept_events (receiver_id);
CREATE INDEX IF NOT EXISTS friend_accept_events_sender_idx
  ON public.friend_accept_events (sender_id);

ALTER TABLE public.friend_accept_events ENABLE ROW LEVEL SECURITY;

-- 读策略：仅事件双方可读（用于客户端/审计；不参与授权判定，授权走 SECURITY DEFINER 函数）。
DROP POLICY IF EXISTS "friend_accept_events_select_participants" ON public.friend_accept_events;
CREATE POLICY "friend_accept_events_select_participants"
ON public.friend_accept_events
FOR SELECT
TO authenticated
USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- 使用 INSERT 策略查事件时仅参与方应可读（RLS + 表级 SELECT）。
GRANT SELECT ON TABLE public.friend_accept_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.friend_accept_events FROM PUBLIC, anon, authenticated;

-- 注意：**故意不创建** INSERT/UPDATE/DELETE 策略。
--   RLS 开启且无写策略 → authenticated 的任何写操作都被拒绝；
--   只有 SECURITY DEFINER 触发器函数（owner 身份）可写入。

-- 触发器函数：在 friend_requests 由 pending 变为 accepted 时写入接受事件。
--   · SECURITY DEFINER：以函数 owner（迁移执行者，通常 postgres）身份运行，绕过 RLS；
--   · SET search_path：防止 search_path 注入；
--   · ON CONFLICT DO NOTHING：同一对重复接受不产生重复事件（幂等）。
CREATE OR REPLACE FUNCTION public.friend_requests_record_accept()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- 仅在「真实接受」迁移时记录：pending -> accepted
  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    INSERT INTO public.friend_accept_events (sender_id, receiver_id, request_id, accepted_at)
    VALUES (NEW.sender_id, NEW.receiver_id, NEW.id, now())
    ON CONFLICT (sender_id, receiver_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.friend_requests_record_accept() IS
  'P1 R1：记录接收方真实接受好友请求的事件（DB 受保护凭证，客户端不可伪造）。';

DROP TRIGGER IF EXISTS friend_requests_record_accept_trg ON public.friend_requests;
CREATE TRIGGER friend_requests_record_accept_trg
  AFTER UPDATE ON public.friend_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.friend_requests_record_accept();

-- 撤销事件：删除任意方向的好友行、删除已接受请求、或将好友状态从
-- accepted 降为其他状态，都必须立即使这对账号的历史接受凭证失效。
-- 仅检查 friends 行而不撤销事件是不够的：客户端可能凭旧事件重新 INSERT。
CREATE OR REPLACE FUNCTION public.p1_revoke_friend_accept_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  first_id uuid;
  second_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'friends' THEN
    first_id := OLD.user_id;
    second_id := OLD.friend_id;
  ELSIF TG_TABLE_NAME = 'friend_requests' THEN
    first_id := OLD.sender_id;
    second_id := OLD.receiver_id;
  ELSE
    RAISE EXCEPTION 'unexpected revocation source %', TG_TABLE_NAME;
  END IF;

  DELETE FROM public.friend_accept_events e
   WHERE (e.sender_id = first_id AND e.receiver_id = second_id)
      OR (e.sender_id = second_id AND e.receiver_id = first_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 两个方向中的任一好友行被删除，即视为双方授权已撤销。
DROP TRIGGER IF EXISTS p1_friends_revoke_on_delete_trg ON public.friends;
CREATE TRIGGER p1_friends_revoke_on_delete_trg
  AFTER DELETE ON public.friends
  FOR EACH ROW EXECUTE FUNCTION public.p1_revoke_friend_accept_event();

DROP TRIGGER IF EXISTS p1_friends_revoke_on_status_trg ON public.friends;
CREATE TRIGGER p1_friends_revoke_on_status_trg
  AFTER UPDATE OF status ON public.friends
  FOR EACH ROW
  WHEN (OLD.status = 'accepted' AND NEW.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION public.p1_revoke_friend_accept_event();

DROP TRIGGER IF EXISTS p1_requests_revoke_on_delete_trg ON public.friend_requests;
CREATE TRIGGER p1_requests_revoke_on_delete_trg
  AFTER DELETE ON public.friend_requests
  FOR EACH ROW
  WHEN (OLD.status = 'accepted')
  EXECUTE FUNCTION public.p1_revoke_friend_accept_event();

-- 授权判定辅助函数：判断「我」与某作者之间是否存在可信接受事件。
--   · SECURITY DEFINER：以 owner 身份读取 friend_accept_events（避免 RLS 递归/权限问题）；
--   · STABLE：同一语句内结果稳定，可被策略安全调用；
--   · 仅按 (sender,receiver) 双向匹配，与 created_at、friends 行数量无关。
CREATE OR REPLACE FUNCTION public.p1_has_trusted_friend_event(me uuid, other uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  -- SECURITY DEFINER 不得成为查询任意两个人关系的 RPC 侧信道。
  -- 同时要求「可信接受事件」和「至少一条当前 accepted 好友行」。
  -- 删除朋友时撤销触发器会移除事件，因此无法用旧凭证重新建行。
  SELECT me IS NOT NULL
     AND me = auth.uid()
     AND other IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.friend_accept_events e
       WHERE (e.sender_id = me AND e.receiver_id = other)
          OR (e.sender_id = other AND e.receiver_id = me)
     )
     AND EXISTS (
       SELECT 1 FROM public.friends f
       WHERE f.status = 'accepted'
         AND (
           (f.user_id = me AND f.friend_id = other)
           OR (f.user_id = other AND f.friend_id = me)
         )
     );
$$;

-- 默认 PUBLIC EXECUTE 对 SECURITY DEFINER 尤其危险；显式限制。
REVOKE ALL ON FUNCTION public.p1_has_trusted_friend_event(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p1_has_trusted_friend_event(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.p1_has_trusted_friend_event(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.p1_has_trusted_friend_event(uuid, uuid) IS
  'P1：仅当前登录者可查，需可信接受事件+当前有效好友行；删除立即撤销，禁止旧事件重插。';

-- ---------------------------------------------------------------------------
-- 1. R1-D1：moments_select_visible —— 基于可信接受事件（单行兼容）
-- ---------------------------------------------------------------------------
-- 仅当「我与作者之间存在可信接受事件，且当前仍有 accepted 好友行」时放行。
--   · 不要求双向 friends 行，单行即可（修复 SQL-02 单行兼容）；
--   · 不再依赖 created_at（修复 SQL-01 不可信时间）；
--   · 无事件 → 拒绝（fail-closed，历史伪造关系不可读）。
DROP POLICY IF EXISTS "moments_select_visible" ON public.moments;
CREATE POLICY "moments_select_visible"
ON public.moments
FOR SELECT
TO authenticated
USING (
  -- 作者本人始终可读
  auth.uid() = author_id
  -- 公开动态：所有人可读
  OR visibility = 'all'
  -- 好友可见：可信事件+现存好友行，删除则立即失效（fail-closed）
  OR (
    visibility = 'friends'
    AND public.p1_has_trusted_friend_event(auth.uid(), moments.author_id)
  )
);

-- ---------------------------------------------------------------------------
-- 2. R1-D1：friends_insert_own —— 仅凭可信接受事件放行
-- ---------------------------------------------------------------------------
-- 旧客户端接受主路径：先 update friend_requests.status='accepted'（产生事件），
-- 再 insert friends（单行）→ 事件已存在 → 放行。
-- 历史伪造反方向行（无事件）不再能补建自己视角行。
DROP POLICY IF EXISTS "friends_insert_own" ON public.friends;
CREATE POLICY "friends_insert_own"
ON public.friends
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND friend_id <> user_id
  -- INSERT 主路径先有接受事件、后创建第一条好友行。
  -- p1_has_trusted_friend_event 还要求现存行，不能用于这里的首次插入。
  -- 旧事件在好友删除时由 DB 触发器撤销，故无法用旧事件重建关系。
  AND EXISTS (
    SELECT 1 FROM public.friend_accept_events e
    WHERE (e.sender_id = auth.uid() AND e.receiver_id = friends.friend_id)
       OR (e.sender_id = friends.friend_id AND e.receiver_id = auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- 3. R1-D5：chat_media_participants_select —— 严格对象级授权
-- ---------------------------------------------------------------------------
-- 分支 ③ 仅当「对象名被某条我参与的 messages 行**精确引用**」时放行：
--   · m.media_url / m.thumbnail_url = storage.objects.name（相对对象路径精确匹配）
--   · 保留命名空间闸门 [1] = m.user_id::text
--   · 无任何 LIKE 后缀匹配 → 不存在通配符放大风险
--   · 无「历史完整 URL」分支：迁移 02 已回填 + 迁移 21 触发器禁止，该形态不存在
DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;
CREATE POLICY "chat_media_participants_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat_media'
  AND (
    -- ① 自己的命名空间（新数据，走 btree 索引）
    (storage.foldername(name))[1] = auth.uid()::text

    -- ② 对象 owner 即当前用户（上传者本人，覆盖多账号/历史）
    OR owner = auth.uid()

    -- ③ 反查消息：我是发送方或接收方，且对象被该消息**精确引用**
    OR EXISTS (
      SELECT 1
        FROM public.messages m
       WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
         -- 命名空间闸门：对象首段必须等于消息发送方 uid
         AND (storage.foldername(name))[1] = m.user_id::text
         -- 相对对象路径精确匹配（唯一授权依据）
         AND (
           m.media_url = storage.objects.name
           OR m.thumbnail_url = storage.objects.name
         )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 4. 自检（执行后手动核对，不自动运行）
-- ---------------------------------------------------------------------------
-- 4.1 接受事件表与策略（应仅 1 条 SELECT 策略，无写策略）：
--   SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname='public' AND tablename='friend_accept_events';
--   -- 期望：仅 friend_accept_events_select_participants / SELECT
--
-- 4.2 触发器（应含 friend_requests_record_accept_trg）：
--   SELECT tgname FROM pg_trigger
--    WHERE NOT tgisinternal AND tgrelid='public.friend_requests'::regclass;
--
-- 4.3 moments 策略（事件 + 当前 accepted 好友行，不依赖 created_at）：
--   SELECT policyname, cmd, qual FROM pg_policies
--    WHERE schemaname='public' AND tablename='moments' ORDER BY cmd, policyname;
--
-- 4.4 chat_media 策略（应仅含精确匹配，无 LIKE）：
--   SELECT policyname, cmd, qual FROM pg_policies
--    WHERE schemaname='storage' AND tablename='objects'
--      AND policyname='chat_media_participants_select';
--   -- 期望：qual 中不含 "LIKE"，仅含 "media_url = name" / "thumbnail_url = name"
--
-- 4.5 只读统计历史异常数据（不删改）：
--   -- 无接受事件凭证的 accepted 请求（历史不可证关系候选）
--   SELECT count(*) FROM public.friend_requests r
--    WHERE r.status='accepted'
--      AND NOT EXISTS (
--        SELECT 1 FROM public.friend_accept_events e
--         WHERE (e.sender_id=r.sender_id AND e.receiver_id=r.receiver_id));
--
-- ---------------------------------------------------------------------------
-- 5. 已知限制（明确记录，不虚假宣称已解决）
-- ---------------------------------------------------------------------------
--   L1. 「历史完整 URL 兼容」**已确认不存在**，故不实现：
--       · 迁移 02 已把所有 http% 且含 /chat_media/ 的 media_url 回填为相对路径；
--       · 迁移 21 的 messages_guard_media_ownership 触发器禁止写入完整 URL。
--       → messages 表中不可能存在完整 URL 形态；本策略仅支持相对路径精确匹配。
--   L2. 历史 accepted 请求**不回填**接受事件 → 历史关系在 R1 后不可读 friends-only 动态，
--       这是有意的 fail-closed 行为。若需恢复，必须由接收方重新接受（产生新事件），
--       或由所有者显式授权的一次性回填脚本（本迁移不包含）。
--   L3. 接受事件依赖「接收方真实执行 pending->accepted UPDATE」。若某历史关系从未
--       经过该迁移（例如直接插入 accepted 行），则无事件 → 不可读（符合预期）。
--   L4. 删除好友/删除已接受请求/降级好友 status 会撤销事件，授权立即失效。
--       删除后必须重新申请、重新接受（新的 pending→accepted 事件）才可重新获得授权；
--       旧事件不能重新插入 friends。
--   L5. 媒体对象若被多条我参与的消息精确引用，仍按精确匹配放行（对象确实被引用，合法）。
-- ============================================================================

-- --- END OF FILE supabase/migrations/33_收紧好友动态与媒体对象级授权_tighten_moments_and_media_object_scope.sql ---
