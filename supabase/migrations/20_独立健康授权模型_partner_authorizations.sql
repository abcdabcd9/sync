-- --- START OF FILE supabase/migrations/20_独立健康授权模型_partner_authorizations.sql ---
-- ============================================================================
-- TASK-P0.2 / Batch A1：独立健康授权模型（T6 修订版）
-- ============================================================================
-- 背景（为什么必须新增一张表）：
--   当前健康数据共享的授权事实完全依赖 public.profiles.bound_partner_id 这个
--   「指针列」。它有三个结构性缺陷：
--
--   1. 客户端可直接写。profiles_update_own 允许本人 UPDATE 自己的整行，
--      于是任何登录用户都能执行：
--        update profiles set bound_partner_id = '<任意用户 id>' where id = auth.uid();
--      单方面把自己「绑定」到任意目标，随后 health_records_select_own_or_partner
--      就会把对方的健康记录读出来。授权完全由客户端声明，服务端没有独立事实。
--
--   2. 授权没有双方确认。指针是单向的，A 写了自己的指针就等于获得了对 B 的
--      读取权，B 从未同意。所谓「双向绑定」只是两个客户端各自写指针的巧合。
--
--   3. 授权没有状态。无法表达 pending / rejected / revoked / expired，
--      也无法审计「谁在什么时候授权了谁」。
--
--   本迁移引入服务端私有的授权关系表 partner_authorizations，作为健康数据
--   共享的唯一权威事实来源。profiles.bound_partner_id 降级为「兼容展示列」，
--   不再参与任何授权判定。
--
-- 设计要点：
--   · 一张表同时承载「邀请」与「成员关系」，用 status 区分生命周期。
--     状态机：pending → accepted → revoked
--             pending → rejected
--             pending → cancelled（申请者撤回）
--             pending → expired（超过有效期）
--   · 只有 accepted 状态构成有效授权。
--   · 一人最多一条 accepted 关系（见下方「成员唯一约束」）。
--   · 同一对用户最多一条 pending 邀请（部分唯一索引强制，防重复刷）。
--   · 所有写操作只经由 SECURITY DEFINER RPC 完成，客户端对表无任何直接
--     INSERT/UPDATE/DELETE 权限，只有 SELECT 自己参与的行。
--   · 不信任客户端声明的身份或角色，一律以 auth.uid() 为准。
--
-- T6 修订（针对 GPT A01/A08 与 Gemini P1-2/P2-2）：
--   1. 一对一硬约束从「两个单列部分唯一索引」升级为「成员唯一约束」：
--      新增 partner_authorization_members 表，对 (user_id) 在 accepted 关系上
--      做唯一约束。这样无论 A 出现在 requester 还是 addressee 侧，都只能有一条
--      有效关系，彻底堵住「A 同时是关系1的 requester 和关系2的 addressee」的
--      跨方向绕过。两个单列部分唯一索引保留作为快速失败的第一道闸。
--   2. accept 采用「固定顺序行锁」：先按 uuid 升序对两个 profile 行加锁，
--      再对候选关系加锁，最后在锁内重新做一次全量一致性复验。并发 accept
--      因此串行化，不会出现双写。
--   3. 过期邀请：accept 遇到过期时，先把 status 落库为 expired 并提交，
--      再抛错（通过独立子事务/先 UPDATE 后 RAISE 的方式保证持久化）。
--   4. get_active_partner_id 增加确定性 ORDER BY，不再用裸 LIMIT 1。
--   5. 卡片与授权记录关联：request_partner 返回授权 id，客户端用它作为卡片
--      的关联键；accept/reject/cancel 接受授权 id，卡片仅作展示。
--
-- 幂等性：全部 IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS。
-- 不修改任何历史迁移文件，不触碰既有数据行（仅新增表与函数）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 授权关系表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_authorizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 邀请发起方（申请者）
  requester_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- 邀请接收方（被邀请成为搭子的人）
  addressee_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- 生命周期状态。只有 accepted 构成有效授权。
  status        TEXT NOT NULL DEFAULT 'pending',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  -- pending 邀请的过期时间；accepted 后置为 NULL
  expires_at    TIMESTAMPTZ,
  -- 状态最后一次变更的时间（审计用）
  responded_at  TIMESTAMPTZ,

  CONSTRAINT partner_authorizations_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired', 'revoked')),

  -- 禁止自己邀请自己
  CONSTRAINT partner_authorizations_no_self
    CHECK (requester_id <> addressee_id)
);

