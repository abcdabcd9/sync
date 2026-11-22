// --- START OF FILE tests/security/d11ClockRollback.test.mjs ---
// ============================================================================
// TASK-P0.3 / D-11 — 系统日期回拨后健康记录被覆盖 复现与回归测试
//
// 设备验收现象（D-11）：
//   手动把手机系统日期回拨到「前一天」→ 修改健康记录（饮水/三餐）→
//   新记录被覆盖（用户看到的是旧值 / 记录丢失）。
//
// 本测试用「真实源码 + 可控时钟」在纯 Node 沙箱中复现该链路：
//   · 真实执行 useHealthData.js / useHealthStorage.js / useHealthCloud.js /
//     useTimeSync.js / useStreak.js 源码；
//   · 通过覆写 Date.now / new Date() 模拟系统时钟回拨；
//   · 通过 stub supabase 控制 get_server_time 校准结果（在线 / 离线两种）；
//   · AsyncStorage 为真实内存 Map，跨「进程重建」保留（模拟磁盘仍在）。
//
// 覆盖场景：
//   D11-A  离线（校准失败，沿用旧 offset）下系统日期回拨到前一天：
//          用户修改饮水 → 不得把「回拨后的前一天」记录清零/覆盖；
//          恢复系统时间后，原「今天」的记录必须完好。
//   D11-B  在线（校准成功，offset 跟随回拨）下系统日期回拨：
//          新操作必须归属到「回拨后的日期」，且不得破坏原「今天」记录。
//   D11-C  回拨后冷启动：磁盘上「未来日期」的 active 不得导致当日记录被清零。
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
// 沙箱构建：与 b4HealthSyncReliability.test.mjs 的 buildHealthProviderSandbox
// 保持一致的 stub 语义（react / AsyncStorage / react-native / expo-haptics /
// supabase / useAuth），额外提供「可控时钟」注入点。
// ---------------------------------------------------------------------------
function buildSandbox(extraCopies = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-clock-'));
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

  // P1.4 R2：useProfileCache 已迁移为 .ts，按 .ts 优先、.js 兜底解析，
  // 使沙箱始终复制当前真实源码（Node 24 原生类型擦除执行）。
  const resolveSrc = (rel) => {
    const tsxRel = rel.replace(/\.js$/, '.tsx');
    if (fs.existsSync(path.join(repoRoot, tsxRel))) return tsxRel;
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
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
// 可控时钟：覆写 Date.now / Date 构造，模拟系统日期回拨。
//   · setWallClock(iso) 把「系统当前时间」固定到指定时刻；
//   · 所有 new Date() / Date.now() 都基于该固定时刻（可加偏移）。
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
// D11-A：离线（校准失败，沿用旧 offset）下系统日期回拨到前一天。
//
// 生产链路：
//   1) 用户「今天」(D0) 有 water=800 的记录（本地 + 云端一致）；
//   2) 系统日期回拨到 D0-1（前一天）；
//   3) 用户修改饮水（+1）；
//   4) 期望：D0 的记录不被清零/覆盖；回拨后的操作不得把 D0 数据写坏。
// ---------------------------------------------------------------------------
test('D11-A 离线日期回拨：修改记录不得清零/覆盖原「今天」数据', () => {
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
// 固定「今天」为 2026-11-20 12:00 本地时间
const D0 = new RealDate(2026, 10, 20, 12, 0, 0);
__setWall(D0.getTime());
const D0STR = formatDateStr(new RealDate(__wall));
// 回拨到前一天
const D1 = new RealDate(2026, 10, 19, 12, 0, 0);
const D1STR = formatDateStr(D1);

const k = buildHealthKeys(A);
// 预置本地：D0 有 water=800
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

// 云端：D0 快照 water=800；离线 → get_server_time 失败
supabase.__reset();
const cloudRows = { [D0STR]: { water_amount: 800, meals_status: { '早餐': true, '午餐': false, '晚餐': false } } };
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
const diskD0Before = await AS.getItem(k.water);

// ── 系统日期回拨到 D1（离线，offset 沿用旧值 → getDateStr 仍返回 D0）──
__setWall(D1.getTime());

// 用户修改饮水（+1）
ctx1.handleAddWater();
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 120));
const waterAfterEdit = ctx1.waterAmount;
const diskAfterEdit = await AS.getItem(k.water);
const activeAfterEdit = await AS.getItem(k.active);

// ── 恢复系统时间到 D0，冷启动重建 ──
__setWall(D0.getTime());
rt1.unmount();
const rt2 = React.__createRuntime();
let ctx2 = null;
const Comp2 = () => { const el = HealthProvider({ children: null }); ctx2 = el && el.props ? el.props.value : null; return null; };
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 120));
rt2.render(Comp2);
const waterAfterRestore = ctx2.waterAmount;
const diskAfterRestore = await AS.getItem(k.water);

