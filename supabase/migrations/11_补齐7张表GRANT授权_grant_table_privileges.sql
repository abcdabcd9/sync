-- --- START OF FILE supabase/migrations/11_补齐7张表GRANT授权_grant_table_privileges.sql ---
-- ============================================================================
-- P0：7 张表缺少 GRANT，导致 App 全部报 permission denied
-- ============================================================================
-- 现象（Metro 日志）：
--   profiles 云端查询失败: permission denied for table profiles
--   Push Token 写入失败: permission denied for table profiles
--   拉取本人 health_records 失败(离线状态) permission denied for table health_records
--
-- 根因：
--   PostgreSQL 的访问控制是**两层**的：
--     第 1 层：表级权限（GRANT SELECT / INSERT / UPDATE / DELETE）
--     第 2 层：行级安全（RLS 策略）
--   两层都必须通过。07_补齐5张核心表_create_core_tables.sql 只建了表 + 索引 + 触发器，
--   08_删除7条全开RLS策略_core_rls_policies.sql 只建了 RLS 策略，**两个脚本都没有 GRANT**。
--
--   结果：authenticated 角色连 SELECT 权限都没有，
--         查询在「表级权限」这一层就被拒绝，RLS 策略根本没机会执行。
--         验证：information_schema.role_table_grants 查不到任何行。
--
-- 为什么之前能用：
--   线上库是手动在 Dashboard 建的，Dashboard 建表时会自动补 GRANT。
--   而用 SQL 脚本重建时，Supabase 不会自动补 —— 必须显式写。
--
-- 本迁移做的事：
--   给 7 张表补上 authenticated / anon / service_role 的标准权限。
--   权限范围与 Supabase Dashboard 建表时的默认值一致。
--
-- 安全说明：
--   GRANT 只是「允许访问这张表」，**真正的数据隔离仍由 RLS 负责**。
--   给 anon 授 SELECT 是安全的：未登录用户受 RLS 限制，只能读到
--   profiles_select_all 允许的公开字段（搜人需要）。
--   service_role 是服务端密钥，绕过 RLS，仅用于 Edge Function。
--
-- 幂等性：GRANT 可重复执行，无副作用。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles：登录用户可读（搜人）/ 可写自己的行
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT ON public.profiles TO anon;
GRANT ALL ON public.profiles TO service_role;

-- ---------------------------------------------------------------------------
-- 2. messages：聊天消息
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;

-- ---------------------------------------------------------------------------
-- 3. friends：好友关系
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friends TO authenticated;
GRANT ALL ON public.friends TO service_role;

-- ---------------------------------------------------------------------------
-- 4. friend_requests：好友请求
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friend_requests TO authenticated;
GRANT ALL ON public.friend_requests TO service_role;

-- ---------------------------------------------------------------------------
-- 5. health_records：健康打卡
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.health_records TO authenticated;
GRANT ALL ON public.health_records TO service_role;

-- ---------------------------------------------------------------------------
-- 6. complaints：投诉
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON public.complaints TO authenticated;
GRANT ALL ON public.complaints TO service_role;

-- ---------------------------------------------------------------------------
-- 7. moments：朋友圈
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moments TO authenticated;
GRANT ALL ON public.moments TO service_role;

-- ---------------------------------------------------------------------------
-- 8. 序列权限（若表用了 serial / identity 列，需要 USAGE）
-- ---------------------------------------------------------------------------
-- 当前 7 张表主键都是 UUID DEFAULT gen_random_uuid()，不依赖序列。
-- 但为兼容未来可能新增的 serial 列，统一授权（无序列时该语句无副作用）。
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT sequence_schema, sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO authenticated',
                   r.sequence_schema, r.sequence_name);
    EXECUTE format('GRANT ALL ON SEQUENCE %I.%I TO service_role',
                   r.sequence_schema, r.sequence_name);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. 自检：执行完后跑这段，确认权限已生效
-- ---------------------------------------------------------------------------
--   SELECT table_name, grantee,
--          string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public'
--     AND grantee IN ('authenticated', 'anon', 'service_role')
--     AND table_name IN ('profiles','messages','friends','friend_requests',
--                        'health_records','complaints','moments')
--   GROUP BY table_name, grantee
--   ORDER BY table_name, grantee;
--
--   期望：每张表都有 authenticated 行，profiles 额外有 anon 行，
--         全部有 service_role 行。

-- --- END OF FILE supabase/migrations/11_补齐7张表GRANT授权_grant_table_privileges.sql ---
