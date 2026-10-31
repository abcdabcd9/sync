-- --- START OF FILE supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql ---
-- ============================================================================
-- P0：删除 7 条「全开」RLS 策略
-- ============================================================================
-- 问题根源：
--   06_核心表启用RLS基线_enable_all_rls.sql 已经写好了正确的策略，但之后有人在
--   Supabase Dashboard 里手动加了 7 条 USING (true) 的「全开」策略。
--   PostgreSQL 的 PERMISSIVE 策略是 **OR 关系** —— 只要有一条 true，
--   旁边写得再严也完全失效。
--
--   结果：9 张表 RLS 全部 enabled = true，看起来「有防护」，
--         实际任何登录用户都能读写全库数据。
--
-- 本迁移做的事：
--   1. 删除 7 条危险策略（P0）
--   2. 收紧 friend_requests 的「处理收到的请求」（P1）
--   3. 清理重复策略，每表每命令只保留 1 条（P2）
--
-- 执行前请先备份 / 确认：
--   本迁移只 DROP POLICY，不动数据。但删错策略会导致前端功能静默失败
--   （Supabase 对 RLS 拦截不报错，只返回空数组）。
--   建议：先在测试库跑一遍，用 App 走一遍「发消息 / 收消息 / 打卡 / 加好友」流程。
--
-- 幂等性：全部 DROP POLICY IF EXISTS，可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. messages：删除 4 条「Allow logged-in users to ...」
-- ---------------------------------------------------------------------------
-- 这 4 条是灾难级：任何登录用户可读/改/删/冒充全库消息。
-- 删除后由 06_核心表启用RLS基线_enable_all_rls.sql 里的 messages_select_participants 等正确策略接管。
DROP POLICY IF EXISTS "Allow logged-in users to read messages"   ON public.messages;
DROP POLICY IF EXISTS "Allow logged-in users to update messages" ON public.messages;
DROP POLICY IF EXISTS "Allow logged-in users to delete messages" ON public.messages;
DROP POLICY IF EXISTS "Allow logged-in users to insert messages" ON public.messages;

-- 清理重复策略（保留 06_核心表启用RLS基线_enable_all_rls.sql 里的英文命名版本）
DROP POLICY IF EXISTS "只看相关的消息"   ON public.messages;
DROP POLICY IF EXISTS "只能发送自己的消息" ON public.messages;
DROP POLICY IF EXISTS "允许修改自己的消息" ON public.messages;

-- ---------------------------------------------------------------------------
-- 2. health_records：删除 2 条「全开」
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow All"    ON public.health_records;
DROP POLICY IF EXISTS "查看打卡记录" ON public.health_records;

-- 清理重复策略（缺 WITH CHECK，保留 health_records_manage_own）
DROP POLICY IF EXISTS "更新自己的打卡" ON public.health_records;

-- ---------------------------------------------------------------------------
-- 3. friend_requests：删除 1 条「全开」+ 收紧越权更新
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Enable all for friend_requests" ON public.friend_requests;

-- P1 越权：原策略 USING 含 sender_id，意味着**发送方可以自己批准自己的请求**，
--    绕过对方同意直接建立好友关系。
--    改为：只有 receiver_id 能改状态（同意/拒绝）。
DROP POLICY IF EXISTS "处理收到的请求" ON public.friend_requests;
CREATE POLICY "friend_requests_update_receiver"
ON public.friend_requests
FOR UPDATE
TO authenticated
USING (auth.uid() = receiver_id)
WITH CHECK (auth.uid() = receiver_id);

-- 补齐 SELECT / INSERT / DELETE（原策略名是中文，这里统一为英文命名）
DROP POLICY IF EXISTS "查看自己的请求" ON public.friend_requests;
CREATE POLICY "friend_requests_select_participants"
ON public.friend_requests
FOR SELECT
TO authenticated
USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

DROP POLICY IF EXISTS "发送请求" ON public.friend_requests;
CREATE POLICY "friend_requests_insert_own"
ON public.friend_requests
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = sender_id);

DROP POLICY IF EXISTS "删除请求" ON public.friend_requests;
CREATE POLICY "friend_requests_delete_participants"
ON public.friend_requests
FOR DELETE
TO authenticated
USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

-- ---------------------------------------------------------------------------
-- 4. friends：清理重复策略（逻辑本来就对，只是每命令 2-3 条）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view their friends." ON public.friends;
DROP POLICY IF EXISTS "查看自己的好友"               ON public.friends;
DROP POLICY IF EXISTS "Users can add friends."       ON public.friends;
DROP POLICY IF EXISTS "添加好友记录"                 ON public.friends;

-- ---------------------------------------------------------------------------
-- 5. profiles：清理重复策略
-- ---------------------------------------------------------------------------
-- SELECT 全开是**有意为之**（搜人需要读别人的 nickname / sync_id），
--       保留 profiles_select_all。但 expo_push_token / public_key 也一起暴露了，
--       理想做法是建只含公开字段的 view（P3，见 docs/DB_SCHEMA_REFERENCE.md 第 11 节）。
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "允许查看所有人资料"                        ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile."       ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile."             ON public.profiles;

-- 补齐 INSERT（原策略 "Users can insert their own profile." 已被上面删除，
-- 必须重建，否则注册时写 profile 会被 RLS 静默拦截）
CREATE POLICY "profiles_insert_own"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- 6. 确认所有表 RLS 已启用（幂等，重复执行无副作用）
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friends         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moments         ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 7. 自检：执行完后跑这段，确认没有残留的 USING (true) 危险策略
-- ---------------------------------------------------------------------------
-- 期望结果：只剩 profiles 的 SELECT 一条（有意为之），其余表不应出现 true。
--
--   SELECT schemaname, tablename, policyname, cmd, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (qual = 'true' OR with_check = 'true')
--   ORDER BY tablename, cmd;

-- --- END OF FILE supabase/migrations/08_删除7条全开RLS策略_core_rls_policies.sql ---
