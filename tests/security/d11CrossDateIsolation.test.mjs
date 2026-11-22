// --- START OF FILE tests/security/d11CrossDateIsolation.test.mjs ---
// ============================================================================
// TASK-P0.3 / L4 ROUND2 — BLOCK-01：D-11 跨日期数据混用 复现与回归测试
//
// L4 第二轮审查结论（BLOCK）：
//   当前回拨处理存在风险 —— D0 本地 water=800，回拨至 D1 后保留 800，
//   用户 +1 得到 801，再将 801 按 D1 入队。问题：D1 的值可能包含 D0 的
//   历史数据；当前本地 water/active 也并非按日期分别存储。
//
// 必须验证（L4 明确要求）：
//   1) D0=800，D1 原本=120，回拨后不能把 D1 写成 801。
//   2) 正常日期恢复后，D0、D1 均保留各自正确值。
//   3) 饮水、三餐均检查。
//   4) 在线与离线不得因校准结果不同而造成不可解释的数据归属差异。
//   5) 测试中的 get_server_time 必须模拟「独立于手机系统时钟的真实服务器时间」，
//      不得简单返回被回拨后的本机时间。
//
// 本测试用「真实源码 + 可控时钟 + 独立服务器时钟」在纯 Node 沙箱中复现：
//   · 真实执行 useHealthData.js / useHealthStorage.js / useHealthCloud.js /
//     useTimeSync.js / useStreak.js 源码；
//   · 覆写 Date.now / new Date() 模拟「手机系统时钟」；
//   · get_server_time 返回一个**独立于手机时钟**的固定服务器时间（真实服务器
//     不会因为用户回拨手机而回拨），以此区分「手机时钟」与「服务器时钟」。
//
// 修复前：D1 被写成 801（含 D0 的 800）→ 断言失败（先红）。
// 修复后：D0、D1 各自保留正确值 → 断言通过（转绿）。
//
// 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// 沙箱构建：与 d11ClockRollback.test.mjs 保持一致的 stub 语义。
// ---------------------------------------------------------------------------
function buildSandbox(extraCopies = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-crossdate-'));
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

  // P1.4 R2：模块可能已迁移为 .ts/.tsx，按 .ts → .tsx → .js 顺序解析真实源文件。
  const resolveSrc = (rel) => {
    const candidates = [];
    if (rel.endsWith('.js')) {
      candidates.push(rel.slice(0, -3) + '.ts', rel.slice(0, -3) + '.tsx', rel);
    } else {
      candidates.push(rel);
    }
    for (const cand of candidates) {
      if (fs.existsSync(path.join(repoRoot, cand))) return cand;
    }
    return rel;
  };

  // P1.4 R6：项目自带 TypeScript 编译器（.ts/.tsx 类型擦除 + JSX 转译）。
  const ts = createRequire(import.meta.url)('typescript');

  const copy = (rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    // 沙箱内 import 路径统一为 .js，故以 rel 落盘。
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    // P1.4 R6：useHealthData 已迁移为 .tsx（HealthProvider JSX + TS 类型注解）。
    //   使用项目自带 TypeScript 编译器做「类型擦除 + JSX→createElement」转译，
    //   再以 .js 落盘供沙箱真实 import（不改变任何业务逻辑）。
    if (actual.endsWith('.tsx')) {
      code = ts.transpileModule(code, {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      if (!/import\s+\*\s+as\s+React\s+from\s+['"]react['"]/.test(code)) {
        code = "import * as React from 'react';\n" + code;
      }
    } else if (actual.endsWith('.ts')) {
      // .ts 源含 `import type` 等类型语法，Node 无法直接执行，需类型擦除。
      code = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
    }
    fs.writeFileSync(dst, code);
  };
  copy('src/hooks/health/useHealthCloud.js');
  copy('src/hooks/health/authRevokeLogic.ts');
  for (const rel of extraCopies) copy(rel);

  // supabase stub：可控 rpc（get_server_time / get_active_partner_id）、
  // query（health_records 读取）、upsert（捕获写入）。
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
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}return n(s,c);}`);
  return dir;
}

function buildHealthProviderSandbox() {
  const dir = buildSandbox([
    'src/hooks/useHealthData.js',
    'src/hooks/health/useHealthStorage.js',
    'src/hooks/health/useTimeSync.js',
    'src/hooks/health/useStreak.js',
    'src/hooks/health/constants.ts',
    'src/hooks/health/dateUtils.ts',
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
// FINAL-2：记录触感调用，供「拒绝时无成功反馈」断言使用。
export async function impactAsync(style) { if (globalThis.__HAPTIC_LOG__) globalThis.__HAPTIC_LOG__.push({ kind: 'impact', style }); }
export async function notificationAsync(type) { if (globalThis.__HAPTIC_LOG__) globalThis.__HAPTIC_LOG__.push({ kind: 'notification', type }); }
export async function selectionAsync() { if (globalThis.__HAPTIC_LOG__) globalThis.__HAPTIC_LOG__.push({ kind: 'selection' }); }
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
// 可控时钟：覆写 Date.now / Date 构造，模拟「手机系统时钟」。
//   · setWallClock(iso) 把「手机当前时间」固定到指定时刻；
//   · 所有 new Date() / Date.now() 都基于该固定时刻。
//   · 服务器时钟独立：get_server_time 返回固定值，不随手机时钟变化。
// ---------------------------------------------------------------------------
const CLOCK_HELPER = `
const RealDate = Date;
let __wall = RealDate.now();
globalThis.__setWall = (ms) => { __wall = ms; };
globalThis.__advanceWall = (ms) => { __wall += ms; };
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(__wall);
    else super(...args);
  }
  static now() { return __wall; }
}
globalThis.Date = FakeDate;
`;

// ---------------------------------------------------------------------------
// BLOCK-01-A：离线（校准失败）下系统日期回拨，D1 原本有独立记录。
//
// 场景：
//   · 服务器真实时间 = D0（2026-11-20），D0 云端 water=800；
//   · D1（2026-11-19）云端原本 water=120（历史独立记录）；
//   · 手机系统时钟回拨到 D1；
//   · 离线 → 校准失败 → 沿用旧 offset（0）→ getDateStr 仍返回 D1（手机日期）；
//   · 用户 +1。
//
// 期望（L4 要求）：
//   · D1 不得被写成 801（不得把 D0 的 800 混入 D1）；
//   · D0 云端记录保持 800；
//   · D1 云端记录保持 120（或至少不因回拨被污染为 801）。
// ---------------------------------------------------------------------------
test('BLOCK-01-A 离线回拨：D1 不得被写成 801（不得混入 D0 的 800）', () => {
  const dir = buildHealthProviderSandbox();
  try {
    const out = runInSandbox(dir, `
