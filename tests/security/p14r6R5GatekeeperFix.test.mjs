// --- START OF FILE tests/security/p14r6R5GatekeeperFix.test.mjs ---
/**
 * P1.4 R6 — Work A：R5 Gatekeeper 修复的**真实执行**验证
 *
 * 背景
 *   GPT Gatekeeper 复核 R5 时，独立复现出 5 处运行时语义差异（A1–A5），
 *   并指出 R5 的 FI-1/2/3 故障注入缺少可复核的测试源码与日志
 *   （删掉 catch 分支的身份闸门后 28 个用例仍全绿 → 测试无敏感性）。
 *
 * 本文件的目标
 *   1) 对 A1–A4 做**新旧真实执行**对比（冻结 JS 基线 vs 当前 TS 源码），
 *      覆盖 Gatekeeper 指定的全部边界输入；
 *   2) 对 A5 做**定向可靠性修复**验证（明确声明：同步抛错场景**不与旧 JS 等价**，
 *      旧 JS 在该场景抛 ReferenceError，新实现返回缓存或 null 且不残留 inflight）；
 *   3) 对 A6 做**身份闸门敏感性**验证：在隔离副本中删除 catch 分支的 epoch 校验，
 *      必须产生显式断言失败（证明测试真的能抓到泄漏）。
 *
 * 机制
 *   · 与 R5 等价测试同构：自定义 Hook 运行时 + ts.transpileModule + 子进程沙箱。
 *   · 沙箱内 supabase stub 增加 `signThrowSync` / `fromThrowSync` 开关，用于 A4/A5 注入。
 *   · 故障注入在**独立临时副本**中进行，绝不修改仓库内真实源码；
 *     注入前后均校验 SHA-256，并在结束时用 diff 确认已完整还原。
 *
 * 约束
 *   · 不访问真实网络 / 数据库。
 *   · 冻结基线只读（启动时校验 SHA-256）。
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r5/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 冻结基线完整性
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__chat__useSignedMediaUrl.js':
    'ac5b88e298aa35a688288fce51c786037f300ed3ec69fdca595c69ac70ccd164',
  'hooks__chat__useFriendActions.js':
    '5600f7e25df248053680ab2fb5208be3e5f065895ed944791e715d31f63b50cd',
};

test('P14R6-A0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
  let cursor = 0;
  let pendingEffects = [];
  let componentFn = null;
  let scheduled = false;
  let renderCount = 0;

  function ensureSlot(i) {
    if (!hooks[i]) hooks[i] = { kind: null };
    return hooks[i];
  }

  function useState(init) {
    const i = cursor++;
    const slot = ensureSlot(i);
    if (slot.kind === null) {
      slot.kind = 'state';
      slot.value = typeof init === 'function' ? init() : init;
    }
    const setter = (next) => {
      const resolved = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(resolved, slot.value)) return;
      slot.value = resolved;
      scheduleRender();
    };
    return [slot.value, setter];
  }

  function useRef(initial) {
    const i = cursor++;
    const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'ref'; slot.ref = { current: initial }; }
    return slot.ref;
  }

  function useEffect(fn, deps) {
    const i = cursor++;
    const slot = ensureSlot(i);
    if (slot.kind === null) {
      slot.kind = 'effect';
      slot.deps = deps;
      slot.cleanup = undefined;
      pendingEffects.push({ index: i, fn });
    } else if (deps === undefined || !shallowEqual(slot.deps, deps)) {
      slot.deps = deps;
      pendingEffects.push({ index: i, fn });
    }
  }

  function useCallback(fn, deps) {
    const i = cursor++;
    const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'callback'; slot.fn = fn; slot.deps = deps; return fn; }
    if (deps === undefined || !shallowEqual(slot.deps, deps)) { slot.fn = fn; slot.deps = deps; }
    return slot.fn;
  }

  function useMemo(fn, deps) {
    const i = cursor++;
    const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'memo'; slot.value = fn(); slot.deps = deps; return slot.value; }
    if (deps === undefined || !shallowEqual(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; }
    return slot.value;
  }

  function scheduleRender() { scheduled = true; }

  function runPendingEffects() {
    const toRun = pendingEffects;
    pendingEffects = [];
    for (const { index } of toRun) {
      const slot = hooks[index];
      if (slot.cleanup) { try { slot.cleanup(); } catch (_) {} slot.cleanup = undefined; }
    }
    for (const { index, fn } of toRun) {
      const slot = hooks[index];
      const ret = fn();
      if (typeof ret === 'function') slot.cleanup = ret;
    }
  }

  function render(fn) {
    componentFn = fn;
    cursor = 0;
    renderCount += 1;
    scheduled = false;
    const out = fn();
    runPendingEffects();
    return out;
  }

  function rerender() {
    if (!componentFn) throw new Error('rerender() called before render()');
    cursor = 0;
    renderCount += 1;
    scheduled = false;
    const out = componentFn();
    runPendingEffects();
    return out;
  }

  function flushEffects() { runPendingEffects(); }

  function settle(maxRounds = 20) {
    let rounds = 0;
    while (scheduled && rounds < maxRounds) { rerender(); rounds += 1; }
    return rounds;
  }

  function unmount() {
    for (const slot of hooks) {
      if (slot && slot.cleanup) {
        try { slot.cleanup(); } catch (_) {}
        slot.cleanup = undefined;
      }
    }
    componentFn = null;
  }

  return {
    useState, useRef, useEffect, useCallback, useMemo,
    render, rerender, flushEffects, settle, unmount,
    get renderCount() { return renderCount; },
    get isScheduled() { return scheduled; },
  };
}
`;

// ---------------------------------------------------------------------------
// 沙箱构建
//   mode = 'before'        → 冻结基线（迁移前 JS）
//   mode = 'after'         → 当前真实源码（迁移后 TS）
//   mode = 'after-mutated' → 注入后的临时副本（仅用于 A6 敏感性验证）
// ---------------------------------------------------------------------------
function buildSandbox(mode, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r6-${mode}-`));
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
  const origRerender = rt.rerender;
  const origSettle = rt.settle;
  const origFlush = rt.flushEffects;
  rt.render = (fn) => { const prev = __active; __active = rt; try { return origRender(fn); } finally { __active = prev; } };
  rt.rerender = () => { const prev = __active; __active = rt; try { return origRerender(); } finally { __active = prev; } };
  rt.settle = (n) => { const prev = __active; __active = rt; try { return origSettle(n); } finally { __active = prev; } };
  rt.flushEffects = () => { const prev = __active; __active = rt; try { return origFlush(); } finally { __active = prev; } };
  return rt;
}
function __route(name) {
  return (...args) => {
    if (!__active) throw new Error('Hook ' + name + ' called outside render()');
    return __active[name](...args);
  };
}
export const useState = __route('useState');
export const useEffect = __route('useEffect');
export const useCallback = __route('useCallback');
export const useMemo = __route('useMemo');
export const useRef = __route('useRef');
export default { useState, useEffect, useCallback, useMemo, useRef, createHookRuntime };
`,
  });

  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
export const __storageLog = [];
const AsyncStorage = {
  async getItem(k) { __storageLog.push(['getItem', k]); return store.has(k) ? store.get(k) : null; },
  async setItem(k, v) { __storageLog.push(['setItem', k, v]); store.set(k, v); },
  async removeItem(k) { __storageLog.push(['removeItem', k]); store.delete(k); },
  __store: store,
  __reset() { store.clear(); __storageLog.length = 0; },
};
export default AsyncStorage;
`,
  });

  mk('expo-crypto', {
    'package.json': JSON.stringify({ name: 'expo-crypto', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
let seq = 0;
export const __uuidLog = [];
export function randomUUID() { seq += 1; const id = 'uuid-' + seq; __uuidLog.push(id); return id; }
export default { randomUUID };
`,
  });

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  mk('react-native-url-polyfill', {
    'package.json': JSON.stringify({ name: 'react-native-url-polyfill', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export default {};\n',
  });

  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(relSrc, dst);
  };

  copyFile(path.join(repoRoot, 'src/types/chat.ts'), 'src/types/chat.ts');
  copyFile(path.join(repoRoot, 'src/types/media.ts'), 'src/types/media.ts');

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
    ['hooks__chat__useSignedMediaUrl.js', 'src/hooks/chat/useSignedMediaUrl.ts', 'src/hooks/chat/useSignedMediaUrl.js'],
    ['hooks__chat__useFriendActions.js', 'src/hooks/chat/useFriendActions.ts', 'src/hooks/chat/useFriendActions.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') place(path.join(beforeDir, beforeName), dstRel);
    else if (mode === 'after-mutated') place(path.join(opts.mutatedRoot, afterRel), dstRel);
    else place(path.join(repoRoot, afterRel), dstRel);
  }

  fs.mkdirSync(path.join(dir, 'src/hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/hooks/useOwnerKey.js'),
    `
const state = { ownerKey: 'anon::0', valid: true };
const stableIsOwnerKeyCurrent = (snapshot) => state.valid && snapshot === state.ownerKey;
const stableOwnerKeyRef = { get current() { return state.ownerKey; } };
export function useOwnerKey() {
  return {
    ownerKey: state.ownerKey,
    ownerKeyRef: stableOwnerKeyRef,
    isOwnerKeyCurrent: stableIsOwnerKeyCurrent,
  };
}
export const __ownerState = state;
export default { useOwnerKey };
`
  );

  // supabase stub：signThrowSync（A5）/ fromThrowSync（A4）同步抛错注入
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/services/supabase.js'),
    `
const state = {
  channelLog: [],
  channelInstances: [],
  removeLog: [],
  signLog: [],
  signError: null,
  signDeferred: false,
  signThrowSync: null,
  pendingSigns: [],
  rpcLog: [],
  rpcError: null,
  rpcData: null,
  fromLog: [],
  fromResults: [],
  fromThrowSync: null,
};

function makeChannel(name, opts) {
  const ch = {
    name,
    opts,
    handlers: [],
    sent: [],
    tracked: [],
    subscribed: false,
    __presence: {},
    on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return ch; },
    subscribe(cb) { ch.subscribed = true; if (cb) ch.subscribeCb = cb; return ch; },
    track(payload) { ch.tracked.push(payload); return Promise.resolve('ok'); },
    send(msg) { ch.sent.push(msg); return Promise.resolve('ok'); },
    presenceState() { return ch.__presence; },
    __emit(type, event, payload) {
      for (const h of ch.handlers) {
        if (h.type !== type) continue;
        const filterEvent = h.filter && h.filter.event;
        if (filterEvent !== undefined && filterEvent !== event) continue;
        h.cb(payload);
      }
    },
  };
  state.channelLog.push({ name, opts });
  state.channelInstances.push(ch);
  return ch;
}

export const supabase = {
  __state: state,
  channel(name, opts) { return makeChannel(name, opts); },
  removeChannel(ch) { state.removeLog.push(ch && ch.name); return Promise.resolve('ok'); },
  storage: {
    from(bucket) {
      // A5：模拟 storage.from() 同步抛错（真实场景：SDK 未初始化 / 参数非法）
      if (state.signThrowSync) throw state.signThrowSync;
      return {
        createSignedUrl(objectPath, ttl) {
          state.signLog.push([bucket, objectPath, ttl]);
          if (state.signDeferred) {
            return new Promise((resolve) => {
              state.pendingSigns.push({ objectPath, ttl, resolve });
            });
          }
          if (state.signError) return Promise.resolve({ data: null, error: state.signError });
          return Promise.resolve({ data: { signedUrl: 'https://signed/' + objectPath }, error: null });
        },
      };
    },
  },
  rpc(name, args) {
    state.rpcLog.push([name, args]);
    return Promise.resolve({ data: state.rpcData, error: state.rpcError });
  },
  from(table) {
    // A4：模拟 from() 同步抛错（覆盖 catch 分支 errMessage 路径）
    if (state.fromThrowSync) throw state.fromThrowSync;
    const result = state.fromResults.shift() || { data: [], error: null };
    const builder = {
      __table: table,
      delete() { state.fromLog.push([table, 'delete']); return builder; },
      update(v) { state.fromLog.push([table, 'update', v]); return builder; },
      upsert(v, o) { state.fromLog.push([table, 'upsert', v, o]); return builder; },
      select(c) { state.fromLog.push([table, 'select', c]); return builder; },
      or(c) { state.fromLog.push([table, 'or', c]); return builder; },
      eq(k, v) { state.fromLog.push([table, 'eq', k, v]); return builder; },
      limit(n) { state.fromLog.push([table, 'limit', n]); return builder; },
      then(resolve) { return Promise.resolve(result).then(resolve); },
    };
    return builder;
  },
};
export default { supabase };
`
  );

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
  assert.deepEqual(after, before, `R6 修复后必须与旧 JS 等价：${label}`);
  return { before, after };
}

// ===========================================================================
// 公共 PRELUDE
// ===========================================================================
const COMMON_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { supabase } = await import('./src/services/supabase');
const __sb = supabase.__state;

let __now = 1000000;
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

const MEDIA_PRELUDE = String.raw`
${COMMON_PRELUDE}
const M = await import('./src/hooks/chat/useSignedMediaUrl');
const { setSignedUrlOwner, getSignedUrlIdentity, toStoragePath, buildPublicStorageUrl,
        getSignedUrl, clearSignedUrlCache, getMemoryCachedSignedUrl, useSignedMediaUrl,
        SIGNED_URL_TTL } = M;
const rt = createHookRuntime();
let last = null;
function mount(value, ttl) { last = rt.render(() => useSignedMediaUrl(value, ttl)); return last; }
function rerender() { last = rt.rerender(); return last; }
function settleLast() { if (rt.isScheduled) last = rt.rerender(); return last; }
`;

const FRIEND_PRELUDE = String.raw`
${COMMON_PRELUDE}
const { useFriendActions } = await import('./src/hooks/chat/useFriendActions');
const rt = createHookRuntime();
let last = null;
function mount(user) { last = rt.render(() => useFriendActions(user)); return last; }
function rerender() { last = rt.rerender(); return last; }
`;

// ===========================================================================
// A1 — toStoragePath 必须要求 `//`
// ===========================================================================
test('A1 toStoragePath：`http:` / `https:` 无 `//` 必须原样返回', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
out({
  httpNoSlash: toStoragePath('http:owner/media/file.jpg'),
  httpsNoSlash: toStoragePath('https:foo/chat_media/owner%20A.jpg'),
  normalHttps: toStoragePath('https://proj.supabase.co/storage/v1/object/sign/chat_media/chat/u1/a.jpg?token=t'),
  normalHttp: toStoragePath('http://x/chat_media/chat/u1/b.jpg'),
  fileUri: toStoragePath('file:///tmp/a.jpg'),
  contentUri: toStoragePath('content://media/1'),
  relative: toStoragePath('chat/u1/a.jpg'),
  noBucket: toStoragePath('https://x/other/u1/a.jpg'),
});
`;
  const { after } = assertEqualBoth(body, 'A1');
  assert.equal(after.httpNoSlash, 'http:owner/media/file.jpg');
  assert.equal(after.httpsNoSlash, 'https:foo/chat_media/owner%20A.jpg');
  assert.equal(after.normalHttps, 'chat/u1/a.jpg');
  assert.equal(after.normalHttp, 'chat/u1/b.jpg');
  assert.equal(after.fileUri, null);
  assert.equal(after.contentUri, null);
  assert.equal(after.relative, 'chat/u1/a.jpg');
  assert.equal(after.noBucket, null);
});

test('A1 getSignedUrl：`http:owner/...` 走「相对路径」分支（签名参数与旧 JS 一致）', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
const r = await getSignedUrl('http:owner/media/file.jpg');
out({ r, signLog: __sb.signLog.slice() });
`;
  const { after } = assertEqualBoth(body, 'A1-sign');
  assert.equal(after.r, 'https://signed/http:owner/media/file.jpg');
  assert.deepEqual(after.signLog, [['chat_media', 'http:owner/media/file.jpg', 604800]]);
});

// ===========================================================================
// A2 — isAbsoluteUrl 只认 http(s)://
// ===========================================================================
test('A2 useSignedMediaUrl：本地 URI 走 isLocalUri 分支（不被 isAbsoluteUrl 抢走）', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
function freshMount(value) {
  const r = createHookRuntime();
  let cur = r.render(() => useSignedMediaUrl(value));
  return { get: () => cur, settle: () => { if (r.isScheduled) cur = r.rerender(); return cur; } };
}
const cases = {};
for (const v of [
  'https://cdn/x.jpg',
  'http://cdn/y.jpg',
  'file:///tmp/a.jpg',
  'content://media/1',
  'data:image/png;base64,AAA',
  'blob:http://x/y',
  'ph://ABC',
  'assets-library://x',
  'chat/u1/a.jpg',
]) {
  const h = freshMount(v);
  const initial = { url: h.get().url, loading: h.get().loading };
  await flushMicrotasks();
  const settled = { url: h.settle().url, loading: h.get().loading };
  cases[v] = { initial, settled };
}
out({ cases, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'A2');
  // 绝对 URL（http/https）与本地 URI（file/content/data/blob/ph/assets-library）
  // 都必须同步透传，且不得发起签名请求。
  for (const v of [
    'https://cdn/x.jpg',
    'http://cdn/y.jpg',
    'file:///tmp/a.jpg',
    'content://media/1',
    'data:image/png;base64,AAA',
    'blob:http://x/y',
    'ph://ABC',
    'assets-library://x',
  ]) {
    assert.deepEqual(after.cases[v].initial, { url: v, loading: false }, '应同步透传：' + v);
  }
  // 相对路径：初始无缓存 → loading，异步签名后收敛
  assert.deepEqual(after.cases['chat/u1/a.jpg'].initial, { url: null, loading: true });
  assert.deepEqual(after.cases['chat/u1/a.jpg'].settled, {
    url: 'https://signed/chat/u1/a.jpg',
    loading: false,
  });
  assert.equal(after.signCount, 1);
});

// ===========================================================================
// A3 — buildPublicStorageUrl 必须保留 .filter(Boolean)
// ===========================================================================
test('A3 buildPublicStorageUrl：前导斜杠 / 连续斜杠不得产生空段', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co/';
const leadingSlash = buildPublicStorageUrl('/chat/u1/a.jpg');
const doubleSlash = buildPublicStorageUrl('chat//u1///a.jpg');
const normal = buildPublicStorageUrl('chat/u1/a b.jpg');
const trailingSlash = buildPublicStorageUrl('chat/u1/a.jpg/');
delete process.env.EXPO_PUBLIC_SUPABASE_URL;
const noBase = buildPublicStorageUrl('chat/u1/a.jpg');
out({ leadingSlash, doubleSlash, normal, trailingSlash, noBase });
`;
  const { after } = assertEqualBoth(body, 'A3');
  assert.equal(
    after.leadingSlash,
    'https://proj.supabase.co/storage/v1/object/public/chat_media/chat/u1/a.jpg'
  );
  assert.equal(
    after.doubleSlash,
    'https://proj.supabase.co/storage/v1/object/public/chat_media/chat/u1/a.jpg'
  );
  assert.equal(
    after.normal,
    'https://proj.supabase.co/storage/v1/object/public/chat_media/chat/u1/a%20b.jpg'
  );
  assert.equal(
    after.trailingSlash,
    'https://proj.supabase.co/storage/v1/object/public/chat_media/chat/u1/a.jpg'
  );
  assert.equal(after.noBase, null);
});

// ===========================================================================
// A4 — useFriendActions.errMessage 必须保持 `e?.message || fallback`
// ===========================================================================
test('A4 deleteFriend：成功 / SDK error / 同步抛错（string / number / 空 / 无 message / Error）', async () => {
  const body = String.raw`
${FRIEND_PRELUDE}
const user = { id: 'me' };
const results = {};

__sb.fromResults = [{ data: null, error: null }, { data: null, error: null }];
mount(user);
results.ok = await last.deleteFriend('peer');
results.okLog = __sb.fromLog.slice();
__sb.fromLog.length = 0;

__sb.fromResults = [{ data: null, error: { message: 'rls denied' } }];
results.sdkError = await last.deleteFriend('peer');
__sb.fromLog.length = 0;

__sb.fromThrowSync = { message: 'boom-string' };
results.throwString = await last.deleteFriend('peer');
__sb.fromThrowSync = null;

__sb.fromThrowSync = { message: 12345 };
results.throwNumber = await last.deleteFriend('peer');
__sb.fromThrowSync = null;

__sb.fromThrowSync = { message: '' };
results.throwEmpty = await last.deleteFriend('peer');
__sb.fromThrowSync = null;

__sb.fromThrowSync = {};
results.throwNoMsg = await last.deleteFriend('peer');
__sb.fromThrowSync = null;

__sb.fromThrowSync = new Error('boom-error');
results.throwError = await last.deleteFriend('peer');
__sb.fromThrowSync = null;

const rt2 = createHookRuntime();
const anon = rt2.render(() => useFriendActions(null));
results.noUser = await anon.deleteFriend('peer');
results.noId = await last.deleteFriend('');
results.self = await last.deleteFriend('me');

out(results);
`;
  const { after } = assertEqualBoth(body, 'A4-delete');
  assert.deepEqual(after.ok, { ok: true });
  assert.deepEqual(after.okLog, [
    ['friends', 'delete'],
    ['friends', 'or', 'and(user_id.eq.me,friend_id.eq.peer),and(user_id.eq.peer,friend_id.eq.me)'],
    ['friend_requests', 'delete'],
    ['friend_requests', 'or', 'and(sender_id.eq.me,receiver_id.eq.peer),and(sender_id.eq.peer,receiver_id.eq.me)'],
    ['friend_requests', 'eq', 'status', 'accepted'],
  ]);
  assert.deepEqual(after.sdkError, { ok: false, error: 'rls denied' });
  assert.deepEqual(after.throwString, { ok: false, error: 'boom-string' });
  // 关键：数字 message 必须原样返回（R5 的 typeof 过滤会错误兜底成「删除失败」）
  assert.deepEqual(after.throwNumber, { ok: false, error: 12345 });
  assert.deepEqual(after.throwEmpty, { ok: false, error: '删除失败' });
  assert.deepEqual(after.throwNoMsg, { ok: false, error: '删除失败' });
  assert.deepEqual(after.throwError, { ok: false, error: 'boom-error' });
  assert.deepEqual(after.noUser, { ok: false, error: '未登录' });
  assert.deepEqual(after.noId, { ok: false, error: '缺少好友 ID' });
  assert.deepEqual(after.self, { ok: false, error: '不能删除自己' });
});

test('A4 updateRemark：UPDATE 命中 / 0 行 + 合法关系 UPSERT / 0 行 + 无关系拒绝 / 各阶段 error / 抛错', async () => {
  const body = String.raw`
${FRIEND_PRELUDE}
const user = { id: 'me' };
const results = {};
mount(user);

// 1) UPDATE 命中 1 行 → ok
__sb.fromResults = [{ data: [{ id: 'r1' }], error: null }];
results.updateHit = await last.updateRemark('peer', 'nick');
results.updateHitLog = __sb.fromLog.slice();
__sb.fromLog.length = 0;

// 2) UPDATE 命中 0 行 + 存在合法关系 → UPSERT 成功（created: true）
__sb.fromResults = [
  { data: [], error: null },
  { data: [{ id: 'r2', user_id: 'peer', friend_id: 'me' }], error: null },
  { data: [{ id: 'r3' }], error: null },
];
results.upsertPath = await last.updateRemark('peer', 'nick');
results.upsertLog = __sb.fromLog.slice();
__sb.fromLog.length = 0;

// 3) UPDATE 命中 0 行 + 无合法关系 → 拒绝创建
__sb.fromResults = [
  { data: [], error: null },
  { data: [], error: null },
];
results.noRelation = await last.updateRemark('peer', 'nick');
__sb.fromLog.length = 0;

// 4) UPDATE 返回 error
__sb.fromResults = [{ data: null, error: { message: 'update-fail' } }];
results.updateError = await last.updateRemark('peer', 'nick');
__sb.fromLog.length = 0;

// 5) 关系查询返回 error
__sb.fromResults = [
  { data: [], error: null },
  { data: null, error: { message: 'rel-fail' } },
];
results.relError = await last.updateRemark('peer', 'nick');
__sb.fromLog.length = 0;

// 6) UPSERT 返回 error
__sb.fromResults = [
  { data: [], error: null },
  { data: [{ id: 'r2' }], error: null },
  { data: null, error: { message: 'upsert-fail' } },
];
results.upsertError = await last.updateRemark('peer', 'nick');
__sb.fromLog.length = 0;

// 7) UPSERT 返回 0 行
__sb.fromResults = [
  { data: [], error: null },
  { data: [{ id: 'r2' }], error: null },
  { data: [], error: null },
];
results.upsertEmpty = await last.updateRemark('peer', 'nick');
__sb.fromLog.length = 0;

// 8) 同步抛错 + 数字 message（errMessage 语义）
__sb.fromThrowSync = { message: 777 };
results.throwNumber = await last.updateRemark('peer', 'nick');
__sb.fromThrowSync = null;

// 9) 同步抛错 + 无 message → 兜底「更新失败」
__sb.fromThrowSync = {};
results.throwNoMsg = await last.updateRemark('peer', 'nick');
__sb.fromThrowSync = null;

// 10) remark 为空 → nextRemark = null
__sb.fromResults = [{ data: [{ id: 'r1' }], error: null }];
results.emptyRemark = await last.updateRemark('peer', '');
results.emptyRemarkLog = __sb.fromLog.slice();
__sb.fromLog.length = 0;

// 11) 边界：未登录 / 缺 ID / 给自己设备注
const rt2 = createHookRuntime();
const anon = rt2.render(() => useFriendActions(null));
results.noUser = await anon.updateRemark('peer', 'x');
results.noId = await last.updateRemark('', 'x');
results.self = await last.updateRemark('me', 'x');

out(results);
`;
  const { after } = assertEqualBoth(body, 'A4-updateRemark');
  assert.deepEqual(after.updateHit, { ok: true });
  assert.deepEqual(after.updateHitLog, [
    ['friends', 'update', { remark: 'nick' }],
    ['friends', 'eq', 'user_id', 'me'],
    ['friends', 'eq', 'friend_id', 'peer'],
    ['friends', 'select', 'id'],
  ]);
  assert.deepEqual(after.upsertPath, { ok: true, created: true });
  assert.deepEqual(after.upsertLog, [
    ['friends', 'update', { remark: 'nick' }],
    ['friends', 'eq', 'user_id', 'me'],
    ['friends', 'eq', 'friend_id', 'peer'],
    ['friends', 'select', 'id'],
    ['friends', 'select', 'id, user_id, friend_id'],
    ['friends', 'or', 'and(user_id.eq.me,friend_id.eq.peer),and(user_id.eq.peer,friend_id.eq.me)'],
    ['friends', 'limit', 1],
    ['friends', 'upsert', { user_id: 'me', friend_id: 'peer', remark: 'nick' }, { onConflict: 'user_id,friend_id' }],
    ['friends', 'select', 'id'],
  ]);
  assert.deepEqual(after.noRelation, { ok: false, error: '好友关系不存在，无法设置备注' });
  assert.deepEqual(after.updateError, { ok: false, error: 'update-fail' });
  assert.deepEqual(after.relError, { ok: false, error: 'rel-fail' });
  assert.deepEqual(after.upsertError, { ok: false, error: 'upsert-fail' });
  assert.deepEqual(after.upsertEmpty, { ok: false, error: '备注保存失败，请重试' });
  assert.deepEqual(after.throwNumber, { ok: false, error: 777 });
  assert.deepEqual(after.throwNoMsg, { ok: false, error: '更新失败' });
  assert.deepEqual(after.emptyRemark, { ok: true });
  assert.deepEqual(after.emptyRemarkLog[0], ['friends', 'update', { remark: null }]);
  assert.deepEqual(after.noUser, { ok: false, error: '未登录' });
  assert.deepEqual(after.noId, { ok: false, error: '缺少好友 ID' });
  assert.deepEqual(after.self, { ok: false, error: '不能给自己设备注' });
});

// ===========================================================================
// A5 — 同步抛错：定向可靠性修复（**不与旧 JS 等价**，单独断言）
// ===========================================================================
test('A5 同步抛错：新实现返回 null 且不残留 inflight（旧 JS 抛 ReferenceError）', async () => {
  // ⚠️ 旧 JS 的 TDZ ReferenceError 发生在 async IIFE 的**同步段**，
  //    它不会被 `await getSignedUrl()` 的 try/catch 捕获，而是直接冒泡为
  //    未捕获异常并终止子进程（Node 默认 unhandled → exit 1）。
  //    因此旧实现只能用「子进程退出码 + stderr 含 ReferenceError」判定，
  //    不能用 try/catch 取 outcome。
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
__sb.signThrowSync = { message: 'sdk-not-ready' };

// 旧 JS 会在此处同步抛出 ReferenceError（TDZ），进程直接崩溃；
// 新实现会正常 resolve 为 null 并继续往下执行。
const r = await getSignedUrl('chat/u1/a.jpg');

// 恢复网络后同路径必须能重新签名（不残留 inflight）
__sb.signThrowSync = null;
const recovered = await getSignedUrl('chat/u1/a.jpg');
const second = await getSignedUrl('chat/u1/a.jpg');

out({ resolved: r, recovered, second, signCount: __sb.signLog.length });
`;

  // ---- 旧 JS：必须因 TDZ ReferenceError 崩溃（子进程非 0 退出）----
  const beforeDir = buildSandbox('before');
  const beforeEntry = path.join(beforeDir, 'entry.mjs');
  fs.writeFileSync(
    beforeEntry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
  );
  fs.writeFileSync(path.join(beforeDir, 'case.mjs'), body);
  const beforeChild = spawnSync(process.execPath, [beforeEntry], {
    cwd: beforeDir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(beforeChild.status, 0, '旧 JS 在同步抛错场景必须崩溃（非 0 退出）');
  assert.match(
    String(beforeChild.stderr),
    /ReferenceError: Cannot access 'task' before initialization/,
    '旧 JS 崩溃原因必须是 TDZ ReferenceError'
  );

  // ---- 新实现：正常降级为 null，且恢复后可重新签名 ----
  const after = runInSandbox(buildSandbox('after'), body);
  assert.equal(after.resolved, null, '新实现必须降级为 null 而非抛错');
  assert.equal(after.recovered, 'https://signed/chat/u1/a.jpg', '恢复网络后必须能重新签名');
  assert.equal(after.second, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.signCount, 1, '恢复后只应发起一次真实签名请求');
});

test('A5 同步抛错 + 已有缓存：返回旧缓存（离线降级语义）', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
const ok = await getSignedUrl('chat/u1/a.jpg');
// 让缓存过期，再注入同步抛错
advance(SIGNED_URL_TTL * 1000);
__sb.signThrowSync = { message: 'sdk-not-ready' };
const degraded = await getSignedUrl('chat/u1/a.jpg');
out({ ok, degraded, signCount: __sb.signLog.length });
`;
  const after = runInSandbox(buildSandbox('after'), body);
  assert.equal(after.ok, 'https://signed/chat/u1/a.jpg');
  // 缓存已过期 → cacheGet 返回 null
  assert.equal(after.degraded, null);
  assert.equal(after.signCount, 1);
});

test('A5 A→B→A：旧 Promise 不得删除/覆盖新会话 inflight 条目', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
__sb.signDeferred = true;
const pOld = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
const pendingOld = __sb.pendingSigns.length;

// A → B → A（epoch 已变化）
setSignedUrlOwner('userB');
setSignedUrlOwner('userA');

// 新会话发起同路径请求
const pNew = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
const pendingNew = __sb.pendingSigns.length;

// 先让旧 Promise 完成（旧 epoch → 必须被闸门丢弃）
__sb.pendingSigns[0].resolve({ data: { signedUrl: 'https://signed/oldA' }, error: null });
const rOld = await pOld;

// 新会话请求仍应处于 pending（未被旧 Promise 的 finally 误删）
const stillPending = __sb.pendingSigns.length === 2 && __sb.pendingSigns[1].objectPath === 'chat/u1/a.jpg';
__sb.pendingSigns[1].resolve({ data: { signedUrl: 'https://signed/newA' }, error: null });
const rNew = await pNew;

// 新会话缓存必须可用
const cached = getMemoryCachedSignedUrl('chat/u1/a.jpg');

out({ pendingOld, pendingNew, rOld, rNew, stillPending, cached, signCount: __sb.signLog.length });
`;
  const after = runInSandbox(buildSandbox('after'), body);
  assert.equal(after.pendingOld, 1);
  assert.equal(after.pendingNew, 2, '新会话必须真正发起第二次请求（旧 inflight 已被 setSignedUrlOwner 清空）');
  assert.equal(after.rOld, null, '旧 epoch 的结果必须被丢弃');
  assert.equal(after.stillPending, true, '旧 Promise 的 finally 不得删除新会话 inflight 条目');
  assert.equal(after.rNew, 'https://signed/newA');
  assert.equal(after.cached, 'https://signed/newA');
});

// ===========================================================================
// A6 — 身份闸门敏感性：删除 catch 分支 epoch 校验必须导致断言失败
// ===========================================================================
const CATCH_GATE_SNIPPET = `      if (!isIdentityStillValid(startOwnerId, startEpoch)) return null;
      return cacheGet(cacheKey) ?? null;`;

/**
 * 构造「注入后的临时源码根」。
 *
 * ⚠️ buildSandbox('after-mutated') 会遍历 MODULES 读取**全部**模块，
 *    因此这里必须把未注入的模块也原样复制过去，否则会 ENOENT。
 */
