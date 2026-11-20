// --- START OF FILE tests/security/p04_c2c3RecordDate.test.mjs ---
// ============================================================================
// TASK-P0.4 / C2 + C3 — 健康数据 recordDate 透传 + 入队即落盘回归测试
//
// 目的：P0.3 的 B4 测试覆盖了 pending 持久化与版本化提交，但未对以下两点
//       做「端到端可执行」的契约断言：
//         C2 recordDate 透传：enqueuePending 携带的 recordDate 必须原样进入
//            commit 的 upsert 载荷（record_date），且 onConflict 精确为
//            'user_id, record_date'；无 override 时回退到 getDateStr()。
//            —— 这是 BUG-01（D-11）「本地写 D0、云端写 D1」日期错位的防线。
//         C3 入队即落盘：enqueuePending 必须在「防抖定时器触发之前」就把
//            pending 写入 AsyncStorage（key = @sync_health_pending_v1_<owner>），
//            使「点击后 500ms 内进程被杀」也能冷启动恢复（L4-03 缺口）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub（react / AsyncStorage / supabase）+ 临时目录运行「真实源码」
//     useHealthCloud.js，直接调用其返回的 enqueuePending / flushNow / hasPendingFor。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-c2c3-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // AsyncStorage：内存 Map，并把每次写入记录到 __writes 供断言「落盘时机」。
  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
const writes = [];
const api = {
  __store: store,
  __writes: writes,
  async getItem(k){ return store.has(k) ? store.get(k) : null; },
  async setItem(k,v){ store.set(k, String(v)); writes.push({ op:'set', k, v:String(v) }); },
  async removeItem(k){ store.delete(k); writes.push({ op:'remove', k }); },
  async multiSet(pairs){ for (const [k,v] of pairs){ store.set(k, String(v)); writes.push({ op:'set', k, v:String(v) }); } },
  async multiRemove(keys){ for (const k of keys){ store.delete(k); writes.push({ op:'remove', k }); } },
  async getAllKeys(){ return [...store.keys()]; },
  async clear(){ store.clear(); },
};
export default api;
`,
  });

  // react：最小可用 hooks（无渲染，仅让 Hook 函数可被调用并返回 API 对象）。
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
export const useEffect = () => {};
export const useCallback = (fn) => fn;
export const useMemo = (fn) => fn();
export const useRef = (v) => ({ current: v });
export const createContext = (v) => ({ __ctx: v });
export const useContext = () => ({});
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext };
`,
  });

  // supabase：记录 upsert 调用（表名 / 载荷 / 选项），返回 { error: null }。
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const createClient = () => ({}); export default { createClient };`,
  });

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/hooks/health/useHealthCloud.js');
  copy('src/hooks/health/authRevokeLogic.js');

  // 覆盖 services/supabase.js 为可观测 stub（记录 upsert）。
  const svcDir = path.join(dir, 'src/services');
  fs.mkdirSync(svcDir, { recursive: true });
  fs.writeFileSync(path.join(svcDir, 'supabase.js'), `
export const __upserts = [];
function makeQuery(table){
  return {
    upsert(payload, options){
      __upserts.push({ table, payload, options });
      return Promise.resolve({ error: null });
    },
    select(){ return this; },
    eq(){ return this; },
    single(){ return Promise.resolve({ data: null, error: { code: 'PGRST116' } }); },
    order(){ return this; },
    limit(){ return this; },
    delete(){ return this; },
    insert(){ return Promise.resolve({ error: null }); },
    update(){ return this; },
  };
}
export const supabase = {
  from(table){ return makeQuery(table); },
  channel(){ return { on(){ return this; }, subscribe(){ return this; } }; },
  removeChannel(){ return Promise.resolve(); },
  auth: { getSession: async () => ({ data: { session: null } }) },
};
export default supabase;
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
// P04-C2-01：enqueuePending 显式 recordDate 必须原样进入 upsert 载荷
// ---------------------------------------------------------------------------
test('P04-C2-01 显式 recordDate 透传到 upsert 的 record_date 与 onConflict', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const { __upserts } = await import('./src/services/supabase.js');
const user = { id: 'user-A' };
const getDateStr = () => '2099-01-01'; // 故意与 override 不同，验证 override 优先
const api = useHealthCloud(user, getDateStr, 0);
const enq = api.enqueuePending(1234, { '早餐': true, '午餐': false, '晚餐': false }, '2026-11-20');
await api.flushNow();
process.stdout.write(JSON.stringify({
  enq,
  upserts: __upserts,
}));
`);
    assert.deepEqual(out.enq, { ownerId: 'user-A', recordDate: '2026-11-20' }, 'enqueuePending 应返回 ownerId + recordDate');
    assert.equal(out.upserts.length, 1, '应发生恰好一次 upsert');
    const u = out.upserts[0];
    assert.equal(u.table, 'health_records', 'upsert 目标表必须是 health_records');
    assert.equal(u.payload.record_date, '2026-11-20', 'record_date 必须等于显式传入的 recordDate（override 优先于 getDateStr）');
    assert.equal(u.payload.user_id, 'user-A', 'user_id 必须为载荷 owner');
    assert.equal(u.payload.water_amount, 1234, 'water_amount 必须透传');
    assert.deepEqual(u.payload.meals_status, { '早餐': true, '午餐': false, '晚餐': false }, 'meals_status 必须透传');
    assert.equal(u.options.onConflict, 'user_id, record_date', 'onConflict 必须精确为 user_id, record_date');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-C2-02：无 override 时 recordDate 回退到 getDateStr()
// ---------------------------------------------------------------------------
test('P04-C2-02 无 recordDate override 时回退到 getDateStr()', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const { __upserts } = await import('./src/services/supabase.js');
const user = { id: 'user-B' };
const getDateStr = () => '2026-11-21';
const api = useHealthCloud(user, getDateStr, 0);
const enq = api.enqueuePending(500, { '早餐': false, '午餐': false, '晚餐': false });
await api.flushNow();
process.stdout.write(JSON.stringify({ enq, upserts: __upserts }));
`);
    assert.equal(out.enq.recordDate, '2026-11-21', '无 override 时应回退到 getDateStr()');
    assert.equal(out.upserts.length, 1);
    assert.equal(out.upserts[0].payload.record_date, '2026-11-21', 'record_date 必须等于 getDateStr() 的返回值');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-C3-01：enqueuePending 在防抖定时器触发前即落盘（入队即持久化）
