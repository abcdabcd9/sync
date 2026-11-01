-- --- START OF FILE supabase/migrations/15_收紧profiles敏感列读取_restrict_profiles_sensitive_columns.sql ---
-- ============================================================================
-- H-2：profiles 表敏感列（expo_push_token / public_key）对全站登录用户可读
-- ============================================================================
-- 问题：
--   06_核心表启用RLS基线_enable_all_rls.sql 中 profiles_select_all 为
--     FOR SELECT TO authenticated USING (true);
--   11_补齐7张表GRANT授权_grant_table_privileges.sql 中
--     GRANT SELECT ON public.profiles TO authenticated;   -- 整表
--     GRANT SELECT ON public.profiles TO anon;            -- 整表
--
--   两层叠加的结果：任何登录用户（甚至未登录的 anon）执行
--     select * from profiles;
--   即可拿到**全站所有用户**的：
--     · expo_push_token —— Expo 推送令牌，可被第三方推送服务滥用
--     · public_key      —— 预留的端到端加密公钥
--
--   08_删除7条全开RLS策略_core_rls_policies.sql 的注释里已把它标为 P3，
--   但开源后暴露面扩大，应视为 P1 处理。
--
-- 为什么不能简单收紧 RLS 行策略：
--   前端有 3 处**必须跨用户读 profiles**，收紧行策略会直接打断功能：
--     1. src/app/chat/search.js:62        按 sync_id 搜人（读任意人的 nickname）
--     2. src/hooks/chat/useChatList.js:183 批量读好友昵称
--     3. src/hooks/useHealthData.js:156    反向查「谁把我设为搭子」
--                                          .eq('bound_partner_id', user.id)
--   所以行级 USING (true) 必须保留。
--
-- 本迁移的方案：列级权限（PostgreSQL 原生能力）
--   把「整表 SELECT」降级为「仅公开列的 SELECT」。
--   行策略不变，跨用户读仍然可用；但敏感列在表级权限层就被拒绝，
--   即使写 select * 也只会报 permission denied for column。
--
--   这是比「建公开视图」更轻量的做法：
--     · 不需要改任何前端代码（前端从未查询过这两个列，已全量 grep 确认）
--     · 不需要维护视图与基表的字段同步
--     · 不改变 PostgREST 的 schema 缓存行为
--
-- 敏感列的唯一合法访问路径：
--   · service_role（Edge Function send-push 用 adminClient 读 expo_push_token）
--     —— service_role 拥有表级 ALL 权限，不受列级 GRANT 限制
--   · 本人写自己的 token（UPDATE 权限单独授予，见下）
--
-- 幂等性：REVOKE / GRANT 均可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 收回 authenticated / anon 的整表 SELECT
-- ---------------------------------------------------------------------------
-- 注意：必须先 REVOKE 整表权限，否则列级 GRANT 会被整表权限覆盖
--       （PostgreSQL 中表级 SELECT 隐含所有列，列级 GRANT 无法「减去」列）
REVOKE SELECT ON public.profiles FROM authenticated;
REVOKE SELECT ON public.profiles FROM anon;

-- ---------------------------------------------------------------------------
-- 2. 只授予公开列
-- ---------------------------------------------------------------------------
-- 公开列清单依据：全量 grep 前端所有 .from('profiles').select(...) 调用
--   src/app/account_info.js:96   id, username, sync_id, nickname, last_id_modified_at
--   src/app/account_info.js:154  nickname, username
--   src/app/account_info.js:232  id, username, sync_id, nickname, last_id_modified_at, bound_partner_id
--   src/app/chat/chat_settings.js:37   id, nickname, username, sync_id
--   src/app/chat/search.js:63          id, username, nickname
--   src/app/chat_room.js:57            nickname, username
--   src/app/invite_friend.js:37        id, username
--   src/app/bind_partner.js:119        bound_partner_id
--   src/app/bind_partner.js:148        id, username
--   src/hooks/chat/useChatList.js:183  id, username, nickname, sync_id
--   src/hooks/chat/useChatList.js:199  id, username, nickname
--   src/hooks/useHealthData.js:108     id, username, sync_id, nickname, bound_partner_id
--   src/hooks/useHealthData.js:156     id
--   src/hooks/useHealthData.js:277     bound_partner_id
--   src/hooks/useHealthData.js:284     id
--   src/hooks/profile/useProfileCache.js:85  id, username, sync_id, nickname
--
-- 排除的敏感列：
--   · expo_push_token —— 仅 service_role 可读（send-push Edge Function）
--   · public_key      —— 当前无任何读取方，预留列，暂不授予
GRANT SELECT (
  id,
  username,
  nickname,
  sync_id,
  avatar_url,
  motto,
  bound_partner_id,
  last_id_modified_at,
  created_at
) ON public.profiles TO authenticated;

-- anon 只用于「未登录时搜人」的极少数场景，同样只给公开列
GRANT SELECT (
  id,
  username,
  nickname,
  sync_id,
  avatar_url,
  motto,
  bound_partner_id,
  last_id_modified_at,
  created_at
) ON public.profiles TO anon;

-- ---------------------------------------------------------------------------
-- 3. 保留写权限（本人写自己的行，由 RLS profiles_update_own 兜底）
-- ---------------------------------------------------------------------------
-- UPDATE 必须保留整表权限：PostgREST 的 update({ expo_push_token: token })
-- 需要该列的 UPDATE 权限。行级 RLS 已限制为 auth.uid() = id，无法越权改他人。
GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;

-- service_role 保持 ALL（Edge Function 需要读 expo_push_token）
GRANT ALL ON public.profiles TO service_role;

-- ---------------------------------------------------------------------------
-- 4. 已知残留风险（本迁移不解决，需后续迭代）
-- ---------------------------------------------------------------------------
-- bound_partner_id 仍是公开列，因为前端有两处必须反向查询：
--   src/hooks/useHealthData.js:156  .eq('bound_partner_id', user.id)
--   src/hooks/useHealthData.js:284  同上
-- 在行级 USING (true) 下，任何登录用户都能执行：
--   select id, bound_partner_id from profiles where bound_partner_id is not null;
-- 从而推断出「谁和谁是搭子」的关系图谱。
--
-- 彻底修复需要把反向查询改为 SECURITY DEFINER RPC，例如：
--   create function public.get_my_partner_id() returns uuid
--   language sql stable security definer set search_path = public, pg_temp
--   as $$ select id from public.profiles where bound_partner_id = auth.uid() limit 1 $$;
-- 然后前端改为 supabase.rpc('get_my_partner_id')，再把 bound_partner_id
-- 从公开列清单中移除。这属于 M 级改动，需同步改前端，故不在本迁移内。
--
-- ---------------------------------------------------------------------------
-- 5. 验证（执行后可手动跑，确认敏感列已不可读）
-- ---------------------------------------------------------------------------
-- 以普通登录用户身份执行以下语句，应当报错：
--   select expo_push_token from profiles limit 1;
--   → ERROR: permission denied for table profiles (column expo_push_token)
--
-- 以下语句应当正常返回：
--   select id, nickname, sync_id from profiles limit 1;
--
-- 检查列级授权：
--   select column_name, privilege_type
--   from information_schema.column_privileges
--   where table_name = 'profiles' and grantee = 'authenticated'
--   order by column_name;
-- ============================================================================
-- --- END OF FILE supabase/migrations/15_收紧profiles敏感列读取_restrict_profiles_sensitive_columns.sql ---