${CLOCK_HELPER}
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const D0 = new RealDate(2026, 10, 20, 12, 0, 0);
const D0STR = formatDateStr(D0);
const D1 = new RealDate(2026, 10, 19, 12, 0, 0);
const D1STR = formatDateStr(D1);

// 手机时钟先固定在 D0
__setWall(D0.getTime());

const k = buildHealthKeys(A);
// 本地磁盘：D0 有 water=800
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
// 云端：D0=800，D1=120（历史独立记录）
const cloudRows = {
  [D0STR]: { water_amount: 800, meals_status: { '早餐': true, '午餐': false, '晚餐': false } },
  [D1STR]: { water_amount: 120, meals_status: { '早餐': false, '午餐': false, '晚餐': false } },
};
// 离线：get_server_time 失败（校准失败，沿用旧 offset=0）
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_server_time') return Promise.resolve({ data: null, error: { message: 'offline' } });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = (table, chain) => {
  if (table === 'health_records') {
    const eqs = chain.ops.filter((o) => o[0] === 'eq');
    const date = eqs.find((o) => o[1] === 'record_date')?.[2];
    const row = cloudRows[date] || null;
    return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116' } });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') {
    cloudRows[row.record_date] = { water_amount: row.water_amount, meals_status: row.meals_status };
  }
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;

