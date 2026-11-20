// --- START OF FILE tests/security/p04_friendRemark.test.mjs ---
// ============================================================================
// TASK-P0.4 / FIX-A — 好友备注（updateRemark）回归测试
//
// 背景（P04-BUG-01）：好友备注修改后界面不刷新 / 实际未生效。
//   根因：updateRemark 只 `.eq('user_id', me).eq('friend_id', them)`，
//         当库里只有「对方 → 我」这一行时命中 0 行，PostgREST 仍返回成功，
//         前端误报「已保存」。
//
// 本测试锁定 FIX-A 契约：
//   P04-REMARK-01  我方行存在 → 直接 UPDATE，命中 1 行，返回 ok:true；
//   P04-REMARK-02  我方行不存在但存在「对方 → 我」合法关系 → UPSERT 我方行，
//                  返回 ok:true + created:true（不报错、不假装成功）；
//   P04-REMARK-03  双方均无关系 → 拒绝创建，返回 ok:false（不得伪造好友关系）；
//   P04-REMARK-04  UPDATE 命中 0 行且无合法关系时，绝不返回 ok:true；
//   P04-REMARK-05  备注是个人视角：只写 user_id=我 的行，绝不触碰对方行；
//   P04-REMARK-06  权限错误（permission denied）→ 返回 ok:false 并透出错误。
//
// 说明：不联网，通过 stub supabase 运行真实源码，记录实际调用序列。
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

// 构造一个可编程的 supabase stub：
//   __DB__ 模拟 friends 表；__CALLS__ 记录调用序列；__FAIL__ 注入错误。
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-remark-'));
  const src = path.join(repoRoot, 'src/hooks/chat/useFriendActions.js');
  const dst = path.join(dir, 'src/hooks/chat/useFriendActions.js');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);

  // react stub：useCallback 直接返回原函数（作为裸包 node_modules/react 解析）
  const reactDir = path.join(dir, 'node_modules/react');
  fs.mkdirSync(reactDir, { recursive: true });
  fs.writeFileSync(path.join(reactDir, 'package.json'), JSON.stringify({ name: 'react', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(reactDir, 'index.js'), `
export function useCallback(fn) { return fn; }
`);

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const __CALLS__ = [];
export const __DB__ = { rows: [] };
export const __FAIL__ = { update: null, select: null, upsert: null };

function matchRow(row, filters) {
  return filters.every((f) => row[f.col] === f.val);
}

function makeQuery(table) {
  const state = { op: null, payload: null, filters: [], orExpr: null, selectCols: null, onConflict: null };
  const q = {
    update(payload) { state.op = 'update'; state.payload = payload; return q; },
    upsert(payload, opts) { state.op = 'upsert'; state.payload = payload; state.onConflict = opts?.onConflict; return q; },
    select(cols) { state.selectCols = cols; return q; },
    eq(col, val) { state.filters.push({ col, val }); return q; },
    or(expr) { state.orExpr = expr; return q; },
    limit() { return q; },
    then(resolve) {
      __CALLS__.push({ table, op: state.op, payload: state.payload, filters: [...state.filters], orExpr: state.orExpr, onConflict: state.onConflict });
      // 注入错误
      if (state.op && __FAIL__[state.op]) {
        return resolve({ data: null, error: { message: __FAIL__[state.op] } });
      }
      if (state.op === 'update') {
        const affected = __DB__.rows.filter((r) => matchRow(r, state.filters));
        affected.forEach((r) => Object.assign(r, state.payload));
        return resolve({ data: affected.map((r) => ({ id: r.id })), error: null });
      }
      if (state.op === 'upsert') {
        const key = { user_id: state.payload.user_id, friend_id: state.payload.friend_id };
        let existing = __DB__.rows.find((r) => r.user_id === key.user_id && r.friend_id === key.friend_id);
        if (existing) { Object.assign(existing, state.payload); }
        else { existing = { id: 'new-' + __DB__.rows.length, ...state.payload }; __DB__.rows.push(existing); }
        return resolve({ data: [{ id: existing.id }], error: null });
      }
      // select（用于关系校验）
      let rows = __DB__.rows.filter((r) => matchRow(r, state.filters));
      if (state.orExpr) {
        // 解析 or(and(user_id.eq.A,friend_id.eq.B),and(...))
        const pairs = [...state.orExpr.matchAll(/and\\(user_id\\.eq\\.([^,]+),friend_id\\.eq\\.([^)]+)\\)/g)]
          .map((m) => ({ u: m[1], f: m[2] }));
        rows = __DB__.rows.filter((r) => pairs.some((p) => r.user_id === p.u && r.friend_id === p.f));
      }
      return resolve({ data: rows, error: null });
    },
  };
  return q;
}

export const supabase = {
  from(table) { return makeQuery(table); },
};
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);console.warn=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

const ME = 'user-me';
const THEM = 'user-them';

