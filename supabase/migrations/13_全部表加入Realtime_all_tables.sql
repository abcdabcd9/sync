-- ===========================================================================
-- 13_全部表加入Realtime_all_tables.sql
-- 把 public schema 下的「全部业务表」加入 Realtime publication
-- ===========================================================================
--
-- 【为什么需要这个脚本】
--   Supabase 的访问控制是三层，缺任何一层都会「静默失效」：
--     第 1 层：表级权限 GRANT        → 缺了报 permission denied（会报错，好排查）
--     第 2 层：行级安全 RLS          → 缺了返回空结果集（不报错，难排查）
--     第 3 层：Realtime publication  → 缺了订阅能建立但永远收不到事件（不报错，最难排查）
--
--   12_开启Realtime实时刷新_enable_realtime_publication.sql 只补了 messages + health_records（聊天 + 健康搭子）。
--   本脚本一次性补齐 public schema 下所有业务表，避免以后每加一个实时功能
--   都要再写一个迁移。
--
-- 【设计：动态遍历，而不是硬编码表名】
--   硬编码表名的问题：以后新建表（比如 moments 之外的新功能表）又要改脚本。
--   这里直接遍历 pg_class 里 public schema 的所有普通表，自动加入 publication。
--   好处：一次执行，永久覆盖；新表只要重跑本脚本即可。
--
-- 【排除项】
--   spatial_ref_sys —— PostGIS 扩展自带的系统表，不属于业务数据，不加入。
--
-- 【注意】
--   1. 加入 publication ≠ 有权限读。Realtime 服务在推送前仍会按订阅者的
--      RLS 策略逐行校验，无权看的行不会推送。所以这里加表不会造成数据泄露。
--   2. 本脚本幂等：重复执行只会打印 NOTICE，不会报错。
--   3. 若某张表已存在但 RLS 未启用，Realtime 会推送全部行 —— 请确认
--      06_核心表启用RLS基线_enable_all_rls.sql 已执行（7 张表 RLS 全部为 true）。
--
-- 【回滚】
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.<表名>;
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. 确保 publication 存在（全新项目里 supabase_realtime 可能不存在）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
    RAISE NOTICE '已创建 publication: supabase_realtime';
  ELSE
    RAISE NOTICE 'publication 已存在，跳过创建: supabase_realtime';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. 遍历 public schema 下所有普通表，逐张加入 publication
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl     text;
  v_added   int := 0;
  v_skipped int := 0;
BEGIN
  FOR v_tbl IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'                       -- 只取普通表（排除视图/序列/分区父表）
      AND c.relname <> 'spatial_ref_sys'        -- 排除 PostGIS 系统表
    ORDER BY c.relname
  LOOP
    -- 已在 publication 中 → 跳过
    IF EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname    = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = v_tbl
    ) THEN
      RAISE NOTICE '已在 publication 中，跳过: public.%', v_tbl;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_tbl);
    RAISE NOTICE '已加入 publication: public.%', v_tbl;
    v_added := v_added + 1;
  END LOOP;

  RAISE NOTICE '完成：新增 % 张表，跳过 % 张表', v_added, v_skipped;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 自检（执行后请单独跑这一段，确认 7 张业务表全部在列）
-- ---------------------------------------------------------------------------
-- SELECT schemaname, tablename
-- FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
-- ORDER BY tablename;
--
-- 期望结果（7 行）：
--   public | complaints
--   public | friend_requests
--   public | friends
--   public | health_records
--   public | messages
--   public | moments
--   public | profiles
-- ===========================================================================