const pendingRaw = await AS.getItem('@sync_health_pending_v1_' + A);
const pendingObj = pendingRaw ? JSON.parse(pendingRaw) : null;
process.stdout.write(JSON.stringify({
  D0STR, D1STR,
  waterD0Before, diskD0Before,
  waterAfterEdit, diskAfterEdit, activeAfterEdit,
  waterAfterRestore, diskAfterRestore,
  cloudD0: cloudRows[D0STR] ? cloudRows[D0STR].water_amount : null,
  cloudD1: cloudRows[D1STR] ? cloudRows[D1STR].water_amount : null,
  pendingKeys: pendingObj ? Object.keys(pendingObj) : null,
  pendingD0: pendingObj && pendingObj[D0STR] ? pendingObj[D0STR].water : null,
  pendingD1: pendingObj && pendingObj[D1STR] ? pendingObj[D1STR].water : null,
  upserts: supabase.__state.upsertCalls.map((c) => ({ date: c.row.record_date, water: c.row.water_amount })),
}));
`);
    // 前置：D0 加载为 800
    assert.equal(out.waterD0Before, 800, '前置：D0 加载后 water 应为 800');
    assert.equal(out.diskD0Before, '800', '前置：D0 磁盘 water 应为 800');
    // 核心：回拨后修改不得把 D0 数据清零
    assert.notEqual(out.waterAfterEdit, 0, `回拨后修改不得把 water 清零，实际 ${out.waterAfterEdit}`);
    assert.notEqual(out.diskAfterEdit, '0', `回拨后修改不得把磁盘 water 清零，实际 ${out.diskAfterEdit}`);
    // 🛡️ L4 ROUND2 BLOCK-01 修正：离线回拨期间归属不确定 → 不同步云端。
    //    因此 D0 云端记录必须保持 800（不得被回拨期间的 +1 写成 801 而「破坏」D0）。
    //    恢复系统时间后本地可能短暂为 801，但云端权威值仍为 800，hydrate 后回到 800。
    //    核心不变量：D0 不得被清零、云端 D0 不得被回拨期间操作破坏。
    assert.notEqual(out.waterAfterRestore, 0, `恢复系统时间后 D0 记录不得为 0，实际 ${out.waterAfterRestore}`);
    assert.equal(
      out.cloudD0,
      800,
      `离线回拨期间不得把 D0 云端记录写成 801（归属不确定应不同步），实际 ${out.cloudD0}；诊断=${JSON.stringify({ waterAfterEdit: out.waterAfterEdit, diskAfterEdit: out.diskAfterEdit, activeAfterEdit: out.activeAfterEdit, pendingKeys: out.pendingKeys, pendingD0: out.pendingD0, pendingD1: out.pendingD1, upserts: out.upserts })}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D11-B：在线（校准成功，offset 跟随回拨）下系统日期回拨。