// ── 第一次进程：D0 正常加载 ──
const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 80));
rt1.render(Comp1);
const waterD0Before = ctx1.waterAmount;

// ── 手机时钟回拨到 D1（离线，offset 沿用旧值 0 → getDateStr 返回 D1）──
__setWall(D1.getTime());

// 用户 +1
ctx1.handleAddWater();
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 120));
const waterAfterEdit = ctx1.waterAmount;

// 等待云端防抖（500ms 外层 + 1500ms 内层）触发 flush
await new Promise((r) => setTimeout(r, 2200));
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 300));

const upserts = supabase.__state.upsertCalls.map((c) => ({ date: c.row.record_date, water: c.row.water_amount }));
const pendingRaw = await AS.getItem('@sync_health_pending_v1_' + A);
const pendingObj = pendingRaw ? JSON.parse(pendingRaw) : null;

process.stdout.write(JSON.stringify({
  D0STR, D1STR,
  waterD0Before,
  waterAfterEdit,
  upserts,
  cloudD0: cloudRows[D0STR] ? cloudRows[D0STR].water_amount : null,
  cloudD1: cloudRows[D1STR] ? cloudRows[D1STR].water_amount : null,
  pendingD0: pendingObj && pendingObj[D0STR] ? pendingObj[D0STR].water : null,
  pendingD1: pendingObj && pendingObj[D1STR] ? pendingObj[D1STR].water : null,
}));
`);
    const diag = JSON.stringify(out);
    assert.equal(out.waterD0Before, 800, `前置：D0 加载后 water 应为 800 | ${diag}`);
    // 核心断言 1：D1 不得被写成 801（不得混入 D0 的 800）
    const d1Upserts = out.upserts.filter((u) => u.date === out.D1STR);
    for (const u of d1Upserts) {
      assert.notEqual(
        u.water,
        801,
        `D1 不得被写成 801（D0 的 800 + 1 混入 D1）| ${diag}`
      );
    }
    // 核心断言 2：D0 云端记录保持 800（不得被回拨期间操作破坏）
    assert.equal(out.cloudD0, 800, `D0 云端记录必须保持 800 | ${diag}`);
    // 核心断言 3：D1 云端记录保持 120（历史独立记录不得被污染）
    assert.equal(out.cloudD1, 120, `D1 云端历史记录必须保持 120 | ${diag}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLOCK-01-B：在线（校准成功，服务器时间独立于手机时钟）下系统日期回拨。
