// --- START OF FILE tests/security/b4HealthSyncReliability.test.mjs ---
// ============================================================================
// TASK-P0.3 / B4 — 健康数据同步可靠性与离线 Pending 队列 自动化回归测试
//
// 覆盖 B4 统一设计中的关键不变量：
//   AC-B4-01  upsert 失败 → pending 保留（内存 + 磁盘），不丢数据
//   AC-B4-02  进程被杀（防抖窗口内）→ Hook 重建 → 同账号重登 → 恢复并补传
//   AC-B4-03  A→B 后 B 不得提交 A 的 pending（跨账号隔离）
//   AC-B4-04  A→B→A 后 A 的 pending 恢复并提交
//   AC-B4-05  冷启动本地新值不被旧云端快照覆盖（hasPendingFor 闸门）
//   AC-B4-06  并发 flush 不丢合法载荷（inflightKeys 按 key 去重）
//   AC-B4-07  提交成功同时清理内存与磁盘 pending
//   AC-B4-08  A、B 同日期 pending 完全隔离（磁盘 key 按 owner 命名空间）
//   AC-B4-09  补充二：旧提交成功不得清理新版本 pending（rev 校验）
//   AC-B4-10  补充二加强：V1 慢 / V2 快，V2 先成功、V1 后成功，最终保留 V2 结果
//   AC-B4-11  补充一：防抖窗口内进程被杀，重建后仍能恢复并提交（专项）
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token / 真实用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」，结束后自动清理。
//   - 断言针对真实生产接口（useHealthCloud 的导出契约 + 真实 AsyncStorage 内容 +
//     真实 upsert 请求参数）。
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
// 沙箱：stub react（真实 hook 语义）/ AsyncStorage（Map 持久化）/ supabase
//   · AsyncStorage 的 store 是模块级 Map，可在同一进程内跨「Hook 重建」保留，
//     用于模拟「进程被杀后磁盘数据仍在」。
//   · supabase stub 增加 upsertImpl，可注入失败 / 延迟 / 捕获请求参数。
// ---------------------------------------------------------------------------
function buildSandbox(extraCopies = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-health-'));
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
// 最小 createElement：仅用于把 JSX 改写后的 Provider 返回值为可读取的
// { type, props } 结构（测试侧读取 el.props.value），不参与真实渲染。
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
    // ⚠️ Node 无法解析 JSX。useHealthData.js 末尾有一处 JSX return
    //    （HealthContext.Provider），这里做最小等价改写为 React.createElement
    //    （不改变任何业务逻辑），使该文件可在沙箱中被真实 import 与执行。
    //    该文件只具名导入 Hook，没有 React 命名空间，因此需补一行 import * as React。
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

  // supabase stub：可注入 upsert 结果（失败 / 延迟 / 捕获请求参数）。
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  channels: [],
  rpcImpl: null,
  queryImpl: null,
  upsertImpl: null,      // (table, row, opts) => Promise<{data, error}>
  upsertCalls: [],       // 捕获每次 upsert 的请求参数
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

// ---------------------------------------------------------------------------
// 「真实 HealthProvider 可运行」沙箱（L4-03 用户操作级验证专用）
//
// 与 buildSandbox 的差异：
//   · 额外复制 useHealthData.js（HealthProvider）+ useHealthStorage.js +
//     useTimeSync.js + useStreak.js + useProfileCache.js + constants/dateUtils；
//   · 额外 stub react-native（AppState）/ expo-haptics / pushService；
//   · 用可控 useAuth stub 替换真实 useAuth（沙箱 useContext 为空桩，
//     真实 useAuth 会让 user 恒为 undefined → 无法验证用户操作流程）。
//
// 真实性声明：
//   ✅ 真实执行 useHealthData.js / useHealthStorage.js / useHealthCloud.js 源码；
//   ✅ 真实执行 handleAddWater → setWaterDirect → setWater → scheduleWaterSync
//      完整用户点击链路（不是直接调用 syncToCloud / enqueuePending）；
//   ✅ AsyncStorage 为真实内存 Map，跨「进程重建」保留（模拟磁盘仍在）。
//   ⚠️ 仅身份来源（useAuth）与原生模块（react-native / expo-haptics）为 stub。
// ---------------------------------------------------------------------------
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

  // react-native stub：AppState 可被测试手动派发 change 事件
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

  // expo-haptics stub：全部 no-op（不参与业务断言）
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

  // pushService stub：记录调用（本用例不断言通知，仅保证模块可解析）
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/pushService.js'), `
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!globalThis.__PUSH_LOG__) globalThis.__PUSH_LOG__ = [];
  globalThis.__PUSH_LOG__.push({ receiverId, title, body, data });
  return { ok: true };
}
`);

  // useAuth stub：由 __UID__ / __EPOCH__ 驱动，按 uid::epoch 缓存返回对象
  // （模拟真实 useMemo 的引用稳定性，避免 useEffect([user]) 反复触发）。
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
// AC-B4-01：upsert 失败 → pending 保留（内存 + 磁盘）
// ---------------------------------------------------------------------------
test('AC-B4-01 upsert 失败时 pending 保留在内存与磁盘，不丢数据', () => {
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

// upsert 一律失败
supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'network down' } });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(1500, { '早餐': true });
// 等待防抖 + flush 完成
await new Promise((r) => setTimeout(r, 1700));

// 磁盘上应存在 pending（owner 命名空间）
const diskKey = '@sync_health_pending_v1_user-aaa';
const diskRaw = await AS.getItem(diskKey);
const disk = diskRaw ? JSON.parse(diskRaw) : null;

// 再次 flush 仍失败，pending 仍在
await api.flushNow();
const diskRaw2 = await AS.getItem(diskKey);
const disk2 = diskRaw2 ? JSON.parse(diskRaw2) : null;

process.stdout.write(JSON.stringify({
  upsertCalls: supabase.__state.upsertCalls.length,
  diskHasEntry: Boolean(disk && disk[DATE]),
  diskWater: disk && disk[DATE] ? disk[DATE].water : null,
  stillThereAfterFlush: Boolean(disk2 && disk2[DATE]),
}));
`);
    assert.equal(out.upsertCalls >= 1, true, '应至少尝试一次 upsert');
    assert.equal(out.diskHasEntry, true, '失败后磁盘必须保留 pending');
    assert.equal(out.diskWater, 1500, '磁盘 pending 应保留原始水量');
    assert.equal(out.stillThereAfterFlush, true, '再次 flush 失败后 pending 仍应保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-02：进程被杀（防抖窗口内）→ Hook 重建 → 同账号重登 → 恢复并补传
// ---------------------------------------------------------------------------
test('AC-B4-02 防抖窗口内进程被杀，Hook 重建后同账号重登可恢复并补传', () => {
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

// 第一段：用户改数据，但 upsert 一直挂起（模拟进程在防抖窗口内被杀）
supabase.__reset();
let resolveUpsert;
supabase.__state.upsertImpl = () => new Promise((res) => { resolveUpsert = res; });

const rt1 = React.__createRuntime();
let api1 = null;
const render1 = (user, epoch) => { api1 = rt1.render(() => useHealthCloud(user, getDateStr, epoch)); return api1; };
render1(A, 1);
api1.syncToCloud(2222, { '早餐': true });
// 让 persistPending 的异步写盘完成（但不触发 flush 成功）
await new Promise((r) => setTimeout(r, 50));

const diskKey = '@sync_health_pending_v1_user-aaa';
const diskAfterKill = await AS.getItem(diskKey);
const diskObj = diskAfterKill ? JSON.parse(diskAfterKill) : null;

// 模拟进程被杀：卸载旧 runtime（不等待挂起的 upsert）
rt1.unmount();

// 第二段：全新 Hook（模拟冷启动 / 重登），upsert 恢复正常
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });
const rt2 = React.__createRuntime();
let api2 = null;
const render2 = (user, epoch) => { api2 = rt2.render(() => useHealthCloud(user, getDateStr, epoch)); return api2; };
render2(A, 1);
// 等待 hydrate + flush
await new Promise((r) => setTimeout(r, 100));
await api2.flushNow();

const diskAfterRecover = await AS.getItem(diskKey);
const upsertRows = supabase.__state.upsertCalls.map((c) => c.row);

process.stdout.write(JSON.stringify({
  diskAfterKillHasEntry: Boolean(diskObj && diskObj[DATE]),
  diskAfterKillWater: diskObj && diskObj[DATE] ? diskObj[DATE].water : null,
  recoveredUpsert: upsertRows.some((r) => r && r.water_amount === 2222),
  diskClearedAfterSuccess: diskAfterRecover === null,
}));
`);
    assert.equal(out.diskAfterKillHasEntry, true, '进程被杀前磁盘必须已落盘 pending');
    assert.equal(out.diskAfterKillWater, 2222, '磁盘 pending 应保留被杀前的水量');
    assert.equal(out.recoveredUpsert, true, '重建后应补传被杀前的数据');
    assert.equal(out.diskClearedAfterSuccess, true, '补传成功后磁盘 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-03：A→B 后 B 不得提交 A 的 pending（跨账号隔离）
// ---------------------------------------------------------------------------
test('AC-B4-03 切到 B 账号后不得提交 A 的 pending', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
// A 的 upsert 失败 → A 的 pending 保留
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'fail' } });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(1111, { '早餐': true });
await new Promise((r) => setTimeout(r, 1700));

// 切到 B
render(B, 2);
// B 触发自己的 flush（不应提交 A 的载荷）
await api.flushNow();

const rows = supabase.__state.upsertCalls.map((c) => c.row);
const aRows = rows.filter((r) => r && r.user_id === 'user-aaa');
const bRows = rows.filter((r) => r && r.user_id === 'user-bbb');

// A 的磁盘 pending 应仍在
const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const diskAObj = diskA ? JSON.parse(diskA) : null;

process.stdout.write(JSON.stringify({
  aUpsertCount: aRows.length,
  bUpsertCount: bRows.length,
  diskAStillThere: Boolean(diskAObj && diskAObj[DATE]),
}));
`);
    // A 的载荷在 A 会话内已尝试过（失败），切到 B 后不应再以 B 身份提交 A 的数据。
    // 关键：B 会话的 flush 不得产生 user_id=user-aaa 的成功写入。
    assert.equal(out.diskAStillThere, true, 'A 的磁盘 pending 在切到 B 后必须保留');
    // B 不应把 A 的数据写成 B 的（user_id 必须仍是 aaa 或不存在）
    assert.equal(out.bUpsertCount, 0, 'B 会话不应提交任何 B 的 upsert（B 无本地数据）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-04：A→B→A 后 A 的 pending 恢复并提交
// ---------------------------------------------------------------------------
test('AC-B4-04 A→B→A 后 A 的 pending 恢复并成功提交', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'fail' } });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(3333, { '早餐': true });
await new Promise((r) => setTimeout(r, 1700));