-- 第一道闸：单列部分唯一索引（快速失败，且对 requester/addressee 各自方向生效）
CREATE UNIQUE INDEX IF NOT EXISTS partner_authorizations_one_active_per_user
  ON public.partner_authorizations (requester_id)
  WHERE status = 'accepted';

CREATE UNIQUE INDEX IF NOT EXISTS partner_authorizations_one_active_per_addressee
  ON public.partner_authorizations (addressee_id)
  WHERE status = 'accepted';

-- 同一对用户最多一条 pending 邀请（防重复刷邀请）
CREATE UNIQUE INDEX IF NOT EXISTS partner_authorizations_one_pending_per_pair
  ON public.partner_authorizations (requester_id, addressee_id)
  WHERE status = 'pending';

-- 常用查询索引
CREATE INDEX IF NOT EXISTS partner_authorizations_requester_idx
  ON public.partner_authorizations (requester_id, status);

CREATE INDEX IF NOT EXISTS partner_authorizations_addressee_idx
  ON public.partner_authorizations (addressee_id, status);

-- ---------------------------------------------------------------------------
-- 1b. 成员唯一约束（T6 新增，堵住跨方向绕过）
-- ---------------------------------------------------------------------------
-- 每条 accepted 关系在成员表里产生两行（requester 一行、addressee 一行）。
-- 对 (user_id) 在「有效关系」上做唯一约束，保证任何用户在任何方向上
-- 最多只属于一条 accepted 关系。这是真正的一对一硬约束。
--
-- 成员表由触发器自动维护，客户端无任何权限。
CREATE TABLE IF NOT EXISTS public.partner_authorization_members (
  authorization_id UUID NOT NULL
    REFERENCES public.partner_authorizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL
    REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (authorization_id, user_id)
);

-- 关键约束：一个 user_id 只能出现在一条 accepted 关系的成员行里。
-- 由于成员行只在 accepted 时存在，这个唯一索引等价于「一人一有效关系」。
CREATE UNIQUE INDEX IF NOT EXISTS partner_authorization_members_one_active
  ON public.partner_authorization_members (user_id);

ALTER TABLE public.partner_authorization_members ENABLE ROW LEVEL SECURITY;
-- 不建任何策略：默认拒绝。客户端不可见、不可写。
REVOKE ALL ON public.partner_authorization_members FROM PUBLIC;
REVOKE ALL ON public.partner_authorization_members FROM anon;
REVOKE ALL ON public.partner_authorization_members FROM authenticated;
GRANT ALL ON public.partner_authorization_members TO service_role;

-- 成员表维护触发器：status 变为 accepted 时插入两行成员，
-- 离开 accepted 时删除该关系的成员行。
CREATE OR REPLACE FUNCTION public.partner_authorizations_sync_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'accepted' THEN
    -- 插入两行成员。若任一用户已属于另一条 accepted 关系，
    -- partner_authorization_members_one_active 唯一索引会立即报错，
    -- 从而在数据库层强制「一人一有效关系」，与并发无关。
    INSERT INTO public.partner_authorization_members (authorization_id, user_id)
    VALUES (NEW.id, NEW.requester_id)
    ON CONFLICT (authorization_id, user_id) DO NOTHING;

    INSERT INTO public.partner_authorization_members (authorization_id, user_id)
    VALUES (NEW.id, NEW.addressee_id)
    ON CONFLICT (authorization_id, user_id) DO NOTHING;
  ELSE
    -- 非 accepted：确保该关系不残留成员行
    DELETE FROM public.partner_authorization_members
    WHERE authorization_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS partner_authorizations_sync_members_trg
  ON public.partner_authorizations;
CREATE TRIGGER partner_authorizations_sync_members_trg
  AFTER INSERT OR UPDATE OF status ON public.partner_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.partner_authorizations_sync_members();

