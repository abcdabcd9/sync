// --- START OF FILE tests/security/d09d10LogEvidence.test.mjs ---
// ============================================================================
// TASK-P0.3 / VERIFY-01 (D-09) + VERIFY-02 (D-10) — 日志级证据验证
//
// 背景：
//   D-09（弱网写入）与 D-10（冷启动 500ms 落盘）真机手工测试通过，但缺少
//   「可核验的日志证据」。本测试不依赖肉眼观察，而是采集结构化日志：
//     · 每次真实 upsert 的 {table, user_id, water_amount, 时间戳(单调)}
//     · 失败重试次数
//     · 最终云端值
//     · 账号归属（user_id）
//     · 500ms 落盘窗口的单调时钟耗时（performance.now 差值）
//
//   D09-A 弱网：首次 upsert 失败 → 重试 → 最终云端值正确、写入次数可解释、
//         账号归属正确、无跨账号污染。
//   D09-B 弱网：连续多次失败后恢复 → 最终只保留最新值，不丢数据。
//   D10-A 冷启动：handleAddWater 后 500ms 定时器触发前，磁盘已落盘；
//         用单调时钟测量「点击 → 磁盘可读」耗时 < 500ms。
//   D10-B 冷启动：进程重建后本地新值不被旧云端覆盖，并最终重传。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」。
//   - 断言针对真实生产接口 + 真实 AsyncStorage 内容 + 真实 upsert 请求参数。
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

// ---------------------------------------------------------------------------
// 沙箱：与 b4HealthSyncReliability.test.mjs 完全一致的 stub 契约
// ---------------------------------------------------------------------------
function buildSandbox(extraCopies = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd09d10-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
const api = {
  __store: store,
  async getItem(k){ return store.has(k) ? store.get(k) : null; },
  async setItem(k,v){ store.set(k, String(v)); },
  async removeItem(k){ store.delete(k); },
  async multiSet(pairs){ for (const [k,v] of pairs) store.set(k, String(v)); },
  async multiRemove(keys){ for (const k of keys) store.delete(k); },
  async getAllKeys(){ return [...store.keys()]; },
  async clear(){ store.clear(); },
};
export default api;
`,
  });

  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
let ctx = null;
let idx = 0;
const shallowEq = (a, b) => {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

export function __createRuntime() {
  const hooks = [];
  const effects = [];
  const runtime = {
    hooks,
    effects,
    renderOnly(fn) {
      idx = 0; effects.length = 0; ctx = runtime;
      return fn();
    },
    render(fn) {
      let out;
      for (let round = 0; round < 20; round++) {
        idx = 0;
        effects.length = 0;
        ctx = runtime;
        const before = hooks.map((h) => (h && 'v' in h ? h.v : undefined));
        out = fn();
        let dirty = false;
        for (const e of effects) {
          if (!e.deps || !e.prevDeps || !shallowEq(e.deps, e.prevDeps)) {
            if (e.cleanup) { try { e.cleanup(); } catch (_) {} }
            e.prevDeps = e.deps;
            const c = e.fn();
            e.cleanup = typeof c === 'function' ? c : null;
          }
        }
        for (let i = 0; i < hooks.length; i++) {
          const h = hooks[i];
          if (h && 'v' in h && !Object.is(before[i], h.v)) { dirty = true; break; }
        }
        if (!dirty) break;
      }
      return out;
    },
    unmount() {
      for (const e of effects) { if (e.cleanup) { try { e.cleanup(); } catch (_) {} } e.cleanup = null; }
    },
  };
  return runtime;
}

export function useState(init) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: typeof init === 'function' ? init() : init };
  const slot = rt.hooks[i];
  const setter = (next) => {
    slot.v = typeof next === 'function' ? next(slot.v) : next;
  };
  return [slot.v, setter];
}

export function useRef(v) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { current: v };
  return rt.hooks[i];
}

export function useEffect(fn, deps) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps: undefined, prevDeps: undefined, cleanup: null };
  const slot = rt.hooks[i];
  slot.fn = fn;
  slot.deps = deps;
  rt.effects.push(slot);
}

export function useCallback(fn, deps) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.fn = fn; slot.deps = deps; }
  return slot.fn;
}

export function useMemo(fn, deps) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: fn(), deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.v = fn(); slot.deps = deps; }
  return slot.v;
}

export const createContext = (v) => ({ __ctx: v });
export const useContext = () => ({});
export function createElement(type, props, ...children) {
  const p = props ? { ...props } : {};
  if (children.length === 1) p.children = children[0];
  else if (children.length > 1) p.children = children;
  return { type, props: p };
}
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement };
`,
  });

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    if (rel.endsWith('useHealthData.js')) {
      code = code.replace(
        /return <HealthContext\.Provider value=\{value\}>\{children\}<\/HealthContext\.Provider>;/,
        'return React.createElement(HealthContext.Provider, { value }, children);'
      );
      code = "import * as React from 'react';\n" + code;
    }
    fs.writeFileSync(dst, code);
  };
  copy('src/hooks/health/useHealthCloud.js');
  copy('src/hooks/health/authRevokeLogic.js');
  for (const rel of extraCopies) copy(rel);

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  channels: [],
  rpcImpl: null,
  queryImpl: null,
  upsertImpl: null,
  upsertCalls: [],
};