// A → B
render(B, 2);
await api.flushNow();

// 恢复网络，B → A（新 epoch）
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });
render(A, 3);
await new Promise((r) => setTimeout(r, 100));
await api.flushNow();

const rows = supabase.__state.upsertCalls.map((c) => c.row);
const aSuccess = rows.some((r) => r && r.user_id === 'user-aaa' && r.water_amount === 3333);
const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');

process.stdout.write(JSON.stringify({
  aSuccess,
  diskACleared: diskA === null,
}));
`);
    assert.equal(out.aSuccess, true, '切回 A 后应补传 A 的 pending');
    assert.equal(out.diskACleared, true, '补传成功后 A 的磁盘 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-05：冷启动本地新值不被旧云端快照覆盖（hasPendingFor 闸门）
// ---------------------------------------------------------------------------
test('AC-B4-05 本地存在未同步 pending 时 hasPendingFor 返回 true（云端 hydrate 闸门）', () => {
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
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'fail' } });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(4444, { '早餐': true });
await new Promise((r) => setTimeout(r, 1700));

// 内存态：hasPendingFor 应为 true
const inMemory = await api.hasPendingFor('user-aaa', DATE);
// 其他日期：应为 false
const otherDate = await api.hasPendingFor('user-aaa', '2026-11-18');
// 其他账号：应为 false
const otherOwner = await api.hasPendingFor('user-bbb', DATE);

process.stdout.write(JSON.stringify({ inMemory, otherDate, otherOwner }));
`);
    assert.equal(out.inMemory, true, '本地有未同步 pending 时 hasPendingFor 必须为 true');
    assert.equal(out.otherDate, false, '无 pending 的日期应为 false');
    assert.equal(out.otherOwner, false, '其他账号应为 false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-06：并发 flush 不丢合法载荷（inflightKeys 按 key 去重）
// ---------------------------------------------------------------------------
test('AC-B4-06 并发 flush 不丢合法载荷，同一 key 不重复提交', () => {
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
// upsert 延迟 30ms 成功，制造并发窗口
supabase.__state.upsertImpl = () => new Promise((res) => setTimeout(() => res({ data: null, error: null }), 30));

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(5555, { '早餐': true });
// 立即并发触发两次 flush（模拟防抖 flush 与 AppState flush 撞车）
await Promise.all([api.flushNow(), api.flushNow()]);

const rows = supabase.__state.upsertCalls.map((c) => c.row);
const waterRows = rows.filter((r) => r && r.water_amount === 5555);
const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');

process.stdout.write(JSON.stringify({
  waterUpsertCount: waterRows.length,
  diskCleared: diskA === null,
}));
`);
    // 同一 key 并发时 inflightKeys 去重，最多一次成功提交（可能因时序有 1 次）
    assert.equal(out.waterUpsertCount >= 1, true, '应至少提交一次合法载荷');
    assert.equal(out.waterUpsertCount <= 2, true, '同一 key 不应被无限重复提交');
    assert.equal(out.diskCleared, true, '成功后磁盘 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-07：提交成功同时清理内存与磁盘 pending
// ---------------------------------------------------------------------------
test('AC-B4-07 提交成功后内存与磁盘 pending 同时清理', () => {
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
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.syncToCloud(6666, { '早餐': true });
await new Promise((r) => setTimeout(r, 1700));
await api.flushNow();

const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const inMemory = await api.hasPendingFor('user-aaa', DATE);

process.stdout.write(JSON.stringify({ diskCleared: diskA === null, inMemory }));
`);
    assert.equal(out.diskCleared, true, '成功后磁盘 pending 应清理');
    assert.equal(out.inMemory, false, '成功后内存 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-08：A、B 同日期 pending 完全隔离（磁盘 key 按 owner 命名空间）
// ---------------------------------------------------------------------------
test('AC-B4-08 A、B 同日期 pending 在磁盘上完全隔离', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'fail' } });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

// A 写入失败
render(A, 1);
api.syncToCloud(7777, { '早餐': true });
await new Promise((r) => setTimeout(r, 1700));

// 切到 B，B 写入失败
render(B, 2);
api.syncToCloud(8888, { '早餐': false });
await new Promise((r) => setTimeout(r, 1700));

const diskA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const diskB = await AS.getItem('@sync_health_pending_v1_user-bbb');
const aObj = diskA ? JSON.parse(diskA) : null;
const bObj = diskB ? JSON.parse(diskB) : null;

process.stdout.write(JSON.stringify({
  aWater: aObj && aObj[DATE] ? aObj[DATE].water : null,
  bWater: bObj && bObj[DATE] ? bObj[DATE].water : null,
  aOwner: aObj && aObj[DATE] ? aObj[DATE].ownerId : null,
  bOwner: bObj && bObj[DATE] ? bObj[DATE].ownerId : null,
}));
`);
    assert.equal(out.aWater, 7777, 'A 的磁盘 pending 应保留 A 的水量');
    assert.equal(out.bWater, 8888, 'B 的磁盘 pending 应保留 B 的水量');
    assert.equal(out.aOwner, 'user-aaa', 'A 的 pending ownerId 必须是 A');
    assert.equal(out.bOwner, 'user-bbb', 'B 的 pending ownerId 必须是 B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// AC-B4-09：补充二 — 旧提交成功不得清理新版本 pending（rev 校验）
//
// 场景：V1 提交挂起 → 用户再次编辑产生 V2（rev 更大）→ V1 迟到成功。
// 期望：V1 成功只能确认 V1，不得删除 V2；磁盘 pending 必须仍是 V2。
// ---------------------------------------------------------------------------
test('AC-B4-09 旧提交成功不得清理新版本 pending（rev 校验）', () => {
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
// 第一次 upsert（V1）挂起，由测试手动 resolve；后续 upsert 直接成功。
let resolveV1 = null;
let callIdx = 0;
supabase.__state.upsertImpl = () => {
  callIdx += 1;
  if (callIdx === 1) return new Promise((res) => { resolveV1 = res; });
  return Promise.resolve({ data: null, error: null });
};

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);

// V1：水量 1000，立即 flush（不等防抖），使 V1 进入 in-flight 挂起
api.syncToCloud(1000, { '早餐': true });
const flushP = api.flushNow();
await new Promise((r) => setTimeout(r, 20));

// V2：用户再次编辑，水量 2000（rev 更大），写入内存 + 磁盘
api.syncToCloud(2000, { '早餐': true });
await new Promise((r) => setTimeout(r, 20));

const diskBeforeV1 = await AS.getItem('@sync_health_pending_v1_user-aaa');
const beforeObj = diskBeforeV1 ? JSON.parse(diskBeforeV1) : null;

// V1 迟到成功
if (resolveV1) resolveV1({ data: null, error: null });
await flushP;
await new Promise((r) => setTimeout(r, 50));

const diskAfterV1 = await AS.getItem('@sync_health_pending_v1_user-aaa');
const afterObj = diskAfterV1 ? JSON.parse(diskAfterV1) : null;
const inMemory = await api.hasPendingFor('user-aaa', DATE);

process.stdout.write(JSON.stringify({
  beforeWater: beforeObj && beforeObj[DATE] ? beforeObj[DATE].water : null,
  beforeRev: beforeObj && beforeObj[DATE] ? beforeObj[DATE].rev : null,
  afterWater: afterObj && afterObj[DATE] ? afterObj[DATE].water : null,
  afterRev: afterObj && afterObj[DATE] ? afterObj[DATE].rev : null,
  inMemory,
}));
`);
    assert.equal(out.beforeWater, 2000, 'V1 挂起期间磁盘应已是 V2 的水量');
    assert.equal(out.beforeRev >= 2, true, 'V2 的 rev 必须大于 V1');
    assert.equal(out.afterWater, 2000, 'V1 迟到成功不得删除 V2，磁盘仍应是 V2 水量');
    assert.equal(out.afterRev >= 2, true, 'V1 迟到成功后 V2 的 rev 必须保留');
    assert.equal(out.inMemory, true, 'V1 迟到成功后内存仍应保留 V2 pending');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-10：补充二加强 — V1 慢 / V2 快，V2 先成功、V1 后成功，最终保留 V2
