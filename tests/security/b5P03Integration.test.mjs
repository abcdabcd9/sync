// --- START OF FILE tests/security/b5P03Integration.test.mjs ---
// ============================================================================
// TASK-P0.3 / B5 — 跨模块综合集成验收（真实运行时）
//
// 定位：
//   B1–B4 各自验证了单模块不变量。B5 验证「多个模块同时在线」时的组合行为，
//   即真实用户操作链跨模块串联后仍满足身份隔离与最终一致性。
//
// 覆盖（AC-B5-01 ~ AC-B5-08 核心组合 + 补充场景）：
//   AC-B5-01  A 离线改健康数据（Pending 未提交）→ 切 B → B 正常使用 → 切回 A
//             → 网络恢复 → A 数据正确回填，B 数据完全不受影响（最关键组合）
//   AC-B5-02  身份切换首帧：不得暴露旧账号私有数据（fail-closed 可见性）
//   AC-B5-03  旧会话在途异步请求不得写入新会话状态（跨模块：health + media + signedUrl）
//   AC-B5-04  新账号合法数据必须正常恢复（隔离不误伤）
//   AC-B5-05  存储 / 订阅 / Pending 异步状态最终收敛到正确身份（最终一致性）
//   AC-B5-06  fail-closed 不得造成永久空白或永久失联（可恢复性）
//   AC-B5-07  媒体缓存跨账号不可读 + 同账号重登合法复用（B2 × B1 组合）
//   AC-B5-08  搭子授权撤销后可见数据清空且订阅失效（B3 × B4 组合）
//   AC-B5-09  补充：正常喝水 / 打卡 / 撤销打卡链路不回归（B4 × UI 契约）
//   AC-B5-10  补充：Modal 退出动画与旧动画回调隔离（B1 × 组件契约）
//   AC-B5-11  补充：Realtime 断线重连 / 前后台切换后订阅仍绑定当前身份
//   AC-B5-12  补充：同账号 token 刷新（TOKEN_REFRESHED）不得误伤在途合法请求
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token / 真实用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」，结束后自动清理。
//   - 断言针对真实生产接口与真实磁盘状态，不做「源码字符串」替代。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// 沙箱 A：健康链路（useHealthData + useHealthStorage + useHealthCloud）
// ---------------------------------------------------------------------------
function buildHealthSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-health-'));
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
    hooks, effects,
    renderOnly(fn) { idx = 0; effects.length = 0; ctx = runtime; return fn(); },
    render(fn) {
      let out;
      for (let round = 0; round < 20; round++) {
        idx = 0; effects.length = 0; ctx = runtime;
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
    unmount() { for (const e of effects) { if (e.cleanup) { try { e.cleanup(); } catch (_) {} } e.cleanup = null; } },
  };
  return runtime;
}
export function useState(init) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: typeof init === 'function' ? init() : init };
  const slot = rt.hooks[i];
  const setter = (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next; };
  return [slot.v, setter];
}
export function useRef(v) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { current: v };
  return rt.hooks[i];
}
export function useEffect(fn, deps) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps: undefined, prevDeps: undefined, cleanup: null };
  const slot = rt.hooks[i];
  slot.fn = fn; slot.deps = deps; rt.effects.push(slot);
}
export function useCallback(fn, deps) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.fn = fn; slot.deps = deps; }
  return slot.fn;
}
export function useMemo(fn, deps) {
  const rt = ctx; const i = idx++;
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

  // P1.4 R2：useProfileCache 已迁移为 .ts，按 .ts/.tsx 优先、.js 兜底解析，
  // 使沙箱始终复制当前真实源码（Node 24 原生类型擦除执行）。
  const resolveSrc = (rel) => {
    const tsxRel = rel.replace(/\.js$/, '.tsx');
    if (fs.existsSync(path.join(repoRoot, tsxRel))) return tsxRel;
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  // 沙箱内 import 扩展名不一致（.js / .ts 混用），故 .ts 源同时落盘两份：
  //   · rel（.js）：tsc 擦除类型后的可执行代码
  //   · actual（.ts）：原样源码（Node 24 原生类型擦除）
  const copy = (rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    // P1.4 R6：useHealthData 已迁移为 .tsx（HealthProvider JSX + TS 类型注解）。
    //   使用项目自带 TypeScript 编译器做「类型擦除 + JSX→createElement」转译。
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
      const raw = code;
      code = ts.transpileModule(raw, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      fs.writeFileSync(path.join(dir, actual), raw);
    }
    fs.writeFileSync(path.join(dir, rel), code);
  };
  copy('src/hooks/useHealthData.js');
  copy('src/hooks/health/useHealthCloud.js');
  copy('src/hooks/health/useHealthStorage.js');
  copy('src/hooks/health/useTimeSync.js');
  copy('src/hooks/health/useStreak.js');
  copy('src/hooks/health/constants.ts');
  copy('src/hooks/health/dateUtils.ts');
  copy('src/hooks/health/authRevokeLogic.ts');
  copy('src/hooks/profile/useProfileCache.js');

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
    const target = chOrRef && chOrRef.__ref
      ? chOrRef.__ref
      : state.channels.find((c) => c.api === chOrRef)
        || state.channels.find((c) => c.topic === (chOrRef && chOrRef.topic));
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
      insert(row) {
        state.upsertCalls.push({ table, row, opts: { insert: true } });
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

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}return n(s,c);}`);
  return dir;
}

// ---------------------------------------------------------------------------
// 沙箱 B：媒体链路（mediaCache + useSignedMediaUrl）
// ---------------------------------------------------------------------------
function buildMediaSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-media-'));
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

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  mk('expo-file-system', {
    'package.json': JSON.stringify({
      name: 'expo-file-system',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js', './legacy': './legacy.js' },
    }),
    'index.js': `
const files = new Map();
const dirs = new Set(['file:///doc/']);
export const documentDirectory = 'file:///doc/';
export const __files = files;
export const __dirs = dirs;
export const __reset = () => { files.clear(); dirs.clear(); dirs.add('file:///doc/'); };
export async function getInfoAsync(p){
  if (dirs.has(p)) return { exists: true, isDirectory: true, size: 0 };
  if (files.has(p)) return { exists: true, isDirectory: false, size: files.get(p).size };
  return { exists: false };
}
export async function makeDirectoryAsync(p){ dirs.add(p); }
export async function readDirectoryAsync(p){
  const prefix = p.endsWith('/') ? p : p + '/';
  const out = new Set();
  for (const k of [...files.keys(), ...dirs]) {
    if (k.startsWith(prefix) && k !== p) {
      const rest = k.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (seg) out.add(seg);
    }
  }
  return [...out];
}
export async function copyAsync({ from, to }){
  const size = files.has(from) ? files.get(from).size : 100;
  const text = files.has(from) ? files.get(from).text : undefined;
  files.set(to, { size, text });
}
export async function writeAsStringAsync(p, content){
  files.set(p, { size: String(content).length, text: String(content) });
}
export async function readAsStringAsync(p){
  if (!files.has(p)) throw new Error('ENOENT: ' + p);
  const rec = files.get(p);
  return rec.text === undefined ? '' : rec.text;
}
export async function downloadAsync(url, to){
  if (globalThis.__DL_IMPL__) return globalThis.__DL_IMPL__(url, to);
  files.set(to, { size: 2048 });
  return { uri: to };
}
export async function deleteAsync(p){
  for (const k of [...files.keys()]) if (k === p || k.startsWith(p)) files.delete(k);
  for (const d of [...dirs]) if (d === p || d.startsWith(p)) dirs.delete(d);
}
export default { documentDirectory, getInfoAsync, makeDirectoryAsync, readDirectoryAsync, copyAsync, downloadAsync, deleteAsync };
`,
  });
  fs.writeFileSync(path.join(nm, 'expo-file-system', 'legacy.js'), `export * from './index.js';\n`);

  // P1.2 R6：mediaCache 已迁移为 TypeScript。按 .ts 优先、.js 兜底解析，
  // 使沙箱始终复制当前真实源码（迁移后为 .ts，Node 24 原生类型擦除执行）。
  const resolveSrc = (rel) => {
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  // 沙箱内 import 扩展名不一致（.js / .ts 混用），故 .ts 源同时落盘两份。
  const copy = (rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    if (actual.endsWith('.ts')) {
      const raw = fs.readFileSync(src, 'utf8');
      const out = ts.transpileModule(raw, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      fs.writeFileSync(path.join(dir, rel), out);
      fs.writeFileSync(path.join(dir, actual), raw);
      return;
    }
    fs.copyFileSync(src, path.join(dir, rel));
  };
  copy('src/services/mediaCache.js');
  copy('src/hooks/chat/useSignedMediaUrl.js');

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const supabase = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      single() { return Promise.resolve({ data: null, error: null }); },
    };
  },
  storage: {
    from() {
      return {
        createSignedUrl(p, ttl) {
          return globalThis.__SIGN_IMPL__ ? globalThis.__SIGN_IMPL__(p, ttl) : Promise.resolve({ data: { signedUrl: 'https://x/' + p }, error: null });
        },
      };
    },
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

// ---------------------------------------------------------------------------
// 沙箱 C：真实 useAuth 运行时（L4-R1 返工：AC-B5-12 / AC-B5-01 真实认证链路）
//
// 目的：旧 AC-B5-12 只做「源码正则 + 自写 decide()」，把 useAuth.js 换成纯注释
//       文件仍然 PASS（L4 负向变异已证明）。本沙箱真实执行 src/hooks/useAuth.js，
//       通过可控的 supabase.auth stub 派发真实 auth 事件（SIGNED_IN /
//       TOKEN_REFRESHED / SIGNED_OUT），断言真实 applySession 的行为。
//
// 真实性声明：
//   - ✅ 真实执行：src/hooks/useAuth.js 源码原样复制（含 applySession / bumpAuthEpoch）；
//   - ✅ 真实执行：useState/useEffect/useRef/useCallback/useMemo 走真实 Hook 运行时；
//   - ✅ 真实执行：setSignedUrlOwner / setProfileCacheOwner / setMediaCacheOwner 真实源码；
//   - ⚠️ 模拟：supabase.auth 为可控 stub，事件由测试通过 __emitAuth 派发。
// ---------------------------------------------------------------------------
function buildAuthSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-auth-'));
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

  // react stub：真实 Hook 运行时（与 buildHealthSandbox 同构，含 renderOnly/render）
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
    hooks, effects,
    renderOnly(fn) { idx = 0; effects.length = 0; ctx = runtime; return fn(); },
    render(fn) {
      let out;
      for (let round = 0; round < 20; round++) {
        idx = 0; effects.length = 0; ctx = runtime;
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
    unmount() { for (const e of effects) { if (e.cleanup) { try { e.cleanup(); } catch (_) {} } e.cleanup = null; } },
  };
  return runtime;
}
export function useState(init) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: typeof init === 'function' ? init() : init };
  const slot = rt.hooks[i];
  const setter = (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next; };
  return [slot.v, setter];
}
export function useRef(v) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { current: v };
  return rt.hooks[i];
}
export function useEffect(fn, deps) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps: undefined, prevDeps: undefined, cleanup: null };
  const slot = rt.hooks[i];
  slot.fn = fn; slot.deps = deps; rt.effects.push(slot);
}
export function useCallback(fn, deps) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.fn = fn; slot.deps = deps; }
  return slot.fn;
}
export function useMemo(fn, deps) {
  const rt = ctx; const i = idx++;
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

  // react-native stub（P0.3 iOS-01：useAuth 现在 import { AppState } 以驱动
  //   Supabase Auth 自动刷新生命周期。本沙箱不验证 AppState 行为，
  //   只需模块可解析、addEventListener 返回可 remove 的订阅。）
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const AppState = {
  currentState: 'active',
  addEventListener() { return { remove() {} }; },
};
export default { AppState };
`,
  });

  mk('expo-file-system', {
    'package.json': JSON.stringify({
      name: 'expo-file-system', version: '0.0.0', type: 'module', main: 'index.js',
      exports: { '.': './index.js', './legacy': './legacy.js' },
    }),
    'index.js': `
const files = new Map();
const dirs = new Set(['file:///doc/']);
export const documentDirectory = 'file:///doc/';
export const __files = files;
export const __dirs = dirs;
export async function getInfoAsync(p){
  if (dirs.has(p)) return { exists: true, isDirectory: true, size: 0 };
  if (files.has(p)) return { exists: true, isDirectory: false, size: files.get(p).size };
  return { exists: false };
}
export async function makeDirectoryAsync(p){ dirs.add(p); }
export async function readDirectoryAsync(p){ return []; }
export async function copyAsync(){}
export async function writeAsStringAsync(p, c){ files.set(p, { size: String(c).length, text: String(c) }); }
export async function readAsStringAsync(p){ return files.has(p) ? files.get(p).text : ''; }
export async function downloadAsync(url, to){ files.set(to, { size: 1 }); return { uri: to }; }
export async function deleteAsync(p){ files.delete(p); }
export default { documentDirectory, getInfoAsync, makeDirectoryAsync, readDirectoryAsync, copyAsync, downloadAsync, deleteAsync };
`,
  });
  fs.writeFileSync(path.join(nm, 'expo-file-system', 'legacy.js'), `export * from './index.js';\n`);

  // 真实源码复制：useAuth + 其依赖的下游 owner 登记模块
  // useAuth.js 含 JSX（<AuthContext.Provider>），必须 Babel 转译为 createElement，
  // 否则纯 Node ESM 无法解析。其余模块无 JSX，原样复制。
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const babel = requireFromRepo('@babel/core');
  // P1.2 R6：mediaCache 已迁移为 TypeScript。按 .ts 优先、.js 兜底解析。
  // P1.4 R2：useProfileCache 已迁移为 .ts，按 .ts 优先、.js 兜底解析。
  // P1.4 R3：useAuth 已迁移为 .tsx，按 .tsx / .ts 优先、.js 兜底解析。
  const resolveAuthSrc = (rel) => {
    const tsxRel = rel.replace(/\.js$/, '.tsx');
    if (fs.existsSync(path.join(repoRoot, tsxRel))) return tsxRel;
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  // P1.4 R3：沙箱内一律落盘为 .js（沙箱 import 路径固定为 './src/hooks/useAuth.js'），
  //   因此目标文件名必须由调用方显式指定，不能沿用源文件扩展名。
  const copy = (rel, transformJsx = false, dstRel = rel) => {
    const actual = resolveAuthSrc(rel);
    const src = path.join(repoRoot, actual);
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (transformJsx) {
      // P1.4 R3：useAuth 已迁移为 .tsx，需同时剥离 TypeScript 类型注解。
      //   对 .js 源保持原行为（仅 JSX 插件），不改变既有测试语义。
      const isTs = /\.tsx?$/.test(actual);
      const code = babel.transformSync(fs.readFileSync(src, 'utf8'), {
        presets: isTs ? ['@babel/preset-typescript'] : [],
        plugins: ['@babel/plugin-transform-react-jsx'],
        configFile: false,
        babelrc: false,
        filename: path.basename(actual),
      }).code;
      fs.writeFileSync(dst, code);
    } else if (actual.endsWith('.ts')) {
      // P1.4 R5：useSignedMediaUrl 已迁移为 .ts。沙箱 import 路径固定为 .js，
      //   因此必须转译为 .js 落盘（Node 24 原生类型擦除只对 .ts 扩展名生效，
      //   直接把 .ts 内容写入 .js 会触发 SyntaxError: Unexpected token ':'）。
      const out = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      fs.writeFileSync(dst, out);
    } else {
      fs.copyFileSync(src, dst);
    }
  };
  // 源为 .tsx，落盘为沙箱内的 .js（保持既有 import 路径不变）。
  copy('src/hooks/useAuth.js', true, 'src/hooks/useAuth.js');
  // P1.4 R3：useAuth.tsx 依赖身份转移决策纯逻辑模块，必须一并复制。
  copy('src/hooks/auth/identityTransitionLogic.ts');
  copy('src/hooks/chat/useSignedMediaUrl.js');
  // P1.4 R2：useProfileCache 已迁移为 .ts（含 `import type`），沙箱内必须落盘为 .ts，
  //   由 Node 24 原生类型擦除处理；若落盘为 .js 会触发 SyntaxError。
  copy('src/hooks/profile/useProfileCache.js', false, 'src/hooks/profile/useProfileCache.ts');
  // P1.2 R6：mediaCache 已迁移为 .ts，同理落盘为 .ts。
  copy('src/services/mediaCache.js', false, 'src/services/mediaCache.ts');
  // 🔄 P0.3 iOS-01：useAuth 现在 import authAutoRefresh 以驱动自动刷新生命周期。
  //    复制**真实实现**（非 stub），保证沙箱执行的是生产代码。
  //    P1.2 R5：源码已迁移为 TypeScript，沙箱按 .ts 落盘（Node 24 原生类型擦除）。
  copy('src/services/authAutoRefresh.ts');

  // supabase stub：可控 auth 事件 + 可注入 getSession
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  authListeners: [],
  sessionImpl: () => Promise.resolve({ data: { session: null }, error: null }),
  signOutImpl: () => Promise.resolve({ error: null }),
  profileUpdateImpl: () => Promise.resolve({ error: null }),
};
export const supabase = {
  __state: state,
  auth: {
    getSession() { return state.sessionImpl(); },
    onAuthStateChange(cb) {
      state.authListeners.push(cb);
      return { data: { subscription: { unsubscribe() {
        const i = state.authListeners.indexOf(cb);
        if (i >= 0) state.authListeners.splice(i, 1);
      } } } };
    },
    signOut() { return state.signOutImpl(); },
    signInWithPassword() { return Promise.resolve({ data: null, error: null }); },
    signUp() { return Promise.resolve({ data: null, error: null }); },
    // 🔄 P0.3 iOS-01：useAuth 通过 authAutoRefresh 控制器调用这两个方法。
    //    本沙箱不验证自动刷新行为，仅需方法存在且可 await。
    async startAutoRefresh() {},
    async stopAutoRefresh() {},
  },
  from() {
    const api = {
      update() { return api; },
      eq() { return state.profileUpdateImpl(); },
    };
    return api;
  },
  __emitAuth(event, session) {
    for (const cb of state.authListeners.slice()) cb(event, session);
  },
  __listenerCount() { return state.authListeners.length; },
};
export const authStorageStatus = { get: () => null };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
export const probeAuthStorage = async () => true;
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // P1.2 R5：authAutoRefresh 已迁移为 TypeScript，无扩展名相对导入需依次尝试 .js / .ts。
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}try{return await n(s+'/index.js',c);}catch{}return n(s,c);}`);
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
// 沙箱 D：真实 MealDetailSheet 组件级沙箱（L4-R1 返工：AC-B5-10）
//
// 目的：旧 AC-B5-10 只做「源码正则 + 手写状态机」，把 MealDetailSheet.js 换成
//       纯注释文件仍然 PASS（L4 负向变异已证明）。本沙箱真实执行组件源码：
//         · 用 Babel 把真实 MealDetailSheet.js 的 JSX 转译为 createElement；
//         · Animated 为可控 stub，start(cb) 只入队，由测试手动 __finish 触发；
//         · Modal/View/Text 为记录型桩，可读取真实 visible。
//       从而验证：正常关闭动画、切号当帧隐藏、旧关闭回调迟到、同账号新实例重开。
//
// 真实性声明：
//   - ✅ 真实执行：MealDetailSheet.js 源码原样复制，仅做 JSX→createElement 转译；
//   - ✅ 真实执行：useState/useEffect/useRef 走真实 Hook 运行时；
//   - ⚠️ 模拟：Animated 可控（完成回调由测试触发）；Modal 等为记录型桩。
// ---------------------------------------------------------------------------
function buildMealSheetSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b5-sheet-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

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
    hooks, effects,
    renderOnly(fn) { idx = 0; effects.length = 0; ctx = runtime; return fn(); },
    render(fn) {
      let out;
      for (let round = 0; round < 20; round++) {
        idx = 0; effects.length = 0; ctx = runtime;
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
    unmount() { for (const e of effects) { if (e.cleanup) { try { e.cleanup(); } catch (_) {} } e.cleanup = null; } },
  };
  return runtime;
}
export function useState(init) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: typeof init === 'function' ? init() : init };
  const slot = rt.hooks[i];
  const setter = (next) => { slot.v = typeof next === 'function' ? next(slot.v) : next; };
  return [slot.v, setter];
}
export function useRef(v) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { current: v };
  return rt.hooks[i];
}
export function useEffect(fn, deps) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps: undefined, prevDeps: undefined, cleanup: null };
  const slot = rt.hooks[i];
  slot.fn = fn; slot.deps = deps; rt.effects.push(slot);
}
export function useCallback(fn, deps) {
  const rt = ctx; const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.fn = fn; slot.deps = deps; }
  return slot.fn;
}
export function useMemo(fn, deps) {
  const rt = ctx; const i = idx++;
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

  // react-native stub：可控 Animated + 记录型基础组件
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __ANIM_QUEUE__ = [];
let __animSeq = 0;
class AnimatedValue {
  constructor(v) { this.__v = v; this.__id = ++__animSeq; }
  setValue(v) { this.__v = v; }
  interpolate() { return this; }
}
function makeAnimation(kind, cfg) {
  return { kind, cfg, start(cb) { __ANIM_QUEUE__.push({ kind, cfg, cb }); }, stop() {}, reset() {} };
}
export const Animated = {
  Value: AnimatedValue,
  spring: (val, cfg) => makeAnimation('spring', cfg),
  timing: (val, cfg) => makeAnimation('timing', cfg),
  parallel: (anims) => ({ kind: 'parallel', anims, start(cb) { __ANIM_QUEUE__.push({ kind: 'parallel', anims, cb }); }, stop() {} }),
  sequence: (anims) => ({ kind: 'sequence', anims, start(cb) { __ANIM_QUEUE__.push({ kind: 'sequence', anims, cb }); }, stop() {} }),
  View: 'Animated.View',
};
export const Modal = 'Modal';
export const View = 'View';
export const Text = 'Text';
export const Pressable = 'Pressable';
export const TouchableOpacity = 'TouchableOpacity';
export const StyleSheet = {
  create: (o) => o,
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
};
export const Platform = { OS: 'ios', select: (o) => (o.ios !== undefined ? o.ios : o.default) };
export function useColorScheme() { return 'light'; }
export default { Animated, Modal, View, Text, Pressable, TouchableOpacity, StyleSheet, Platform, useColorScheme };
`,
  });

  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export async function impactAsync() { (globalThis.__HAPTIC_LOG__ ||= []).push('impact'); }
