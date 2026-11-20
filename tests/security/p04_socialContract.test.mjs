// --- START OF FILE tests/security/p04_socialContract.test.mjs ---
// ============================================================================
// TASK-P0.4 / 社交关系模块 — 最小契约测试
//
// 目的：P0.3 的 229 个测试集中在 auth / health / isolation / media cache，
//       社交关系（好友删除 / 备注 / 搭子授权撤销）零自动化覆盖。本测试锁定：
//         P04-SOCIAL-01 useFriendActions.deleteFriend：
//                       双向解除 + 只删「与自己相关」的行 + 拒绝删自己；
//         P04-SOCIAL-02 useFriendActions.updateRemark：
//                       只更新「我 → 对方」一条 + 空备注归一化为 null；
//         P04-SOCIAL-03 isAuthEventRelevant / shouldRevokeOnAuthChange：
//                       搭子授权撤销决策（绝不读 payload.old.status，
//                       复验出错不误删，服务端权威为准）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - useFriendActions 通过 stub react/supabase 后运行真实源码，并记录
//     实际下发的查询条件（表名 / or 表达式 / eq 条件 / update payload）。
//   - authRevokeLogic 为零依赖纯函数，直接 import 真实源码。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-social-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const useCallback = (fn) => fn;
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
export const useEffect = () => {};
export const useRef = (v) => ({ current: v });
export default { useCallback, useState, useEffect, useRef };
`,
  });

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/hooks/chat/useFriendActions.js');
  copy('src/hooks/health/authRevokeLogic.js');

  // supabase stub：记录每一次查询链路，便于断言「实际下发的条件」
  //
  // P0.4 FIX-A 起，updateRemark 需要校验「实际影响行数」，因此 stub 必须
  // 支持 `.select()` 并返回可编程的结果集：
  //   __DB__.rows        —— 当前「我 → 对方」行是否存在（决定 UPDATE 命中 0 行还是 1 行）
  //   __DB__.relation    —— 任一方向好友关系是否存在（决定是否允许 UPSERT）
  //   __DB__.upsertFails —— 模拟 UPSERT 被 RLS 拒绝（permission denied）
  const stub = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  stub('src/services/supabase.js', `
export const __calls = [];
export const __DB__ = { rows: 1, relation: 1, upsertFails: false };
function makeBuilder(table) {
  const rec = { table, ops: [], payload: null, select: null };
  __calls.push(rec);
  const b = {
    delete() { rec.ops.push({ op: 'delete' }); return b; },
    update(p) { rec.ops.push({ op: 'update' }); rec.payload = p; return b; },
    upsert(p, opts) { rec.ops.push({ op: 'upsert', opts }); rec.payload = p; return b; },
    or(expr) { rec.ops.push({ op: 'or', expr }); return b; },
    eq(col, val) { rec.ops.push({ op: 'eq', col, val }); return b; },
    limit(n) { rec.ops.push({ op: 'limit', n }); return b; },
    select(cols) { rec.ops.push({ op: 'select', cols }); rec.select = cols; return b; },
    then(resolve) {
      const has = (op) => rec.ops.some((o) => o.op === op);
      let res = { data: null, error: null };
      if (has('upsert')) {
        res = __DB__.upsertFails
          ? { data: null, error: { message: 'permission denied for table friends' } }
          : { data: [{ id: 'row-upserted' }], error: null };
      } else if (has('update')) {
        res = __DB__.rows > 0
          ? { data: [{ id: 'row-updated' }], error: null }
          : { data: [], error: null };
      } else if (has('select')) {
        res = __DB__.relation > 0
          ? { data: [{ id: 'row-relation', user_id: 'user-other', friend_id: 'user-me' }], error: null }
          : { data: [], error: null };
      }
      return Promise.resolve(res).then(resolve);
    },
  };
  return b;
}
export const supabase = { from(table) { return makeBuilder(table); } };
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

// ---------------------------------------------------------------------------
// P04-SOCIAL-01：deleteFriend 契约
// ---------------------------------------------------------------------------
test('P04-SOCIAL-01 deleteFriend 双向解除且只删与自己相关的行', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __calls } = await import('./src/services/supabase.js');
const me = 'user-me';
const other = 'user-other';

// 1) 未登录
__calls.length = 0;
const noUser = await useFriendActions(null).deleteFriend(other);
const callsAfterNoUser = __calls.length;

