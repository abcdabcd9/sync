-- --- START OF FILE supabase/migrations/25_收紧profiles写权限_restrict_profiles_update_columns.sql ---
-- ============================================================================
-- TASK-P0.2 / T6.1 FIX-02：收紧 profiles 的客户端写权限
-- ============================================================================
-- 背景（GPT A07 的残留缺口）：
--   迁移 15 收紧了 profiles 的 **SELECT** 列权限（anon 不再能读 bound_partner_id），
--   但第 109 行仍然是整表写授权：
--       GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
--
--   整表 UPDATE 意味着客户端可以直写任意列，包括：
--     · bound_partner_id —— 伪造「我的健康搭子是谁」的展示状态。
--       虽然迁移 20 已把健康记录读取改为基于 partner_authorizations
--       （get_active_partner_id()），bound_partner_id 不再是授权依据，
--       但它仍被旧 UI 用于展示，客户端可写会造成「展示与授权事实不一致」，
--       也会让用户误以为自己已绑定/已解绑。
--     · public_key —— 端到端加密公钥，被篡改会导致加密消息无法解密。
--     · created_at / id —— 身份与时间线字段。
--
-- 本迁移的策略（不改变正常 UX）：
--   A. 收回 authenticated 对 profiles 的整表 UPDATE，改为列级白名单：
--        nickname, sync_id, last_id_modified_at, expo_push_token
--      这四列正是客户端真实业务会写的列（见下方「客户端实际写入点」）。
--   B. bound_partner_id 只能由 SECURITY DEFINER RPC 写入
--      （accept_partner_invite / revoke_partner_authorization / unbind_partner）。
--   C. INSERT / DELETE 保持原状（注册由触发器 handle_new_user 完成，
--      注销走服务端流程），不在本次范围内改动。
--
-- 客户端实际写入点（已核对源码）：
--   · src/app/account_info.js:362   update({ nickname }) 或 update({ sync_id, last_id_modified_at })
--   · src/hooks/usePushNotifications.js:57  update({ expo_push_token: token })
--   · src/hooks/useAuth.js:134      update({ expo_push_token: null })
--   以上全部落在白名单内，不会因本迁移失败。
--
-- 幂等性：REVOKE / GRANT 均可重复执行。
-- 不修改历史迁移 01–19，不触碰既有数据行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 收回整表 UPDATE，按列重授
-- ---------------------------------------------------------------------------
-- 注意：必须先 REVOKE 整表 UPDATE，否则列级 GRANT 无法「减去」列
--       （PostgreSQL 中表级 UPDATE 隐含所有列）。
REVOKE UPDATE ON public.profiles FROM authenticated;

-- 客户端真实业务需要的可写列
GRANT UPDATE (
  nickname,
  sync_id,
  last_id_modified_at,
  expo_push_token
) ON public.profiles TO authenticated;

-- 说明：
--   · bound_partner_id 不在白名单内 —— 只能由 SECURITY DEFINER RPC 写入。
--   · public_key / avatar_url / motto 等展示列当前客户端无写入路径，
--     如后续需要，应在此显式追加并同步更新本注释。
--   · service_role 保持表级 ALL（迁移 15 已授予），不受列级限制影响。

-- ---------------------------------------------------------------------------
-- 2. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT column_name
-- FROM information_schema.column_privileges
-- WHERE table_schema='public' AND table_name='profiles'
--   AND grantee='authenticated' AND privilege_type='UPDATE'
-- ORDER BY column_name;
-- 期望：expo_push_token, last_id_modified_at, nickname, sync_id
--       （不含 bound_partner_id / public_key / id / created_at）

-- --- END OF FILE supabase/migrations/25_收紧profiles写权限_restrict_profiles_update_columns.sql ---