export async function notificationAsync(t) { (globalThis.__HAPTIC_LOG__ ||= []).push('notify:' + t); }
export async function selectionAsync() {}
export default { ImpactFeedbackStyle, NotificationFeedbackType, impactAsync, notificationAsync, selectionAsync };
`,
  });

  // 真实常量（动画参数必须与生产一致）
  for (const rel of ['src/constants/motion.ts', 'src/constants/haptics.ts']) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  }

  // ThemeContext stub（useAppTheme 返回固定调色板，不参与生命周期断言）
  fs.mkdirSync(path.join(dir, 'src/context'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/context/ThemeContext.js'), `
export function useAppTheme() {
  return { colors: { card: '#fff', textPrimary: '#000', textSecondary: '#888', background: '#f5f5f5', primary: '#FF2D55' } };
}
export function ThemeProvider({ children }) { return children; }
`);

  // useHealthData stub（组件仅用 mealGuides）
  fs.mkdirSync(path.join(dir, 'src/hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/hooks/useHealthData.js'), `
export function useHealthData() {
  return { mealGuides: { '早餐': '规则A\\n要点1', '午餐': '规则B\\n要点2', '晚餐': '规则C\\n要点3' } };
}
export function HealthProvider({ children }) { return children; }
`);

  // 真实组件源码 + Babel JSX 转译
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const babel = requireFromRepo('@babel/core');
  const src = fs.readFileSync(path.join(repoRoot, 'src/components/MealDetailSheet.js'), 'utf8');
  const transformed = babel.transformSync(src, {
    plugins: ['@babel/plugin-transform-react-jsx'],
    configFile: false,
    babelrc: false,
    filename: 'MealDetailSheet.js',
  }).code;
  fs.mkdirSync(path.join(dir, 'src/components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/components/MealDetailSheet.js'), transformed);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}return n(s,c);}`);
  return dir;
}

// 组件级 harness：渲染真实 MealDetailSheet，暴露 Modal visible 与动画队列控制。
const MEAL_SHEET_HARNESS = String.raw`
const React = await import('react');
const RN = await import('react-native');
const { default: MealDetailSheet } = await import('./src/components/MealDetailSheet.js');

const rt = React.__createRuntime();
let __latestProps = null;
const __Comp = () => MealDetailSheet(__latestProps);

function renderSheet(props) { __latestProps = props; return rt.render(__Comp); }
// 只重渲染组件函数、不跑 effect —— 精确模拟「父组件已重渲染、effect 尚未执行」的一帧
function setPropsAndRenderOnly(props) { __latestProps = props; return rt.renderOnly(__Comp); }
// 跑完挂起 effect 后再渲染一次，读取 effect 生效后的真实树
function getEl() { return rt.render(__Comp); }
function renderNow() { return rt.renderOnly(__Comp); }

function findModalVisible(el) {
  if (!el || typeof el !== 'object') return undefined;
  if (el.type === 'Modal') return el.props.visible;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const v = findModalVisible(k); if (v !== undefined) return v; }
  return undefined;
}
function findModal(el) {
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'Modal') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = findModal(k); if (r) return r; }
  return null;
}
function finishAnim(idx, finished = true) {
  const item = RN.__ANIM_QUEUE__[idx];
  if (!item) throw new Error('no anim at index ' + idx);
  if (typeof item.cb === 'function') item.cb({ finished });
}
`;

