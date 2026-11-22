// --- START OF FILE tests/security/p14r8HealthPromiseTiming.test.mjs ---
/**
 * P1.4 R8 — Work A：useHealthData AppState 分支的 **Promise 时序等价** 验证
 *
 * 背景
 *   R7 交付后 GPT Gatekeeper 指出：`useHealthData.tsx` 的 AppState 'active' 分支
 *   仍残留 `Promise.resolve(supabase.rpc(...))` 包装，而迁移前冻结 JS 是直接
 *   `supabase.rpc(...).then(...).catch(...)`。
 *
 *   两者在「返回值最终结果」上等价，但**执行时序不同**：
 *     · 直接 `.then()`：若 rpc 返回 thenable，`.then` 在**同一同步栈**内被调用。
 *     · `Promise.resolve(thenable)`：先进入 Promise 同化流程，`.then` 被推迟到
 *       一个微任务之后才被调用。
 *
 *   本测试用**可控 thenable**（记录 `.then` 被调用的同步/异步时机）来证明：
 *     1. 冻结 JS 与当前 TSX 在 AppState 'active' 事件下的**同步调用顺序完全一致**；
 *     2. 迟到 RPC 响应在新身份下被身份闸门拦截（不 bindPartner / 不 setProfile）；
 *     3. 故障注入（把 `Promise.resolve` 包装重新塞回 TSX 临时副本）后，
 *        本测试的时序断言**必须失败**——证明测试不是空转。
 *
 * 机制
 *   · 与 p14r6HealthEquivalence 同构：自定义 Hook 运行时 + ts.transpileModule + 子进程沙箱。
 *   · 冻结基线只读（启动时校验 SHA-256）。
 *   · 不访问真实网络 / 数据库 / 真实用户数据。
 */

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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r6/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 冻结基线完整性（与 R6 同一份冻结 JS）
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__useHealthData.js':
    '803deafb6311f68db39a6a2fafe3acdd8f67bc4c0fbaff59dcc4ec2a2f698823',
  'hooks__health__useHealthCloud.js':
    'ba38ae88089b2b1f27609d97c233bd744bebd0a5f29173bedd42ad3929997a1a',
  'hooks__health__useHealthStorage.js':
    'a1b0677c99b8475151c962dd832d554ae5b93ac64f9a0748b3c25c4462df8797',
};

test('P14R8-A0 冻结基线完整性（SHA-256 未被篡改）', () => {
  for (const [name, expected] of Object.entries(EXPECTED_SHA)) {
    const p = path.join(beforeDir, name);
    assert.equal(fs.existsSync(p), true, `缺少冻结基线：${name}`);
    const actual = spawnSync('shasum', ['-a', '256', p], { encoding: 'utf8' })
      .stdout.trim()
      .split(/\s+/)[0];
    assert.equal(actual, expected, `冻结基线被修改：${name}`);
  }
});

// ---------------------------------------------------------------------------
// 极简 Hook 运行时（与 R6 测试同构，独立复制以保持自包含）
// ---------------------------------------------------------------------------
const HOOK_RUNTIME_SRC = String.raw`
function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function __createHookRuntime() {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let scheduled = false;
  let renderCount = 0;

  function render(fn) {
    renderCount += 1;
    cursor = 0;
    effects.length = 0;
    const out = fn();
    for (const e of effects) {
      if (!e.deps || !e.prevDeps || !shallowEqual(e.deps, e.prevDeps)) {
        if (e.cleanup) { try { e.cleanup(); } catch (_) {} }
        e.prevDeps = e.deps;
        const c = e.fn();
        e.cleanup = typeof c === 'function' ? c : null;
      }
    }
    scheduled = false;
    return out;
  }

  let lastFn = null;
  function rerender() {
    return render(lastFn);
  }

  const api = {
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { v: typeof init === 'function' ? init() : init };
      const slot = hooks[i];
      const setter = (next) => {
        const v = typeof next === 'function' ? next(slot.v) : next;
        if (!Object.is(v, slot.v)) { slot.v = v; scheduled = true; }
      };
      return [slot.v, setter];
    },
    useRef(v) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: v };
      return hooks[i];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { fn, deps: undefined, prevDeps: undefined, cleanup: null };
      const slot = hooks[i];
      slot.fn = fn;
      slot.deps = deps;
      effects.push(slot);
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { fn, deps };
      const slot = hooks[i];
      if (!slot.deps || !deps || !shallowEqual(deps, slot.deps)) { slot.fn = fn; slot.deps = deps; }
      return slot.fn;
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { v: fn(), deps };
      const slot = hooks[i];
      if (!slot.deps || !deps || !shallowEqual(deps, slot.deps)) { slot.v = fn(); slot.deps = deps; }
      return slot.v;
    },
    flushEffects() {
      for (const e of effects) {
        if (!e.deps || !e.prevDeps || !shallowEqual(e.deps, e.prevDeps)) {
          if (e.cleanup) { try { e.cleanup(); } catch (_) {} }
          e.prevDeps = e.deps;
          const c = e.fn();
          e.cleanup = typeof c === 'function' ? c : null;
        }
      }
    },
    unmount() {
      for (const e of effects) { if (e.cleanup) { try { e.cleanup(); } catch (_) {} } e.cleanup = null; }
    },
    render(fn) { lastFn = fn; return render(fn); },
    rerender() { return api.render(lastFn); },
    get renderCount() { return renderCount; },
    get isScheduled() { return scheduled; },
  };
  return api;
}
`;