// ---------------------------------------------------------------------------
// P04-REMARK-01：我方行存在 → 直接 UPDATE 命中 1 行
// ---------------------------------------------------------------------------
test('P04-REMARK-01 我方行存在时直接 UPDATE 并返回 ok:true', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __DB__, __CALLS__ } = await import('./src/services/supabase.js');
__DB__.rows = [{ id: 'r1', user_id: '${ME}', friend_id: '${THEM}', remark: null }];
const { updateRemark } = useFriendActions({ id: '${ME}' });
const res = await updateRemark('${THEM}', '新备注');
process.stdout.write(JSON.stringify({ res, calls: __CALLS__, rows: __DB__.rows }));
`);
    assert.equal(out.res.ok, true);
    assert.equal(out.res.created, undefined, '直接命中时不应标记 created');
    assert.equal(out.rows[0].remark, '新备注');
    // 第一次调用必须是 update
    assert.equal(out.calls[0].op, 'update');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-REMARK-02：只有「对方 → 我」行 → UPSERT 我方行，ok:true + created
// ---------------------------------------------------------------------------
test('P04-REMARK-02 仅有对方→我关系时 UPSERT 我方行并返回 created:true', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __DB__, __CALLS__ } = await import('./src/services/supabase.js');
// 库里只有「对方 → 我」这一行（contacts.js 接受请求时只插一条的典型场景）
__DB__.rows = [{ id: 'r1', user_id: '${THEM}', friend_id: '${ME}', remark: '对方给我设的备注' }];
const { updateRemark } = useFriendActions({ id: '${ME}' });
const res = await updateRemark('${THEM}', '我的备注');
process.stdout.write(JSON.stringify({ res, calls: __CALLS__, rows: __DB__.rows }));
`);
    assert.equal(out.res.ok, true);
    assert.equal(out.res.created, true, '应标记 created:true');
    // 必须存在我方行
    const mine = out.rows.find((r) => r.user_id === ME && r.friend_id === THEM);
    assert.ok(mine, '必须创建我方视角的行');
    assert.equal(mine.remark, '我的备注');
    // 对方行不得被修改（个人视角隔离）
    const theirs = out.rows.find((r) => r.user_id === THEM && r.friend_id === ME);
    assert.equal(theirs.remark, '对方给我设的备注', '不得修改对方视角的备注');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-REMARK-03：双方均无关系 → 拒绝创建
// ---------------------------------------------------------------------------
test('P04-REMARK-03 无任何好友关系时拒绝创建并返回 ok:false', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __DB__, __CALLS__ } = await import('./src/services/supabase.js');
__DB__.rows = [];
const { updateRemark } = useFriendActions({ id: '${ME}' });
const res = await updateRemark('${THEM}', '恶意备注');
process.stdout.write(JSON.stringify({ res, calls: __CALLS__, rows: __DB__.rows }));
`);
    assert.equal(out.res.ok, false, '无关系时必须失败');
    assert.ok(out.res.error, '必须给出错误信息');
    assert.equal(out.rows.length, 0, '不得凭空创建好友关系行');
    // 不得出现 upsert 调用
    assert.equal(out.calls.some((c) => c.op === 'upsert'), false, '无关系时不得 UPSERT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-REMARK-04：UPDATE 命中 0 行且无合法关系 → 绝不返回 ok:true
// ---------------------------------------------------------------------------
test('P04-REMARK-04 UPDATE 命中 0 行且无合法关系时绝不返回 ok:true', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __DB__ } = await import('./src/services/supabase.js');
__DB__.rows = [];
const { updateRemark } = useFriendActions({ id: '${ME}' });
const res = await updateRemark('${THEM}', 'x');
process.stdout.write(JSON.stringify({ res }));
`);
    assert.notEqual(out.res.ok, true, '0 行命中 + 无关系时不得假装成功');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-REMARK-05：个人视角隔离 — 只写 user_id=我 的行
// ---------------------------------------------------------------------------
test('P04-REMARK-05 备注写入仅作用于 user_id=我 的行', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __DB__, __CALLS__ } = await import('./src/services/supabase.js');
__DB__.rows = [
  { id: 'r1', user_id: '${ME}', friend_id: '${THEM}', remark: 'old-mine' },
  { id: 'r2', user_id: '${THEM}', friend_id: '${ME}', remark: 'old-theirs' },
];
const { updateRemark } = useFriendActions({ id: '${ME}' });
const res = await updateRemark('${THEM}', 'new-mine');
process.stdout.write(JSON.stringify({ res, calls: __CALLS__, rows: __DB__.rows }));
`);
    assert.equal(out.res.ok, true);
    const mine = out.rows.find((r) => r.user_id === ME);
    const theirs = out.rows.find((r) => r.user_id === THEM);
    assert.equal(mine.remark, 'new-mine');
    assert.equal(theirs.remark, 'old-theirs', '对方行必须保持不变');
    // update 调用的 filters 必须含 user_id=我
    const upd = out.calls.find((c) => c.op === 'update');
    assert.ok(upd.filters.some((f) => f.col === 'user_id' && f.val === ME), 'UPDATE 必须限定 user_id=我');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-REMARK-06：权限错误 → ok:false 并透出错误
// ---------------------------------------------------------------------------
test('P04-REMARK-06 权限错误时返回 ok:false 并透出错误信息', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions.js');
const { __DB__, __FAIL__ } = await import('./src/services/supabase.js');
__DB__.rows = [{ id: 'r1', user_id: '${ME}', friend_id: '${THEM}', remark: null }];
__FAIL__.update = 'permission denied for table friends';
const { updateRemark } = useFriendActions({ id: '${ME}' });
const res = await updateRemark('${THEM}', 'x');
process.stdout.write(JSON.stringify({ res }));
`);
    assert.equal(out.res.ok, false);
    assert.match(out.res.error, /permission denied/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_friendRemark.test.mjs ---