-- updated_at 自动维护（复用迁移 07 已定义的 touch_updated_at）
DROP TRIGGER IF EXISTS partner_authorizations_touch_updated_at
  ON public.partner_authorizations;
CREATE TRIGGER partner_authorizations_touch_updated_at
  BEFORE UPDATE ON public.partner_authorizations
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. RLS：本人只能看到自己参与的授权行，且不能直接写
-- ---------------------------------------------------------------------------
ALTER TABLE public.partner_authorizations ENABLE ROW LEVEL SECURITY;

-- 只读自己参与的行（作为申请者或接收者）
DROP POLICY IF EXISTS partner_authorizations_select_participants
  ON public.partner_authorizations;
CREATE POLICY partner_authorizations_select_participants
  ON public.partner_authorizations
  FOR SELECT
  TO authenticated
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- 刻意不创建任何 INSERT / UPDATE / DELETE 策略：
--   没有策略 = 默认拒绝。所有写入必须走下面的 SECURITY DEFINER RPC。

-- 表级权限：只给 SELECT，不给任何写权限。
-- 注意：必须先 REVOKE 再 GRANT，避免继承自 PUBLIC 的默认权限残留。
REVOKE ALL ON public.partner_authorizations FROM PUBLIC;
REVOKE ALL ON public.partner_authorizations FROM anon;
REVOKE ALL ON public.partner_authorizations FROM authenticated;
GRANT SELECT ON public.partner_authorizations TO authenticated;
GRANT ALL ON public.partner_authorizations TO service_role;

-- ---------------------------------------------------------------------------
-- 3. 内部辅助函数：取当前用户的有效搭子 id
-- ---------------------------------------------------------------------------
-- 供 RLS 策略与其它 RPC 复用。SECURITY DEFINER + 固定 search_path，
-- 只返回一个 UUID，不泄露任何其它字段，无法用于枚举关系图谱。
--
-- T6：增加确定性 ORDER BY。若因历史脏数据存在多条 accepted（理论上已被
-- 成员唯一约束阻止），始终采信最近更新的那条，避免结果随机闪烁。
CREATE OR REPLACE FUNCTION public.get_active_partner_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN requester_id = auth.uid() THEN addressee_id
    ELSE requester_id
  END
  FROM public.partner_authorizations
  WHERE status = 'accepted'
    AND (requester_id = auth.uid() OR addressee_id = auth.uid())
  ORDER BY updated_at DESC, id DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_active_partner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_partner_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3b. 内部辅助：固定顺序锁两个用户（防死锁）
