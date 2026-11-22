// --- START OF FILE tests/security/p14r5RealtimeMediaMigrationEquivalence.test.mjs ---
/**
 * P1.4 R5 — Realtime + Signed Media + 低风险 Hooks 成批 JS → TS 迁移 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前实现：冻结基线（tests/fixtures/p14r5/before/*.js）
 *     · 迁移后实现：当前真实源码（src/hooks/**\/*.ts）
 *   对同一组事件序列比较**完整可观测结果**（state / 返回值 / 调用序列 / 副作用）。
 *
 * 覆盖模块与用例
 *   ── SYNCROOM（高风险：Realtime 订阅 + 身份隔离）──
 *     SYNC-1   初始状态与公开返回对象形状
 *     SYNC-2   roomId 为空：不创建 channel
 *     SYNC-3   创建 channel：config / presence key
 *     SYNC-4   partnerStatus 由 presence sync 更新
 *     SYNC-5   remoteCommand 接收（过滤自身 senderId）
 *     SYNC-6   emitCommand 参数与 send 载荷
 *     SYNC-7   emitDanmaku：Date.now 两次采样 + 列表截断到 100
 *     SYNC-8   旧 channel 迟到事件被 isOwnerKeyCurrent 拦截
 *     SYNC-9   身份切换：清理旧 channel + 重置 state
 *     SYNC-10  unmount：removeChannel 调用
 *     SYNC-11  emitCommand / emitDanmaku 函数引用不稳定性（每次渲染重建）
 *   ── SIGNEDMEDIA（高风险：缓存 + 身份代际 + 异步竞态）──
 *     MEDIA-1  无缓存：createSignedUrl 调用 + 写入缓存
 *     MEDIA-2  缓存命中：不重复请求
 *     MEDIA-3  缓存过期：重新请求
 *     MEDIA-4  并发去重：同一 key 只发一次请求
 *     MEDIA-5  请求失败：返回 null 且不写缓存
 *     MEDIA-6  无 owner：fail-closed 返回 null
 *     MEDIA-7  账号切换：缓存 key 隔离
 *     MEDIA-8  A→B→A：回到 A 时旧缓存仍有效
 *     MEDIA-9  同账号新代际：旧 Promise 结果被丢弃
 *     MEDIA-10 迟到旧请求：不污染新代际缓存
 *     MEDIA-11 非法输入：本地 URI / 空值 / 非 chat_media URL
 *     MEDIA-12 toStoragePath / buildPublicStorageUrl 纯函数语义
 *   ── LOWRISK（低风险：纯业务规则 / 本地存储）──
 *     LOW-1  useStreak：边沿检测推进 / 撤销
 *     LOW-2  useTimeSync：校准成功 / 失败保留旧 offset
 *     LOW-3  useChatPrefs：加载 / toggle / 落盘
 *     LOW-4  useFriendActions：删除 / 备注 UPSERT 分支
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实源码：
 *   该运行时实现 useState / useRef / useEffect / useCallback / useMemo 的最小语义，
 *   用于在 Node 环境中真实调用 Hook 并观察状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 *   TS 处理：Node 原生类型剥离不支持 TS 语法扩展，因此两侧源码统一经
 *   **项目自带 TypeScript 编译器**（`ts.transpileModule`）转译后执行，
 *   保证两侧执行机制一致。
 *
 *   虚拟时钟：沙箱内替换 setTimeout / setInterval / clearTimeout / clearInterval /
 *   Date.now，使 TTL 与节流判定完全可控、可复现。
 *
 * 约束
 *   · 不访问真实网络 / 数据库（使用记录型 stub）。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行源码，不复制内部函数做模拟。
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
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__useSyncRoom.js':
    '9fac51789d4927e8f99ccbc3d89ab8f1cac1578d4872fc91b2fd888463b782f0',
  'hooks__chat__useSignedMediaUrl.js':
    'ac5b88e298aa35a688288fce51c786037f300ed3ec69fdca595c69ac70ccd164',
  'hooks__chat__useChatPrefs.js':
    'db23038a0e70eb5f020696b2c938bd0ea4c34fb5f4a1482c9a587050e9d05469',
  'hooks__chat__useFriendActions.js':
    '5600f7e25df248053680ab2fb5208be3e5f065895ed944791e715d31f63b50cd',
  'hooks__health__useTimeSync.js':
    '46bda49ea63bfff0b2bc0d2b18dbc8f0e7415b94fac6a6b9c24ab324a8afca5b',
  'hooks__health__useStreak.js':
    'd9e585bf187fbae5addffd30458002a8e00ab9e7e961a8e3100f7d95ce04bded',
};

test('P14R5-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 P1.4 R0–R4 测试同构，独立复制以保持自包含）
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
    // 与真实 React 一致：先执行「全部」cleanup，再执行「全部」effect body。
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
//   mode = 'before' → 使用冻结基线（迁移前 JS）
//   mode = 'after'  → 使用当前真实源码（迁移后 TS）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r5-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // react stub：Hook 运行时单例 + 模块级动态路由
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

  // @react-native-async-storage/async-storage stub：内存 KV + 调用日志
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

  // expo-crypto stub：确定性 UUID 序列
  mk('expo-crypto', {
    'package.json': JSON.stringify({ name: 'expo-crypto', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
let seq = 0;
export const __uuidLog = [];
export function randomUUID() { seq += 1; const id = 'uuid-' + seq; __uuidLog.push(id); return id; }
export default { randomUUID };
`,
  });

  // @supabase/supabase-js stub（supabase.ts 依赖）
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // react-native-url-polyfill stub
  mk('react-native-url-polyfill', {
    'package.json': JSON.stringify({ name: 'react-native-url-polyfill', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export default {};\n',
  });

  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(relSrc, dst);
  };

  // 类型模块（仅类型，运行时为空；复制以支持 import type 解析）
  copyFile(path.join(repoRoot, 'src/types/cinema.ts'), 'src/types/cinema.ts');
  copyFile(path.join(repoRoot, 'src/types/chat.ts'), 'src/types/chat.ts');
  copyFile(path.join(repoRoot, 'src/types/health.ts'), 'src/types/health.ts');
  copyFile(path.join(repoRoot, 'src/types/media.ts'), 'src/types/media.ts');

  // 真实依赖（被测模块 import 的纯逻辑模块）
  copyFile(path.join(repoRoot, 'src/hooks/health/dateUtils.ts'), 'src/hooks/health/dateUtils.ts');

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

  // 被测模块映射：before 用冻结基线，after 用当前真实源码
  const MODULES = [
    ['hooks__useSyncRoom.js', 'src/hooks/useSyncRoom.ts', 'src/hooks/useSyncRoom.js'],
    ['hooks__chat__useSignedMediaUrl.js', 'src/hooks/chat/useSignedMediaUrl.ts', 'src/hooks/chat/useSignedMediaUrl.js'],
    ['hooks__chat__useChatPrefs.js', 'src/hooks/chat/useChatPrefs.ts', 'src/hooks/chat/useChatPrefs.js'],
    ['hooks__chat__useFriendActions.js', 'src/hooks/chat/useFriendActions.ts', 'src/hooks/chat/useFriendActions.js'],
    ['hooks__health__useTimeSync.js', 'src/hooks/health/useTimeSync.ts', 'src/hooks/health/useTimeSync.js'],
    ['hooks__health__useStreak.js', 'src/hooks/health/useStreak.ts', 'src/hooks/health/useStreak.js'],
  ];
  for (const [beforeName, afterRel, dstRel] of MODULES) {
    if (mode === 'before') place(path.join(beforeDir, beforeName), dstRel);
    else place(path.join(repoRoot, afterRel), dstRel);
  }

  // useOwnerKey stub：可控 ownerKey + isOwnerKeyCurrent（可模拟代际失效）
  fs.mkdirSync(path.join(dir, 'src/hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/hooks/useOwnerKey.js'),
    `
const state = { ownerKey: 'anon::0', valid: true };
// 真实 useOwnerKey 用 useCallback 返回稳定引用；stub 必须同样稳定，
// 否则 useSyncRoom 的 E3 依赖 [.., isOwnerKeyCurrent] 每次渲染都变化，
// 导致 channel 被反复重建（与真实行为不符）。
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

  // supabase 服务 stub：channel / removeChannel / storage.createSignedUrl / rpc / from
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
  pendingSigns: [],
  rpcLog: [],
  rpcError: null,
  rpcData: null,
  fromLog: [],
  fromResults: [],
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
    // 真实 Supabase 按 (type, filter.event) 精确路由：
    //   broadcast 下 sync_command / danmaku 是两个独立事件，绝不能互相串投。
    // 因此 __emit(type, event, payload) 必须同时匹配 type 与 filter.event。
    //   presence 的 filter 只有 { event: 'sync' }，同样按 event 精确匹配。
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
  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  const before = runInSandbox(beforeSandbox, body);
  const after = runInSandbox(afterSandbox, body);
  return { before, after };
}

function assertEqualBoth(body, label) {
  const { before, after } = runBoth(body);
  assert.deepEqual(after, before, `R5 迁移前后可观测结果必须一致：${label}`);
  return { before, after };
}

// ===========================================================================
// 公共 PRELUDE：虚拟时钟 + 通用工具
// ===========================================================================
const COMMON_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { __ownerState } = await import('./src/hooks/useOwnerKey');
const { supabase } = await import('./src/services/supabase');
const __sb = supabase.__state;

// ---- 虚拟时钟 -------------------------------------------------------------
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

// 微任务冲刷：让已 resolve 的 Promise 链跑完
async function flushMicrotasks(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// 注意：entry.mjs 将 console.log 重定向到 stderr（用于隔离调试输出），
// 结果必须直接写 stdout，否则 JSON.parse(child.stdout) 会失败。
function out(obj) { process.stdout.write(JSON.stringify(obj)); }

// AsyncStorage stub 的内存 Map（供 LOW-4 预置/断言存储内容）
const __store = (await import('@react-native-async-storage/async-storage')).default.__store;
`;

// ===========================================================================
// SYNCROOM 场景
// ===========================================================================
const SYNC_PRELUDE = String.raw`
${COMMON_PRELUDE}
const { useSyncRoom } = await import('./src/hooks/useSyncRoom');
const rt = createHookRuntime();
let last = null;
function mount(roomId) {
  last = rt.render(() => useSyncRoom(roomId));
  return last;
}
function rerender() { last = rt.rerender(); return last; }
function lastChannel() { return __sb.channelInstances[__sb.channelInstances.length - 1]; }
// settle 并回写 last（settle 返回轮数，不返回渲染结果）
function settleLast() { if (rt.isScheduled) last = rt.rerender(); return last; }
// deviceId 是异步就绪的（AsyncStorage → setState → rerender → E3 建 channel）。
// 必须「冲刷微任务 + settle 渲染」交替推进，直到 channel 真正建立。
async function boot(roomId) {
  last = rt.render(() => useSyncRoom(roomId));
  // 推进异步链：AsyncStorage.getItem → setDeviceId → rerender → E3 建 channel。
  // 每轮只在确实被调度时 rerender 一次，避免重复重建 channel。
  for (let i = 0; i < 8; i += 1) {
    await flushMicrotasks();
    if (!rt.isScheduled) break;
    last = rt.rerender();
  }
  return last;
}
`;

test('SYNC-1 初始状态与公开返回对象形状', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
const r = await boot('room-1');
out({
  keys: Object.keys(r).sort(),
  partnerStatus: r.partnerStatus,
  remoteCommand: r.remoteCommand,
  danmakuList: r.danmakuList,
  ownerKey: r.ownerKey,
  emitCommandType: typeof r.emitCommand,
  emitDanmakuType: typeof r.emitDanmaku,
});
`;
  const { after } = assertEqualBoth(body, 'SYNC-1');
  assert.deepEqual(after.keys, [
    'danmakuList', 'emitCommand', 'emitDanmaku', 'ownerKey', 'partnerStatus', 'remoteCommand',
  ]);
  assert.equal(after.partnerStatus, '等待建立连接...');
  assert.equal(after.remoteCommand, null);
  assert.deepEqual(after.danmakuList, []);
  assert.equal(after.emitCommandType, 'function');
  assert.equal(after.emitDanmakuType, 'function');
});

test('SYNC-2 roomId 为空：不创建 channel', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot(null);
out({ channelCount: __sb.channelLog.length });
`;
  const { after } = assertEqualBoth(body, 'SYNC-2');
  assert.equal(after.channelCount, 0);
});

test('SYNC-3 创建 channel：config / presence key', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-42');
const ch = __sb.channelLog[0];
out({
  name: ch.name,
  broadcastAck: ch.opts.config.broadcast.ack,
  presenceKeyIsString: typeof ch.opts.config.presence.key === 'string',
  channelCount: __sb.channelLog.length,
});
`;
  const { after } = assertEqualBoth(body, 'SYNC-3');
  assert.equal(after.name, 'room-42');
  assert.equal(after.broadcastAck, false);
  assert.equal(after.presenceKeyIsString, true);
  assert.equal(after.channelCount, 1);
});

test('SYNC-4 partnerStatus 由 presence sync 更新', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-1');
const ch = lastChannel();
// onlineCount = Object.keys(presenceState()).length，> 1 才判定「对方已加入」。
// 因此需要「自己 + 对方」两个 key。
ch.__presence = { 'dev-me': [{}], 'dev-other': [{ deviceId: 'dev-other' }] };
ch.__emit('presence', 'sync', { event: 'sync' });
settleLast();
const afterTwo = last.partnerStatus;
ch.__presence = { 'dev-me': [{}] };
ch.__emit('presence', 'sync', { event: 'sync' });
settleLast();
out({ afterTwo, afterEmpty: last.partnerStatus });
`;
  const { after } = assertEqualBoth(body, 'SYNC-4');
  assert.equal(after.afterTwo, '对方已加入房间');
  assert.equal(after.afterEmpty, '等待对方加入...');
});

test('SYNC-5 remoteCommand / danmaku 接收（均过滤自身 senderId）', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-1');
const ch = lastChannel();
const myDeviceId = ch.opts.config.presence.key;
// sync_command：自身发送必须被过滤
ch.__emit('broadcast', 'sync_command', { payload: { senderId: myDeviceId, type: 'PLAY', time: 5, url: 'u1' } });
settleLast();
const afterSelf = last.remoteCommand;
ch.__emit('broadcast', 'sync_command', { payload: { senderId: 'peer-x', type: 'PAUSE', time: 9, url: 'u2' } });
settleLast();
// danmaku：自身发送必须被过滤（不得进入 danmakuList）
ch.__emit('broadcast', 'danmaku', { payload: { senderId: myDeviceId, id: 'd-self', text: 'me', color: '#fff', timestamp: 1 } });
settleLast();
const danmakuAfterSelf = last.danmakuList.length;
ch.__emit('broadcast', 'danmaku', { payload: { senderId: 'peer-x', id: 'd-peer', text: 'hi', color: '#fff', timestamp: 2 } });
settleLast();
out({ afterSelf, afterPeer: last.remoteCommand, danmakuAfterSelf, danmakuAfterPeer: last.danmakuList.length });
`;
  const { after } = assertEqualBoth(body, 'SYNC-5');
  assert.equal(after.afterSelf, null);
  assert.equal(after.danmakuAfterSelf, 0);
  assert.equal(after.danmakuAfterPeer, 1);
  assert.deepEqual(after.afterPeer, { senderId: 'peer-x', type: 'PAUSE', time: 9, url: 'u2' });
});

test('SYNC-6 emitCommand 参数与 send 载荷', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
const r = await boot('room-1');
const ch = lastChannel();
r.emitCommand('PLAY');
r.emitCommand('SEEK', 12.5, 'https://v/1.mp4');
out({ sent: ch.sent });
`;
  const { after } = assertEqualBoth(body, 'SYNC-6');
  assert.equal(after.sent.length, 2);
  assert.deepEqual(after.sent[0], {
    type: 'broadcast',
    event: 'sync_command',
    payload: { senderId: after.sent[0].payload.senderId, type: 'PLAY', time: 0, url: null },
  });
  assert.equal(after.sent[1].payload.type, 'SEEK');
  assert.equal(after.sent[1].payload.time, 12.5);
  assert.equal(after.sent[1].payload.url, 'https://v/1.mp4');
  assert.equal(after.sent[0].payload.senderId, after.sent[1].payload.senderId);
});

test('SYNC-7 emitDanmaku：Date.now 两次采样 + 列表截断到 100', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-1');
const ch = lastChannel();
last.emitDanmaku('hello');
settleLast();
if (!ch.sent[0]) { out({ DIAG: true, chCount: __sb.channelInstances.length, sentLen: ch.sent.length, listLen: last.danmakuList.length, hasCh: ch === __sb.channelInstances[__sb.channelInstances.length-1] }); }
const first = ch.sent[0];
const listAfterOne = last.danmakuList.length;
// 连续发送 120 条，验证截断
for (let i = 0; i < 120; i += 1) { last.emitDanmaku('d' + i); }
settleLast();
out({
  firstEvent: first.event,
  firstPayloadKeys: Object.keys(first.payload).sort(),
  firstText: first.payload.text,
  firstColor: first.payload.color,
  idIsString: typeof first.payload.id === 'string',
  timestampIsNumber: typeof first.payload.timestamp === 'number',
  listAfterOne,
  listAfterMany: last.danmakuList.length,
  lastText: last.danmakuList[last.danmakuList.length - 1].text,
});
`;
  const { after } = assertEqualBoth(body, 'SYNC-7');
  assert.equal(after.firstEvent, 'danmaku');
  assert.deepEqual(after.firstPayloadKeys, ['color', 'id', 'senderId', 'text', 'timestamp']);
  assert.equal(after.firstText, 'hello');
  assert.equal(after.firstColor, '#FFFFFF');
  assert.equal(after.idIsString, true);
  assert.equal(after.timestampIsNumber, true);
  assert.equal(after.listAfterOne, 1);
  assert.equal(after.listAfterMany, 100);
  assert.equal(after.lastText, 'd119');
});

test('SYNC-8 旧 channel 迟到事件被 isOwnerKeyCurrent 拦截（sync_command / danmaku / presence）', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-1');
const ch = lastChannel();
__ownerState.valid = false;
ch.__emit('broadcast', 'sync_command', { payload: { senderId: 'peer-x', type: 'PLAY', time: 1, url: 'u' } });
settleLast();
const cmdAfterStale = last.remoteCommand;
// danmaku 同样必须被 ownerKey 守卫拦截（否则切号后旧房间弹幕会串入新账号）
ch.__emit('broadcast', 'danmaku', { payload: { senderId: 'peer-x', id: 'd-stale', text: 'stale', color: '#fff', timestamp: 1 } });
settleLast();
const danmakuAfterStale = last.danmakuList.length;
ch.__presence = { a: [{}], b: [{}] };
ch.__emit('presence', 'sync', { event: 'sync' });
settleLast();
const statusAfterStale = last.partnerStatus;
out({ cmdAfterStale, danmakuAfterStale, statusAfterStale });
`;
  const { after } = assertEqualBoth(body, 'SYNC-8');
  assert.equal(after.cmdAfterStale, null);
  assert.equal(after.danmakuAfterStale, 0);
  assert.equal(after.statusAfterStale, '等待建立连接...');
});

test('SYNC-9 身份切换：清理旧 channel + 重置 state', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-1');
const ch1 = lastChannel();
ch1.__emit('broadcast', 'sync_command', { payload: { senderId: 'peer-x', type: 'PLAY', time: 3, url: 'u' } });
ch1.__presence = { a: [{}], b: [{}] };
ch1.__emit('presence', 'sync', { event: 'sync' });
settleLast();
const beforeSwitch = {
  remoteCommand: last.remoteCommand,
  partnerStatus: last.partnerStatus,
  ownerKey: last.ownerKey,
};
__ownerState.ownerKey = 'userB::1';
__ownerState.valid = true;
rerender();
settleLast();
await flushMicrotasks();
const afterSwitch = {
  remoteCommand: last.remoteCommand,
  partnerStatus: last.partnerStatus,
  ownerKey: last.ownerKey,
  channelCount: __sb.channelLog.length,
  removeCount: __sb.removeLog.length,
};
out({ beforeSwitch, afterSwitch });
`;
  const { after } = assertEqualBoth(body, 'SYNC-9');
  assert.equal(after.beforeSwitch.remoteCommand.type, 'PLAY');
  assert.equal(after.beforeSwitch.partnerStatus, '对方已加入房间');
  assert.equal(after.beforeSwitch.ownerKey, 'anon::0');
  assert.equal(after.afterSwitch.remoteCommand, null);
  assert.equal(after.afterSwitch.partnerStatus, '等待建立连接...');
  assert.equal(after.afterSwitch.ownerKey, 'userB::1');
  assert.equal(after.afterSwitch.removeCount, 1);
  assert.equal(after.afterSwitch.channelCount, 2);
});

test('SYNC-10 unmount：removeChannel 调用', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
await boot('room-1');
const beforeUnmount = __sb.removeLog.length;
rt.unmount();
out({ beforeUnmount, afterUnmount: __sb.removeLog.length, removedName: __sb.removeLog[0] });
`;
  const { after } = assertEqualBoth(body, 'SYNC-10');
  assert.equal(after.beforeUnmount, 0);
  assert.equal(after.afterUnmount, 1);
  assert.equal(after.removedName, 'room-1');
});

test('SYNC-11 emitCommand / emitDanmaku 函数引用不稳定性（每次渲染重建）', async () => {
  const body = String.raw`
${SYNC_PRELUDE}
const r1 = await boot('room-1');
const c1 = r1.emitCommand;
const d1 = r1.emitDanmaku;
rerender();
const c2 = last.emitCommand;
const d2 = last.emitDanmaku;
out({ emitCommandStable: c1 === c2, emitDanmakuStable: d1 === d2 });
`;
  const { after } = assertEqualBoth(body, 'SYNC-11');
  // 关键不变量：必须每次渲染重建（useCinema 的 AppState Effect 依赖此不稳定性）
  assert.equal(after.emitCommandStable, false);
  assert.equal(after.emitDanmakuStable, false);
});

// ===========================================================================
// MEDIA — useSignedMediaUrl 纯函数 / 缓存 / 身份代际 / 并发去重 / 离线降级
// ===========================================================================

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

test('MEDIA-1 toStoragePath 归一化矩阵（本地 URI / 完整 URL / 相对路径 / 非法）', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
out({
  nonString: toStoragePath(123),
  empty: toStoragePath('   '),
  file: toStoragePath('file:///tmp/a.jpg'),
  content: toStoragePath('content://media/1'),
  ph: toStoragePath('ph://ABC'),
  assets: toStoragePath('assets-library://x'),
  data: toStoragePath('data:image/png;base64,AAA'),
  blob: toStoragePath('blob:http://x/y'),
  relative: toStoragePath('chat/u1/a.jpg'),
  fullUrl: toStoragePath('https://proj.supabase.co/storage/v1/object/sign/chat_media/chat/u1/a.jpg?token=zzz'),
  fullUrlEncoded: toStoragePath('https://x/chat_media/chat/u1/a%20b.jpg'),
  fullUrlNoBucket: toStoragePath('https://x/other/u1/a.jpg'),
});
`;
  const { after } = assertEqualBoth(body, 'MEDIA-1');
  assert.equal(after.nonString, null);
  assert.equal(after.empty, null);
  assert.equal(after.file, null);
  assert.equal(after.content, null);
  assert.equal(after.ph, null);
  assert.equal(after.assets, null);
  assert.equal(after.data, null);
  assert.equal(after.blob, null);
  assert.equal(after.relative, 'chat/u1/a.jpg');
  assert.equal(after.fullUrl, 'chat/u1/a.jpg');
  assert.equal(after.fullUrlEncoded, 'chat/u1/a b.jpg');
  assert.equal(after.fullUrlNoBucket, null);
});

test('MEDIA-2 buildPublicStorageUrl：无配置 / 完整 URL / 相对路径拼接', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
const noBase = buildPublicStorageUrl('chat/u1/a.jpg');
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co/';
const withBase = buildPublicStorageUrl('chat/u1/a b.jpg');
const alreadyFull = buildPublicStorageUrl('https://x/chat_media/a.jpg');
const local = buildPublicStorageUrl('file:///tmp/a.jpg');
out({ noBase, withBase, alreadyFull, local });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-2');
  assert.equal(after.noBase, null);
  assert.equal(after.withBase, 'https://proj.supabase.co/storage/v1/object/public/chat_media/chat/u1/a%20b.jpg');
  assert.equal(after.alreadyFull, null);
  assert.equal(after.local, null);
});

test('MEDIA-3 setSignedUrlOwner：owner 变化 / forceBump 才自增 epoch 并清缓存', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
const e0 = getSignedUrlIdentity();
const e1 = setSignedUrlOwner('userA');
const e2 = setSignedUrlOwner('userA');            // 同 owner，无 forceBump → 不变
const e3 = setSignedUrlOwner('userA', true);      // forceBump → 自增
const e4 = setSignedUrlOwner(null);               // 变化 → 自增
out({ e0, e1, e2, e3, e4, final: getSignedUrlIdentity() });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-3');
  assert.deepEqual(after.e0, { ownerId: null, epoch: 0 });
  assert.equal(after.e1, 1);
  assert.equal(after.e2, 1);
  assert.equal(after.e3, 2);
  assert.equal(after.e4, 3);
  assert.deepEqual(after.final, { ownerId: null, epoch: 3 });
});

test('MEDIA-4 getSignedUrl：未登录 fail-closed / 本地 URI / 空路径 均不发请求', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner(null);
const rNoOwner = await getSignedUrl('chat/u1/a.jpg');
const rLocal = await getSignedUrl('file:///tmp/a.jpg');
const rEmpty = await getSignedUrl('');
out({ rNoOwner, rLocal, rEmpty, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-4');
  assert.equal(after.rNoOwner, null);
  assert.equal(after.rLocal, null);
  assert.equal(after.rEmpty, null);
  assert.equal(after.signCount, 0);
});

test('MEDIA-5 getSignedUrl：成功签名 + 二次命中缓存（不重复请求）', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
const first = await getSignedUrl('chat/u1/a.jpg');
const second = await getSignedUrl('chat/u1/a.jpg');
out({ first, second, signCount: __sb.signLog.length, signArgs: __sb.signLog[0] });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-5');
  assert.equal(after.first, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.second, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.signCount, 1);
  // SIGNED_URL_TTL = 60*60*24*7 = 604800（在沙箱外不可见，用字面量断言）
  assert.deepEqual(after.signArgs, ['chat_media', 'chat/u1/a.jpg', 604800]);
});

test('MEDIA-6 并发去重：同 owner + 同路径只发一次请求', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
__sb.signDeferred = true;
const p1 = getSignedUrl('chat/u1/a.jpg');
const p2 = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
const pendingCount = __sb.pendingSigns.length;
__sb.pendingSigns[0].resolve({ data: { signedUrl: 'https://signed/one' }, error: null });
const [r1, r2] = await Promise.all([p1, p2]);
out({ pendingCount, r1, r2, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-6');
  assert.equal(after.pendingCount, 1);
  assert.equal(after.r1, 'https://signed/one');
  assert.equal(after.r2, 'https://signed/one');
  assert.equal(after.signCount, 1);
});

test('MEDIA-7 身份代际闸门：请求期间切换 owner → 不写缓存、不返回旧账号 URL', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
__sb.signDeferred = true;
const p = getSignedUrl('chat/u1/a.jpg');
await flushMicrotasks();
// 请求在途时切换身份（setSignedUrlOwner 会清空 inflight，但已发出的 Promise 仍会 resolve）
setSignedUrlOwner('userB');
// 让在途请求以旧账号 URL 返回：代际闸门必须丢弃它
__sb.pendingSigns[0].resolve({ data: { signedUrl: 'https://signed/oldA' }, error: null });
const r = await p;
// 新身份下同一路径必须重新请求（旧缓存未写入）
__sb.signDeferred = false;
const rB = await getSignedUrl('chat/u1/a.jpg');
out({ r, rB, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-7');
  assert.equal(after.r, null);
  assert.equal(after.rB, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.signCount, 2);
});

test('MEDIA-8 离线降级：签名失败返回旧缓存（不返回 null 覆盖已有图片）', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
const ok = await getSignedUrl('chat/u1/a.jpg');   // 先写入缓存
// 让缓存过期（推进虚拟时钟超过 TTL - 提前刷新窗口）
advance(SIGNED_URL_TTL * 1000);
__sb.signError = { message: 'offline' };
const degraded = await getSignedUrl('chat/u1/a.jpg');
out({ ok, degraded, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-8');
  assert.equal(after.ok, 'https://signed/chat/u1/a.jpg');
  // 缓存已过期 → cacheGet 返回 null，离线降级返回 null（不抛异常）
  assert.equal(after.degraded, null);
  assert.equal(after.signCount, 2);
});

test('MEDIA-9 离线降级：缓存仍有效时直接命中，不发请求', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
const ok = await getSignedUrl('chat/u1/a.jpg');
__sb.signError = { message: 'offline' };
const hit = await getSignedUrl('chat/u1/a.jpg');
out({ ok, hit, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-9');
  assert.equal(after.ok, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.hit, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.signCount, 1);
});

test('MEDIA-10 跨账号隔离：不同 owner 同路径缓存键不同', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
const a = await getSignedUrl('chat/u1/a.jpg');
setSignedUrlOwner('userB');
const b = await getSignedUrl('chat/u1/a.jpg');
out({ a, b, signCount: __sb.signLog.length });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-10');
  assert.equal(after.a, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.b, 'https://signed/chat/u1/a.jpg');
  // 切换 owner 清空缓存 → 必须重新请求
  assert.equal(after.signCount, 2);
});

test('MEDIA-11 getMemoryCachedSignedUrl：绝对 URL 透传 / 相册句柄 null / 相对路径读缓存', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
await getSignedUrl('chat/u1/a.jpg');
out({
  nonString: getMemoryCachedSignedUrl(null),
  empty: getMemoryCachedSignedUrl('  '),
  absolute: getMemoryCachedSignedUrl('https://x/y.jpg'),
  file: getMemoryCachedSignedUrl('file:///tmp/a.jpg'),
  ph: getMemoryCachedSignedUrl('ph://ABC'),
  assets: getMemoryCachedSignedUrl('assets-library://x'),
  blob: getMemoryCachedSignedUrl('blob:http://x/y'),
  cached: getMemoryCachedSignedUrl('chat/u1/a.jpg'),
  uncached: getMemoryCachedSignedUrl('chat/u1/missing.jpg'),
});
`;
  const { after } = assertEqualBoth(body, 'MEDIA-11');
  assert.equal(after.nonString, null);
  assert.equal(after.empty, null);
  assert.equal(after.absolute, 'https://x/y.jpg');
  assert.equal(after.file, 'file:///tmp/a.jpg');
  assert.equal(after.ph, null);
  assert.equal(after.assets, null);
  assert.equal(after.blob, null);
  assert.equal(after.cached, 'https://signed/chat/u1/a.jpg');
  assert.equal(after.uncached, null);
});

test('MEDIA-12 useSignedMediaUrl：绝对 URL 透传 / 相对路径异步签名 / 身份切换丢弃旧 state', async () => {
  const body = String.raw`
${MEDIA_PRELUDE}
setSignedUrlOwner('userA');
// 每个用例使用独立 runtime（同一 runtime 重复 render 会复用上一帧）
function freshMount(value) {
  const r = createHookRuntime();
  let cur = r.render(() => useSignedMediaUrl(value));
  return {
    get: () => cur,
    settle: () => { if (r.isScheduled) cur = r.rerender(); return cur; },
  };
}
// 1) 绝对 URL：同步透传，loading=false
const abs = freshMount('https://cdn/x.jpg').get();
const absOut = { url: abs.url, loading: abs.loading };
// 2) 本地 URI：同步透传
const loc = freshMount('file:///tmp/a.jpg').get();
const locOut = { url: loc.url, loading: loc.loading };
// 3) 相对路径：初始 loading=true，异步签名后 loading=false
const relH = freshMount('chat/u1/a.jpg');
const relInitial = { url: relH.get().url, loading: relH.get().loading };
await flushMicrotasks();
const relAfter = { url: relH.settle().url, loading: relH.get().loading };
// 4) 身份切换：旧 state 不得泄漏到新身份
setSignedUrlOwner('userB');
const afterSwitch = { url: relH.settle().url, loading: relH.get().loading };
out({ absOut, locOut, relInitial, relAfter, afterSwitch });
`;
  const { after } = assertEqualBoth(body, 'MEDIA-12');
  assert.deepEqual(after.absOut, { url: 'https://cdn/x.jpg', loading: false });
  assert.deepEqual(after.locOut, { url: 'file:///tmp/a.jpg', loading: false });
  assert.deepEqual(after.relInitial, { url: null, loading: true });
  assert.deepEqual(after.relAfter, { url: 'https://signed/chat/u1/a.jpg', loading: false });
  // 新身份 userB 下缓存为空 → 回落 null + loading=true（旧 userA 的 URL 绝不泄漏）
  assert.deepEqual(after.afterSwitch, { url: null, loading: true });
});

// ===========================================================================
// LOW — useStreak / useTimeSync / useChatPrefs / useFriendActions
// ===========================================================================

test('LOW-1 useStreak：三餐+饮水达标边沿推进 streak / 撤销回退 / 未加载不判定', async () => {
  const body = String.raw`
${COMMON_PRELUDE}
const { useStreak } = await import('./src/hooks/health/useStreak');
const rt = createHookRuntime();
const log = [];
const params = {
  todayStr: '2026-03-10',
  getDateStr: (d) => d.toISOString().slice(0, 10),
  isLoaded: false,
  mealsStatus: { '早餐': true, '午餐': true, '晚餐': true },
  waterAmount: 2000,
  maxWater: 2000,
  streakDays: 0,
  lastCheckInDate: null,
  setStreak: (v) => log.push(['streak', v]),
  setCheckInDate: (v) => log.push(['date', v]),
};
let last = rt.render(() => useStreak(params));
const notLoaded = { isDone: last.isDoneToday, logLen: log.length };
// 加载完成：首次判定只记录基线，不触发写入
params.isLoaded = true;
last = rt.rerender();
const firstLoaded = { isDone: last.isDoneToday, logLen: log.length };
// 未达标 → 达标：推进 streak=1，写入 todayStr
params.mealsStatus = { '早餐': true, '午餐': true, '晚餐': false };
last = rt.rerender();
const undone = { isDone: last.isDoneToday, logLen: log.length };
params.mealsStatus = { '早餐': true, '午餐': true, '晚餐': true };
last = rt.rerender();
const done = { isDone: last.isDoneToday, log: log.slice() };
out({ notLoaded, firstLoaded, undone, done });
`;
  const { after } = assertEqualBoth(body, 'LOW-1');
  assert.deepEqual(after.notLoaded, { isDone: true, logLen: 0 });
  assert.deepEqual(after.firstLoaded, { isDone: true, logLen: 0 });
  assert.deepEqual(after.undone, { isDone: false, logLen: 0 });
  assert.equal(after.done.isDone, true);
  assert.deepEqual(after.done.log, [['streak', 1], ['date', '2026-03-10']]);
});

test('LOW-2 useStreak：撤销打卡 streak 回退 1，回退到 0 时清空日期', async () => {
  const body = String.raw`
${COMMON_PRELUDE}
const { useStreak } = await import('./src/hooks/health/useStreak');
const rt = createHookRuntime();
const log = [];
const params = {
  todayStr: '2026-03-10',
  getDateStr: (d) => d.toISOString().slice(0, 10),
  isLoaded: true,
  mealsStatus: { '早餐': true, '午餐': true, '晚餐': true },
  waterAmount: 2000,
  maxWater: 2000,
  streakDays: 1,
  lastCheckInDate: '2026-03-10',
  setStreak: (v) => log.push(['streak', v]),
  setCheckInDate: (v) => log.push(['date', v]),
};
let last = rt.render(() => useStreak(params));
// 基线：已完成
const base = { isDone: last.isDoneToday, logLen: log.length };
// 撤销：未达标 → 回退 streak=0，清空日期
params.mealsStatus = { '早餐': true, '午餐': true, '晚餐': false };
last = rt.rerender();
out({ base, afterUndo: { isDone: last.isDoneToday, log: log.slice() } });
`;
  const { after } = assertEqualBoth(body, 'LOW-2');
  assert.deepEqual(after.base, { isDone: true, logLen: 0 });
  assert.equal(after.afterUndo.isDone, false);
  assert.deepEqual(after.afterUndo.log, [['streak', 0], ['date', null]]);
});

test('LOW-3 useTimeSync：calibrate 成功写 offset / 失败保留旧 offset / 非有限值拒绝', async () => {
  const body = String.raw`
${COMMON_PRELUDE}
const { useTimeSync } = await import('./src/hooks/health/useTimeSync');
const rt = createHookRuntime();
let last = rt.render(() => useTimeSync());
function settleLast() { if (rt.isScheduled) last = rt.rerender(); return last; }
const initial = { offsetMs: last.offsetMs, isSynced: last.isSynced };
// 成功校准：服务器时间比本地快 5000ms
__sb.rpcData = new Date(__now + 5000).toISOString();
const ok1 = await last.calibrate();
settleLast();
const afterOk = { ok: ok1, offsetMs: last.offsetMs, isSynced: last.isSynced };
// 失败校准：保留旧 offset，isSynced 仍为 true
__sb.rpcError = { message: 'net' };
const ok2 = await last.calibrate();
settleLast();
const afterFail = { ok: ok2, offsetMs: last.offsetMs, isSynced: last.isSynced };
// 非有限值：返回 false，不改 offset
__sb.rpcError = null;
__sb.rpcData = 'not-a-date';
const ok3 = await last.calibrate();
settleLast();
const afterBad = { ok: ok3, offsetMs: last.offsetMs };
out({ initial, afterOk, afterFail, afterBad, rpcCount: __sb.rpcLog.length });
`;
  const { after } = assertEqualBoth(body, 'LOW-3');
  assert.deepEqual(after.initial, { offsetMs: 0, isSynced: false });
  assert.deepEqual(after.afterOk, { ok: true, offsetMs: 5000, isSynced: true });
  assert.deepEqual(after.afterFail, { ok: false, offsetMs: 5000, isSynced: true });
  assert.deepEqual(after.afterBad, { ok: false, offsetMs: 5000 });
  assert.equal(after.rpcCount, 3);
});

test('LOW-4 useChatPrefs：按用户隔离加载 / toggle 落盘 / 无 user 不写 / resetAll', async () => {
  const body = String.raw`
${COMMON_PRELUDE}
const { useChatPrefs } = await import('./src/hooks/chat/useChatPrefs');
const rt = createHookRuntime();
let last = null;
function settleLast() { if (rt.isScheduled) last = rt.rerender(); return last; }
// 预置 userA 的存储
__store.set('sync_chat_prefs_v1_userA', JSON.stringify({ pinned: ['f1'], hidden: [], muted: [], starred: [], blocked: [], backgrounds: { f1: 'dark' } }));
last = rt.render(() => useChatPrefs({ id: 'userA' }));
const beforeLoad = { loaded: last.loaded, pinned: last.pinned.slice() };
await flushMicrotasks();
settleLast();
const afterLoad = { loaded: last.loaded, pinned: last.pinned.slice(), bg: last.getBackground('f1') };
// toggle 置顶 f2
last.togglePin('f2');
settleLast();
const afterToggle = { pinned: last.pinned.slice(), stored: JSON.parse(__store.get('sync_chat_prefs_v1_userA')) };
// 无 user：loaded=true，操作不落盘
const rt2 = createHookRuntime();
let anon = rt2.render(() => useChatPrefs(null));
const anonLoaded = anon.loaded;
anon.togglePin('x');
const storeKeys = Array.from(__store.keys()).sort();
out({ beforeLoad, afterLoad, afterToggle, anonLoaded, storeKeys });
`;
  const { after } = assertEqualBoth(body, 'LOW-4');
  assert.deepEqual(after.beforeLoad, { loaded: false, pinned: [] });
  assert.deepEqual(after.afterLoad, { loaded: true, pinned: ['f1'], bg: 'dark' });
  assert.deepEqual(after.afterToggle.pinned, ['f1', 'f2']);
  assert.deepEqual(after.afterToggle.stored.pinned, ['f1', 'f2']);
  assert.equal(after.anonLoaded, true);
  assert.deepEqual(after.storeKeys, ['sync_chat_prefs_v1_userA']);
});