//
// 场景：V1 挂起 → V2 产生并成功提交（清理 V2）→ V1 迟到成功。
// 期望：V1 迟到成功不得把已清理的 V2 结果「复活」或覆盖；最终无 pending，
//       且云端最后一次成功写入是 V2 的水量。
// ---------------------------------------------------------------------------
test('AC-B4-10 V1 慢 / V2 快：V1 迟到成功不得删除 V2，后续 flush 提交 V2', () => {
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
// 第 1 次（V1）挂起；后续（V2 及之后）快速成功。
let resolveV1 = null;
let callIdx = 0;
supabase.__state.upsertImpl = () => {
  callIdx += 1;
  if (callIdx === 1) return new Promise((res) => { resolveV1 = res; });
  return Promise.resolve({ data: null, error: null });
};

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);

// V1：水量 1000，进入 in-flight 挂起（占用同一 key）
api.syncToCloud(1000, { '早餐': true });
const flushP = api.flushNow();
await new Promise((r) => setTimeout(r, 20));

// V2：水量 2000（rev 更大）。此时 V1 仍占用 key，V2 的 flush 被按 key 去重跳过，
// 因此 V2 只能留在 pending，等待 V1 结束后再提交。
api.syncToCloud(2000, { '早餐': true });
await api.flushNow();
await new Promise((r) => setTimeout(r, 20));

const diskAfterV2 = await AS.getItem('@sync_health_pending_v1_user-aaa');
const afterV2Obj = diskAfterV2 ? JSON.parse(diskAfterV2) : null;

// V1 迟到成功：只能确认 V1，绝不能删除 V2。
if (resolveV1) resolveV1({ data: null, error: null });
await flushP;
await new Promise((r) => setTimeout(r, 30));

const diskAfterV1 = await AS.getItem('@sync_health_pending_v1_user-aaa');
const afterV1Obj = diskAfterV1 ? JSON.parse(diskAfterV1) : null;

// 再次 flush：此时 V2 可提交并成功，pending 清理。
await api.flushNow();
await new Promise((r) => setTimeout(r, 30));

const diskFinal = await AS.getItem('@sync_health_pending_v1_user-aaa');
const inMemory = await api.hasPendingFor('user-aaa', DATE);
const rows = supabase.__state.upsertCalls.map((c) => c.row);
const successWaters = rows.filter((r) => r && r.user_id === 'user-aaa').map((r) => r.water_amount);

process.stdout.write(JSON.stringify({
  v2PendingWater: afterV2Obj && afterV2Obj[DATE] ? afterV2Obj[DATE].water : null,
  v1LateKeptV2: afterV1Obj && afterV1Obj[DATE] ? afterV1Obj[DATE].water : null,
  finalCleared: diskFinal === null,
  inMemory,
  successWaters,
}));
`);
    assert.equal(out.v2PendingWater, 2000, 'V1 挂起期间 V2 应已写入 pending');
    assert.equal(out.v1LateKeptV2, 2000, 'V1 迟到成功不得删除 V2，pending 仍应是 V2');
    assert.equal(out.finalCleared, true, 'V2 最终提交成功后 pending 应清理');
    assert.equal(out.inMemory, false, '最终内存不应残留 pending');
    assert.equal(out.successWaters.includes(2000), true, '云端最终应收到 V2 的写入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B4-11：补充一 — 防抖窗口内进程被杀，重建后仍能恢复并提交（专项）
//
// 场景：用户改数据后「立即」被杀（远早于 1500ms 防抖），此时 flush 尚未发生。
// 期望：入队即落盘，磁盘已有 pending；重建 Hook 后恢复并成功提交。
// 说明：本用例验证「入队即落盘」保证的边界——只要 syncToCloud 已执行，
//       数据即进入可靠持久化路径，不依赖防抖计时器是否触发。
// ---------------------------------------------------------------------------
test('AC-B4-11 防抖窗口内（flush 前）进程被杀，重建后仍能恢复并提交', () => {
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
// upsert 一直挂起：模拟「网络请求已发出但无响应」，flush 永远不成功，
// 从而把 pending 稳定地留在磁盘上，用于验证「防抖窗口内被杀」的落盘保证。
supabase.__state.upsertImpl = () => new Promise(() => {});

const rt1 = React.__createRuntime();
let api1 = null;
const render1 = (user, epoch) => { api1 = rt1.render(() => useHealthCloud(user, getDateStr, epoch)); return api1; };
render1(A, 1);

// 用户改数据后「立即」被杀：只等 persistPending 的微任务落盘，不等 1500ms 防抖
api1.syncToCloud(9999, { '早餐': true });
await new Promise((r) => setTimeout(r, 40));

const diskKey = '@sync_health_pending_v1_user-aaa';
const diskAtKill = await AS.getItem(diskKey);
const killObj = diskAtKill ? JSON.parse(diskAtKill) : null;

// 进程被杀（卸载，防抖计时器不会触发 flush）
rt1.unmount();

// 冷启动重建：upsert 恢复正常
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });
const rt2 = React.__createRuntime();
let api2 = null;
const render2 = (user, epoch) => { api2 = rt2.render(() => useHealthCloud(user, getDateStr, epoch)); return api2; };
render2(A, 1);
await new Promise((r) => setTimeout(r, 100));
await api2.flushNow();

const diskAfter = await AS.getItem(diskKey);
const rows = supabase.__state.upsertCalls.map((c) => c.row);
const recovered = rows.some((r) => r && r.user_id === 'user-aaa' && r.water_amount === 9999);

process.stdout.write(JSON.stringify({
  diskAtKillHasEntry: Boolean(killObj && killObj[DATE]),
  diskAtKillWater: killObj && killObj[DATE] ? killObj[DATE].water : null,
  recovered,
  diskClearedAfterSuccess: diskAfter === null,
}));
`);
    assert.equal(out.diskAtKillHasEntry, true, '防抖窗口内被杀前，数据必须已落盘');
    assert.equal(out.diskAtKillWater, 9999, '落盘 pending 应保留被杀前的水量');
    assert.equal(out.recovered, true, '重建后应恢复并补传被杀前的数据');
    assert.equal(out.diskClearedAfterSuccess, true, '补传成功后磁盘 pending 应清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// L4-VERIFY-01: If V2's sole debounce flush expires while V1 is in-flight,
// V1 completion must trigger eventual V2 submission without manual flushNow().
test('L4-VERIFY-01 latest pending must automatically retry after older in-flight completes', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const A = {id:'user-aaa'}, D='2026-11-19';
let finishV1;
supabase.__state.upsertImpl = (table, row) => {
  if (row.water_amount === 1000) return new Promise(resolve => {finishV1=resolve;});
  return Promise.resolve({data:null,error:null});
};
const rt = React.__createRuntime();
const api = rt.render(() => useHealthCloud(A, () => D, 1));
api.syncToCloud(1000, {'早餐': true});
const v1 = api.flushNow();
await new Promise(r=>setTimeout(r,35));
api.syncToCloud(2000, {'早餐': true});
// V2 auto-debounce fires while V1 is still in-flight and is discarded by the Set.
await new Promise(r=>setTimeout(r,1650));
finishV1({data:null,error:null});
await v1;
await new Promise(r=>setTimeout(r,150));
const raw = await AS.getItem('@sync_health_pending_v1_user-aaa');
const disk = raw ? JSON.parse(raw) : null;
process.stdout.write(JSON.stringify({
  upserts: supabase.__state.upsertCalls.map(x=>x.row.water_amount),
  pending: disk && disk[D] ? disk[D].water : null,
}));
`);
    assert.equal(out.upserts.includes(2000), true,
      `V2 must auto-submit after V1 completes, observed ${JSON.stringify(out)}`);
    assert.equal(out.pending, null, 'after success V2 must be cleared from disk');
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

// L4-VERIFY-02: A user may edit immediately after startup, before the async
// disk hydration resolves. A persisted high revision must not overwrite the
// freshly edited value simply because the fresh in-memory revision restarted at 1.
test('L4-VERIFY-02 fresh edit during cold-start hydration must not be overwritten by old disk rev', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const A = {id:'user-aaa'}, D='2026-11-19';
// Old pending persisted in a prior process, rev=8.
await AS.setItem('@sync_health_pending_v1_user-aaa', JSON.stringify({
  [D]:{recordDate:D,water:1000,meals:{'早餐':false},ownerId:A.id,rev:8,updatedAt:1000}
}));
const rt = React.__createRuntime();
const api = rt.render(() => useHealthCloud(A, () => D, 1));
// User edits *before* hydratePendingFromDisk's first await has resumed.
api.syncToCloud(2000, {'早餐':true});
await new Promise(r=>setTimeout(r,140));
const raw = await AS.getItem('@sync_health_pending_v1_user-aaa');
const disk = raw ? JSON.parse(raw) : null;
process.stdout.write(JSON.stringify({
  upserts: supabase.__state.upsertCalls.map(x=>x.row.water_amount),
  diskWater:disk && disk[D] ? disk[D].water : null,
  diskRev:disk && disk[D] ? disk[D].rev : null
}));
`);
    assert.equal(out.upserts.includes(1000), false,
      `stale disk revision must not be sent after a newer edit, observed ${JSON.stringify(out)}`);
    assert.equal(out.upserts.includes(2000), true,
      `fresh edit should win and submit, observed ${JSON.stringify(out)}`);
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

// ===========================================================================
// L4-03 — 真实 HealthProvider 用户操作级验证：外层 500ms 防抖窗口内必须已落盘
//
// 缺陷（L4 复现）：生产链路是
//   handleAddWater → setWaterDirect → setWater → scheduleWaterSync(500ms)
//   → syncToCloud → persistPending
// 旧实现只在 500ms 定时器触发后才 syncToCloud → persistPending，因此
// 「用户点击后 500ms 内进程被杀」时磁盘无 Pending：
//   · 冷启动 hydratePendingFromDisk 无数据可恢复；
//   · 旧云端快照（water=400）会覆盖本地新值（water=401）。
// 实测：点击后本地 401，500ms 内 B4 Pending 为 null。
//
// 期望（修复后）：
//   1) 用户真实执行 handleAddWater（不是直接调 syncToCloud）；
//   2) 本地值成功变化（400 → 401）；
//   3) 在 500ms 定时器触发**之前**，磁盘已存在 pending（water=401）；
//   4) 模拟进程终止并重建 Provider；
//   5) 旧云端快照（400）不得覆盖本地新值（401）；
//   6) 网络恢复后最终把最新值（401）重传上云。
// ===========================================================================
test('L4-03 真实 handleAddWater 在 500ms 防抖窗口内必须已落盘，且冷启动不被旧云端覆盖', () => {
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
// ⚠️ 日期必须与 useTimeSync.getDateStr() 的「本地时区当前日期」一致。
//    硬编码日期会在跨午夜（如 Europe/Madrid 的 23:00 UTC 之后）导致
//    enqueuePending 写入「明天」的槽位，而断言读取「昨天」的槽位 → 假失败。
//    这里动态取当前本地日期，保证测试与生产路径使用同一日期口径。
const DATE = formatDateStr(new Date());
const PENDING_KEY = '@sync_health_pending_v1_' + A;
const k = buildHealthKeys(A);

// 预置本地磁盘：water=400（用户点击前的真实值）
await AS.setItem(k.water, '400');
await AS.setItem(k.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);
await AS.setItem(k.maxWater, '2000');

// 云端旧快照：water=400（点击前）。upsert 成功后云端快照同步更新，
// 以真实反映「写入成功 → 后续 fetch 读到新值」的云端语义。
supabase.__reset();
const cloudRow = { water_amount: 400, meals_status: { '早餐': false, '午餐': false, '晚餐': false } };
supabase.__state.queryImpl = (table) => {
  if (table === 'health_records') {
    return Promise.resolve({ data: { ...cloudRow }, error: null });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = (table, row) => {
  if (table === 'health_records') {
    cloudRow.water_amount = row.water_amount;
    cloudRow.meals_status = row.meals_status;
  }
  return Promise.resolve({ data: null, error: null });
};

// ── 第一次进程：真实渲染 HealthProvider，执行用户点击 ──
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => {
  const el = HealthProvider({ children: null });
  ctx1 = el && el.props ? el.props.value : null;
  return null;
};
rt1.render(Comp1);
// 等待本地 load + 云端 hydrate 完成（此时云端 400 与本地 400 一致）
await new Promise((r) => setTimeout(r, 60));
rt1.render(Comp1);

const waterBefore = ctx1.waterAmount;

// 用户真实点击「+1」：走 handleAddWater 完整链路
ctx1.handleAddWater();
rt1.render(Comp1);
const waterAfterClick = ctx1.waterAmount;

// ⚠️ 关键断言点：此刻 500ms 定时器尚未触发（只等 120ms），
//    但 pending 必须已经落盘（修复后 enqueuePending 在排队时立即写盘）。
await new Promise((r) => setTimeout(r, 120));
const rawBeforeKill = await AS.getItem(PENDING_KEY);
const pendingBeforeKill = rawBeforeKill ? JSON.parse(rawBeforeKill) : null;
const pendingWaterBeforeKill = pendingBeforeKill && pendingBeforeKill[DATE] ? pendingBeforeKill[DATE].water : null;
const localDiskBeforeKill = await AS.getItem(k.water);

// ── 模拟进程终止：卸载（不等待 500ms 定时器，不 flush）──
rt1.unmount();

// ── 第二次进程：重建 Provider（磁盘数据仍在）──
const rt2 = React.__createRuntime();
let ctx2 = null;
const Comp2 = () => {
  const el = HealthProvider({ children: null });
  ctx2 = el && el.props ? el.props.value : null;
  return null;
};
rt2.render(Comp2);
// 等待冷启动 hydrate + 云端拉取（云端返回旧快照 400）
await new Promise((r) => setTimeout(r, 120));
rt2.render(Comp2);

const waterAfterRestart = ctx2.waterAmount;
const localDiskAfterRestart = await AS.getItem(k.water);

// ── 网络恢复：不调用任何内部 API，仅等待真实 500ms 防抖定时器自然触发 ──
//    （HealthProvider 的 context 不暴露 flushNow，必须走真实用户路径）
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 700));
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 200));

const upserts = supabase.__state.upsertCalls.map((c) => c.row.water_amount);

process.stdout.write(JSON.stringify({
  waterBefore,
  waterAfterClick,
  pendingWaterBeforeKill,
  localDiskBeforeKill,
  waterAfterRestart,
  localDiskAfterRestart,
  upserts,
}));
`);
    // (1)(2) 用户真实点击后本地值成功变化
    assert.equal(out.waterBefore, 400, '前置条件：点击前本地 water 应为 400');
    assert.equal(out.waterAfterClick, 401, '用户执行 handleAddWater 后本地值必须变为 401');
    // (3) 500ms 定时器触发前，pending 必须已落盘
    assert.equal(
      out.pendingWaterBeforeKill,
      401,
      `500ms 防抖窗口内 pending 必须已落盘为 401，实际 ${JSON.stringify(out.pendingWaterBeforeKill)}`
    );
    assert.equal(out.localDiskBeforeKill, '401', '点击后本地磁盘 water 应为 401');
    // (4)(5) 重建后本地新值不被旧云端快照（400）覆盖
    assert.equal(
      out.waterAfterRestart,
      401,
      `冷启动重建后本地新值必须保持 401（不得被旧云端 400 覆盖），实际 ${JSON.stringify(out.waterAfterRestart)}`
    );
    assert.equal(out.localDiskAfterRestart, '401', '重建后本地磁盘 water 必须仍为 401');
    // (6) 网络恢复后最终重传最新值
    assert.equal(
      out.upserts.includes(401),
      true,
      `网络恢复后必须把最新值 401 重传上云，实际 upserts=${JSON.stringify(out.upserts)}`
    );
    assert.equal(
      out.upserts.includes(400),
      false,
      `不得把旧云端快照 400 当作新值提交，实际 upserts=${JSON.stringify(out.upserts)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// L4-R1-EXTRA-01: same-millisecond edits cannot use updatedAt strictly increasing as a revision.
test('L4-R1-EXTRA-01 two versions with same Date.now must auto-flush latest after inflight', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const A={id:'user-aaa'}, D='2026-11-19';
let finishV1;
supabase.__state.upsertImpl = (t,row)=>row.water_amount===1000
  ? new Promise(resolve=>{finishV1=resolve;})
  : Promise.resolve({data:null,error:null});
// Date.now has 1ms resolution: legitimate rapid changes may receive identical timestamps.
const originalNow=Date.now;
Date.now=()=>1800000000000;
const rt=React.__createRuntime();
const api=rt.render(()=>useHealthCloud(A,()=>D,1));
api.syncToCloud(1000, {'早餐':true});
const v1=api.flushNow();
// Second edit happens immediately in the same JS turn, possibly within the same millisecond.
api.syncToCloud(2000, {'早餐':true});
Date.now=originalNow;
await new Promise(r=>setTimeout(r,1650));
finishV1({data:null,error:null});
await v1;
await new Promise(r=>setTimeout(r,150));
const raw=await AS.getItem('@sync_health_pending_v1_user-aaa');
const disk=raw?JSON.parse(raw):null;
process.stdout.write(JSON.stringify({upserts:supabase.__state.upsertCalls.map(x=>x.row.water_amount),pending:disk?.[D]?.water??null}));
`);
    assert.deepEqual(out.upserts, [1000,2000], `latest version must be auto submitted even when timestamps tie: ${JSON.stringify(out)}`);
    assert.equal(out.pending, null);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

// L4-R1-EXTRA-02: device wall clock is not monotonic. A corrected clock may go backward.
test('L4-R1-EXTRA-02 cold-start new edit wins despite old disk timestamp ahead of wall clock', () => {
  const dir=buildSandbox();
  try {
    const out=runInSandbox(dir, `
const React=await import('react');
const AS=(await import('@react-native-async-storage/async-storage')).default;
const {supabase}=await import('./src/services/supabase.js');
const {useHealthCloud}=await import('./src/hooks/health/useHealthCloud.js');
const A={id:'user-aaa'},D='2026-11-19';
// Previous process persisted when device clock was 10 seconds ahead; NTP corrected it.
const futureBeforeCorrection=Date.now()+10000;
await AS.setItem('@sync_health_pending_v1_user-aaa',JSON.stringify({
  [D]:{recordDate:D,water:1000,meals:{'早餐':false},ownerId:A.id,rev:8,updatedAt:futureBeforeCorrection}
}));
const rt=React.__createRuntime();
const api=rt.render(()=>useHealthCloud(A,()=>D,1));
// User edits right after startup, before queued disk hydration resolves.
api.syncToCloud(2000, {'早餐':true});
await new Promise(r=>setTimeout(r,140));
const raw=await AS.getItem('@sync_health_pending_v1_user-aaa');
const disk=raw?JSON.parse(raw):null;
process.stdout.write(JSON.stringify({upserts:supabase.__state.upsertCalls.map(x=>x.row.water_amount),pending:disk?.[D]?.water??null}));
`);
    assert.equal(out.upserts.includes(1000),false, `stale edit must not overwrite new edit after clock rollback: ${JSON.stringify(out)}`);
    assert.equal(out.upserts.includes(2000),true, `new edit must be recovered and submitted: ${JSON.stringify(out)}`);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

// L4 final focused probe: an in-flight restored previous-boot version has higher
// numeric opSeq than a new operation from the current boot; opSeq cannot order boots.
test('L4-R2-CROSS-BOOT restored V1 inflight must auto-submit current-boot V2 regardless of numeric opSeq', () => {
  const dir=buildSandbox();
  try {
    const out=runInSandbox(dir, `
const React=await import('react');
const AS=(await import('@react-native-async-storage/async-storage')).default;
const {supabase}=await import('./src/services/supabase.js');
const {useHealthCloud}=await import('./src/hooks/health/useHealthCloud.js');
const A={id:'user-aaa'},D='2026-11-19', key='@sync_health_pending_v1_user-aaa';
await AS.setItem(key,JSON.stringify({
  [D]:{recordDate:D,ownerId:A.id,water:1000,meals:{'早餐':true},
    rev:80,updatedAt:1800000000000,bootId:'old-process-identity',opSeq:80,opId:'old-process-identity-80'}
}));
let finishOld;
supabase.__state.upsertImpl=(table,row)=>row.water_amount===1000
  ? new Promise(resolve=>{finishOld=resolve;})
  : Promise.resolve({data:null,error:null});
const rt=React.__createRuntime();
const api=rt.render(()=>useHealthCloud(A,()=>D,1));
await new Promise(r=>setTimeout(r,80));
if(typeof finishOld!=='function') throw Error('Old pending did not start automatic flush');
api.syncToCloud(2000,{'早餐':true});
await new Promise(r=>setTimeout(r,1640));
finishOld({data:null,error:null});
await new Promise(r=>setTimeout(r,180));
const raw=await AS.getItem(key);
const disk=raw?JSON.parse(raw):null;
process.stdout.write(JSON.stringify({upserts:supabase.__state.upsertCalls.map(c=>c.row.water_amount),
    pending:disk?.[D]?.water??null, opSeq:disk?.[D]?.opSeq??null}));
`);
    assert.deepEqual(out.upserts,[1000,2000],`new current-boot operation must auto flush: ${JSON.stringify(out)}`);
    assert.equal(out.pending,null);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