-- ---------------------------------------------------------------------------
-- 所有涉及「双方」的写操作都先按 uuid 升序对两个 profile 行加锁，
-- 保证并发事务的加锁顺序一致，不会互相等待成环。
CREATE OR REPLACE FUNCTION public.lock_profile_pair(a UUID, b UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lo UUID := LEAST(a, b);
  v_hi UUID := GREATEST(a, b);
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = v_lo FOR UPDATE;
  PERFORM 1 FROM public.profiles WHERE id = v_hi FOR UPDATE;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_profile_pair(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_profile_pair(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. 邀请：发起 / 接受 / 拒绝 / 取消 / 撤销
-- ---------------------------------------------------------------------------

-- 4.1 发起邀请
-- 返回授权记录 id，客户端用它作为聊天卡片的关联键（card ↔ authorization）。
--
-- T6.1/FIX-01：邀请卡片改由本函数在**同一事务内**写入，与授权记录同生共死。
--   旧实现由客户端在 RPC 返回后单独 INSERT 卡片，存在两个缺口：
--     1. RPC 成功但卡片 INSERT 失败 → 留下「有授权、无卡片」的孤立 pending，
--        对方永远看不到邀请，却占用了「同一对最多一条 pending」的唯一索引；
--     2. 客户端可自行决定卡片内容与 subtype，卡片与授权事实可能不一致。
--   现在卡片写入与授权记录在同一事务：任一失败整体回滚，不会产生半绑定。
--   客户端不再需要（也不允许）自行插入 SYNC_PARTNER_* 卡片。
CREATE OR REPLACE FUNCTION public.request_partner(target_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
  v_expired_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF target_user_id IS NULL OR target_user_id = v_uid THEN
    RAISE EXCEPTION 'invalid target user' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'target user not found' USING ERRCODE = '22023';
  END IF;

  -- 固定顺序锁双方，避免与 accept 并发时死锁
  PERFORM public.lock_profile_pair(v_uid, target_user_id);

  -- 双方任一方已有有效关系时拒绝（一对一）
  IF public.get_active_partner_id() IS NOT NULL THEN
    RAISE EXCEPTION 'you already have an active partner' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.partner_authorizations
    WHERE status = 'accepted'
      AND (requester_id = target_user_id OR addressee_id = target_user_id)
  ) THEN
    RAISE EXCEPTION 'target already has an active partner' USING ERRCODE = '23505';
  END IF;

  -- T6/A08：先处理「已过期但仍标记为 pending」的邀请，避免复用过期记录。
  --   把过期 pending 落库为 expired（持久化），再继续后续逻辑。
  --
  -- T6.2 收尾缺陷2b：过期路径必须同步卡片状态。
  --   旧实现只把授权行改成 expired，聊天卡片仍停在 SYNC_PARTNER_INVITE，
  --   对方看到的仍是「可同意」的邀请卡片（点击后才发现已过期），
  --   造成「授权事实已过期、卡片仍待处理」的状态不同步。
  --   这里用 RETURNING 收集被过期的授权 id（卡片 id 恒等于授权 id），
  --   在同一事务内把对应卡片推进到 SYNC_PARTNER_EXPIRED。
  WITH expired_rows AS (
    UPDATE public.partner_authorizations
    SET status = 'expired', responded_at = timezone('utc', now())
    WHERE status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at < timezone('utc', now())
      AND ((requester_id = v_uid AND addressee_id = target_user_id)
        OR (requester_id = target_user_id AND addressee_id = v_uid))
    RETURNING id
  )
  UPDATE public.messages
  SET subtype = 'SYNC_PARTNER_EXPIRED'
  WHERE id IN (SELECT id FROM expired_rows)
    AND subtype = 'SYNC_PARTNER_INVITE';

  -- 复用仍然有效的 pending（同一对、任一方向）
  -- FIX-06：这里**必须**用 FOR UPDATE 加锁。
  --   否则 A→B 与 B→A 并发发起时，两个事务都读不到对方的未提交行，
  --   各自走 INSERT 分支，最终同一对用户出现两条方向相反的 pending，
  --   与「一对一」语义冲突（后续 accept 才被成员唯一约束兜底，属于延迟失败）。
  --   加锁后第二个事务会阻塞，待第一个提交后重新读取并命中幂等分支。
  --   注意：此处已持有双方 profile 行锁（lock_profile_pair），
  --   且 partner_authorizations 的行锁顺序由 profile 行锁串行化，不会死锁。
  SELECT id INTO v_id
  FROM public.partner_authorizations
  WHERE status = 'pending'
    AND ((requester_id = v_uid AND addressee_id = target_user_id)
      OR (requester_id = target_user_id AND addressee_id = v_uid))
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    -- 幂等：重复邀请返回同一条。
    -- FIX-01：同时确保卡片存在（历史数据可能因旧客户端「RPC 成功但卡片失败」而缺失）。
    --   卡片 id 恒等于授权 id，故 ON CONFLICT DO NOTHING 天然幂等。
    INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
    VALUES (v_id, v_uid, target_user_id, 'text', '', 'SYNC_PARTNER_INVITE')
    ON CONFLICT (id) DO NOTHING;
    RETURN v_id;
  END IF;

  INSERT INTO public.partner_authorizations
    (requester_id, addressee_id, status, expires_at)
  VALUES
    (v_uid, target_user_id, 'pending', timezone('utc', now()) + INTERVAL '7 days')
  RETURNING id INTO v_id;

  -- FIX-01：卡片与授权记录在同一事务内写入，id 复用授权 id。
  --   若此 INSERT 失败，整个函数事务回滚，不会留下孤立 pending。
  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (v_id, v_uid, target_user_id, 'text', '', 'SYNC_PARTNER_INVITE');

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_partner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_partner(UUID) TO authenticated;

-- 4.2 接受邀请（只有被邀请方可以）
-- T6：固定顺序锁 + 锁内全量复验 + 过期持久化。
CREATE OR REPLACE FUNCTION public.accept_partner_invite(auth_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.partner_authorizations%ROWTYPE;
  v_conflict INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- 先读一次拿到双方 id（不加锁），用于确定加锁顺序
  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE id = auth_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite not found' USING ERRCODE = '22023';
  END IF;
  IF v_row.addressee_id <> v_uid THEN
    RAISE EXCEPTION 'only the addressee can accept' USING ERRCODE = '42501';
  END IF;

  -- 固定顺序锁双方 profile 行（与 request_partner 一致，防死锁）
  PERFORM public.lock_profile_pair(v_row.requester_id, v_row.addressee_id);

  -- 再对候选关系行加锁并重新读取（锁内复验，防止并发状态漂移）
  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE id = auth_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite not found' USING ERRCODE = '22023';
  END IF;
  IF v_row.addressee_id <> v_uid THEN
    RAISE EXCEPTION 'only the addressee can accept' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'invite is not pending' USING ERRCODE = '22023';
  END IF;

  -- T6/A08：过期邀请必须「先持久化 expired，再让调用方感知失败」。
  --   若直接 RAISE，整个函数事务回滚，expired 状态不会落库（旧实现的缺陷）。
  --   因此这里把状态更新为 expired 后正常 RETURN（不抛错），
  --   调用方通过再次查询该行 status = 'expired' 区分「过期」与「成功」。
  IF v_row.expires_at IS NOT NULL AND v_row.expires_at < timezone('utc', now()) THEN
    UPDATE public.partner_authorizations
    SET status = 'expired', responded_at = timezone('utc', now())
    WHERE id = auth_id;

    -- T6.2 收尾缺陷2b：过期路径必须同步卡片状态（INVITE → EXPIRED）。
    --   旧实现只改授权行，卡片仍停在 SYNC_PARTNER_INVITE，对方看到「可同意」
    --   的邀请卡片，点击后才被提示已过期，状态不同步。
    UPDATE public.messages
    SET subtype = 'SYNC_PARTNER_EXPIRED'
    WHERE id = auth_id AND subtype = 'SYNC_PARTNER_INVITE';

    RETURN;
  END IF;

  -- 锁内全量复验：双方都不得已有其它有效关系
  SELECT count(*) INTO v_conflict
  FROM public.partner_authorizations
  WHERE status = 'accepted'
    AND id <> auth_id
    AND (requester_id IN (v_row.requester_id, v_row.addressee_id)
      OR addressee_id IN (v_row.requester_id, v_row.addressee_id));

  IF v_conflict > 0 THEN
    RAISE EXCEPTION 'one of the users already has an active partner'
      USING ERRCODE = '23505';
  END IF;

  -- 更新为 accepted。成员表触发器会插入两行成员；
  -- 若任一用户已属于其它 accepted 关系，成员唯一索引会在此处报错，
  -- 事务回滚，保证不会出现双关系。
  UPDATE public.partner_authorizations
  SET status = 'accepted',
      responded_at = timezone('utc', now()),
      expires_at = NULL
  WHERE id = auth_id;

  -- FIX-01：卡片状态与授权状态在同一事务内同步。
  --   卡片 id 恒等于授权 id，故这里按 id 精确定位，不依赖文案匹配。
  --   若卡片不存在（历史数据），补建一条，保证「授权 accepted ⇒ 卡片存在」。
  UPDATE public.messages
  SET subtype = 'SYNC_PARTNER_ACCEPTED'
  WHERE id = auth_id AND subtype = 'SYNC_PARTNER_INVITE';

  INSERT INTO public.messages (id, user_id, receiver_id, type, text, subtype)
  VALUES (auth_id, v_row.requester_id, v_row.addressee_id, 'text', '', 'SYNC_PARTNER_ACCEPTED')
  ON CONFLICT (id) DO NOTHING;

  -- 兼容：同步 bound_partner_id 供旧 UI 展示（不再作为授权依据）
  UPDATE public.profiles SET bound_partner_id = v_row.addressee_id
  WHERE id = v_row.requester_id;
  UPDATE public.profiles SET bound_partner_id = v_row.requester_id
  WHERE id = v_row.addressee_id;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_partner_invite(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_partner_invite(UUID) TO authenticated;

-- 4.3 拒绝邀请（只有被邀请方可以）
CREATE OR REPLACE FUNCTION public.reject_partner_invite(auth_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.partner_authorizations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE id = auth_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite not found' USING ERRCODE = '22023';
  END IF;
  IF v_row.addressee_id <> v_uid THEN
    RAISE EXCEPTION 'only the addressee can reject' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'invite is not pending' USING ERRCODE = '22023';
  END IF;

  UPDATE public.partner_authorizations
  SET status = 'rejected', responded_at = timezone('utc', now())
  WHERE id = auth_id;

  -- FIX-01：卡片状态与授权状态在同一事务内同步（INVITE → REJECTED）。
  --   旧实现由客户端在 RPC 返回后自行 UPDATE messages，会被迁移 21 的
  --   列权限/触发器拒绝（客户端不能改 subtype），导致卡片永远停在「待处理」。
  --   现在由服务端在同一事务内推进，客户端不再直写。
  UPDATE public.messages
  SET subtype = 'SYNC_PARTNER_REJECTED'
  WHERE id = auth_id AND subtype = 'SYNC_PARTNER_INVITE';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_partner_invite(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_partner_invite(UUID) TO authenticated;

-- 4.4 取消待决邀请（只有申请者可以）
CREATE OR REPLACE FUNCTION public.cancel_partner_invite(auth_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.partner_authorizations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE id = auth_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite not found' USING ERRCODE = '22023';
  END IF;
  IF v_row.requester_id <> v_uid THEN
    RAISE EXCEPTION 'only the requester can cancel' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'invite is not pending' USING ERRCODE = '22023';
  END IF;

  UPDATE public.partner_authorizations
  SET status = 'cancelled', responded_at = timezone('utc', now())
  WHERE id = auth_id;

  -- FIX-01：卡片状态与授权状态在同一事务内同步（INVITE → CANCELLED）。
  UPDATE public.messages
  SET subtype = 'SYNC_PARTNER_CANCELLED'
  WHERE id = auth_id AND subtype = 'SYNC_PARTNER_INVITE';
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_partner_invite(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_partner_invite(UUID) TO authenticated;

-- 4.5 撤销有效关系（任一方都可以）
CREATE OR REPLACE FUNCTION public.revoke_partner_authorization()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.partner_authorizations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE status = 'accepted'
    AND (requester_id = v_uid OR addressee_id = v_uid)
  ORDER BY updated_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    -- 幂等：没有有效关系时静默成功
    RETURN;
  END IF;

  UPDATE public.partner_authorizations
  SET status = 'revoked', responded_at = timezone('utc', now())
  WHERE id = v_row.id;

  -- T6.2 收尾缺陷2b：撤销路径必须同步卡片状态（ACCEPTED → UNBOUND）。
  --   旧实现只改授权行并清空 bound_partner_id，聊天卡片仍停在
  --   SYNC_PARTNER_ACCEPTED，双方看到的仍是「已成为健康搭子」的卡片，
  --   与「授权已撤销」的事实不一致。这里按授权 id（= 卡片 id）精确同步。
  UPDATE public.messages
  SET subtype = 'SYNC_PARTNER_UNBOUND'
  WHERE id = v_row.id AND subtype = 'SYNC_PARTNER_ACCEPTED';

  -- 兼容：清空双方 bound_partner_id 展示列
  UPDATE public.profiles SET bound_partner_id = NULL
  WHERE id IN (v_row.requester_id, v_row.addressee_id);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_partner_authorization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_partner_authorization() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. 兼容旧签名：unbind_partner(target_partner_id UUID)
-- ---------------------------------------------------------------------------
-- 旧客户端仍会调用 unbind_partner。保留签名，但内部改为走新授权模型：
--   · 只允许解除「自己与 target 之间」的有效关系（对象级授权）；
--   · 不能通过传任意 id 来解除他人关系；
--   · T6/A03：只有确实撤销了「自己与 target 之间」的关系时，才清理双方
--     展示列；若不存在该关系，不清任何指针（避免误清他人有效绑定）。
CREATE OR REPLACE FUNCTION public.unbind_partner(target_partner_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.partner_authorizations%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF target_partner_id IS NULL OR target_partner_id = v_uid THEN
    RAISE EXCEPTION 'invalid target partner' USING ERRCODE = '22023';
  END IF;

  -- 固定顺序锁双方
  PERFORM public.lock_profile_pair(v_uid, target_partner_id);

  -- 只查找「自己与 target 之间」的有效关系（对象级授权）
  SELECT * INTO v_row
  FROM public.partner_authorizations
  WHERE status = 'accepted'
    AND ((requester_id = v_uid AND addressee_id = target_partner_id)
      OR (requester_id = target_partner_id AND addressee_id = v_uid))
  FOR UPDATE;

  IF NOT FOUND THEN
    -- 不存在「我与 target」的有效关系：不做任何清理，静默返回。
    -- 这防止攻击者通过传任意 id 误清他人绑定。
    RETURN;
  END IF;

  UPDATE public.partner_authorizations
  SET status = 'revoked', responded_at = timezone('utc', now())
  WHERE id = v_row.id;

  -- 仅清理「确实被撤销的这条关系」的双方展示列
  UPDATE public.profiles SET bound_partner_id = NULL
  WHERE id IN (v_row.requester_id, v_row.addressee_id);

  -- 历史卡片状态（保持迁移 14 的行为，仅限这条关系的双方）
  UPDATE public.messages
  SET text = '', subtype = 'SYNC_PARTNER_UNBOUND'
  WHERE subtype = 'SYNC_PARTNER_ACCEPTED'
    AND ((user_id = v_row.requester_id AND receiver_id = v_row.addressee_id)
      OR (user_id = v_row.addressee_id AND receiver_id = v_row.requester_id));
END;
$$;

REVOKE ALL ON FUNCTION public.unbind_partner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unbind_partner(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. 健康记录读取策略：改为基于新授权模型
-- ---------------------------------------------------------------------------
-- 旧策略依赖 profiles.bound_partner_id（客户端可写），必须替换。
DROP POLICY IF EXISTS health_records_select_own_or_partner
  ON public.health_records;

CREATE POLICY health_records_select_own_or_partner
  ON public.health_records
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR user_id = public.get_active_partner_id()
  );

-- ---------------------------------------------------------------------------
-- 7. 注销清理：删除授权与待决邀请
-- ---------------------------------------------------------------------------
-- 外键已是 ON DELETE CASCADE，auth.users 删除时 profiles 删除会级联清掉
-- partner_authorizations 与 partner_authorization_members。
-- 这里额外提供显式清理函数，供 delete_my_account 在删除 auth 用户之前调用。
CREATE OR REPLACE FUNCTION public.purge_partner_authorizations_for(target_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.partner_authorizations
  WHERE requester_id = target_user_id OR addressee_id = target_user_id;
END;
$$;

-- 仅 service_role 可调用（注销流程在服务端执行）
REVOKE ALL ON FUNCTION public.purge_partner_authorizations_for(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_partner_authorizations_for(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT policyname, cmd, qual FROM pg_policies
--   WHERE schemaname='public' AND tablename='partner_authorizations';
-- 期望：只有 1 条 SELECT 策略。
--
-- SELECT has_table_privilege('authenticated','public.partner_authorizations','INSERT') AS auth_insert,
--        has_table_privilege('authenticated','public.partner_authorizations','UPDATE') AS auth_update,
--        has_table_privilege('authenticated','public.partner_authorizations','DELETE') AS auth_delete;
-- 期望：全部 false。
--
-- SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
--   WHERE polname='health_records_select_own_or_partner';
-- 期望：包含 get_active_partner_id()，不再包含 bound_partner_id。

-- --- END OF FILE supabase/migrations/20_独立健康授权模型_partner_authorizations.sql ---