// ---------------------------------------------------------------------------
// 沙箱构建
//   mode = 'before' → 冻结基线（迁移前 JS）
//   mode = 'after'  → 当前真实源码（迁移后 TSX）
//   opts.healthDataOverride → 用给定源码替换 useHealthData（故障注入用）
// ---------------------------------------------------------------------------
function buildSandbox(mode, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r8-health-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
${HOOK_RUNTIME_SRC}
let __active = null;
export function createHookRuntime() {
  const rt = __createHookRuntime();
  const wrap = (name) => (...args) => {
    if (!__active) throw new Error('Hook ' + name + ' called outside render()');
    return __active[name](...args);
  };
  const origRender = rt.render;
  rt.render = (fn) => { const prev = __active; __active = rt; try { return origRender(fn); } finally { __active = prev; } };
  return rt;
}
export const useState = (init) => { if (!__active) throw new Error('useState outside render'); return __active.useState(init); };
export const useEffect = (fn, deps) => { if (!__active) throw new Error('useEffect outside render'); return __active.useEffect(fn, deps); };
export const useCallback = (fn, deps) => { if (!__active) throw new Error('useCallback outside render'); return __active.useCallback(fn, deps); };
export const useMemo = (fn, deps) => { if (!__active) throw new Error('useMemo outside render'); return __active.useMemo(fn, deps); };
export const useRef = (v) => { if (!__active) throw new Error('useRef outside render'); return __active.useRef(v); };
export const createContext = (v) => ({ __ctx: v });
export const useContext = () => ({});
export function createElement(type, props, ...children) {
  const p = props ? { ...props } : {};
  if (children.length === 1) p.children = children[0];
  else if (children.length > 1) p.children = children;
  return { type, props: p };
}
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
export const __storageLog = [];
const AsyncStorage = {
  async getItem(k) { __storageLog.push(['getItem', k]); return store.has(k) ? store.get(k) : null; },
  async setItem(k, v) { __storageLog.push(['setItem', k, v]); store.set(k, String(v)); },
  async removeItem(k) { __storageLog.push(['removeItem', k]); store.delete(k); },
  async multiSet(pairs) { for (const [k, v] of pairs) store.set(k, String(v)); },
  async multiRemove(keys) { for (const k of keys) store.delete(k); },
  async getAllKeys() { return [...store.keys()]; },
  __store: store,
  __reset() { store.clear(); __storageLog.length = 0; },
};
export default AsyncStorage;
`,
  });

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
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
`,
  });

  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export async function impactAsync() {}
