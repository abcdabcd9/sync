-- --- START OF FILE tests/security/t61_concurrency.test.sql ---
-- ============================================================================
-- TASK-P0.2 / T6.1 FIX-06：真实并发测试（独立数据库会话）
-- ============================================================================
-- 目的：
--   验证「一对一授权硬约束」与「配额原子预占」在**真实并发**下仍然成立。
--   与既有 batchA_rls.test.sql / quota_test.sql 的区别：
--     那两个脚本是单会话顺序断言，无法暴露锁竞争与竞态；
--     本脚本由 run_concurrency.sh 驱动，用多个独立 psql 连接同时发起 RPC。
--
-- 覆盖场景：
--   C1. 同一对用户并发互相邀请 → 只允许一条 pending（部分唯一索引）
--   C2. 两个不同邀请者并发邀请同一目标 → 目标只能接受其中一条（成员唯一约束）
--   C3. 同一用户并发预占配额 → 成功次数严格等于上限（行锁 + 计数）
--   C4. 并发 accept 同一邀请 → 只有一次成功，其余失败且状态唯一
--
-- 用法（由 run_concurrency.sh 调用，不直接执行）：
--   psql -v scenario=C1 -v a=<uuid> -v b=<uuid> ...
--
-- 说明：
--   本文件只包含「单个并发参与者」的 SQL 片段，由 shell 脚本并行启动多份。
--   断言在 shell 脚本中通过查询最终状态完成，避免依赖 psql 输出解析。
-- ============================================================================

\set ON_ERROR_STOP off
\pset pager off

-- 场景参数由 -v 传入：
--   scenario : C1 / C2 / C3 / C4
--   actor    : 当前会话扮演的用户 uuid
--   target   : 目标用户 uuid（C1/C2/C4）
--   auth_id  : 授权记录 id（C4）
--   bytes    : 预占字节数（C3）

\if :{?scenario}
\else
  \echo 'ERROR: 必须通过 -v scenario=... 指定场景'
  \quit 1
\endif

-- ---------------------------------------------------------------------------
-- C1：同一对用户并发互相邀请
--   期望：两条 INSERT 中只有一条成功（partner_authorizations_one_pending_per_pair
--         只约束 (requester_id, addressee_id) 方向，因此 A→B 与 B→A 是两条不同
--         记录，都会成功 —— 这正是需要验证的行为：反向 pending 不冲突，
--         但最终 accept 时由成员唯一约束兜底）。
-- ---------------------------------------------------------------------------
\if :'scenario' = 'C1'
  SELECT public.request_partner(:'target'::uuid) AS result;
\endif

-- ---------------------------------------------------------------------------
-- C2：并发邀请同一目标（不同邀请者）
--   期望：两条 pending 都能创建（不同 requester），
--         但目标 accept 其中一条后，另一条 accept 必须失败。
-- ---------------------------------------------------------------------------
\if :'scenario' = 'C2'
  SELECT public.request_partner(:'target'::uuid) AS result;
\endif

-- ---------------------------------------------------------------------------
-- C3：并发预占配额
--   期望：成功（返回非 NULL）的次数严格等于 p_max_requests。
-- ---------------------------------------------------------------------------
\if :'scenario' = 'C3'
  SELECT public.transcribe_quota_reserve(
    :'actor'::uuid,
    :bytes::bigint,
    5,            -- p_max_requests：5 个并发会话，上限 5
    1000000,      -- p_max_bytes
    1000,         -- p_global_max_requests
    100000000,    -- p_global_max_bytes
    60
  ) AS reservation_id;
\endif

-- ---------------------------------------------------------------------------
-- C4：并发 accept 同一邀请
--   期望：只有一次返回 accepted，其余抛错（状态已非 pending）。
-- ---------------------------------------------------------------------------
\if :'scenario' = 'C4'
  SELECT public.accept_partner_invite(:'auth_id'::uuid) AS result;
\endif

-- --- END OF FILE tests/security/t61_concurrency.test.sql ---