//
// 场景：
//   · 服务器真实时间 = D0（2026-11-20 12:00 UTC），D0 云端 water=800；
//   · D1（2026-11-19）云端原本 water=120；
//   · 手机系统时钟回拨到 D1；
//   · 在线 → get_server_time 返回**真实服务器时间 D0**（不随手机回拨）；
//   · 校准后 offset = D0 - D1 = +1 天 → getDateStr 返回 D0（服务器日期）。
//
// 期望（L4 要求「在线与离线不得因校准结果不同而造成不可解释的数据归属差异」）：
//   · 在线时新操作应归属 D0（服务器真实日期），D0 变为 801；
//   · D1 保持 120（不得被污染）；
//   · 与离线场景的差异必须是「可解释的」（离线无法得知真实日期，只能按手机日期）。
// ---------------------------------------------------------------------------
test('BLOCK-01-B 在线回拨：服务器时间独立，新操作归属服务器真实日期 D0', () => {
  const dir = buildHealthProviderSandbox();
  try {
    const out = runInSandbox(dir, `
${CLOCK_HELPER}
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const D0 = new RealDate(2026, 10, 20, 12, 0, 0);
const D0STR = formatDateStr(D0);
const D1 = new RealDate(2026, 10, 19, 12, 0, 0);
const D1STR = formatDateStr(D1);

__setWall(D0.getTime());

const k = buildHealthKeys(A);
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
const cloudRows = {
  [D0STR]: { water_amount: 800, meals_status: { '早餐': true, '午餐': false, '晚餐': false } },
  [D1STR]: { water_amount: 120, meals_status: { '早餐': false, '午餐': false, '晚餐': false } },
};
// 在线：get_server_time 返回**真实服务器时间 D0**（独立于手机时钟，不随回拨变化）
const SERVER_NOW = D0.toISOString();
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_server_time') return Promise.resolve({ data: SERVER_NOW, error: null });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = (table, chain) => {
  if (table === 'health_records') {
    const eqs = chain.ops.filter((o) => o[0] === 'eq');
    const date = eqs.find((o) => o[1] === 'record_date')?.[2];
    const row = cloudRows[date] || null;
    return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116' } });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') {
    cloudRows[row.record_date] = { water_amount: row.water_amount, meals_status: row.meals_status };
  }
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;

const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 80));
rt1.render(Comp1);
const waterD0Before = ctx1.waterAmount;

// 手机时钟回拨到 D1（在线，服务器时间仍为 D0）
__setWall(D1.getTime());
// 触发前台切换，使 loadAllData 重新校准（offset = D0 - D1 = +1 天）
const { AppState } = await import('react-native');
AppState.__emit('background');
AppState.__emit('active');
await new Promise((r) => setTimeout(r, 150));
rt1.render(Comp1);

// 用户 +1
ctx1.handleAddWater();
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 2200));
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 300));

const upserts = supabase.__state.upsertCalls.map((c) => ({ date: c.row.record_date, water: c.row.water_amount }));

process.stdout.write(JSON.stringify({
  D0STR, D1STR,
  waterD0Before,
  upserts,
  cloudD0: cloudRows[D0STR] ? cloudRows[D0STR].water_amount : null,
  cloudD1: cloudRows[D1STR] ? cloudRows[D1STR].water_amount : null,
}));
`);
    const diag = JSON.stringify(out);
    assert.equal(out.waterD0Before, 800, `前置：D0 加载后 water 应为 800 | ${diag}`);
    // 在线：服务器时间独立 → 新操作应归属 D0（服务器真实日期）
    const d0Upserts = out.upserts.filter((u) => u.date === out.D0STR);
    assert.ok(d0Upserts.length > 0, `在线回拨后新操作必须归属服务器真实日期 D0 | ${diag}`);
    // D0 变为 801（800 + 1）
    assert.equal(out.cloudD0, 801, `在线回拨后 D0 应为 801（800+1）| ${diag}`);
    // D1 历史记录保持 120（不得被污染）
    assert.equal(out.cloudD1, 120, `D1 云端历史记录必须保持 120 | ${diag}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLOCK-01-C：恢复系统时间后，D0、D1 均保留各自正确值（饮水 + 三餐）。
//
// 场景：
//   · D0 有 water=800、三餐（早餐=true）；
//   · D1 有 water=120、三餐（午餐=true）；
//   · 手机回拨到 D1 → 用户 +1 → 恢复手机时间到 D0 → 冷启动。
//
// 期望：
//   · D0 恢复后 water=800（或 801，取决于操作归属），三餐早餐=true；
//   · D1 保持 water=120、午餐=true（不得被 D0 数据污染）。
// ---------------------------------------------------------------------------
test('BLOCK-01-C 恢复时间后：D0、D1 各自保留正确值（饮水+三餐）', () => {
  const dir = buildHealthProviderSandbox();
  try {
    const out = runInSandbox(dir, `
${CLOCK_HELPER}
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const D0 = new RealDate(2026, 10, 20, 12, 0, 0);
const D0STR = formatDateStr(D0);
const D1 = new RealDate(2026, 10, 19, 12, 0, 0);
const D1STR = formatDateStr(D1);

__setWall(D0.getTime());

const k = buildHealthKeys(A);
// 本地磁盘：D0 有 water=800、早餐=true
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
// 云端：D0=800/早餐=true，D1=120/午餐=true（历史独立记录）
const cloudRows = {
  [D0STR]: { water_amount: 800, meals_status: { '早餐': true, '午餐': false, '晚餐': false } },
  [D1STR]: { water_amount: 120, meals_status: { '早餐': false, '午餐': true, '晚餐': false } },
};
// 离线：校准失败，沿用旧 offset=0 → getDateStr 跟随手机时钟
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_server_time') return Promise.resolve({ data: null, error: { message: 'offline' } });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = (table, chain) => {
  if (table === 'health_records') {
    const eqs = chain.ops.filter((o) => o[0] === 'eq');
    const date = eqs.find((o) => o[1] === 'record_date')?.[2];
    const row = cloudRows[date] || null;
    return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116' } });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') {
    cloudRows[row.record_date] = { water_amount: row.water_amount, meals_status: row.meals_status };
  }
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;

// ── 第一次进程：D0 正常加载 ──
const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 80));
rt1.render(Comp1);

// ── 手机时钟回拨到 D1（离线）→ 用户 +1 ──
// 🍎 BLOCK-B：回拨期间日期不可信，写入必须被拒绝（不得显示成功后又丢失）。
__setWall(D1.getTime());
ctx1.handleAddWater();
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 2200));
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 300));
const waterAfterRollbackEdit = ctx1.waterAmount;
const diskAfterRollbackEdit = await AS.getItem(k.water);