// ---------------------------------------------------------------------------
// 沙箱 F：真实 useAuth × 真实 HealthProvider 组合沙箱（L4-R1 返工：AC-B5-01 / 08 / 11）
//
// 目的：旧 AC-B5-08 手动调用 subscribeAuthorization(PARTNER, () => clearPartner(...))，
//       只验证「手写回调组合」，无法证明 HealthProvider 真的接线正确。
//       本沙箱真实执行 useHealthData.js（HealthProvider），由 Provider 自身的
//       useEffect 建立 subscribePartner / subscribeAuthorization 订阅，
//       测试只通过 supabase.__emit 派发真实 Realtime 事件，验证：
//         · 授权撤销 → Provider 自动 clearPartner → 可见数据清空；
//         · 旧 channel 失效、迟到事件不写回；
//         · 重新授权后正常恢复；
//         · 前后台切换 / epoch 变化后订阅仍绑定当前身份。
//
// 真实性声明：
//   - ✅ 真实执行：useHealthData.js / useHealthCloud.js / useHealthStorage.js 等真实源码；
//   - ✅ 真实执行：Provider 的订阅 effect 真实建立/清理 channel；
//   - ⚠️ 模拟：supabase Realtime 为可控 stub（__emit 派发事件）；
//   - ⚠️ 模拟：AppState 为可控 stub（__emit 派发前后台事件）。
//
// 目的：旧 AC-B5-01 完全靠手动改 globalThis.__UID__ / __EPOCH__ 驱动身份切换，
//       无法证明「真实 auth 事件 → useAuth → HealthProvider」这条链路本身正确。
//       本沙箱把真实 useAuth.js（AuthProvider）与真实 useHealthData.js（HealthProvider）
//       组合起来，身份切换由可控 Supabase auth 事件（__emitAuth）驱动，而非手改全局。
//
// 真实性声明：
//   - ✅ 真实执行：useAuth.js / useHealthData.js / useHealthCloud.js / useHealthStorage.js
//      等源码原样复制（useAuth.js 与 useHealthData.js 仅做 JSX→createElement 转译）；
//   - ✅ 真实执行：AuthProvider 内部 getSession/onAuthStateChange 走真实逻辑；
//   - ⚠️ 模拟：Supabase 客户端为可控桩（auth 事件、channel、rpc、from 均可注入）。
// ---------------------------------------------------------------------------
function buildAuthHealthSandbox() {
  const dir = buildHealthSandbox();
  const nm = path.join(dir, 'node_modules');

  // 用真实 useAuth 源码覆盖 buildHealthSandbox 写入的 useAuth 桩。
  // P1.4 R3：源码已迁移为 useAuth.tsx（含 JSX），必须 Babel 转译为 createElement，
  // 并落盘为沙箱内的 src/hooks/useAuth.js（沙箱 import 路径不变）。
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const babel = requireFromRepo('@babel/core');
  const authSrc = path.join(repoRoot, 'src/hooks/useAuth.tsx');
  const authDst = path.join(dir, 'src/hooks/useAuth.js');
  const authCode = babel.transformSync(fs.readFileSync(authSrc, 'utf8'), {
    // P1.4 R3：源为 .tsx，需剥离 TypeScript 类型注解后再转译 JSX。
    presets: ['@babel/preset-typescript'],
    plugins: ['@babel/plugin-transform-react-jsx'],
    configFile: false,
    babelrc: false,
    filename: 'useAuth.tsx',
  }).code;
  fs.writeFileSync(authDst, authCode);
  // P1.4 R3：复制身份转移决策纯逻辑模块（useAuth.tsx 依赖）。
  {
    const logicSrc = path.join(repoRoot, 'src/hooks/auth/identityTransitionLogic.ts');
    const logicDst = path.join(dir, 'src/hooks/auth/identityTransitionLogic.ts');
    fs.mkdirSync(path.dirname(logicDst), { recursive: true });
    fs.copyFileSync(logicSrc, logicDst);
  }

  // 覆盖 react stub：在 buildHealthSandbox 的运行时基础上，增加「真实 Context 传播」能力。
  // 原因：真实 useAuth() = useContext(AuthContext)，而 HealthProvider 内部调用 useAuth()。
  //   原 stub 的 useContext 恒返回 {}，导致 HealthProvider 永远拿不到 AuthProvider 的 value。
  //   这里让 createContext 返回带 Provider 标记的对象，useContext 读取「最近一次 Provider 的 value」。
  //   测试通过 __setContextValue(ctx, value) 在渲染 HealthProvider 前注入 AuthProvider 的 value。
  const reactDir = path.join(nm, 'react');
  const baseReact = fs.readFileSync(path.join(reactDir, 'index.js'), 'utf8');
  // 替换 createContext / useContext 两行，并追加 __setContextValue 导出。
  const ctxReact = baseReact
    .replace(
      'export const createContext = (v) => ({ __ctx: v });',
      `const __ctxValues = new WeakMap();
export const createContext = (v) => { const c = { __ctx: v, __isContext: true }; c.Provider = { __isProvider: true, __context: c }; __ctxValues.set(c, v); return c; };
export function __setContextValue(c, v) { __ctxValues.set(c, v); }`
    )
    .replace(
      'export const useContext = () => ({});',
      `export function useContext(c) { return c && c.__isContext ? __ctxValues.get(c) : {}; }`
    );
  fs.writeFileSync(path.join(reactDir, 'index.js'), ctxReact);

  // useAuth.js 依赖的下游 owner 登记模块（真实源码原样复制）：
  //   · useSignedMediaUrl.js（setSignedUrlOwner）
  //   · mediaCache.js（setMediaCacheOwner，依赖 expo-file-system/legacy）
  // useProfileCache.js 已由 buildHealthSandbox 复制。
  // P1.2 R6：mediaCache 已迁移为 TypeScript。按 .ts 优先、.js 兜底解析。
  const resolveRawSrc = (rel) => {
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  // 沙箱内 import 扩展名不一致（.js / .ts 混用），故 .ts 源同时落盘两份。
  const copyRaw = (rel) => {
    const actual = resolveRawSrc(rel);
    const src = path.join(repoRoot, actual);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    if (actual.endsWith('.ts')) {
      const raw = fs.readFileSync(src, 'utf8');
      const out = ts.transpileModule(raw, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      fs.writeFileSync(path.join(dir, rel), out);
      fs.writeFileSync(path.join(dir, actual), raw);
      return;
    }
    fs.copyFileSync(src, path.join(dir, rel));
  };
  copyRaw('src/hooks/chat/useSignedMediaUrl.js');
  copyRaw('src/services/mediaCache.js');
  // 🔄 P0.3 iOS-01：真实 useAuth.js 现在 import authAutoRefresh 以驱动自动刷新生命周期。
  //    复制**真实实现**（非 stub），保证本沙箱执行的是生产代码。
  //    P1.2 R5：源码已迁移为 TypeScript，沙箱按 .ts 落盘（Node 24 原生类型擦除）。
  copyRaw('src/services/authAutoRefresh.ts');

  // react-native 桩（P0.3 iOS-01）：真实 useAuth.js 现在 import { AppState }。
  //   本沙箱的 AC-B5-08 / AC-B5-11 需要**真实派发**前后台事件（AppState.__emit），
  //   因此这里提供与 buildHealthSandbox 同构的可控 AppState（含 __emit / __listenerCount）。
  const rnDir = path.join(nm, 'react-native');
  fs.mkdirSync(rnDir, { recursive: true });
  fs.writeFileSync(path.join(rnDir, 'package.json'), JSON.stringify({
    name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js',
  }));
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

  // expo-file-system 桩（mediaCache.js 通过 expo-file-system/legacy 引入）。
  const efsDir = path.join(nm, 'expo-file-system');
  fs.mkdirSync(efsDir, { recursive: true });
  fs.writeFileSync(path.join(efsDir, 'package.json'), JSON.stringify({
    name: 'expo-file-system', version: '0.0.0', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './legacy': './legacy.js' },
  }));
  fs.writeFileSync(path.join(efsDir, 'index.js'), `
const files = new Map();
const dirs = new Set(['file:///doc/']);
export const documentDirectory = 'file:///doc/';
export const __files = files;
export const __dirs = dirs;
export async function getInfoAsync(p){
  if (dirs.has(p)) return { exists: true, isDirectory: true, size: 0 };
  if (files.has(p)) return { exists: true, isDirectory: false, size: files.get(p).size };
  return { exists: false };
}
export async function makeDirectoryAsync(p){ dirs.add(p); }
export async function readDirectoryAsync(p){ return []; }
export async function copyAsync(){}
export async function writeAsStringAsync(p, c){ files.set(p, { size: String(c).length, text: String(c) }); }
export async function readAsStringAsync(p){ return files.has(p) ? files.get(p).text : ''; }
export async function downloadAsync(url, to){ files.set(to, { size: 1 }); return { uri: to }; }
export async function deleteAsync(p){ files.delete(p); }
export default { documentDirectory, getInfoAsync, makeDirectoryAsync, readDirectoryAsync, copyAsync, downloadAsync, deleteAsync };
`);
  fs.writeFileSync(path.join(efsDir, 'legacy.js'), `export * from './index.js';\n`);

  // 用「同时支持 auth 事件 + health 通道/rpc/from」的 supabase 桩覆盖。
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  // auth
  authListeners: [],
  sessionImpl: () => Promise.resolve({ data: { session: null }, error: null }),
  signOutImpl: () => Promise.resolve({ error: null }),
  profileUpdateImpl: () => Promise.resolve({ error: null }),
  // health
  channels: [],
  rpcImpl: null,
  queryImpl: null,
  upsertImpl: null,
  upsertCalls: [],
  // 🛡️ L4-R2（R2-02）：RPC 调用归属日志。每次 rpc() 记录「调用时当前登录身份」，
  //    用于证明「B 会话确实执行了授权复验」而不是仅凭最终 partnerId === null 推断。
  rpcLog: [],
  // 🛡️ L4-R2（R2-02）：当前登录身份（由测试在派发 auth 事件时同步维护）。
  currentUserId: null,
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
  __reset() {
    state.channels.length = 0; state.rpcImpl = null; state.queryImpl = null;
    state.upsertImpl = null; state.upsertCalls.length = 0; state.rpcLog.length = 0;
    state.currentUserId = null;
  },
  __emit(channelName, payload) {
    const ch = state.channels.find((c) => c.name === channelName && !c.removed);
    if (!ch) return 0;
    let n = 0;
    for (const h of ch.handlers) { h.cb(payload); n += 1; }
    return n;
  },
  // 🛡️ L4-R2（R2-01）：捕获某个 channel 上真实注册的回调引用。
  //    与 __emit 不同，本方法**不检查 removed**，因此可在 channel 被移除后
  //    直接调用「SDK 已排队但迟到执行」的旧回调，真实检验生产代码的
  //    身份/代际闸门是否生效。返回回调数组（按注册顺序）。
  __captureHandlers(channelName) {
    const ch = state.channels.find((c) => c.name === channelName);
    if (!ch) return [];
    return ch.handlers.map((h) => h.cb);
  },
  // 🛡️ L4-R2（R2-01）：直接调用已捕获的旧回调（模拟 SDK 迟到执行）。
  //    返回实际被调用的回调数量。
  __invokeCaptured(callbacks, payload) {
    let n = 0;
    for (const cb of callbacks) { cb(payload); n += 1; }
    return n;
  },
  __liveChannels() { return state.channels.filter((c) => !c.removed); },
  channel(name) { return makeChannel(name); },
  getChannels() { return state.channels.filter((c) => !c.removed).map((c) => ({ topic: c.topic, __ref: c })); },
  removeChannel(chOrRef) {
    const target = chOrRef && chOrRef.__ref
      ? chOrRef.__ref
      : state.channels.find((c) => c.api === chOrRef)
        || state.channels.find((c) => c.topic === (chOrRef && chOrRef.topic));
    if (target) target.removed = true;
    return Promise.resolve('ok');
  },
  rpc(fn, args) {
    // 🛡️ L4-R2（R2-02）：记录调用归属（调用时当前登录身份 + 函数名 + 参数）。
    state.rpcLog.push({ fn, args: args ?? null, asUser: state.currentUserId });
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
      insert(row) {
        state.upsertCalls.push({ table, row, opts: { insert: true } });
        return Promise.resolve({ data: null, error: null });
      },
      update() { return api; },
      then(res, rej) {
        const p = state.queryImpl ? state.queryImpl(table, chain) : Promise.resolve({ data: null, error: null });
        return p.then(res, rej);
      },
    };
    return api;
  },
  auth: {
    getSession() { return state.sessionImpl(); },
    onAuthStateChange(cb) {
      state.authListeners.push(cb);
      return { data: { subscription: { unsubscribe() {
        const i = state.authListeners.indexOf(cb);
        if (i >= 0) state.authListeners.splice(i, 1);
      } } } };
    },
    signOut() { return state.signOutImpl(); },
    signInWithPassword() { return Promise.resolve({ data: null, error: null }); },
    signUp() { return Promise.resolve({ data: null, error: null }); },
    // 🔄 P0.3 iOS-01：真实 useAuth 通过 authAutoRefresh 控制器调用这两个方法。
    //    本沙箱不验证自动刷新行为，仅需方法存在且可 await。
    async startAutoRefresh() {},
    async stopAutoRefresh() {},
  },
  __emitAuth(event, session) {
    for (const cb of state.authListeners.slice()) cb(event, session);
  },
  __listenerCount() { return state.authListeners.length; },
};
export const authStorageStatus = { get: () => null };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
export const probeAuthStorage = async () => true;
`);
  return dir;
}

// ===========================================================================
// AC-B5-01（最关键组合）：A 离线改数据 → 切 B → B 正常使用 → 切回 A → 恢复
// ===========================================================================
test('AC-B5-01 A离线改数据→切B→B正常使用→切回A→网络恢复后A回填且B不受影响', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const B = 'user-bbb';
const DATE = formatDateStr(new Date());
const PEND_A = '@sync_health_pending_v1_' + A;
const PEND_B = '@sync_health_pending_v1_' + B;

supabase.__reset();
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'offline' } });
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });

// ── 进程 1：A 登录，离线改数据 ──
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 80));
rt1.render(Comp1);

ctx1.handleAddWater();
rt1.render(Comp1);
const aWaterAfterClick = ctx1.waterAmount;
await new Promise((r) => setTimeout(r, 700));
rt1.render(Comp1);

const pendARaw = await AS.getItem(PEND_A);
const pendA = pendARaw ? JSON.parse(pendARaw) : null;
const aPendingWater = pendA && pendA[DATE] ? pendA[DATE].water : null;
const aPendingOwner = pendA && pendA[DATE] ? pendA[DATE].ownerId : null;

// ── 切到 B ──
rt1.unmount();
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
const rt2 = React.__createRuntime();
let ctx2 = null;
const Comp2 = () => { const el = HealthProvider({ children: null }); ctx2 = el && el.props ? el.props.value : null; return null; };
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 80));
rt2.render(Comp2);

const bWaterBefore = ctx2.waterAmount;
ctx2.handleAddWater();
rt2.render(Comp2);
ctx2.handleAddWater();
rt2.render(Comp2);
ctx2.handleAddWater();
rt2.render(Comp2);
const bWaterAfter = ctx2.waterAmount;
await new Promise((r) => setTimeout(r, 700));
rt2.render(Comp2);

const pendBRaw = await AS.getItem(PEND_B);
const pendB = pendBRaw ? JSON.parse(pendBRaw) : null;
const bPendingWater = pendB && pendB[DATE] ? pendB[DATE].water : null;
const bPendingOwner = pendB && pendB[DATE] ? pendB[DATE].ownerId : null;

const pendAAfterB = await AS.getItem(PEND_A);
const pendAAfterBObj = pendAAfterB ? JSON.parse(pendAAfterB) : null;
const aPendingSurvivedB = pendAAfterBObj && pendAAfterBObj[DATE] ? pendAAfterBObj[DATE].water : null;

// 切回 A 之前快照 B 的磁盘 pending（此时网络仍为离线，B 的 pending 必须存在）
const pendBBeforeSwitch = await AS.getItem(PEND_B);
const pendBBeforeSwitchObj = pendBBeforeSwitch ? JSON.parse(pendBBeforeSwitch) : null;
const bPendingBeforeSwitchWater = pendBBeforeSwitchObj && pendBBeforeSwitchObj[DATE] ? pendBBeforeSwitchObj[DATE].water : null;

// ── 网络恢复 + 切回 A（新 epoch）──
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });
rt2.unmount();
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 2;
const rt3 = React.__createRuntime();
let ctx3 = null;
const Comp3 = () => { const el = HealthProvider({ children: null }); ctx3 = el && el.props ? el.props.value : null; return null; };
rt3.render(Comp3);
await new Promise((r) => setTimeout(r, 120));
rt3.render(Comp3);
await new Promise((r) => setTimeout(r, 900));
rt3.render(Comp3);

const upserts = supabase.__state.upsertCalls.map((c) => ({ uid: c.row.user_id, water: c.row.water_amount }));
const aRecovered = upserts.some((u) => u.uid === A && u.water === aWaterAfterClick);
const anyBWrittenAsA = upserts.some((u) => u.uid === A && u.water === bWaterAfter);
const pendAFinal = await AS.getItem(PEND_A);
const pendBFinal = await AS.getItem(PEND_B);
const pendBFinalObj = pendBFinal ? JSON.parse(pendBFinal) : null;
// B 的 pending 若在 A 恢复期间被清理，只允许是「以 B 身份成功提交」导致（合法），
// 绝不允许被 A 的恢复流程删除或以 A 身份提交。
const bFlushedAsB = upserts.some((u) => u.uid === B && u.water === bWaterAfter);
const bPendingGone = !(pendBFinalObj && pendBFinalObj[DATE]);
const bPendingRemovalLegit = !bPendingGone || bFlushedAsB;

process.stdout.write(JSON.stringify({
  aWaterAfterClick,
  aPendingWater, aPendingOwner,
  bWaterBefore, bWaterAfter, bPendingWater, bPendingOwner,
  aPendingSurvivedB,
  bPendingBeforeSwitchWater,
  aRecovered, anyBWrittenAsA,
  pendACleared: pendAFinal === null,
  bPendingGone, bFlushedAsB, bPendingRemovalLegit,
  bPendingFinalWater: pendBFinalObj && pendBFinalObj[DATE] ? pendBFinalObj[DATE].water : null,
  upserts,
}));
`);
    if (process.env.B5_DEBUG) console.error('AC-B5-01 OUT=' + JSON.stringify(out));
    assert.equal(out.aPendingOwner, 'user-aaa', 'A 的 pending ownerId 必须是 A');
    assert.equal(out.aPendingWater, out.aWaterAfterClick, 'A 的 pending 水量必须等于用户点击后的值');
    assert.equal(out.bPendingOwner, 'user-bbb', 'B 的 pending ownerId 必须是 B');
    assert.equal(out.bPendingWater, out.bWaterAfter, 'B 的 pending 水量必须等于 B 的操作结果');
    assert.equal(out.bWaterAfter, out.bWaterBefore + 3, 'B 的本地水量应正常累加 3');
    assert.equal(out.aPendingSurvivedB, out.aWaterAfterClick, 'A 的 pending 在 B 会话期间必须原封不动');
    assert.equal(out.bPendingBeforeSwitchWater, out.bWaterAfter, '切回 A 之前 B 的磁盘 pending 必须存在且为 B 的值');
    assert.equal(out.aRecovered, true, `切回 A 后必须补传 A 的离线数据，实际 upserts=${JSON.stringify(out.upserts)}`);
    assert.equal(out.anyBWrittenAsA, false, 'B 的数据绝不能被以 A 的身份提交');
    assert.equal(out.pendACleared, true, 'A 补传成功后 A 的磁盘 pending 应清理');
    assert.equal(out.bPendingRemovalLegit, true, 'B 的磁盘 pending 只允许因「以 B 身份成功提交」而清理，不得被 A 的恢复流程删除');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-01b：真实 auth 事件驱动的 A→B→A 身份切换（L4-R1 返工补强）