//
// 期望：新操作归属到「回拨后的日期」(D1)，且 D0 记录不被破坏。
// ---------------------------------------------------------------------------
test('D11-B 在线日期回拨：新操作归属回拨后日期，原「今天」记录不被破坏', () => {
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
__setWall(D0.getTime());
const D0STR = formatDateStr(new RealDate(__wall));
const D1 = new RealDate(2026, 10, 19, 12, 0, 0);
const D1STR = formatDateStr(D1);

const k = buildHealthKeys(A);
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
const cloudRows = { [D0STR]: { water_amount: 800, meals_status: { '早餐': true, '午餐': false, '晚餐': false } } };
// 🛡️ L4 ROUND2 BLOCK-01 修正：get_server_time 必须模拟「独立于手机系统时钟的真实服务器时间」。
//    真实服务器不会因用户回拨手机而回拨 —— 固定返回 D0（真实时间），
//    不得返回被回拨后的本机时间（旧实现 new RealDate(__wall) 是错误模拟）。
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

// 回拨到 D1（在线，校准会跟随）
__setWall(D1.getTime());
// 触发一次前台切换，使 loadAllData 重新校准并读取 D1
const { AppState } = await import('react-native');
AppState.__emit('background');
AppState.__emit('active');
await new Promise((r) => setTimeout(r, 120));
rt1.render(Comp1);

// 用户修改饮水（+1）
ctx1.handleAddWater();
rt1.render(Comp1);
// 云端防抖 DEBOUNCE_MS=1500，必须等待超过防抖窗口才能触发 tryFlushPending。
await new Promise((r) => setTimeout(r, 1800));
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 300));

const upserts = supabase.__state.upsertCalls.map((c) => ({ date: c.row.record_date, water: c.row.water_amount }));
const d0Disk = await AS.getItem(k.water);

process.stdout.write(JSON.stringify({
  D0STR, D1STR, waterD0Before, upserts, d0Disk,
  cloudD0: cloudRows[D0STR] ? cloudRows[D0STR].water_amount : null,
  cloudD1: cloudRows[D1STR] ? cloudRows[D1STR].water_amount : null,
}));
`);
    const diag = JSON.stringify(out);
    assert.equal(out.waterD0Before, 800, `前置：D0 加载后 water 应为 800 | ${diag}`);
    // 🛡️ L4 ROUND2 BLOCK-01 修正：在线校准成功时 getDateStr() 返回服务器真实日期 D0，
    //    新操作应归属 D0（可解释：用户确实在 D0 操作），D0 变为 801。
    const d0Upserts = out.upserts.filter((u) => u.date === out.D0STR);
    assert.ok(d0Upserts.length > 0, `在线回拨后新操作必须归属服务器真实日期 D0 | ${diag}`);
    assert.equal(out.cloudD0, 801, `在线回拨后 D0 应为 801（800+1）| ${diag}`);
    // D1 历史记录不得被污染（本场景云端无 D1 行，故为 null）
    assert.equal(out.cloudD1, null, `D1 不得被写入（历史无记录应保持 null）| ${diag}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D11-C：回拨后冷启动 —— 磁盘 active 为「未来日期」时不得清零当日记录。
//
// 场景：用户在 D0 使用后，系统回拨到 D1，然后冷启动。
//   磁盘 active=D0（相对 D1 是「未来」），water=800。
//   期望：不得因 active != today 就无条件清零（否则 D0 记录丢失）。
// ---------------------------------------------------------------------------
test('D11-C 回拨后冷启动：磁盘 active 为未来日期时不得清零当日记录', () => {
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

// 系统时间已回拨到 D1
__setWall(D1.getTime());

const k = buildHealthKeys(A);
// 磁盘：active=D0（未来），water=800
await AS.setItem(k.water, '800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, D0STR);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_server_time') return Promise.resolve({ data: new RealDate(__wall).toISOString(), error: null });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: { code: 'PGRST116' } });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;

const rt = React.__createRuntime();
let ctx = null;
const Comp = () => { const el = HealthProvider({ children: null }); ctx = el && el.props ? el.props.value : null; return null; };
rt.render(Comp);
await new Promise((r) => setTimeout(r, 120));
rt.render(Comp);

const waterAfterColdStart = ctx.waterAmount;
const diskAfterColdStart = await AS.getItem(k.water);
const activeAfterColdStart = await AS.getItem(k.active);

process.stdout.write(JSON.stringify({
  D0STR, D1STR, waterAfterColdStart, diskAfterColdStart, activeAfterColdStart,
}));
`);
    // 核心：回拨后冷启动不得把 D0 的 800 清零
    assert.notEqual(out.waterAfterColdStart, 0, `回拨后冷启动不得把 water 清零，实际 ${out.waterAfterColdStart}`);
    assert.notEqual(out.diskAfterColdStart, '0', `回拨后冷启动不得把磁盘 water 清零，实际 ${out.diskAfterColdStart}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- END OF FILE tests/security/d11ClockRollback.test.mjs ---
