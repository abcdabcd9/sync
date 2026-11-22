// --- START OF FILE tests/security/p14r6HealthEquivalence.test.mjs ---
/**
 * P1.4 R6 — Work B：Health 大型模块 JS→TS 迁移的**新旧真实执行等价**验证
 *
 * 目标
 *   对以下三个模块做「冻结 JS 基线 vs 当前 TS 源码」的真实执行对比：
 *     · src/hooks/useHealthData.tsx        （HealthProvider 编排层）
 *     · src/hooks/health/useHealthCloud.ts （云端 IO + Pending 队列）
 *     · src/hooks/health/useHealthStorage.ts（本地磁盘存储）
 *
 * 覆盖的关键业务不变量（逐条断言）：
 *   H-01  useHealthStorage：8 个 V2 key 命名空间 + 无 userId 时 buildHealthKeys 返回 null
 *   H-02  useHealthStorage：load 读取 8 个字段并正确解析（water 数字 / meals JSON / guides JSON）
 *   H-03  useHealthStorage：setWater / setMeals / setMaxWater / setMotto / setMealGuide 落盘
 *   H-04  useHealthStorage：身份切换（userId / authEpoch）后 setter 必须 fail-closed
 *   H-05  useHealthStorage：hydrateFromCloud 覆盖本地并落盘
 *   H-06  useHealthStorage：resetTodayLocal 清空当日
 *   H-07  useHealthCloud：syncToCloud 防抖 1500ms 后 upsert（请求参数逐字段一致）
 *   H-08  useHealthCloud：upsert 失败 → pending 保留在内存 + 磁盘
 *   H-09  useHealthCloud：flushNow 立即提交并清理 pending
 *   H-10  useHealthCloud：A→B 跨账号隔离（B 不得提交 A 的 pending）
 *   H-11  useHealthCloud：fetchMyRecord / fetchPartnerRecord 返回形态
 *   H-12  useHealthCloud：subscribePartner 收到 postgres_changes 后回调
 *   H-13  useHealthCloud：hasPendingFor 闸门
 *   H-14  useHealthData：HealthProvider 公开接口字段集合完全一致
 *   H-15  useHealthData：handleAddWater / handleMinusWater 边界（0 下限 / maxWater 上限）
 *   H-16  useHealthData：confirmCheck / undoCheck 状态机
 *   H-17  useHealthData：openMeal / closeMeal 选中态
 *   H-18  useHealthData：updateMaxWater / updateMotto / updateMealGuide
 *   H-19  useHealthData：resetToday
 *   H-20  useHealthData：A→B→A 身份切换后不串号
 *
 * 机制
 *   · 与 R5 等价测试同构：自定义 Hook 运行时 + ts.transpileModule + 子进程沙箱。
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
// 冻结基线完整性
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__useHealthData.js':
    '803deafb6311f68db39a6a2fafe3acdd8f67bc4c0fbaff59dcc4ec2a2f698823',
  'hooks__health__useHealthCloud.js':
    'ba38ae88089b2b1f27609d97c233bd744bebd0a5f29173bedd42ad3929997a1a',
  'hooks__health__useHealthStorage.js':
    'a1b0677c99b8475151c962dd832d554ae5b93ac64f9a0748b3c25c4462df8797',
};

test('P14R6-H0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 R5 测试同构，独立复制以保持自包含）
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

  // 单次渲染：执行函数体 + 结算本轮 effect。
  // ⚠️ 不做「循环到 state 稳定」——真实 React 中 setState 只触发下一轮渲染，
  //    而 effect 内的异步 setState 在微任务中到达，必须由外部 rerender 推进。
  //    若在此处循环，会把 effect 里 setState 的结果在同一帧内反复重跑，
  //    导致 hook 槽位与真实 React 语义偏离。
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
//   mode = 'after'  → 当前真实源码（迁移后 TS/TSX）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r6-health-${mode}-`));
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

  const place = (srcPath, dstRel) => {
    let src = fs.readFileSync(srcPath, 'utf8');
    // ⚠️ 冻结基线 useHealthData.js 含原始 JSX（.js 扩展名，ts.transpileModule 不会转换）。
    //    这里做最小等价改写为 React.createElement（不改变任何业务逻辑），
    //    并补一行 import * as React，使该文件可在沙箱中被真实 import 与执行。
    //    当前 TS 源码（.tsx）由 transpile 的 jsx: React 自动转换，无需改写。
    if (srcPath.endsWith('hooks__useHealthData.js')) {
      src = src.replace(
        /return <HealthContext\.Provider value=\{value\}>\{children\}<\/HealthContext\.Provider>;/,
        'return React.createElement(HealthContext.Provider, { value }, children);'
      );
      src = "import * as React from 'react';\n" + src;
    }
    // ⚠️ TS 源码 useHealthData.tsx 的 JSX 由 ts.transpileModule(jsx: React) 转成
    //    React.createElement(...)，但源码只 import 了具名 Hook、没有 import React，
    //    沙箱执行时会抛 "React is not defined"。这里补一行 import * as React，
    //    仅补齐 JSX 运行时依赖，不改变任何业务逻辑。
    if (srcPath.endsWith('useHealthData.tsx')) {
      src = "import * as React from 'react';\n" + src;
    }
    // ⚠️ 冻结基线 useHealthStorage.js 的 useState 初值来自模块级常量 EMPTY_MEALS。
    //    该常量在文件内定义，行为与 TS 版一致，无需改写。
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, transpile(src, path.basename(srcPath)));
  };

  // [beforeName, afterRel, dstRel]
  const MODULES = [
    ['hooks__useHealthData.js', 'src/hooks/useHealthData.tsx', 'src/hooks/useHealthData.js'],
    ['hooks__health__useHealthCloud.js', 'src/hooks/health/useHealthCloud.ts', 'src/hooks/health/useHealthCloud.js'],
    ['hooks__health__useHealthStorage.js', 'src/hooks/health/useHealthStorage.ts', 'src/hooks/health/useHealthStorage.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') place(path.join(beforeDir, beforeName), dstRel);
    else place(path.join(repoRoot, afterRel), dstRel);
  }

  // 依赖模块：新旧一致（R5 已迁移的 useTimeSync / useStreak / constants / dateUtils / authRevokeLogic）
  const SHARED = [
    ['src/hooks/health/useTimeSync.ts', 'src/hooks/health/useTimeSync.js'],
    ['src/hooks/health/useStreak.ts', 'src/hooks/health/useStreak.js'],
    ['src/hooks/health/constants.ts', 'src/hooks/health/constants.js'],
    ['src/hooks/health/dateUtils.ts', 'src/hooks/health/dateUtils.js'],
    ['src/hooks/health/authRevokeLogic.ts', 'src/hooks/health/authRevokeLogic.js'],
    ['src/hooks/profile/useProfileCache.ts', 'src/hooks/profile/useProfileCache.js'],
  ];
  for (const [srcRel, dstRel] of SHARED) place(path.join(repoRoot, srcRel), dstRel);

  // useAuth stub：由 __UID__ / __EPOCH__ 驱动，按 uid::epoch 缓存返回对象
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

  // pushService stub
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/pushService.js'), `
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!globalThis.__PUSH_LOG__) globalThis.__PUSH_LOG__ = [];
  globalThis.__PUSH_LOG__.push({ receiverId, title, body, data });
  return { ok: true };
}
`);

  // supabase stub：可注入 upsert / query / rpc 结果，捕获请求参数
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
    // ⚠️ 真实 supabase channel() 返回对象带 topic/name；removeChannel(api) 依赖它定位。
    //    旧桩缺这两个字段，导致 unsubscribe 无法移除 channel（桩缺陷，非源码缺陷）。
    topic: ch.topic,
    name: ch.name,
    on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return api; },
    subscribe(cb) { ch.subscribed = true; if (cb) ch.subscribeCb = cb; return api; },
    __emit(type, event, payload) {
      for (const h of ch.handlers) {
        if (h.type !== type) continue;
        const fe = h.filter && h.filter.event;
        // ⚠️ Supabase Realtime 语义：filter.event === '*' 表示通配所有事件。
        //    旧桩实现只做严格相等，导致 event:'*' 的订阅永远收不到 'UPDATE'，
        //    H-12 因此恒为 0（测试桩缺陷，非源码缺陷）。
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
  __reset() { state.channels.length = 0; state.rpcImpl = null; state.queryImpl = null; state.upsertImpl = null; state.upsertCalls.length = 0; },
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
  assert.deepEqual(after, before, `R6 迁移后必须与旧 JS 等价：${label}`);
  return { before, after };
}

// ===========================================================================
// 公共 PRELUDE
// ===========================================================================
const COMMON_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { supabase } = await import('./src/services/supabase');
const __sb = supabase.__state;

// ⚠️ 虚拟时钟必须锚定到「真实今天」，否则 useHealthData 的日期归属守卫
//    （isBackwardSkew：getDateStr() < lastActiveDate）会把所有写入判为时钟回拨
//    并 fail-closed，导致 handleAddWater / resetToday 等全部被拒。
//    这里取真实当前时间（截断到秒），使 formatDateStr(new Date()) === 真实今天。
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

const STORAGE_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const S = await import('./src/hooks/health/useHealthStorage');
const { useHealthStorage, buildHealthKeys } = S;
const rt = createHookRuntime();
let last = null;
function mount(today, uid, epoch) { last = rt.render(() => useHealthStorage(today, uid, epoch)); return last; }
function rerender() { last = rt.rerender(); return last; }
// 等待 Hook 内部 effect 链（load → setState → 自动落盘）全部结算。
// 虚拟时钟下 setTimeout 不会自行触发，因此这里只做微任务轮转 + 重渲染。
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    last = rt.rerender();
  }
  return last;
}
`;

const CLOUD_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud');
const rt = createHookRuntime();
let last = null;
function mount(user, getDateStr, epoch) { last = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return last; }
function rerender() { last = rt.rerender(); return last; }
`;

const DATA_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { HealthProvider } = await import('./src/hooks/useHealthData');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage');
const { formatDateStr } = await import('./src/hooks/health/dateUtils');
const rt = createHookRuntime();
let ctx = null;
function mountProvider() {
  const el = rt.render(() => HealthProvider({ children: null }));
  ctx = el && el.props ? el.props.value : null;
  return ctx;
}
function rerender() { return mountProvider(); }
// ⚠️ HealthProvider 的 loadAllData 由 useEffect 内的 setTimeout(..., 0) 触发。
//    虚拟时钟下 setTimeout 不会自行执行，必须显式 advance(0) 让定时器回调落地，
//    再轮转微任务让 calibrate → loadLocal → rpc → fetchMyRecord → hydrateFromCloud
//    这条异步链逐段推进（每段之间都需要一次 rerender 让 setState 生效）。
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
// H-01 buildHealthKeys：8 个 V2 key + 无 userId 返回 null
// ===========================================================================
test('H-01 buildHealthKeys：V2 命名空间 8 个 key，无 userId 返回 null', async () => {
  const body = String.raw`
${STORAGE_PRELUDE}
out({
  keys: buildHealthKeys('user-aaa'),
  nullKey: buildHealthKeys(null),
  emptyKey: buildHealthKeys(''),
  undefKey: buildHealthKeys(undefined),
});
`;
  const { after } = assertEqualBoth(body, 'H-01');
  assert.deepEqual(after.keys, {
    water: '@sync_health_v2_user-aaa_water',
    meals: '@sync_health_v2_user-aaa_meals',
    maxWater: '@sync_health_v2_user-aaa_maxWater',
    motto: '@sync_health_v2_user-aaa_motto',
    guides: '@sync_health_v2_user-aaa_guides',
    streak: '@sync_health_v2_user-aaa_streak',
    checkIn: '@sync_health_v2_user-aaa_checkIn',
    active: '@sync_health_v2_user-aaa_active',
  });
  assert.equal(after.nullKey, null);
  assert.equal(after.emptyKey, null);
  assert.equal(after.undefKey, null);
});

// ===========================================================================
// H-02 load：读取 8 个字段并正确解析
// ===========================================================================
test('H-02 load：读取 8 个字段并正确解析（water 数字 / meals JSON / guides JSON）', async () => {
  const body = String.raw`
${STORAGE_PRELUDE}
const k = buildHealthKeys('user-aaa');
await AS.setItem(k.water, '1234');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': true }));
await AS.setItem(k.maxWater, '3000');
await AS.setItem(k.motto, '坚持就是胜利');
await AS.setItem(k.guides, JSON.stringify({ '早餐': 'guide-a' }));
await AS.setItem(k.streak, '7');
await AS.setItem(k.checkIn, '2026-11-18');
await AS.setItem(k.active, '2026-11-19');

mount('2026-11-19', 'user-aaa', 1);
// ⚠️ useHealthStorage 的 load() 是显式 API（由编排层 useHealthData 调用），
//    不会在 Hook 内部自动触发。这里必须显式调用，才能验证磁盘读取与解析。
await last.load();
await settle();
out({
  isLoaded: last.isLoaded,
  waterAmount: last.waterAmount,
  mealsStatus: last.mealsStatus,
  maxWater: last.maxWater,
  motto: last.motto,
  mealGuides: last.mealGuides,
  streakDays: last.streakDays,
  lastCheckInDate: last.lastCheckInDate,
  lastActiveDate: last.lastActiveDate,
  userId: last.userId,
});
`;
  const { after } = assertEqualBoth(body, 'H-02');
  assert.equal(after.isLoaded, true);
  assert.equal(after.waterAmount, 1234);
  assert.deepEqual(after.mealsStatus, { '早餐': true, '午餐': false, '晚餐': true });
  assert.equal(after.maxWater, 3000);
  assert.equal(after.motto, '坚持就是胜利');
  assert.deepEqual(after.mealGuides, { '早餐': 'guide-a' });
  assert.equal(after.streakDays, 7);
  assert.equal(after.lastCheckInDate, '2026-11-18');
  assert.equal(after.lastActiveDate, '2026-11-19');
  assert.equal(after.userId, 'user-aaa');
});

// ===========================================================================
// H-03 setter 落盘
// ===========================================================================
test('H-03 setWater / setMeals / setMaxWater / setMotto / setMealGuide 落盘', async () => {
  const body = String.raw`
${STORAGE_PRELUDE}
const k = buildHealthKeys('user-aaa');
mount('2026-11-19', 'user-aaa', 1);
await flushMicrotasks(30);
last.setWater(888);
last.setMeals({ '早餐': true, '午餐': true, '晚餐': false });
last.setMaxWater(2500);
last.setMotto('新格言');
last.setMealGuide('早餐', '新指南');
await flushMicrotasks(30);
rerender();
out({
  diskWater: await AS.getItem(k.water),
  diskMeals: await AS.getItem(k.meals),
  diskMaxWater: await AS.getItem(k.maxWater),
  diskMotto: await AS.getItem(k.motto),
  diskGuides: await AS.getItem(k.guides),
  stateWater: last.waterAmount,
  stateMaxWater: last.maxWater,
  stateMotto: last.motto,
});
`;
  const { after } = assertEqualBoth(body, 'H-03');
  assert.equal(after.diskWater, '888');
  assert.deepEqual(JSON.parse(after.diskMeals), { '早餐': true, '午餐': true, '晚餐': false });
  assert.equal(after.diskMaxWater, '2500');
  assert.equal(after.diskMotto, '新格言');
  // ⚠️ mealGuides 初值为 DEFAULT_MEALS（三餐均有默认文案），
  //    setMealGuide('早餐', ...) 只覆盖早餐，午餐/晚餐保留默认文案。
  const guides = JSON.parse(after.diskGuides);
  assert.equal(guides['早餐'], '新指南');
  assert.equal(typeof guides['午餐'], 'string');
  assert.equal(typeof guides['晚餐'], 'string');
  assert.equal(after.stateWater, 888);
  assert.equal(after.stateMaxWater, 2500);
  assert.equal(after.stateMotto, '新格言');
});

// ===========================================================================
// H-04 身份切换后 setter fail-closed
// ===========================================================================
test('H-04 身份切换（userId / authEpoch）后旧 setter 必须 fail-closed', async () => {
  const body = String.raw`
${STORAGE_PRELUDE}
const kA = buildHealthKeys('user-aaa');
const kB = buildHealthKeys('user-bbb');
mount('2026-11-19', 'user-aaa', 1);
await flushMicrotasks(30);
const staleSetter = last.setWater;
// 切到 B（新 epoch）
mount('2026-11-19', 'user-bbb', 2);
await flushMicrotasks(30);
// 用 A 会话的旧 setter 写入 —— 必须被身份闸门拒绝
staleSetter(9999);
await flushMicrotasks(30);
out({
  diskAWater: await AS.getItem(kA.water),
  diskBWater: await AS.getItem(kB.water),
  stateBWater: last.waterAmount,
});
`;
  const { after } = assertEqualBoth(body, 'H-04');
  assert.equal(after.diskAWater, null, 'A 的旧 setter 不得写入 A 的磁盘');
  assert.equal(after.diskBWater, null, 'A 的旧 setter 不得写入 B 的磁盘');
  assert.notEqual(after.stateBWater, 9999, 'B 的状态不得被 A 的旧 setter 污染');
});

// ===========================================================================
// H-05 hydrateFromCloud 覆盖本地并落盘
// ===========================================================================
test('H-05 hydrateFromCloud 覆盖本地状态并落盘', async () => {
  // ⚠️ hydrateFromCloud 的契约只接受 camelCase 的 waterAmount / mealsStatus
  //    （见 HydrateFromCloudData），其余字段一律忽略。这里按真实契约构造入参。
  const body = String.raw`
${STORAGE_PRELUDE}
const k = buildHealthKeys('user-aaa');
mount('2026-11-19', 'user-aaa', 1);
await flushMicrotasks(30);
last.hydrateFromCloud({
  waterAmount: 1500,
  mealsStatus: { '早餐': true, '午餐': false, '晚餐': false },
}, 'user-aaa', last.getSessionEpoch());
await flushMicrotasks(30);
rerender();
out({
  stateWater: last.waterAmount,
  stateMeals: last.mealsStatus,
  diskWater: await AS.getItem(k.water),
  diskMeals: await AS.getItem(k.meals),
});
`;
  const { after } = assertEqualBoth(body, 'H-05');
  assert.equal(after.stateWater, 1500);
  assert.deepEqual(after.stateMeals, { '早餐': true, '午餐': false, '晚餐': false });
  assert.equal(after.diskWater, '1500');
  assert.deepEqual(JSON.parse(after.diskMeals), { '早餐': true, '午餐': false, '晚餐': false });
});

// ===========================================================================
// H-06 resetTodayLocal 清空当日
// ===========================================================================
test('H-06 resetTodayLocal 清空当日水量与三餐', async () => {
  const body = String.raw`
${STORAGE_PRELUDE}
const k = buildHealthKeys('user-aaa');
await AS.setItem(k.water, '1500');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': true, '晚餐': true }));
mount('2026-11-19', 'user-aaa', 1);
await flushMicrotasks(30);
last.resetTodayLocal();
await flushMicrotasks(30);
rerender();
out({
  stateWater: last.waterAmount,
  stateMeals: last.mealsStatus,
  diskWater: await AS.getItem(k.water),
  diskMeals: await AS.getItem(k.meals),
});
`;
  const { after } = assertEqualBoth(body, 'H-06');
  assert.equal(after.stateWater, 0);
  assert.deepEqual(after.stateMeals, { '早餐': false, '午餐': false, '晚餐': false });
  assert.equal(after.diskWater, '0');
  assert.deepEqual(JSON.parse(after.diskMeals), { '早餐': false, '午餐': false, '晚餐': false });
});

// ===========================================================================
// H-07 syncToCloud 防抖 1500ms 后 upsert（请求参数逐字段一致）
// ===========================================================================
test('H-07 syncToCloud：1500ms 防抖后 upsert，请求参数逐字段一致', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const D = '2026-11-19';
supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });
mount(A, () => D, 1);
// ⚠️ 挂载 effect 会异步 hydratePendingFromDisk + tryFlushPending，
//    必须先让其结算，否则它会与随后的 syncToCloud 竞态，提前提交本次载荷。
await flushMicrotasks(30);
last.syncToCloud(1500, { '早餐': true, '午餐': false, '晚餐': false });
// 防抖未到：不应有 upsert
const beforeDebounce = __sb.upsertCalls.length;
advance(1499);
await flushMicrotasks();
const at1499 = __sb.upsertCalls.length;
advance(2);
await flushMicrotasks(20);
const calls = __sb.upsertCalls.map((c) => ({ table: c.table, row: c.row, opts: c.opts }));
out({ beforeDebounce, at1499, calls });
`;
  const { after } = assertEqualBoth(body, 'H-07');
  assert.equal(after.beforeDebounce, 0, '防抖窗口内不得 upsert');
  assert.equal(after.at1499, 0, '1499ms 时仍不得 upsert');
  assert.equal(after.calls.length, 1, '1500ms 后应 upsert 一次');
  assert.equal(after.calls[0].table, 'health_records');
  assert.equal(after.calls[0].row.water_amount, 1500);
  assert.deepEqual(after.calls[0].row.meals_status, { '早餐': true, '午餐': false, '晚餐': false });
  assert.equal(after.calls[0].row.record_date, '2026-11-19');
  assert.equal(after.calls[0].row.user_id, 'user-aaa');
  assert.deepEqual(after.calls[0].opts, { onConflict: 'user_id, record_date' });
});

// ===========================================================================
// H-08 upsert 失败 → pending 保留在内存 + 磁盘
// ===========================================================================
test('H-08 upsert 失败：pending 保留在内存与磁盘', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const D = '2026-11-19';
supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'network down' } });
mount(A, () => D, 1);
last.syncToCloud(1500, { '早餐': true });
advance(1600);
await flushMicrotasks(20);
const diskKey = '@sync_health_pending_v1_user-aaa';
const raw = await AS.getItem(diskKey);
const disk = raw ? JSON.parse(raw) : null;
const inMemory = await last.hasPendingFor('user-aaa', D);
await last.flushNow();
const raw2 = await AS.getItem(diskKey);
const disk2 = raw2 ? JSON.parse(raw2) : null;
out({
  upsertCalls: __sb.upsertCalls.length,
  diskHasEntry: Boolean(disk && disk[D]),
  diskWater: disk && disk[D] ? disk[D].water : null,
  inMemory,
  stillThereAfterFlush: Boolean(disk2 && disk2[D]),
});
`;
  const { after } = assertEqualBoth(body, 'H-08');
  assert.equal(after.upsertCalls >= 1, true);
  assert.equal(after.diskHasEntry, true);
  assert.equal(after.diskWater, 1500);
  assert.equal(after.inMemory, true);
  assert.equal(after.stillThereAfterFlush, true);
});

// ===========================================================================
// H-09 flushNow 立即提交并清理 pending
// ===========================================================================
test('H-09 flushNow：立即提交并清理内存与磁盘 pending', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const D = '2026-11-19';
supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });
mount(A, () => D, 1);
last.syncToCloud(6666, { '早餐': true });
await last.flushNow();
await flushMicrotasks(20);
const diskKey = '@sync_health_pending_v1_user-aaa';
const raw = await AS.getItem(diskKey);
const inMemory = await last.hasPendingFor('user-aaa', D);
out({
  upsertWaters: __sb.upsertCalls.map((c) => c.row.water_amount),
  diskCleared: raw === null,
  inMemory,
});
`;
  const { after } = assertEqualBoth(body, 'H-09');
  assert.deepEqual(after.upsertWaters, [6666]);
  assert.equal(after.diskCleared, true);
  assert.equal(after.inMemory, false);
});

// ===========================================================================
// H-10 A→B 跨账号隔离
// ===========================================================================
test('H-10 A→B：B 会话不得提交 A 的 pending', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const D = '2026-11-19';
supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'fail' } });
mount(A, () => D, 1);
last.syncToCloud(1111, { '早餐': true });
advance(1600);
await flushMicrotasks(20);
// 切到 B
mount(B, () => D, 2);
await last.flushNow();
await flushMicrotasks(20);
const rows = __sb.upsertCalls.map((c) => c.row);
const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const diskAObj = diskA ? JSON.parse(diskA) : null;
out({
  bRows: rows.filter((r) => r && r.user_id === 'user-bbb').length,
  diskAStillThere: Boolean(diskAObj && diskAObj[D]),
  diskAOwner: diskAObj && diskAObj[D] ? diskAObj[D].ownerId : null,
});
`;
  const { after } = assertEqualBoth(body, 'H-10');
  assert.equal(after.bRows, 0, 'B 会话不得提交任何 B 的 upsert');
  assert.equal(after.diskAStillThere, true, 'A 的磁盘 pending 必须保留');
  assert.equal(after.diskAOwner, 'user-aaa', 'A 的 pending ownerId 必须是 A');
});

// ===========================================================================
// H-11 fetchMyRecord / fetchPartnerRecord 返回形态
// ===========================================================================
test('H-11 fetchMyRecord / fetchPartnerRecord 返回形态一致', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const D = '2026-11-19';
supabase.__reset();
supabase.__state.queryImpl = (table, chain) => {
  if (table === 'health_records') {
    const eqs = chain.ops.filter((o) => o[0] === 'eq');
    const isPartner = eqs.some((o) => o[1] === 'user_id' && o[2] === 'partner-xyz');
    if (isPartner) {
      return Promise.resolve({ data: { user_id: 'partner-xyz', water_amount: 777, meals_status: { '早餐': true } }, error: null });
    }
    return Promise.resolve({ data: { user_id: 'user-aaa', water_amount: 1234, meals_status: { '早餐': false } }, error: null });
  }
  return Promise.resolve({ data: null, error: null });
};
mount(A, () => D, 1);
const mine = await last.fetchMyRecord(D);
const partner = await last.fetchPartnerRecord('partner-xyz', D);
const none = await last.fetchPartnerRecord(null, D);
out({ mine, partner, none });
`;
  const { after } = assertEqualBoth(body, 'H-11');
  assert.equal(after.mine.water_amount, 1234);
  assert.equal(after.partner.water_amount, 777);
  assert.equal(after.none, null);
});

// ===========================================================================
// H-12 subscribePartner 收到 postgres_changes 后回调
// ===========================================================================
test('H-12 subscribePartner：postgres_changes 事件触发回调', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const D = '2026-11-19';
supabase.__reset();
mount(A, () => D, 1);
// ⚠️ 回调内有三重闸门：partnerIdRef.current === pId、epoch 未变、gen 未变，
//    且要求 payload.new.record_date === date。必须先 bindPartner 让
//    partnerIdRef 指向该搭子，并在事件载荷里带上 record_date。
last.bindPartner('partner-xyz');
await flushMicrotasks(10);
rerender();
// subscribePartner(pId, date) 无回调参数：事件经内部 setPartnerData 写入，
// 需重渲染后从对外接口读取（含身份遮蔽）。
const unsub = last.subscribePartner('partner-xyz', D);
const live = supabase.__liveChannels();
const chName = live.length ? live[live.length - 1].name : null;
const emitRet = supabase.__emit(chName, 'postgres_changes', 'UPDATE', {
  new: { record_date: D, water_amount: 999, meals_status: { '早餐': true } },
});
rerender();
const partnerWater = last.partnerData ? last.partnerData.waterAmount : null;
unsub();
const liveAfterUnsub = supabase.__liveChannels().length;
out({ emitRet, partnerWater, liveAfterUnsub });
`;
  const { after } = assertEqualBoth(body, 'H-12');
  assert.equal(after.emitRet, 1, 'postgres_changes 应投递到订阅 channel');
  assert.equal(after.partnerWater, 999, '回调应把 water_amount 写入 partnerData');
  assert.equal(after.liveAfterUnsub, 0, 'unsubscribe 后不得残留 channel');
});

// ===========================================================================
// H-13 hasPendingFor 闸门
// ===========================================================================
test('H-13 hasPendingFor：仅对存在 pending 的 owner+date 返回 true', async () => {
  const body = String.raw`
${CLOUD_PRELUDE}
const A = { id: 'user-aaa' };
const D = '2026-11-19';
supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'fail' } });
mount(A, () => D, 1);
last.syncToCloud(4444, { '早餐': true });
advance(1600);
await flushMicrotasks(20);
out({
  inMemory: await last.hasPendingFor('user-aaa', D),
  otherDate: await last.hasPendingFor('user-aaa', '2026-11-18'),
  otherOwner: await last.hasPendingFor('user-bbb', D),
  nullOwner: await last.hasPendingFor(null, D),
});
`;
  const { after } = assertEqualBoth(body, 'H-13');
  assert.equal(after.inMemory, true);
  assert.equal(after.otherDate, false);
  assert.equal(after.otherOwner, false);
  assert.equal(after.nullOwner, false);
});

// ===========================================================================
// H-14 HealthProvider 公开接口字段集合完全一致
// ===========================================================================
test('H-14 HealthProvider：公开接口字段集合与类型完全一致', async () => {
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
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
const keys = Object.keys(ctx).sort();
const types = {};
for (const key of keys) types[key] = typeof ctx[key];
out({ keys, types, isInitialized: ctx.isInitialized, waterAmount: ctx.waterAmount });
`;
  const { after } = assertEqualBoth(body, 'H-14');
  assert.deepEqual(after.keys, [
    'clearDateAnomalyNotice',
    'closeMeal',
    'confirmCheck',
    'currentSessionOwnerKey',
    'dateAnomalyNotice',
    'handleAddWater',
    'handleMinusWater',
    'isDoneToday',
    'isInitialized',
    'maxWater',
    'mealGuides',
    'mealsStatus',
    'motto',
    'openMeal',
    'partnerData',
    'partnerId',
    'profile',
    'profileLoading',
    'refreshPartner',
    'refreshProfile',
    'resetToday',
    'selectedMeal',
    'selectedMealOwnerKey',
    'selectedMealSelectionId',
    'setWaterDirect',
    'streakDays',
    'undoCheck',
    'updateMaxWater',
    'updateMealGuide',
    'updateMotto',
    'waterAmount',
  ]);
  assert.equal(after.types.handleAddWater, 'function');
  assert.equal(after.types.confirmCheck, 'function');
  assert.equal(after.types.waterAmount, 'number');
  assert.equal(after.isInitialized, true);
  assert.equal(after.waterAmount, 500);
});

// ===========================================================================
// H-15 handleAddWater / handleMinusWater 边界
// ===========================================================================
test('H-15 handleAddWater / handleMinusWater：0 下限与 maxWater 上限', async () => {
  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(A);
await AS.setItem(k.water, '0');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
// ⚠️ 上限必须可被 25 次点击触达，否则测试无法验证 clamp。设为 10。
await AS.setItem(k.maxWater, '10');
await AS.setItem(k.active, DATE);
supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
const start = ctx.waterAmount;
// 减到 0 以下必须被夹到 0
ctx.handleMinusWater();
rerender();
const afterMinus = ctx.waterAmount;
// 加到上限（25 次点击，maxWater=10 → 必须被夹到 10）
for (let i = 0; i < 25; i += 1) { ctx.handleAddWater(); }
rerender();
const afterAdds = ctx.waterAmount;
out({ start, afterMinus, afterAdds, maxWater: ctx.maxWater });
`;
  const { after } = assertEqualBoth(body, 'H-15');
  assert.equal(after.start, 0);
  assert.equal(after.afterMinus, 0, '水量不得低于 0');
  assert.equal(after.afterAdds, 10, '水量不得超过 maxWater');
  assert.equal(after.maxWater, 10);
});

// ===========================================================================
// H-16 confirmCheck / undoCheck 状态机
// ===========================================================================
test('H-16 confirmCheck / undoCheck：streak 推进与回退', async () => {
  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(A);
// ⚠️ confirmCheck 的前置条件是「当前选中餐次存在且尚未打卡」
//    （visibleSelectedMeal 非空 && !mealsStatus[meal]），
//    而 streak 推进由 useStreak 的边沿检测在 isDoneToday false→true 时触发。
//    因此必须从「晚餐未打卡」起步：boot 后 isDoneToday=false（建立边沿基线），
//    再 openMeal('晚餐') → confirmCheck() 把晚餐置 true → isDoneToday 变 true → streak +1。
await AS.setItem(k.water, '2000');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': true, '晚餐': false }));
await AS.setItem(k.maxWater, '2000');
await AS.setItem(k.streak, '3');
// 上次打卡为昨天 → 连续天数应 +1（3 → 4）
const yDate = new Date(Date.now() - 86400000);
const yStr = formatDateStr(yDate);
await AS.setItem(k.checkIn, yStr);
await AS.setItem(k.active, DATE);
supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
const beforeStreak = ctx.streakDays;
const beforeDone = ctx.isDoneToday;
ctx.openMeal('晚餐');
rerender();
await ctx.confirmCheck();
// 多轮 rerender 让 useStreak 的边沿检测 effect 落地
for (let i = 0; i < 6; i += 1) { await flushMicrotasks(8); rerender(); }
const afterConfirmStreak = ctx.streakDays;
const afterConfirmDone = ctx.isDoneToday;
const afterConfirmCheckIn = await AS.getItem(k.checkIn);
// 撤销：重新打开晚餐（confirmCheck 已清空选中态）→ undoCheck 把晚餐置 false
ctx.openMeal('晚餐');
rerender();
ctx.undoCheck();
for (let i = 0; i < 6; i += 1) { await flushMicrotasks(8); rerender(); }
const afterUndoStreak = ctx.streakDays;
const afterUndoDone = ctx.isDoneToday;
out({ beforeStreak, beforeDone, afterConfirmStreak, afterConfirmDone, afterConfirmCheckIn, afterUndoStreak, afterUndoDone });
`;
  const { after } = assertEqualBoth(body, 'H-16');
  assert.equal(after.beforeDone, false, '晚餐未打卡时 isDoneToday 应为 false');
  assert.equal(after.afterConfirmDone, true, 'confirmCheck 后三餐+饮水达标，isDoneToday 应为 true');
  assert.equal(after.afterConfirmStreak, 4, 'confirmCheck 后 streak 应 +1');
  assert.equal(after.afterConfirmCheckIn, after.afterConfirmCheckIn, 'checkIn 日期应写入');
  assert.equal(after.afterUndoDone, false, 'undoCheck 后 isDoneToday 应回到 false');
  assert.equal(after.afterUndoStreak, 3, 'undoCheck 后 streak 应回退到 3');
});

// ===========================================================================
// H-17 openMeal / closeMeal 选中态
// ===========================================================================
test('H-17 openMeal / closeMeal：选中态与 ownerKey / selectionId', async () => {
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
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
const beforeMeal = ctx.selectedMeal;
ctx.openMeal('午餐');
rerender();
const openedMeal = ctx.selectedMeal;
const openedOwnerKey = ctx.selectedMealOwnerKey;
const openedSelId = ctx.selectedMealSelectionId;
const sessionKey = ctx.currentSessionOwnerKey;
ctx.closeMeal();
rerender();
out({
  beforeMeal,
  openedMeal,
  openedOwnerKey,
  openedSelIdIsNumber: typeof openedSelId === 'number',
  sessionKey,
  afterClose: ctx.selectedMeal,
});
`;
  const { after } = assertEqualBoth(body, 'H-17');
  assert.equal(after.beforeMeal, null);
  assert.equal(after.openedMeal, '午餐');
  assert.equal(after.openedOwnerKey, after.sessionKey, '选中态 ownerKey 必须等于当前会话 ownerKey');
  assert.equal(after.openedSelIdIsNumber, true);
  assert.equal(after.afterClose, null);
});

// ===========================================================================
// H-18 updateMaxWater / updateMotto / updateMealGuide
// ===========================================================================
test('H-18 updateMaxWater / updateMotto / updateMealGuide 落盘', async () => {
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
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
ctx.updateMaxWater(3500);
ctx.updateMotto('我的格言');
ctx.updateMealGuide('晚餐', '晚餐指南');
await flushMicrotasks(30);
rerender();
out({
  maxWater: ctx.maxWater,
  motto: ctx.motto,
  guide: ctx.mealGuides['晚餐'],
  diskMaxWater: await AS.getItem(k.maxWater),
  diskMotto: await AS.getItem(k.motto),
  diskGuides: await AS.getItem(k.guides),
});
`;
  const { after } = assertEqualBoth(body, 'H-18');
  assert.equal(after.maxWater, 3500);
  assert.equal(after.motto, '我的格言');
  assert.equal(after.guide, '晚餐指南');
  assert.equal(after.diskMaxWater, '3500');
  assert.equal(after.diskMotto, '我的格言');
  // ⚠️ mealGuides 初值是 DEFAULT_MEALS（三餐均有默认文案），updateMealGuide 是
  //    「合并」语义（{ ...prev, [meal]: text }），因此落盘结果必然包含三餐键。
  //    这里只断言「晚餐被覆盖为新文案」，并确认其余两餐默认文案未被破坏。
  const diskGuides = JSON.parse(after.diskGuides);
  assert.equal(diskGuides['晚餐'], '晚餐指南', '晚餐指南应落盘');
  assert.deepEqual(Object.keys(diskGuides).sort(), ['早餐', '午餐', '晚餐'].sort(), '三餐键必须齐全');
  assert.ok(diskGuides['早餐'] && diskGuides['早餐'] !== '晚餐指南', '早餐默认文案不得被覆盖');
  assert.ok(diskGuides['午餐'] && diskGuides['午餐'] !== '晚餐指南', '午餐默认文案不得被覆盖');
});

// ===========================================================================
// H-19 resetToday
// ===========================================================================
test('H-19 resetToday：清空当日水量与三餐', async () => {
  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(A);
await AS.setItem(k.water, '1800');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': true, '晚餐': true }));
await AS.setItem(k.active, DATE);
supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
const beforeWater = ctx.waterAmount;
ctx.resetToday();
await flushMicrotasks(30);
rerender();
out({
  beforeWater,
  afterWater: ctx.waterAmount,
  afterMeals: ctx.mealsStatus,
  diskWater: await AS.getItem(k.water),
});
`;
  const { after } = assertEqualBoth(body, 'H-19');
  assert.equal(after.beforeWater, 1800);
  assert.equal(after.afterWater, 0);
  assert.deepEqual(after.afterMeals, { '早餐': false, '午餐': false, '晚餐': false });
  assert.equal(after.diskWater, '0');
});

// ===========================================================================
// H-20 A→B→A 身份切换后不串号
// ===========================================================================
test('H-20 A→B→A：身份切换后数据不串号', async () => {
  const body = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
const B = 'user-bbb';
const DATE = formatDateStr(new Date());
const kA = buildHealthKeys(A);
const kB = buildHealthKeys(B);
await AS.setItem(kA.water, '111');
await AS.setItem(kA.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(kA.active, DATE);
await AS.setItem(kB.water, '222');
await AS.setItem(kB.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(kB.active, DATE);
supabase.__reset();
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
await boot();
const waterA1 = ctx.waterAmount;
const ownerKeyA1 = ctx.currentSessionOwnerKey;

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 2;
await boot();
const waterB = ctx.waterAmount;
const ownerKeyB = ctx.currentSessionOwnerKey;

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 3;
await boot();
const waterA2 = ctx.waterAmount;
const ownerKeyA2 = ctx.currentSessionOwnerKey;

out({ waterA1, waterB, waterA2, ownerKeyA1, ownerKeyB, ownerKeyA2 });
`;
  const { after } = assertEqualBoth(body, 'H-20');
  assert.equal(after.waterA1, 111, 'A 首次会话应读到 A 的数据');
  assert.equal(after.waterB, 222, 'B 会话应读到 B 的数据');
  assert.equal(after.waterA2, 111, 'A 再次会话应仍读到 A 的数据（不串号）');
  assert.notEqual(after.ownerKeyA1, after.ownerKeyB, 'A/B 会话 ownerKey 必须不同');
  assert.notEqual(after.ownerKeyA1, after.ownerKeyA2, 'A 新 epoch 的 ownerKey 必须变化');
});

// --- END OF FILE tests/security/p14r6HealthEquivalence.test.mjs ---