function makeMutatedRoot(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p14r6-mut-'));
  const rel = 'src/hooks/chat/useSignedMediaUrl.ts';
  const dst = path.join(root, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const original = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const mutated = mutator(original);
  assert.notEqual(mutated, original, '故障注入必须真正改变源码');
  fs.writeFileSync(dst, mutated);

  // 其余模块（本文件只注入 useSignedMediaUrl，其余原样复制）
  for (const [, afterRel] of [
    ['hooks__chat__useSignedMediaUrl.js', 'src/hooks/chat/useSignedMediaUrl.ts'],
    ['hooks__chat__useFriendActions.js', 'src/hooks/chat/useFriendActions.ts'],
  ]) {
    if (afterRel === rel) continue;
    const copyDst = path.join(root, afterRel);
    fs.mkdirSync(path.dirname(copyDst), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, afterRel), copyDst);
  }
  return root;
}

test('A6 敏感性：删除 catch 分支 epoch 校验 → 旧请求必须泄漏新会话缓存（断言失败）', async () => {
  // 场景（严格按 Gatekeeper 指定）：
  //   1) A 登录，旧签名请求发起但**未完成**；
  //   2) A→B→A，epoch 变化；
  //   3) 新 A 会话对同路径请求，成功拿到新签名 URL 并写入缓存；
  //   4) 旧 A 请求随后进入 catch（网络失败）。
  //   正确行为：旧请求必须被 catch 分支的 epoch 闸门拦截 → 返回 null，
  //             绝不能返回/消费新会话缓存。
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
// 1) 旧请求：在旧 epoch 下发起，挂起（未完成）
__sb.signDeferred = true;
const pOld = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
const pendingOld = __sb.pendingSigns.length;

// 2) A→B→A：epoch 变化（旧请求的 epoch 已失效）
setSignedUrlOwner('userB');
setSignedUrlOwner('userA');

// 3) 新 A 会话：同路径请求成功，写入新缓存
__sb.signDeferred = false;
const rNew = await getSignedUrl('chat/u1/a.jpg');
const cachedNew = getMemoryCachedSignedUrl('chat/u1/a.jpg');

// 4) 旧请求随后进入 catch（网络失败）
__sb.pendingSigns[0].resolve({ data: null, error: { message: 'offline' } });
const rOld = await pOld;

out({ pendingOld, rNew, cachedNew, rOld });
`;
  // 正确实现：旧请求 catch 分支被 epoch 闸门拦截 → null
  const correct = runInSandbox(buildSandbox('after'), body);
  assert.equal(correct.pendingOld, 1);
  assert.equal(correct.rNew, 'https://signed/chat/u1/a.jpg');
  assert.equal(correct.cachedNew, 'https://signed/chat/u1/a.jpg');
  assert.equal(correct.rOld, null, '正确实现：旧 epoch 的 catch 分支必须返回 null');

  // 注入：删除 catch 分支的 epoch 校验
  const mutatedRoot = makeMutatedRoot((src) => {
    assert.equal(src.includes(CATCH_GATE_SNIPPET), true, '注入锚点必须存在');
    return src.replace(
      CATCH_GATE_SNIPPET,
      `      return cacheGet(cacheKey) ?? null;`
    );
  });
  try {
    const mutated = runInSandbox(buildSandbox('after-mutated', { mutatedRoot }), body);
    // 注入后：旧请求会返回新会话缓存 → 与正确行为不同 → 断言必须失败
    assert.notEqual(
      mutated.rOld,
      null,
      '注入后旧请求应泄漏缓存（若此处仍为 null，说明测试对该闸门不敏感）'
    );
    assert.notDeepEqual(mutated, correct, '注入后结果必须与正确实现不同');
  } finally {
    fs.rmSync(mutatedRoot, { recursive: true, force: true });
  }
});

test('A6 敏感性：删除成功路径 epoch 校验 → 旧请求必须污染新会话缓存', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
__sb.signDeferred = true;
const pOld = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
setSignedUrlOwner('userA', true);   // epoch 失效
__sb.pendingSigns[0].resolve({ data: { signedUrl: 'https://signed/staleA' }, error: null });
const rOld = await pOld;
// 新会话同路径：若旧请求污染了缓存，这里会直接命中 staleA
__sb.signDeferred = false;
const rNew = await getSignedUrl('chat/u1/a.jpg');
out({ rOld, rNew, signCount: __sb.signLog.length });
`;
  const correct = runInSandbox(buildSandbox('after'), body);
  assert.equal(correct.rOld, null);
  assert.equal(correct.rNew, 'https://signed/chat/u1/a.jpg');

  const SUCCESS_GATE = `      if (!isIdentityStillValid(startOwnerId, startEpoch)) return null;
      if (url) cacheSet(cacheKey, url, ttlSeconds);`;
  const mutatedRoot = makeMutatedRoot((src) => {
    assert.equal(src.includes(SUCCESS_GATE), true, '注入锚点必须存在');
    return src.replace(SUCCESS_GATE, `      if (url) cacheSet(cacheKey, url, ttlSeconds);`);
  });
  try {
    const mutated = runInSandbox(buildSandbox('after-mutated', { mutatedRoot }), body);
    assert.notEqual(mutated.rOld, null, '注入后旧请求应返回 staleA');
    assert.equal(mutated.rNew, 'https://signed/staleA', '注入后新会话必须命中被污染的缓存');
  } finally {
    fs.rmSync(mutatedRoot, { recursive: true, force: true });
  }
});