export async function notificationAsync() {}
export async function selectionAsync() {}
export default { ImpactFeedbackStyle, NotificationFeedbackType, impactAsync, notificationAsync, selectionAsync };
`,
  });

  const transpile = (src, fileName) =>
    ts.transpileModule(src, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      fileName,
    }).outputText;

  const place = (srcPath, dstRel, rawOverride) => {
    let src = rawOverride != null ? rawOverride : fs.readFileSync(srcPath, 'utf8');
    if (srcPath.endsWith('hooks__useHealthData.js')) {
      src = src.replace(
        /return <HealthContext\.Provider value=\{value\}>\{children\}<\/HealthContext\.Provider>;/,
        'return React.createElement(HealthContext.Provider, { value }, children);'
      );
      src = "import * as React from 'react';\n" + src;
    }
    if (srcPath.endsWith('useHealthData.tsx')) {
      src = "import * as React from 'react';\n" + src;
    }
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, transpile(src, path.basename(srcPath)));
  };

  const MODULES = [
    ['hooks__useHealthData.js', 'src/hooks/useHealthData.tsx', 'src/hooks/useHealthData.js'],
    ['hooks__health__useHealthCloud.js', 'src/hooks/health/useHealthCloud.ts', 'src/hooks/health/useHealthCloud.js'],
    ['hooks__health__useHealthStorage.js', 'src/hooks/health/useHealthStorage.ts', 'src/hooks/health/useHealthStorage.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') {
      place(path.join(beforeDir, beforeName), dstRel);
    } else if (dstRel === 'src/hooks/useHealthData.js' && opts.healthDataOverride != null) {
      place(path.join(repoRoot, afterRel), dstRel, opts.healthDataOverride);
    } else {
      place(path.join(repoRoot, afterRel), dstRel);
    }
  }

  const SHARED = [
    ['src/hooks/health/useTimeSync.ts', 'src/hooks/health/useTimeSync.js'],
    ['src/hooks/health/useStreak.ts', 'src/hooks/health/useStreak.js'],
    ['src/hooks/health/constants.ts', 'src/hooks/health/constants.js'],
    ['src/hooks/health/dateUtils.ts', 'src/hooks/health/dateUtils.js'],
    ['src/hooks/health/authRevokeLogic.ts', 'src/hooks/health/authRevokeLogic.js'],
    ['src/hooks/profile/useProfileCache.ts', 'src/hooks/profile/useProfileCache.js'],
  ];
  for (const [srcRel, dstRel] of SHARED) place(path.join(repoRoot, srcRel), dstRel);

  fs.mkdirSync(path.join(dir, 'src/hooks'), { recursive: true });
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

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/pushService.js'), `
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!globalThis.__PUSH_LOG__) globalThis.__PUSH_LOG__ = [];
  globalThis.__PUSH_LOG__.push({ receiverId, title, body, data });
  return { ok: true };
}
`);

  // supabase stub：rpc 支持「可控 thenable」注入（用于时序探测）
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  channels: [],
  rpcImpl: null,
  queryImpl: null,
  upsertImpl: null,
  upsertCalls: [],
  rpcCalls: [],
};

function makeChannel(name) {
  const ch = { topic: 'realtime:' + name, name, handlers: [], removed: false, subscribed: false };
  const api = {
    topic: ch.topic,
    name: ch.name,
    on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return api; },
    subscribe(cb) { ch.subscribed = true; if (cb) ch.subscribeCb = cb; return api; },
    __emit(type, event, payload) {
      for (const h of ch.handlers) {
        if (h.type !== type) continue;
        const fe = h.filter && h.filter.event;
        if (fe !== undefined && fe !== '*' && fe !== event) continue;
        h.cb(payload);
      }
    },
  };
  ch.api = api;
  state.channels.push(ch);
  return api;
}

export const supabase = {
  __state: state,
  __reset() {
    state.channels.length = 0;
    state.rpcImpl = null; state.queryImpl = null; state.upsertImpl = null;
    state.upsertCalls.length = 0; state.rpcCalls.length = 0;
  },
  __emit(channelName, type, event, payload) {
    const ch = state.channels.find((c) => c.name === channelName && !c.removed);
    if (!ch) return 0;
    ch.api.__emit(type, event, payload);
    return 1;
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
    state.rpcCalls.push({ fn, args });
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
  fs.writeFileSync(
    path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'.tsx',c);}catch{}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}}return n(s,c);}`
  );
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(
    entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
  );
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

function runBoth(body) {
  const before = runInSandbox(buildSandbox('before'), body);
  const after = runInSandbox(buildSandbox('after'), body);
  return { before, after };
}

function assertEqualBoth(body, label) {
  const { before, after } = runBoth(body);
  assert.deepEqual(after, before, `R8 迁移后必须与旧 JS 等价：${label}`);
  return { before, after };
}

// ===========================================================================
// 公共 PRELUDE（与 R6 同构，虚拟时钟锚定真实今天）
// ===========================================================================
const COMMON_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { supabase } = await import('./src/services/supabase');
const __sb = supabase.__state;