// 2) 缺 friendId
__calls.length = 0;
const noFriendId = await useFriendActions({ id: me }).deleteFriend('');
const callsAfterNoFriendId = __calls.length;

// 3) 删自己
__calls.length = 0;
const self = await useFriendActions({ id: me }).deleteFriend(me);
const callsAfterSelf = __calls.length;

// 4) 正常删除
__calls.length = 0;
const ok = await useFriendActions({ id: me }).deleteFriend(other);
const calls = JSON.parse(JSON.stringify(__calls));

process.stdout.write(JSON.stringify({ noUser, callsAfterNoUser, noFriendId, callsAfterNoFriendId, self, callsAfterSelf, ok, calls }));
`);
    assert.deepEqual(out.noUser, { ok: false, error: '未登录' });
    assert.equal(out.callsAfterNoUser, 0, '未登录时不得发起任何查询');
    assert.deepEqual(out.noFriendId, { ok: false, error: '缺少好友 ID' });
    assert.equal(out.callsAfterNoFriendId, 0, '缺 friendId 时不得发起任何查询');
    assert.deepEqual(out.self, { ok: false, error: '不能删除自己' });
    assert.equal(out.callsAfterSelf, 0, '删自己时不得发起任何查询');
    assert.deepEqual(out.ok, { ok: true });

    assert.equal(out.calls.length, 2, '正常删除应下发 2 次查询（friends + friend_requests）');

    const friendsCall = out.calls[0];
    assert.equal(friendsCall.table, 'friends', '第一次必须操作 friends 表');
    const friendsOr = friendsCall.ops.find((o) => o.op === 'or');
    assert.ok(friendsOr, 'friends 删除必须带 or 条件');
    assert.ok(friendsOr.expr.includes('and(user_id.eq.user-me,friend_id.eq.user-other)'), '必须包含「我→对方」方向');
    assert.ok(friendsOr.expr.includes('and(user_id.eq.user-other,friend_id.eq.user-me)'), '必须包含「对方→我」方向');

    const reqCall = out.calls[1];
    assert.equal(reqCall.table, 'friend_requests', '第二次必须清理 friend_requests');
    const reqOr = reqCall.ops.find((o) => o.op === 'or');
    assert.ok(reqOr, 'friend_requests 清理必须带 or 条件');
    assert.ok(reqOr.expr.includes('and(sender_id.eq.user-me,receiver_id.eq.user-other)'), '必须包含「我→对方」请求方向');
    assert.ok(reqOr.expr.includes('and(sender_id.eq.user-other,receiver_id.eq.user-me)'), '必须包含「对方→我」请求方向');
    const statusEq = reqCall.ops.find((o) => o.op === 'eq' && o.col === 'status');
    assert.ok(statusEq, 'friend_requests 清理必须限定 status');
    assert.equal(statusEq.val, 'accepted', '仅清理已通过（accepted）的请求');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-SOCIAL-02：updateRemark 契约
// ---------------------------------------------------------------------------
test('P04-SOCIAL-02 updateRemark 只更新我→对方一条且空备注归一化为 null', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __calls, __DB__ } = await import('./src/services/supabase.js');
const me = 'user-me';
const other = 'user-other';

__calls.length = 0;
const noUser = await useFriendActions(null).updateRemark(other, 'x');
const callsAfterNoUser = __calls.length;

__calls.length = 0;
const noFriendId = await useFriendActions({ id: me }).updateRemark('', 'x');
const callsAfterNoFriendId = __calls.length;

__calls.length = 0;
const self = await useFriendActions({ id: me }).updateRemark(me, 'x');
const callsAfterSelf = __calls.length;

// 正常路径：我方行存在 → 只下发 1 次 UPDATE（带 .select('id') 校验行数）
__DB__.rows = 1;
__calls.length = 0;
const withRemark = await useFriendActions({ id: me }).updateRemark(other, '老王');
const callsWithRemark = JSON.parse(JSON.stringify(__calls));

// 空备注归一化
__calls.length = 0;
const emptyRemark = await useFriendActions({ id: me }).updateRemark(other, '');
const callsEmptyRemark = JSON.parse(JSON.stringify(__calls));

// 我方行缺失（关系由对方发起并接受）→ 校验关系后 UPSERT 我方行
__DB__.rows = 0;
__DB__.relation = 1;
__calls.length = 0;
const missingRow = await useFriendActions({ id: me }).updateRemark(other, '老王');
const callsMissingRow = JSON.parse(JSON.stringify(__calls));

// 我方行缺失且无任何合法关系 → 拒绝，绝不凭空创建好友关系
__DB__.rows = 0;
__DB__.relation = 0;
__calls.length = 0;
const noRelation = await useFriendActions({ id: me }).updateRemark(other, '老王');
const callsNoRelation = JSON.parse(JSON.stringify(__calls));

// UPSERT 被 RLS 拒绝 → 必须显式失败，不得假报成功
__DB__.rows = 0;
__DB__.relation = 1;
__DB__.upsertFails = true;
__calls.length = 0;
const upsertDenied = await useFriendActions({ id: me }).updateRemark(other, '老王');
const callsUpsertDenied = JSON.parse(JSON.stringify(__calls));
__DB__.upsertFails = false;

process.stdout.write(JSON.stringify({
  noUser, callsAfterNoUser, noFriendId, callsAfterNoFriendId, self, callsAfterSelf,
  withRemark, callsWithRemark, emptyRemark, callsEmptyRemark,
  missingRow, callsMissingRow, noRelation, callsNoRelation,
  upsertDenied, callsUpsertDenied,
}));
`);
    assert.deepEqual(out.noUser, { ok: false, error: '未登录' });
    assert.equal(out.callsAfterNoUser, 0, '未登录时不得发起查询');
    assert.deepEqual(out.noFriendId, { ok: false, error: '缺少好友 ID' });
    assert.equal(out.callsAfterNoFriendId, 0, '缺 friendId 时不得发起查询');
    assert.deepEqual(out.self, { ok: false, error: '不能给自己设备注' });
    assert.equal(out.callsAfterSelf, 0, '给自己设备注时不得发起查询');

    // ---- 正常路径：命中我方行 ----
    assert.deepEqual(out.withRemark, { ok: true });
    assert.equal(out.callsWithRemark.length, 1, '命中我方行时只下发 1 次查询');
    const c1 = out.callsWithRemark[0];
    assert.equal(c1.table, 'friends');
    const upd = c1.ops.find((o) => o.op === 'update');
    assert.ok(upd, '必须为 update 操作');
    assert.deepEqual(c1.payload, { remark: '老王' }, '备注原样写入');
    const eqs = c1.ops.filter((o) => o.op === 'eq');
    assert.equal(eqs.length, 2, '必须同时限定 user_id 与 friend_id');
    assert.deepEqual(eqs[0], { op: 'eq', col: 'user_id', val: 'user-me' }, '必须限定 user_id = 自己（归属校验）');
    assert.deepEqual(eqs[1], { op: 'eq', col: 'friend_id', val: 'user-other' }, '必须限定 friend_id = 对方');
    const sel = c1.ops.find((o) => o.op === 'select');
    assert.ok(sel, '必须 .select() 取回受影响行以校验行数（禁止 0 行假成功）');
    assert.equal(sel.cols, 'id', '只需取回 id 用于行数校验');

    assert.deepEqual(out.emptyRemark, { ok: true });
    assert.deepEqual(out.callsEmptyRemark[0].payload, { remark: null }, '空备注必须归一化为 null');

    // ---- 我方行缺失：先校验关系，再 UPSERT 我方行 ----
    assert.deepEqual(out.missingRow, { ok: true, created: true }, '我方行缺失时应补建我方视角行');
    assert.equal(out.callsMissingRow.length, 3, '应为 UPDATE → SELECT 关系 → UPSERT 三次查询');
    assert.equal(out.callsMissingRow[0].table, 'friends');
    assert.ok(out.callsMissingRow[0].ops.some((o) => o.op === 'update'), '第 1 步必须是 UPDATE');
    const relCall = out.callsMissingRow[1];
    assert.ok(relCall.ops.some((o) => o.op === 'select'), '第 2 步必须是 SELECT 校验关系');
    const relOr = relCall.ops.find((o) => o.op === 'or');
    assert.ok(relOr, '关系校验必须带 or 条件（双向）');
    assert.ok(relOr.expr.includes('and(user_id.eq.user-me,friend_id.eq.user-other)'), '关系校验必须包含「我→对方」方向');
    assert.ok(relOr.expr.includes('and(user_id.eq.user-other,friend_id.eq.user-me)'), '关系校验必须包含「对方→我」方向');
    const upsertCall = out.callsMissingRow[2];
    const upsertOp = upsertCall.ops.find((o) => o.op === 'upsert');
    assert.ok(upsertOp, '第 3 步必须是 UPSERT');
    assert.deepEqual(upsertOp.opts, { onConflict: 'user_id,friend_id' }, 'UPSERT 必须依赖唯一约束保证幂等');
    assert.deepEqual(upsertCall.payload, { user_id: 'user-me', friend_id: 'user-other', remark: '老王' }, 'UPSERT 只写我方视角行');

    // ---- 无合法关系：拒绝，且不得下发 UPSERT ----
    assert.equal(out.noRelation.ok, false, '无合法好友关系时必须失败');
    assert.equal(out.noRelation.error, '好友关系不存在，无法设置备注');
    assert.equal(out.callsNoRelation.length, 2, '无关系时只允许 UPDATE + SELECT 两次查询');
    assert.ok(
      !out.callsNoRelation.some((c) => c.ops.some((o) => o.op === 'upsert')),
      '无合法关系时绝不允许 UPSERT（禁止通过备注接口伪造好友关系）'
    );

    // ---- UPSERT 被拒：显式失败 ----
    assert.equal(out.upsertDenied.ok, false, 'UPSERT 被 RLS 拒绝时必须失败');
    assert.equal(out.upsertDenied.error, 'permission denied for table friends', '必须透出真实错误，不得假报「已保存」');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-SOCIAL-03：搭子授权撤销决策契约
