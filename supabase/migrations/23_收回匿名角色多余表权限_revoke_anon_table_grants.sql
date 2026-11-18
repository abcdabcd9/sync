-- --- START OF FILE supabase/migrations/23_收回匿名角色多余表权限_revoke_anon_table_grants.sql ---
-- ============================================================================
-- TASK-P0.2 / Batch A：收回 anon 对敏感业务表的多余表级权限
-- ============================================================================
-- 现状（迁移 11 遗留）：
--   11_补齐7张表GRANT授权_grant_table_privileges.sql 对 anon 授予了
--   health_records / messages 等表的表级 SELECT。
--
--   但这两张表**没有任何 anon 的 RLS 策略**（策略全部 TO authenticated），
--   所以 anon 实际读到的是空集 —— 数据没有泄露。
--
--   问题在于「纵深防御」：
--     · 表级 GRANT 是第 1 层，RLS 是第 2 层。当前只有第 2 层在挡。
--     · 一旦将来有人误加一条 `TO public USING (true)` 的 SELECT 策略，
--       anon 立刻就能读到全部健康记录与聊天消息。
--     · 最小权限原则要求：不需要的权限就不该授予。
--
-- 本迁移：
--   · 收回 anon 对 health_records / messages / friends / friend_requests /
--     partner_authorizations 的全部权限。
--   · 保留 anon 对 profiles 的「公开列」SELECT（未登录搜人需要，
--     见迁移 15 的列级授权，不含 expo_push_token / public_key）。
--   · 保留 anon 对 complaints 的 INSERT（未登录用户提交投诉是既有产品行为，
--     由 complaints_insert_own 策略要求 auth.uid() = reporter_id，
--     实际 anon 无法满足，故一并收回更安全）。
--
-- 幂等性：REVOKE 可重复执行。
-- 不修改历史迁移文件。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 收回 anon 对业务表的全部权限
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.health_records        FROM anon;
REVOKE ALL ON public.messages              FROM anon;
REVOKE ALL ON public.friends               FROM anon;
REVOKE ALL ON public.friend_requests       FROM anon;
REVOKE ALL ON public.partner_authorizations FROM anon;
REVOKE ALL ON public.complaints            FROM anon;
REVOKE ALL ON public.moments               FROM anon;

-- ---------------------------------------------------------------------------
-- 2. profiles：只保留公开列的 SELECT（迁移 15 已按列授权，这里确保没有整表残留）
-- ---------------------------------------------------------------------------
-- 先收回整表（若存在），再按列重授，避免整表权限隐含所有列。
--
-- T6/A07：不再向 anon 授予 bound_partner_id。
--   该列是旧授权模型的「兼容展示列」，已不参与任何授权判定（见迁移 20）。
--   未登录用户没有任何理由读取任意用户的搭子指针 —— 它既泄露社交关系，
--   又给旧客户端留下「用指针推断授权」的错误路径。因此从 anon 公开列中移除。
REVOKE SELECT ON public.profiles FROM anon;
GRANT SELECT (
  id,
  username,
  nickname,
  sync_id,
  avatar_url,
  motto,
  last_id_modified_at,
  created_at
) ON public.profiles TO anon;

-- ---------------------------------------------------------------------------
-- 3. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT 'health_records' AS t, has_table_privilege('anon','public.health_records','SELECT') AS anon_can
-- UNION ALL SELECT 'messages',        has_table_privilege('anon','public.messages','SELECT')
-- UNION ALL SELECT 'friends',         has_table_privilege('anon','public.friends','SELECT')
-- UNION ALL SELECT 'friend_requests', has_table_privilege('anon','public.friend_requests','SELECT')
-- UNION ALL SELECT 'partner_auth',    has_table_privilege('anon','public.partner_authorizations','SELECT');
-- 期望：全部 false。
--
-- SELECT has_column_privilege('anon','public.profiles','nickname','SELECT') AS anon_nickname,
--        has_column_privilege('anon','public.profiles','expo_push_token','SELECT') AS anon_push_token;
-- 期望：anon_nickname = true，anon_push_token = false。

-- --- END OF FILE supabase/migrations/23_收回匿名角色多余表权限_revoke_anon_table_grants.sql ---
