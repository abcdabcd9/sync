// --- START OF FILE tests/security/p14r6ChatEquivalence.test.mjs ---
/**
 * P1.4 R6 — Work C：Chat 大型模块 JS→TS 迁移的**新旧真实执行等价**验证
 *
 * 目标
 *   对以下两个模块做「冻结 JS 基线 vs 当前 TS 源码」的真实执行对比：
 *     · src/hooks/chat/useChatMessages.ts （单会话消息流：缓存 / 拉取 / 实时 / 撤回 / 删除）
 *     · src/hooks/chat/useChatList.ts     （会话列表：好友 / 请求 / 未读 / 预览 / 实时）
 *
 * 机制
 *   · 与 R6 Health / R5 等价测试同构：自定义 Hook 运行时 + ts.transpileModule + 子进程沙箱。
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
  'hooks__chat__useChatMessages.js':
    '9878b7b34744d964319d28efe73c1c454fa7828ba38017f7d7395a0a8ef788b0',
  'hooks__chat__useChatList.js':
    'f30a3336e3a783e51116407dee8f52d5147fe9291100cac9388851d064211a3d',
};

test('P14R6-C0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 R6 Health / R5 测试同构，独立复制以保持自包含）
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
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r6-chat-${mode}-`));
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

  // expo-router stub：useFocusEffect 在每次渲染视为聚焦一次
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
    const src = fs.readFileSync(srcPath, 'utf8');
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, transpile(src, path.basename(srcPath)));
  };

  const MODULES = [
    ['hooks__chat__useChatMessages.js', 'src/hooks/chat/useChatMessages.ts', 'src/hooks/chat/useChatMessages.js'],
    ['hooks__chat__useChatList.js', 'src/hooks/chat/useChatList.ts', 'src/hooks/chat/useChatList.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') place(path.join(beforeDir, beforeName), dstRel);
    else place(path.join(repoRoot, afterRel), dstRel);
  }

  // 依赖：useOwnerKey（真实源码，新旧一致）
  place(path.join(repoRoot, 'src/hooks/useOwnerKey.js'), 'src/hooks/useOwnerKey.js');

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
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
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

  // supabase stub
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  channels: [],
  queryImpl: null,
  updateImpl: null,
  deleteImpl: null,
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
    state.queryImpl = null; state.updateImpl = null; state.deleteImpl = null;
    state.queryCalls.length = 0; state.updateCalls.length = 0; state.deleteCalls.length = 0;
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
  rpc() { return Promise.resolve({ data: null, error: null }); },
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

// 构造一条 messages 表行
const ROW = (over) => Object.assign({
  id: 'm1',
  created_at: '2026-11-20T10:00:00.000Z',
  user_id: 'user-a',
  text: 'hello',
  media_url: null,
  thumbnail_url: null,
  type: 'text',
  duration: null,
  receiver_id: 'peer-x',
  is_read: false,
  group_id: null,
  subtype: null,
  deleted_by: [],
}, over || {});

// ===========================================================================
// C-01 formatDbMsg
// ===========================================================================
test('C-01 formatDbMsg：字段映射 + action 撤回文案 + duration 兜底', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
const row = ${JSON.stringify(ROW())};
const mine = formatDbMsg(row, 'user-a');
const theirs = formatDbMsg(row, 'user-b');
const actionMine = formatDbMsg(${JSON.stringify(ROW({ type: 'action', text: null, user_id: 'user-a' }))}, 'user-a');
const actionTheirs = formatDbMsg(${JSON.stringify(ROW({ type: 'action', text: null, user_id: 'user-b' }))}, 'user-a');
const durNull = formatDbMsg(${JSON.stringify(ROW({ duration: null }))}, 'user-a');
out({ mine, theirs, actionMine, actionTheirs, durNull });
`;
  const { after } = assertEqualBoth(body, 'C-01');
  assert.equal(after.mine.isMe, true);
  assert.equal(after.theirs.isMe, false);
  assert.equal(after.mine.timestamp, new Date('2026-11-20T10:00:00.000Z').getTime());
  assert.equal(after.actionMine.text, '你撤回了一条消息');
  assert.equal(after.actionTheirs.text, '对方撤回了一条消息');
  assert.equal(after.durNull.duration, 0);
});

// ===========================================================================
// C-02 缓存优先加载（过滤本地删除集）
// ===========================================================================
test('C-02 useChatMessages：缓存优先加载并过滤本地删除集', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
const CACHE_MSG_KEY = '@chatMessages_user-a_peer-x';
const CACHE_DEL_KEY = '@deletedMsgIds_user-a_peer-x';
const cached = [
  formatDbMsg(${JSON.stringify(ROW({ id: 'c1', created_at: '2026-11-20T10:00:00.000Z' }))}, 'user-a'),
  formatDbMsg(${JSON.stringify(ROW({ id: 'c2', created_at: '2026-11-20T11:00:00.000Z' }))}, 'user-a'),
];
await AS.setItem(CACHE_MSG_KEY, JSON.stringify(cached));
await AS.setItem(CACHE_DEL_KEY, JSON.stringify(['c2']));
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount(targetId, user);
await settle();
out({ ids: last.messages.map((m) => m.id), loading: last.loading, ownerKey: last.ownerKey });
`;
  const { after } = assertEqualBoth(body, 'C-02');
  assert.deepEqual(after.ids, ['c1']);
  assert.equal(after.loading, false);
  assert.equal(after.ownerKey, 'user-a::1');
});

// ===========================================================================
// C-03 云端拉取合并
// ===========================================================================
test('C-03 useChatMessages：云端拉取合并（本地乐观 + 远端权威 + 排序）', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
const CACHE_MSG_KEY = '@chatMessages_user-a_peer-x';
// 本地缓存一条乐观消息（localUri 存在）
const optimistic = Object.assign(
  formatDbMsg(${JSON.stringify(ROW({ id: 'local1', created_at: '2026-11-20T12:00:00.000Z', text: 'optimistic' }))}, 'user-a'),
  { localUri: 'file:///local1.jpg' }
);
await AS.setItem(CACHE_MSG_KEY, JSON.stringify([optimistic]));
// 云端返回两条（其中 local1 权威覆盖 + 一条新消息）
__sb.queryImpl = (table, chain) => {
  if (table === 'messages' && chain.ops.some((o) => o[0] === 'select')) {
    return Promise.resolve({ data: [
      ${JSON.stringify(ROW({ id: 'local1', created_at: '2026-11-20T12:00:00.000Z', text: 'authoritative' }))},
      ${JSON.stringify(ROW({ id: 'remote2', created_at: '2026-11-20T13:00:00.000Z', text: 'newer' }))},
    ], error: null });
  }
  return Promise.resolve({ data: null, error: null });
};
mount(targetId, user);
await settle();
out({
  ids: last.messages.map((m) => m.id),
  texts: last.messages.map((m) => m.text),
  localUri: last.messages.find((m) => m.id === 'local1')?.localUri ?? null,
  cached: JSON.parse(await AS.getItem(CACHE_MSG_KEY)).map((m) => m.id),
});
`;
  const { after } = assertEqualBoth(body, 'C-03');
  // 排序：remote2(13:00) > local1(12:00)
  assert.deepEqual(after.ids, ['remote2', 'local1']);
  assert.equal(after.texts[1], 'authoritative');
  assert.equal(after.localUri, 'file:///local1.jpg');
  assert.deepEqual(after.cached, ['remote2', 'local1']);
});

// ===========================================================================
// C-04 已读回写
// ===========================================================================
test('C-04 useChatMessages：已读回写（update is_read=true 条件逐字段一致）', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount(targetId, user);
await settle();
out({ updateCalls: __sb.updateCalls });
`;
  const { after } = assertEqualBoth(body, 'C-04');
  const readCall = after.updateCalls.find((c) => c.table === 'messages' && c.patch && c.patch.is_read === true);
  assert.ok(readCall, '应发起 is_read=true 的 update');
  assert.deepEqual(readCall.ops, [
    ['eq', 'user_id', 'peer-x'],
    ['eq', 'receiver_id', 'user-a'],
    ['eq', 'is_read', false],
  ]);
});

// ===========================================================================
// C-05 实时 INSERT（真实频道名 chat_<sorted>_<ts>_<rand>）
// ===========================================================================
test('C-05 useChatMessages：实时 INSERT 订阅（投递 + 去重）', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount(targetId, user);
await settle();
const names = supabase.__channelNames();
const insertCh = names.find((n) => n.startsWith('chat_'));
const ret = supabase.__emit(insertCh, 'postgres_changes', 'INSERT', { new: ${JSON.stringify(ROW({ id: 'rt1', created_at: '2026-11-20T14:00:00.000Z', text: 'realtime' }))} });
await settle();
const idsAfter = last.messages.map((m) => m.id);
supabase.__emit(insertCh, 'postgres_changes', 'INSERT', { new: ${JSON.stringify(ROW({ id: 'rt1', created_at: '2026-11-20T14:00:00.000Z', text: 'realtime' }))} });
await settle();
out({ ret, idsAfter, idsDedup: last.messages.map((m) => m.id), channelPrefix: insertCh ? insertCh.split('_')[0] : null });
`;
  const { after } = assertEqualBoth(body, 'C-05');
  assert.equal(after.ret, 1, 'INSERT 应投递到订阅 channel');
  assert.equal(after.channelPrefix, 'chat', '频道名应为 chat_ 前缀');
  assert.deepEqual(after.idsAfter, ['rt1']);
  assert.deepEqual(after.idsDedup, ['rt1'], '重复 INSERT 必须去重');
});

// ===========================================================================
// C-06 实时 UPDATE 撤回
// ===========================================================================
test('C-06 useChatMessages：实时 UPDATE 撤回（action 文案替换）', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z', text: 'hello' }))}], error: null });
mount(targetId, user);
await settle();
const names = supabase.__channelNames();
const updCh = names.find((n) => n.startsWith('chat_'));
supabase.__emit(updCh, 'postgres_changes', 'UPDATE', { new: ${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z', type: 'action', text: '撤回了一条消息', user_id: 'user-a' }))} });
await settle();
out({ type: last.messages[0]?.type, text: last.messages[0]?.text });
`;
  const { after } = assertEqualBoth(body, 'C-06');
  assert.equal(after.type, 'action');
  assert.equal(after.text, '你撤回了一条消息');
});

// ===========================================================================
// C-07 saveAndSend
// ===========================================================================
test('C-07 useChatMessages：saveAndSend 乐观插入并写缓存', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
const CACHE_MSG_KEY = '@chatMessages_user-a_peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount(targetId, user);
await settle();
last.saveAndSend({ id: 'opt1', type: 'text', text: 'hi', isMe: true, timestamp: 1000, localUri: 'file:///opt1' });
rerender();
await settle();
const cached = JSON.parse(await AS.getItem(CACHE_MSG_KEY));
out({ ids: last.messages.map((m) => m.id), cachedIds: cached.map((m) => m.id) });
`;
  const { after } = assertEqualBoth(body, 'C-07');
  assert.deepEqual(after.ids, ['opt1']);
  assert.deepEqual(after.cachedIds, ['opt1']);
});

// ===========================================================================
// C-08 patchMessage
// ===========================================================================
test('C-08 useChatMessages：patchMessage 局部更新并同步缓存', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
const CACHE_MSG_KEY = '@chatMessages_user-a_peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z', text: 'hello' }))}], error: null });
mount(targetId, user);
await settle();
last.patchMessage('m1', { text: 'edited', localUri: 'file:///m1.jpg' });
rerender();
await settle();
const cached = JSON.parse(await AS.getItem(CACHE_MSG_KEY));
out({ text: last.messages[0]?.text, localUri: last.messages[0]?.localUri, cachedText: cached[0]?.text });
`;
  const { after } = assertEqualBoth(body, 'C-08');
  assert.equal(after.text, 'edited');
  assert.equal(after.localUri, 'file:///m1.jpg');
  assert.equal(after.cachedText, 'edited');
});

// ===========================================================================
// C-09 revokeMessage 成功（update 条件：id + user_id）
// ===========================================================================
test('C-09 useChatMessages：revokeMessage 成功路径（update 条件 + 协议文案）', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z', text: 'hello' }))}], error: null });
__sb.updateImpl = () => Promise.resolve({ data: null, error: null });
mount(targetId, user);
await settle();
const res = await last.revokeMessage('m1');
rerender();
await settle();
out({ res, updateCalls: __sb.updateCalls, type: last.messages[0]?.type, text: last.messages[0]?.text });
`;
  const { after } = assertEqualBoth(body, 'C-09');
  assert.equal(after.res.ok, true);
  const upd = after.updateCalls.find((c) => c.table === 'messages' && c.patch && c.patch.type === 'action');
  assert.ok(upd, '应发起撤回 update');
  assert.deepEqual(upd.patch, { type: 'action', text: '撤回了一条消息', media_url: null, thumbnail_url: null });
  assert.deepEqual(upd.ops, [['eq', 'id', 'm1'], ['eq', 'user_id', 'user-a']]);
  assert.equal(after.type, 'action');
  assert.equal(after.text, '你撤回了一条消息');
});

// ===========================================================================
// C-10 revokeMessage 失败回滚
// ===========================================================================
test('C-10 useChatMessages：revokeMessage 失败回滚（原消息恢复）', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = (table, chain) => {
  if (chain && chain.ops.some((o) => o[0] === 'eq' && o[1] === 'id')) {
    return Promise.resolve({ data: ${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z', text: 'hello' }))}, error: null });
  }
  return Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z', text: 'hello' }))}], error: null });
};
__sb.updateImpl = () => Promise.resolve({ data: null, error: { message: 'boom' } });
mount(targetId, user);
await settle();
const res = await last.revokeMessage('m1');
rerender();
await settle();
out({ res, type: last.messages[0]?.type, text: last.messages[0]?.text });
`;
  const { after } = assertEqualBoth(body, 'C-10');
  assert.equal(after.res.ok, false);
  assert.equal(after.type, 'text');
  assert.equal(after.text, 'hello');
});

// ===========================================================================
// C-11 deleteMessage（delete 条件：id + user_id）
// ===========================================================================
test('C-11 useChatMessages：deleteMessage 软删除并写本地删除集', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
const CACHE_DEL_KEY = '@deletedMsgIds_user-a_peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'm1', created_at: '2026-11-20T10:00:00.000Z' }))}, ${JSON.stringify(ROW({ id: 'm2', created_at: '2026-11-20T11:00:00.000Z' }))}], error: null });
__sb.deleteImpl = () => Promise.resolve({ data: null, error: null });
mount(targetId, user);
await settle();
await last.deleteMessage('m1');
rerender();
await settle();
const del = JSON.parse(await AS.getItem(CACHE_DEL_KEY));
out({ ids: last.messages.map((m) => m.id), del, deleteCalls: __sb.deleteCalls });
`;
  const { after } = assertEqualBoth(body, 'C-11');
  assert.deepEqual(after.ids, ['m2']);
  assert.deepEqual(after.del, ['m1']);
  const del = after.deleteCalls.find((c) => c.table === 'messages');
  assert.ok(del, '应发起 delete');
  assert.deepEqual(del.ops, [['eq', 'id', 'm1'], ['eq', 'user_id', 'user-a']]);
});

// ===========================================================================
// C-12 owner 切换
// ===========================================================================
test('C-12 useChatMessages：owner 切换 A→B 后旧数据不残留', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
let user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'a1', created_at: '2026-11-20T10:00:00.000Z' }))}], error: null });
mount(targetId, user);
await settle();
const beforeIds = last.messages.map((m) => m.id);
const beforeOwner = last.ownerKey;
setIdentity('user-b', 2);
user = { id: 'user-b' };
__sb.queryImpl = () => Promise.resolve({ data: [${JSON.stringify(ROW({ id: 'b1', created_at: '2026-11-20T12:00:00.000Z', user_id: 'user-b' }))}], error: null });
last = rt.render(() => useChatMessages(targetId, user));
await settle();
out({ beforeIds, beforeOwner, afterIds: last.messages.map((m) => m.id), afterOwner: last.ownerKey });
`;
  const { after } = assertEqualBoth(body, 'C-12');
  assert.deepEqual(after.beforeIds, ['a1']);
  assert.equal(after.beforeOwner, 'user-a::1');
  assert.deepEqual(after.afterIds, ['b1']);
  assert.equal(after.afterOwner, 'user-b::2');
});

// ===========================================================================
// C-13 卸载清理
// ===========================================================================
test('C-13 useChatMessages：卸载后实时 channel 全部移除', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount(targetId, user);
await settle();
const liveBefore = supabase.__liveChannels().length;
rt.unmount();
const liveAfter = supabase.__liveChannels().length;
out({ liveBefore, liveAfter });
`;
  const { after } = assertEqualBoth(body, 'C-13');
  assert.ok(after.liveBefore >= 1, '挂载后应有实时 channel');
  assert.equal(after.liveAfter, 0, '卸载后不得残留 channel');
});

// ===========================================================================
// C-14 formatPreview（真实文案）
// ===========================================================================
test('C-14 formatPreview：各类型预览文案一致', async () => {
  const body = String.raw`
${LIST_PRELUDE}
const cases = [
  ${JSON.stringify(ROW({ type: 'text', text: 'hello' }))},
  ${JSON.stringify(ROW({ type: 'image', text: null }))},
  ${JSON.stringify(ROW({ type: 'audio', text: null }))},
  ${JSON.stringify(ROW({ type: 'video', text: null }))},
  ${JSON.stringify(ROW({ type: 'text', text: null }))},
  null,
];
out({ previews: cases.map((c) => formatPreview(c)) });
`;
  const { after } = assertEqualBoth(body, 'C-14');
  assert.equal(after.previews[0], 'hello');
  assert.equal(after.previews[1], '[图片]');
  assert.equal(after.previews[2], '[语音]');
  assert.equal(after.previews[3], '[视频]');
  assert.equal(after.previews[4], '暂无新消息');
  assert.equal(after.previews[5], '点击进入会话...');
});

// ===========================================================================
// C-15 useChatList 加载（friends 双向 or + profiles.in）
// ===========================================================================
test('C-15 useChatList：好友与请求加载（字段映射 + 排序）', async () => {
  const body = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'f1', user_id: 'user-a', friend_id: 'peer-1', remark: 'Alice', created_at: '2026-11-20T10:00:00.000Z' },
      { id: 'f2', user_id: 'peer-2', friend_id: 'user-a', remark: null, created_at: '2026-11-20T09:00:00.000Z' },
    ], error: null });
  }
  if (table === 'friend_requests') {
    return Promise.resolve({ data: [
      { id: 'r1', sender_id: 'peer-3', receiver_id: 'user-a', status: 'pending', created_at: '2026-11-20T11:00:00.000Z' },
    ], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [
      { id: 'peer-1', username: 'u1', nickname: 'Nick1', sync_id: 'S1' },
      { id: 'peer-2', username: 'u2', nickname: 'Nick2', sync_id: 'S2' },
      { id: 'peer-3', username: 'u3', nickname: 'Nick3', sync_id: 'S3' },
    ];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
mount(user);
await settle();
out({
  friendIds: last.friends.map((f) => f.id).sort(),
  requestIds: last.requests.map((r) => r.id),
  requestSender: last.requests[0]?.sender_profile?.nickname ?? null,
  loading: last.loading,
  ownerKey: last.ownerKey,
});
`;
  const { after } = assertEqualBoth(body, 'C-15');
  assert.deepEqual(after.friendIds, ['peer-1', 'peer-2']);
  assert.deepEqual(after.requestIds, ['r1']);
  assert.equal(after.requestSender, 'Nick3');
  assert.equal(after.loading, false);
  assert.equal(after.ownerKey, 'user-a::1');
});

// ===========================================================================
// C-16 未读计数
// ===========================================================================
test('C-16 useChatList：未读计数按 sender 聚合', async () => {
  const body = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'f1', user_id: 'user-a', friend_id: 'peer-1', remark: 'Alice', created_at: '2026-11-20T10:00:00.000Z' },
    ], error: null });
  }
  if (table === 'messages') {
    const isUnreadQuery = chain.ops.some((o) => o[0] === 'eq' && o[1] === 'is_read');
    if (isUnreadQuery) {
      return Promise.resolve({ data: [{ user_id: 'peer-1' }, { user_id: 'peer-1' }], error: null });
    }
    return Promise.resolve({ data: [], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [{ id: 'peer-1', username: 'u1', nickname: 'Nick1', sync_id: 'S1' }];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
mount(user);
await settle();
out({ unread: last.unreadCounts });
`;
  const { after } = assertEqualBoth(body, 'C-16');
  assert.equal(after.unread['peer-1'], 2);
});

// ===========================================================================
// C-17 实时消息更新未读（频道名 chat_list_realtime_<uid>_<ts>）
// ===========================================================================
test('C-17 useChatList：实时 INSERT 更新未读', async () => {
  const body = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'f1', user_id: 'user-a', friend_id: 'peer-1', remark: 'Alice', created_at: '2026-11-20T10:00:00.000Z' },
    ], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [{ id: 'peer-1', username: 'u1', nickname: 'Nick1', sync_id: 'S1' }];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
mount(user);
await settle();
const names = supabase.__channelNames();
const msgCh = names.find((n) => n.startsWith('chat_list_realtime_'));
const ret = supabase.__emit(msgCh, 'postgres_changes', 'INSERT', { new: ${JSON.stringify(ROW({ id: 'rt9', user_id: 'peer-1', receiver_id: 'user-a', text: 'yo', is_read: false, created_at: '2026-11-20T15:00:00.000Z' }))} });
await settle();
out({ ret, unread: last.unreadCounts, channelPrefix: msgCh ? msgCh.split('_').slice(0,3).join('_') : null });
`;
  const { after } = assertEqualBoth(body, 'C-17');
  assert.equal(after.ret, 1);
  assert.equal(after.channelPrefix, 'chat_list_realtime');
  assert.equal(after.unread['peer-1'], 1);
});

// ===========================================================================
// C-18 useChatList owner 切换
// ===========================================================================
test('C-18 useChatList：owner 切换 A→B 后旧好友不残留', async () => {
  const body = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
let user = { id: 'user-a' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'f1', user_id: 'user-a', friend_id: 'peer-1', remark: 'Alice', created_at: '2026-11-20T10:00:00.000Z' },
    ], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [{ id: 'peer-1', username: 'u1', nickname: 'Nick1', sync_id: 'S1' }];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
mount(user);
await settle();
const beforeIds = last.friends.map((f) => f.id);
const beforeOwner = last.ownerKey;
setIdentity('user-b', 2);
user = { id: 'user-b' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'g1', user_id: 'user-b', friend_id: 'peer-9', remark: 'Bob', created_at: '2026-11-20T12:00:00.000Z' },
    ], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [{ id: 'peer-9', username: 'u9', nickname: 'Nick9', sync_id: 'S9' }];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
last = rt.render(() => useChatList(user));
await settle();
out({ beforeIds, beforeOwner, afterIds: last.friends.map((f) => f.id), afterOwner: last.ownerKey });
`;
  const { after } = assertEqualBoth(body, 'C-18');
  assert.deepEqual(after.beforeIds, ['peer-1']);
  assert.equal(after.beforeOwner, 'user-a::1');
  assert.deepEqual(after.afterIds, ['peer-9']);
  assert.equal(after.afterOwner, 'user-b::2');
});

// ===========================================================================
// C-19 useChatList 卸载清理
// ===========================================================================
test('C-19 useChatList：卸载后实时 channel 全部移除', async () => {
  const body = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
__sb.queryImpl = () => Promise.resolve({ data: [], error: null });
mount(user);
await settle();
const liveBefore = supabase.__liveChannels().length;
rt.unmount();
const liveAfter = supabase.__liveChannels().length;
out({ liveBefore, liveAfter });
`;
  const { after } = assertEqualBoth(body, 'C-19');
  assert.ok(after.liveBefore >= 1, '挂载后应有实时 channel');
  assert.equal(after.liveAfter, 0, '卸载后不得残留 channel');
});

// ===========================================================================
// C-20 getDisplayName（备注优先 → nickname → username → undefined；null → '未知'）
// ===========================================================================
test('C-20 useChatList：getDisplayName 备注优先 + 兜底', async () => {
  const body = String.raw`
${LIST_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
__sb.queryImpl = (table, chain) => {
  if (table === 'friends') {
    return Promise.resolve({ data: [
      { id: 'f1', user_id: 'user-a', friend_id: 'peer-1', remark: 'Alice', created_at: '2026-11-20T10:00:00.000Z' },
      { id: 'f2', user_id: 'user-a', friend_id: 'peer-2', remark: null, created_at: '2026-11-20T09:00:00.000Z' },
    ], error: null });
  }
  if (table === 'profiles') {
    const inOp = chain.ops.find((o) => o[0] === 'in' && o[1] === 'id');
    const ids = inOp ? inOp[2] : [];
    const all = [
      { id: 'peer-1', username: 'u1', nickname: 'Nick1', sync_id: 'S1' },
      { id: 'peer-2', username: 'u2', nickname: 'Nick2', sync_id: 'S2' },
    ];
    return Promise.resolve({ data: all.filter((r) => ids.includes(r.id)), error: null });
  }
  return Promise.resolve({ data: [], error: null });
};
mount(user);
await settle();
const f1 = last.friends.find((f) => f.id === 'peer-1');
const f2 = last.friends.find((f) => f.id === 'peer-2');
out({ n1: last.getDisplayName(f1), n2: last.getDisplayName(f2), nNull: last.getDisplayName(null) });
`;
  const { after } = assertEqualBoth(body, 'C-20');
  assert.equal(after.n1, 'Alice');
  assert.equal(after.n2, 'Nick2');
  assert.equal(after.nNull, '未知');
});

// ===========================================================================
// C-21 故障注入敏感性
// ===========================================================================
test('C-21 敏感性：篡改排序结果后等价断言必须失败', async () => {
  const body = String.raw`
${MESSAGES_PRELUDE}
setIdentity('user-a', 1);
const user = { id: 'user-a' };
const targetId = 'peer-x';
__sb.queryImpl = () => Promise.resolve({ data: [
  ${JSON.stringify(ROW({ id: 'old', created_at: '2026-11-20T10:00:00.000Z' }))},
  ${JSON.stringify(ROW({ id: 'new', created_at: '2026-11-20T13:00:00.000Z' }))},
], error: null });
mount(targetId, user);
await settle();
out({ ids: last.messages.map((m) => m.id) });
`;
  const { before, after } = runBoth(body);
  assert.deepEqual(after.ids, before.ids, '正常应等价');
  const tampered = { ids: [...after.ids].reverse() };
  assert.throws(
    () => assert.deepEqual(tampered, before),
    /Expected values to be strictly deep-equal/,
    '排序被篡改时断言必须失败（证明测试非无条件通过）'
  );
});