// ---------------------------------------------------------------------------
test('P04-SOCIAL-03 授权撤销决策：不读 old.status、复验出错不误删、以服务端为准', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { isAuthEventRelevant, shouldRevokeOnAuthChange } = await import('./src/hooks/health/authRevokeLogic.js');
const pId = 'partner-1';

const relevant = {
  noPid: isAuthEventRelevant({ new: { requester_id: pId } }, ''),
  requesterMatch: isAuthEventRelevant({ new: { requester_id: pId, addressee_id: 'x' } }, pId),
  addresseeMatch: isAuthEventRelevant({ new: { requester_id: 'x', addressee_id: pId } }, pId),
  bothMissing: isAuthEventRelevant({ new: {} }, pId),
  noNew: isAuthEventRelevant({}, pId),
  unrelated: isAuthEventRelevant({ new: { requester_id: 'a', addressee_id: 'b' } }, pId),
  // 关键：payload.old.status 存在但 new 无关 → 仍判为不相关（绝不依赖 old.status）
  oldStatusOnly: isAuthEventRelevant({ new: { requester_id: 'a', addressee_id: 'b' }, old: { status: 'revoked' } }, pId),
};

const revoke = {
  error: shouldRevokeOnAuthChange({ error: { message: 'net' } }, pId),
  nullResult: shouldRevokeOnAuthChange(null, pId),
  sameId: shouldRevokeOnAuthChange({ data: pId, error: null }, pId),
  nullData: shouldRevokeOnAuthChange({ data: null, error: null }, pId),
  otherId: shouldRevokeOnAuthChange({ data: 'partner-2', error: null }, pId),
  undefinedData: shouldRevokeOnAuthChange({ data: undefined, error: null }, pId),
};

process.stdout.write(JSON.stringify({ relevant, revoke }));
`);
    assert.equal(out.relevant.noPid, false, '无当前搭子 → 不相关');
    assert.equal(out.relevant.requesterMatch, true, 'requester_id 命中 → 相关');
    assert.equal(out.relevant.addresseeMatch, true, 'addressee_id 命中 → 相关');
    assert.equal(out.relevant.bothMissing, true, '双方字段缺失 → 保守判为相关（交服务端复验）');
    assert.equal(out.relevant.noNew, true, '无 new 字段 → 保守判为相关');
    assert.equal(out.relevant.unrelated, false, '双方均不匹配 → 不相关');
    assert.equal(out.relevant.oldStatusOnly, false, '绝不因 payload.old.status 判定相关（该表未设 REPLICA IDENTITY FULL）');

    assert.equal(out.revoke.error, false, '复验出错 → 不撤销（防网络抖动误删）');
    assert.equal(out.revoke.nullResult, false, '无复验结果 → 不撤销');
    assert.equal(out.revoke.sameId, false, '服务端仍返回同一搭子 → 不撤销');
    assert.equal(out.revoke.nullData, true, '服务端返回 null → 撤销');
    assert.equal(out.revoke.otherId, true, '服务端返回不同 id → 撤销');
    assert.equal(out.revoke.undefinedData, true, '服务端返回 undefined → 视为 null → 撤销');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_socialContract.test.mjs ---
