// --- START OF FILE tests/security/p14r7MigrationEquivalence.test.mjs ---
/**
 * P1.4 R7 — Work B：本轮 5 个模块 TypeScript 迁移的**新旧真实执行等价**验证
 *
 * 覆盖模块（冻结 JS 基线 vs 当前 TS 源码）
 *   M1  src/hooks/useAccountSwitcher.ts        （本地多账号档案 / L-4 邮箱脱敏 / LRU）
 *   M2  src/hooks/chat/useChatFavorites.ts     （聊天收藏本地持久化）
 *   M3  src/hooks/chat/useMediaUpload.ts       （cleanStoragePath / createSignedMediaUrl / uploadToSupabase）
 *   M4  src/hooks/chat/useAudioRecorder.ts     （buildAudioMode / 录音状态机）
 *   M5  src/hooks/usePushNotifications.ts      （Token 注册成功后置位 / 点击跳转）
 *
 * 机制
 *   · 与 R6 / R7-WorkA 等价测试同构：自定义 Hook 运行时 + ts.transpileModule + 子进程沙箱。
 *   · 冻结基线只读（启动时校验 SHA-256）。
 *   · 不访问真实网络 / 数据库 / 真实用户数据。
 *   · 每个模块至少一条「故障注入」用例：在隔离副本里把实现改回一个**错误写法**，
 *     证明本文件的断言确实能检出差异（不是无条件通过）。
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r7/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 冻结基线完整性
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__useAccountSwitcher.js':
    'a356df4480d99f2fa797b3599b00c105d313eb9ceaae33b99e9a48d77d1b6217',
  'hooks__chat__useChatFavorites.js':
    '4b74f692be9a2f27984e4266e502d4da44cf2427360878ab3c247a777e9bd555',
  'hooks__chat__useMediaUpload.js':
    '3dd9537e6dccc4883305f42be3914473110db30c48ae7ea905bd101a997a095f',
  'hooks__chat__useAudioRecorder.js':
    'a15aa0f0e445be34d69246f57f0985944efae1397e2a99dedabc483886eeff1f',
  'hooks__usePushNotifications.js':
    '54e434a5195848f02273f7b5de76a6fa0a425ec7a4d6f759bd4ee7ab6bc35d72',
};

test('P14R7-B0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 R6 / R7-WorkA 同构，独立复制以保持自包含）
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
//   mode = 'after'    → 当前真实源码（迁移后 TS）
//   mode = 'injected' → 当前源码的隔离副本，按 inject 回调改成错误写法
// ---------------------------------------------------------------------------
function buildSandbox(mode, inject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r7-mig-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      const target = path.join(d, f);
      // 支持子路径文件（如 legacy/index.js），需先建父目录。
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, c);
    }
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
export const Platform = { OS: 'ios', select: (o) => (o && (o.ios ?? o.default)) };
export const AppState = { currentState: 'active', addEventListener() { return { remove() {} }; } };
export default { Platform, AppState };
`,
  });

  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export async function impactAsync(style) { (globalThis.__HAPTIC__ ||= []).push(['impact', style]); }
export async function notificationAsync(type) { (globalThis.__HAPTIC__ ||= []).push(['notification', type]); }
export async function selectionAsync() {}
export default { ImpactFeedbackStyle, NotificationFeedbackType, impactAsync, notificationAsync, selectionAsync };
`,
  });

  mk('expo-crypto', {
    'package.json': JSON.stringify({ name: 'expo-crypto', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
let __seq = 0;
export function randomUUID() { __seq += 1; return 'uuid-' + __seq; }
export default { randomUUID };
`,
  });

  mk('expo-audio', {
    'package.json': JSON.stringify({ name: 'expo-audio', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const RecordingPresets = { HIGH_QUALITY: { extension: '.m4a', sampleRate: 44100, numberOfChannels: 2, bitRate: 128000, android: {}, ios: {} } };
globalThis.__audioLog = [];
export const __audioLog = globalThis.__audioLog;
export async function setAudioModeAsync(mode) { __audioLog.push(['setAudioModeAsync', mode]); }
export async function requestRecordingPermissionsAsync() { __audioLog.push(['requestRecordingPermissionsAsync']); return { granted: true }; }
export function useAudioRecorder(options) {
  if (!globalThis.__RECORDER__) {
    globalThis.__RECORDER__ = {
      options,
      uri: 'file:///tmp/rec.m4a',
      prepared: 0,
      recorded: 0,
      stopped: 0,
      async prepareToRecordAsync() { this.prepared += 1; },
      record() { this.recorded += 1; },
      stop() { this.stopped += 1; },
    };
  }
  return globalThis.__RECORDER__;
}
export default { RecordingPresets, setAudioModeAsync, requestRecordingPermissionsAsync, useAudioRecorder };
`,
  });

  mk('expo-image-picker', {
    'package.json': JSON.stringify({ name: 'expo-image-picker', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export async function requestMediaLibraryPermissionsAsync() { return { granted: true }; }
export async function launchImageLibraryAsync() { return { canceled: true, assets: [] }; }
export default { requestMediaLibraryPermissionsAsync, launchImageLibraryAsync };
`,
  });

  mk('expo-video-thumbnails', {
    'package.json': JSON.stringify({ name: 'expo-video-thumbnails', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export async function getThumbnailAsync() { return { uri: 'file:///tmp/thumb.jpg' }; }
export default { getThumbnailAsync };
`,
  });

  mk('expo-file-system', {
    'package.json': JSON.stringify({
      name: 'expo-file-system',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      // 真实 expo-file-system 通过 exports 暴露 ./legacy 子路径；
      // 这里显式声明，避免 Node ESM 拒绝目录导入（ERR_UNSUPPORTED_DIR_IMPORT）。
      exports: {
        '.': './index.js',
        './legacy': './legacy/index.js',
      },
    }),
    'index.js': `
export class File {
  constructor(uri) { this.uri = uri; }
  info() { return { size: globalThis.__FILE_SIZE__ ?? 1024 }; }
}
export default { File };
`,
    'legacy/index.js': `
export const EncodingType = { Base64: 'base64', UTF8: 'utf8' };
export async function readAsStringAsync(uri) { (globalThis.__READ_LOG__ ||= []).push(uri); return 'QUJD'; }
export default { EncodingType, readAsStringAsync };
`,
  });

  mk('base64-arraybuffer', {
    'package.json': JSON.stringify({ name: 'base64-arraybuffer', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export function decode(b64) { return { byteLength: b64 ? b64.length : 0, __b64: b64 }; }
export default { decode };
`,
  });

  mk('expo-device', {
    'package.json': JSON.stringify({ name: 'expo-device', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
// ESM 命名空间对 export const 是静态快照，因此用 export let + 显式刷新函数，
// 保证测试中途修改 __IS_DEVICE__ 后能同步到 Device.isDevice。
export let isDevice = true;
globalThis.__refreshIsDevice__ = () => { isDevice = globalThis.__IS_DEVICE__ ?? true; };
export default { get isDevice() { return globalThis.__IS_DEVICE__ ?? true; } };
`,
  });

  mk('expo-constants', {
    'package.json': JSON.stringify({ name: 'expo-constants', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const Constants = { expoConfig: { extra: { eas: { projectId: 'proj-1' } } }, easConfig: { projectId: 'proj-1' } };
export default Constants;
`,
  });

  mk('expo-notifications', {
    'package.json': JSON.stringify({ name: 'expo-notifications', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const AndroidImportance = { MAX: 5 };
export const __notifLog = [];
export function setNotificationHandler(h) { globalThis.__NOTIF_HANDLER__ = h; }
export async function setNotificationChannelAsync(name, cfg) { __notifLog.push(['channel', name, cfg]); }
export async function getPermissionsAsync() { return { status: globalThis.__PERM_STATUS__ ?? 'granted' }; }
export async function requestPermissionsAsync() { return { status: globalThis.__PERM_STATUS__ ?? 'granted' }; }
export async function getExpoPushTokenAsync(args) {
  __notifLog.push(['token', args]);
  if (globalThis.__TOKEN_THROW__) throw new Error('token boom');
  return { data: globalThis.__TOKEN__ ?? 'ExponentPushToken[abc]' };
}
export function addNotificationReceivedListener(cb) { (globalThis.__RECV__ ||= []).push(cb); return { remove() { globalThis.__RECV_REMOVED__ = (globalThis.__RECV_REMOVED__ || 0) + 1; } }; }
export function addNotificationResponseReceivedListener(cb) { (globalThis.__RESP__ ||= []).push(cb); return { remove() { globalThis.__RESP_REMOVED__ = (globalThis.__RESP_REMOVED__ || 0) + 1; } }; }
export default { AndroidImportance, setNotificationHandler, setNotificationChannelAsync, getPermissionsAsync, requestPermissionsAsync, getExpoPushTokenAsync, addNotificationReceivedListener, addNotificationResponseReceivedListener };
`,
  });

  mk('expo-router', {
    'package.json': JSON.stringify({ name: 'expo-router', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __pushLog = [];
export const router = { push(a) { __pushLog.push(a); }, replace() {}, back() {} };
export function useRouter() { return router; }
export function useFocusEffect(cb) { return cb(); }
export function Link() { return null; }
export function useLocalSearchParams() { return {}; }
export default { router, useRouter, useFocusEffect, Link, useLocalSearchParams };
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
    ['hooks__useAccountSwitcher.js', 'src/hooks/useAccountSwitcher.ts', 'src/hooks/useAccountSwitcher.js'],
    ['hooks__chat__useChatFavorites.js', 'src/hooks/chat/useChatFavorites.ts', 'src/hooks/chat/useChatFavorites.js'],
    ['hooks__chat__useMediaUpload.js', 'src/hooks/chat/useMediaUpload.ts', 'src/hooks/chat/useMediaUpload.js'],
    ['hooks__chat__useAudioRecorder.js', 'src/hooks/chat/useAudioRecorder.ts', 'src/hooks/chat/useAudioRecorder.js'],
    ['hooks__usePushNotifications.js', 'src/hooks/usePushNotifications.ts', 'src/hooks/usePushNotifications.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') place(path.join(beforeDir, beforeName), dstRel);
    else place(path.join(repoRoot, afterRel), dstRel);
  }

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

  // mediaCache stub
  fs.writeFileSync(path.join(dir, 'src/services/mediaCache.js'), `
export const __persistLog = [];
export async function persistMedia(uri, id, kind) { __persistLog.push([uri, id, kind]); return 'file:///sandbox/' + kind + '/' + id; }
export async function resolveLocalMedia(id, kind) { return 'file:///sandbox/' + kind + '/' + id; }
export async function downloadToSandbox() { return null; }
export function getMemoryLocalMedia() { return null; }
export async function getMediaCacheSize() { return { bytes: 0, count: 0 }; }
export async function clearMediaCache() { return { ok: true }; }
export function setMediaCacheOwner() { return 0; }
export function normalizeFileUri(p) { return p; }
`);

  // supabase stub：storage（upload / createSignedUrl）+ from().insert() + auth.getSession()
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  insertCalls: [],
  uploadCalls: [],
  signCalls: [],
  updateCalls: [],
  insertImpl: null,
  uploadImpl: null,
  signImpl: null,
  updateImpl: null,
  sessionUid: null,
};

function makeInsert(table) {
  const api = {
    then(res, rej) {
      state.insertCalls.push({ table });
      const p = state.insertImpl ? state.insertImpl(table) : Promise.resolve({ data: null, error: null });
      return p.then(res, rej);
    },
  };
  return api;
}

function makeUpdate(table, patch) {
  const api = {
    eq(col, val) {
      state.updateCalls.push({ table, patch, col, val });
      const p = state.updateImpl ? state.updateImpl(table, patch, col, val) : Promise.resolve({ data: null, error: null });
      return p;
    },
  };
  return api;
}

export const supabase = {
  __state: state,
  __reset() {
    state.insertCalls.length = 0;
    state.uploadCalls.length = 0;
    state.signCalls.length = 0;
    state.updateCalls.length = 0;
    state.insertImpl = null;
    state.uploadImpl = null;
    state.signImpl = null;
    state.updateImpl = null;
    state.sessionUid = null;
  },
  auth: {
    async getSession() { return { data: { session: state.sessionUid ? { user: { id: state.sessionUid } } : null } }; },
  },
  storage: {
    from(bucket) {
      return {
        async upload(name, body, opts) {
          state.uploadCalls.push({ bucket, name, byteLength: body && body.byteLength, opts });
          if (state.uploadImpl) return state.uploadImpl(bucket, name, body, opts);
          return { data: { path: name }, error: null };
        },
        async createSignedUrl(objectPath, ttl) {
          state.signCalls.push({ bucket, objectPath, ttl });
          if (state.signImpl) return state.signImpl(bucket, objectPath, ttl);
          return { data: { signedUrl: 'https://signed.example/' + objectPath }, error: null };
        },
      };
    },
  },
  from(table) {
    return {
      insert(row) { state.insertCalls.push({ table, row }); return makeInsert(table); },
      update(patch) { return makeUpdate(table, patch); },
    };
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
  assert.deepEqual(after, before, `R7 迁移后必须与旧 JS 等价：${label}`);
  return { before, after };
}

// ===========================================================================
// 公共 PRELUDE
// ===========================================================================
const COMMON_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { supabase } = await import('./src/services/supabase');
const __sb = supabase.__state;

// 固定虚拟时钟起点：不得依赖真实 Date.now()，否则跨真实秒边界运行时
// lastUsedAt 等时间戳会产生 1000ms 抖动，导致等价测试偶发失败。
let __now = 1700000000000;
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

// ===========================================================================
// M1 — useAccountSwitcher：L-4 邮箱脱敏 / djb2 指纹 / LRU 截断 / 旧数据迁移
// ===========================================================================
const SWITCHER_PRELUDE = String.raw`
${COMMON_PRELUDE}
const AS = (await import('@react-native-async-storage/async-storage')).default;
const S = await import('./src/hooks/useAccountSwitcher');
const { useAccountSwitcher } = S;
const rt = createHookRuntime();
let last = null;
function mount() { last = rt.render(() => useAccountSwitcher()); return last; }
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    last = rt.rerender();
  }
  return last;
}
`;

const M1_BODY = String.raw`
${SWITCHER_PRELUDE}
// 1) 旧格式（含明文 email）→ 读取时即时脱敏迁移
await AS.setItem('@app_known_accounts', JSON.stringify([
  { id: 'u1', email: 'alice@gmail.com', nickname: 'Alice', syncId: 'S1', lastUsedAt: 100 },
  { id: 'u2', email: 'bob@example.org', nickname: 'Bob', syncId: 'S2', lastUsedAt: 300 },
  { id: 'u3', email: 'x', nickname: 'Bad', lastUsedAt: 200 },
  { id: 'u4', email: 'carol@a.io', nickname: 'Carol', lastUsedAt: 50 },
  { id: 'u5', email: 'dave@b.io', nickname: 'Dave', lastUsedAt: 400 },
  { id: 'u6', email: 'erin@c.io', nickname: 'Erin', lastUsedAt: 250 },
  { id: 'u7', email: 'frank@d.io', nickname: 'Frank', lastUsedAt: 10 },
  { id: '', email: 'skip@e.io', lastUsedAt: 999 },
  null,
  'garbage',
]));
mount();
await settle();
const first = last.accounts.map((a) => ({
  id: a.id, emailMasked: a.emailMasked, emailHash: a.emailHash,
  nickname: a.nickname, syncId: a.syncId, lastUsedAt: a.lastUsedAt,
  hasAvatarColor: typeof a.avatarColor === 'string' && a.avatarColor.startsWith('#'),
  hasPlainEmail: Object.prototype.hasOwnProperty.call(a, 'email'),
}));

// 2) rememberAccount：新账号 + 已有账号更新（email 缺省时沿用旧脱敏值）
await last.rememberAccount({ id: 'u2', email: 'bob2@example.org', nickname: 'Bob2' });
await last.rememberAccount({ id: 'u8', email: 'new@z.io', nickname: 'New' });
await last.rememberAccount({ id: 'u2', nickname: 'Bob3' });
await settle();
const afterRemember = last.accounts.map((a) => ({
  id: a.id, emailMasked: a.emailMasked, emailHash: a.emailHash,
  nickname: a.nickname, syncId: a.syncId, lastUsedAt: a.lastUsedAt,
  hasPlainEmail: Object.prototype.hasOwnProperty.call(a, 'email'),
}));
const persistedRaw = await AS.getItem('@app_known_accounts');
const persisted = JSON.parse(persistedRaw);
// 明文判定：落盘对象里出现 email 字段，或 emailMasked 不是掩码格式（含完整本地部分）。
const persistedHasPlainEmail = persisted.some(
  (a) =>
    Object.prototype.hasOwnProperty.call(a, 'email') ||
    (typeof a.emailMasked === 'string' && a.emailMasked.includes('@') && !a.emailMasked.includes('***'))
);

// 3) forgetAccount / clearAccounts
await last.forgetAccount('u8');
await settle();
const afterForget = last.accounts.map((a) => a.id);
await last.clearAccounts();
await settle();
const afterClear = last.accounts.length;
const clearedRaw = await AS.getItem('@app_known_accounts');

// 4) 纯函数：maskEmail / hashEmail / pickAvatarColor
const masks = [
  S.maskEmail('alice@gmail.com'),
  S.maskEmail('a@b.co'),
  S.maskEmail('@b.co'),
  S.maskEmail('no-at-sign'),
  S.maskEmail('  bob@example.org  '),
  S.maskEmail('x@'),
  S.maskEmail(null),
  S.maskEmail(123),
];
const hashes = [
  S.hashEmail('alice@gmail.com'),
  S.hashEmail('ALICE@gmail.com'),
  S.hashEmail('  alice@gmail.com  '),
  S.hashEmail(''),
  S.hashEmail(null),
];
const colors = [S.pickAvatarColor(''), S.pickAvatarColor('u1'), S.pickAvatarColor('u2'), S.pickAvatarColor('u1')];
const colorInPool = colors.every((c) => S.AVATAR_COLORS.includes(c));

out({
  first,
  afterRemember,
  persistedHasPlainEmail,
  persistedCount: persisted.length,
  afterForget,
  afterClear,
  clearedRaw,
  masks,
  hashes,
  colors,
  colorInPool,
  maxAccounts: S.MAX_ACCOUNTS,
  avatarPool: S.AVATAR_COLORS,
});
`;

test('M1 useAccountSwitcher：脱敏 / 指纹 / LRU / 旧数据迁移 / 增删清空 与旧 JS 等价', async () => {
  const { after } = assertEqualBoth(M1_BODY, 'M1');
  assert.equal(after.persistedHasPlainEmail, false, '落盘数据不得包含明文 email 字段（L-4）');
  assert.equal(after.persistedCount, 5, 'LRU 截断后最多 5 条');
  assert.equal(after.maxAccounts, 5);
  assert.equal(after.colorInPool, true, '头像色必须取自固定色池');
  assert.equal(after.afterClear, 0, 'clearAccounts 后列表为空');
  assert.equal(after.clearedRaw, null, 'clearAccounts 必须移除存储键');
  assert.equal(after.afterForget.includes('u8'), false, 'forgetAccount 必须移除目标账号');
  assert.equal(after.masks[0], 'al***@gmail.com');
  assert.equal(after.masks[1], 'a***@b.co');
  assert.equal(after.masks[2], '', '缺少本地部分时返回空串');
  assert.equal(after.masks[3], '', '无 @ 时返回空串');
  assert.equal(after.masks[4], 'bo***@example.org', '首尾空白必须被 trim');
  assert.equal(after.masks[5], '', '空域名返回空串');
  assert.equal(after.masks[6], '', '非字符串返回空串');
  assert.equal(after.masks[7], '');
  assert.equal(after.hashes[0], after.hashes[1], '指纹必须大小写不敏感');
  assert.equal(after.hashes[0], after.hashes[2], '指纹必须忽略首尾空白');
  assert.equal(after.hashes[3], '');
  assert.equal(after.hashes[4], '');
  assert.equal(after.colors[1], after.colors[3], '同一 seed 必须得到同一颜色');
});

test('M1 故障注入：让 maskEmail 退化为原样返回（落盘出现明文 email）后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useAccountSwitcher.ts')) return src;
    // 注入点：把脱敏函数改成「原样返回」，模拟 L-4 脱敏被移除的错误实现。
    const marker = 'function maskEmail(email: unknown): string {';
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到 maskEmail 定义');
    return src.replace(
      marker,
      'function maskEmail(email: unknown): string {\n  if (typeof email === "string") return email.trim();'
    );
  };
  const injected = runInSandbox(buildSandbox('injected', inject), M1_BODY);
  assert.equal(injected.persistedHasPlainEmail, true, '注入后落盘出现明文 email（证明注入生效）');
  assert.equal(
    injected.masks[0],
    'alice@gmail.com',
    '注入后 maskEmail 退化为原样返回（证明注入确实改写了脱敏逻辑）'
  );
  const before = runInSandbox(buildSandbox('before'), M1_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// M2 — useChatFavorites：按用户隔离的收藏 / 归一化 / 增删清空
// ===========================================================================
const FAVORITES_PRELUDE = String.raw`
${COMMON_PRELUDE}
const ASMOD = await import('@react-native-async-storage/async-storage');
const AS = ASMOD.default;
const { __storageLog } = ASMOD;
const F = await import('./src/hooks/chat/useChatFavorites');
const { useChatFavorites } = F;
const rt = createHookRuntime();
let last = null;
function mount(user) { last = rt.render(() => useChatFavorites(user)); return last; }
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    last = rt.rerender();
  }
  return last;
}
`;

const M2_BODY = String.raw`
${FAVORITES_PRELUDE}
// 1) 未登录：loaded 必须为 true 且不读写任何存储键
setIdentity(null, 0);
mount(null);
await settle();
const anon = {
  loaded: last.loaded,
  count: last.items.length,
  keys: __storageLog.filter((e) => e[0] !== 'getItem' || !String(e[1]).startsWith('sync_chat_favorites_v1_')).map((e) => e[1]),
};

// 2) 用户 A：预置脏数据 → 归一化过滤
setIdentity('ua', 1);
await AS.setItem('sync_chat_favorites_v1_ua', JSON.stringify([
  { id: 'f1', msgId: 'm1', text: 'hello', peerId: 'ub', savedAt: 200 },
  { id: 'f2', msgId: 'm2', text: '', peerId: 'ub', savedAt: 300 },
  { id: 'f3', msgId: 'm3', text: '   ', peerId: 'ub', savedAt: 400 },
  { id: 'f4', msgId: 'm4', text: 'ok', peerId: 'ub', savedAt: 500, mediaUrl: 'ua/x.jpg', type: 'image' },
  { text: 'no-id', peerId: 'ub', savedAt: 600 },
  null,
  'garbage',
  { id: 'f5', msgId: 'm5', text: 'dup', peerId: 'ub', savedAt: 700 },
]));
mount({ id: 'ua' });
await settle();
const loadedA = {
  loaded: last.loaded,
  items: last.items.map((i) => ({ id: i.id, msgId: i.msgId, text: i.text, mediaUrl: i.mediaUrl, type: i.type, savedAt: i.savedAt })),
};

// 3) addFavorite：正常 / 空文本 / 空消息 / 重复 id
const addOk = last.addFavorite({ id: 'm1', text: 'msg one', senderId: 'ub', createdAt: 1000 }, { senderName: 'Bob' });
const addEmpty = last.addFavorite({ id: 'm9', text: '   ', senderId: 'ub', createdAt: 1000 });
const addNull = last.addFavorite(null);
const addMedia = last.addFavorite({ id: 'm10', text: '', senderId: 'ub', createdAt: 1000, mediaPath: 'ua/y.jpg', mediaType: 'image' });
await settle();
// 收藏 id 由 Date.now() + Math.random() 生成，跨进程必然不同；输出时归一化，只比较语义字段。
const normId = (id) => (/^fav_\d+_\d+$/.test(String(id)) ? 'fav_<generated>' : id);
const pick = (i) => (i && typeof i === 'object'
  ? { id: normId(i.id), msgId: i.msgId, text: i.text, peerName: i.peerName, mediaUrl: i.mediaUrl, type: i.type }
  : i);
const afterAdd = {
  addOk, addEmpty, addNull, addMedia,
  items: last.items.map(pick),
  persisted: JSON.parse(await AS.getItem('sync_chat_favorites_v1_ua')).map(pick),
};

// 4) removeFavorite：存在 / 不存在 / 空参数
last.removeFavorite(last.items[0].id);
last.removeFavorite('not-exist');
last.removeFavorite(null);
await settle();
const afterRemove = last.items.map((i) => normId(i.id));

// 5) 用户 B：必须与 A 完全隔离
setIdentity('ub', 1);
mount({ id: 'ub' });
await settle();
const userB = { loaded: last.loaded, count: last.items.length, raw: await AS.getItem('sync_chat_favorites_v1_ub') };

// 6) 切回 A：数据仍在
setIdentity('ua', 1);
mount({ id: 'ua' });
await settle();
const backToA = last.items.map((i) => normId(i.id));

// 7) clearFavorites
last.clearFavorites();
await settle();
const afterClear = { count: last.items.length, raw: await AS.getItem('sync_chat_favorites_v1_ua') };

out({ anon, loadedA, afterAdd, afterRemove, userB, backToA, afterClear, keyPrefix: F.KEY_PREFIX });
`;

test('M2 useChatFavorites：归一化 / 增删清空 / 用户隔离 与旧 JS 等价', async () => {
  const { after } = assertEqualBoth(M2_BODY, 'M2');
  assert.equal(after.anon.loaded, true, '未登录时 loaded 必须为 true（不阻塞 UI）');
  assert.equal(after.anon.count, 0);
  assert.deepEqual(after.anon.keys, [], '未登录不得读写任何收藏存储键');
  assert.equal(after.loadedA.loaded, true);
  assert.deepEqual(
    after.loadedA.items.map((i) => i.id),
    ['f1', 'f2', 'f3', 'f4', 'f5'],
    '归一化必须过滤无 id / 非对象项，并保持原有顺序（迁移前不排序、不去重）'
  );
  assert.equal(after.loadedA.items[0].msgId, 'm1');
  assert.equal(after.loadedA.items[1].text, '', '空文本项迁移前保留（不擅自过滤）');
  assert.equal(after.loadedA.items[3].mediaUrl, 'ua/x.jpg');
  assert.equal(after.loadedA.items[3].type, 'image');
  // 迁移前行为：addFavorite 的返回值依赖 setState updater 的同步执行时机，
  // 在批处理/延迟渲染下可能返回 false；这里只断言「与旧 JS 完全一致」，
  // 真正的收藏结果以 items / persisted 为准。
  assert.equal(after.afterAdd.addNull, false, '空消息必须立即返回 false（不进入 updater）');
  assert.equal(
    after.afterAdd.items.filter((i) => i.msgId === 'm1').length,
    1,
    '正常消息必须被收藏'
  );
  assert.equal(
    after.afterAdd.items.filter((i) => i.msgId === 'm9').length,
    1,
    '迁移前行为：纯空白文本仍可收藏（保持等价，不擅自收紧）'
  );
  assert.equal(
    after.afterAdd.items.filter((i) => i.msgId === 'm10').length,
    1,
    '仅含媒体的消息可收藏'
  );
  assert.equal(after.afterAdd.persisted.length, after.afterAdd.items.length, '落盘条数与内存一致');
  assert.equal(after.afterRemove.includes('not-exist'), false);
  assert.equal(after.userB.count, 0, '用户 B 不得看到用户 A 的收藏');
  assert.equal(after.userB.raw, null, '用户 B 未写入前不应有存储键');
  assert.deepEqual(after.backToA, after.afterRemove, '切回用户 A 后收藏必须完整保留');
  assert.equal(after.afterClear.count, 0);
  assert.equal(after.afterClear.raw, '[]', 'clearFavorites 迁移前行为：写入空数组（保持等价）');
});

test('M2 故障注入：去掉用户维度隔离（固定存储键）后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useChatFavorites.ts')) return src;
    const marker = 'const storageKey = user?.id ? `${KEY_PREFIX}${user.id}` : null;';
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到 storageKey 计算语句');
    return src.replace(marker, 'const storageKey = user?.id ? `${KEY_PREFIX}shared` : null;');
  };
  const injected = runInSandbox(buildSandbox('injected', inject), M2_BODY);
  assert.equal(injected.userB.count > 0, true, '注入后用户 B 读到共享数据（证明注入生效）');
  const before = runInSandbox(buildSandbox('before'), M2_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// M3 — useMediaUpload：存储路径归一化 / 签名 URL / 上传（含 RLS 路径校验）
// ===========================================================================
const MEDIA_PRELUDE = String.raw`
${COMMON_PRELUDE}
const M = await import('./src/hooks/chat/useMediaUpload');
`;

const M3_BODY = String.raw`
${MEDIA_PRELUDE}
// 1) cleanStoragePath：本地 URI / 完整 URL / 带查询串 / 已归一化路径 / 脏输入
const cleaned = [
  M.cleanStoragePath('file:///var/mobile/tmp/a.jpg'),
  M.cleanStoragePath('content://media/external/images/1'),
  M.cleanStoragePath('ph://ABC-123'),
  M.cleanStoragePath('assets-library://asset/asset.JPG?id=1'),
  M.cleanStoragePath('data:image/png;base64,AAAA'),
  M.cleanStoragePath('blob:https://x/y'),
  M.cleanStoragePath('https://proj.supabase.co/storage/v1/object/public/chat_media/ua/a.jpg'),
  M.cleanStoragePath('https://proj.supabase.co/storage/v1/object/sign/chat_media/ua/b.jpg?token=xyz'),
  M.cleanStoragePath('https://proj.supabase.co/storage/v1/object/public/chat_media/ua/c.jpg#frag'),
  M.cleanStoragePath('chat_media/ua/d.jpg'),
  M.cleanStoragePath('ua/e.jpg'),
  M.cleanStoragePath(''),
  M.cleanStoragePath(null),
  M.cleanStoragePath(undefined),
  M.cleanStoragePath('   '),
];

// 2) createSignedMediaUrl：成功 / 失败 / 空路径
__sb.signImpl = null;
const signedOk = await M.createSignedMediaUrl('ua/a.jpg');
const signedTtl = __sb.signCalls[0];
__sb.signImpl = async () => ({ data: null, error: { message: 'denied' } });
const signedFail = await M.createSignedMediaUrl('ua/b.jpg');
__sb.signImpl = null;
const signedEmpty = await M.createSignedMediaUrl('');

// 3) uploadToSupabase：正常上传（路径以 userId 开头）
__sb.sessionUid = 'ua';
__sb.uploadImpl = null;
__sb.signImpl = null;
const upOk = await M.uploadToSupabase('file:///tmp/pic.jpg', 'img', 'ua');
const upOkCalls = {
  uploads: __sb.uploadCalls.map((c) => ({ bucket: c.bucket, name: c.name, byteLength: c.byteLength })),
  signs: __sb.signCalls.map((c) => ({ bucket: c.bucket, objectPath: c.objectPath, ttl: c.ttl })),
};

// 4) uploadToSupabase：缺少 userId（无法构造带命名空间的对象路径）
supabase.__reset();
__sb.sessionUid = 'ua';
const upNoUser = await M.uploadToSupabase('file:///tmp/pic.jpg', 'img', null);
const upNoUserCalls = { uploads: __sb.uploadCalls.length, signs: __sb.signCalls.length };

// 4b) uploadToSupabase：空 uri 直接返回 null
supabase.__reset();
const upNoUri = await M.uploadToSupabase('', 'img', 'ua');
const upNoUriCalls = { uploads: __sb.uploadCalls.length, signs: __sb.signCalls.length };

// 5) uploadToSupabase：上传失败
supabase.__reset();
__sb.sessionUid = 'ua';
__sb.uploadImpl = async () => ({ data: null, error: { message: 'boom' } });
const upFail = await M.uploadToSupabase('file:///tmp/pic.jpg', 'img', 'ua');
const upFailCalls = { uploads: __sb.uploadCalls.length, signs: __sb.signCalls.length };

// 6) uploadToSupabase：无扩展名时按 prefix 回退
supabase.__reset();
__sb.sessionUid = 'ua';
__sb.uploadImpl = null;
__sb.signImpl = null;
const upNoExt = await M.uploadToSupabase('file:///tmp/noext', 'audio', 'ua');
const upNoExtName = __sb.uploadCalls[0] && __sb.uploadCalls[0].name;
supabase.__reset();
__sb.sessionUid = 'ua';
const upNoExtVid = await M.uploadToSupabase('file:///tmp/noext', 'vid', 'ua');
const upNoExtVidName = __sb.uploadCalls[0] && __sb.uploadCalls[0].name;
supabase.__reset();
__sb.sessionUid = 'ua';
const upNoExtOther = await M.uploadToSupabase('file:///tmp/noext', 'other', 'ua');
const upNoExtOtherName = __sb.uploadCalls[0] && __sb.uploadCalls[0].name;

out({
  cleaned,
  signedOk,
  signedTtl,
  signedFail,
  signedEmpty,
  upOk,
  upOkCalls,
  upNoUser,
  upNoUserCalls,
  upNoUri,
  upNoUriCalls,
  upFail,
  upFailCalls,
  upNoExt,
  upNoExtName,
  upNoExtVid,
  upNoExtVidName,
  upNoExtOther,
  upNoExtOtherName,
  ttlConst: M.SIGNED_URL_TTL,
});
`;

test('M3 useMediaUpload：路径归一化 / 签名 URL / 上传与 RLS 路径校验 与旧 JS 等价', async () => {
  const { after } = assertEqualBoth(M3_BODY, 'M3');
  // 本地 URI 一律归一化为空串（不可作为存储路径）
  assert.deepEqual(after.cleaned.slice(0, 6), ['', '', '', '', '', ''], '本地/内联 URI 必须归一化为空串');
  assert.equal(after.cleaned[6], 'ua/a.jpg', 'public URL 必须剥离到 bucket 之后的相对路径');
  assert.equal(after.cleaned[7], 'ua/b.jpg', 'sign URL 必须剥离查询串');
  assert.equal(after.cleaned[8], 'ua/c.jpg', '必须剥离 hash 片段');
  assert.equal(after.cleaned[9], 'ua/d.jpg', '带 bucket 前缀的路径必须去掉前缀');
  assert.equal(after.cleaned[10], 'ua/e.jpg', '已归一化路径保持不变');
  assert.deepEqual(after.cleaned.slice(11), ['', '', '', ''], '空/空白/非字符串输入归一化为空串');
  assert.equal(after.signedOk, 'https://signed.example/ua/a.jpg');
  assert.equal(after.signedTtl.bucket, 'chat_media');
  assert.equal(after.signedTtl.objectPath, 'ua/a.jpg');
  assert.equal(after.signedTtl.ttl, after.ttlConst, '签名 TTL 必须使用 SIGNED_URL_TTL');
  assert.equal(after.signedFail, null, '签名失败必须返回 null（不抛错）');
  assert.equal(after.signedEmpty, null, '空路径必须直接返回 null');
  assert.equal(after.upOk && after.upOk.path, 'ua/' + after.upOkCalls.uploads[0].name.split('/').slice(1).join('/'));
  assert.equal(after.upOkCalls.uploads.length, 1);
  assert.equal(after.upOkCalls.uploads[0].bucket, 'chat_media');
  assert.equal(after.upOkCalls.uploads[0].name.startsWith('ua/'), true, '上传路径必须以 userId 开头（RLS 要求）');
  assert.equal(after.upNoUser, null, '缺少 userId 时必须拒绝上传');
  assert.deepEqual(after.upNoUserCalls, { uploads: 0, signs: 0 }, '缺少 userId 时不得发起任何存储请求');
  assert.equal(after.upNoUri, null, '空 uri 必须直接返回 null');
  assert.deepEqual(after.upNoUriCalls, { uploads: 0, signs: 0 }, '空 uri 时不得发起任何存储请求');
  assert.equal(after.upFail, null, '上传失败必须返回 null');
  assert.deepEqual(after.upFailCalls, { uploads: 1, signs: 0 }, '上传失败后不得再请求签名 URL');
  assert.equal(after.upNoExtName.endsWith('.m4a'), true, 'audio 前缀无扩展名时回退 m4a');
  assert.equal(after.upNoExtVidName.endsWith('.mp4'), true, 'vid 前缀无扩展名时回退 mp4');
  assert.equal(after.upNoExtOtherName.endsWith('.jpg'), true, '其他前缀无扩展名时回退 jpg');
});

test('M3 故障注入：去掉上传前的 RLS 路径校验后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useMediaUpload.ts')) return src;
    // 注入点：把对象路径首段从 userId 改成固定 'shared'，
    // 使 RLS 路径校验（fileName 必须以 `${userId}/` 开头）必然失败。
    const marker = 'const fileName = `${userId}/${prefix}_${Date.now()}_${Crypto.randomUUID()}.${ext}`;';
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到对象路径构造语句');
    return src.replace(
      marker,
      'const fileName = `shared/${prefix}_${Date.now()}_${Crypto.randomUUID()}.${ext}`;'
    );
  };
  const injected = runInSandbox(buildSandbox('injected', inject), M3_BODY);
  assert.equal(injected.upOk, null, '注入后正常上传被 RLS 路径校验拦截（证明注入生效）');
  assert.equal(injected.upOkCalls.uploads.length, 0, '注入后不得发起上传请求');
  const before = runInSandbox(buildSandbox('before'), M3_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// M4 — useAudioRecorder：录音选项 / 音频会话模式 / 录音状态机 / 发送链路
// ===========================================================================
const AUDIO_PRELUDE = String.raw`
${COMMON_PRELUDE}
const A = await import('./src/hooks/chat/useAudioRecorder');
const { useAudioRecorder } = A;
const rt = createHookRuntime();
let last = null;
let sent = [];
let patched = [];
function mount(props) {
  last = rt.render(() => useAudioRecorder(props));
  return last;
}
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    last = rt.rerender();
  }
  return last;
}
`;

const M4_BODY = String.raw`
${AUDIO_PRELUDE}
// 1) 纯常量：AUDIO_OPTIONS 展开 HIGH_QUALITY 且开启电平计量
const options = {
  extension: A.AUDIO_OPTIONS.extension,
  sampleRate: A.AUDIO_OPTIONS.sampleRate,
  numberOfChannels: A.AUDIO_OPTIONS.numberOfChannels,
  bitRate: A.AUDIO_OPTIONS.bitRate,
  isMeteringEnabled: A.AUDIO_OPTIONS.isMeteringEnabled,
};

// 2) 纯函数：buildAudioMode 两种取值
const modeOn = A.buildAudioMode(true);
const modeOff = A.buildAudioMode(false);

// 3) 挂载（user + targetId 齐备）→ 初始化音频会话
setIdentity('ua', 1);
const props = {
  targetId: 'peer-1',
  user: { id: 'ua' },
  saveAndSend: (m) => { sent.push(m); },
  patchMessage: (id, p) => { patched.push([id, p]); },
};
mount(props);
await settle();
const audioLogAfterMount = (globalThis.__audioLog || []).map((e) => e[0]);

// 4) startRecord：iOS 下先设置音频模式 → prepare → record → 计时器启动
//    注意：iOS 分支内部会 await 一个 50ms 的 setTimeout Promise，依赖虚拟定时器，
//    必须先推进时间才能让该 Promise settle（否则顶层 await 永不结束）。
const startPromise = last.startRecord();
await flushMicrotasks(4);
advance(60);
await startPromise;
await settle();
const recorder = globalThis.__RECORDER__;
const afterStart = {
  isRecording: last.isRecording,
  recordingDuration: last.recordingDuration,
  preparedGte1: recorder.prepared >= 1,
  recordedGte1: recorder.recorded >= 1,
  audioLog: (globalThis.__audioLog || []).map((e) => e[0]),
};

// 5) 计时器推进 3 秒 → recordingDuration 跟随
advance(3000);
await settle(4);
const durationAfter3s = last.recordingDuration;

// 6) stopAndSendRecord：停止 → 150ms 后异步发送（persistMedia → saveAndSend → 上传 → 落库 → patch → push）
last.stopAndSendRecord();
await settle(4);
const afterStopImmediate = {
  isRecording: last.isRecording,
  recordingDuration: last.recordingDuration,
  stopped: recorder.stopped,
  sentCount: sent.length,
};
advance(200);
await settle(30);
const sentMsg = sent[0] || null;
const afterSend = {
  sentCount: sent.length,
  sentType: sentMsg && sentMsg.type,
  sentIsMe: sentMsg && sentMsg.isMe,
  sentDuration: sentMsg && sentMsg.duration,
  sentMediaUrl: sentMsg && sentMsg.mediaUrl,
  sentLocalUri: sentMsg && sentMsg.localUri,
  insertCalls: __sb.insertCalls.map((c) => ({ table: c.table, row: c.row })),
  uploadCalls: __sb.uploadCalls.map((c) => ({ bucket: c.bucket, name: c.name })),
  patched,
  pushLog: (globalThis.__PUSH_LOG__ || []).map((p) => ({ receiverId: p.receiverId, body: p.body, data: p.data })),
  haptics: (globalThis.__HAPTIC__ || []).map((h) => h.join(':')),
};

// 7) 未开始录音时 stopAndSendRecord 必须直接返回（不发送、不落库）
supabase.__reset();
sent = [];
patched = [];
last.stopAndSendRecord();
advance(200);
await settle(10);
const stopWithoutStart = {
  sentCount: sent.length,
  insertCalls: __sb.insertCalls.length,
  haptics: (globalThis.__HAPTIC__ || []).map((h) => h.join(':')),
};

// 8) cancelRecord：停止并复位状态
const startPromise2 = last.startRecord();
await flushMicrotasks(4);
advance(60);
await startPromise2;
await settle();
last.cancelRecord();
await settle(4);
const afterCancel = {
  isRecording: last.isRecording,
  recordingDuration: last.recordingDuration,
  stopped: recorder.stopped,
};

// 9) 上传失败 → 静默标记 failed，不落库、不推送
supabase.__reset();
sent = [];
patched = [];
globalThis.__PUSH_LOG__ = [];
__sb.uploadImpl = async () => ({ data: null, error: { message: 'offline' } });
const startPromise3 = last.startRecord();
await flushMicrotasks(4);
advance(60);
await startPromise3;
await settle();
advance(2000);
last.stopAndSendRecord();
advance(200);
await settle(30);
const uploadFail = {
  sentCount: sent.length,
  insertCalls: __sb.insertCalls.length,
  patched,
  pushCount: (globalThis.__PUSH_LOG__ || []).length,
};

// 10) 落库失败 → 标记 failed，不推送
supabase.__reset();
sent = [];
patched = [];
globalThis.__PUSH_LOG__ = [];
__sb.uploadImpl = null;
__sb.insertImpl = async () => ({ data: null, error: { message: 'db down' } });
const startPromise4 = last.startRecord();
await flushMicrotasks(4);
advance(60);
await startPromise4;
await settle();
advance(2000);
last.stopAndSendRecord();
advance(200);
await settle(30);
const insertFail = {
  sentCount: sent.length,
  // 说明：supabase stub 的 from().insert() 会先同步 push 一次，makeInsert().then 再 push 一次，
  // 因此「一次 insert 调用」在 stub 里表现为 2 条记录。这里按 table 去重统计真实调用次数。
  insertCalls: new Set(__sb.insertCalls.map((c) => c.table)).size,
  insertRaw: __sb.insertCalls.length,
  patched,
  pushCount: (globalThis.__PUSH_LOG__ || []).length,
};

out({
  options,
  modeOn,
  modeOff,
  audioLogAfterMount,
  afterStart,
  durationAfter3s,
  afterStopImmediate,
  afterSend,
  stopWithoutStart,
  afterCancel,
  uploadFail,
  insertFail,
});
`;

test('M4 useAudioRecorder：录音选项 / 音频模式 / 状态机 / 发送链路 与旧 JS 等价', async () => {
  const { after } = assertEqualBoth(M4_BODY, 'M4');
  assert.equal(after.options.extension, '.m4a');
  assert.equal(after.options.sampleRate, 44100);
  assert.equal(after.options.numberOfChannels, 2);
  assert.equal(after.options.bitRate, 128000);
  assert.equal(after.options.isMeteringEnabled, true, '必须开启电平计量');
  assert.deepEqual(after.modeOn, {
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'mixWithOthers',
    shouldRouteThroughEarpiece: false,
  });
  assert.equal(after.modeOff.allowsRecording, false, 'buildAudioMode(false) 必须关闭录音');
  assert.deepEqual(after.audioLogAfterMount, [
    'requestRecordingPermissionsAsync',
    'setAudioModeAsync',
  ], '挂载后必须申请权限并设置音频会话');
  assert.equal(after.afterStart.isRecording, true);
  assert.equal(after.afterStart.preparedGte1, true, '必须调用 prepareToRecordAsync');
  assert.equal(after.afterStart.recordedGte1, true, '必须调用 record()');
  assert.equal(after.durationAfter3s, 3, '计时器必须按秒推进录音时长');
  assert.equal(after.afterStopImmediate.isRecording, false);
  assert.equal(after.afterStopImmediate.recordingDuration, 0);
  assert.equal(after.afterStopImmediate.stopped, 1);
  assert.equal(after.afterStopImmediate.sentCount, 0, '发送必须延迟到 150ms 之后');
  assert.equal(after.afterSend.sentCount, 1);
  assert.equal(after.afterSend.sentType, 'audio');
  assert.equal(after.afterSend.sentIsMe, true);
  assert.equal(after.afterSend.sentDuration, 3);
  assert.equal(after.afterSend.sentMediaUrl, 'file:///sandbox/audio/uuid-1');
  // 说明：stub 的 from().insert() 会同步 push 一次、makeInsert().then 再 push 一次，
  // 因此一次真实 insert 在 __sb.insertCalls 里是 2 条记录（含 row 的那条来自 from().insert）。
  const sentInserts = after.afterSend.insertCalls.filter((c) => c.row);
  assert.equal(sentInserts.length, 1, '发送成功后必须且只落库一次');
  assert.equal(sentInserts[0].table, 'messages');
  assert.equal(sentInserts[0].row.type, 'audio');
  assert.equal(sentInserts[0].row.user_id, 'ua');
  assert.equal(sentInserts[0].row.receiver_id, 'peer-1');
  assert.equal(after.afterSend.uploadCalls.length, 1);
  assert.equal(after.afterSend.uploadCalls[0].bucket, 'chat_media');
  assert.equal(after.afterSend.uploadCalls[0].name.startsWith('ua/audio_'), true, '上传路径必须以 userId 开头');
  assert.equal(after.afterSend.patched.length, 1, '成功后必须回填 remotePath / localUri');
  assert.equal(after.afterSend.patched[0][1].remotePath.startsWith('ua/audio_'), true);
  assert.equal(after.afterSend.pushLog.length, 1);
  assert.equal(after.afterSend.pushLog[0].receiverId, 'peer-1');
  assert.equal(after.afterSend.pushLog[0].body, '[语音消息]');
  assert.deepEqual(after.afterSend.pushLog[0].data, { type: 'chat', targetId: 'ua' });
  assert.equal(after.stopWithoutStart.sentCount, 0, '未开始录音时不得发送');
  assert.equal(after.stopWithoutStart.insertCalls, 0, '未开始录音时不得落库');
  assert.equal(after.afterCancel.isRecording, false);
  assert.equal(after.afterCancel.recordingDuration, 0);
  assert.equal(after.uploadFail.sentCount, 1, '上传失败前气泡已本地插入');
  assert.equal(after.uploadFail.insertCalls, 0, '上传失败不得落库');
  assert.equal(after.uploadFail.patched.length, 1);
  assert.equal(after.uploadFail.patched[0][1].status, 'failed', '上传失败必须静默标记 failed');
  assert.equal(after.uploadFail.pushCount, 0, '上传失败不得推送');
  assert.equal(after.insertFail.sentCount, 1);
  assert.equal(after.insertFail.insertCalls, 1, '落库失败场景只应发起一次 messages insert');
  assert.equal(after.insertFail.patched.length, 1);
  assert.equal(after.insertFail.patched[0][1].status, 'failed', '落库失败必须静默标记 failed');
  assert.equal(after.insertFail.pushCount, 0, '落库失败不得推送');
});

test('M4 故障注入：去掉「未开始录音直接返回」守卫后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('useAudioRecorder.ts')) return src;
    const marker = `      if (!recordStartTimeRef.current) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }`;
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到未开始录音守卫');
    return src.replace(
      marker,
      `      if (!recordStartTimeRef.current) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }`
    );
  };
  const injected = runInSandbox(buildSandbox('injected', inject), M4_BODY);
  assert.equal(injected.stopWithoutStart.sentCount, 1, '注入后未开始录音也会发送（证明注入生效）');
  const before = runInSandbox(buildSandbox('before'), M4_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});

// ===========================================================================
// M5 — usePushNotifications：Token 注册 / 空 Token 短路 / 点击跳转 / 监听清理
// ===========================================================================
const PUSH_PRELUDE = String.raw`
${COMMON_PRELUDE}
const P = await import('./src/hooks/usePushNotifications');
const { usePushNotifications } = P;
const rt = createHookRuntime();
function mount() { rt.render(() => usePushNotifications()); }
async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await flushMicrotasks(6);
    rt.rerender();
  }
}
`;

const M5_BODY = String.raw`
${PUSH_PRELUDE}
// 1) 前台通知 handler 必须开启横幅 + 通知中心
const handler = globalThis.__NOTIF_HANDLER__;
const handlerResult = handler ? await handler.handleNotification({}) : null;

// 2) 已登录用户挂载 → 注册 Token 并写入 profiles
setIdentity('ua', 1);
supabase.__reset();
globalThis.__TOKEN__ = 'ExponentPushToken[abc]';
mount();
await settle(30);
const afterMount = {
  updateCalls: __sb.updateCalls.map((c) => ({ table: c.table, patch: c.patch, col: c.col, val: c.val })),
  recvCount: (globalThis.__RECV__ || []).length,
  respCount: (globalThis.__RESP__ || []).length,
};

// 3) 点击通知：type=chat + targetId → 跳转 chat_room（targetName 去空白）
const respCb = (globalThis.__RESP__ || [])[0];
const pushLog = (await import('expo-router')).__pushLog;
respCb({ notification: { request: { content: { data: { type: 'chat', targetId: 'peer-9', targetName: '  Alice  ' } } } } });
const respCb2 = (globalThis.__RESP__ || [])[0];
respCb2({ notification: { request: { content: { data: { type: 'chat', targetId: 'peer-8' } } } } });
const respCb3 = (globalThis.__RESP__ || [])[0];
respCb3({ notification: { request: { content: { data: { type: 'other', targetId: 'peer-7' } } } } });
const respCb4 = (globalThis.__RESP__ || [])[0];
respCb4({ notification: { request: { content: { data: null } } } });
const pushRoutes = pushLog.map((r) => ({ pathname: r.pathname, params: r.params }));

// 4) 空 Token（模拟器）→ 不得写库
supabase.__reset();
globalThis.__TOKEN__ = '';
setIdentity('ub', 2);
mount();
await settle(30);
const emptyToken = { updateCalls: __sb.updateCalls.length };

// 5) 获取 Token 抛错 → 不得写库（且不崩溃）
supabase.__reset();
globalThis.__TOKEN_THROW__ = true;
setIdentity('uc', 3);
mount();
await settle(30);
const tokenThrow = { updateCalls: __sb.updateCalls.length };
globalThis.__TOKEN_THROW__ = false;

// 6) 权限被拒 → 不得写库
supabase.__reset();
globalThis.__PERM_STATUS__ = 'denied';
setIdentity('ud', 4);
mount();
await settle(30);
const permDenied = { updateCalls: __sb.updateCalls.length };
globalThis.__PERM_STATUS__ = 'granted';

// 7) 缺少 EAS projectId → 不得写库（覆盖 registerForPushNotificationsAsync 的另一条短路）
//    注意：源码取 projectId 时先看 expoConfig.extra.eas.projectId，再回退 easConfig.projectId，
//    因此两处都必须清空，才能真正进入「缺少 projectId」分支。
supabase.__reset();
const ConstantsMod = (await import('expo-constants')).default;
const savedExtra = ConstantsMod.expoConfig.extra;
const savedEasConfig = ConstantsMod.easConfig;
ConstantsMod.expoConfig.extra = {};
ConstantsMod.easConfig = {};
const notifLogBefore = (await import('expo-notifications')).__notifLog.length;
setIdentity('ue', 5);
mount();
await settle(30);
const noProjectId = {
  updateCalls: __sb.updateCalls.length,
  tokenAttempts: (await import('expo-notifications')).__notifLog.length - notifLogBefore,
};
ConstantsMod.expoConfig.extra = savedExtra;
ConstantsMod.easConfig = savedEasConfig;

// 8) 卸载 → 两个监听器都必须被移除
const removedBefore = { recv: globalThis.__RECV_REMOVED__ || 0, resp: globalThis.__RESP_REMOVED__ || 0 };
rt.unmount();
const removedAfter = { recv: globalThis.__RECV_REMOVED__ || 0, resp: globalThis.__RESP_REMOVED__ || 0 };

out({
  handlerResult,
  afterMount,
  pushRoutes,
  emptyToken,
  tokenThrow,
  permDenied,
  noProjectId,
  removedBefore,
  removedAfter,
});
`;

test('M5 usePushNotifications：Token 注册 / 空值短路 / 点击跳转 / 监听清理 与旧 JS 等价', async () => {
  const { after } = assertEqualBoth(M5_BODY, 'M5');
  assert.deepEqual(after.handlerResult, {
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }, '前台通知必须展示横幅与通知中心条目');
  assert.equal(after.afterMount.updateCalls.length, 1, '已登录用户必须写入一次 push token');
  assert.equal(after.afterMount.updateCalls[0].table, 'profiles');
  assert.deepEqual(after.afterMount.updateCalls[0].patch, { expo_push_token: 'ExponentPushToken[abc]' });
  assert.equal(after.afterMount.updateCalls[0].col, 'id');
  assert.equal(after.afterMount.updateCalls[0].val, 'ua');
  assert.equal(after.afterMount.recvCount, 1, '必须注册前台通知监听');
  assert.equal(after.afterMount.respCount, 1, '必须注册点击通知监听');
  assert.deepEqual(after.pushRoutes, [
    { pathname: '/chat_room', params: { targetId: 'peer-9', targetName: 'Alice' } },
    { pathname: '/chat_room', params: { targetId: 'peer-8', targetName: '' } },
  ], '仅 type=chat 且有 targetId 时跳转；targetName 缺失时留空');
  assert.equal(after.emptyToken.updateCalls, 0, '空 Token 不得覆盖云端已有 Token');
  assert.equal(after.tokenThrow.updateCalls, 0, '获取 Token 抛错时不得写库');
  assert.equal(after.permDenied.updateCalls, 0, '权限被拒时不得写库');
  assert.equal(after.noProjectId.tokenAttempts, 0, '缺少 projectId 时不得尝试获取 Push Token');
  assert.equal(after.noProjectId.updateCalls, 0, '缺少 projectId 时不得写库');
  // 说明：每次 setIdentity 变更都会触发 effect 重跑，旧 effect 的 cleanup 会移除上一轮监听，
  // 因此 removedBefore 记录的是「历史累计移除次数」，这里只断言卸载后确实又移除了各 1 次。
  assert.equal(after.removedAfter.recv - after.removedBefore.recv, 1, '卸载必须移除前台通知监听');
  assert.equal(after.removedAfter.resp - after.removedBefore.resp, 1, '卸载必须移除点击通知监听');
});

test('M5 故障注入：去掉空 Token 短路后，等价断言必须失败', async () => {
  const inject = (srcPath, src) => {
    if (!srcPath.endsWith('usePushNotifications.ts')) return src;
    const marker = `          if (!token || typeof token !== 'string' || token.trim() === '') {`;
    if (src.indexOf(marker) < 0) throw new Error('注入失败：未找到空 Token 短路分支');
    return src.replace(marker, `          if (false) {`);
  };
  const injected = runInSandbox(buildSandbox('injected', inject), M5_BODY);
  assert.equal(injected.emptyToken.updateCalls, 1, '注入后空 Token 也会写库（证明注入生效）');
  const before = runInSandbox(buildSandbox('before'), M5_BODY);
  assert.throws(
    () => assert.deepEqual(injected, before),
    /Expected values to be strictly deep-equal/,
    '注入错误实现后，等价断言必须失败（证明测试非无条件通过）'
  );
});
// --- END OF FILE tests/security/p14r7MigrationEquivalence.test.mjs ---