-- --- START OF FILE supabase/migrations/12_开启Realtime实时刷新_enable_realtime_publication.sql ---
-- ============================================================================
-- P0：重建库后 Realtime 实时刷新全部失效
-- ============================================================================
-- 现象：
--   聊天列表不再自动置顶、未读数不再 +1、聊天室内新消息不自动出现、
--   健康搭子的打卡进度不再实时同步。
--   但手动下拉刷新 / 重新进入页面能看到最新数据（说明数据本身是好的）。
--
-- 根因：
--   Supabase 的访问控制其实是**三层**的：
--     第 1 层：表级权限 GRANT          ← 11_补齐7张表GRANT授权_grant_table_privileges.sql 已修
--     第 2 层：行级安全 RLS            ← 08_删除7条全开RLS策略_core_rls_policies.sql 已建
--     第 3 层：Realtime publication    ← 本迁移修复
--
--   Realtime 服务只广播「被加入 publication 的表」的变更。
--   Supabase 项目初始化时会自动创建 publication `supabase_realtime`，
--   但**它默认是空的**。在 Dashboard 里点开关加表，等价于执行
--   `ALTER PUBLICATION supabase_realtime ADD TABLE xxx;`
--   而用 SQL 脚本 CREATE TABLE 时，表不会被自动加入 publication。
--
--   所以重建库后：GRANT 有了、RLS 有了，但表不在 publication 里，
--   Realtime 服务根本不推送任何变更 → 前端订阅成功但永远收不到事件。
--
-- 代码中依赖 Realtime 的位置（已核对）：
--   · src/hooks/chat/useChatList.js:302   messages  INSERT（receiver_id 过滤）
--   · src/hooks/chat/useChatList.js:314   messages  UPDATE（已读回执）
--   · src/hooks/chat/useChatMessages.js   messages  INSERT / UPDATE
--   · src/components/CustomTabBar.js:46   messages  INSERT（全局未读角标）
--   · src/hooks/health/useHealthCloud.js:157  health_records  *（搭子进度）
--
-- 安全说明：
--   加入 publication 只是「允许广播」，**不代表任何人能收到**。
--   Realtime 在推送前会以订阅者的身份执行一次 RLS 检查：
--   订阅者无权读取的行不会被推送。
--   因此 messages / health_records 的 RLS 策略必须正确（已由 08_删除7条全开RLS策略_core_rls_policies.sql 建立）。
--   另外前端均使用 filter（receiver_id=eq.xxx / user_id=eq.xxx）做服务端过滤，
--   进一步缩小广播范围。
--
-- REPLICA IDENTITY：
--   UPDATE / DELETE 事件的 payload.old 默认只含主键。
--   本项目的 UPDATE 订阅（messages 已读回执）只用到 payload.new，
--   因此保持默认 REPLICA IDENTITY 即可，无需 FULL（FULL 会显著增加 WAL 体积）。
--
-- 幂等性：ADD TABLE 重复执行会报 "already member of publication"，
--         因此用 DO 块先查 pg_publication_tables 再决定是否添加。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 确保 publication 存在（Supabase 项目默认已有，此处兜底）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. 把需要实时推送的表加入 publication（幂等）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tables text[] := ARRAY['messages', 'health_records'];
  v_tbl    text;
BEGIN
  FOREACH v_tbl IN ARRAY v_tables
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname    = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = v_tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_tbl);
      RAISE NOTICE '已加入 publication: public.%', v_tbl;
    ELSE
      RAISE NOTICE '已在 publication 中，跳过: public.%', v_tbl;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 自检：执行完后跑这段，确认两张表都在 publication 里
-- ---------------------------------------------------------------------------
--   SELECT schemaname, tablename
--   FROM pg_publication_tables
--   WHERE pubname = 'supabase_realtime'
--   ORDER BY tablename;
--
--   期望：至少包含 health_records 和 messages 两行。
--
--   若还想确认 RLS 是否会让 Realtime 静默丢事件，可检查两张表的策略：
--   SELECT tablename, policyname, cmd, qual
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('messages', 'health_records')
--   ORDER BY tablename, cmd;

-- ---------------------------------------------------------------------------
-- 4. 回滚说明
-- ---------------------------------------------------------------------------
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.health_records;

-- --- END OF FILE supabase/migrations/12_开启Realtime实时刷新_enable_realtime_publication.sql ---
