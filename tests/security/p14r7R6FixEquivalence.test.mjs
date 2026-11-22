// --- START OF FILE tests/security/p14r7R6FixEquivalence.test.mjs ---
/**
 * P1.4 R7 — Work A：R6 Gatekeeper 三项发现的**新旧真实执行等价**验证
 *
 * 背景
 *   R6 交付后，Gatekeeper 指出三处「迁移时无意改变了运行时语义」：
 *     A1  useHealthData()：旧 JS 直接 `return useContext(HealthContext)`，
 *         Provider 之外返回 undefined 而**不抛错**；R6 版新增了 `if (!ctx) throw`。
 *     A2  useChatMessages.revokeMessage：旧 JS 未登录时 `return;`（undefined）；
 *         R6 版改成了 `return { ok: false }`。
 *     A3  useChatList.getDisplayName：旧 JS 返回 `rel?.remark || item.nickname || item.username`
 *         （可能为 null / undefined / ''）；R6 版追加了 `|| undefined`。
 *
 * 本文件做什么
 *   · 对上述三处，用「冻结 JS 基线 vs 当前 TS 源码」的真实执行对比，逐条断言等价。
 *   · 每条断言都配一个**故障注入**用例：在隔离副本里把实现改回 R6 的错误写法，
 *     证明本文件的断言确实能检出差异（不是无条件通过）。
 *
 * 机制
 *   · 与 R6 Health / Chat 等价测试同构：自定义 Hook 运行时 + ts.transpileModule + 子进程沙箱。
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
  'hooks__chat__useChatMessages.js':
    '9878b7b34744d964319d28efe73c1c454fa7828ba38017f7d7395a0a8ef788b0',
  'hooks__chat__useChatList.js':
    'f30a3336e3a783e51116407dee8f52d5147fe9291100cac9388851d064211a3d',
};

test('P14R7-A0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
//   mode = 'before'   → 冻结基线（迁移前 JS）
//   mode = 'after'    → 当前真实源码（迁移后 TS/TSX）
//   mode = 'injected' → 当前源码的隔离副本，按 inject 回调改回 R6 的错误写法
// ---------------------------------------------------------------------------
function buildSandbox(mode, inject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r7-fix-${mode}-`));
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
  const origRender = rt.render;
  rt.render = (fn) => { const prev = __active; __active = rt; try { return origRender(fn); } finally { __active = prev; } };
  return rt;
}
export const useState = (init) => { if (!__active) throw new Error('useState outside render'); return __active.useState(init); };
export const useEffect = (fn, deps) => { if (!__active) throw new Error('useEffect outside render'); return __active.useEffect(fn, deps); };
export const useCallback = (fn, deps) => { if (!__active) throw new Error('useCallback outside render'); return __active.useCallback(fn, deps); };
export const useMemo = (fn, deps) => { if (!__active) throw new Error('useMemo outside render'); return __active.useMemo(fn, deps); };
export const useRef = (v) => { if (!__active) throw new Error('useRef outside render'); return __active.useRef(v); };
export const createContext = (v) => ({ __ctx: v, __isCtx: true });
export const useContext = (ctx) => (ctx && ctx.__isCtx ? ctx.__ctx : undefined);
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
  addEventListener(type, cb) { if (type === 'change') listeners.add(cb); return { remove() { listeners.delete(cb); } }; },
  __emit(next) { AppState.currentState = next; for (const cb of Array.from(listeners)) cb(next); },
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

  mk('expo-router', {
    'package.json': JSON.stringify({ name: 'expo-router', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
import { useEffect } from 'react';
export function useFocusEffect(cb) {
  useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; }, [cb]);
}
export const router = { push() {}, replace() {}, back() {} };
export function Link() { return null; }
export function useLocalSearchParams() { return {}; }
export default { useFocusEffect, router, Link, useLocalSearchParams };
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
    // 冻结基线 useHealthData.js 含原始 JSX（.js 扩展名，ts.transpileModule 不转换）。
    // 做最小等价改写为 React.createElement，并补 import * as React。
    if (srcPath.endsWith('hooks__useHealthData.js')) {
      src = src.replace(
        /return <HealthContext\.Provider value=\{value\}>\{children\}<\/HealthContext\.Provider>;/,
        'return React.createElement(HealthContext.Provider, { value }, children);'
      );
      src = "import * as React from 'react';\n" + src;
    }
    // TS 源码 useHealthData.tsx 的 JSX 由 transpile 转成 React.createElement，
    // 但源码未 import React，沙箱执行会抛 "React is not defined"。
    if (srcPath.endsWith('useHealthData.tsx')) {
      src = "import * as React from 'react';\n" + src;
    }
    // 故障注入：仅在隔离副本上改写源码文本，冻结基线与真实源码均不受影响。
    if (mode === 'injected' && typeof inject === 'function') {
      const next = inject(srcPath, src);
      if (typeof next === 'string') src = next;
    }
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, transpile(src, path.basename(srcPath)));
  };

  // [beforeName, afterRel, dstRel]
  const MODULES = [
    ['hooks__useHealthData.js', 'src/hooks/useHealthData.tsx', 'src/hooks/useHealthData.js'],
    ['hooks__health__useHealthCloud.js', 'src/hooks/health/useHealthCloud.ts', 'src/hooks/health/useHealthCloud.js'],
    ['hooks__health__useHealthStorage.js', 'src/hooks/health/useHealthStorage.ts', 'src/hooks/health/useHealthStorage.js'],
    ['hooks__chat__useChatMessages.js', 'src/hooks/chat/useChatMessages.ts', 'src/hooks/chat/useChatMessages.js'],
    ['hooks__chat__useChatList.js', 'src/hooks/chat/useChatList.ts', 'src/hooks/chat/useChatList.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') place(path.join(beforeDir, beforeName), dstRel);
    else place(path.join(repoRoot, afterRel), dstRel);
  }

  // 依赖：useOwnerKey（真实源码，新旧一致，只读）
  place(path.join(repoRoot, 'src/hooks/useOwnerKey.js'), 'src/hooks/useOwnerKey.js');

  // R5 已迁移的 Health 共享依赖（新旧一致）
  const SHARED = [
    ['src/hooks/health/useTimeSync.ts', 'src/hooks/health/useTimeSync.js'],
    ['src/hooks/health/useStreak.ts', 'src/hooks/health/useStreak.js'],
    ['src/hooks/health/constants.ts', 'src/hooks/health/constants.js'],
    ['src/hooks/health/dateUtils.ts', 'src/hooks/health/dateUtils.js'],
    ['src/hooks/health/authRevokeLogic.ts', 'src/hooks/health/authRevokeLogic.js'],
    ['src/hooks/profile/useProfileCache.ts', 'src/hooks/profile/useProfileCache.js'],
  ];
  for (const [srcRel, dstRel] of SHARED) place(path.join(repoRoot, srcRel), dstRel);

  // useAuth stub：由 __UID__ / __EPOCH__ 驱动
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

  // useSignedMediaUrl stub
  fs.writeFileSync(path.join(dir, 'src/hooks/chat/useSignedMediaUrl.js'), `
export const __signLog = [];
export async function getSignedUrl(p, ttl) {
  __signLog.push([p, ttl]);
  return 'https://signed.example/' + p;
}
export function setSignedUrlOwner() { return 0; }
export function clearSignedUrlCache() {}
export const getMemoryCachedSignedUrl = () => null;
export function useSignedMediaUrl() { return { url: null, loading: false, error: null }; }
export default { getSignedUrl, setSignedUrlOwner, clearSignedUrlCache, getMemoryCachedSignedUrl, useSignedMediaUrl };
`);

  // mediaCache stub
  fs.writeFileSync(path.join(dir, 'src/services/mediaCache.js'), `
export const __downloadLog = [];
export async function downloadToSandbox(url, id, kind) {
  __downloadLog.push([url, id, kind]);
  return 'file:///cache/' + id;
}
export async function persistMedia() { return null; }
export async function resolveLocalMedia() { return null; }
export function getMemoryLocalMedia() { return null; }
export async function getMediaCacheSize() { return { bytes: 0, count: 0 }; }
export async function clearMediaCache() { return { ok: true }; }
export function setMediaCacheOwner() { return 0; }
export function normalizeFileUri(p) { return p; }
`);

  // supabase stub：同时满足 Health（rpc/upsert）与 Chat（channel/update/delete）需求
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  channels: [],
  rpcImpl: null,
  queryImpl: null,
  upsertImpl: null,
  updateImpl: null,
  deleteImpl: null,
  upsertCalls: [],
  queryCalls: [],
  updateCalls: [],
  deleteCalls: [],
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

function makeQuery(table) {
  const chain = { table, ops: [] };
  const api = {
    select(cols) { chain.ops.push(['select', cols]); return api; },
    or(expr) { chain.ops.push(['or', expr]); return api; },
    not(col, op, val) { chain.ops.push(['not', col, op, val]); return api; },
    eq(col, val) { chain.ops.push(['eq', col, val]); return api; },
    in(col, val) { chain.ops.push(['in', col, val]); return api; },
    order(col, opts) { chain.ops.push(['order', col, opts]); return api; },
    limit(n) { chain.ops.push(['limit', n]); return api; },
    single() {
      state.queryCalls.push({ table, ops: chain.ops.slice(), single: true });
      if (state.queryImpl) return state.queryImpl(table, chain);
      return Promise.resolve({ data: null, error: null });
    },
    upsert(row, opts) {
      state.upsertCalls.push({ table, row, opts });
      if (state.upsertImpl) return state.upsertImpl(table, row, opts);
      return Promise.resolve({ data: null, error: null });
    },
    update(patch) {
      const uchain = { table, patch, ops: [] };
      const uapi = {
        eq(col, val) { uchain.ops.push(['eq', col, val]); return uapi; },
        then(res, rej) {
          state.updateCalls.push({ table, patch: uchain.patch, ops: uchain.ops.slice() });
          const p = state.updateImpl ? state.updateImpl(table, uchain) : Promise.resolve({ data: null, error: null });
          return p.then(res, rej);
        },
      };
      return uapi;
    },
    delete() {
      const dchain = { table, ops: [] };
      const dapi = {
        eq(col, val) { dchain.ops.push(['eq', col, val]); return dapi; },
        then(res, rej) {
          state.deleteCalls.push({ table, ops: dchain.ops.slice() });
          const p = state.deleteImpl ? state.deleteImpl(table, dchain) : Promise.resolve({ data: null, error: null });
          return p.then(res, rej);
        },
      };
      return dapi;
    },
    then(res, rej) {
      state.queryCalls.push({ table, ops: chain.ops.slice(), single: false });
      const p = state.queryImpl ? state.queryImpl(table, chain) : Promise.resolve({ data: null, error: null });
      return p.then(res, rej);
    },
  };
  return api;
}

export const supabase = {
  __state: state,
  __reset() {
    state.channels.length = 0;
    state.rpcImpl = null; state.queryImpl = null; state.upsertImpl = null;
    state.updateImpl = null; state.deleteImpl = null;
    state.upsertCalls.length = 0; state.queryCalls.length = 0;
    state.updateCalls.length = 0; state.deleteCalls.length = 0;
  },
  __emit(channelName, type, event, payload) {
    const ch = state.channels.find((c) => c.name === channelName && !c.removed);
    if (!ch) return 0;
    ch.api.__emit(type, event, payload);
    return 1;
  },
  __liveChannels() { return state.channels.filter((c) => !c.removed); },
  __channelNames() { return state.channels.filter((c) => !c.removed).map((c) => c.name); },
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
  from(table) { return makeQuery(table); },
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
  assert.deepEqual(after, before, `R7 修复后必须与旧 JS 等价：${label}`);
  return { before, after };
}

// ===========================================================================
// 公共 PRELUDE
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
globalThis.__DEV__ = false;
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
function setIdentity(uid, epoch) { globalThis.__UID__ = uid; globalThis.__EPOCH__ = epoch; }
`;

const MESSAGES_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const M = await import('./src/hooks/chat/useChatMessages');
const { useChatMessages, formatDbMsg } = M;
const rt = createHookRuntime();
let last = null;
function mount(targetId, user) { last = rt.render(() => useChatMessages(targetId, user)); return last; }
function rerender() { last = rt.rerender(); return last; }
async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    last = rt.rerender();
  }
  return last;
}
`;

const LIST_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const L = await import('./src/hooks/chat/useChatList');
const { useChatList, formatPreview } = L;
const rt = createHookRuntime();
let last = null;
function mount(user) { last = rt.render(() => useChatList(user)); return last; }
function rerender() { last = rt.rerender(); return last; }
async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    last = rt.rerender();
  }
  return last;
}
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
// A1 — useHealthData() 在 Provider 之外返回 undefined，且不抛错
// ===========================================================================
const A1_BODY = String.raw`
${COMMON_PRELUDE}
const { useHealthData } = await import('./src/hooks/useHealthData');
const rt = createHookRuntime();
let threw = null;
let value = 'NOT_CALLED';
try {
  value = rt.render(() => useHealthData());
} catch (e) {
  threw = String((e && e.message) || e);
}
out({
  threw,
  valueType: value === undefined ? 'undefined' : typeof value,
  isUndefined: value === undefined,
});
`;

test('A1 useHealthData()：Provider 之外返回 undefined 且不抛错（与旧 JS 一致）', async () => {
  const { after } = assertEqualBoth(A1_BODY, 'A1');
  assert.equal(after.threw, null, 'Provider 之外调用 useHealthData() 不得抛错');
  assert.equal(after.isUndefined, true, 'Provider 之外调用 useHealthData() 必须返回 undefined');
  assert.equal(after.valueType, 'undefined');
});

test('A1 故障注入：改回 R6 的 throw 写法后，等价断言必须失败', async () => {
  // 在隔离副本里把 useHealthData() 改回 R6 的「无 ctx 就 throw」写法。
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useHealthData.tsx')) return src;
    const marker = 'export function useHealthData(): HealthContextValue | undefined {';
    const idx = src.indexOf(marker);
    if (idx < 0) throw new Error('注入失败：未找到 useHealthData 导出');
    const end = src.indexOf('\n}', idx);
    if (end < 0) throw new Error('注入失败：未找到 useHealthData 函数体结尾');
    const injected =
      'export function useHealthData(): HealthContextValue | undefined {\n' +
      '  const ctx = useContext(HealthContext);\n' +
      '  if (!ctx) { throw new Error("useHealthData must be used within HealthProvider"); }\n' +
      '  return ctx;\n' +
      '}';
    return src.slice(0, idx) + injected + src.slice(end + 2);
  };
  const injected = runInSandbox(buildSandbox('injected', inject), A1_BODY);
  assert.notEqual(injected.threw, null, '注入 throw 写法后必须抛错（证明注入生效）');
  assert.match(injected.threw, /HealthProvider/, '抛错信息应来自注入的 throw');
  // 与冻结基线对比：注入版必须与旧 JS 不等价
  const before = runInSandbox(buildSandbox('before'), A1_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// A2 — revokeMessage 未登录时返回 undefined（不返回 { ok: false }）
// ===========================================================================
const A2_BODY = String.raw`
${MESSAGES_PRELUDE}
setIdentity(null, 0);
const user = null;
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount('peer-x', user);
await settle();
const ret = await last.revokeMessage('m1');
out({
  retIsUndefined: ret === undefined,
  retType: ret === undefined ? 'undefined' : typeof ret,
  retJson: ret === undefined ? null : ret,
  updateCalls: __sb.updateCalls.length,
  deleteCalls: __sb.deleteCalls.length,
});
`;

test('A2 revokeMessage：未登录时返回 undefined，且不发起任何写请求', async () => {
  const { after } = assertEqualBoth(A2_BODY, 'A2');
  assert.equal(after.retIsUndefined, true, '未登录 revokeMessage 必须返回 undefined');
  assert.equal(after.retType, 'undefined');
  assert.equal(after.retJson, null);
  assert.equal(after.updateCalls, 0, '未登录不得发起 update');
  assert.equal(after.deleteCalls, 0, '未登录不得发起 delete');
});

test('A2 故障注入：改回 R6 的 { ok: false } 写法后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useChatMessages.ts')) return src;
    const marker = 'if (!user?.id) return;';
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到未登录早退分支');
    return src.replace(marker, 'if (!user?.id) return { ok: false };');
  };
  const injected = runInSandbox(buildSandbox('injected', inject), A2_BODY);
  assert.equal(injected.retIsUndefined, false, '注入后返回值不再是 undefined（证明注入生效）');
  assert.deepEqual(injected.retJson, { ok: false }, '注入后应返回 { ok: false }');
  const before = runInSandbox(buildSandbox('before'), A2_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// A3 — getDisplayName 返回原表达式（可能为 null / '' / undefined）
// ===========================================================================
const A3_BODY = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'f1', user_id: 'user-a', friend_id: 'peer-remark', remark: 'Alice', created_at: '2026-11-20T10:00:00.000Z' },
      { id: 'f2', user_id: 'user-a', friend_id: 'peer-nick', remark: null, created_at: '2026-11-20T09:00:00.000Z' },
      { id: 'f3', user_id: 'user-a', friend_id: 'peer-user', remark: '', created_at: '2026-11-20T08:00:00.000Z' },
      { id: 'f4', user_id: 'user-a', friend_id: 'peer-empty', remark: '', created_at: '2026-11-20T07:00:00.000Z' },
    ], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [
      { id: 'peer-remark', username: 'u-remark', nickname: 'NickRemark', sync_id: 'S1' },
      { id: 'peer-nick', username: 'u-nick', nickname: 'NickOnly', sync_id: 'S2' },
      { id: 'peer-user', username: 'UserOnly', nickname: null, sync_id: 'S3' },
      { id: 'peer-empty', username: '', nickname: null, sync_id: 'S4' },
    ];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
mount(user);
await settle();
const byId = (id) => last.friends.find((f) => f.id === id);
const r1 = last.getDisplayName(byId('peer-remark'));
const r2 = last.getDisplayName(byId('peer-nick'));
const r3 = last.getDisplayName(byId('peer-user'));
const r4 = last.getDisplayName(byId('peer-empty'));
const rNull = last.getDisplayName(null);
out({
  r1, r2, r3,
  r4IsEmptyString: r4 === '',
  r4Type: typeof r4,
  rNull,
});
`;

test('A3 getDisplayName：备注 → nickname → username 原表达式（空串保持空串）', async () => {
  const { after } = assertEqualBoth(A3_BODY, 'A3');
  assert.equal(after.r1, 'Alice', '有备注时取备注');
  assert.equal(after.r2, 'NickOnly', '无备注时取 nickname');
  assert.equal(after.r3, 'UserOnly', '无备注无 nickname 时取 username');
  assert.equal(after.r4IsEmptyString, true, 'username 为空串时必须原样返回空串（不得转成 undefined）');
  assert.equal(after.r4Type, 'string');
  assert.equal(after.rNull, '未知', 'null 入参返回「未知」');
});

test('A3 故障注入：改回 R6 的 `|| undefined` 写法后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useChatList.ts')) return src;
    const marker = 'return rel?.remark || item.nickname || item.username;';
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到 getDisplayName 返回表达式');
    return src.replace(marker, 'return rel?.remark || item.nickname || item.username || undefined;');
  };
  const injected = runInSandbox(buildSandbox('injected', inject), A3_BODY);
  assert.equal(injected.r4IsEmptyString, false, '注入后空串被转成 undefined（证明注入生效）');
  assert.equal(injected.r4Type, 'undefined');
  const before = runInSandbox(buildSandbox('before'), A3_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// A4 — HealthData 额外语义：云端 null 原样透传 / normalizeProfile 无条件写入
// ===========================================================================
const A4_BODY = String.raw`
${DATA_PRELUDE}
const A = 'user-aaa';
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(A);
await AS.setItem(k.water, '0');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);
supabase.__reset();
// 云端返回 water_amount = null / meals_status = null（真实 DB 可空列）
supabase.__state.queryImpl = (table) => {
  if (table === 'health_records') {
    return Promise.resolve({ data: { water_amount: null, meals_status: null, record_date: DATE }, error: null });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
await boot();
out({
  water: ctx.waterAmount,
  meals: ctx.mealsStatus,
  waterType: typeof ctx.waterAmount,
  mealsIsObject: !!ctx.mealsStatus && typeof ctx.mealsStatus === 'object',
});
`;

test('A4 HealthData：云端 null 字段原样透传，hydrate 结果与旧 JS 一致', async () => {
  const { after } = assertEqualBoth(A4_BODY, 'A4');
  assert.equal(after.waterType, 'number', 'waterAmount 必须始终为数字');
  assert.equal(after.mealsIsObject, true, 'mealsStatus 必须始终为对象');
});

// ===========================================================================
// A5 — R5 已通过修复未被回滚（源码级断言，不依赖沙箱）
// ===========================================================================
test('A5 R5 已通过修复仍在位（URL 归一 / errMessage / stale inflight / 身份代际）', () => {
  const media = fs.readFileSync(path.join(repoRoot, 'src/hooks/chat/useSignedMediaUrl.ts'), 'utf8');
  assert.match(media, /\/\^https\?:\\\/\\\/\/i/, 'toStoragePath / isAbsoluteUrl 必须保留 HTTP(S) 前缀判定');
  assert.match(media, /\.filter\(Boolean\)/, 'buildPublicStorageUrl 必须保留 .filter(Boolean)');
  assert.match(media, /holder\.task/, 'stale inflight 必须保留 holder.task 守卫');
  assert.match(media, /isIdentityStillValid/, '必须保留身份代际校验');
  assert.match(media, /renderEpoch/, '必须保留 renderEpoch 依赖');

  const friend = fs.readFileSync(path.join(repoRoot, 'src/hooks/chat/useFriendActions.ts'), 'utf8');
  assert.match(friend, /return msg \|\| fallback;/, 'errMessage 必须保留 e?.message || fallback 语义');
});

// --- END OF FILE tests/security/p14r7R6FixEquivalence.test.mjs ---