// ---------------------------------------------------------------------------
test('P04-C3-01 enqueuePending 立即写入 pending 持久化 key（不等防抖）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
const user = { id: 'user-C' };
const getDateStr = () => '2026-11-22';
const api = useHealthCloud(user, getDateStr, 0);
// 仅入队，不调用 scheduleFlush / flushNow —— 模拟「点击后 500ms 内进程被杀」。
api.enqueuePending(777, { '早餐': true, '午餐': true, '晚餐': false }, '2026-11-22');
// 等待 persistPending 的 Promise 链完成（enqueuePending 内部未 await 落盘）。
await new Promise((r) => setTimeout(r, 30));
const key = '@sync_health_pending_v1_user-C';
const raw = await AsyncStorage.getItem(key);
const parsed = raw ? JSON.parse(raw) : null;
const hasPending = await api.hasPendingFor('user-C', '2026-11-22');
process.stdout.write(JSON.stringify({
  key,
  raw,
  parsed,
  hasPending,
  writes: AsyncStorage.__writes,
}));
`);
    assert.ok(out.raw, 'pending 持久化 key 必须已被写入（入队即落盘）');
    assert.ok(out.parsed && out.parsed['2026-11-22'], 'pending 表必须包含 recordDate 对应的条目');
    const entry = out.parsed['2026-11-22'];
    assert.equal(entry.ownerId, 'user-C', 'pending 条目 ownerId 必须正确');
    assert.equal(entry.recordDate, '2026-11-22', 'pending 条目 recordDate 必须正确');
    assert.equal(entry.water, 777, 'pending 条目 water 必须透传');
    assert.equal(out.hasPending, true, 'hasPendingFor 必须返回 true（供云端 hydrate 闸门使用）');
    // 落盘必须发生在「入队」阶段，而非 flush 阶段：写入记录里应出现该 key 的 set。
    const setWrites = out.writes.filter((w) => w.op === 'set' && w.k === out.key);
    assert.ok(setWrites.length >= 1, '必须观察到对该 pending key 的 set 写入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-C3-02：flush 成功后 pending 被清理（内存与磁盘一致）
// ---------------------------------------------------------------------------
test('P04-C3-02 flush 成功后 pending 持久化条目被移除', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
const user = { id: 'user-D' };
const getDateStr = () => '2026-11-23';
const api = useHealthCloud(user, getDateStr, 0);
api.enqueuePending(999, { '早餐': false, '午餐': false, '晚餐': true }, '2026-11-23');
await new Promise((r) => setTimeout(r, 30));
const before = await AsyncStorage.getItem('@sync_health_pending_v1_user-D');
await api.flushNow();
await new Promise((r) => setTimeout(r, 30));
const after = await AsyncStorage.getItem('@sync_health_pending_v1_user-D');
const hasPendingAfter = await api.hasPendingFor('user-D', '2026-11-23');
process.stdout.write(JSON.stringify({ before, after, hasPendingAfter }));
`);
    assert.ok(out.before, 'flush 前应存在 pending 持久化条目');
    assert.equal(out.after, null, 'flush 成功后 pending 持久化 key 应被移除（空表删除 key）');
    assert.equal(out.hasPendingAfter, false, 'flush 成功后 hasPendingFor 应返回 false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_c2c3RecordDate.test.mjs ---
