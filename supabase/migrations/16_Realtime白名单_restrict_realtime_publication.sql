-- --- START OF FILE supabase/migrations/16_Realtime白名单_restrict_realtime_publication.sql ---
-- ============================================================================
-- H-3：Realtime publication 从「全表动态加入」收敛为「显式白名单」
-- ============================================================================
-- 问题：
--   13_全部表加入Realtime_all_tables.sql 用 DO 块遍历 pg_class，
--   把 public schema 下**所有**普通表都 ALTER PUBLICATION ... ADD TABLE。
--
--   这带来三个问题：
--     1. 暴露面失控：以后任何新建表（哪怕含敏感数据）都会被自动广播，
--        无需任何人审阅。开源后贡献者新增表时尤其危险。
--     2. profiles 被全量广播：profiles 的 UPDATE 事件会推给所有订阅者。
--        虽然 Realtime 推送前会按订阅者 RLS 逐行校验，但 profiles 的
--        SELECT 策略是 USING (true)（搜人必需，见 15 号迁移说明），
--        等于**任何登录用户都能收到全站任意用户的资料变更事件流**。
--        事件里虽只有公开列（15 号迁移已收回 expo_push_token / public_key），
--        但仍可被用来做全站用户活跃度画像 / 昵称变更追踪。
--     3. complaints 被广播但无人订阅：纯浪费 WAL 解码与带宽。
--
-- 本迁移做的事：
--   1. 把 publication 收敛为**显式白名单**（只保留真正有订阅的表）
--   2. 把 profiles 移出 publication
--   3. 把 complaints 移出 publication
--   4. 用「白名单 + 拒绝清单」双保险，防止以后有人重跑 13 号迁移又全量加回
--
-- 白名单依据（全量 grep src/ 下所有 postgres_changes 订阅）：
--   messages        ← useChatList.js:302/314、useChatMessages.js:167/193、
--                     CustomTabBar.js:46
--   friends         ← useChatList.js:380
--   friend_requests ← useChatList.js:386
--   health_records  ← useHealthCloud.js:157
--   moments         ← src/app/chat/moments.js:110
--
-- 移出 publication 的表：
--   profiles   ← 两处订阅已改为「不依赖 Realtime」的方案（见下）
--   complaints ← 前端只 INSERT，无任何订阅
--
-- ⚠️ profiles 移出后，两处原订阅的替代方案（前端已同步改造）：
--   1. src/app/account_info.js
--      原：订阅 profiles UPDATE（无 filter）→ 收到任意人改资料就重查自己
--      新：订阅 profiles UPDATE + filter: id=eq.<自己>（只收自己的行）
--          —— 但 profiles 已移出 publication，此订阅不再生效，
--             改为依赖「绑定/解绑动作本身」在本地立即刷新（已有 refreshPartner），
--             以及页面重新获得焦点时的 fetchProfileData 兜底。
--   2. src/hooks/chat/useChatList.js
--      原：订阅 profiles UPDATE（无 filter）→ 好友改昵称时刷新列表
--      新：移除该订阅。好友改昵称属于低频事件，由以下时机兜底刷新：
--          · useFocusEffect（每次进入会话列表 / 联系人页）
--          · friends / friend_requests 变更事件（已订阅）
--          · 下拉刷新 / 手动 refresh()
--
-- 为什么不用「保留 profiles + 加 filter」：
--   Realtime 的 filter 只支持单值 eq，无法表达
--   id IN (好友1, 好友2, ...)。而 account_info 需要感知「伴侣改昵称」，
--   伴侣 id 是动态的，也无法在订阅时静态确定。
--   因此 profiles 不适合走 Realtime 广播，改为事件驱动 + 焦点刷新。
--
-- 幂等性：
--   ALTER PUBLICATION ... DROP TABLE 在表不在 publication 时会报错，
--   因此全部包在 IF EXISTS 判断里。可重复执行。
--
-- 回滚：
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.complaints;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 确保 publication 存在（全新项目里可能不存在）
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
-- 2. 把 profiles 移出 publication（H-3 核心）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.profiles;
    RAISE NOTICE '已从 publication 移除: public.profiles';
  ELSE
    RAISE NOTICE 'public.profiles 不在 publication 中，跳过';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 把 complaints 移出 publication（无任何订阅方）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'complaints'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.complaints;
    RAISE NOTICE '已从 publication 移除: public.complaints';
  ELSE
    RAISE NOTICE 'public.complaints 不在 publication 中，跳过';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 白名单：确保 5 张有订阅的表都在 publication 中
-- ---------------------------------------------------------------------------
-- 用数组遍历，避免 5 段重复的 IF EXISTS 代码。
DO $$
DECLARE
  v_tbl     text;
  v_added   int := 0;
  v_skipped int := 0;
  v_whitelist text[] := ARRAY[
    'messages',
    'friends',
    'friend_requests',
    'health_records',
    'moments'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_whitelist
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_tbl
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- 表可能尚未创建（例如全新库只跑了部分迁移）→ 跳过而不是报错
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_tbl AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE '表不存在，跳过: public.%', v_tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_tbl);
    RAISE NOTICE '已加入 publication: public.%', v_tbl;
    v_added := v_added + 1;
  END LOOP;

  RAISE NOTICE '白名单处理完成：新增 % 张，已存在 % 张', v_added, v_skipped;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. 拒绝清单：把白名单之外的表全部移出 publication
-- ---------------------------------------------------------------------------
-- 这一步是「防回归」的关键：即使有人重跑了 13_全部表加入Realtime_all_tables.sql，
-- 只要再跑一次本迁移，多余的表就会被清掉。
-- 也覆盖了未来新增的表 —— 新表默认不进 publication，必须显式加白名单。
DO $$
DECLARE
  v_tbl     text;
  v_removed int := 0;
  v_whitelist text[] := ARRAY[
    'messages',
    'friends',
    'friend_requests',
    'health_records',
    'moments'
  ];
BEGIN
  FOR v_tbl IN
    SELECT tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename <> ALL (v_whitelist)
    ORDER BY tablename
  LOOP
    EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', v_tbl);
    RAISE NOTICE '非白名单表，已移出 publication: public.%', v_tbl;
    v_removed := v_removed + 1;
  END LOOP;

  RAISE NOTICE '拒绝清单处理完成：移出 % 张表', v_removed;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. 自检（执行后单独跑这一段）
-- ---------------------------------------------------------------------------
-- SELECT schemaname, tablename
-- FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
-- ORDER BY tablename;
--
-- 期望结果（恰好 5 行，且不含 profiles / complaints）：
--   public | friend_requests
--   public | friends
--   public | health_records
--   public | messages
--   public | moments
--
-- 再确认 profiles 确实不在：
-- SELECT count(*) FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'profiles';
-- 期望：0
-- ============================================================================
-- --- END OF FILE supabase/migrations/16_Realtime白名单_restrict_realtime_publication.sql ---