//
// L4-R1 要求：AC-B5-01 不能只靠手动改 globalThis.__UID__ / __EPOCH__ 驱动身份，
//   必须至少有一个场景由「真实 auth 事件 → 真实 useAuth → 真实 HealthProvider」
//   这条链路驱动，证明身份切换本身在真实接线中成立。
//
// 本用例：
//   · 组合真实 AuthProvider（useAuth.js）与真实 HealthProvider（useHealthData.js）；
//   · 身份切换完全由可控 Supabase auth 事件（__emitAuth）驱动，不触碰任何全局变量；
//   · 验证：A 登录后可见 A 的本地数据；切到 B 后 B 首帧不可见 A 数据且 B 可正常操作；
//     切回 A（新会话）后 A 的数据恢复可见，且 B 的数据不串入 A。
// ===========================================================================
test('AC-B5-01b 真实 auth 事件驱动 A→B→A 身份切换', () => {
  const dir = buildAuthHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { AuthProvider } = await import('./src/hooks/useAuth.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const B = 'user-bbb';
const DATE = formatDateStr(new Date());
const flush = () => new Promise((r) => setTimeout(r, 0));

supabase.__reset();
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

// 初始会话：A 已登录（getSession 返回 A）
const sessA1 = { user: { id: A }, access_token: 'tokA1' };
const sessB1 = { user: { id: B }, access_token: 'tokB1' };
const sessA2 = { user: { id: A }, access_token: 'tokA2' };
supabase.__state.sessionImpl = () => Promise.resolve({ data: { session: sessA1 }, error: null });

// 组合渲染：AuthProvider 包裹 HealthProvider，HealthProvider 内部调用真实 useAuth()。
// AuthProvider 返回 <AuthContext.Provider value={authValue}>；本 stub 下该元素为
// { type: AuthContext.Provider, props: { value } }。渲染 HealthProvider 前，把该 value
// 注入 AuthContext（__setContextValue），使 HealthProvider 内部的 useAuth() 读到真实身份。
const rt = React.__createRuntime();
let health = null;
const Root = () => {
  const authEl = AuthProvider({ children: null });
  const authValue = authEl && authEl.props ? authEl.props.value : null;
  const authCtx = authEl && authEl.type && authEl.type.__context ? authEl.type.__context : null;
  if (authCtx) React.__setContextValue(authCtx, authValue);
  const hEl = HealthProvider({ children: null });
  health = hEl && hEl.props ? hEl.props.value : null;
  return authEl;
};
rt.render(Root);
await flush();
rt.render(Root);
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);

// A 会话：本地加 2 杯水
health.handleAddWater();
rt.render(Root);
health.handleAddWater();
rt.render(Root);
const aWater = health.waterAmount;

// ── 真实 auth 事件切到 B ──
supabase.__emitAuth('SIGNED_IN', sessB1);
await flush();
// 执行 effect 并稳定（本地存储的跨账号隔离由 useHealthStorage 的会话代际 effect 完成，
// 其 fail-closed 首帧保证针对的是「搭子云端数据」而非本地水量，故此处只验证稳定后结果）
rt.render(Root);
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);
const bSettledWater = health.waterAmount;

// B 正常操作 +1
health.handleAddWater();
rt.render(Root);
const bAfterAdd = health.waterAmount;
await new Promise((r) => setTimeout(r, 700));
rt.render(Root);

// ── 真实 auth 事件切回 A（新 token → 新会话）──
supabase.__emitAuth('SIGNED_IN', sessA2);
await flush();
rt.render(Root);
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);
const aRecoveredWater = health.waterAmount;

