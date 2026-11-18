-- --- START OF FILE supabase/migrations/27_授权表加入Realtime白名单_partner_authorizations_realtime.sql ---
-- ============================================================================
-- TASK-P0.2 / T6.1 FIX-05：授权撤销的实时通知
-- ============================================================================
-- 背景（REVIEW_RESOLUTION 剩余风险 R1）：
--   迁移 16 把 Realtime publication 收敛为显式白名单，当时白名单里没有
--   partner_authorizations（该表在迁移 20 才引入）。结果是：
--
--     对方解绑（unbind_partner 把 status 改为 revoked）时，本端**收不到任何
--     实时事件**。客户端只能靠以下时机被动发现：
--       · App 从后台切回前台时的 get_active_partner_id() 复验
--       · 冷启动时的 loadAllData()
--
--   在「双方都在前台」的常见场景下，被解绑方会继续看到搭子卡片、
--   继续订阅对方健康数据，直到自己切后台再回来 —— 授权已撤销但界面未失效，
--   属于「撤销不及时」的可见缺陷。
--
-- 本迁移做的事（最小改动）：
--   1. 把 partner_authorizations 加入 supabase_realtime publication。
--   2. 确认该表已启用 RLS 且 SELECT 策略只允许「自己参与的行」。
--      Realtime 在推送前会按订阅者身份逐行校验 RLS，因此：
--        · 只有 requester_id 或 addressee_id 等于自己的行会被推送；
--        · 不会把全站授权关系广播给无关用户。
--   3. 显式 REVOKE 匿名角色的一切权限（沿用迁移 23 的收敛策略）。
--
-- 为什么可以安全加入白名单：
--   · 表内只有 requester_id / addressee_id / status / 时间戳，
--     不含 token、密钥或健康数据本身；
--   · RLS SELECT 策略（迁移 20）为：
--       USING (requester_id = auth.uid() OR addressee_id = auth.uid())
--     即订阅者只能收到与自己相关的授权变更；
--   · 客户端只订阅 UPDATE 事件用于「撤销感知」，不依赖该表做任何授权判定
--     （授权判定始终在服务端 RPC / RLS 内完成）。
--
-- 幂等性：
--   ALTER PUBLICATION ... ADD TABLE 在表已在 publication 时会报错，
--   因此用 pg_publication_tables 判断后再执行。可重复运行。
--
-- 回滚：
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.partner_authorizations;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 确保 publication 存在
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
    RAISE NOTICE '已创建 publication: supabase_realtime';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. 加入白名单（幂等）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'partner_authorizations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.partner_authorizations;
    RAISE NOTICE '已把 partner_authorizations 加入 supabase_realtime';
  ELSE
    RAISE NOTICE 'partner_authorizations 已在 supabase_realtime 中，跳过';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 确认 RLS 已启用（防御性；迁移 20 已启用，这里只做断言）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rls BOOLEAN;
BEGIN
  SELECT relrowsecurity INTO v_rls
  FROM pg_class
  WHERE oid = 'public.partner_authorizations'::regclass;

  IF NOT COALESCE(v_rls, false) THEN
    -- 未启用 RLS 时绝不能广播：直接拒绝本次迁移，避免把授权关系泄露给所有人
    RAISE EXCEPTION 'partner_authorizations 未启用 RLS，拒绝加入 Realtime publication';
  END IF;
  RAISE NOTICE 'partner_authorizations RLS 已启用，可安全广播';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 权限收敛：匿名角色不得读取授权关系
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.partner_authorizations FROM anon;

-- 已登录用户仅保留 SELECT（由 RLS 限定为自己参与的行）；
-- 写操作一律经由 SECURITY DEFINER RPC，客户端无直接写权限。
REVOKE INSERT, UPDATE, DELETE ON public.partner_authorizations FROM authenticated;
GRANT SELECT ON public.partner_authorizations TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'partner_authorizations';
-- 期望：返回 1 行

-- --- END OF FILE supabase/migrations/27_授权表加入Realtime白名单_partner_authorizations_realtime.sql ---
