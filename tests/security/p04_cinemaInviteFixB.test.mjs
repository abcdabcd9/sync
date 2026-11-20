// --- START OF FILE tests/security/p04_cinemaInviteFixB.test.mjs ---
// ============================================================================
// TASK-P0.4 / FIX-B —— 放映厅邀请卡片状态更新：客户端契约测试
//
// 背景（P04-BUG-02）：
//   关闭放映厅时，客户端直接 `UPDATE messages SET subtype='SYNC_CINEMA_ENDED'`，
//   但 authenticated 角色**没有** messages.subtype 的 UPDATE 权限（迁移 21 列级
//   授权 + 迁移 28 触发器），于是报 `permission denied for table messages`，
//   卡片状态永远无法更新。
//
// 本测试锁定 FIX-B 的客户端契约（不联网、不连真实 DB）：
//   P04-FIXB-01：useCinema.closePlayer 不再直接 UPDATE subtype，而是调用
//                批量 RPC `end_cinema_invites_by_room`（源码静态断言）。
//   P04-FIXB-02：RPC 调用参数名必须是 p_room_id，且以当前 roomId 精确定位。
//   P04-FIXB-03：useChatMessages 同时存在「接收方」与「发送方」两条 UPDATE
//                Realtime 订阅，且均为单列等值 filter（不使用 OR 语法）。
//   P04-FIXB-04：迁移草案包含 SECURITY DEFINER RPC + 仅授予 authenticated，
//                且不向 authenticated 授予 subtype UPDATE。
//   P04-FIXB-05：单卡片 RPC 负向安全约束（id+user_id 双限定、统一 RETURN 0）。
//   P04-FIXB-06：批量 RPC 负向安全约束（roomId+user_id 双限定、只处理合法
//                起点、幂等、不授予 anon、不泄露存在性）。
//
// 说明：本文件是「源码契约」测试，真实 DB 行为由
//       tests/security/fixB_cinemaInviteStatus.test.sql 在真实 PostgreSQL 隔离环境验证。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------------------
// P04-FIXB-01：closePlayer 不再直接 UPDATE subtype，改为调用批量 RPC
//
// L4 第六批第 2 项：同一 roomId 可能对应多张邀请卡片（invite_friend.js 每次
//   点击「邀请」都插入新消息，text 始终是同一个 roomId）。因此必须结束该
//   roomId 下**全部**合法邀请卡片，改为调用批量 RPC `end_cinema_invites_by_room`。
// ---------------------------------------------------------------------------
test('P04-FIXB-01 useCinema 不再直接 UPDATE messages.subtype，改为调用 end_cinema_invites_by_room RPC', () => {
  const src = read('src/hooks/useCinema.js');

  // 必须调用批量 RPC
  assert.match(
    src,
    /supabase\.rpc\(\s*['"]end_cinema_invites_by_room['"]/,
    'closePlayer 必须调用 supabase.rpc(\'end_cinema_invites_by_room\', ...)'
  );

  // 不得再出现「.update({ subtype: ... })」这种直接写 subtype 的调用
  assert.doesNotMatch(
    src,
    /\.update\(\s*\{\s*subtype\s*:/,
    'closePlayer 不得再直接 UPDATE subtype（authenticated 无该列权限）'
  );

  // 不得再出现 .from('messages').update(...) 的写法（FIX-B 后应只读 + RPC）
  assert.doesNotMatch(
    src,
    /\.from\(\s*['"]messages['"]\s*\)\s*\.update\(/,
    'closePlayer 不得再对 messages 直接 update'
  );
});

// ---------------------------------------------------------------------------
// P04-FIXB-02：批量 RPC 参数名 p_room_id，且以当前 roomId 精确定位
//
// L4 第五批修正 1：禁止「最近一条邀请卡片」兜底（会误结束其它放映厅的邀请）。
// L4 第六批第 2 项：改为按 roomId 批量结束，RPC 内部限定
//   user_id = auth.uid() + type = 'cinema_invite' + text = roomId，
//   只处理 subtype ∈ (NULL, 'SYNC_CINEMA_INVITE') 的行，幂等。
// ---------------------------------------------------------------------------
test('P04-FIXB-02 批量 RPC 参数为 p_room_id，且以当前 roomId 精确定位（无兜底）', () => {
  const src = read('src/hooks/useCinema.js');

  assert.match(
    src,
    /p_room_id\s*:\s*cinemaRoomId/,
    'RPC 必须传 { p_room_id: cinemaRoomId }'
  );

  // 负向：不得再出现「最近一条」兜底（order by created_at desc + limit 1 取最新）
  assert.doesNotMatch(
    src,
    /order\(\s*['"]created_at['"]\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/,
    '不得使用「按 created_at 倒序取最新一条」的兜底定位（会误结束其它邀请）'
  );
  // 负向：不得出现仅按 user_id 定位的兜底查询（缺少 roomId 约束）
  assert.doesNotMatch(
    src,
    /\.eq\(\s*['"]type['"]\s*,\s*['"]cinema_invite['"]\s*\)\s*\.eq\(\s*['"]user_id['"]/,
    '不得出现「type + user_id」但缺少 roomId 的兜底查询'
  );
  // 负向：不得再出现单卡片 RPC（已升级为批量版本）
  assert.doesNotMatch(
    src,
    /supabase\.rpc\(\s*['"]end_cinema_invite['"]/,
    '不得再调用单卡片 RPC（已升级为 end_cinema_invites_by_room）'
  );
});

// ---------------------------------------------------------------------------
// P04-FIXB-03：Realtime 双方向 UPDATE 订阅（接收方 + 发送方），无 OR filter
// ---------------------------------------------------------------------------
test('P04-FIXB-03 useChatMessages 具备接收方与发送方两条 UPDATE 订阅且无 OR filter', () => {
  const src = read('src/hooks/chat/useChatMessages.js');

  // 接收方方向：receiver_id=eq.<me>
  assert.match(
    src,
    /event:\s*['"]UPDATE['"][^}]*filter:\s*`receiver_id=eq\.\$\{user\.id\}`/s,
    '必须存在 receiver_id=eq.<me> 的 UPDATE 订阅（接收方方向）'
  );

  // 发送方方向：user_id=eq.<me>
  assert.match(
    src,
    /event:\s*['"]UPDATE['"][^}]*filter:\s*`user_id=eq\.\$\{user\.id\}`/s,
    '必须存在 user_id=eq.<me> 的 UPDATE 订阅（发送方方向，FIX-B 新增）'
  );

  // 不得使用未经验证的 OR filter 语法（如 `or=(...)` 或 `user_id.eq.x,receiver_id.eq.y`）
  assert.doesNotMatch(
    src,
    /filter:\s*`[^`]*\bor\b[^`]*`/i,
    'Realtime filter 不得使用 OR 语法（L4 明确禁止未经验证的 OR filter）'
  );
  assert.doesNotMatch(
    src,
    /filter:\s*`[^`]*,[^`]*`/,
    'Realtime filter 不得使用逗号拼接的多条件（PostgREST or 语法）'
  );
});

// ---------------------------------------------------------------------------
// P04-FIXB-04：迁移草案的安全属性
// ---------------------------------------------------------------------------
test('P04-FIXB-04 迁移草案含 SECURITY DEFINER RPC 且不放宽 authenticated subtype 权限', () => {
  const sql = read('.internal/refactor/tasks/P0/TASK-P0.4/fix-b/29_DRAFT_cinema_invite_status_transition.sql');

  // RPC 定义 + SECURITY DEFINER + search_path 固化
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.end_cinema_invite\(/, '必须定义 end_cinema_invite');
  assert.match(sql, /SECURITY DEFINER/, 'RPC 必须是 SECURITY DEFINER');
  // L4 第五批修正 3：search_path 必须收紧为 pg_catalog, pg_temp（不再包含 public）
  assert.match(
    sql,
    /SET search_path\s*=\s*pg_catalog,\s*pg_temp/,
    'SECURITY DEFINER 必须收紧 search_path 为 pg_catalog, pg_temp'
  );
  assert.doesNotMatch(
    sql,
    /SET search_path\s*=\s*public\s*,/,
    'SECURITY DEFINER 的 search_path 不得包含 public（防同名对象劫持）'
  );

  // 只授予 authenticated 执行权
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.end_cinema_invite\(UUID\) TO authenticated/, '必须仅授予 authenticated 执行权');
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.end_cinema_invite\(UUID\) FROM PUBLIC/, '必须先收回 PUBLIC 执行权');

  // 红线：不得向 authenticated 授予 subtype UPDATE
  assert.doesNotMatch(
    sql,
    /GRANT\s+UPDATE\s*\([^)]*subtype[^)]*\)\s+ON\s+public\.messages\s+TO\s+authenticated/i,
    '不得向 authenticated 授予 subtype UPDATE（红线）'
  );
  // 必须显式收回 authenticated 的 subtype UPDATE
  assert.match(
    sql,
    /REVOKE\s+UPDATE\s*\(subtype\)\s+ON\s+public\.messages\s+FROM\s+authenticated/i,
    '必须显式 REVOKE authenticated 的 subtype UPDATE'
  );

  // 触发器必须同时放行「存量 NULL」与「新 INVITE」两种起点
  assert.match(sql, /OLD\.subtype IS NULL[\s\S]{0,120}OLD\.type\s*=\s*'cinema_invite'[\s\S]{0,120}NEW\.subtype\s*=\s*'SYNC_CINEMA_ENDED'/, '触发器必须放行存量卡片 NULL→ENDED');
  assert.match(sql, /OLD\.subtype\s*=\s*'SYNC_CINEMA_INVITE'[\s\S]{0,80}NEW\.subtype\s*=\s*'SYNC_CINEMA_ENDED'/, '触发器必须放行新卡片 INVITE→ENDED');
});

// ---------------------------------------------------------------------------
// P04-FIXB-05：RPC 负向安全约束（不扩大权限 / 不泄露存在性 / 不越权）
//
// L4 第五批修正 2 要求：
//   · 查询同时限定 id 与 user_id = auth.uid()，未命中统一 RETURN 0；
//   · 不得通过异常区分「不存在」「非本人」「非邀请卡片」；
//   · 只改 subtype 一列；
//   · 不向 anon 授予执行权。
// ---------------------------------------------------------------------------
test('P04-FIXB-05 RPC 负向约束：同时限定 id+user_id、统一 RETURN 0、不授予 anon', () => {
  const sql = read('.internal/refactor/tasks/P0/TASK-P0.4/fix-b/29_DRAFT_cinema_invite_status_transition.sql');

  // 取出 RPC 函数体（从 CREATE ... end_cinema_invite 到其 $$; 结束）
  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.end_cinema_invite(');
  assert.ok(fnStart >= 0, '必须存在 end_cinema_invite 定义');
  const fnEnd = sql.indexOf('$$;', fnStart);
  assert.ok(fnEnd > fnStart, 'RPC 函数体必须正确闭合');
  const body = sql.slice(fnStart, fnEnd);

  // 1) 定位查询必须同时限定 id 与 user_id
  assert.match(
    body,
    /WHERE\s+id\s*=\s*p_message_id\s+AND\s+user_id\s*=\s*v_uid/s,
    'RPC 查询必须同时限定 id 与 user_id = auth.uid()'
  );

  // 2) UPDATE 语句同样必须同时限定 id 与 user_id
  assert.match(
    body,
    /UPDATE\s+public\.messages[\s\S]{0,200}WHERE\s+id\s*=\s*p_message_id\s+AND\s+user_id\s*=\s*v_uid/s,
    'RPC 的 UPDATE 必须同时限定 id 与 user_id'
  );

  // 3) 未命中必须 RETURN 0，而不是 RAISE（不泄露存在性）
  assert.match(body, /IF NOT FOUND THEN\s+RETURN 0;/s, '未命中必须 RETURN 0');
  assert.doesNotMatch(
    body,
    /IF NOT FOUND THEN\s+RAISE/s,
    '未命中不得 RAISE（避免通过异常探测消息存在性）'
  );

  // 4) 只改 subtype 一列（UPDATE 的 SET 子句内不得出现其它列）
  const setClause = body.match(/UPDATE\s+public\.messages\s+SET\s+([\s\S]*?)\s+WHERE/s);
  assert.ok(setClause, 'RPC 必须包含 UPDATE ... SET 子句');
  assert.match(setClause[1], /^\s*subtype\s*=\s*'SYNC_CINEMA_ENDED'\s*$/, 'SET 子句只允许修改 subtype 一列');

  // 5) 不得向 anon 授予执行权
  assert.doesNotMatch(
    sql,
    /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.end_cinema_invite\(UUID\)\s+TO\s+anon/i,
    '不得向 anon 授予 RPC 执行权'
  );
  // 6) 必须先 REVOKE PUBLIC 再 GRANT authenticated（顺序保证）
  const revokeIdx = sql.search(/REVOKE ALL ON FUNCTION public\.end_cinema_invite\(UUID\) FROM PUBLIC/);
  const grantIdx = sql.search(/GRANT EXECUTE ON FUNCTION public\.end_cinema_invite\(UUID\) TO authenticated/);
  assert.ok(revokeIdx >= 0 && grantIdx > revokeIdx, '必须先 REVOKE PUBLIC 再 GRANT authenticated');
});

// ---------------------------------------------------------------------------
// P04-FIXB-06：批量 RPC 负向安全约束（L4 第六批第 2 项）
//
//   · 只处理 user_id = auth.uid() 的行（接收方/无关账号影响 0 行）；
//   · 只处理 type='cinema_invite' 且 subtype ∈ (NULL, 'SYNC_CINEMA_INVITE')；
//   · 只改 subtype 一列；
//   · 幂等（已 ENDED 不在 WHERE 内）；
//   · 不授予 anon 执行权，且先 REVOKE PUBLIC 再 GRANT authenticated。
// ---------------------------------------------------------------------------
test('P04-FIXB-06 批量 RPC 负向约束：roomId+user_id 双限定、只处理合法起点、不授予 anon', () => {
  const sql = read('.internal/refactor/tasks/P0/TASK-P0.4/fix-b/29_DRAFT_cinema_invite_status_transition.sql');

  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.end_cinema_invites_by_room(');
  assert.ok(fnStart >= 0, '必须存在 end_cinema_invites_by_room 定义');
  const fnEnd = sql.indexOf('$$;', fnStart);
  assert.ok(fnEnd > fnStart, '批量 RPC 函数体必须正确闭合');
  const body = sql.slice(fnStart, fnEnd);

  // 1) SECURITY DEFINER + 收紧 search_path
  assert.match(body, /SECURITY DEFINER/, '批量 RPC 必须是 SECURITY DEFINER');
  assert.match(body, /SET search_path\s*=\s*pg_catalog,\s*pg_temp/, '批量 RPC 必须收紧 search_path');

  // 2) UPDATE 必须同时限定 user_id = auth.uid() + type + text(roomId)
  assert.match(
    body,
    /UPDATE\s+public\.messages[\s\S]{0,300}WHERE\s+user_id\s*=\s*v_uid[\s\S]{0,120}type\s*=\s*'cinema_invite'[\s\S]{0,120}text\s*=\s*p_room_id/s,
    '批量 RPC 的 UPDATE 必须同时限定 user_id + type + text(roomId)'
  );

  // 3) 只处理合法起点（NULL 或 SYNC_CINEMA_INVITE），保证幂等
  assert.match(
    body,
    /AND\s*\(\s*subtype\s+IS\s+NULL\s+OR\s+subtype\s*=\s*'SYNC_CINEMA_INVITE'\s*\)/s,
    '批量 RPC 只处理 subtype ∈ (NULL, SYNC_CINEMA_INVITE) 的行（幂等）'
  );

  // 4) 只改 subtype 一列
  const setClause = body.match(/UPDATE\s+public\.messages\s+SET\s+([\s\S]*?)\s+WHERE/s);
  assert.ok(setClause, '批量 RPC 必须包含 UPDATE ... SET 子句');
  assert.match(setClause[1], /^\s*subtype\s*=\s*'SYNC_CINEMA_ENDED'\s*$/, 'SET 子句只允许修改 subtype 一列');

  // 5) 空 roomId 直接 RETURN 0（不泄露、不误伤）
  assert.match(body, /p_room_id\s+IS\s+NULL\s+OR\s+btrim\(p_room_id\)\s*=\s*''[\s\S]{0,40}RETURN\s+0/s, '空 roomId 必须 RETURN 0');

  // 6) 不授予 anon 执行权
  assert.doesNotMatch(
    sql,
    /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.end_cinema_invites_by_room\(TEXT\)\s+TO\s+anon/i,
    '不得向 anon 授予批量 RPC 执行权'
  );
  // 7) 先 REVOKE PUBLIC 再 GRANT authenticated
  const revokeIdx = sql.search(/REVOKE ALL ON FUNCTION public\.end_cinema_invites_by_room\(TEXT\) FROM PUBLIC/);
  const grantIdx = sql.search(/GRANT EXECUTE ON FUNCTION public\.end_cinema_invites_by_room\(TEXT\) TO authenticated/);
  assert.ok(revokeIdx >= 0 && grantIdx > revokeIdx, '必须先 REVOKE PUBLIC 再 GRANT authenticated（批量 RPC）');
});
// --- END OF FILE tests/security/p04_cinemaInviteFixB.test.mjs ---