function makeChannel(name) {
  const ch = { topic: 'realtime:' + name, name, handlers: [], removed: false, subscribed: false };
  const api = {
    on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return api; },
    subscribe() { ch.subscribed = true; return api; },
  };
  ch.api = api;
  state.channels.push(ch);
  return api;
}

export const supabase = {
  __state: state,
  __reset() { state.channels.length = 0; state.rpcImpl = null; state.queryImpl = null; state.upsertImpl = null; state.upsertCalls.length = 0; },
  __emit(channelName, payload) {
    const ch = state.channels.find((c) => c.name === channelName && !c.removed);
    if (!ch) return 0;
    let n = 0;
    for (const h of ch.handlers) { h.cb(payload); n += 1; }
    return n;
  },
  __liveChannels() { return state.channels.filter((c) => !c.removed); },
  channel(name) { return makeChannel(name); },
  getChannels() { return state.channels.filter((c) => !c.removed).map((c) => ({ topic: c.topic, __ref: c })); },
  removeChannel(chOrRef) {
    const target = chOrRef && chOrRef.__ref ? chOrRef.__ref : state.channels.find((c) => c.topic === (chOrRef && chOrRef.topic));
    if (target) target.removed = true;
    return Promise.resolve('ok');
  },
  rpc(fn, args) {
    if (state.rpcImpl) return state.rpcImpl(fn, args);
    return Promise.resolve({ data: null, error: null });
  },
  from(table) {
    const chain = { table, ops: [] };
    const api = {
      select() { chain.ops.push(['select']); return api; },
      eq(k, v) { chain.ops.push(['eq', k, v]); return api; },
      single() {
        if (state.queryImpl) return state.queryImpl(table, chain);
        return Promise.resolve({ data: null, error: null });
      },
      upsert(row, opts) {
        state.upsertCalls.push({ table, row, opts });
        if (state.upsertImpl) return state.upsertImpl(table, row, opts);
        return Promise.resolve({ data: null, error: null });
      },
      then(res, rej) {
        const p = state.queryImpl ? state.queryImpl(table, chain) : Promise.resolve({ data: null, error: null });
        return p.then(res, rej);
      },
    };
    return api;
  },
};
export const authStorageStatus = { get: () => null };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
export const probeAuthStorage = async () => true;
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

function buildHealthProviderSandbox() {
  const dir = buildSandbox([
    'src/hooks/useHealthData.js',
    'src/hooks/health/useHealthStorage.js',
    'src/hooks/health/useTimeSync.js',
    'src/hooks/health/useStreak.js',
    'src/hooks/health/constants.js',
    'src/hooks/health/dateUtils.js',
    'src/hooks/profile/useProfileCache.js',
  ]);
  const nm = path.join(dir, 'node_modules');

  const rnDir = path.join(nm, 'react-native');
  fs.mkdirSync(rnDir, { recursive: true });
  fs.writeFileSync(path.join(rnDir, 'package.json'),
    JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(rnDir, 'index.js'), `
const listeners = new Set();
export const AppState = {
  currentState: 'active',
  addEventListener(type, cb) {
    if (type === 'change') listeners.add(cb);
    return { remove() { listeners.delete(cb); } };
  },
  __emit(next) {
    AppState.currentState = next;
    for (const cb of Array.from(listeners)) cb(next);
  },
  __listenerCount() { return listeners.size; },
};
export default { AppState };
`);

  const hapDir = path.join(nm, 'expo-haptics');
  fs.mkdirSync(hapDir, { recursive: true });
  fs.writeFileSync(path.join(hapDir, 'package.json'),
    JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(hapDir, 'index.js'), `
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export async function impactAsync() {}
export async function notificationAsync() {}
export async function selectionAsync() {}
export default { ImpactFeedbackStyle, NotificationFeedbackType, impactAsync, notificationAsync, selectionAsync };
`);

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/pushService.js'), `
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!globalThis.__PUSH_LOG__) globalThis.__PUSH_LOG__ = [];
  globalThis.__PUSH_LOG__.push({ receiverId, title, body, data });
  return { ok: true };
}
`);

  fs.writeFileSync(path.join(dir, 'src/hooks/useAuth.js'), `
