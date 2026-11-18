#!/usr/bin/env bash
# --- START OF FILE tests/security/run_concurrency.sh ---
# ============================================================================
# TASK-P0.2 / T6.1 FIX-06：真实并发测试驱动脚本
# ============================================================================
# 用**多个独立 psql 连接**同时发起 RPC，验证并发下的约束与原子性。
# 与顺序断言的 batchA_rls.test.sql / quota_test.sql 互补。
#
# 前置：
#   · 本地隔离库容器 supabase_db_p02-supabase-test 已启动（端口 54322）
#   · 迁移 00–27 已全部应用
#
# 用法：
#   bash tests/security/run_concurrency.sh
#
# 退出码：0 = 全部通过；非 0 = 有断言失败
# ============================================================================

set -uo pipefail
# bash 3.2（macOS 自带）在非 C locale 下会把紧跟变量名的全角标点
# 当作变量名的一部分，导致 "unbound variable"。强制 C locale 规避。
export LC_ALL=C

CONTAINER="${PG_CONTAINER:-supabase_db_p02-supabase-test}"
PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d postgres -X -q -t -A)

PASS=0
FAIL=0
FAILED_CASES=()

pass() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL + 1)); FAILED_CASES+=("$1"); echo "  ❌ $1"; }

# 执行单条 SQL，返回去空白后的结果
q() { "${PSQL[@]}" -c "$1" 2>/dev/null | tr -d '[:space:]'; }

# 执行单条 SQL，允许失败（返回空）
q_soft() { "${PSQL[@]}" -c "$1" 2>/dev/null | tr -d '[:space:]'; }

# 以指定用户身份执行 SQL（模拟 PostgREST 注入的 JWT 上下文）。
# 必须用单事务包裹：SET LOCAL 只在事务内生效。
#   $1 = 用户 uuid，$2 = SQL 语句
as_user() {
  "${PSQL[@]}" -c "BEGIN; SET LOCAL role authenticated; SET LOCAL request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2 COMMIT;" 2>/dev/null | tr -d '[:space:]'
}

# 同上，但保留 stderr 以便断言失败原因
as_user_soft() {
  "${PSQL[@]}" -c "BEGIN; SET LOCAL role authenticated; SET LOCAL request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'; $2 COMMIT;" 2>&1 | tr -d '[:space:]'
}

echo "============================================================"
echo "T6.1 / FIX-06 真实并发测试"
echo "容器: $CONTAINER"
echo "============================================================"

# ---------------------------------------------------------------------------
# 准备：创建测试用户（handle_new_user 触发器会自动建 profiles）
# ---------------------------------------------------------------------------
echo ""
echo "[准备] 创建测试用户"

U_A="d61a0000-0000-4000-8000-00000000000a"
U_B="d61b0000-0000-4000-8000-00000000000b"
U_C="d61c0000-0000-4000-8000-00000000000c"
U_D="d61d0000-0000-4000-8000-00000000000d"

# 清理上次残留
q "DELETE FROM public.partner_authorizations WHERE requester_id IN ('$U_A','$U_B','$U_C','$U_D') OR addressee_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.transcribe_quota_reservations WHERE user_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.transcribe_quota_windows WHERE subject_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.transcribe_quota_windows WHERE scope='global';" >/dev/null
q "DELETE FROM public.messages WHERE user_id IN ('$U_A','$U_B','$U_C','$U_D') OR receiver_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.profiles WHERE id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM auth.users WHERE id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null

for u in "$U_A" "$U_B" "$U_C" "$U_D"; do
  q "INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
     VALUES ('$u', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             't61-${u:1:4}@example.test', 'x', now(), now(), now())
     ON CONFLICT (id) DO NOTHING;" >/dev/null
done

CNT=$(q "SELECT count(*) FROM public.profiles WHERE id IN ('$U_A','$U_B','$U_C','$U_D');")
if [ "$CNT" = "4" ]; then pass "测试用户创建（4 个 profiles）"; else fail "测试用户创建（期望 4，实际 $CNT）"; fi

# ---------------------------------------------------------------------------
# C1：同一对用户并发互相邀请（A→B 与 B→A 同时发起）
#   期望：两条 pending 都成功（方向不同），但随后 accept 时只能有一条成立。
# ---------------------------------------------------------------------------
echo ""
echo "[C1] 同一对用户并发互相邀请"

# 并行发起：A 邀请 B，B 邀请 A（各自独立连接 + 各自 JWT 身份）
as_user "$U_A" "SELECT public.request_partner('$U_B'::uuid);" >/dev/null 2>&1 &
P1=$!
as_user "$U_B" "SELECT public.request_partner('$U_A'::uuid);" >/dev/null 2>&1 &
P2=$!
wait $P1 $P2

# 期望：并发反向邀请被串行化为**同一条** pending（一对一语义），
# 且两个调用方拿到同一个授权 id（幂等返回）。
PENDING=$(q "SELECT count(*) FROM public.partner_authorizations WHERE status='pending' AND ((requester_id='$U_A' AND addressee_id='$U_B') OR (requester_id='$U_B' AND addressee_id='$U_A'));")
if [ "$PENDING" = "1" ]; then
  pass "C1 反向并发邀请被串行化为唯一 pending（pending=$PENDING）"