// ── 恢复手机时钟到 D0，冷启动重建 ──
__setWall(D0.getTime());
rt1.unmount();
const rt2 = React.__createRuntime();
let ctx2 = null;
const Comp2 = () => { const el = HealthProvider({ children: null }); ctx2 = el && el.props ? el.props.value : null; return null; };
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 150));
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 2200));
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 300));

process.stdout.write(JSON.stringify({
  D0STR, D1STR,
  waterAfterRollbackEdit,
  diskAfterRollbackEdit,
  waterAfterRestore: ctx2.waterAmount,
  mealsAfterRestore: ctx2.mealsStatus,
  cloudD0: cloudRows[D0STR] ? cloudRows[D0STR].water_amount : null,
  cloudD0Meals: cloudRows[D0STR] ? cloudRows[D0STR].meals_status : null,
  cloudD1: cloudRows[D1STR] ? cloudRows[D1STR].water_amount : null,
  cloudD1Meals: cloudRows[D1STR] ? cloudRows[D1STR].meals_status : null,
}));
`);
    const diag = JSON.stringify(out);
    // 🍎 BLOCK-B 核心断言 1：回拨期间（日期不可信）写入必须被**拒绝**，
    //    不得显示成功后又悄悄丢失。因此回拨后本地饮水仍为 800（不是 801），
    //    磁盘也仍为 800。这证明「没有假装成功」。
    assert.equal(
      out.waterAfterRollbackEdit,
      800,
      `回拨期间 +1 必须被拒绝（本地应保持 800，不得为 801）| ${diag}`
    );
    assert.equal(
      String(out.diskAfterRollbackEdit),
      '800',
      `回拨期间 +1 必须被拒绝（磁盘应保持 800）| ${diag}`
    );
    // 🍎 BLOCK-B 核心断言 2：恢复时间后 D0 必须精确为 800（无丢失、无污染）。
    assert.equal(
      out.waterAfterRestore,
      800,
      `D0 恢复后 water 必须精确为 800（回拨写入已拒绝，不得丢失/污染）| ${diag}`
    );
    // 🍎 BLOCK-B 核心断言 3：D0 云端必须精确为 800（回拨期间不得写入云端）。
    assert.equal(out.cloudD0, 800, `D0 云端饮水必须精确为 800 | ${diag}`);
    // D0 早餐必须保持 true（不得被 D1 的三餐污染）
    assert.equal(out.cloudD0Meals?.['早餐'], true, `D0 早餐必须保持 true | ${diag}`);
    // D1 饮水必须保持 120（不得被 D0 的 800 污染）
    assert.equal(out.cloudD1, 120, `D1 云端饮水必须保持 120 | ${diag}`);
    // D1 午餐必须保持 true（不得被 D0 的三餐污染）
    assert.equal(out.cloudD1Meals?.['午餐'], true, `D1 午餐必须保持 true | ${diag}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FINAL-2（P0.3 FINAL L4 收尾）— D-11 拒绝操作的用户反馈