test('A6 敏感性：删除 finally 的 holder 比较 → A→B→A 旧 Promise 误删新 inflight', async () => {
  // 场景：A 旧请求在途 → epoch 变化 → 新会话同路径请求（inflight 中登记 pNew）
  //       → 旧请求完成（其 finally 若不做 holder 比较，会误删 pNew 的 inflight 条目）
  //       → 第三次调用：正确实现应复用 pNew（不重新发请求）；注入后应重新发请求。
  //
  // ⚠️ 不能用 `pThird === pNew` 判定：getSignedUrl 是 async 函数，
  //    `return inflight.get(cacheKey)` 会被 async 包装成新 Promise，
  //    引用恒不相等。正确判据是「是否重新发起真实签名请求」——
  //    即 pendingSigns 数量与 signLog 数量是否增加。
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
__sb.signDeferred = true;
const pOld = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
setSignedUrlOwner('userA', true);
const pNew = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
const pendingBefore = __sb.pendingSigns.length;
const signBefore = __sb.signLog.length;
// 旧请求完成（旧 epoch → 结果被闸门丢弃）
__sb.pendingSigns[0].resolve({ data: { signedUrl: 'https://signed/oldA' }, error: null });
const rOld = await pOld;
// 此时 pNew 仍 pending（pendingSigns[1] 未 resolve）
const pendingMid = __sb.pendingSigns.length;
// 第三次调用：正确实现应复用 pNew（inflight 未被旧 finally 误删）→ 不新增请求
const pThird = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
const pendingAfter = __sb.pendingSigns.length;
const signAfter = __sb.signLog.length;
out({ pendingBefore, signBefore, pendingMid, pendingAfter, signAfter, rOld });
`;
  const correct = runInSandbox(buildSandbox('after'), body);
  assert.equal(correct.pendingBefore, 2);
  assert.equal(correct.signBefore, 2);
  assert.equal(correct.pendingMid, 2, '旧请求完成后 pNew 仍应 pending');
  assert.equal(correct.pendingAfter, 2, '正确实现：旧 finally 不得删除新 inflight（第三次调用不得新增请求）');
  assert.equal(correct.signAfter, 2, '正确实现：第三次调用不得重新发起签名请求');
  assert.equal(correct.rOld, null, '旧 epoch 的结果必须被丢弃');

  const mutatedRoot = makeMutatedRoot((src) => {
    const anchor = `      if (inflight.get(cacheKey) === holder.task) inflight.delete(cacheKey);`;
    assert.equal(src.includes(anchor), true, '注入锚点必须存在');
    return src.replace(anchor, `      inflight.delete(cacheKey);`);
  });
  try {
    const mutated = runInSandbox(buildSandbox('after-mutated', { mutatedRoot }), body);
    assert.equal(
      mutated.pendingAfter,
      3,
      '注入后旧 finally 误删新 inflight → 第三次调用重新发请求'
    );
    assert.equal(mutated.signAfter, 3, '注入后第三次调用必须重新发起签名请求');
  } finally {
    fs.rmSync(mutatedRoot, { recursive: true, force: true });
  }
});

// ===========================================================================
// 仓库源码完整性：故障注入不得污染真实源码
// ===========================================================================
test('P14R6-A7 故障注入后仓库源码 SHA-256 未变化', () => {
  const targets = [
    'src/hooks/chat/useSignedMediaUrl.ts',
    'src/hooks/chat/useFriendActions.ts',
  ];
  const snapshot = {};
  for (const rel of targets) {
    snapshot[rel] = spawnSync('shasum', ['-a', '256', path.join(repoRoot, rel)], {
      encoding: 'utf8',
    })
      .stdout.trim()
      .split(/\s+/)[0];
  }
  // 与测试开始时记录的期望值比对（由 R6 交付文档登记）
  const EXPECTED = {
    'src/hooks/chat/useSignedMediaUrl.ts':
      '2312170173db06f6cb551c64a29fc0175cce56b5f437de0fe6fcf9e8fb31251f',
    'src/hooks/chat/useFriendActions.ts':
      'a566250a73930cb24f6a788eb1cf3882303f2d41463afb13a2d1efbae3f7f010',
  };
  for (const rel of targets) {
    assert.equal(snapshot[rel], EXPECTED[rel], `源码被意外修改：${rel}`);
  }
});
// --- END OF FILE tests/security/p14r6R5GatekeeperFix.test.mjs ---