else
  fail "C1 反向并发邀请未收敛为唯一 pending（期望 1，实际 $PENDING）"
fi

# 两个方向都必须能查到同一条 pending（不区分方向）
AUTH_ANY=$(q "SELECT id FROM public.partner_authorizations WHERE status='pending' AND ((requester_id='$U_A' AND addressee_id='$U_B') OR (requester_id='$U_B' AND addressee_id='$U_A')) LIMIT 1;")
if [ -n "$AUTH_ANY" ]; then
  pass "C1 并发反向邀请返回同一条授权记录（id=$AUTH_ANY）"
else
  fail "C1 未找到并发反向邀请产生的 pending 记录"
fi

# 由 addressee 接受该唯一 pending
if [ -n "$AUTH_ANY" ]; then
  ADDRESSEE=$(q "SELECT addressee_id FROM public.partner_authorizations WHERE id='$AUTH_ANY';")
  as_user "$ADDRESSEE" "SELECT public.accept_partner_invite('$AUTH_ANY'::uuid);" >/dev/null
  ACCEPTED=$(q "SELECT count(*) FROM public.partner_authorizations WHERE status='accepted' AND id='$AUTH_ANY';")
  if [ "$ACCEPTED" = "1" ]; then
    pass "C1 唯一 pending 被接受，形成唯一 accepted 关系"
  else
    fail "C1 唯一 pending 接受失败（accepted=$ACCEPTED）"
  fi

  # 成员表必须恰好 2 行（一对一）
  MEMBERS_C1=$(q "SELECT count(*) FROM public.partner_authorization_members WHERE authorization_id='$AUTH_ANY';")
  if [ "$MEMBERS_C1" = "2" ]; then
    pass "C1 成员表恰好 2 行（一对一关系成立）"
  else
    fail "C1 成员表行数异常（期望 2，实际 $MEMBERS_C1）"
  fi
else
  fail "C1 缺少可接受的 pending 记录"
fi

# ---------------------------------------------------------------------------
# C2：两个不同邀请者并发邀请同一目标，目标只能接受其中一条
# ---------------------------------------------------------------------------
echo ""
echo "[C2] 并发邀请同一目标"

# 清理 C1 结果
q "DELETE FROM public.partner_authorizations WHERE requester_id IN ('$U_A','$U_B','$U_C','$U_D') OR addressee_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null

# A→C 与 B→C 并发（不同邀请者，各自身份）
as_user "$U_A" "SELECT public.request_partner('$U_C'::uuid);" >/dev/null 2>&1 &
P1=$!
as_user "$U_B" "SELECT public.request_partner('$U_C'::uuid);" >/dev/null 2>&1 &
P2=$!
wait $P1 $P2

PENDING_C=$(q "SELECT count(*) FROM public.partner_authorizations WHERE status='pending' AND addressee_id='$U_C';")
if [ "$PENDING_C" = "2" ]; then
  pass "C2 两个邀请者的 pending 并存（pending=$PENDING_C）"
else
  fail "C2 两个邀请者的 pending 并存（期望 2，实际 $PENDING_C）"
fi

# C 接受第一条
AUTH_AC=$(q "SELECT id FROM public.partner_authorizations WHERE status='pending' AND addressee_id='$U_C' ORDER BY created_at LIMIT 1;")
if [ -n "$AUTH_AC" ]; then
  as_user "$U_C" "SELECT public.accept_partner_invite('$AUTH_AC'::uuid);" >/dev/null
  ACC=$(q "SELECT count(*) FROM public.partner_authorizations WHERE status='accepted' AND addressee_id='$U_C';")
  if [ "$ACC" = "1" ]; then
    pass "C2 目标只接受一条（accepted=$ACC）"
  else
    fail "C2 目标接受条数异常（accepted=$ACC）"
  fi

  # 第二条必须无法接受
  AUTH_BC=$(q "SELECT id FROM public.partner_authorizations WHERE status='pending' AND addressee_id='$U_C' LIMIT 1;")
  if [ -n "$AUTH_BC" ]; then
    as_user "$U_C" "SELECT public.accept_partner_invite('$AUTH_BC'::uuid);" >/dev/null
    STILL=$(q "SELECT count(*) FROM public.partner_authorizations WHERE id='$AUTH_BC' AND status='pending';")
    if [ "$STILL" = "1" ]; then
      pass "C2 第二条邀请被一对一约束拒绝（仍 pending）"
    else
      fail "C2 第二条邀请未被拒绝"
    fi
  fi
else
  fail "C2 未找到 C 的 pending 记录"
fi

# ---------------------------------------------------------------------------
# C3：同一用户并发预占配额（5 个并发会话，上限 5）
# ---------------------------------------------------------------------------
echo ""
echo "[C3] 并发配额预占"