let __now = Math.floor(Date.now() / 1000) * 1000;
const __timers = new Map();
let __timerSeq = 1;
globalThis.setTimeout = (fn, delay) => {
  const id = __timerSeq++;
  __timers.set(id, { fn, at: __now + (delay || 0), interval: null });
  return id;
};
globalThis.setInterval = (fn, delay) => {
  const id = __timerSeq++;
  __timers.set(id, { fn, at: __now + (delay || 0), interval: delay || 0 });
  return id;
};
globalThis.clearTimeout = (id) => { __timers.delete(id); };
globalThis.clearInterval = (id) => { __timers.delete(id); };
Date.now = () => __now;
function advance(ms) {
  const target = __now + ms;
  let guard = 0;
  while (guard++ < 10000) {
    let nextId = null;
    let nextAt = Infinity;
    for (const [id, t] of __timers) {
      if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
    }
    if (nextId === null) break;
    const t = __timers.get(nextId);
    __now = t.at;
    if (t.interval) t.at = __now + t.interval;
    else __timers.delete(nextId);
    try { t.fn(); } catch (_) {}
  }
  __now = target;
}
async function flushMicrotasks(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
`;

const DATA_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { HealthProvider } = await import('./src/hooks/useHealthData');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage');
const { formatDateStr } = await import('./src/hooks/health/dateUtils');
const { AppState } = await import('react-native');
const rt = createHookRuntime();
let ctx = null;
function mountProvider() {
  const el = rt.render(() => HealthProvider({ children: null }));
  ctx = el && el.props ? el.props.value : null;
  return ctx;
}
function rerender() { return mountProvider(); }
async function boot(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    advance(0);
    await flushMicrotasks(8);
    rerender();
  }
  return ctx;
}
`;

// ===========================================================================
// A-01 可控 thenable：证明 AppState 'active' 分支的 .then 同步调用时机
//
//   构造一个「记录 .then 被调用时是否仍在同步栈内」的 thenable：
//     · 直接 `rpc(...).then(cb)` → 同步栈内立即调用 .then（syncThenCall = true）
//     · `Promise.resolve(rpc(...)).then(cb)` → .then 被推迟到微任务（syncThenCall = false）
//
//   冻结 JS 与当前 TSX 必须给出**完全一致**的 syncThenCall 结果。
// ===========================================================================
test('A-01 AppState active：rpc .then 同步调用时机与旧 JS 一致', async () => {
  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(A);
await AS.setItem(k.water, '500');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);

supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });

// 可控 thenable：记录 .then 是否在同步栈内被调用
// ⚠️ boot() 期间 loadAllData 也会走 rpc（非 AppState 路径），因此必须**只统计
//    __emit 同步栈内发生的 .then 调用**。用 __inEmit 作为闸门：仅当其为 true 时
//    记录到 emitSyncFlags；同时统计 emitThenCount（emit 期间 .then 调用次数）。
//    一次 __emit 可能触发多个存活监听器 → 计数可能 >1，但**全部**都必须在同步栈内。
let emitSyncFlags = [];
let emitThenCount = 0;
const probeThenable = {
  then(onFulfilled) {
    if (globalThis.__inEmit === true) {
      emitThenCount += 1;
      emitSyncFlags.push(true);
    }
    return Promise.resolve({ data: null, error: null }).then(onFulfilled);
  },
};
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_active_partner_id') return probeThenable;
  return Promise.resolve({ data: null, error: null });
};

await boot();
const listenerCount = AppState.__listenerCount();
globalThis.__inEmit = true;
AppState.__emit('active');
globalThis.__inEmit = false;

await flushMicrotasks(20);
rerender();