process.stdout.write(JSON.stringify({
  aWater,
  bSettledWater,
  bAfterAdd,
  aRecoveredWater,
  listenerCount: supabase.__listenerCount(),
}));
`);
    if (process.env.B5_DEBUG) console.error('AC-B5-01b OUT=' + JSON.stringify(out));
    assert.ok(out.listenerCount >= 1, '必须真实注册 onAuthStateChange 监听器');
    assert.equal(out.aWater, 2, 'A 会话本地加 2 杯水应生效');
    assert.equal(out.bSettledWater, 0, '切到 B 稳定后不得残留 A 的本地水量');
    assert.equal(out.bAfterAdd, 1, 'B 稳定后正常操作必须恢复（不得永久锁死）');
    assert.equal(out.aRecoveredWater, 2, '切回 A 后 A 的本地数据必须恢复可见，且不被 B 的数据污染');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-02：身份切换首帧不得暴露旧账号私有数据（fail-closed 可见性）
//
// L4-R1 返工要点（旧实现为假阳性）：
//   旧测试用 rt.render(B, 1) 读取「切号后」的值。但 rt.render() 会先执行 effect
//   再重渲染，因此读到的是「effect 已清空之后」的帧，无法证明「首帧」安全。
//   L4 负向变异把 useHealthCloud 换成「首帧暴露旧数据、仅在 useEffect 里清空」的
//   不安全实现，旧测试仍然 PASS —— 证明力不足。
//
// 修复：用 rt.renderOnly() 精确读取「父组件已用新身份重渲染、effect 尚未执行」
//   的那一帧。真实实现通过 stateOwnerKey 掩码在**渲染期**即返回空数据，
//   因此 renderOnly 帧必须为空；而「仅靠 effect 清空」的不安全实现会在该帧
//   暴露旧数据 → 被本测试判为 FAIL。
//
// 断言：
//   1) A 视角可见自己的搭子数据（前置条件）；
//   2) 切到 B 的 renderOnly 首帧：partnerData 被掩码为 0、partnerId 为 null；
//   3) 随后执行 effect 并重渲染（render）：B 仍不可见 A 的数据（持续 fail-closed）。
// ===========================================================================
test('AC-B5-02 身份切换首帧不得暴露旧账号私有数据', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const PARTNER = 'partner-xxx';
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };
// 只重渲染、不执行 effect —— 精确模拟「身份已切换、effect 尚未跑」的首帧
const renderOnly = (user, epoch) => { api = rt.renderOnly(() => useHealthCloud(user, getDateStr, epoch)); return api; };

// A 建立搭子数据：使用真实公开 API applyPartnerRecord（等价于实时推送落库）
render(A, 1);
api.bindPartner(PARTNER);
render(A, 1);
api.applyPartnerRecord({ record_date: DATE, water_amount: 1234, meals_status: {} });
render(A, 1);
const aVisible = JSON.parse(JSON.stringify(api.partnerData));
const aPartnerId = api.partnerId;

// 切到 B：读取「首帧」（renderOnly，不跑 effect）
renderOnly(B, 1);
const bFirstFramePartnerData = JSON.parse(JSON.stringify(api.partnerData));
const bFirstFramePartnerId = api.partnerId;

// 随后执行 effect 并重渲染：B 仍不得看到 A 的数据（持续 fail-closed）
render(B, 1);
const bSettledPartnerData = JSON.parse(JSON.stringify(api.partnerData));
const bSettledPartnerId = api.partnerId;

process.stdout.write(JSON.stringify({
  aVisibleWater: aVisible.waterAmount,
  aPartnerId,
  bFirstFrameWater: bFirstFramePartnerData.waterAmount,
  bFirstFramePartnerId: bFirstFramePartnerId,
  bSettledWater: bSettledPartnerData.waterAmount,
  bSettledPartnerId: bSettledPartnerId,
}));
`);
    assert.equal(out.aVisibleWater, 1234, '前置条件：A 视角应看到自己的搭子数据');
    assert.equal(out.aPartnerId, 'partner-xxx', '前置条件：A 视角 partnerId 应为搭子');
    assert.equal(out.bFirstFrameWater, 0, '切到 B 的首帧（effect 未执行）不得暴露 A 的搭子数据');
    assert.equal(out.bFirstFramePartnerId, null, '切到 B 的首帧 partnerId 必须为 null');
    assert.equal(out.bSettledWater, 0, '切到 B 后（effect 已执行）仍不得暴露 A 的搭子数据');
    assert.equal(out.bSettledPartnerId, null, '切到 B 后 partnerId 必须保持 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-03：旧会话在途异步请求不得写入新会话状态（跨模块）
//
// 覆盖三条真实在途链路：
//   1) useHealthCloud.fetchPartnerRecord 的网络回包（epoch 闸门）
//   2) mediaCache.downloadToSandbox 的下载完成（身份闸门）
//   3) useSignedMediaUrl.getSignedUrl 的签名回包（代际闸门）
// 断言：三条链路在身份切换后完成，均不得把旧账号数据交给新会话。
// ===========================================================================
test('AC-B5-03 旧会话在途异步请求不得写入新会话状态（health/media/signedUrl）', () => {
  const healthDir = buildHealthSandbox();
  const mediaDir = buildMediaSandbox();
  try {
    const healthOut = runInSandbox(healthDir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const PARTNER = 'partner-xxx';
const DATE = '2026-11-19';
const getDateStr = () => DATE;

supabase.__reset();
const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

render(A, 1);
api.bindPartner(PARTNER);
render(A, 1);

// 缓存预置 500，网络请求挂起
const cacheKey = '@partner_health_' + PARTNER + '_' + DATE;
await AS.setItem(cacheKey, JSON.stringify({ waterAmount: 500, mealsStatus: {} }));
let releaseFetch;
supabase.__state.queryImpl = () => new Promise((res) => {
  releaseFetch = () => res({ data: { water_amount: 4242, meals_status: { '午餐': true } }, error: null });
});
const pendingFetch = api.fetchPartnerRecord(PARTNER, DATE);
await new Promise((r) => setTimeout(r, 5));

// 同账号新会话（epoch 1 → 2）
render(A, 2);
releaseFetch();
const fetchResult = await pendingFetch;
const afterStale = JSON.parse(JSON.stringify(api.partnerData));
const cacheAfter = await AS.getItem(cacheKey);

process.stdout.write(JSON.stringify({
  fetchResult,
  afterStaleWater: afterStale.waterAmount,
  cacheWater: cacheAfter ? JSON.parse(cacheAfter).waterAmount : null,
}));
`);
    assert.equal(healthOut.fetchResult, null, 'epoch 变化后 fetchPartnerRecord 必须返回 null');
    assert.equal(healthOut.afterStaleWater, 0, 'epoch 变化后迟到 fetch 结果不得写入 state');
    assert.equal(healthOut.cacheWater, 500, 'epoch 变化后迟到 fetch 结果不得覆盖本地缓存');

    const mediaOut = runInSandbox(mediaDir, `
const MC = await import('./src/services/mediaCache.ts');
const FS = await import('expo-file-system');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const M = await import('./src/hooks/chat/useSignedMediaUrl.js');

const A = 'user-aaa', B = 'user-bbb';
const MSG = '11111111-1111-4111-8111-111111111111';

// ── 链路 2：媒体下载在途时切号 ──
MC.setMediaCacheOwner(A);
let releaseDl;
globalThis.__DL_IMPL__ = (url, to) => new Promise((res) => {
  releaseDl = () => { FS.__files.set(to, { size: 4096 }); res({ uri: to }); };
});
const pendingDl = MC.downloadToSandbox('https://cdn/A-private.mp4', MSG, 'video');
await new Promise((r) => setTimeout(r, 10));
MC.setMediaCacheOwner(B);
releaseDl();
const dlResult = await pendingDl;
const memAfter = MC.getMemoryLocalMedia(MSG, 'video');
const idxRaw = await AS.getItem('@media_file_index');
const idx = idxRaw ? JSON.parse(idxRaw) : {};
const indexed = Object.prototype.hasOwnProperty.call(idx, 'video:' + MSG);

// ── 链路 3：签名请求在途时切号 ──
M.setSignedUrlOwner(A);
let releaseSign;
globalThis.__SIGN_IMPL__ = () => new Promise((res) => {
  releaseSign = () => res({ data: { signedUrl: 'https://cdn/LATE-A' }, error: null });
});
const pendingSign = M.getSignedUrl('user-aaa/late.jpg');
M.setSignedUrlOwner(B);
releaseSign();
const signResult = await pendingSign;
const signCacheAfter = M.getMemoryCachedSignedUrl('user-aaa/late.jpg');

process.stdout.write(JSON.stringify({ dlResult, memAfter, indexed, signResult, signCacheAfter }));
`);
    assert.equal(mediaOut.dlResult, null, '身份失效后完成的下载必须返回 null');
    assert.equal(mediaOut.memAfter, null, '身份失效后完成的下载不得进入内存索引');
    assert.equal(mediaOut.indexed, false, '身份失效后完成的下载不得写入持久化索引');
    assert.equal(mediaOut.signResult, null, '身份失效后完成的签名请求必须被代际校验拦截');
    assert.equal(mediaOut.signCacheAfter, null, '旧账号迟到签名结果不得写入新会话缓存');
  } finally {
    fs.rmSync(healthDir, { recursive: true, force: true });
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-04：新账号合法数据必须正常恢复（隔离不误伤）
//
// 断言：切到 B 后，B 自己的健康数据（本地磁盘 + 云端）能正常加载与显示，
//       且 B 的实时推送能正常写入 B 视角。
// ===========================================================================
test('AC-B5-04 新账号合法数据正常恢复（隔离不误伤）', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const B = 'user-bbb';
const DATE = formatDateStr(new Date());
const k = buildHealthKeys(B);

// B 的本地磁盘已有合法数据
await AS.setItem(k.water, '1500');
await AS.setItem(k.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(k.active, DATE);
await AS.setItem(k.maxWater, '2000');

supabase.__reset();
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
const rt = React.__createRuntime();
let ctx = null;
const Comp = () => { const el = HealthProvider({ children: null }); ctx = el && el.props ? el.props.value : null; return null; };
rt.render(Comp);
await new Promise((r) => setTimeout(r, 120));
rt.render(Comp);

const water = ctx.waterAmount;
const meals = JSON.parse(JSON.stringify(ctx.mealsStatus));

// B 正常喝水
ctx.handleAddWater();
rt.render(Comp);
const waterAfter = ctx.waterAmount;

process.stdout.write(JSON.stringify({ water, meals, waterAfter }));
`);
    assert.equal(out.water, 1500, 'B 的合法本地数据必须正常加载');
    assert.equal(out.meals['早餐'], true, 'B 的合法打卡状态必须正常加载');
    assert.equal(out.waterAfter, 1501, 'B 的正常喝水操作必须生效');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-05：存储 / 订阅 / Pending 异步状态最终收敛到正确身份
//
// 断言：A→B→A 多次切换后，最终所有异步状态（磁盘 pending、订阅 channel、
//       可见数据）都收敛到「当前身份 = A」，不残留 B 的任何状态。
// ===========================================================================
test('AC-B5-05 多次切号后异步状态最终收敛到当前身份', () => {
  const dir = buildHealthSandbox();
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
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

// A → B → A → B → A 多次切换。
//
// ⚠️ 关键设计：前几次会话「在线」（upsert 成功 → pending 立即 flush 并删除 key），
//    最后一次 A 会话「离线」（upsert 失败 → pending 落盘保留）。
//    这样才能验证「异步状态最终收敛到当前身份」：
//      - 在线会话的 pending 被合法 flush（key 被删除，属正常收敛，不是丢失）；
//      - 离线会话的 pending 必须落盘且 ownerId 严格等于当前身份；
//      - 跨账号 pending key 绝不互相污染（A 的 key 只含 A，B 的 key 只含 B）。
render(A, 1);
api.bindPartner('partner-a');
render(A, 1);
api.syncToCloud(1000, { '早餐': true });
await new Promise((r) => setTimeout(r, 100));

render(B, 1);
api.bindPartner('partner-b');
render(B, 1);
api.syncToCloud(2000, { '早餐': false });
await new Promise((r) => setTimeout(r, 100));

render(A, 2);
api.bindPartner('partner-a');
render(A, 2);
api.syncToCloud(3000, { '早餐': true });
await new Promise((r) => setTimeout(r, 100));

render(B, 2);
render(A, 3);
api.bindPartner('partner-a');
render(A, 3);
await new Promise((r) => setTimeout(r, 100));

// 最后一次 A 会话改为离线：upsert 失败 → A 的 pending 必须落盘保留。
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: { message: 'offline' } });
api.syncToCloud(4000, { '早餐': true });
await new Promise((r) => setTimeout(r, 100));

// 最终身份 = A(epoch 3)
//
// ⚠️ 归属身份 stateOwnerKey 是 useHealthCloud 的内部 state，**未对外导出**
//    （返回对象见 useHealthCloud.js:1035-1064，仅含 partnerData/partnerId/...）。
//    因此这里不直接读内部 state，而是断言「对外可观测的归属契约」：
//      ownerIsCurrent === true 时 partnerId 原样呈现、partnerData 不被遮蔽；
//      ownerIsCurrent === false 时 partnerId 被遮蔽为 null、partnerData 被遮蔽为 0。
//
// 🛡️ L4 R1 补强（AC-B5-05）：原断言只用 waterAmount === 0 作为「未被遮蔽」的证据，
//    但「空状态」与「错误遮蔽」都返回 0，证明力不足。
//    改为：先给最终身份 A 建立一个**非零合法搭子值 7333**（走真实 applyPartnerRecord
//    合法写入路径 → claimStateOwner 推进归属），再断言：
//      1) 7333 必须原样可见（证明当前身份数据未被遮蔽）；
//      2) 切到 B 后 7333 必须不可见（证明旧身份数据不会泄漏给新身份）。
const finalPartnerId = api.partnerId;
const finalPartnerData = JSON.parse(JSON.stringify(api.partnerData));

// 建立非零合法搭子值：applyPartnerRecord 是真实生产代码的合法写入入口。
//
// ⚠️ 时序要点：applyPartnerRecord 内部先 claimStateOwner() 再 setPartnerData()，
//    两者都是 setState，必须**再渲染一次**才能让归属身份与数据同时生效。
//    因此这里 render → 读值，而不是在调用后立刻读旧快照。
api.applyPartnerRecord({ water_amount: 7333, meals_status: { '早餐': true } });
render(A, 3);
const aVisiblePartnerWater = api.partnerData.waterAmount;
const aVisiblePartnerId = api.partnerId;

// 切到 B（新身份）：A 的 7333 必须不可见。
// 注意：身份切换 effect 会清空 partnerData，因此 B 侧读到的必然是「空」；
// 这里断言的是「A 的 7333 没有泄漏给 B」，而不是「B 自己有数据」。
render(B, 3);
const bVisiblePartnerWater = api.partnerData.waterAmount;
const bVisiblePartnerId = api.partnerId;

// 切回 A：7333 必须恢复可见（可恢复性，不是永久锁死）。
//
// ⚠️ 生产语义：切回 A 时身份切换 effect 会清空 partnerData（这是 fail-closed 的
//    正确行为，不是缺陷）。A 的搭子数据恢复依赖真实数据源重新写入：
//    fetchPartnerRecord（缓存优先 + 网络）或 Realtime applyPartnerRecord。
//    因此这里模拟「切回 A 后真实数据源返回 A 的搭子记录」——通过 applyPartnerRecord
//    合法写入路径恢复，再断言 7333 可见。这证明的是「归属身份已推进到 A::3，
//    合法写入不再被遮蔽」，而非「内存残留自动复活」。
//
// ⚠️ 关键：applyPartnerRecord 的 claimStateOwner() 读取的是 userRef.current /
//    authEpochRef.current，而这两个 ref 由 useEffect 同步。因此必须先 render(A,3)
//    让 ref 追上 A::3，再调用 applyPartnerRecord，最后再 render 一次让 setState 生效。
render(A, 3);
api.applyPartnerRecord({ water_amount: 7333, meals_status: { '早餐': true } });
render(A, 3);
const aRecoveredPartnerWater = api.partnerData.waterAmount;

const pendA = await AS.getItem('@sync_health_pending_v1_user-aaa');
const pendB = await AS.getItem('@sync_health_pending_v1_user-bbb');
const aObj = pendA ? JSON.parse(pendA) : null;
const bObj = pendB ? JSON.parse(pendB) : null;

// 跨账号污染检测：A 的 key 内所有条目 ownerId 必须都是 A；B 同理。
const aOwners = aObj ? Object.values(aObj).map((e) => e.ownerId) : [];
const bOwners = bObj ? Object.values(bObj).map((e) => e.ownerId) : [];
const aPolluted = aOwners.some((o) => o !== 'user-aaa');
const bPolluted = bOwners.some((o) => o !== 'user-bbb');

process.stdout.write(JSON.stringify({
  finalPartnerId,
  finalPartnerWater: finalPartnerData.waterAmount,
  aVisiblePartnerWater,
  aVisiblePartnerId,
  bVisiblePartnerWater,
  bVisiblePartnerId,
  aRecoveredPartnerWater,
  aPendingWater: aObj && aObj[DATE] ? aObj[DATE].water : null,
  aPendingOwner: aObj && aObj[DATE] ? aObj[DATE].ownerId : null,
  bPendingWater: bObj && bObj[DATE] ? bObj[DATE].water : null,
  bPendingOwner: bObj && bObj[DATE] ? bObj[DATE].ownerId : null,
  aPolluted,
  bPolluted,
}));
`);
    assert.equal(out.finalPartnerId, 'partner-a', '最终身份 A 的 partnerId 必须收敛到 A 的搭子（未被遮蔽）');
    // 🛡️ L4 R1：非零合法值 7333 必须原样可见（空状态与错误遮蔽都返回 0，故不能用 0 作证据）。
    assert.equal(out.aVisiblePartnerWater, 7333, '最终身份 A 的非零合法搭子值 7333 必须原样可见（未被遮蔽）');
    assert.equal(out.aVisiblePartnerId, 'partner-a', '最终身份 A 的 partnerId 必须原样可见');
    // 🛡️ L4 R1：切到 B 后 A 的 7333 必须不可见（旧身份数据不得泄漏）。
    assert.equal(out.bVisiblePartnerWater, 0, '切到 B 后 A 的 7333 必须不可见（旧身份数据不得泄漏）');
    assert.equal(out.bVisiblePartnerId, null, '切到 B 后 A 的 partnerId 必须被遮蔽为 null');
    // 🛡️ L4 R1：切回 A 后 7333 必须恢复可见（可恢复性）。
    assert.equal(out.aRecoveredPartnerWater, 7333, '切回 A 后 7333 必须恢复可见（不是永久锁死）');
    assert.equal(out.aPendingOwner, 'user-aaa', 'A 的离线 pending ownerId 必须是 A');
    assert.equal(out.aPendingWater, 4000, 'A 的离线 pending 必须是最后一次 A 会话写入的值');
    assert.equal(out.aPolluted, false, 'A 的 pending key 内不得混入其他账号条目');
    assert.equal(out.bPolluted, false, 'B 的 pending key 内不得混入其他账号条目');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-06：fail-closed 不得造成永久空白或永久失联（可恢复性）
//
// 场景：切号瞬间身份失效 → 所有写入被 fail-closed 拒绝；
//       但新身份稳定后，正常操作必须恢复（不是永久锁死）。
// ===========================================================================
test('AC-B5-06 fail-closed 后新身份稳定时正常操作可恢复', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const B = 'user-bbb';
const DATE = formatDateStr(new Date());

supabase.__reset();
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

// A 会话
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const rt1 = React.__createRuntime();
let ctx1 = null;
const Comp1 = () => { const el = HealthProvider({ children: null }); ctx1 = el && el.props ? el.props.value : null; return null; };
rt1.render(Comp1);
await new Promise((r) => setTimeout(r, 100));
rt1.render(Comp1);
const aWater = ctx1.waterAmount;

// 切到 B（新会话）
rt1.unmount();
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
const rt2 = React.__createRuntime();
let ctx2 = null;
const Comp2 = () => { const el = HealthProvider({ children: null }); ctx2 = el && el.props ? el.props.value : null; return null; };
rt2.render(Comp2);
await new Promise((r) => setTimeout(r, 100));
rt2.render(Comp2);

// B 首帧不得是 A 的数据（fail-closed）
const bFirstWater = ctx2.waterAmount;

// B 稳定后正常操作必须恢复
ctx2.handleAddWater();
rt2.render(Comp2);
const bAfterAdd = ctx2.waterAmount;
await new Promise((r) => setTimeout(r, 700));
rt2.render(Comp2);

const pendB = await AS.getItem('@sync_health_pending_v1_' + B);
const bObj = pendB ? JSON.parse(pendB) : null;

process.stdout.write(JSON.stringify({
  aWater,
  bFirstWater,
  bAfterAdd,
  bPendingWater: bObj && bObj[DATE] ? bObj[DATE].water : null,
}));
`);
    assert.equal(out.aWater, 0, '前置条件：A 初始水量为 0');
    assert.equal(out.bFirstWater, 0, 'B 首帧不得显示 A 的数据（fail-closed）');
    assert.equal(out.bAfterAdd, 1, 'B 稳定后正常操作必须恢复（不得永久锁死）');
    assert.equal(out.bPendingWater, 1, 'B 的操作必须正常落盘（不得永久失联）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-07：媒体缓存跨账号不可读 + 同账号重登合法复用（B2 × B1 组合）
// ===========================================================================
test('AC-B5-07 媒体缓存跨账号不可读且同账号重登可复用', () => {
  const dir = buildMediaSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.ts');
const FS = await import('expo-file-system');
const M = await import('./src/hooks/chat/useSignedMediaUrl.js');

const A = 'user-aaa', B = 'user-bbb';
const MSG = '11111111-1111-4111-8111-111111111111';

// A 落盘一张私有图片
MC.setMediaCacheOwner(A);
FS.__files.set('file:///tmp/a.jpg', { size: 500 });
const persistedA = await MC.persistMedia('file:///tmp/a.jpg', MSG, 'image');
const aResolve = await MC.resolveLocalMedia(MSG, 'image');

// 切到 B：B 不得读到 A 的私有媒体
MC.setMediaCacheOwner(B);
const bResolve = await MC.resolveLocalMedia(MSG, 'image');
const bMem = MC.getMemoryLocalMedia(MSG, 'image');

// 同账号重登（forceBump）：合法缓存必须仍可复用
MC.setMediaCacheOwner(A, true);
const aResolveAgain = await MC.resolveLocalMedia(MSG, 'image');

// 签名 URL 层同样隔离
M.setSignedUrlOwner(A);
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://cdn/' + p }, error: null });
const urlA = await M.getSignedUrl('user-aaa/a.jpg');
M.setSignedUrlOwner(B);
const memB = M.getMemoryCachedSignedUrl('user-aaa/a.jpg');

process.stdout.write(JSON.stringify({
  persistedA, aResolve, bResolve, bMem, aResolveAgain, urlA, memB,
}));
`);
    assert.ok(out.persistedA, 'A 的媒体应成功落盘');
    assert.equal(out.aResolve, out.persistedA, 'A 应能解析到自己的媒体');
    assert.equal(out.bResolve, null, 'B 不得解析到 A 的私有媒体');
    assert.equal(out.bMem, null, 'B 不得命中 A 的媒体内存索引');
    assert.equal(out.aResolveAgain, out.persistedA, '同账号重登后合法缓存必须仍可复用');
    assert.ok(out.urlA, 'A 的签名 URL 应正常生成');
    assert.equal(out.memB, null, 'B 不得命中 A 的签名 URL 缓存');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-08：搭子授权撤销后可见数据清空且订阅失效（B3 × B4 组合）
//
// L4-R1 返工要点（旧实现为假阳性）：
//   旧测试手动调用 subscribeAuthorization(PARTNER, () => api.clearPartner(...))，
//   只验证「手写回调组合」，无法证明 HealthProvider 真的把订阅接线正确。
//   L4 负向变异把 useHealthCloud 的订阅 effect 破坏后，旧测试仍然 PASS。
//
// 修复：改用 buildProviderSandbox()，真实执行 useHealthData.js（HealthProvider）。
//   Provider 自身的 useEffect 建立 subscribePartner / subscribeAuthorization；
//   测试只通过 supabase.__emit 派发真实 Realtime 事件，验证：
//     1) 授权有效时，搭子健康实时事件可见（前置条件）；
//     2) 授权撤销（服务端 get_active_partner_id 返回 null）→ Provider 自动
//        clearPartner → 可见数据清空、partnerId 为 null；
//     3) 撤销后旧搭子的迟到实时事件不得写回；
//     4) 重新授权（服务端再次返回同一搭子）→ 数据正常恢复。
//
// 真实性声明：
//   - ✅ 真实执行：useHealthData.js / useHealthCloud.js / useHealthStorage.js 等源码；
//   - ✅ 真实执行：Provider 订阅 effect 真实建立/清理 channel；
//   - ⚠️ 模拟：supabase Realtime 为可控 stub（__emit 派发事件）。
// ===========================================================================
test('AC-B5-08 搭子授权撤销后可见数据清空且旧订阅失效', () => {
  const dir = buildAuthHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const PARTNER = 'partner-xxx';
const DATE = formatDateStr(new Date());
const flush = () => new Promise((r) => setTimeout(r, 0));

supabase.__reset();
// 初始：A 已登录，服务端权威确认存在有效搭子 PARTNER。
// loadAllData 会 rpc('get_active_partner_id') → bindPartner(PARTNER) →
// fetchPartnerRecord → applyPartnerRecord，并触发 Provider 的订阅 effect。
supabase.__state.sessionImpl = () => Promise.resolve({ data: { session: { user: { id: A }, access_token: 'tokA1' } }, error: null });
let activePartner = PARTNER;
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_active_partner_id') return Promise.resolve({ data: activePartner, error: null });
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

// 组合渲染：AuthProvider 包裹 HealthProvider（与 AC-B5-01b 同款真实接线）。
const { AuthProvider } = await import('./src/hooks/useAuth.js');
const rt = React.__createRuntime();
let health = null;
const Root = () => {
  const authEl = AuthProvider({ children: null });
  const authValue = authEl && authEl.props ? authEl.props.value : null;
  const authCtx = authEl && authEl.type && authEl.type.__context ? authEl.type.__context : null;
  if (authCtx) React.__setContextValue(authCtx, authValue);
  const hEl = HealthProvider({ children: null });
  health = hEl && hEl.props ? hEl.props.value : null;
  return authEl;
};
rt.render(Root);
await flush();
rt.render(Root);
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);

// 前置条件：Provider 已绑定搭子并建立订阅。
const partnerIdBound = health.partnerId;
const partnerCh = supabase.__liveChannels().map((c) => c.name).find((n) => n.startsWith('partner_health_'));
const authCh = supabase.__liveChannels().map((c) => c.name).find((n) => n.startsWith('partner_auth_'));

// 1) 授权有效：搭子健康实时事件可见
supabase.__emit(partnerCh, { new: { record_date: DATE, water_amount: 1800, meals_status: {} } });
rt.render(Root);
const beforeRevokeWater = health.partnerData.waterAmount;

// 🛡️ L4-R2（R2-01）：在撤销**之前**捕获 Provider 真实注册在旧 channel 上的回调引用。
//    旧实现用 __emit(partnerCh) 派发，但 channel 被移除后 __emit 直接返回 0，
//    回调根本没执行 —— 等于「什么都没验证」。这里捕获真实回调，撤销后直接调用，
//    模拟「SDK 已把事件排入队列、在 channel 清理之后才迟到执行」的真实场景。
const capturedPartnerCbs = supabase.__captureHandlers(partnerCh);
const capturedCount = capturedPartnerCbs.length;

// 2) 授权撤销：服务端 get_active_partner_id 返回 null，派发授权 UPDATE 事件。
//    Provider 的 subscribeAuthorization 回调会向服务端复验 → 确认失效 →
//    调用真实 onRevoked（clearPartner + setProfile）。
activePartner = null;
supabase.__emit(authCh, { new: { requester_id: PARTNER, addressee_id: A, status: 'revoked' } });
await new Promise((r) => setTimeout(r, 60));
rt.render(Root);
const afterRevokeWater = health.partnerData.waterAmount;
const partnerIdAfter = health.partnerId;
// 撤销后旧 channel 必须已被移除（保留原有清理断言）
const oldChannelStillLive = supabase.__liveChannels().some((c) => c.name === partnerCh);

// 3) 撤销后旧搭子的迟到实时事件不得写回。
//    🛡️ L4-R2（R2-01）：直接调用**捕获的真实旧回调**（channel 已移除，__emit 无效）。
const lateInvoked = supabase.__invokeCaptured(capturedPartnerCbs, { new: { record_date: DATE, water_amount: 9999, meals_status: {} } });
rt.render(Root);
const afterLateEventWater = health.partnerData.waterAmount;
const partnerIdAfterLate = health.partnerId;

// 4) 重新授权：服务端再次返回同一搭子。
//    真实恢复路径 = App 切回前台（AppState 'active'）→ Provider 的 AppState effect
//    复验 get_active_partner_id → bindPartner(PARTNER) + fetchPartnerRecord + applyPartnerRecord。
//    这里派发真实 AppState 'active' 事件驱动该链路（而非无效的重复 render）。
activePartner = PARTNER;
const { AppState } = await import('react-native');
AppState.__emit('active');
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);
const partnerIdRecovered = health.partnerId;
// 重新授权后 Provider 必须重建搭子健康订阅 channel；用其派发实时事件验证数据可见。
const partnerCh2 = supabase.__liveChannels().map((c) => c.name).find((n) => n.startsWith('partner_health_'));
supabase.__emit(partnerCh2, { new: { record_date: DATE, water_amount: 2500, meals_status: {} } });
rt.render(Root);
const recoveredWater = health.partnerData.waterAmount;

process.stdout.write(JSON.stringify({
  partnerIdBound,
  hasPartnerCh: !!partnerCh,
  hasAuthCh: !!authCh,
  beforeRevokeWater,
  capturedCount,
  afterRevokeWater,
  partnerIdAfter,
  oldChannelStillLive,
  lateInvoked,
  afterLateEventWater,
  partnerIdAfterLate,
  recoveredWater,
  partnerIdRecovered,
}));
`);
    assert.equal(out.partnerIdBound, 'partner-xxx', '前置条件：Provider 必须真实绑定搭子');
    assert.equal(out.hasPartnerCh, true, 'Provider 必须真实建立搭子健康订阅 channel');
    assert.equal(out.hasAuthCh, true, 'Provider 必须真实建立授权订阅 channel');
    assert.equal(out.beforeRevokeWater, 1800, '前置条件：撤销前应能看到搭子实时数据');
    // 🛡️ L4-R2（R2-01）：必须真实捕获到 Provider 注册的回调，否则「迟到回调」验证无意义
    assert.ok(out.capturedCount >= 1, 'R2-01：必须捕获到 Provider 真实注册的搭子健康回调');
    assert.equal(out.afterRevokeWater, 0, '授权撤销后 Provider 必须自动清空可见搭子数据');
    assert.equal(out.partnerIdAfter, null, '授权撤销后 partnerId 必须为 null');
    assert.equal(out.oldChannelStillLive, false, '撤销后旧搭子健康 channel 必须已被移除');
    // 🛡️ L4-R2（R2-01）：真实调用了旧回调（不是 __emit 空转）
    assert.equal(out.lateInvoked, out.capturedCount, 'R2-01：必须真实调用捕获的旧回调（模拟 SDK 迟到执行）');
    assert.equal(out.afterLateEventWater, 0, '撤销后旧搭子的迟到实时事件不得写回');
    assert.equal(out.partnerIdAfterLate, null, '撤销后旧回调不得复活 partnerId');
    assert.equal(out.recoveredWater, 2500, '重新授权后搭子数据必须正常恢复');
    assert.equal(out.partnerIdRecovered, 'partner-xxx', '重新授权后 partnerId 必须恢复');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-09：正常喝水 / 打卡 / 撤销打卡链路不回归（B4 × UI 契约）
// ===========================================================================
test('AC-B5-09 正常喝水/打卡/撤销打卡链路不回归', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');

const A = 'user-aaa';
const DATE = formatDateStr(new Date());

supabase.__reset();
supabase.__state.rpcImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
const rt = React.__createRuntime();
let ctx = null;
const Comp = () => { const el = HealthProvider({ children: null }); ctx = el && el.props ? el.props.value : null; return null; };
rt.render(Comp);
await new Promise((r) => setTimeout(r, 100));
rt.render(Comp);

// 喝水 +1 / -1
const w0 = ctx.waterAmount;
ctx.handleAddWater();
rt.render(Comp);
const w1 = ctx.waterAmount;
ctx.handleMinusWater();
rt.render(Comp);
const w2 = ctx.waterAmount;

// 打开餐食详情 → 打卡 → 撤销
// 注意：对外暴露的 selectedMeal 是「餐次名字符串」（visibleSelectedMeal），
//       不是内部 { meal, ownerKey, selectionId } 对象。
ctx.openMeal('早餐');
rt.render(Comp);
const openedMeal = ctx.selectedMeal;
const ownerKey = ctx.selectedMealOwnerKey;
await ctx.confirmCheck();
rt.render(Comp);
const afterCheck = JSON.parse(JSON.stringify(ctx.mealsStatus));
const modalClosedAfterCheck = ctx.selectedMeal === null;

ctx.openMeal('早餐');
rt.render(Comp);
await ctx.undoCheck();
rt.render(Comp);
const afterUndo = JSON.parse(JSON.stringify(ctx.mealsStatus));

process.stdout.write(JSON.stringify({
  w0, w1, w2,
  openedMeal, ownerKey,
  afterCheckBreakfast: afterCheck['早餐'],
  modalClosedAfterCheck,
  afterUndoBreakfast: afterUndo['早餐'],
}));
`);
    assert.equal(out.w1, out.w0 + 1, '喝水 +1 必须生效');
    assert.equal(out.w2, out.w0, '喝水 -1 必须生效');
    assert.equal(out.openedMeal, '早餐', '打开餐食详情必须正确设置 selectedMeal');
    assert.equal(out.ownerKey, 'user-aaa::1', 'selectedMealOwnerKey 必须绑定当前身份');
    assert.equal(out.afterCheckBreakfast, true, '打卡后早餐状态必须为 true');
    assert.equal(out.modalClosedAfterCheck, true, '打卡成功后 Modal 必须关闭');
    assert.equal(out.afterUndoBreakfast, false, '撤销打卡后早餐状态必须为 false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-10：Modal 退出动画与旧动画回调隔离（真实组件级执行）
//
// L4-R1 返工要点（旧实现为假阳性）：
//   旧测试只做「源码正则 + 手写状态机」，把 MealDetailSheet.js 换成纯注释文件
//   仍然 PASS（L4 负向变异已证明）。证明力不足。
//
// 修复：真实执行 MealDetailSheet.js 组件源码（Babel 仅做 JSX→createElement 转译），
//   Animated 为可控 stub（start(cb) 只入队，由测试手动 finishAnim 触发完成回调），
//   Modal 为记录型桩（可读取真实 visible）。四个场景全部基于真实组件行为：
//     1) 正常关闭：动画期间 Modal 保持可见，finishAnim 后隐藏并回调 onClose；
//     2) 切号当帧：sessionOwnerKey 变化 → 该帧 Modal 立即隐藏（不等动画）；
//     3) 旧关闭回调迟到：切号后旧动画完成回调不得关闭新会话 Modal；
//     4) 同账号新实例重开：selectionId 变化后旧关闭标记失效，新实例正常可见。
// ===========================================================================
test('AC-B5-10 Modal 退出动画与旧动画回调隔离（真实组件级执行）', () => {
  const dir = buildMealSheetSandbox();
  try {
    const out = runInSandbox(dir, MEAL_SHEET_HARNESS + `
const A_KEY = 'user-aaa::1';
const B_KEY = 'user-bbb::1';
const baseProps = (over) => ({
  meal: '早餐',
  sessionOwnerKey: A_KEY,
  selectionId: 1,
  checked: false,
  onClose: () => {},
  onConfirm: () => {},
  onUndo: () => {},
  ...over,
});

// ── 场景 1：正常关闭 —— 动画期间保持可见，完成后隐藏并回调 onClose ──
let closeCalls = 0;
renderSheet(baseProps({ onClose: () => { closeCalls += 1; } }));
const s1OpenVisible = findModalVisible(getEl());
const animsBeforeClose = RN.__ANIM_QUEUE__.length;
const el1 = getEl();
// 触发真实 handleClose（通过 Modal.onRequestClose，等价用户点击关闭）
const modal1 = findModal(el1);
modal1.props.onRequestClose();
const s1ClosingVisible = findModalVisible(renderNow());
// 完成关闭动画（队列中最后一个 parallel）
const closeAnimIdx = RN.__ANIM_QUEUE__.length - 1;
const s1AnimQueued = closeAnimIdx >= animsBeforeClose;
finishAnim(closeAnimIdx, true);
const s1AfterFinishVisible = findModalVisible(getEl());
const s1CloseCalls = closeCalls;

// ── 场景 2：切号当帧 —— sessionOwnerKey 变化，Modal 立即隐藏 ──
// ⚠️ 必须用「新的 selectionId」打开 A 会话：场景 1 结束后 lastOpenRef 仍为
//    {meal:'早餐', selectionId:1}（关闭路径不清空它），若此处复用 selectionId=1，
//    组件会判定「非新打开」而不显示 Modal，导致前置条件不成立。selectionId=10
//    代表一个真实的新选择实例，语义上就是一次全新打开。
const s2OpenVisible = findModalVisible(renderSheet(baseProps({ selectionId: 10, onClose: () => {} })));
// 真实 Provider 契约（useHealthData.js:82-84）：
//   currentOwnerKey = user.id + '::' + authEpoch
//   visibleSelectedMeal = selectedMeal.ownerKey === currentOwnerKey ? selectedMeal.meal : null
// 切号当帧 currentOwnerKey 变为 B，而 selectedMeal.ownerKey 仍是 A → visibleSelectedMeal
// 在同一渲染帧即变为 null → 传给组件的 meal 为 null。这正是「不等 effect/动画、当帧隐藏」
// 的真实机制（FINAL-04）。因此切号帧必须传 meal:null（Provider 已把选中态门控为 null），
// 而不是继续传旧 meal 字符串。
const s2SwitchFrameVisible = findModalVisible(setPropsAndRenderOnly(baseProps({ meal: null, sessionOwnerKey: B_KEY, selectionId: null })));
// 执行 effect 后仍不可见
const s2SettledVisible = findModalVisible(getEl());

// ── 场景 3：旧关闭回调迟到 —— 切号后旧动画完成不得关闭新会话 Modal ──
let lateCloseCalls = 0;
renderSheet(baseProps({ onClose: () => { lateCloseCalls += 1; } }));
const el3 = getEl();
const modal3 = findModal(el3);
modal3.props.onRequestClose(); // 启动 A 的关闭动画
const lateAnimIdx = RN.__ANIM_QUEUE__.length - 1;
// 期间切到 B 并打开新实例（openToken 推进）
renderSheet(baseProps({ sessionOwnerKey: B_KEY, selectionId: 2, onClose: () => { lateCloseCalls += 1; } }));
const s3NewOpenVisible = findModalVisible(getEl());
// 旧关闭动画迟到完成
finishAnim(lateAnimIdx, true);
const s3AfterLateVisible = findModalVisible(getEl());
const s3LateCloseCalls = lateCloseCalls;

// ── 场景 4：同账号新实例重开 —— selectionId 变化，旧关闭标记失效 ──
renderSheet(baseProps({ selectionId: 1, onClose: () => {} }));
const el4 = getEl();
findModal(el4).props.onRequestClose(); // 启动关闭动画（selectionId=1）
const reopenAnimIdx = RN.__ANIM_QUEUE__.length - 1;
// 同账号新实例（selectionId=2）打开
renderSheet(baseProps({ selectionId: 2, onClose: () => {} }));
const s4ReopenVisible = findModalVisible(getEl());
// 旧实例关闭动画迟到完成，不得关闭新实例
finishAnim(reopenAnimIdx, true);
const s4AfterLateVisible = findModalVisible(getEl());

process.stdout.write(JSON.stringify({
  s1OpenVisible, s1ClosingVisible, s1AnimQueued, s1AfterFinishVisible, s1CloseCalls,
  s2OpenVisible, s2SwitchFrameVisible, s2SettledVisible,
  s3NewOpenVisible, s3AfterLateVisible, s3LateCloseCalls,
  s4ReopenVisible, s4AfterLateVisible,
}));
`);
    if (process.env.B5_DEBUG) console.error('AC-B5-10 OUT=' + JSON.stringify(out));
    // 场景 1：正常关闭
    assert.equal(out.s1OpenVisible, true, '打开后 Modal 必须可见');
    assert.equal(out.s1ClosingVisible, true, '正常关闭动画期间 Modal 必须保持可见（退出动画完整）');
    assert.equal(out.s1AnimQueued, true, '关闭必须启动退出动画');
    assert.equal(out.s1AfterFinishVisible, false, '关闭动画完成后 Modal 必须隐藏');
    assert.equal(out.s1CloseCalls, 1, '关闭动画完成后必须回调 onClose 一次');
    // 场景 2：切号当帧隐藏
    assert.equal(out.s2OpenVisible, true, '前置条件：A 会话 Modal 可见');
    assert.equal(out.s2SwitchFrameVisible, false, '切号当帧 Modal 必须立即隐藏（不等 effect/动画）');
    assert.equal(out.s2SettledVisible, false, '切号后 Modal 必须保持隐藏');
    // 场景 3：旧关闭回调迟到
    assert.equal(out.s3NewOpenVisible, true, '切号后新会话 Modal 必须可见');
    assert.equal(out.s3AfterLateVisible, true, '旧关闭动画迟到完成不得关闭新会话 Modal');
    assert.equal(out.s3LateCloseCalls, 0, '旧关闭动画迟到完成不得触发新会话 onClose');
    // 场景 4：同账号新实例重开
    assert.equal(out.s4ReopenVisible, true, '同账号新实例打开后 Modal 必须可见');
    assert.equal(out.s4AfterLateVisible, true, '旧实例关闭动画迟到完成不得关闭新实例 Modal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-11：Realtime 断线重连 / 前后台切换后订阅仍绑定当前身份
//
// L4-R1 返工要点（旧实现证明力不足）：
//   旧测试直接渲染 useHealthCloud，且用无证明力的 `assert.ok(appStateListeners >= 0)`。
//   但 useHealthCloud 本身不监听 AppState —— AppState 复验逻辑在 useHealthData 的
//   Provider 层。因此旧测试根本没有覆盖「前后台切换 → Provider 复验 → 订阅重建」链路。
//
// 修复：使用真实 Provider（buildAuthHealthSandbox：真实 useAuth + 真实 HealthProvider），
//   通过真实 AppState 事件驱动 Provider 的 AppState effect，验证：
//     1) 前后台切换后订阅仍绑定当前身份，正常实时推送仍生效；
//     2) 前后台切换不产生重复存活的搭子健康 channel（去重，恰好 1 条）；
//     3) 切号后旧 channel 被移除、旧订阅迟到事件被丢弃（不复活）；
//     4) AppState 监听器真实注册（>=1），删除无证明力断言。
//
// 覆盖边界（诚实记录）：本沙箱无法模拟 Supabase SDK 内部的 WebSocket 断线重连
//   （SDK 层自动重连、心跳、退避重试）。此处验证的是「应用层在前后台切换/身份变化
//   时对订阅生命周期的正确管理」。SDK 层真实断线重连列入真机验收清单。
// ===========================================================================
test('AC-B5-11 前后台切换后订阅仍绑定当前身份且旧订阅不复活', () => {
  const dir = buildAuthHealthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { AuthProvider } = await import('./src/hooks/useAuth.js');
const { formatDateStr } = await import('./src/hooks/health/dateUtils.ts');
const { AppState } = await import('react-native');

const A = 'user-aaa';
const B = 'user-bbb';
const PARTNER = 'partner-xxx';
const PARTNER_B = 'partner-bbb';
const DATE = formatDateStr(new Date());
const flush = () => new Promise((r) => setTimeout(r, 0));

supabase.__reset();
supabase.__state.sessionImpl = () => Promise.resolve({ data: { session: { user: { id: A }, access_token: 'tokA1' } }, error: null });

// 🛡️ L4-R2（R2-02）：**按当前登录身份区分的服务端权威行为**。
//    旧实现 rpcImpl 恒返回 PARTNER，与「切到 B 后 B 无搭子」的断言自相矛盾。
//    现在服务端按 supabase.__state.currentUserId 返回该身份的真实搭子：
//      · A → PARTNER（A 有合法搭子）
//      · B → null（B 无搭子，阶段一）
//      · B → PARTNER_B（B 有自己的合法搭子，阶段二）
//    这样「B 无搭子」不再是测试凭空假设，而是服务端权威返回的结果。
const partnerByUser = { [A]: PARTNER, [B]: null };
supabase.__state.currentUserId = A;
supabase.__state.rpcImpl = (fn) => {
  if (fn === 'get_active_partner_id') {
    const who = supabase.__state.currentUserId;
    return Promise.resolve({ data: partnerByUser[who] ?? null, error: null });
  }
  return Promise.resolve({ data: null, error: null });
};
supabase.__state.queryImpl = () => Promise.resolve({ data: null, error: null });
supabase.__state.upsertImpl = () => Promise.resolve({ data: null, error: null });

const rt = React.__createRuntime();
let health = null;
const Root = () => {
  const authEl = AuthProvider({ children: null });
  const authValue = authEl && authEl.props ? authEl.props.value : null;
  const authCtx = authEl && authEl.type && authEl.type.__context ? authEl.type.__context : null;
  if (authCtx) React.__setContextValue(authCtx, authValue);
  const hEl = HealthProvider({ children: null });
  health = hEl && hEl.props ? hEl.props.value : null;
  return authEl;
};
const partnerChannels = () => supabase.__liveChannels().map((c) => c.name).filter((n) => n.startsWith('partner_health_'));
// 🛡️ L4-R2（R2-02）：派发 auth 事件时同步维护「服务端看到的当前身份」，
//    使 rpcImpl 能按真实身份返回权威结果（而非恒返回 A 的搭子）。
const signInAs = (uid, token) => {
  supabase.__state.currentUserId = uid;
  supabase.__emitAuth('SIGNED_IN', { user: { id: uid }, access_token: token });
};

rt.render(Root);
await flush();
rt.render(Root);
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);

// 前置条件：已绑定搭子并建立订阅
const partnerIdBound = health.partnerId;
const chBefore = partnerChannels();
const chName = chBefore[0];
// 🛡️ L4-R2（R2-01）：切号前捕获 Provider 真实注册在 A 的搭子健康 channel 上的回调。
const capturedOldCbs = supabase.__captureHandlers(chName);
const capturedOldCount = capturedOldCbs.length;

// 1) 后台 → 前台（真实 AppState 事件）：Provider 复验授权，订阅仍绑定当前身份
AppState.__emit('background');
AppState.__emit('active');
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);
const partnerIdAfterForeground = health.partnerId;
const chAfterForeground = partnerChannels();

// 前台后正常实时推送仍生效
supabase.__emit(chAfterForeground[0], { new: { record_date: DATE, water_amount: 1600, meals_status: {} } });
rt.render(Root);
const afterForegroundWater = health.partnerData.waterAmount;

// 2) 切号 A → B（真实 auth 事件）：旧 channel 必须被移除，旧订阅迟到事件丢弃
const rpcLogBeforeSwitch = supabase.__state.rpcLog.length;
signInAs(B, 'tokB1');
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);
const partnerIdAfterSwitch = health.partnerId;
const chAfterSwitch = partnerChannels();
const oldChannelStillLive = chAfterSwitch.includes(chName);

// 🛡️ L4-R2（R2-01）：直接调用**捕获的 A 旧回调**（channel 已移除，__emit 无效），
//    模拟 SDK 已排队但迟到执行的事件。B 会话不得被 A 的旧数据污染。
const staleInvoked = supabase.__invokeCaptured(capturedOldCbs, { new: { record_date: DATE, water_amount: 9999, meals_status: {} } });
rt.render(Root);
const afterStaleEventWater = health.partnerData.waterAmount;
const partnerIdAfterStale = health.partnerId;

// 3) 阶段二：B 拥有自己的合法搭子 → 必须正常显示 B 的数据（不被安全闸门永久遮蔽）
partnerByUser[B] = PARTNER_B;
AppState.__emit('background');
AppState.__emit('active');
await new Promise((r) => setTimeout(r, 120));
rt.render(Root);
const partnerIdBRecovered = health.partnerId;
const bChannels = partnerChannels();
// B 的新订阅必须能正常接收实时事件
if (bChannels.length > 0) {
  supabase.__emit(bChannels[0], { new: { record_date: DATE, water_amount: 700, meals_status: {} } });
  rt.render(Root);
}
const bWater = health.partnerData.waterAmount;

// 🛡️ L4-R2（R2-02）：切号后必须存在「以 B 身份发起的 get_active_partner_id 复验」，
//    证明 B 会话确实执行了授权恢复/复验流程，而不是仅凭最终 partnerId===null 推断。
//    注意：切号瞬间的清理 effect 只清空 partnerId，真正的授权复验发生在
//    切号后的 loadAllData / AppState active 路径（阶段一 + 阶段二均以 B 身份执行）。
//    因此这里统计「切号之后、以 B 身份」的全部 get_active_partner_id 调用。
const rpcAfterSwitch = supabase.__state.rpcLog.slice(rpcLogBeforeSwitch);
const bVerifyCalls = rpcAfterSwitch.filter((r) => r.fn === 'get_active_partner_id' && r.asUser === B).length;

process.stdout.write(JSON.stringify({
  partnerIdBound,
  chBeforeCount: chBefore.length,
  capturedOldCount,
  partnerIdAfterForeground,
  chAfterForegroundCount: chAfterForeground.length,
  afterForegroundWater,
  partnerIdAfterSwitch,
  oldChannelStillLive,
  bVerifyCalls,
  staleInvoked,
  afterStaleEventWater,
  partnerIdAfterStale,
  partnerIdBRecovered,
  bChannelCount: bChannels.length,
  bWater,
  appStateListeners: AppState.__listenerCount(),
}));
`);
    // 前置条件
    assert.equal(out.partnerIdBound, 'partner-xxx', '前置条件：Provider 必须真实绑定搭子');
    assert.equal(out.chBeforeCount, 1, '前置条件：应恰好建立 1 条搭子健康订阅 channel');
    assert.ok(out.capturedOldCount >= 1, 'R2-01：必须捕获到 A 会话真实注册的搭子健康回调');
    // 1) 前后台切换后订阅仍绑定当前身份，且不产生重复 channel
    assert.equal(out.partnerIdAfterForeground, 'partner-xxx', '前后台切换后 partnerId 必须仍为当前搭子');
    assert.equal(out.chAfterForegroundCount, 1, '前后台切换后搭子健康 channel 必须恰好 1 条（不重复订阅）');
    assert.equal(out.afterForegroundWater, 1600, '前后台切换后正常实时推送必须仍生效');
    // 2) 切号后旧 channel 失效、旧订阅迟到事件丢弃
    assert.equal(out.partnerIdAfterSwitch, null, '切号后 partnerId 必须清空（服务端权威返回 B 无搭子）');
    assert.equal(out.oldChannelStillLive, false, '切号后旧搭子健康 channel 必须被移除');
    // 🛡️ L4-R2（R2-02）：B 会话必须真实执行过授权复验（RPC 归属证据）
    assert.ok(out.bVerifyCalls >= 1, 'R2-02：切号后必须以 B 身份真实执行 get_active_partner_id 复验');
    // 🛡️ L4-R2（R2-01）：真实调用了 A 的旧回调，且 B 不受影响
    assert.equal(out.staleInvoked, out.capturedOldCount, 'R2-01：必须真实调用捕获的 A 旧回调（模拟 SDK 迟到执行）');
    assert.equal(out.afterStaleEventWater, 0, '切号后 A 旧回调迟到事件不得写回 B 会话');
    assert.equal(out.partnerIdAfterStale, null, '切号后 A 旧回调不得复活 partnerId');
    // 3) B 拥有自己的合法搭子时必须正常显示（不被安全闸门永久遮蔽）
    assert.equal(out.partnerIdBRecovered, 'partner-bbb', 'R2-02：B 拥有自己的搭子时必须正常绑定');
    assert.ok(out.bChannelCount >= 1, 'R2-02：B 绑定自己的搭子后必须建立订阅 channel');
    assert.equal(out.bWater, 700, 'R2-02：B 自己的搭子实时数据必须正常显示');
    // 4) AppState 监听器真实注册（删除无证明力断言）
    assert.ok(out.appStateListeners >= 1, 'Provider 必须真实注册 AppState 监听器');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// AC-B5-12：同账号 token 刷新（TOKEN_REFRESHED）不得误伤在途合法请求
//
// L4-R1 返工要点（旧实现为假阳性）：
//   旧测试只做「源码正则 + 手写 decide()」，把 useAuth.js 换成纯注释文件仍然
//   PASS（L4 负向变异已证明）。证明力不足。
//
// 修复：真实执行 useAuth.js 的 AuthProvider（Babel 仅做 JSX→createElement 转译），
//   通过 supabase stub 的 __emitAuth 派发可控 auth 事件，读取真实 value.authEpoch：
//     1) 初始 getSession(null→A)：ownerChanged → epoch 0→1；
//     2) TOKEN_REFRESHED（同 owner、token 变化）：不得推进 epoch（CR-06 核心）；
//     3) SIGNED_IN（同 owner、token 变化）：tokenRotated → epoch +1（真实重登）；
//     4) SIGNED_IN（不同 owner）：ownerChanged → epoch +1 且 user.id 更新（切号）；
//     5) 切号后当前会话的 TOKEN_REFRESHED：不得推进 epoch（在途请求不被误伤）。
// ===========================================================================
test('AC-B5-12 TOKEN_REFRESHED 不推进 authEpoch（真实 useAuth 运行时）', () => {
  const dir = buildAuthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { AuthProvider } = await import('./src/hooks/useAuth.js');

const rt = React.__createRuntime();
let el = null;
const render = () => { el = rt.render(() => AuthProvider({})); return el.props.value; };
const flush = () => new Promise((r) => setTimeout(r, 0));

const sessA1 = { user: { id: 'user-aaa' }, access_token: 'tok1' };
const sessA2 = { user: { id: 'user-aaa' }, access_token: 'tok2' };
const sessA3 = { user: { id: 'user-aaa' }, access_token: 'tok3' };
const sessB1 = { user: { id: 'user-bbb' }, access_token: 'tokB1' };
const sessB2 = { user: { id: 'user-bbb' }, access_token: 'tokB2' };

// 初始会话：getSession 返回 A(tok1)
supabase.__state.sessionImpl = () => Promise.resolve({ data: { session: sessA1 }, error: null });
let v = render();
await flush();
v = render();
const epochAfterInit = v.authEpoch;      // null→A：ownerChanged → 1
const userAfterInit = v.user && v.user.id;

// ① TOKEN_REFRESHED（同 owner、token 变化）→ 不得推进 epoch
supabase.__emitAuth('TOKEN_REFRESHED', sessA2);
await flush();
v = render();
const epochAfterRefresh = v.authEpoch;

// ② SIGNED_IN（同 owner、token 变化）→ tokenRotated → epoch +1
supabase.__emitAuth('SIGNED_IN', sessA3);
await flush();
v = render();
const epochAfterRelogin = v.authEpoch;

// ③ SIGNED_IN（不同 owner）→ ownerChanged → epoch +1 且 user.id 更新
supabase.__emitAuth('SIGNED_IN', sessB1);
await flush();
v = render();
const epochAfterSwitch = v.authEpoch;
const userAfterSwitch = v.user && v.user.id;

// ④ 切号后当前会话（B）的 TOKEN_REFRESHED → 不得推进 epoch（在途请求不被误伤）
supabase.__emitAuth('TOKEN_REFRESHED', sessB2);
await flush();
v = render();
const epochAfterBRefresh = v.authEpoch;

// ===========================================================================
// ⑤ 🛡️ L4-R2（R2-03）：**旧 auth 会话的迟到异步回调隔离**。
//
//    场景（真实可控 Promise）：
//      1) 初始 getSession() 返回一个**挂起**的 Promise（代表旧 A 会话的恢复请求）；
//      2) 挂起期间，通过真实 onAuthStateChange 派发 B 的合法登录事件；
//      3) B 成为当前身份；
//      4) 旧 A 的 getSession() Promise 此刻才完成（resolve 出 A 的会话）；
//      5) 断言 B 的 user.id / authEpoch 不被旧结果回滚。
//
//    这是「旧会话异步结果迟到」的真实路径，而非顺序派发事件。
// ===========================================================================
const rt2 = React.__createRuntime();
let el2 = null;
const render2 = () => { el2 = rt2.render(() => AuthProvider({})); return el2.props.value; };

// 挂起控制器：手动决定 getSession 何时完成
let resolveOldSession = null;
const oldSessionPromise = new Promise((res) => { resolveOldSession = res; });
supabase.__state.sessionImpl = () => oldSessionPromise;

// 首帧：getSession 尚未完成（挂起中）
let v2 = render2();
await flush();
v2 = render2();
const epochBeforeOldResolve = v2.authEpoch;
const userBeforeOldResolve = v2.user && v2.user.id;

// 挂起期间：B 通过真实 auth 事件登录，成为当前身份
supabase.__emitAuth('SIGNED_IN', sessB1);
await flush();
v2 = render2();
const epochAfterBLogin = v2.authEpoch;
const userAfterBLogin = v2.user && v2.user.id;

// 旧 A 的 getSession 此刻才完成（迟到 resolve）
resolveOldSession({ data: { session: sessA1 }, error: null });
await flush();
await flush();
v2 = render2();
const epochAfterOldResolve = v2.authEpoch;
const userAfterOldResolve = v2.user && v2.user.id;

process.stdout.write(JSON.stringify({
  epochAfterInit, userAfterInit,
  epochAfterRefresh,
  epochAfterRelogin,
  epochAfterSwitch, userAfterSwitch,
  epochAfterBRefresh,
  epochBeforeOldResolve, userBeforeOldResolve,
  epochAfterBLogin, userAfterBLogin,
  epochAfterOldResolve, userAfterOldResolve,
  listenerCount: supabase.__listenerCount(),
}));
`);
    if (process.env.B5_DEBUG) console.error('AC-B5-12 OUT=' + JSON.stringify(out));
    // 初始：null→A 视为身份转移，epoch 0→1
    assert.equal(out.epochAfterInit, 1, '初始会话 null→A 必须推进 epoch 至 1');
    assert.equal(out.userAfterInit, 'user-aaa', '初始会话必须正确设置 user.id');
    // ① TOKEN_REFRESHED 不得推进 epoch（CR-06 核心）
    assert.equal(out.epochAfterRefresh, out.epochAfterInit, 'TOKEN_REFRESHED 不得推进 authEpoch');
    // ② 同账号真实重登（SIGNED_IN + token 变化）必须推进 epoch
    assert.equal(out.epochAfterRelogin, out.epochAfterRefresh + 1, '同账号真实重登必须推进 authEpoch');
    // ③ 切号必须推进 epoch 且更新身份
    assert.equal(out.epochAfterSwitch, out.epochAfterRelogin + 1, '切号必须推进 authEpoch');
    assert.equal(out.userAfterSwitch, 'user-bbb', '切号后 user.id 必须更新为 B');
    // ④ 切号后当前会话的 TOKEN_REFRESHED 不得推进 epoch
    assert.equal(out.epochAfterBRefresh, out.epochAfterSwitch, '切号后当前会话 TOKEN_REFRESHED 不得推进 authEpoch');
    // ⑤ 🛡️ L4-R2（R2-03）：旧 A 会话迟到 resolve 不得回滚 B
    assert.equal(out.userBeforeOldResolve, null, 'R2-03 前置：getSession 挂起期间尚无用户');
    assert.equal(out.userAfterBLogin, 'user-bbb', 'R2-03 前置：B 登录后当前身份必须为 B');
    assert.equal(out.userAfterOldResolve, 'user-bbb', 'R2-03：旧 A 会话迟到 resolve 不得把 user.id 回滚为 A');
    assert.equal(out.epochAfterOldResolve, out.epochAfterBLogin, 'R2-03：旧 A 会话迟到 resolve 不得推进/回滚 authEpoch');
    // 监听器必须真实注册（证明走的是真实 onAuthStateChange 链路）
    assert.ok(out.listenerCount >= 1, '必须真实注册 onAuthStateChange 监听器');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- END OF FILE tests/security/b5P03Integration.test.mjs ---

test('L4-FINAL-VERIFY retrySession delayed A must not roll back newer B login', () => {
  const dir = buildAuthSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { AuthProvider } = await import('./src/hooks/useAuth.js');
const rt = React.__createRuntime();
let val;
const render = () => { val = rt.render(() => AuthProvider({})).props.value; return val; };
const flush = () => new Promise(r => setTimeout(r, 0));
const a = { user: { id: 'user-aaa' }, access_token: 'tokA1' };
const b = { user: { id: 'user-bbb' }, access_token: 'tokB1' };
supabase.__state.sessionImpl = () => Promise.resolve({data:{session:a},error:null});
render(); await flush(); render();
const initialUser = val.user?.id;
let resolveRetry;
const pending = new Promise(res => { resolveRetry = res; });
supabase.__state.sessionImpl = () => pending;
const retry = val.retrySession(); // Starts before B logs in, hangs returning A's stale session
supabase.__emitAuth('SIGNED_IN', b);
render();
const before = { user: val.user?.id, epoch: val.authEpoch };
resolveRetry({data:{session:a},error:null});
await retry; await flush(); render();
process.stdout.write(JSON.stringify({initialUser,before,after:{user:val.user?.id,epoch:val.authEpoch}}));
`);
    console.error('L4 RETRY ACTUAL:', JSON.stringify(out));
    assert.equal(out.initialUser, 'user-aaa');
    assert.equal(out.before.user, 'user-bbb');
    assert.equal(out.after.user, 'user-bbb', 'stale retrySession result must not roll back newer B login');
    assert.equal(out.after.epoch, out.before.epoch, 'stale retry must not bump epoch');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

// Independent L4 negative probe: authentication event supersedes pending getSession even if epoch didn't bump.
test('L4-FINAL-VERIFY SIGNED_OUT while no owner must invalidate delayed initial A session', () => {
  const dir = buildAuthSandbox();
  try {
    const out=runInSandbox(dir, `
const React=await import('react');
const {supabase}=await import('./src/services/supabase.js');
const {AuthProvider}=await import('./src/hooks/useAuth.js');
const rt=React.__createRuntime();
const render=()=>rt.render(()=>AuthProvider({})).props.value;
const flush=()=>new Promise(r=>setTimeout(r,0));
let resolveInit; const init=new Promise(res=>{resolveInit=res;});
supabase.__state.sessionImpl=()=>init;
let v=render();
supabase.__emitAuth('SIGNED_OUT', null); // Valid newer explicit auth event, no owner/epoch change
v=render();const before={user:v.user?.id??null, epoch:v.authEpoch};
resolveInit({data:{session:{user:{id:'user-aaa'},access_token:'oldA'}},error:null});
await flush();await flush();v=render();
process.stdout.write(JSON.stringify({before,after:{user:v.user?.id??null,epoch:v.authEpoch}}));
`);
    console.error('L4 SIGNED_OUT ACTUAL:',JSON.stringify(out));
    assert.equal(out.before.user,null);
    assert.equal(out.after.user,null,'newer SIGNED_OUT must take precedence over delayed stale init getSession');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