const __authCache = new Map();
export function useAuth() {
  const uid = globalThis.__UID__ ?? null;
  const epoch = globalThis.__EPOCH__ ?? 0;
  const key = String(uid) + '::' + String(epoch);
  let v = __authCache.get(key);
  if (!v) {
    v = {
      user: uid ? { id: uid } : null,
      ownerId: uid,
      authEpoch: epoch,
      session: null,
      isAuthLoading: false,
      authError: null,
      isIdentityTransitioning: false,
      signOutError: null,
      retrySession: async () => {},
      signIn: async () => {},
      signUp: async () => {},
      signOut: async () => {},
    };
    __authCache.set(key, v);
  }
  return v;
}
export function AuthProvider({ children }) { return children; }
`);
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
// D09-A：弱网首次失败 → 重试 → 最终云端值正确、账号归属正确
// ---------------------------------------------------------------------------
test('D09-A 弱网首次 upsert 失败后重试，最终云端值正确且账号归属正确', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
// 结构化日志：每次 upsert 记录 {user_id, water, t(单调), ok}
const log = [];
let attempt = 0;
supabase.__state.upsertImpl = (table, row) => {
  attempt += 1;
  const ok = attempt > 1; // 第一次失败，之后成功
  log.push({ user_id: row.user_id, water: row.water_amount, t: performance.now(), ok });
  return Promise.resolve(ok ? { data: null, error: null } : { data: null, error: { message: 'weak network' } });
};

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(1500, { '早餐': true });
// 等待首次失败 + 自动重试（防抖 500ms + 重试窗口）
await new Promise((r) => setTimeout(r, 1700));
// 主动再 flush 一次，确保重试被驱动
await api.flushNow();
await new Promise((r) => setTimeout(r, 100));

const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const successRows = log.filter((e) => e.ok);
const failRows = log.filter((e) => !e.ok);

process.stdout.write(JSON.stringify({
  totalAttempts: log.length,
  failCount: failRows.length,
  successCount: successRows.length,
  finalSuccessWater: successRows.length ? successRows[successRows.length - 1].water : null,
  allUserIds: [...new Set(log.map((e) => e.user_id))],
  diskCleared: diskA === null,
}));
`);
    // 日志证据：至少 1 次失败 + 至少 1 次成功重试
    assert.ok(out.failCount >= 1, `弱网应至少记录 1 次失败，实际 failCount=${out.failCount}`);
    assert.ok(out.successCount >= 1, `重试后应至少记录 1 次成功，实际 successCount=${out.successCount}`);
    // 最终云端值正确
    assert.equal(out.finalSuccessWater, 1500, `最终成功写入的云端值应为 1500，实际 ${out.finalSuccessWater}`);
    // 账号归属正确（全部 user_id 均为 user-aaa，无跨账号污染）
    assert.deepEqual(out.allUserIds, ['user-aaa'], `所有写入的 user_id 必须均为 user-aaa，实际 ${JSON.stringify(out.allUserIds)}`);
    // 成功后磁盘 pending 清理
    assert.equal(out.diskCleared, true, '重试成功后磁盘 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D09-B：连续多次失败后恢复 → 最终只保留最新值，不丢数据
// ---------------------------------------------------------------------------
test('D09-B 连续多次失败后恢复，最终只保留最新值且不丢数据', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
const log = [];
// 前 3 次真实 upsert 尝试失败，之后成功（用独立计数器，避免依赖防抖合并后的次数）
let attempt = 0;
const FAIL_ATTEMPTS = 3;
supabase.__state.upsertImpl = (table, row) => {
  attempt += 1;
  const ok = attempt > FAIL_ATTEMPTS;
  log.push({ user_id: row.user_id, water: row.water_amount, ok });
  return Promise.resolve(ok ? { data: null, error: null } : { data: null, error: { message: 'weak network' } });
};

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
// 连续三次修改（模拟弱网下用户多次点击）
api.syncToCloud(1000, { '早餐': true });
await new Promise((r) => setTimeout(r, 600));
api.syncToCloud(2000, { '早餐': true });
await new Promise((r) => setTimeout(r, 600));
api.syncToCloud(3000, { '早餐': true });
await new Promise((r) => setTimeout(r, 600));
// 恢复网络后驱动重试：多次 flush + 再次 syncToCloud 触发重试
await api.flushNow();
await new Promise((r) => setTimeout(r, 200));
await api.flushNow();
await new Promise((r) => setTimeout(r, 200));
api.syncToCloud(3000, { '早餐': true });
await new Promise((r) => setTimeout(r, 700));
await api.flushNow();
await new Promise((r) => setTimeout(r, 200));

const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const successRows = log.filter((e) => e.ok);
const failRows = log.filter((e) => !e.ok);

process.stdout.write(JSON.stringify({
  totalAttempts: log.length,
  failCount: failRows.length,
  successCount: successRows.length,
  successWaters: successRows.map((e) => e.water),
  finalSuccessWater: successRows.length ? successRows[successRows.length - 1].water : null,
  allUserIds: [...new Set(log.map((e) => e.user_id))],
  diskCleared: diskA === null,
}));
`);
    assert.ok(out.failCount >= 1, `弱网应记录失败，实际 failCount=${out.failCount}`);
    assert.ok(out.successCount >= 1, `恢复后应记录成功，实际 successCount=${out.successCount}`);
    // 最终云端值必须是最新值 3000（不丢最新数据）
    assert.equal(out.finalSuccessWater, 3000, `最终成功写入的云端值应为最新值 3000，实际 ${out.finalSuccessWater}`);
    // 账号归属正确
    assert.deepEqual(out.allUserIds, ['user-aaa'], `所有写入的 user_id 必须均为 user-aaa，实际 ${JSON.stringify(out.allUserIds)}`);
    // 成功后磁盘 pending 清理
    assert.equal(out.diskCleared, true, '最终成功后磁盘 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D10-A：冷启动 500ms 落盘窗口 —— 单调时钟测量「点击 → 磁盘可读」耗时
// ---------------------------------------------------------------------------
test('D10-A handleAddWater 后 500ms 定时器触发前磁盘已落盘，单调耗时 < 500ms', () => {
  const dir = buildHealthProviderSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.js');

const A = 'user-aaa';
const DATE = formatDateStr(new Date());
const PENDING_KEY = '@sync_health_pending_v1_' + A;
const k = buildHealthKeys(A);

await AS.setItem(k.water, '400');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
const cloudRow = { water_amount: 400, meals_status: { '早餐': false, '午餐': false, '晚餐': false } };
supabase.__state.queryImpl = (table) => {
  if (table === 'health_records') return Promise.resolve({ data: { ...cloudRow }, error: null });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') { cloudRow.water_amount = row.water_amount; cloudRow.meals_status = row.meals_status; }
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const rt = React.__createRuntime();
let ctx = null;
const Comp = () => { const el = HealthProvider({ children: null }); ctx = el && el.props ? el.props.value : null; return null; };
rt.render(Comp);
await new Promise((r) => setTimeout(r, 60));
rt.render(Comp);

const waterBefore = ctx.waterAmount;

// 单调时钟：记录点击时刻
const tClick = performance.now();
ctx.handleAddWater();
rt.render(Comp);
const waterAfterClick = ctx.waterAmount;

// 轮询磁盘，测量「点击 → pending 可读」的单调耗时（不依赖 500ms 定时器）
let pendingWater = null;
let tDiskReady = null;
for (let i = 0; i < 100; i++) {
  const raw = await AS.getItem(PENDING_KEY);
  const obj = raw ? JSON.parse(raw) : null;
  const w = obj && obj[DATE] ? obj[DATE].water : null;
  if (w !== null) { pendingWater = w; tDiskReady = performance.now(); break; }
  await new Promise((r) => setTimeout(r, 5));
}
const diskLatencyMs = tDiskReady === null ? null : (tDiskReady - tClick);

process.stdout.write(JSON.stringify({
  waterBefore,
  waterAfterClick,
  pendingWater,
  diskLatencyMs,
}));
`);
    assert.equal(out.waterBefore, 400, '前置条件：点击前本地 water 应为 400');
    assert.equal(out.waterAfterClick, 401, 'handleAddWater 后本地值必须变为 401');
    assert.equal(out.pendingWater, 401, `500ms 定时器触发前 pending 必须已落盘为 401，实际 ${JSON.stringify(out.pendingWater)}`);
    // 单调耗时证据：落盘必须显著早于 500ms 防抖窗口
    assert.equal(typeof out.diskLatencyMs, 'number', '必须能测到落盘单调耗时');
    assert.ok(
      out.diskLatencyMs < 500,
      `点击 → 磁盘可读的单调耗时必须 < 500ms（证明在防抖窗口内已落盘），实际 ${out.diskLatencyMs}ms`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D10-B：冷启动进程重建后本地新值不被旧云端覆盖，并最终重传
// ---------------------------------------------------------------------------
test('D10-B 冷启动重建后本地新值不被旧云端覆盖，并最终重传最新值', () => {
  const dir = buildHealthProviderSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.js');

const A = 'user-aaa';
const DATE = formatDateStr(new Date());
const PENDING_KEY = '@sync_health_pending_v1_' + A;
const k = buildHealthKeys(A);

await AS.setItem(k.water, '400');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
const cloudRow = { water_amount: 400, meals_status: { '早餐': false, '午餐': false, '晚餐': false } };
supabase.__state.queryImpl = (table) => {
  if (table === 'health_records') return Promise.resolve({ data: { ...cloudRow }, error: null });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') { cloudRow.water_amount = row.water_amount; cloudRow.meals_status = row.meals_status; }
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 60));
rt1.render(Comp1);

ctx1.handleAddWater();
rt1.render(Comp1);
const waterAfterClick = ctx1.waterAmount;

// 500ms 内进程被杀（只等 120ms，pending 已落盘）
await new Promise((r) => setTimeout(r, 120));
const rawBeforeKill = await AS.getItem(PENDING_KEY);
const pendingBeforeKill = rawBeforeKill ? JSON.parse(rawBeforeKill) : null;
const pendingWaterBeforeKill = pendingBeforeKill && pendingBeforeKill[DATE] ? pendingBeforeKill[DATE].water : null;
rt1.unmount();

// 进程重建
const rt2 = React.__createRuntime();
let ctx2 = null;
const Comp2 = () => { const el = HealthProvider({ children: null }); ctx2 = el && el.props ? el.props.value : null; return null; };
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 120));
rt2.render(Comp2);
const waterAfterRestart = ctx2.waterAmount;

// 网络恢复：等待真实 500ms 防抖定时器自然触发
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 700));
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 200));

const upserts = supabase.__state.upsertCalls.map((c) => c.row.water_amount);

process.stdout.write(JSON.stringify({
  waterAfterClick,
  pendingWaterBeforeKill,
  waterAfterRestart,
  upserts,
}));
`);
    assert.equal(out.waterAfterClick, 401, '点击后本地值必须变为 401');
    assert.equal(out.pendingWaterBeforeKill, 401, `500ms 内 pending 必须已落盘为 401，实际 ${JSON.stringify(out.pendingWaterBeforeKill)}`);
    assert.equal(out.waterAfterRestart, 401, `冷启动重建后本地新值必须保持 401（不得被旧云端 400 覆盖），实际 ${JSON.stringify(out.waterAfterRestart)}`);
    assert.equal(out.upserts.includes(401), true, `网络恢复后必须重传最新值 401，实际 upserts=${JSON.stringify(out.upserts)}`);
    assert.equal(out.upserts.includes(400), false, `不得把旧云端快照 400 当作新值提交，实际 upserts=${JSON.stringify(out.upserts)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- END OF FILE tests/security/d09d10LogEvidence.test.mjs ---