out({ emitSyncFlags, emitThenCount, listenerCount });
`;
  const { before, after } = assertEqualBoth(body, 'A-01');
  assert.ok(before.emitThenCount >= 1, '冻结 JS 在 emit 同步栈内至少调用一次 .then');
  assert.equal(before.emitSyncFlags.every((f) => f === true), true, '冻结 JS emit 期间所有 .then 调用都应在同步栈内');
  assert.ok(after.emitThenCount >= 1, '当前 TSX 在 emit 同步栈内至少调用一次 .then');
  assert.equal(after.emitSyncFlags.every((f) => f === true), true, '当前 TSX emit 期间所有 .then 调用都必须在同步栈内（不得经 Promise 同化）');
  assert.equal(after.emitThenCount, before.emitThenCount, '当前 TSX 与冻结 JS 的 emit 期间 .then 调用次数必须一致');
  assert.equal(after.listenerCount, before.listenerCount, '当前 TSX 与冻结 JS 的存活监听器数量必须一致');
});

// ===========================================================================
// A-02 迟到 RPC 响应在新身份下被身份闸门拦截（不 bindPartner / 不 setProfile）
// ===========================================================================
test('A-02 迟到 RPC：身份切换后旧响应不得 bindPartner / 改写 profile', async () => {
  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
const B = 'user-bbb';
const DATE = formatDateStr(new Date());
const kA = buildHealthKeys(A);
await AS.setItem(kA.water, '500');
await AS.setItem(kA.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(kA.active, DATE);

supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });

// 挂起型 rpc：返回一个「手动 resolve」的 thenable，模拟迟到响应
let pendingResolve = null;
const lateThenable = {
  then(onFulfilled) {
    return new Promise((resolve) => {
      pendingResolve = () => resolve(onFulfilled({ data: 'partner-zzz', error: null }));
    });
  },
};
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_active_partner_id') return lateThenable;
  return Promise.resolve({ data: null, error: null });
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
await boot();

// A 会话下触发 active，rpc 挂起
AppState.__emit('active');
await flushMicrotasks(4);

// 切换到 B（身份变化，旧监听器应被移除；即便旧回调迟到也必须被闸门拦截）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 2;
await boot();

const boundBefore = ctx.profile ? ctx.profile.bound_partner_id : null;

// 现在让 A 会话的迟到 RPC 响应落地
if (pendingResolve) pendingResolve();
await flushMicrotasks(20);
rerender();

const boundAfter = ctx.profile ? ctx.profile.bound_partner_id : null;
out({ boundBefore, boundAfter });
`;
  const { before, after } = assertEqualBoth(body, 'A-02');
  assert.equal(before.boundAfter, before.boundBefore, '冻结 JS：迟到响应不得改写 profile');
  assert.equal(after.boundAfter, after.boundBefore, '当前 TSX：迟到响应不得改写 profile');
  assert.notEqual(after.boundAfter, 'partner-zzz', '当前 TSX：不得绑定旧会话的 partner');
});

// ===========================================================================
// A-03 故障注入：把 Promise.resolve 包装重新塞回 TSX 临时副本，
//      证明 A-01 的时序断言能够检出差异（测试非空转）
// ===========================================================================
test('A-03 故障注入：重新注入 Promise.resolve 后时序断言必须失败', async () => {
  const tsxPath = path.join(repoRoot, 'src/hooks/useHealthData.tsx');
  const original = fs.readFileSync(tsxPath, 'utf8');

  // 把「直接 .then」重新包成 Promise.resolve(...)，模拟 R7 残留缺陷
  const injected = original.replace(
    /\(supabase!\.rpc\('get_active_partner_id'\) as unknown as Promise<\{\s*data: string \| null;\s*error: unknown;\s*\}>\)/,
    "Promise.resolve(supabase!.rpc('get_active_partner_id') as unknown as Promise<{ data: string | null; error: unknown; }>)"
  );
  assert.notEqual(injected, original, '故障注入必须真正改写源码（否则测试无效）');

  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(A);
await AS.setItem(k.water, '500');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);

supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });

// 注入 Promise.resolve 后，.then 被推迟到微任务 → emit 期间不会同步调用 .then。
// 因此 emitThenCount 必须为 0（对比 A-01 中冻结 JS/当前 TSX 的 emitThenCount >= 1）。
let emitThenCount = 0;
const probeThenable = {
  then(onFulfilled) {
    if (globalThis.__inEmit === true) emitThenCount += 1;
    return Promise.resolve({ data: null, error: null }).then(onFulfilled);
  },
};
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_active_partner_id') return probeThenable;
  return Promise.resolve({ data: null, error: null });
};

await boot();
globalThis.__inEmit = true;
AppState.__emit('active');
globalThis.__inEmit = false;

await flushMicrotasks(20);
rerender();

out({ emitThenCount });
`;

  // 用注入后的源码构建 after 沙箱
  const dir = buildSandbox('after', { healthDataOverride: injected });
  const result = runInSandbox(dir, body);

  // 注入 Promise.resolve 后，emit 期间 .then 被推迟到微任务 → emitThenCount 必须为 0
  assert.equal(
    result.emitThenCount,
    0,
    '故障注入后 emit 期间不得同步调用 .then（emitThenCount=0），证明 A-01 断言可检出差异'
  );
});

// --- END OF FILE tests/security/p14r8HealthPromiseTiming.test.mjs ---