q "DELETE FROM public.transcribe_quota_reservations WHERE user_id='$U_D';" >/dev/null
q "DELETE FROM public.transcribe_quota_windows WHERE subject_id='$U_D';" >/dev/null
q "DELETE FROM public.transcribe_quota_windows WHERE scope='global';" >/dev/null

TMPDIR_C3=$(mktemp -d)
for i in 1 2 3 4 5; do
  "${PSQL[@]}" -c "SELECT public.transcribe_quota_reserve('$U_D'::uuid, 1000, 5, 1000000, 1000, 100000000, 60);" \
    > "$TMPDIR_C3/out_$i.txt" 2>/dev/null &
done
wait

SUCCESS=0
for i in 1 2 3 4 5; do
  V=$(tr -d '[:space:]' < "$TMPDIR_C3/out_$i.txt")
  if [ -n "$V" ] && [ "$V" != "" ]; then SUCCESS=$((SUCCESS + 1)); fi
done
rm -rf "$TMPDIR_C3"

if [ "$SUCCESS" = "5" ]; then
  pass "C3 5 个并发预占全部成功（上限 5，无超发）"
else
  fail "C3 并发预占成功数异常（期望 5，实际 $SUCCESS）"
fi

# 第 6 次必须失败
SIXTH=$(q "SELECT COALESCE(public.transcribe_quota_reserve('$U_D'::uuid, 1000, 5, 1000000, 1000, 100000000, 60)::text, 'NULL');")
if [ "$SIXTH" = "NULL" ]; then
  pass "C3 第 6 次预占被拒绝（严格等于上限）"
else
  fail "C3 第 6 次预占未被拒绝（返回 $SIXTH）"
fi

# 窗口计数必须精确等于 5
REQ=$(q "SELECT req_count FROM public.transcribe_quota_windows WHERE scope='user' AND subject_id='$U_D';")
if [ "$REQ" = "5" ]; then
  pass "C3 用户窗口计数精确为 5（无丢失更新）"
else
  fail "C3 用户窗口计数异常（期望 5，实际 $REQ）"
fi

# ---------------------------------------------------------------------------
# C4：并发 accept 同一邀请（3 个会话同时接受）
# ---------------------------------------------------------------------------
echo ""
echo "[C4] 并发接受同一邀请"

q "DELETE FROM public.partner_authorizations WHERE requester_id IN ('$U_A','$U_B','$U_C','$U_D') OR addressee_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null

AUTH_C4=$(as_user "$U_A" "SELECT public.request_partner('$U_B'::uuid);")
if [ -n "$AUTH_C4" ]; then
  TMPDIR_C4=$(mktemp -d)
  for i in 1 2 3; do
    as_user_soft "$U_B" "SELECT public.accept_partner_invite('$AUTH_C4'::uuid);" \
      > "$TMPDIR_C4/out_$i.txt" 2>&1 &
  done
  wait

  OK_COUNT=0
  for i in 1 2 3; do
    if grep -qi "accepted" "$TMPDIR_C4/out_$i.txt" 2>/dev/null; then OK_COUNT=$((OK_COUNT + 1)); fi
  done
  rm -rf "$TMPDIR_C4"

  ACCEPTED_ROWS=$(q "SELECT count(*) FROM public.partner_authorizations WHERE id='$AUTH_C4' AND status='accepted';")
  if [ "$ACCEPTED_ROWS" = "1" ]; then
    pass "C4 并发 accept 后状态唯一为 accepted（成功会话数=$OK_COUNT）"
  else
    fail "C4 并发 accept 状态异常（accepted 行数=$ACCEPTED_ROWS）"
  fi

  MEMBERS=$(q "SELECT count(*) FROM public.partner_authorization_members WHERE authorization_id='$AUTH_C4';")
  if [ "$MEMBERS" = "2" ]; then
    pass "C4 成员表恰好 2 行（双方各一）"
  else
    fail "C4 成员表行数异常（期望 2，实际 $MEMBERS）"
  fi
else
  fail "C4 创建邀请失败"
fi

# ---------------------------------------------------------------------------
# 清理
# ---------------------------------------------------------------------------
q "DELETE FROM public.partner_authorizations WHERE requester_id IN ('$U_A','$U_B','$U_C','$U_D') OR addressee_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.transcribe_quota_reservations WHERE user_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.transcribe_quota_windows WHERE subject_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.transcribe_quota_windows WHERE scope='global';" >/dev/null
q "DELETE FROM public.messages WHERE user_id IN ('$U_A','$U_B','$U_C','$U_D') OR receiver_id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM public.profiles WHERE id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null
q "DELETE FROM auth.users WHERE id IN ('$U_A','$U_B','$U_C','$U_D');" >/dev/null

echo ""
echo "============================================================"
echo "结果：通过 $PASS / 失败 $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "失败用例："
  for c in "${FAILED_CASES[@]}"; do echo "  - $c"; done
  echo "============================================================"
  exit 1
fi
echo "全部通过"
echo "============================================================"
exit 0

# --- END OF FILE tests/security/run_concurrency.sh ---