//
// L4 审查结论：回拨期间禁止写入的逻辑正确，但：
//   · console.warn 不是面向用户的反馈；
//   · handleAddWater / handleMinusWater 仍提前设置 userInteractedRef；
//   · 操作被拒绝时仍触发触感反馈。
//
// 要求：
//   1) 用户明确看到「设备日期异常，请恢复正确时间后重试」一类提示；
//   2) 拒绝时不显示成功反馈（无触感）；
//   3) 拒绝时不错误设置 userInteractedRef（避免干扰云端 hydrate）；
//   4) 不改变 fail-closed 策略；
//   5) 饮水、三餐、重置保持一致。
//
// 本测试在真实 HealthProvider 沙箱中：
//   · 回拨到 D1（离线，getDateStr 跟随手机时钟）；
//   · 调用 handleAddWater / confirmCheck / resetToday；
//   · 断言：dateAnomalyNotice 被设置（用户可见提示）、无触感、userInteractedRef 未被设置。
//
// 修复前：无 dateAnomalyNotice（undefined）、触感被触发、userInteractedRef=true → 先红。
// ---------------------------------------------------------------------------
test('FINAL-2 回拨拒绝：必须给出用户可见提示、无触感、不设置 userInteractedRef（饮水/三餐/重置一致）', () => {
  const dir = buildHealthProviderSandbox();
  try {
    const out = runInSandbox(dir, `
${CLOCK_HELPER}
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');
const Haptics = await import('expo-haptics');

// 记录触感调用（用于断言「拒绝时无成功反馈」）
globalThis.__HAPTIC_LOG__ = [];
const origImpact = Haptics.impactAsync;
const origNotif = Haptics.notificationAsync;

const A = 'user-aaa';
const D0 = new RealDate(2026, 10, 20, 12, 0, 0);
const D0STR = formatDateStr(D0);
const D1 = new RealDate(2026, 10, 19, 12, 0, 0);
const D1STR = formatDateStr(D1);

__setWall(D0.getTime());

const k = buildHealthKeys(A);
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
const cloudRows = {
  [D0STR]: { water_amount: 800, meals_status: { '早餐': true, '午餐': false, '晚餐': false } },
  [D1STR]: { water_amount: 120, meals_status: { '早餐': false, '午餐': false, '晚餐': false } },
};
// 离线：校准失败，沿用旧 offset=0 → getDateStr 跟随手机时钟
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_server_time') return Promise.resolve({ data: null, error: { message: 'offline' } });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = (table, chain) => {
  if (table === 'health_records') {
    const eqs = chain.ops.filter((o) => o[0] === 'eq');
    const date = eqs.find((o) => o[1] === 'record_date')?.[2];
    const row = cloudRows[date] || null;
    return Promise.resolve({ data: row, error: row ? null : { code: 'PGRST116' } });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') {
    cloudRows[row.record_date] = { water_amount: row.water_amount, meals_status: row.meals_status };
  }
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;

const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 80));
rt1.render(Comp1);

// 回拨到 D1（离线）
__setWall(D1.getTime());

// 清空触感日志，只观察回拨期间的调用
globalThis.__HAPTIC_LOG__ = [];

// ① 饮水 +1（handleAddWater）
ctx1.handleAddWater();
rt1.render(Comp1);
const noticeAfterAdd = ctx1.dateAnomalyNotice ?? null;
const hapticsAfterAdd = globalThis.__HAPTIC_LOG__.length;
const waterAfterAdd = ctx1.waterAmount;

// ② 三餐打卡（confirmCheck）：先打开午餐再确认
ctx1.openMeal('午餐');
rt1.render(Comp1);
// openMeal 自身会触发一次「打开弹窗」触感（合法 UI 反馈，与写入成功无关）。
// 这里清空日志，只观察 confirmCheck 被拒绝时是否触发触感。
globalThis.__HAPTIC_LOG__ = [];
await ctx1.confirmCheck();
rt1.render(Comp1);
const noticeAfterMeal = ctx1.dateAnomalyNotice ?? null;
const hapticsAfterMeal = globalThis.__HAPTIC_LOG__.length;
const mealsAfterMeal = ctx1.mealsStatus;

// ③ 重置（resetToday）
ctx1.resetToday();
rt1.render(Comp1);
const noticeAfterReset = ctx1.dateAnomalyNotice ?? null;
const hapticsAfterReset = globalThis.__HAPTIC_LOG__.length;
const waterAfterReset = ctx1.waterAmount;

// ④ 用户可见提示可被清除（供 UI 关闭）
const clearFn = typeof ctx1.clearDateAnomalyNotice === 'function';
if (clearFn) { ctx1.clearDateAnomalyNotice(); rt1.render(Comp1); }
const noticeAfterClear = ctx1.dateAnomalyNotice ?? null;

process.stdout.write(JSON.stringify({
  D0STR, D1STR,
  noticeAfterAdd, hapticsAfterAdd, waterAfterAdd,
  noticeAfterMeal, hapticsAfterMeal, mealsAfterMeal,
  noticeAfterReset, hapticsAfterReset, waterAfterReset,
  clearFn, noticeAfterClear,
}));
`);
    const diag = JSON.stringify(out);
    // ① 饮水：拒绝时必须给出用户可见提示
    assert.ok(
      typeof out.noticeAfterAdd === 'string' && out.noticeAfterAdd.length > 0,
      `FINAL-2：回拨期间饮水被拒绝时必须给出用户可见提示（dateAnomalyNotice），实际 ${out.noticeAfterAdd} | ${diag}`
    );
    // ① 饮水：拒绝时不得触发触感（无成功反馈）
    assert.equal(
      out.hapticsAfterAdd,
      0,
      `FINAL-2：回拨期间饮水被拒绝时不得触发触感反馈，实际 ${out.hapticsAfterAdd} 次 | ${diag}`
    );
    // ① 饮水：本地值保持不变（fail-closed 未变）
    assert.equal(out.waterAfterAdd, 800, `FINAL-2：回拨期间饮水写入必须被拒绝（本地保持 800）| ${diag}`);
    // ② 三餐：拒绝时同样给出提示、无触感、状态不变
    assert.ok(
      typeof out.noticeAfterMeal === 'string' && out.noticeAfterMeal.length > 0,
      `FINAL-2：回拨期间三餐被拒绝时必须给出用户可见提示 | ${diag}`
    );
    assert.equal(
      out.hapticsAfterMeal,
      0,
      `FINAL-2：回拨期间三餐被拒绝时不得触发触感反馈，实际 ${out.hapticsAfterMeal} 次 | ${diag}`
    );
    assert.equal(
      out.mealsAfterMeal?.['午餐'],
      false,
      `FINAL-2：回拨期间三餐写入必须被拒绝（午餐保持 false）| ${diag}`
    );
    // ③ 重置：拒绝时同样给出提示、无触感、状态不变
    assert.ok(
      typeof out.noticeAfterReset === 'string' && out.noticeAfterReset.length > 0,
      `FINAL-2：回拨期间重置被拒绝时必须给出用户可见提示 | ${diag}`
    );
    assert.equal(
      out.hapticsAfterReset,
      0,
      `FINAL-2：回拨期间重置被拒绝时不得触发触感反馈，实际 ${out.hapticsAfterReset} 次 | ${diag}`
    );
    assert.equal(out.waterAfterReset, 800, `FINAL-2：回拨期间重置必须被拒绝（本地保持 800）| ${diag}`);
    // ④ 提示可被清除
    assert.equal(out.clearFn, true, `FINAL-2：必须暴露 clearDateAnomalyNotice 供 UI 关闭提示 | ${diag}`);
    assert.equal(out.noticeAfterClear, null, `FINAL-2：清除后 dateAnomalyNotice 必须为 null | ${diag}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- END OF FILE tests/security/d11CrossDateIsolation.test.mjs ---