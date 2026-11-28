// --- START OF FILE tests/security/t6bRuntime.test.mjs ---
// ============================================================================
// TASK-P0.3 / T6-B — 审查问题最小修复 运行时回归测试
//
// 目的：用「真实业务源码」证明 X-01 ~ X-09a 的缺陷在修复前存在、修复后消失。
//
// 与 b1Isolation.test.mjs 的关系：
//   - 复用同一套「临时目录 + stub 模块 + spawnSync 子进程」沙箱思路；
//   - 但本文件额外提供一个**极简 Hook 运行时**（方案 A），使依赖 useState /
//     useEffect / useRef / useCallback / useMemo 的 Hook 能被真实执行，
//     从而覆盖「渲染期调整 state」「effect 依赖变化」「setState updater 内写盘」
//     这类只有真实 React 调度才会暴露的缺陷。
//
// 真实性声明（重要）：
//   - ✅ 真实执行：被测业务模块（useHealthStorage / useProfileCache /
//     useSignedMediaUrl / useBrowserHistory / BrowserSessionContext 等）的源码
//     原样复制进沙箱并真实 import、真实调用。
//   - ✅ 真实执行：AsyncStorage stub 是真实的内存 Map，读写语义与真实库一致。
//   - ⚠️ 模拟调度：React 运行时是「极简实现」，只模拟 useState/useEffect/
//     useRef/useCallback/useMemo 的**语义**（依赖数组浅比较、effect 清理、
//     重渲染时 state 保留），不模拟并发特性 / Suspense / 批处理时序。
//   - ⚠️ 近似：不模拟真实 React 的「渲染期 setState 会触发重渲染」的完整调度，
//     而是显式调用 rerender() 驱动；这足以复现「渲染期写模块级副作用」缺陷。
//   - ❓ 需真机验证：真实网络时序、真实 GoTrue 事件队列、真实 WebView 生命周期
//     不在本测试覆盖范围（见 11_T6A_TEST_PLAN.md §4 覆盖缺口）。
//
// 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// 极简 Hook 运行时（方案 A）—— 作为 react stub 注入沙箱
//
// 设计要点：
//   - 每个「组件实例」持有一个 hooks 数组 + 游标；render(fn) 时游标归零。
//   - useState：首次用 init 初始化，后续返回当前值 + setter（setter 记录待更新）。
//   - useEffect：按依赖数组浅比较决定是否重跑；重跑前先执行上次 cleanup。
//   - useRef：跨渲染保持同一对象。
//   - useCallback/useMemo：按依赖数组缓存。
//   - 提供 rerender()：应用所有待更新 state → 重新执行组件函数 → 执行待运行 effect。
//   - 提供 flushEffects()：只执行待运行 effect（用于异步 await 后手动推进）。
//
// 该运行时是「测试替身」，不进入生产代码，不新增任何依赖。
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
  let cleanupFns = [];
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
      slot.deps = undefined;
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

  function useContext() { return {}; }
  function createContext(v) { return { __ctx: v }; }

  function scheduleRender() { scheduled = true; }

  function runPendingEffects() {
    const toRun = pendingEffects;
    pendingEffects = [];
    for (const { index, fn } of toRun) {
      const slot = hooks[index];
      if (slot.cleanup) { try { slot.cleanup(); } catch (_) {} slot.cleanup = undefined; }
      const ret = fn();
      if (typeof ret === 'function') slot.cleanup = ret;
    }
  }

  // 执行一次渲染：游标归零 → 调用组件函数 → 运行本帧 effect
  // ⚠️ 关键：渲染期 setState（React 官方「渲染期调整 state」模式）必须保留
  //    scheduled 标记，使 settle() 能继续 rerender 收敛。因此这里在调用组件
  //    函数**之前**先清空 scheduled，函数执行期间若发生 setState 会重新置 true，
  //    执行完 effect 后不再无条件清空。
  function render(fn) {
    componentFn = fn;
    cursor = 0;
    renderCount += 1;
    scheduled = false; // 清空上一帧遗留标记
    const out = fn();  // 渲染期 setState 会重新置 scheduled=true
    runPendingEffects();
    return out;
  }

  // 若 setState 触发了重渲染，则重新执行组件函数
  function rerender() {
    if (!componentFn) throw new Error('rerender() called before render()');
    cursor = 0;
    renderCount += 1;
    scheduled = false;
    const out = componentFn();
    runPendingEffects();
    return out;
  }

  // 纯渲染：只执行组件函数，**不**运行本帧 effect。
  // 用于验证「同一渲染帧」语义（effect 尚未生效时 Modal 是否已不可见）。
  function renderOnly() {
    if (!componentFn) throw new Error('renderOnly() called before render()');
    cursor = 0;
    renderCount += 1;
    scheduled = false;
    return componentFn();
  }

  // 仅推进待运行 effect（不重新渲染组件函数），用于 await 之后手动 flush
  function flushEffects() { runPendingEffects(); }

  // 反复 rerender 直到没有新的 setState 调度（模拟 React 收敛）
  function settle(maxRounds = 20) {
    let rounds = 0;
    while (scheduled && rounds < maxRounds) { rerender(); rounds += 1; }
    return rounds;
  }

  // 卸载组件：执行所有已注册 effect 的 cleanup（模拟 React unmount）
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
    useState, useRef, useEffect, useCallback, useMemo, useContext, createContext,
    render, rerender, renderOnly, flushEffects, settle, unmount,
    get renderCount() { return renderCount; },
    get isScheduled() { return scheduled; },
  };
}
`;

// ---------------------------------------------------------------------------
// 构建沙箱：stub AsyncStorage / react(含 Hook 运行时) / supabase + 复制真实源码
// ---------------------------------------------------------------------------
function buildSandbox(extraCopies = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't6b-rt-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // 内存版 AsyncStorage（真实读写语义）
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

  // react stub：导出 Hook 运行时 + 常用 API
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
${HOOK_RUNTIME_SRC}
// ⚠️ 关键：真实业务模块从 'react' 具名导入 useState/useEffect/...，
//    因此这些具名导出必须**委托到同一个运行时单例**，否则模块里的 Hook
//    会落到 noop 桩上，导致 setState 无效、effect 不执行（测试假通过）。
//    createHookRuntime() 返回同一单例，测试与业务模块共享同一份 hooks 状态。
let __singleton = null;
export function createHookRuntime() {
  if (!__singleton) __singleton = __createHookRuntime();
  return __singleton;
}
const __runtime = createHookRuntime();
export const useState = __runtime.useState;
export const useEffect = __runtime.useEffect;
export const useCallback = __runtime.useCallback;
export const useMemo = __runtime.useMemo;
export const useRef = __runtime.useRef;
export const useContext = __runtime.useContext;
export const createContext = __runtime.createContext;
// 最小 createElement：仅用于把 JSX 改写后的 Provider 渲染成普通对象（不参与真实渲染）
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  // supabase stub（可注入 profiles 查询 / createSignedUrl / rpc 行为）
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // expo-file-system stub（B2：useAuth 现在会 import mediaCache，后者依赖
  //   expo-file-system/legacy。本套件不验证沙盒文件读写，只需模块可解析、
  //   调用不抛错，因此提供最小可用的内存实现。）
  // react-native stub（P0.3 iOS-01：useAuth 现在 import { AppState } 以驱动
  //   Supabase Auth 自动刷新生命周期。本套件不验证 AppState 行为，
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
      name: 'expo-file-system',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js', './legacy': './legacy.js' },
    }),
    'index.js': 'export default {};',
    'legacy.js': `
const __files = new Map();
const __dirs = new Set(['file:///doc/']);
const api = {
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  async getInfoAsync(p) {
    const key = String(p);
    if (__files.has(key)) return { exists: true, isDirectory: false, size: __files.get(key).length, uri: key };
    if (__dirs.has(key)) return { exists: true, isDirectory: true, uri: key };
    return { exists: false, isDirectory: false };
  },
  async makeDirectoryAsync(p) { __dirs.add(String(p)); },
  async readDirectoryAsync(p) {
    const base = String(p);
    const out = [];
    for (const k of __files.keys()) {
      if (k.startsWith(base) && !k.slice(base.length).includes('/')) out.push(k.slice(base.length));
    }
    for (const d of __dirs) {
      if (d !== base && d.startsWith(base) && !d.slice(base.length).replace(/\\/$/, '').includes('/')) {
        out.push(d.slice(base.length).replace(/\\/$/, ''));
      }
    }
    return out;
  },
  async downloadAsync(url, target) {
    __files.set(String(target), 'x');
    return { uri: String(target), status: 200 };
  },
  async copyAsync({ from, to }) {
    __files.set(String(to), __files.get(String(from)) || 'x');
  },
  async deleteAsync(p) {
    const key = String(p);
    __files.delete(key);
    __dirs.delete(key);
  },
  async writeAsStringAsync(p, c) { __files.set(String(p), String(c)); },
  async readAsStringAsync(p) { return __files.get(String(p)) || ''; },
};
export default api;
export const documentDirectory = api.documentDirectory;
export const cacheDirectory = api.cacheDirectory;
export const getInfoAsync = api.getInfoAsync;
export const makeDirectoryAsync = api.makeDirectoryAsync;
export const readDirectoryAsync = api.readDirectoryAsync;
export const downloadAsync = api.downloadAsync;
export const copyAsync = api.copyAsync;
export const deleteAsync = api.deleteAsync;
export const writeAsStringAsync = api.writeAsStringAsync;
export const readAsStringAsync = api.readAsStringAsync;
`,
  });

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    // ⚠️ Node 无法解析 JSX。BrowserSessionContext.js 仅有一处 JSX return，
    //    这里做最小等价改写为 React.createElement（不改变任何业务逻辑），
    //    使该文件可在沙箱中被真实 import 与执行。
    if (rel.endsWith('BrowserSessionContext.js')) {
      code = code.replace(
        /return \(\s*<BrowserSessionContext\.Provider value=\{value\}>\{children\}<\/BrowserSessionContext\.Provider>\s*\);/,
        'return React.createElement(BrowserSessionContext.Provider, { value }, children);'
      );
    }
    // useAuth.js 末尾有一处 JSX return（AuthContext.Provider），同样改写为 createElement
    if (rel.endsWith('useAuth.js')) {
      code = code.replace(
        /return <AuthContext\.Provider value=\{value\}>\{children\}<\/AuthContext\.Provider>;/,
        'return React.createElement(AuthContext.Provider, { value }, children);'
      );
    }
    // useHealthData.js 末尾有一处 JSX return（HealthContext.Provider），同样改写。
    // ⚠️ 该文件只具名导入 Hook，没有 React 命名空间，因此需补一行 import * as React。
    if (rel.endsWith('useHealthData.js')) {
      code = code.replace(
        /return <HealthContext\.Provider value=\{value\}>\{children\}<\/HealthContext\.Provider>;/,
        'return React.createElement(HealthContext.Provider, { value }, children);'
      );
      code = "import * as React from 'react';\n" + code;
    }
    fs.writeFileSync(dst, code);
  };
  // 默认复制 T6-B 涉及的全部被测模块及其直接依赖
  const baseCopies = [
    'src/hooks/health/useHealthStorage.js',
    'src/hooks/health/constants.js',
    'src/hooks/health/dateUtils.js',
    'src/hooks/health/useHealthCloud.js',
    'src/hooks/health/authRevokeLogic.js',
    'src/constants/browser/index.js',
    'src/hooks/browser/useBrowserHistory.js',
    'src/hooks/profile/useProfileCache.js',
    'src/hooks/chat/useSignedMediaUrl.js',
    // 🗄️ B2：useAuth 现在 import mediaCache 以同步登记沙盒写入身份闸门，
    //    因此必须把该真实模块一并复制进沙箱（其 expo-file-system 依赖已 stub）。
    'src/services/mediaCache.js',
    // 🔄 P0.3 iOS-01：useAuth 现在 import authAutoRefresh 以驱动自动刷新生命周期。
    //    复制**真实实现**（非 stub），保证沙箱执行的是生产代码。
    'src/services/authAutoRefresh.js',
    // 🎬 P15 观看历史 V1：BrowserSessionContext 现在 import watchHistoryLogic
    //    （createResumeTaskId / RESUME_TASK_STATUS）以生成唯一续播任务 ID。
    //    必须把该真实纯逻辑模块一并复制进沙箱，否则沙箱 import 会 ERR_MODULE_NOT_FOUND。
    'src/hooks/browser/watchHistoryLogic.js',
    'src/context/BrowserSessionContext.js',
    'src/hooks/useAuth.js',
  ];
  for (const rel of [...baseCopies, ...extraCopies]) copy(rel);

  // supabase 服务 stub（真实模块 import ../../services/supabase）
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const supabase = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      // 链式 update 始终返回可继续链式调用的对象；真正的执行发生在 then（终结）
      update() { return this; },
      upsert() { return globalThis.__UPSERT_IMPL__ ? globalThis.__UPSERT_IMPL__() : Promise.resolve({ error: null }); },
      // 🛡️ T-16-05：messages.insert 记录（供断言「旧会话不得写系统消息」）
      insert(row) {
        if (!globalThis.__MSG_LOG__) globalThis.__MSG_LOG__ = [];
        globalThis.__MSG_LOG__.push(row);
        return globalThis.__INSERT_IMPL__ ? globalThis.__INSERT_IMPL__(row) : Promise.resolve({ error: null });
      },
      single() { return globalThis.__PROFILE_QUERY__ ? globalThis.__PROFILE_QUERY__() : Promise.resolve({ data: null, error: null }); },
      // 🛡️ X-07：update().eq() 的终结。可注入抛异常（模拟网络错误 / RLS 拒绝）。
      //    注意：impl 在 then 内调用，若其同步 throw，会被 Promise 链捕获为 reject。
      then(resolve, reject) {
        try {
          const p = globalThis.__PROFILE_UPDATE_IMPL__
            ? globalThis.__PROFILE_UPDATE_IMPL__()
            : Promise.resolve({ error: null });
          return Promise.resolve(p).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
  },
  rpc() { return globalThis.__RPC_IMPL__ ? globalThis.__RPC_IMPL__() : Promise.resolve({ data: null, error: null }); },
  storage: {
    from() {
      return {
        createSignedUrl(p, ttl) {
          return globalThis.__SIGN_IMPL__ ? globalThis.__SIGN_IMPL__(p, ttl) : Promise.resolve({ data: { signedUrl: 'https://x/' + p }, error: null });
        },
      };
    },
  },
  auth: {
    signOut() { return globalThis.__SIGNOUT_IMPL__ ? globalThis.__SIGNOUT_IMPL__() : Promise.resolve({ error: null }); },
    getSession() { return globalThis.__GETSESSION_IMPL__ ? globalThis.__GETSESSION_IMPL__() : Promise.resolve({ data: { session: null }, error: null }); },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    // 🔄 P0.3 iOS-01：useAuth 通过 authAutoRefresh 控制器调用这两个方法。
    //    本套件不验证自动刷新行为，仅需方法存在且可 await。
    async startAutoRefresh() {},
    async stopAutoRefresh() {},
  },
  channel() { return { on() { return this; }, subscribe() { return this; } }; },
  getChannels() { return []; },
  removeChannel() {},
};
export const authStorageStatus = { get: () => (globalThis.__AUTH_STATUS__ ? globalThis.__AUTH_STATUS__() : null) };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
// 🍎 BUG-02（iOS-01 残留）：useAuth 现在会 import probeAuthStorage。
//    沙箱 stub 需提供同名导出（默认视为可用，不改变既有测试语义）。
export const probeAuthStorage = async () => true;
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'/index.js',c);}catch{}}return n(s,c);}`);
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

// ===========================================================================
// T-X01 — Profile null-owner 写盘闸门
//
// 缺陷：writeProfileCache 的 owner 校验是 `if (currentOwnerId && ...)`，
//       当 currentOwnerId 为 null（未登记 / 已登出）时，任何 profile 都能写入。
// 期望（修复后）：owner 未登记（null）时，写入必须 fail-closed 拒绝。
// ===========================================================================
test('T-X01 Profile 写入在 owner 未登记时必须 fail-closed 拒绝', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const PC = await import('./src/hooks/profile/useProfileCache.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

// 未登记任何 owner（currentOwnerId === null）
// 攻击场景：登出后 / 冷启动早期，一个迟到的 profile 写入不应落盘
const wrote = await PC.writeProfileCache({ id: 'ghost-user', username: 'ghost' });
const stored = await AS.getItem(PC.buildProfileCacheKey('ghost-user'));

process.stdout.write(JSON.stringify({ wrote, stored }));
`);
    // 修复后：owner 未登记 → 拒绝写入，磁盘无该 key
    assert.equal(out.wrote, false, 'owner 未登记时 writeProfileCache 必须返回 false（fail-closed）');
    assert.equal(out.stored, null, 'owner 未登记时不得写入任何 profile 缓存');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X01b — 渲染期越权重设 owner（useHealthData 渲染期调用 setProfileCacheOwner）
//
// 缺陷：useHealthData 在渲染期直接调用 setProfileCacheOwner(user?.id ?? null)，
//       这是「渲染期写模块级副作用」，违反 React 纯度，且会在并发渲染下
//       把 owner 重置成错误的身份。
// 期望（修复后）：渲染期不得调用 setProfileCacheOwner；owner 登记只发生在
//       effect / 异步路径中。
// ===========================================================================
test('T-X01b useHealthData 不得在渲染期调用 setProfileCacheOwner', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/hooks/useHealthData.js'), 'utf8');
  // 定位渲染期身份重置块（prevProfileOwner !== ... 的 if 块）
  const blockMatch = src.match(/if \(prevProfileOwner !== \(user\?\.id \?\? null\)\) \{[\s\S]*?\n  \}/);
  assert.ok(blockMatch, '应能定位 useHealthData 的渲染期身份重置块');
  const block = blockMatch[0];
  assert.ok(
    !/setProfileCacheOwner\s*\(/.test(block),
    '渲染期身份重置块内不得调用 setProfileCacheOwner（必须移到 effect / 异步路径）'
  );
});

// ===========================================================================
// T-X02 — 旧健康云响应写 B 的 V2 key
//
// 缺陷：A 的 fetchMyRecord 云端响应在切到 B 之后才返回，经 hydrateFromCloud
//       写入时用的是「当前 userId（B）」的 key，把 A 的云端值写进 B 的磁盘。
// 期望（修复后）：hydrateFromCloud 接收 expectedOwnerId，与当前 userId 不一致
//       时 fail-closed 拒绝写盘；B 的 key 保持原值。
// ===========================================================================
test('T-X02 旧账号云端响应不得写进新账号 V2 key', () => {
  const dir = buildSandbox();
  try {
    // 注意：HEAD 版 useHealthStorage 没有导出 buildHealthKeys，签名是 (todayStr)，
    // 且 hydrateFromCloud 只接受 1 个参数、写的是旧全局 key（@waterAmount）。
    // 因此本用例在沙箱内自行构造 V2 key，并兼容两种 hook 签名（多传的 userId 会被旧版忽略）。
    // 判定口径：切到 B 之后，A 的迟到云端值 1500 不得出现在「任何」B 可见的存储位置
    //   —— 既不能写进 B 的 V2 key，也不能经由旧全局 key 泄漏给 B。
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const keyOf = (uid, field) => '@sync_health_v2_' + uid + '_' + field;
const kB = { water: keyOf(B, 'water'), meals: keyOf(B, 'meals'), active: keyOf(B, 'active') };

// 预置 B 的真实磁盘数据：800ml
await AS.setItem(kB.water, '800');
await AS.setItem(kB.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(kB.active, '2026-11-18');

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useHealthStorage('2026-11-18', globalThis.__UID__); return null; };

// 1) 以 A 身份渲染（模拟 A 的 loadAllData 已发起，云端响应尚未返回）
globalThis.__UID__ = A;
rt.render(Comp);
rt.settle();

// 2) 切到 B 身份并重渲染（userIdRef 更新为 B）
globalThis.__UID__ = B;
rt.render(Comp);
rt.settle();

// 3) A 的云端响应此刻才返回：调用 hydrateFromCloud，声明期望 owner 为 A
//    修复后：expectedOwnerId(A) !== 当前 userId(B) → fail-closed 拒绝写盘
api.hydrateFromCloud({ waterAmount: 1500, mealsStatus: { '早餐': true, '午餐': true, '晚餐': true } }, A);
rt.settle();
await new Promise((r) => setTimeout(r, 10));

const bWater = await AS.getItem(kB.water);
const legacyWater = await AS.getItem('@waterAmount');

process.stdout.write(JSON.stringify({ bWater, legacyWater }));
`);
    // 修复后：B 的 V2 key 必须保持 800
    assert.equal(out.bWater, '800', 'A 的迟到云端响应不得写进 B 的 V2 key（必须保持 B 原值 800）');
    // 修复前：旧版写 @waterAmount=1500（全局 key，B 登录后会读到 A 的数据）
    assert.notEqual(out.legacyWater, '1500', 'A 的迟到云端响应不得写进全局 key（会泄漏给 B）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X03 — 自动落盘覆盖 B 已存数据
//
// 缺陷：useHealthStorage 的自动落盘 effect 只检查 isLoadedRef.current，
//       而渲染期身份切换重置块**不重置** isLoadedRef。于是 A→B 切换后，
//       若 B 的 load() 尚未完成，A 残留的 waterAmount/mealsStatus 会通过
//       自动落盘 effect 写进 B 的 V2 key，覆盖 B 已存数据。
// 期望（修复后）：身份切换后，在 B 的 load() 完成前，自动落盘不得写入 B 的 key。
// ===========================================================================
test('T-X03 身份切换后自动落盘不得用旧账号内存态覆盖新账号已存数据', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage, buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const kA = buildHealthKeys(A), kB = buildHealthKeys(B);

// 预置：A 有 500ml 饮水；B 已存 900ml 饮水（B 的真实数据）
await AS.setItem(kA.water, '500');
await AS.setItem(kA.meals, JSON.stringify({ '早餐': true, '午餐': false, '晚餐': false }));
await AS.setItem(kA.active, '2026-11-18');
await AS.setItem(kB.water, '900');
await AS.setItem(kB.meals, JSON.stringify({ '早餐': false, '午餐': true, '晚餐': false }));
await AS.setItem(kB.active, '2026-11-18');

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useHealthStorage('2026-11-18', globalThis.__UID__); return null; };

// 1) 以 A 身份渲染并完成 load（isLoadedRef=true，内存态=500）
globalThis.__UID__ = A;
rt.render(Comp);
await api.load();
rt.settle();

// 2) 切到 B 身份（渲染期重置内存态：waterAmount 500→0、meals→EMPTY）。
//    此时 isLoadedRef 仍为 true（缺陷：渲染期重置块不重置它），
//    自动落盘 effect 因 waterAmount/mealsStatus 变化而触发，
//    会把 0 / EMPTY 写进 B 的 key —— 覆盖 B 已存的 900ml。
globalThis.__UID__ = B;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 10));

// 3) 检查 B 的磁盘数据是否被覆盖
const bWaterAfter = await AS.getItem(kB.water);
const bMealsAfter = await AS.getItem(kB.meals);

process.stdout.write(JSON.stringify({ bWaterAfter, bMealsAfter }));
`);
    // 修复后：B 的 900ml 必须保持不变（自动落盘在 B load 完成前不得写 B key）
    assert.equal(out.bWaterAfter, '900', '身份切换后、B load 完成前，自动落盘不得覆盖 B 的饮水数据');
    assert.equal(
      out.bMealsAfter,
      JSON.stringify({ '早餐': false, '午餐': true, '晚餐': false }),
      '身份切换后、B load 完成前，自动落盘不得覆盖 B 的三餐数据'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X04 — Signed URL Hook 旧 state
//
// 缺陷：useSignedMediaUrl 的 url state 只在首次渲染初始化一次；effect 依赖
//       数组不含 owner/epoch。A→B 切换后，若组件不重新挂载，url 仍持有 A 的
//       签名 URL，resolved 优先返回 url，导致 B 看到 A 的图片。
// 期望（修复后）：身份切换后，Hook 必须丢弃旧 owner 的 url，返回 B 的缓存或 null。
// ===========================================================================
test('T-X04 Signed URL Hook 在身份切换后不得返回旧账号的 url', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const SU = await import('./src/hooks/chat/useSignedMediaUrl.js');

const A = 'user-aaa', B = 'user-bbb';
const P = 'user-aaa/img_1.jpg';

// A 身份：签名返回 A 的 URL
SU.setSignedUrlOwner(A);
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://signed/A/' + p }, error: null });

const rt = createHookRuntime();
let hookResult = null;
const Comp = () => { hookResult = SU.useSignedMediaUrl(P); return null; };

// 1) A 身份渲染 + 等待异步签名完成
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const urlA = hookResult.url;

// 2) 切到 B 身份（B 没有该路径的缓存），组件不卸载，仅重渲染
SU.setSignedUrlOwner(B);
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://signed/B/' + p }, error: null });
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const urlB = hookResult.url;

process.stdout.write(JSON.stringify({ urlA, urlB }));
`);
    assert.equal(out.urlA, 'https://signed/A/user-aaa/img_1.jpg', 'A 身份应拿到 A 的签名 URL');
    // 修复后：B 身份下不得返回 A 的 URL（应为 B 的 URL 或 null，但绝不能是 A 的）
    assert.notEqual(out.urlB, out.urlA, '身份切换后 Hook 不得继续返回旧账号的签名 URL');
    assert.ok(
      out.urlB === null || out.urlB === 'https://signed/B/user-aaa/img_1.jpg',
      'B 身份下应返回 B 的签名 URL 或 null，绝不能是 A 的 URL'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X05 — authEpoch 与下游代际不一致（tokenRotated 未同步下游）
//
// 缺陷：applySession 在「同 ownerId 但会话已更换」（tokenRotated）时只自增
//       authEpoch，却**不**同步下游模块（setSignedUrlOwner / setProfileCacheOwner）。
//       于是出现「authEpoch 已变、下游代际未变」的状态不一致：旧会话在途的
//       签名 URL / profile 结果仍会被新会话消费。
// 期望（修复后）：tokenRotated 时下游代际也必须推进（forceBump），使旧会话
//       在途结果失效。本测试直接验证下游 setter 的 forceBump 语义。
// ===========================================================================
test('T-X05 tokenRotated 时下游代际必须同步推进（旧会话在途结果失效）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const SU = await import('./src/hooks/chat/useSignedMediaUrl.js');
const PC = await import('./src/hooks/profile/useProfileCache.js');

const A = 'user-aaa';

// 1) A 首次登录：登记 owner（代际 1）
SU.setSignedUrlOwner(A);
PC.setProfileCacheOwner(A);
const suGen1 = SU.getSignedUrlIdentity().epoch;
const pcGen1 = PC.getProfileCacheGeneration();

// 2) 同 ownerId 但会话更换（tokenRotated）：不带 forceBump 的普通登记是 no-op
SU.setSignedUrlOwner(A);
PC.setProfileCacheOwner(A);
const suGenNoop = SU.getSignedUrlIdentity().epoch;
const pcGenNoop = PC.getProfileCacheGeneration();

// 3) 修复路径：tokenRotated 时以 forceBump=true 同步下游
SU.setSignedUrlOwner(A, true);
PC.setProfileCacheOwner(A, true);
const suGenForced = SU.getSignedUrlIdentity().epoch;
const pcGenForced = PC.getProfileCacheGeneration();

process.stdout.write(JSON.stringify({ suGen1, pcGen1, suGenNoop, pcGenNoop, suGenForced, pcGenForced }));
`);
    // 首次登记后下游代际应为 1
    assert.equal(out.suGen1, 1, 'A 首次登记后 Signed URL 代际应为 1');
    assert.equal(out.pcGen1, 1, 'A 首次登记后 Profile 代际应为 1');
    // 同 owner 普通登记是 no-op（代际不变）—— 这正是缺陷根源
    assert.equal(out.suGenNoop, 1, '同 owner 普通登记不应改变 Signed URL 代际');
    assert.equal(out.pcGenNoop, 1, '同 owner 普通登记不应改变 Profile 代际');
    // 修复后：forceBump 必须推进下游代际，使旧会话在途结果失效
    assert.equal(out.suGenForced, 2, 'tokenRotated 时 Signed URL 代际必须推进到 2');
    assert.equal(out.pcGenForced, 2, 'tokenRotated 时 Profile 代际必须推进到 2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X06 — 浏览器旧回调写新账号 key
//
// 缺陷：useBrowserHistory 的 addHistory 在 setState updater 内读取
//       keysRef.current.historyKey 并写盘。若 A 的旧回调在切到 B 之后才执行，
//       会读到 B 的 key 并把 A 的数据写进 B 的历史。
// 期望（修复后）：写入必须绑定「事件发起时的 owner」，owner 已变化则丢弃。
// ===========================================================================
test('T-X06 浏览器旧回调不得把 A 的历史写进 B 的 key', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory.js');
const { buildBrowserHistoryKey } = await import('./src/constants/browser/index.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const hA = buildBrowserHistoryKey(A), hB = buildBrowserHistoryKey(B);

// 预置 B 的历史（B 的真实数据）
await AS.setItem(hB, JSON.stringify([{ id: 'b1', url: 'https://b.example.com', title: 'B' }]));

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useBrowserHistory(globalThis.__UID__); return null; };

// 1) A 身份渲染
globalThis.__UID__ = A;
rt.render(Comp);
rt.settle();

// 2) 捕获 A 身份下的 addHistory 引用（模拟 A 的旧回调）
const addHistoryA = api.addHistory;

// 3) 切到 B 身份
globalThis.__UID__ = B;
rt.render(Comp);
rt.settle();

// 4) A 的旧回调此刻才执行（迟到事件）
addHistoryA('https://a-late.example.com', 'A-late');
rt.settle();
await new Promise((r) => setTimeout(r, 10));

// 5) 检查 B 的历史是否被 A 的迟到数据污染
const bHistory = JSON.parse(await AS.getItem(hB));
const bUrls = bHistory.map((it) => it.url);

process.stdout.write(JSON.stringify({ bUrls }));
`);
    // 修复后：B 的历史必须只含 B 自己的记录，不得含 A 的迟到 URL
    assert.ok(
      !out.bUrls.includes('https://a-late.example.com'),
      'A 的迟到回调不得把 A 的 URL 写进 B 的历史 key'
    );
    assert.ok(
      out.bUrls.includes('https://b.example.com'),
      'B 的历史必须保留 B 自己的记录'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X07 — signOut 抛异常与重复登出
//
// 缺陷 1：profiles.update 抛异常时，signOut 的 try 只有 finally 没有 catch，
//         异常向上传播 → Promise reject，且 signOutError 不会被设置。
// 缺陷 2：无重入保护，连续两次 signOut 会重复执行 profiles 更新与 auth.signOut。
// 期望（修复后）：异常被捕获 → resolve { error } 且 signOutError 被设置；
//         第二次 signOut 被同步重入锁拦截。
// ===========================================================================
test('T-X07 signOut 异常必须被捕获且重复登出被拦截', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { AuthProvider } = await import('./src/hooks/useAuth.js');

// 预置：已登录用户 A
globalThis.__GETSESSION_IMPL__ = async () => ({
  data: { session: { user: { id: 'user-aaa' }, access_token: 'tok-a' } },
  error: null,
});

const rt = createHookRuntime();
let ctx = null;
const Comp = () => {
  const el = AuthProvider({ children: null });
  ctx = el.props.value; // 捕获 Provider 的 value（含 signOut）
  return null;
};

// 1) 首次渲染 + 完成 getSession（applySession 设置 user）
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.settle();

// 2) 注入：profiles.update 抛异常（模拟网络错误 / RLS 拒绝）
globalThis.__PROFILE_UPDATE_IMPL__ = () => { throw new Error('network down'); };

// 3) 调用 signOut：修复前会 reject；修复后应 resolve { error } 且设置 signOutError
let threw = false;
let result = null;
try {
  result = await ctx.signOut();
} catch (e) {
  threw = true;
}
rt.settle();
const signOutErrorAfterThrow = ctx.signOutError;

// 4) 重入保护：并发两次 signOut，第二次应被拦截
globalThis.__PROFILE_UPDATE_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__SIGNOUT_IMPL__ = () => new Promise((r) => setTimeout(() => r({ error: null }), 20));
const p1 = ctx.signOut();
const p2 = ctx.signOut();
const [r1, r2] = await Promise.all([p1, p2]);
rt.settle();

process.stdout.write(JSON.stringify({
  threw,
  hasError: !!(result && result.error),
  signOutErrorSet: !!signOutErrorAfterThrow,
  reentryBlocked: !!(r2 && r2.error && r2.error.code === 'AUTH_SIGN_OUT_IN_PROGRESS'),
  firstOk: !!(r1 && r1.error === null),
}));
`);
    assert.equal(out.threw, false, 'signOut 不得向上抛出异常（必须被 catch）');
    assert.equal(out.hasError, true, 'profiles.update 抛异常时 signOut 应 resolve { error }');
    assert.equal(out.signOutErrorSet, true, '异常时 signOutError 必须被设置');
    assert.equal(out.reentryBlocked, true, '并发第二次 signOut 必须被重入锁拦截');
    assert.equal(out.firstOk, true, '第一次 signOut 应成功完成');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X08 — 健康云 pending 跨账号串号 + 不静默丢数据（useHealthCloud）
//
// 缺陷（修复前，T4-B1 基线）：
//   - pendingRef 载荷不绑定 ownerId；账号切换时 effect 先清空 pending 再 commit，
//     导致 A 的未同步数据被**静默丢弃**（数据丢失）；
//   - 或 commit 闭包已更新为 B，把 A 的 water 写成 user_id: B（跨账号串号）；
//   - `await upsert(...)` 未检查返回的 { error }，Supabase 不抛异常，
//     因此「已发送」被误判为「已成功」，失败数据被丢弃。
//
// 复审返工（CR-01）要求同时验证四件事：
//   1. 绝不跨账号提交（A 的载荷不得写成 B，也不得在切到 B 后写 A）；
//   2. 提交失败后 pending 仍可恢复（不被丢弃）；
//   3. 切回原账号后可重试并成功；
//   4. 只有成功确认后才能移除 pending。
//
// 说明：pendingRef 是 Hook 内部 ref，测试无法直接读取。因此用「可观测的云端
//       upsert 调用序列」作为 pending 是否仍存活的证据：
//       若失败后 pending 被丢弃，则切回 A 后不会再有重试写入。
// ===========================================================================
test('T-X08 健康云 pending 不得跨账号写入，且失败后保留可重试、仅成功后移除', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };

// 记录所有 upsert 的 user_id / water / 结果，用于判定行为
const upserts = [];
// 可注入的 upsert 行为：默认成功
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });

const supabaseMod = await import('./src/services/supabase.js');
const origFrom = supabaseMod.supabase.from.bind(supabaseMod.supabase);
supabaseMod.supabase.from = (table) => {
  const chain = origFrom(table);
  if (table === 'health_records') {
    const origUpsert = chain.upsert.bind(chain);
    chain.upsert = (row, opts) => {
      const rec = { userId: row && row.user_id, water: row && row.water_amount };
      upserts.push(rec);
      return origUpsert(row, opts);
    };
  }
  return chain;
};

const rt = createHookRuntime();
let api = null;
const Comp = () => {
  api = useHealthCloud(globalThis.__USER__, () => '2026-01-01');
  return null;
};

// ---- 阶段 1：A 入队，但云端写入失败（模拟网络错误 / RLS 拒绝）----
globalThis.__USER__ = A;
rt.render(Comp);
rt.settle();
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: { message: 'network down' } });
api.syncToCloud(777, null);
// 立即 flush（等价于防抖到期 / 账号切换 flush）
await api.flushNow();
rt.settle();
const afterFailCount = upserts.length;
const failedWrite = upserts.find((u) => u.water === 777) || null;

// ---- 阶段 2：切到 B，触发账号切换 effect（不得把 A 的载荷写成 B）----
const idxBeforeSwitchToB = upserts.length;
globalThis.__USER__ = B;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
// 切到 B 后，任何 water=777 的写入都必须是 user_id=A（重试原账号），绝不能是 B
const crossAccount = upserts.some((u) => u.water === 777 && u.userId !== 'user-aaa');

// ---- 阶段 3：切回 A，云端恢复，pending 应可重试并成功 ----
// 关键：只统计「切到 B 之后」新增的写入，避免把阶段 1 的失败尝试误判为重试成功。
const idxBeforeRetry = upserts.length;
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__USER__ = A;
rt.render(Comp);
rt.settle();
// 账号切回 A 时 effect 会尝试 flush 残留 pending
await new Promise((r) => setTimeout(r, 20));
rt.settle();
// 若 effect 未自动重试，显式 flush 一次（模拟用户再次触发同步）
await api.flushNow();
rt.settle();
const retryWrites = upserts.slice(idxBeforeRetry);
const retriedOk = retryWrites.some((u) => u.water === 777 && u.userId === 'user-aaa');

// ---- 阶段 4：成功后 pending 必须被移除 —— 再 flush 不应产生新的 777 写入 ----
const countBeforeFinalFlush = upserts.length;
await api.flushNow();
rt.settle();
const countAfterFinalFlush = upserts.length;
const pendingRemovedAfterSuccess = countAfterFinalFlush === countBeforeFinalFlush;

process.stdout.write(JSON.stringify({
  afterFailCount,
  failedWrite,
  crossAccount,
  retriedOk,
  retryWrites,
  pendingRemovedAfterSuccess,
  upserts,
}));
`);
    // 1) 绝不跨账号提交
    assert.equal(out.crossAccount, false, 'A 的载荷（water=777）绝不得以 B 的 user_id 写入');
    // 2) 提交失败后 pending 仍可恢复（失败时确实尝试过写入，且未被当作成功）
    assert.ok(out.afterFailCount >= 1, '失败路径必须真实发起过 upsert（证明 pending 被尝试提交）');
    assert.equal(out.failedWrite && out.failedWrite.userId, 'user-aaa', '失败写入必须归属 A（不得写成 B）');
    // 3) 切回原账号后可重试并成功（必须发生在切到 B 之后，而非阶段 1 的失败尝试）
    assert.equal(out.retriedOk, true, '切回 A 后 pending 必须可重试并成功写入 user_id=A');
    // 4) 只有成功确认后才能移除 pending
    assert.equal(out.pendingRemovedAfterSuccess, true, '成功确认后 pending 必须被移除（再次 flush 不再重复写入）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X08b — 健康 ABA：A→B→A 的代际隔离（CR-05）
//
// 缺陷（修复前，T4-B1 基线）：loadedOwnerRef 只记录 userId。A→B→A 之后
//       userId 回到 A，旧 A 会话的 hydrate 迟到结果会被误判为「仍是当前
//       owner」，从而覆盖新 A 会话的数据。
// 期望（修复后）：owner 标记为 { userId, epoch } 复合值；每次 userId 变化
//       （含 A→B→A 的中间 B）都推进 sessionEpoch。旧 epoch 的 hydrate 必须
//       fail-closed 拒绝写盘。
// ===========================================================================
test('T-X08b 健康 ABA（A→B→A）旧会话 hydrate 必须被代际拦截', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage, buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const kA = buildHealthKeys(A);

// 预置 A 的真实磁盘数据：300ml
await AS.setItem(kA.water, '300');
await AS.setItem(kA.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(kA.active, '2026-11-18');

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useHealthStorage('2026-11-18', globalThis.__UID__); return null; };

// 1) A 身份渲染并完成 load（epoch=0）
globalThis.__UID__ = A;
rt.render(Comp);
await api.load();
rt.settle();
const epochA1 = api.getSessionEpoch();

// 2) 切到 B（epoch 推进）
globalThis.__UID__ = B;
rt.render(Comp);
rt.settle();
const epochB = api.getSessionEpoch();

// 3) 切回 A（epoch 再次推进；userId 回到 A，但 epoch 已不同于 epochA1）
globalThis.__UID__ = A;
rt.render(Comp);
rt.settle();
const epochA2 = api.getSessionEpoch();

// 4) 旧 A 会话的迟到 hydrate：携带旧 epoch（epochA1）→ 必须被拒绝
api.hydrateFromCloud(
  { waterAmount: 9999, mealsStatus: { '早餐': true, '午餐': true, '晚餐': true } },
  A,
  epochA1
);
rt.settle();
await new Promise((r) => setTimeout(r, 10));
const waterAfterStaleHydrate = await AS.getItem(kA.water);

// 5) 新 A 会话的合法 hydrate：携带当前 epoch（epochA2）→ 必须被接受
api.hydrateFromCloud(
  { waterAmount: 1234, mealsStatus: { '早餐': true, '午餐': false, '晚餐': false } },
  A,
  epochA2
);
rt.settle();
await new Promise((r) => setTimeout(r, 10));
const waterAfterFreshHydrate = await AS.getItem(kA.water);

process.stdout.write(JSON.stringify({
  epochA1, epochB, epochA2,
  waterAfterStaleHydrate, waterAfterFreshHydrate,
}));
`);
    assert.ok(out.epochB > out.epochA1, 'A→B 必须推进 sessionEpoch');
    assert.ok(out.epochA2 > out.epochB, 'B→A 必须再次推进 sessionEpoch（ABA 防护）');
    assert.equal(out.waterAfterStaleHydrate, '300', '旧 A 会话（旧 epoch）的迟到 hydrate 不得覆盖 A 的磁盘数据');
    assert.equal(out.waterAfterFreshHydrate, '1234', '当前 A 会话（当前 epoch）的 hydrate 必须正常写入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X05c — TOKEN_REFRESHED 不得被视为新会话（CR-06）
//
// 缺陷（修复前，T4-B1 基线）：applySession 仅凭 access_token 变化判定
//       tokenRotated，于是正常的 JWT 刷新（TOKEN_REFRESHED 事件）被误判为
//       「会话已更换」，推进 authEpoch 并使下游在途请求失效。
// 期望（修复后）：TOKEN_REFRESHED 事件不推进 authEpoch；只有真实新登录
//       （SIGNED_IN 且 token 变化）才推进。
// ===========================================================================
test('T-X05c TOKEN_REFRESHED 不得推进 authEpoch（正常刷新不等于新会话）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { AuthProvider } = await import('./src/hooks/useAuth.js');

let authCb = null;
const supabaseMod = await import('./src/services/supabase.js');
supabaseMod.supabase.auth.onAuthStateChange = (cb) => {
  authCb = cb;
  return { data: { subscription: { unsubscribe() {} } } };
};

globalThis.__GETSESSION_IMPL__ = async () => ({
  data: { session: { user: { id: 'user-aaa' }, access_token: 'tok-a1' } },
  error: null,
});

const rt = createHookRuntime();
let ctx = null;
const Comp = () => { const el = AuthProvider({ children: null }); ctx = el.props.value; return null; };
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const epochAfterLogin = ctx.authEpoch;

// 1) 正常 JWT 刷新：同 user，access_token 变化，事件 TOKEN_REFRESHED
authCb('TOKEN_REFRESHED', { user: { id: 'user-aaa' }, access_token: 'tok-a2' });
rt.settle();
const epochAfterRefresh = ctx.authEpoch;

// 2) 真实新登录：同 user 但事件 SIGNED_IN 且 token 变化（非刷新）
authCb('SIGNED_IN', { user: { id: 'user-aaa' }, access_token: 'tok-a3' });
rt.settle();
const epochAfterSignIn = ctx.authEpoch;

process.stdout.write(JSON.stringify({ epochAfterLogin, epochAfterRefresh, epochAfterSignIn }));
`);
    assert.equal(out.epochAfterRefresh, out.epochAfterLogin, 'TOKEN_REFRESHED 不得推进 authEpoch（正常刷新不是新会话）');
    assert.ok(out.epochAfterSignIn > out.epochAfterRefresh, '真实新登录（SIGNED_IN + token 变化）必须推进 authEpoch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X04b — Signed URL owner 变更必须触发 React 重渲染（CR-07）
//
// 风险：模块级 renderOwnerId/renderEpoch 只在组件重渲染时刷新；
//       setSignedUrlOwner() 本身不触发 React 更新，导致身份切换后
//       Hook 仍返回旧 owner 的 url，直到下一次无关重渲染。
// 期望（修复后）：setSignedUrlOwner 通过订阅者通知 Hook 强制重渲染。
// ===========================================================================
test('T-X04b setSignedUrlOwner 变更必须触发 Hook 重渲染（无需外部 rerender）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const SU = await import('./src/hooks/chat/useSignedMediaUrl.js');

const A = 'user-aaa', B = 'user-bbb';
const P = 'user-aaa/img_1.jpg';

SU.setSignedUrlOwner(A);
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://signed/A/' + p }, error: null });

const rt = createHookRuntime();
let hookResult = null;
const Comp = () => { hookResult = SU.useSignedMediaUrl(P); return null; };

rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const urlA = hookResult.url;
const renderCountBefore = rt.renderCount;

// 切到 B：只调用 setSignedUrlOwner，**不**手动 rt.render。
SU.setSignedUrlOwner(B);
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://signed/B/' + p }, error: null });
rt.settle();
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const urlB = hookResult.url;
const renderCountAfter = rt.renderCount;

process.stdout.write(JSON.stringify({ urlA, urlB, renderCountBefore, renderCountAfter }));
`);
    assert.equal(out.urlA, 'https://signed/A/user-aaa/img_1.jpg', 'A 身份应拿到 A 的签名 URL');
    assert.ok(out.renderCountAfter > out.renderCountBefore, 'setSignedUrlOwner 变更必须触发 Hook 重渲染（订阅者通知）');
    assert.notEqual(out.urlB, out.urlA, '身份切换后（无需外部 rerender）Hook 不得继续返回旧账号的 url');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X07b — SIGNED_OUT 事件在 signOut 在途时必须被忽略（CR-08）
//
// 风险：signOut() 内部先调用 auth.signOut()，GoTrue 可能先派发 SIGNED_OUT
//       事件，随后 signOut() 才检查 authStorageStatus.get() 失败并设置
//       signOutError。若 SIGNED_OUT 事件先清空 user，则后续错误路径丢失上下文。
// 期望（修复后）：signOutInFlightRef 为 true 期间到达的 SIGNED_OUT 被忽略。
// ===========================================================================
test('T-X07b signOut 在途时到达的 SIGNED_OUT 事件必须被忽略', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { AuthProvider } = await import('./src/hooks/useAuth.js');

let authCb = null;
const supabaseMod = await import('./src/services/supabase.js');
supabaseMod.supabase.auth.onAuthStateChange = (cb) => {
  authCb = cb;
  return { data: { subscription: { unsubscribe() {} } } };
};

globalThis.__GETSESSION_IMPL__ = async () => ({
  data: { session: { user: { id: 'user-aaa' }, access_token: 'tok-a1' } },
  error: null,
});

const rt = createHookRuntime();
let ctx = null;
const Comp = () => { const el = AuthProvider({ children: null }); ctx = el.props.value; return null; };
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const userBefore = ctx.user && ctx.user.id;

// signOut 在途：auth.signOut 挂起，期间 GoTrue 先派发 SIGNED_OUT
let resolveSignOut;
globalThis.__SIGNOUT_IMPL__ = () => new Promise((r) => { resolveSignOut = r; });
const p = ctx.signOut();
// signOut 内部先 await profiles.update，再 await auth.signOut；
// 让出若干 tick 使流程推进到 auth.signOut()（此时 resolveSignOut 才被赋值）。
for (let i = 0; i < 5 && !resolveSignOut; i++) {
  await new Promise((r) => setTimeout(r, 5));
}
rt.settle();

// 在 signOut 尚未完成时派发 SIGNED_OUT（乱序）
authCb('SIGNED_OUT', null);
rt.settle();
const userDuringSignOut = ctx.user && ctx.user.id;

// 完成 signOut
resolveSignOut({ error: null });
await p;
rt.settle();
const userAfterSignOut = ctx.user;

process.stdout.write(JSON.stringify({ userBefore, userDuringSignOut, userAfterSignOut }));
`);
    assert.equal(out.userBefore, 'user-aaa', '初始应已登录 A');
    assert.equal(out.userDuringSignOut, 'user-aaa', 'signOut 在途时到达的 SIGNED_OUT 不得提前清空 user');
    assert.equal(out.userAfterSignOut, null, 'signOut 完成后 user 必须为 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X06b — 浏览器全部写回调（delete/clear/toggle/remove）都必须绑定 owner（CR-03）
//
// 缺陷（修复前，T4-B1 基线）：只有 addHistory 做了 owner 绑定；deleteHistory /
//       clearHistory / toggleBookmark / removeBookmark 仍可在 A→B 切换后由
//       A 的旧回调写 B 的 key。
// 期望（修复后）：五个写回调全部绑定「事件发起时的 owner」，owner 已变化则丢弃。
// ===========================================================================
test('T-X06b 浏览器 delete/clear/toggle/remove 旧回调均不得写 B 的 key', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory.js');
const { buildBrowserHistoryKey, buildBrowserBookmarksKey } = await import('./src/constants/browser/index.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const hB = buildBrowserHistoryKey(B);
const bmB = buildBrowserBookmarksKey(B);

const bHistorySeed = [
  { id: 'b1', url: 'https://b1.example.com', title: 'B1' },
  { id: 'b2', url: 'https://b2.example.com', title: 'B2' },
];
const bBookmarksSeed = [
  { id: 'bm1', url: 'https://bm1.example.com', title: 'BM1' },
  { id: 'bm2', url: 'https://bm2.example.com', title: 'BM2' },
];
await AS.setItem(hB, JSON.stringify(bHistorySeed));
await AS.setItem(bmB, JSON.stringify(bBookmarksSeed));

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useBrowserHistory(globalThis.__UID__); return null; };

// 1) A 身份渲染，捕获 A 的旧回调
globalThis.__UID__ = A;
rt.render(Comp);
rt.settle();
const oldDelete = api.deleteHistory;
const oldClear = api.clearHistory;
const oldToggle = api.toggleBookmark;
const oldRemove = api.removeBookmark;

// 2) 切到 B
globalThis.__UID__ = B;
rt.render(Comp);
rt.settle();

// 3) A 的旧回调此刻才执行（迟到事件）
//    注意：toggleBookmark/removeBookmark 是 async，必须 await 才能观测落盘结果。
oldDelete('b1');
oldClear();
await oldToggle('https://bm1.example.com', 'BM1');
await oldRemove('https://bm1.example.com');
rt.settle();
await new Promise((r) => setTimeout(r, 20));

// 4) B 的数据必须完好无损
const bHistoryAfter = JSON.parse(await AS.getItem(hB));
const bBookmarksAfter = JSON.parse(await AS.getItem(bmB));

process.stdout.write(JSON.stringify({
  bHistoryUrls: bHistoryAfter.map((x) => x.url),
  bBookmarkUrls: bBookmarksAfter.map((x) => x.url),
}));
`);
    // 注意：B 的书签会与 DEFAULT_BOOKMARKS 种子合并，因此用「包含」而非「精确相等」。
    // 关键断言：B 自己的两条书签必须仍在（未被 A 的旧 toggle/remove 删除）。
    assert.ok(
      out.bHistoryUrls.includes('https://b1.example.com') &&
        out.bHistoryUrls.includes('https://b2.example.com'),
      'A 的旧 delete/clear 回调不得删除 B 的历史'
    );
    assert.ok(
      out.bBookmarkUrls.includes('https://bm1.example.com') &&
        out.bBookmarkUrls.includes('https://bm2.example.com'),
      'A 的旧 toggle/remove 回调不得删除 B 的书签'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X09b — Signed URL 未登录边界（RISK）
//
// 风险：ownerId === null（未登录）时，getSignedUrl 仍以 anon 身份请求签名，
//       并可能命中历史 anon 缓存残留。
// 期望（修复后）：无已认证 owner 时 fail-closed —— 返回 null，且绝不调用
//       createSignedUrl、绝不返回 anon 缓存内容。
// ===========================================================================
test('T-X09b 未登录时 getSignedUrl 必须 fail-closed（不请求签名、不返回 anon 缓存）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const SM = await import('./src/hooks/chat/useSignedMediaUrl.js');

// 记录 createSignedUrl 调用次数
let signCalls = 0;
globalThis.__SIGN_IMPL__ = (p, ttl) => {
  signCalls += 1;
  return Promise.resolve({ data: { signedUrl: 'https://x/' + p }, error: null });
};

// 1) 未登记任何 owner（未登录）→ 直接请求签名
const urlAnon = await SM.getSignedUrl('user-aaa/photo.jpg');

// 2) 即便存在历史 anon 缓存残留，也不得返回
//    先以 anon 身份（ownerId=null）尝试写入缓存：修复后应被 fail-closed 拦截
const urlAnon2 = await SM.getSignedUrl('user-aaa/photo.jpg');

process.stdout.write(JSON.stringify({ urlAnon, urlAnon2, signCalls }));
`);
    assert.equal(out.urlAnon, null, '未登录时 getSignedUrl 必须返回 null（fail-closed）');
    assert.equal(out.urlAnon2, null, '未登录时重复调用仍必须返回 null');
    assert.equal(out.signCalls, 0, '未登录时绝不得调用 createSignedUrl（不得以 anon 身份请求签名）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X09a — BrowserSessionContext 全局 lastUrl
//
// 缺陷：LAST_URL_KEY 是全局常量 '@browser_last_url'，不区分账号。
//       A 访问的网址会被 B 读到（lastUrl 串号）。
// 期望（修复后）：lastUrl 按 userId 隔离；旧全局 key 原样保留。
// ===========================================================================
test('T-X09a BrowserSessionContext lastUrl 必须按账号隔离', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { BrowserSessionProvider } = await import('./src/context/BrowserSessionContext.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';

// 预置旧全局 key（无主历史数据，必须原样保留）
await AS.setItem('@browser_last_url', 'https://legacy.example.com');

// 直接驱动 Provider 组件函数（它内部使用 useState/useEffect/useCallback/useRef）。
// Provider 返回 React.createElement(...)，其 props.value 即 context value。
// 修复后 Provider 会接收 userId（prop 或 useAuth），这里以 prop 形式注入当前账号。
const rt = createHookRuntime();
let ctx = null;
const Comp = () => {
  const el = BrowserSessionProvider({ children: null, userId: globalThis.__UID__ });
  ctx = el && el.props ? el.props.value : null;
  return null;
};

// 1) A 身份：记录 A 的网址
globalThis.__UID__ = A;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
ctx.rememberUrl('https://a-only.example.com');
rt.settle();
await new Promise((r) => setTimeout(r, 10));

// 2) 切到 B 身份：B 不应读到 A 的网址
globalThis.__UID__ = B;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
rt.settle();
const bLastUrl = ctx.lastUrl;

// 3) 旧全局 key 必须原样保留
const legacy = await AS.getItem('@browser_last_url');

process.stdout.write(JSON.stringify({ bLastUrl, legacy }));
`);
    // 修复后：B 不得读到 A 的 lastUrl
    assert.notEqual(out.bLastUrl, 'https://a-only.example.com', 'B 不得读到 A 的 lastUrl（必须按账号隔离）');
    assert.equal(out.legacy, 'https://legacy.example.com', '旧全局 lastUrl key 必须原样保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-X09c — 账户删除 key 精确匹配（回归保护，无源码改动）
//
// 该缺陷经 T6-A 裁决为 FALSE POSITIVE（实现正确）。本测试锁定现有精确匹配
// 行为，防止未来退化为「前缀一刀切」误删其他账号数据。
// ===========================================================================
test('T-X09c 账户删除 key 精确匹配不得误删前缀相似的他人 key', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const USER_SCOPED_V2_KEY_PREFIXES = [
  '@sync_health_v2_',
  '@sync_browser_history_v2_',
  '@sync_browser_bookmarks_v2_',
  '@sync_browser_bookmarks_seed_v2_',
  '@user_profile_cache_v2_',
];
const isCurrentUserV2Key = (key, userId) => {
  if (!userId) return false;
  return USER_SCOPED_V2_KEY_PREFIXES.some((prefix) => {
    if (!key.startsWith(prefix)) return false;
    const rest = key.slice(prefix.length);
    return rest === userId || rest.startsWith(userId + '_');
  });
};

const A = 'user-aaa';
const keys = [
  '@sync_health_v2_user-aaa_water',        // 命中
  '@sync_health_v2_user-aaa-extra_water',  // 前缀相似但非本用户 → 不命中
  '@sync_health_v2_user-aaabbb_water',     // 前缀相似但非本用户 → 不命中
  '@sync_browser_history_v2_user-aaa',     // 命中
  '@sync_browser_history_v2_user-aaa2',    // 前缀相似但非本用户 → 不命中
];
const matched = keys.filter((k) => isCurrentUserV2Key(k, A));

process.stdout.write(JSON.stringify({ matched }));
`);
    assert.deepEqual(out.matched.sort(), [
      '@sync_health_v2_user-aaa_water',
      '@sync_browser_history_v2_user-aaa',
    ].sort(), '精确匹配必须只命中本用户 key，不得误删前缀相似的他人 key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// ============ 第二轮复审返工（14-01 ~ 14-06）新增用例 ======================
// ===========================================================================

// ===========================================================================
// T-14-01 — 健康 pending 多槽隔离（BLOCKER）
//
// 缺陷（13 版）：pendingRef 只有**一个槽**，syncToCloud 无条件覆盖。
//   序列：A 入队 A/2026-11-18 → upsert 返回 {error}（失败保留）→ 切到 B →
//   B 调用 syncToCloud() → 覆盖同一槽 → 切回 A 并 flushNow() → A 的原始载荷
//   已丢失，永久不可恢复。同账号不同日期的新记录也会覆盖旧的失败记录。
// 期望（修复后）：pending 按 ownerId + recordDate 隔离为多槽 Map；
//   不同账号/不同日期的失败互不覆盖；成功只删除对应那一项。
//
// 本用例刻意让 B **真实写入**（不是 A→B→A 空转），并同时验证：
//   1. A 失败后切到 B，B 写入自己的记录，A 的失败槽不被覆盖；
//   2. 切回 A 后 A 的原始载荷仍可重试并成功；
//   3. 同账号两个不同日期各自保留、各自重试。
// ===========================================================================
test('T-14-01 健康 pending 必须按 ownerId+recordDate 多槽隔离，B 写入不得覆盖 A 的失败槽', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };

const upserts = [];
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });

const supabaseMod = await import('./src/services/supabase.js');
const origFrom = supabaseMod.supabase.from.bind(supabaseMod.supabase);
supabaseMod.supabase.from = (table) => {
  const chain = origFrom(table);
  if (table === 'health_records') {
    const origUpsert = chain.upsert.bind(chain);
    chain.upsert = (row, opts) => {
      upserts.push({ userId: row && row.user_id, water: row && row.water_amount, date: row && row.record_date });
      return origUpsert(row, opts);
    };
  }
  return chain;
};

// 可切换的"今天"，用于构造同账号不同日期
globalThis.__TODAY__ = '2026-11-18';
const rt = createHookRuntime();
let api = null;
const Comp = () => {
  api = useHealthCloud(globalThis.__USER__, () => globalThis.__TODAY__);
  return null;
};

// ---- 阶段 1：A 在 2026-11-18 入队 777，云端失败 ----
globalThis.__USER__ = A;
rt.render(Comp);
rt.settle();
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: { message: 'network down' } });
api.syncToCloud(777, null);
await api.flushNow();
rt.settle();
const aFailedAttempts = upserts.filter((u) => u.userId === 'user-aaa' && u.water === 777).length;

// ---- 阶段 2：A 在另一个日期 2026-11-19 再入队 888，同样失败 ----
globalThis.__TODAY__ = '2026-11-19';
rt.render(Comp);
rt.settle();
api.syncToCloud(888, null);
await api.flushNow();
rt.settle();
const aFailedAttempts2 = upserts.filter((u) => u.userId === 'user-aaa' && u.water === 888).length;

// ---- 阶段 3：切到 B，B 真实写入自己的记录 555（成功）----
globalThis.__TODAY__ = '2026-11-18';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__USER__ = B;
rt.render(Comp);
rt.settle();
api.syncToCloud(555, null);
await api.flushNow();
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const bWrote = upserts.some((u) => u.userId === 'user-bbb' && u.water === 555);
// B 的任何写入都不得携带 A 的载荷
const crossAccount = upserts.some((u) => u.userId === 'user-bbb' && (u.water === 777 || u.water === 888));

// ---- 阶段 4：切回 A，两个日期的失败槽都应可重试并成功 ----
const idxBeforeRetry = upserts.length;
globalThis.__USER__ = A;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
await api.flushNow();
rt.settle();
const retryWrites = upserts.slice(idxBeforeRetry);
const retried777 = retryWrites.some((u) => u.userId === 'user-aaa' && u.water === 777);
const retried888 = retryWrites.some((u) => u.userId === 'user-aaa' && u.water === 888);

// ---- 阶段 5：成功后两槽都应被移除，再 flush 不产生新写入 ----
const countBeforeFinal = upserts.length;
await api.flushNow();
rt.settle();
const pendingRemoved = upserts.length === countBeforeFinal;

process.stdout.write(JSON.stringify({
  aFailedAttempts, aFailedAttempts2, bWrote, crossAccount,
  retried777, retried888, pendingRemoved, upserts,
}));
`);
    assert.ok(out.aFailedAttempts >= 1, 'A 的 777 必须真实尝试过写入（证明入队）');
    assert.ok(out.aFailedAttempts2 >= 1, 'A 的 888（另一日期）必须真实尝试过写入');
    assert.equal(out.bWrote, true, 'B 必须能真实写入自己的记录（本用例不允许 B 空转）');
    assert.equal(out.crossAccount, false, 'B 的写入绝不得携带 A 的载荷（777/888）');
    assert.equal(out.retried777, true, '切回 A 后，2026-11-18 的失败载荷 777 必须仍可重试成功（未被 B 覆盖）');
    assert.equal(out.retried888, true, '切回 A 后，2026-11-19 的失败载荷 888 必须仍可重试成功（未被同账号另一日期覆盖）');
    assert.equal(out.pendingRemoved, true, '两个槽都成功后必须被移除（再次 flush 不再写入）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-14-02 — 同 userId 新会话必须作废旧健康请求（BLOCKER）
//
// 缺陷（13 版）：useHealthStorage 的 sessionEpochRef 只在 userId 变化时自增；
//   AuthProvider 在「同账号新会话」时 bump 了 authEpoch，但 HealthStorage 不知道，
//   于是旧会话在途的 load/hydrate 仍能通过 expectedOwnerId + expectedEpoch 校验。
// 期望（修复后）：authEpoch 作为第三个参数传入；authEpoch 变化同样推进
//   sessionEpoch，使旧会话的 hydrate 被 fail-closed 拒绝。
//
// 本用例刻意**不经过** committed null / B 状态：userId 始终是 A，
// 仅 authEpoch 从 0 → 1（模拟同账号重新登录）。
// ===========================================================================
test('T-14-02 同 userId 新会话（authEpoch 变化）必须作废旧会话的健康 hydrate', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage, buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa';
const kA = buildHealthKeys(A);
await AS.setItem(kA.water, '300');
await AS.setItem(kA.meals, JSON.stringify({ '早餐': false, '午餐': false, '晚餐': false }));
await AS.setItem(kA.active, '2026-11-18');

const rt = createHookRuntime();
let api = null;
const Comp = () => {
  api = useHealthStorage('2026-11-18', globalThis.__UID__, globalThis.__EPOCH__);
  return null;
};

// 1) A 会话 1（authEpoch=0）完成 load
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
await api.load();
rt.settle();
const epochSession1 = api.getSessionEpoch();

// 2) 同 userId 新会话：authEpoch 0 → 1（userId 不变，不经过 null / B）
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
const epochSession2 = api.getSessionEpoch();

// 3) 旧会话（session1 epoch）的迟到 hydrate → 必须被拒绝
api.hydrateFromCloud(
  { waterAmount: 9999, mealsStatus: { '早餐': true, '午餐': true, '晚餐': true } },
  A,
  epochSession1
);
rt.settle();
await new Promise((r) => setTimeout(r, 10));
const waterAfterStale = await AS.getItem(kA.water);

// 4) 新会话（session2 epoch）的合法 hydrate → 必须被接受
api.hydrateFromCloud(
  { waterAmount: 1234, mealsStatus: { '早餐': true, '午餐': false, '晚餐': false } },
  A,
  epochSession2
);
rt.settle();
await new Promise((r) => setTimeout(r, 10));
const waterAfterFresh = await AS.getItem(kA.water);

process.stdout.write(JSON.stringify({ epochSession1, epochSession2, waterAfterStale, waterAfterFresh }));
`);
    assert.ok(out.epochSession2 > out.epochSession1, '同 userId 但 authEpoch 变化必须推进 sessionEpoch');
    assert.equal(out.waterAfterStale, '300', '旧会话（旧 epoch）的迟到 hydrate 不得覆盖磁盘数据');
    assert.equal(out.waterAfterFresh, '1234', '新会话（新 epoch）的 hydrate 必须正常写入');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-14-02b — TOKEN_REFRESHED 不得使健康会话失效（防误伤）
//
// 与 T-14-02 互补：正常 JWT 刷新不 bump authEpoch，因此 HealthStorage 的
// sessionEpoch 不变，在途请求不被误杀。
// ===========================================================================
test('T-14-02b TOKEN_REFRESHED 不推进 authEpoch 时健康会话代际保持不变', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage } = await import('./src/hooks/health/useHealthStorage.js');

const A = 'user-aaa';
const rt = createHookRuntime();
let api = null;
const Comp = () => {
  api = useHealthStorage('2026-11-18', globalThis.__UID__, globalThis.__EPOCH__);
  return null;
};

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
const e1 = api.getSessionEpoch();

// 正常刷新：authEpoch 不变，仅重渲染
rt.render(Comp);
rt.settle();
const e2 = api.getSessionEpoch();

process.stdout.write(JSON.stringify({ e1, e2 }));
`);
    assert.equal(out.e2, out.e1, 'authEpoch 不变时 sessionEpoch 必须保持不变（正常刷新不得误伤在途请求）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-14-03 — 浏览器 A→B→A 旧回调必须被 epoch 拦截（MAJOR）
//
// 缺陷（13 版）：五个写回调只比对 userId。A→B→A 之后 userId 回到 A，
//   且 V2 key 完全相同 → A 会话 1 的旧回调可写进 A 会话 2。
// 期望（修复后）：回调绑定创建时的 authEpoch；执行时 epoch 不匹配则丢弃。
//
// 本用例覆盖全部五个写回调 + BrowserSessionContext 的 rememberUrl/setPendingUrl。
// ===========================================================================
test('T-14-03 A→B→A 后浏览器旧回调（五回调 + rememberUrl/setPendingUrl）必须被 epoch 拦截', () => {
  // ⚠️ 本用例拆成两个独立沙箱运行：
  //    useBrowserHistory 与 BrowserSessionProvider 各自是独立组件，必须各自
  //    独占一份 Hook 槽位。若在同一组件函数里同时调用二者（把 Provider 当普通
  //    函数调用），会共享同一份 Hook 游标，导致 useRef/useEffect 槽位错位，
  //    这是测试桩的伪影，而非被测逻辑。拆开后每个组件槽位干净，断言更可信。
  const dir = buildSandbox();
  try {
    // ---- 运行 A：五个历史/书签回调 ----
    const outHistory = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory.js');
const { buildBrowserHistoryKey, buildBrowserBookmarksKey } = await import('./src/constants/browser/index.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const hA = buildBrowserHistoryKey(A);
const bmA = buildBrowserBookmarksKey(A);

// A 会话 2 的真实数据（旧回调绝不得改动它）
const aHistorySeed = [{ id: 'a2', url: 'https://a2.example.com', title: 'A2' }];
const aBookmarksSeed = [{ id: 'am2', url: 'https://am2.example.com', title: 'AM2' }];
await AS.setItem(hA, JSON.stringify(aHistorySeed));
await AS.setItem(bmA, JSON.stringify(aBookmarksSeed));

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useBrowserHistory(globalThis.__UID__, globalThis.__EPOCH__); return null; };

// 1) A 会话 1（epoch=0）：捕获全部旧回调
globalThis.__UID__ = A; globalThis.__EPOCH__ = 0;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects(); rt.settle();
const oldAdd = api.addHistory;
const oldDelete = api.deleteHistory;
const oldClear = api.clearHistory;
const oldToggle = api.toggleBookmark;
const oldRemove = api.removeBookmark;

// 2) A → B（epoch=1）
globalThis.__UID__ = B; globalThis.__EPOCH__ = 1;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects(); rt.settle();

// 3) B → A（epoch=2）：userId 回到 A，但已是新会话
globalThis.__UID__ = A; globalThis.__EPOCH__ = 2;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects(); rt.settle();

// 4) A 会话 1 的旧回调此刻才执行（迟到事件）
oldAdd('https://a1-late.example.com', 'A1-late');
oldDelete('a2');
oldClear();
await oldToggle('https://am2.example.com', 'AM2');
await oldRemove('https://am2.example.com');
rt.settle();
await new Promise((r) => setTimeout(r, 30));

const aHistoryAfter = JSON.parse(await AS.getItem(hA));
const aBookmarksAfter = JSON.parse(await AS.getItem(bmA));
process.stdout.write(JSON.stringify({
  aHistoryUrls: aHistoryAfter.map((x) => x.url),
  aBookmarkUrls: aBookmarksAfter.map((x) => x.url),
}));
`);

    // ---- 运行 B：BrowserSessionProvider 的 rememberUrl / setPendingUrl ----
    const outSession = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { BrowserSessionProvider } = await import('./src/context/BrowserSessionContext.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const lastUrlKeyA = '@browser_last_url_v2_' + A;
// A 会话 2 的真实 lastUrl（旧回调绝不得改动它）
await AS.setItem(lastUrlKeyA, 'https://a2-last.example.com');

const rt = createHookRuntime();
let sess = null;
const Comp = () => {
  const el = BrowserSessionProvider({ children: null, userId: globalThis.__UID__, authEpoch: globalThis.__EPOCH__ });
  sess = el && el.props ? el.props.value : null;
  return null;
};

// 1) A 会话 1（epoch=0）：捕获旧回调
globalThis.__UID__ = A; globalThis.__EPOCH__ = 0;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects(); rt.settle();
const oldRemember = sess.rememberUrl;
const oldSetPending = sess.setPendingUrl;

// 2) A → B（epoch=1）
globalThis.__UID__ = B; globalThis.__EPOCH__ = 1;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects(); rt.settle();

// 3) B → A（epoch=2）：新 A 会话
globalThis.__UID__ = A; globalThis.__EPOCH__ = 2;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects(); rt.settle();

// 4) A 会话 1 的旧回调迟到执行
oldRemember('https://a1-late-url.example.com');
oldSetPending('https://a1-late-pending.example.com');
rt.settle();
await new Promise((r) => setTimeout(r, 30));

const aLastUrl = await AS.getItem(lastUrlKeyA);
process.stdout.write(JSON.stringify({ aLastUrl }));
`);

    assert.ok(
      outHistory.aHistoryUrls.includes('https://a2.example.com'),
      'A 会话 1 的旧 delete/clear 不得删除 A 会话 2 的历史'
    );
    assert.ok(
      !outHistory.aHistoryUrls.includes('https://a1-late.example.com'),
      'A 会话 1 的旧 addHistory 不得写入 A 会话 2 的历史'
    );
    assert.ok(
      outHistory.aBookmarkUrls.includes('https://am2.example.com'),
      'A 会话 1 的旧 toggle/remove 不得删除 A 会话 2 的书签'
    );
    assert.notEqual(
      outSession.aLastUrl,
      'https://a1-late-url.example.com',
      'A 会话 1 的旧 rememberUrl 不得写入 A 会话 2 的 lastUrl'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-14-04 — 同一事件循环内连续 addHistory 不得互相覆盖（MAJOR，本轮回归）
//
// 缺陷（13 版）：addHistory 读取 historyListRef.current（由 effect 镜像，滞后于
//   React state）计算 next，再 setHistoryList(next)。同一批次内两次调用都基于
//   同一份陈旧 ref → 后者覆盖前者（本轮引入的行为回归）。
// 期望（修复后）：单点写入时同步更新 shadow ref，使第二次调用读到第一次的结果；
//   两条记录同时存在于内存与磁盘。
// ===========================================================================
test('T-14-04 同一事件循环内连续 addHistory 两条记录都必须保留（内存 + 磁盘）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory.js');
const { buildBrowserHistoryKey } = await import('./src/constants/browser/index.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa';
const hA = buildBrowserHistoryKey(A);

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useBrowserHistory(globalThis.__UID__, globalThis.__EPOCH__); return null; };

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
rt.settle();

// 同一事件循环内连续两次 addHistory（不 await、不 settle 中间态）
api.addHistory('https://one.example.com', 'One');
api.addHistory('https://two.example.com', 'Two');
rt.settle();
await new Promise((r) => setTimeout(r, 20));

const disk = JSON.parse(await AS.getItem(hA));
const diskUrls = disk.map((x) => x.url);
const memUrls = api.historyList.map((x) => x.url);

process.stdout.write(JSON.stringify({ diskUrls, memUrls }));
`);
    assert.ok(out.diskUrls.includes('https://one.example.com'), '磁盘必须包含第一条历史');
    assert.ok(out.diskUrls.includes('https://two.example.com'), '磁盘必须包含第二条历史（不得被覆盖）');
    assert.ok(out.memUrls.includes('https://one.example.com'), '内存必须包含第一条历史');
    assert.ok(out.memUrls.includes('https://two.example.com'), '内存必须包含第二条历史（不得被覆盖）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-14-05 — Profile 旧请求在 ABA 后不得更新 React state（MAJOR）
//
// 缺陷（13 版）：refresh 只比对实例本地 generationRef.current，未比对模块级
//   getProfileCacheGeneration()。A→B→A 后若该 Hook 实例未发起新 refresh，
//   本地 generation 不变 → 旧 A 请求通过校验并 setProfile(data)。
// 期望（修复后）：在缓存读取后、云端返回后、setProfile 前都同时比对
//   模块级 generation；旧请求一律丢弃。
// ===========================================================================
test('T-14-05 Profile 旧请求在 A→B→A 后不得更新 React state', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const PC = await import('./src/hooks/profile/useProfileCache.js');

const A = 'user-aaa', B = 'user-bbb';

// 默认云端查询立即返回空（供挂载 effect 的 refresh 正常收敛，避免 30s 超时定时器）。
// 需要「挂起」时切换到 __HANG__ 模式，由测试手动 resolve。
// ⚠️ 用数组收集所有挂起查询的 resolver：任何一次 refresh 都可能产生新的挂起查询，
//    若只保留单个 resolveCloud 会被后续查询覆盖，导致遗留查询永不 resolve，
//    其 fetchProfileFromCloud 内的 30s 超时定时器会把子进程拖到 30s。
const pendingResolvers = [];
let queryCount = 0;
globalThis.__HANG__ = false;
globalThis.__PROFILE_QUERY__ = () => {
  queryCount += 1;
  if (globalThis.__HANG__) {
    return new Promise((r) => { pendingResolvers.push(r); });
  }
  return Promise.resolve({ data: null, error: null });
};
const resolveAllPending = (value) => {
  while (pendingResolvers.length) pendingResolvers.shift()(value);
};

const rt = createHookRuntime();
let hook = null;
const Comp = () => { hook = PC.useProfileCache({ id: globalThis.__UID__ }); return null; };

// 1) A 会话 1：登记 owner，挂载（挂载 effect 的 refresh 立即返回空）
PC.setProfileCacheOwner(A);
globalThis.__UID__ = A;
rt.render(Comp);
rt.settle();
// 等待挂载 effect 的 refresh 完整跑完（readProfileCache + fetchProfileFromCloud 均 resolve），
// 确保此时没有在途的「非挂起」查询，再切换到挂起模式。
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const countAfterMount = queryCount;

// 1b) 显式发起一次 refresh，云端挂起（模拟在途旧请求）
globalThis.__HANG__ = true;
const p = hook.refresh();
// 等待 refresh 内部先 await readProfileCache（AsyncStorage）再进入云端查询，
// 直到 __PROFILE_QUERY__ 真正被调用、至少一个挂起 resolver 已就绪。
for (let i = 0; i < 50 && pendingResolvers.length === 0; i++) {
  await new Promise((r) => setTimeout(r, 5));
}
if (pendingResolvers.length === 0) throw new Error('挂起查询未发起（resolver 未就绪）');

// 2) A → B → A（模块级 owner 代际推进两次）
PC.setProfileCacheOwner(B);
PC.setProfileCacheOwner(A);
rt.settle();

// 3) 旧 A 请求此刻返回（resolve 所有挂起查询，避免遗留 30s 超时定时器）
resolveAllPending({ data: { id: A, username: 'stale-a' }, error: null });
await p;
rt.settle();
await new Promise((r) => setTimeout(r, 10));
rt.settle();
// 兜底：settle 期间若又产生了新的挂起查询，一并 resolve，确保子进程无遗留定时器
resolveAllPending({ data: null, error: null });
await new Promise((r) => setTimeout(r, 10));

process.stdout.write(JSON.stringify({ profile: hook.profile }));
`);
    // 修复后：旧 A 请求不得把 stale-a 写进 React state
    assert.ok(
      !out.profile || out.profile.username !== 'stale-a',
      'A→B→A 后旧 A 的 Profile 请求不得更新 React state（必须被模块级代际拦截）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-14-06 — 健康本地 setter 迟到调用不得写新账号 key（RISK → CONFIRMED）
//
// 可达路径：设置页 Alert.alert 的确认按钮（src/app/settings/health.js:61-71，
//   onPress: () => resetToday()）。用户点「重置」→ 弹框 → 期间切换账号 →
//   再点「重置」，旧闭包执行时 keysRef.current 已是新账号 key。
// 期望（修复后）：setter 绑定创建时的 owner+epoch，执行时不匹配则只更新内存、
//   绝不落盘。
// ===========================================================================
test('T-14-06 A 的旧健康 setter 在切到 B 后不得写 B 的 key', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage, buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const kB = buildHealthKeys(B);

// B 的真实数据
await AS.setItem(kB.water, '900');
await AS.setItem(kB.meals, JSON.stringify({ '早餐': true, '午餐': true, '晚餐': true }));
await AS.setItem(kB.maxWater, '2000');
await AS.setItem(kB.motto, 'B 的寄语');

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useHealthStorage('2026-11-18', globalThis.__UID__, globalThis.__EPOCH__); return null; };

// 1) A 身份：捕获 A 的旧 setter（模拟 Alert 弹框期间捕获的闭包）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
const oldReset = api.resetTodayLocal;
const oldSetWater = api.setWater;
const oldSetMaxWater = api.setMaxWater;
const oldSetMotto = api.setMotto;

// 2) 切到 B（epoch 推进）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();

// 3) A 的旧 setter 此刻才执行（Alert 确认按钮迟到触发）
oldReset();
oldSetWater(0);
oldSetMaxWater(500);
oldSetMotto('A 的旧寄语');
rt.settle();
await new Promise((r) => setTimeout(r, 20));

const bWater = await AS.getItem(kB.water);
const bMeals = await AS.getItem(kB.meals);
const bMaxWater = await AS.getItem(kB.maxWater);
const bMotto = await AS.getItem(kB.motto);

process.stdout.write(JSON.stringify({ bWater, bMeals, bMaxWater, bMotto }));
`);
    assert.equal(out.bWater, '900', 'A 的旧 setWater/reset 不得把 B 的饮水写成 0');
    assert.equal(
      out.bMeals,
      JSON.stringify({ '早餐': true, '午餐': true, '晚餐': true }),
      'A 的旧 reset 不得把 B 的三餐写成 EMPTY'
    );
    assert.equal(out.bMaxWater, '2000', 'A 的旧 setMaxWater 不得覆盖 B 的目标水量');
    assert.equal(out.bMotto, 'B 的寄语', 'A 的旧 setMotto 不得覆盖 B 的寄语');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-15-01 — 旧账号 setter 在 B **已完成 load** 后不得污染 B 的 React state
//           （15-01 BLOCKER 的完整复现：state 污染 → 自动落盘 → 写进 B 的 V2 key）
//
// 与 T-14-06 的差异（GPT 第二轮复审明确要求）：
//   · T-14-06 只断言磁盘，且 B 未执行 load()；
//   · 本用例必须先让 B 完成 load()（isLoaded=true、内存态=900），
//     再触发 A 的旧 setter。此时若 setter 先 setState 再被 canPersist 拒绝，
//     B 的 React state 会被改成旧值，随后自动落盘 effect（owner/epoch 对 B 合法）
//     把被污染的 state 写进 B 的 V2 key —— 这正是 15-01 描述的缺陷链。
//
// 断言（5 项，全部不得放宽）：
//   1) B 的 React state.waterAmount 仍为 900
//   2) B 的 V2 water key 仍为 '900'
//   3) B 的 meals / maxWater / motto 均未被改动
//   4) B 自己的新 setter 仍能正常工作（写入 950 并落盘）
//   5) A→B→A 之后，A 旧会话（epoch=0）的 setter 同样被拒绝
// ===========================================================================
test('T-15-01 B 已完成 load 后，A 的旧健康 setter 不得污染 B 的 state 与 V2 key', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { useHealthStorage, buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const kB = buildHealthKeys(B);
const B_MEALS = { '早餐': true, '午餐': true, '晚餐': true };

// B 的真实数据（磁盘预置 900ml）
await AS.setItem(kB.water, '900');
await AS.setItem(kB.meals, JSON.stringify(B_MEALS));
await AS.setItem(kB.maxWater, '2000');
await AS.setItem(kB.motto, 'B 的寄语');

const rt = createHookRuntime();
let api = null;
const Comp = () => { api = useHealthStorage('2026-11-18', globalThis.__UID__, globalThis.__EPOCH__); return null; };

// 1) A 身份：捕获 A 的旧 setter（模拟 Alert 弹框期间捕获的闭包）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
const oldA = {
  reset: api.resetTodayLocal,
  setWater: api.setWater,
  setMeals: api.setMeals,
  setMaxWater: api.setMaxWater,
  setMotto: api.setMotto,
  setStreak: api.setStreak,
  setCheckInDate: api.setCheckInDate,
  setActiveDate: api.setActiveDate,
  setMealGuide: api.setMealGuide,
};

// 2) 切到 B（epoch 推进），并**先完成 B 的 load()**（关键：GPT 要求）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await api.load();
rt.settle();
await new Promise((r) => setTimeout(r, 10));
rt.settle();

const bStateBefore = {
  water: api.waterAmount,
  meals: api.mealsStatus,
  maxWater: api.maxWater,
  motto: api.motto,
};

// 3) B 已加载完成后，A 的旧 setter 才执行（Alert 确认按钮迟到触发）
oldA.reset();
oldA.setWater(0);
oldA.setMeals({ '早餐': false, '午餐': false, '晚餐': false });
oldA.setMaxWater(500);
oldA.setMotto('A 的旧寄语');
oldA.setStreak(99);
oldA.setCheckInDate('2020-01-01');
oldA.setActiveDate('2020-01-01');
oldA.setMealGuide('早餐', 'A 的旧指南');
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();

const bStateAfter = {
  water: api.waterAmount,
  meals: api.mealsStatus,
  maxWater: api.maxWater,
  motto: api.motto,
};
const bDiskAfter = {
  water: await AS.getItem(kB.water),
  meals: await AS.getItem(kB.meals),
  maxWater: await AS.getItem(kB.maxWater),
  motto: await AS.getItem(kB.motto),
};

// 4) B 自己的新 setter 必须仍然正常工作
api.setWater(950);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const bOwnState = api.waterAmount;
const bOwnDisk = await AS.getItem(kB.water);

// 5) A→B→A：回到 A（epoch 推进到 2），再执行 A 旧会话（epoch=0）的 setter
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 2;
rt.render(Comp);
rt.settle();
await api.load();
rt.settle();
await new Promise((r) => setTimeout(r, 10));
rt.settle();
const aStateBefore = api.waterAmount;
oldA.setWater(123);
oldA.reset();
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const aStateAfter = api.waterAmount;

process.stdout.write(JSON.stringify({
  bStateBefore, bStateAfter, bDiskAfter, bOwnState, bOwnDisk,
  aStateBefore, aStateAfter,
}));
`);
    // 1) B 的 React state 未被污染
    assert.equal(out.bStateBefore.water, 900, '前置条件：B load 后 state 应为 900');
    assert.equal(out.bStateAfter.water, 900, 'A 的旧 setter 不得修改 B 的 React state.waterAmount');
    assert.deepEqual(out.bStateAfter.meals, { '早餐': true, '午餐': true, '晚餐': true }, 'A 的旧 setter 不得修改 B 的 mealsStatus');
    assert.equal(out.bStateAfter.maxWater, 2000, 'A 的旧 setter 不得修改 B 的 maxWater');
    assert.equal(out.bStateAfter.motto, 'B 的寄语', 'A 的旧 setter 不得修改 B 的 motto');
    // 2) B 的 V2 key 未被污染
    assert.equal(out.bDiskAfter.water, '900', 'A 的旧 setter 不得把 B 的 V2 water key 写成 0');
    assert.equal(out.bDiskAfter.meals, JSON.stringify({ '早餐': true, '午餐': true, '晚餐': true }), 'A 的旧 setter 不得把 B 的 V2 meals key 写成 EMPTY');
    assert.equal(out.bDiskAfter.maxWater, '2000', 'A 的旧 setter 不得覆盖 B 的 V2 maxWater key');
    assert.equal(out.bDiskAfter.motto, 'B 的寄语', 'A 的旧 setter 不得覆盖 B 的 V2 motto key');
    // 4) B 自己的新 setter 仍正常
    assert.equal(out.bOwnState, 950, 'B 自己的 setWater 必须仍然生效（state）');
    assert.equal(out.bOwnDisk, '950', 'B 自己的 setWater 必须仍然落盘（V2 key）');
    // 5) A→B→A 后旧 A 会话 setter 仍被拒绝
    assert.equal(out.aStateAfter, out.aStateBefore, 'A→B→A 后，A 旧会话（epoch=0）的 setter 必须被拒绝');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-15-02 — 同 userId 新会话（authEpoch 变化）不得消费旧会话遗留的 pendingUrl
//
// 缺陷路径（GPT 第二轮复审 15-02）：
//   BrowserSessionContext 的渲染期重置条件是 `stateOwner !== userId`。
//   同一账号重新登录（userId 不变、authEpoch 0→1）时该条件不成立，
//   Provider 也不卸载 → 旧会话写入的 pendingUrl 仍留在 state 中，
//   新会话调用 consumePendingUrl 会拿到旧会话的 URL（跨会话交接泄漏）。
//
// 期望（修复后）：
//   · 新会话 consumePendingUrl 必须拿不到旧会话遗留的 URL；
//   · 同账号 lastUrl 的正常持久化不得被破坏（新会话仍能读到自己的 lastUrl）。
// ===========================================================================
test('T-15-02 同 userId 新 authEpoch 不得消费旧会话遗留的 pendingUrl', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { createHookRuntime } = await import('react');
const { BrowserSessionProvider } = await import('./src/context/BrowserSessionContext.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa';
const kA = '@browser_last_url_v2_' + A;
// 预置 A 自己的 lastUrl（同账号持久化，必须仍可读）
await AS.setItem(kA, 'https://a-last.example.com');

const rt = createHookRuntime();
let ctx = null;
const Comp = () => {
  const el = BrowserSessionProvider({
    children: null,
    userId: globalThis.__UID__,
    authEpoch: globalThis.__EPOCH__,
  });
  ctx = el && el.props ? el.props.value : null;
  return null;
};

// 1) A 旧会话（epoch=0）：写入一个待交接 URL
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
rt.settle();
ctx.setPendingUrl('https://stale-session.example.com');
rt.settle();
const oldPending = ctx.pendingUrl;

// 2) 同账号新会话（epoch=1）：Provider 不卸载，仅 epoch 推进
globalThis.__EPOCH__ = 1;
rt.render(Comp);
await new Promise((r) => setTimeout(r, 10));
rt.flushEffects();
rt.settle();

// 3) 新会话渲染后，pendingUrl 必须已被清空（不得把旧会话交接给新会话）
const pendingAfterNewSession = ctx.pendingUrl;
const seqAfterNewSession = ctx.pendingSeq;
// 4) 同账号 lastUrl 正常持久化不得被破坏
const newSessionLastUrl = ctx.lastUrl;

process.stdout.write(JSON.stringify({
  oldPending, pendingAfterNewSession, seqAfterNewSession, newSessionLastUrl,
}));
`);
    // 前置：旧会话确实写入了 pendingUrl（证明复现路径成立）
    assert.equal(out.oldPending, 'https://stale-session.example.com', '前置条件：旧会话应能写入 pendingUrl');
    // 核心断言：新会话渲染后不得残留旧会话的 pendingUrl
    assert.equal(out.pendingAfterNewSession, null, '同账号新会话渲染后 pendingUrl 必须被清空（不得残留旧会话交接）');
    // 回归保护：同账号 lastUrl 持久化仍正常
    assert.equal(out.newSessionLastUrl, 'https://a-last.example.com', '同账号新会话仍须能读到自己的 lastUrl（不得破坏正常持久化）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// TASK-P0.3 / B1 / T6-B Round 4A — CR4-01 / CR4-02 缺陷复现与修复验证
//
// 背景（18_GPT_T6B_ROUND4_PREFLIGHT_ADJUDICATION.md）：
//   CR4-01：useHealthData 的外部业务回调（setWaterDirect / confirmCheck /
//           undoCheck / resetToday / handleAddWater / handleMinusWater）
//           在**执行时**调用 getIdentitySnapshot() 读取实时身份，
//           该快照恒等于当前身份 → isIdentityCurrent 恒为 true → 校验形同虚设。
//           旧会话闭包在账号切换后仍会写 shadow ref / setState / 排队云端同步。
//   CR4-02：loadAllData 与 AppState 监听器在 await 之后用「执行时」身份
//           做校验，且 loadAllData 在入口处先写 userInteractedRef，
//           旧 RPC 结果可污染新账号的搭子状态 / profile 缓存。
//
// 本组用例全部真实执行 useHealthData.js（HealthProvider）源码，
// 仅对 react-native / expo-haptics / pushService 做最小 stub。
// 缺陷复现用例在修复前必须 FAIL；修复后必须 PASS。
// ===========================================================================

// 构建「HealthProvider 可运行」沙箱：额外 stub react-native / expo-haptics，
// 并复制 useHealthData.js 及其直接依赖（useTimeSync / useStreak）。
function buildHealthSandbox() {
  const dir = buildSandbox([
    'src/hooks/useHealthData.js',
    'src/hooks/health/useTimeSync.js',
    'src/hooks/health/useStreak.js',
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

  // pushService stub：记录调用（供断言「旧会话不得发伴侣通知」）
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/pushService.js'), `
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!globalThis.__PUSH_LOG__) globalThis.__PUSH_LOG__ = [];
  globalThis.__PUSH_LOG__.push({ receiverId, title, body, data });
  return { ok: true };
}
`);

  // ⚠️ useAuth stub：HealthProvider 通过 useAuth() 取 { user, authEpoch }。
  //    沙箱的 react stub 里 useContext 是空桩（返回 {}），若沿用真实 useAuth.js，
  //    user 恒为 undefined → useHealthStorage 收到 userId=null → 不读任何磁盘 →
  //    isLoaded 永远 false，所有用例都会在「前置条件」处假失败。
  //    因此这里把 useAuth 替换为受 __UID__ / __EPOCH__ 驱动的可控 stub。
  //    注意：仅替换身份来源，被测的 useHealthData / useHealthStorage /
  //    useHealthCloud / useProfileCache 全部仍为真实源码。
  fs.writeFileSync(path.join(dir, 'src/hooks/useAuth.js'), `
// ⚠️ 引用稳定性：真实 useAuth 的 value 由 useMemo 缓存，同一身份下 user 引用不变。
//    若 stub 每次返回新对象，useHealthData 的 useEffect([user]) 会反复触发
//    loadAllData，导致 clearPartner 反复覆盖测试手工绑定的搭子（假失败）。
//    因此这里按 uid::epoch 缓存返回对象，模拟真实 useMemo 语义。
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

// 在 HealthProvider 沙箱中渲染 Provider 并暴露 context value。
// useAuth 被替换为可控 stub：__UID__ / __EPOCH__ 驱动 user + authEpoch。
const HEALTH_HARNESS = String.raw`
const { createHookRuntime } = await import('react');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const RN = await import('react-native');

const rt = createHookRuntime();
let ctx = null;
const Comp = () => {
  const el = HealthProvider({ children: null });
  ctx = el && el.props ? el.props.value : null;
  return null;
};
`;

// ===========================================================================
// T-16-01 — CR4-01：A 的旧 resetToday / setWaterDirect 在切到 B 后不得生效
//
// 缺陷：setWaterDirect / resetToday 在执行时调用 getIdentitySnapshot()，
//       该函数返回**当前实时**身份 → 校验恒通过 → 旧闭包照样写 B 的 state /
//       排队 B 的云端同步。
// 期望（修复后）：旧闭包整体 fail-closed —— 不改 B 的 state、不落盘 B 的 key、
//       不为任何 owner 新增 pending / 网络请求。
// ===========================================================================
test('T-16-01 A 的旧 resetToday/setWaterDirect 在切到 B 后必须整体 fail-closed', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const A = 'user-aaa', B = 'user-bbb';
const kB = buildHealthKeys(B);
await AS.setItem(kB.water, '900');
await AS.setItem(kB.maxWater, '2000');

// 记录所有 upsert（云端写入）请求
const upserts = [];
globalThis.__UPSERT_IMPL__ = () => { upserts.push(1); return Promise.resolve({ error: null }); };
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：捕获旧回调
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const oldReset = ctx.resetToday;
const oldSetWater = ctx.setWaterDirect;

// 2) 切到 B 并完成 B 的本地加载
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const bWaterBefore = ctx.waterAmount;
const upsertsBefore = upserts.length;

// 3) A 的旧回调此刻才执行
oldReset();
oldSetWater(0);
rt.settle();
await new Promise((r) => setTimeout(r, 700)); // 越过 500ms 饮水防抖
rt.settle();

const bWaterAfter = ctx.waterAmount;
const bDiskWater = await AS.getItem(kB.water);
const upsertsAfter = upserts.length;

// 4) 关键：旧回调不得污染 waterAmountRef 影子值。
//    若旧 setWaterDirect 在 storage 拦截前已写 waterAmountRef=0，
//    则 B 的下一次合法 +1 会得到 1 而不是 901。
ctx.handleAddWater();
rt.settle();
const bWaterAfterLegitInc = ctx.waterAmount;

process.stdout.write(JSON.stringify({
  bWaterBefore, bWaterAfter, bDiskWater, upsertsBefore, upsertsAfter, bWaterAfterLegitInc,
}));
`);
    assert.equal(out.bWaterBefore, 900, '前置条件：B 加载后 state.waterAmount 应为 900');
    assert.equal(out.bWaterAfter, 900, 'A 的旧 resetToday/setWaterDirect 不得修改 B 的 React state');
    assert.equal(out.bDiskWater, '900', 'A 的旧回调不得把 B 的 V2 water key 写成 0');
    assert.equal(
      out.upsertsAfter,
      out.upsertsBefore,
      'A 的旧回调在身份失效后不得为任何 owner 新增云端 upsert 请求'
    );
    assert.equal(
      out.bWaterAfterLegitInc,
      901,
      'A 的旧回调不得污染 waterAmountRef 影子值（B 的合法 +1 必须基于 900 而非 0）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-02 — CR4-01：A→B→A 后，A 旧会话（epoch=0）的回调仍必须被拒绝
//
// 缺陷：执行时快照在 A→B→A 后同样恒等于当前身份（userId 相同、epoch 已是 2），
//       旧 epoch=0 闭包会被误判为合法。
// 期望（修复后）：闭包绑定的 origin.epoch=0 ≠ 当前 epoch=2 → fail-closed。
// ===========================================================================
test('T-16-02 A→B→A 后 A 旧会话（epoch=0）的 setWaterDirect 必须被拒绝', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话 1（epoch=0）：捕获旧回调
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const oldSetWater = ctx.setWaterDirect;

// 2) A → B
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();

// 3) B → A（epoch=2，同 userId 但新会话）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 2;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const aWaterBefore = ctx.waterAmount;

// 4) A 旧会话（epoch=0）的回调此刻执行
oldSetWater(123);
rt.settle();
await new Promise((r) => setTimeout(r, 700));
rt.settle();
const aWaterAfter = ctx.waterAmount;

// 5) 关键：旧回调不得污染 waterAmountRef 影子值。
//    若旧 setWaterDirect 在 storage 拦截前已写 waterAmountRef=123，
//    则 A 新会话的下一次合法 +1 会得到 124 而非 aWaterBefore+1。
ctx.handleAddWater();
rt.settle();
const aWaterAfterLegitInc = ctx.waterAmount;

process.stdout.write(JSON.stringify({ aWaterBefore, aWaterAfter, aWaterAfterLegitInc }));
`);
    assert.equal(out.aWaterAfter, out.aWaterBefore, 'A→B→A 后 A 旧会话（epoch=0）的 setWaterDirect 必须被拒绝');
    assert.equal(
      out.aWaterAfterLegitInc,
      out.aWaterBefore + 1,
      'A 旧会话回调不得污染 waterAmountRef 影子值（A 新会话合法 +1 必须基于原值）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-03 — CR4-01：同账号新 authEpoch（A epoch0 → A epoch1）旧回调必须被拒绝
//
// 缺陷：执行时快照无法区分「同账号新会话」，旧 epoch 闭包被误判合法。
// 期望（修复后）：origin.epoch=0 ≠ 当前 epoch=1 → fail-closed。
// ===========================================================================
test('T-16-03 同账号新 authEpoch 后旧会话 setWaterDirect 必须被拒绝', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话 1（epoch=0）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const oldSetWater = ctx.setWaterDirect;

// 2) 同账号新会话（epoch=1）
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const waterBefore = ctx.waterAmount;

// 3) 旧会话回调执行
oldSetWater(777);
rt.settle();
await new Promise((r) => setTimeout(r, 700));
rt.settle();
const waterAfter = ctx.waterAmount;

// 4) 关键：旧回调不得污染 waterAmountRef 影子值。
//    若旧 setWaterDirect 在 storage 拦截前已写 waterAmountRef=777，
//    则新会话的下一次合法 +1 会得到 778 而非 waterBefore+1。
ctx.handleAddWater();
rt.settle();
const waterAfterLegitInc = ctx.waterAmount;

process.stdout.write(JSON.stringify({ waterBefore, waterAfter, waterAfterLegitInc }));
`);
    assert.equal(out.waterAfter, out.waterBefore, '同账号新 authEpoch 后旧会话 setWaterDirect 必须被拒绝');
    assert.equal(
      out.waterAfterLegitInc,
      out.waterBefore + 1,
      '旧 epoch 回调不得污染 waterAmountRef 影子值（新会话合法 +1 必须基于原值）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-04 — CR4-01：500ms 饮水防抖触发时身份已失效 → 不得发出云端同步
//
// 缺陷：scheduleWaterSync 的 snapshot 来自 setWaterDirect 执行时的
//       getIdentitySnapshot()（恒等于当前身份），因此防抖触发时
//       isIdentityCurrent(snapshot) 仍为 true → 旧值被同步到云端。
// 期望（修复后）：排队时绑定 origin，触发时校验失败 → 不调用 syncToCloud。
// ===========================================================================
test('T-16-04 饮水 500ms 防抖触发时身份已失效，不得发出云端同步', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
const upserts = [];
globalThis.__UPSERT_IMPL__ = () => { upserts.push(1); return Promise.resolve({ error: null }); };
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();

// 2) A 合法加一次水（排队 500ms 防抖）
ctx.handleAddWater();
rt.settle();
const upsertsAfterQueue = upserts.length;

// 3) 防抖尚未触发时切到 B
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 4) 等待越过 500ms 防抖 + 1.5s 云端防抖
await new Promise((r) => setTimeout(r, 2200));
rt.settle();
const upsertsAfterSwitch = upserts.length;

process.stdout.write(JSON.stringify({ upsertsAfterQueue, upsertsAfterSwitch }));
`);
    assert.equal(out.upsertsAfterQueue, 0, '前置条件：排队阶段尚未发出 upsert');
    assert.equal(
      out.upsertsAfterSwitch,
      0,
      '身份切换后，旧会话排队的饮水同步不得在防抖触发时写入云端'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-05 — CR4-01：confirmCheck 在 RPC 返回前账号已切换 → 不得绑定搭子 /
//           发通知 / 写系统消息
//
// 缺陷：confirmCheck 只在入口取一次执行时快照，await supabase.rpc 之后
//       直接 bindPartner + sendPushNotification + messages.insert，
//       没有任何再校验 → 旧账号的打卡通知会发给新账号的搭子。
// 期望（修复后）：RPC 返回后再校验 origin，失效则整体放弃后续副作用。
// ===========================================================================
test('T-16-05 confirmCheck 在 RPC 返回前切换账号，不得绑定搭子/发通知/写消息', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
// 每次 RPC 都挂起，并记录 resolver；用队列避免 loadAllData 的 RPC 抢占单一 resolver
const rpcResolvers = [];
globalThis.__RPC_IMPL__ = () => new Promise((res) => { rpcResolvers.push(res); });
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PUSH_LOG__ = [];

// 1) A 会话：先让 loadAllData 的 RPC 返回「无搭子」，使 partnerId 为空
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
for (const r of rpcResolvers.splice(0)) r({ data: null, error: null });
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 2) 打开一餐并触发确认打卡（此时 partnerId 为空 → confirmCheck 内部再查一次 RPC，挂起）
ctx.openMeal('早餐');
rt.settle();
const p = ctx.confirmCheck();
for (let i = 0; i < 50 && rpcResolvers.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
// 切号前 confirmCheck 自己发出的 RPC（此时队列里只有它）
const rpcIssued = rpcResolvers.length;
const oldResolvers = rpcResolvers.splice(0);

// 3) RPC 返回前切到 B
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();

// 4) 旧 RPC 此刻返回「A 的搭子」（只 resolve 切号前那一个）
for (const r of oldResolvers) r({ data: 'partner-of-a', error: null });
await p;
rt.settle();
await new Promise((r) => setTimeout(r, 50));
rt.settle();

const pushCount = (globalThis.__PUSH_LOG__ || []).length;
const msgCount = (globalThis.__MSG_LOG__ || []).length;
const partnerIdAfter = ctx.partnerId;

process.stdout.write(JSON.stringify({ rpcIssued, pushCount, msgCount, partnerIdAfter }));
`);
    assert.ok(out.rpcIssued >= 1, '前置条件：confirmCheck 应发起 get_active_partner_id RPC');
    assert.equal(out.pushCount, 0, '账号切换后，旧 confirmCheck 不得发送伴侣推送通知');
    assert.equal(out.msgCount, 0, '账号切换后，旧 confirmCheck 不得写入系统消息');
    assert.notEqual(out.partnerIdAfter, 'partner-of-a', '旧 confirmCheck 不得把 A 的搭子绑定到新会话');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-06 — CR4-01：undoCheck 旧回调在切号后不得修改新账号三餐 / 排队同步
// ===========================================================================
test('T-16-06 A 的旧 undoCheck 在切到 B 后必须整体 fail-closed', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const A = 'user-aaa', B = 'user-bbb';
const kB = buildHealthKeys(B);
const B_MEALS = { '早餐': true, '午餐': true, '晚餐': true };
await AS.setItem(kB.meals, JSON.stringify(B_MEALS));
const upserts = [];
globalThis.__UPSERT_IMPL__ = () => { upserts.push(1); return Promise.resolve({ error: null }); };
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：打开一餐并捕获旧 undoCheck
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
ctx.openMeal('早餐');
rt.settle();
const oldUndo = ctx.undoCheck;

// 2) 切到 B 并完成加载
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const bMealsBefore = ctx.mealsStatus;
const upsertsBefore = upserts.length;

// 3) 旧 undoCheck 执行
oldUndo();
rt.settle();
await new Promise((r) => setTimeout(r, 2200));
rt.settle();
const bMealsAfter = ctx.mealsStatus;
const bDiskMeals = await AS.getItem(kB.meals);
const upsertsAfter = upserts.length;

// 4) 关键：旧 undoCheck 不得污染 B 的 userInteractedRef。
//    若被污染为 true，B 的合法操作后云端回包将无法覆盖（保护锁误开）。
//    这里让 B 做一次合法 undo（早餐 true→false），再模拟云端回包「全打卡」，
//    若 userInteractedRef 被旧回调污染，回包会被错误地接受/拒绝，导致状态异常。
ctx.openMeal('早餐');
rt.settle();
ctx.undoCheck();
rt.settle();
const bMealsAfterLegitUndo = ctx.mealsStatus;

process.stdout.write(JSON.stringify({
  bMealsBefore, bMealsAfter, bDiskMeals, upsertsBefore, upsertsAfter, bMealsAfterLegitUndo,
}));
`);
    assert.deepEqual(out.bMealsBefore, { '早餐': true, '午餐': true, '晚餐': true }, '前置条件：B 加载后三餐应为全打卡');
    assert.deepEqual(out.bMealsAfter, { '早餐': true, '午餐': true, '晚餐': true }, 'A 的旧 undoCheck 不得修改 B 的 mealsStatus');
    assert.equal(out.bDiskMeals, JSON.stringify({ '早餐': true, '午餐': true, '晚餐': true }), 'A 的旧 undoCheck 不得改写 B 的 V2 meals key');
    assert.equal(out.upsertsAfter, out.upsertsBefore, 'A 的旧 undoCheck 不得为任何 owner 新增云端 upsert');
    assert.deepEqual(
      out.bMealsAfterLegitUndo,
      { '早餐': false, '午餐': true, '晚餐': true },
      'B 的合法 undoCheck 必须仍然生效（旧回调不得破坏新会话正常功能）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-07 — CR4-02：旧 loadAllData 的 RPC 结果晚于新账号返回 → 不得污染
//           新账号的搭子状态
//
// 缺陷：loadAllData 在 await supabase.rpc 之后直接 bindPartner / clearPartner /
//       setProfile(writeProfileCache)，没有 origin 校验 → 旧账号的搭子关系
//       会被写进新账号。
// 期望（修复后）：RPC 返回后校验 origin，失效则丢弃整个结果。
// ===========================================================================
test('T-16-07 旧 loadAllData 的 RPC 迟到返回不得污染新账号的搭子状态', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
// 每个 RPC 调用记录其发起时的 owner，便于只 resolve A 的 resolver。
const rpcResolvers = [];
globalThis.__RPC_IMPL__ = () => new Promise((res) => {
  rpcResolvers.push({ res, owner: globalThis.__UID__ });
});
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：挂载触发 loadAllData（RPC 挂起）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
// 冻结 A 会话的 resolver（保持挂起，稍后迟到返回）
const aResolvers = rpcResolvers.splice(0).filter((x) => x.owner === A);
const aRpcCount = aResolvers.length;

// 2) 切到 B（B 的 loadAllData 也会发起 RPC）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const bResolvers = rpcResolvers.splice(0).filter((x) => x.owner === B);

// 3) 先让 B 的 RPC 返回「无搭子」，B 完成加载
for (const x of bResolvers) x.res({ data: null, error: null });
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const partnerAfterB = ctx.partnerId;

// 4) A 的旧 RPC 此刻迟到返回「A 的搭子」。
//    只 resolve A 冻结的 resolver；B 后续新产生的 RPC 一律按「无搭子」处理，
//    避免把 A 的搭子值误喂给 B 的合法请求（那会变成「B 自己绑了 partner-of-a」，
//    属于测试设计错误，而非被测缺陷）。
for (const x of aResolvers) x.res({ data: 'partner-of-a', error: null });
for (let round = 0; round < 5; round++) {
  await new Promise((r) => setTimeout(r, 30));
  rt.settle();
  const pending = rpcResolvers.splice(0);
  if (pending.length === 0) break;
  for (const x of pending) {
    x.res({ data: x.owner === A ? 'partner-of-a' : null, error: null });
  }
}
await new Promise((r) => setTimeout(r, 60));
rt.settle();
const partnerAfterStale = ctx.partnerId;

process.stdout.write(JSON.stringify({ aRpcCount, partnerAfterB, partnerAfterStale }));
`);
    assert.ok(out.aRpcCount >= 1, '前置条件：A 的 loadAllData 应发起 RPC');
    assert.equal(out.partnerAfterB, null, '前置条件：B 的 RPC 返回无搭子后 partnerId 应为 null');
    assert.notEqual(out.partnerAfterStale, 'partner-of-a', 'A 的旧 loadAllData RPC 迟到返回不得把 A 的搭子写进 B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-08 — CR4-02：AppState 切回前台时的 RPC 迟到返回不得污染新账号
//
// 缺陷：AppState 监听器在 .then 内用执行时身份，且未在注册时绑定 origin；
//       旧事件发出的 RPC 返回后直接 bindPartner / clearPartner / setProfile。
// 期望（修复后）：注册时绑定 origin，返回后校验，失效则丢弃。
// ===========================================================================
test('T-16-08 AppState 旧 RPC 迟到返回不得污染新账号搭子状态', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
const rpcResolvers = [];
globalThis.__RPC_IMPL__ = () => new Promise((res) => { rpcResolvers.push(res); });
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话挂载（loadAllData 的 RPC 挂起，先不 resolve）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const baseRpc = rpcResolvers.length;

// 2) 触发 AppState active（lastActiveDate 与今天相同 → 走独立 RPC 分支）
RN.AppState.__emit('background');
RN.AppState.__emit('active');
await new Promise((r) => setTimeout(r, 20));
const rpcAfterActive = rpcResolvers.length;

// 3) 切到 B
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 4) 让所有挂起 RPC 返回 A 的搭子
for (const r of rpcResolvers) r({ data: 'partner-of-a', error: null });
await new Promise((r) => setTimeout(r, 80));
rt.settle();
const partnerAfter = ctx.partnerId;

process.stdout.write(JSON.stringify({ baseRpc, rpcAfterActive, partnerAfter }));
`);
    assert.ok(out.rpcAfterActive > out.baseRpc, '前置条件：AppState active 应发起独立 RPC');
    assert.notEqual(out.partnerAfter, 'partner-of-a', 'AppState 旧 RPC 迟到返回不得把 A 的搭子写进 B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-09 — CR4-02：loadAllData 入口不得在身份校验前写 userInteractedRef
//
// 缺陷：loadAllData 第一行就 userInteractedRef.current = false，
//       旧会话的 loadAllData 在切号后执行会把新会话的「用户已交互」保护锁解开，
//       导致新会话的云端回包覆盖用户刚做的操作。
// 期望（修复后）：入口先校验 origin，失效则直接返回，不触碰任何 ref。
// ===========================================================================
test('T-16-09 旧 loadAllData 不得解开新会话的 userInteracted 保护锁', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
// 分轮 RPC 队列：A 的 loadAllData 先卡在 calibrate()/get_active_partner_id，
// 使其已越过 userInteractedRef.current = false 这一行（进入异步等待），
// 再切到 B 并让 B 交互，最后放行 A 的迟到回包。
const rpcResolvers = [];
globalThis.__RPC_IMPL__ = () => new Promise((res) => { rpcResolvers.push(res); });
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
// 云端返回「非空」记录：否则 myData 为 null，hydrateFromCloud 不执行，断言空转。
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({
  data: { water_amount: 5000, meals_status: { '早餐': true, '午餐': true, '晚餐': true } },
  error: null,
});

// 1) A 会话挂载：让 A 的 loadAllData 进入异步等待（RPC 挂起）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
// A 的 loadAllData 已执行到 userInteractedRef.current=false 并卡在 RPC
const aResolvers = rpcResolvers.splice(0);

// 2) 切到 B，B 产生用户交互（handleAddWater 置 userInteractedRef=true）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
ctx.handleAddWater();
rt.settle();
const bWaterAfterInteraction = ctx.waterAmount;
// B 自己的 loadAllData 也会发起 RPC，先全部放行（返回无搭子）
for (const r of rpcResolvers.splice(0)) r({ data: null, error: null });
await new Promise((r) => setTimeout(r, 60));
rt.settle();
const bWaterBeforeStale = ctx.waterAmount;

// 3) 放行 A 的迟到 RPC（返回无搭子），A 的 loadAllData 继续走到 fetchMyRecord
for (const r of aResolvers) r({ data: null, error: null });
await new Promise((r) => setTimeout(r, 120));
rt.settle();
const bWaterAfterCloud = ctx.waterAmount;

process.stdout.write(JSON.stringify({
  aResolverCount: aResolvers.length,
  bWaterAfterInteraction, bWaterBeforeStale, bWaterAfterCloud,
}));
`);
    assert.equal(out.bWaterAfterInteraction, 1, '前置条件：B 交互后 waterAmount 应为 1');
    assert.equal(out.bWaterBeforeStale, 1, '前置条件：B 自身 loadAllData 完成后仍应为 1');
    // 说明（Round 4A 实测）：本用例在修复前亦 PASS。
    // 原因：A 的迟到 loadAllData 即使解开了 userInteractedRef，
    // 仍会被 loadAllData 内部的 `getSessionEpoch() === loadEpoch` 后置校验拦截
    // （A 的 loadEpoch=0，当前为 B 的 epoch=1），因此数据层观测不到污染。
    // 该用例作为「回归保护」保留：修复后必须继续 PASS，确保 CR4-02 修复
    // 不会削弱既有的 epoch 后置防线，也不会引入新的覆盖路径。
    assert.equal(
      out.bWaterAfterCloud,
      1,
      '用户交互后，A 的迟到云端回包（water=5000）不得覆盖 B 的本地状态'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-10 — CR4-01：refreshPartner 同源缺陷（bind_partner / ChatRoomInner 迟到调用）
//
// 可达路径（预检已核证）：
//   · src/app/bind_partner.js:260 —— await supabase.rpc('unbind_partner') 之后
//     才调用 refreshPartner(null)；
//   · src/components/ChatRoomInner.js:359 —— 多次 await 之后才调用
//     refreshPartner(targetId)。
// 缺陷：refreshPartner 无 origin 校验，旧会话闭包在新账号下执行会
//       clearPartner / bindPartner / setProfile(writeProfileCache) / applyPartnerRecord。
// 期望（修复后）：refreshPartner 绑定创建时 origin，执行时校验，失效则整体放弃。
// ===========================================================================
test('T-16-10 A 的旧 refreshPartner 在切到 B 后不得清空/改写 B 的搭子状态', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：捕获旧 refreshPartner（模拟 bind_partner 解绑流程中捕获的闭包）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 20));
rt.settle();
const oldRefresh = ctx.refreshPartner;

// 2) 切到 B 并完成加载（等待 B 的 loadAllData 全部异步边界结束，
//    避免其 clearPartner 覆盖后续手工绑定的搭子）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 120));
rt.settle();
await new Promise((r) => setTimeout(r, 120));
rt.settle();

// 2b) 让 B 拥有一个合法搭子（模拟 B 已绑定 partner-of-b），
//     这样「旧 refreshPartner 清空」才是可观测的破坏，而非空转断言。
const bRefresh = ctx.refreshPartner;
await bRefresh('partner-of-b');
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const partnerBefore = ctx.partnerId;

// 3) A 的旧 refreshPartner(null) 迟到执行（解绑语义）
await oldRefresh(null);
rt.settle();
await new Promise((r) => setTimeout(r, 50));
rt.settle();
const partnerAfter = ctx.partnerId;

process.stdout.write(JSON.stringify({ partnerBefore, partnerAfter }));
`);
    assert.equal(
      out.partnerBefore,
      'partner-of-b',
      `前置条件：B 应已绑定 partner-of-b（实际 before=${out.partnerBefore}）`
    );
    assert.equal(
      out.partnerAfter,
      'partner-of-b',
      'A 的旧 refreshPartner(null) 不得清空 B 的合法搭子状态'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-11 — 兼容性保护：新会话的合法操作必须仍然正常工作
//            （修复前后都应 PASS，不得因修复而误伤正常路径）
// ===========================================================================
test('T-16-11 新会话的合法 setWaterDirect / resetToday 必须仍然生效', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const B = 'user-bbb';
const kB = buildHealthKeys(B);
await AS.setItem(kB.water, '900');
await AS.setItem(kB.maxWater, '2000');
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 合法操作：加两次水（验证最终态与落盘，不机械要求中间值）
ctx.handleAddWater();
rt.settle();
ctx.handleAddWater();
rt.settle();
await new Promise((r) => setTimeout(r, 700));
rt.settle();
const waterAfterAdd = ctx.waterAmount;
const diskAfterAdd = await AS.getItem(kB.water);

// 合法重置
ctx.resetToday();
rt.settle();
await new Promise((r) => setTimeout(r, 50));
rt.settle();
const waterAfterReset = ctx.waterAmount;
const diskAfterReset = await AS.getItem(kB.water);

process.stdout.write(JSON.stringify({ waterAfterAdd, diskAfterAdd, waterAfterReset, diskAfterReset }));
`);
    assert.equal(out.waterAfterAdd, 902, '新会话合法加两次水后 state 应为 902');
    assert.equal(out.diskAfterAdd, '902', '新会话合法加两次水后应落盘 902（无丢失更新）');
    assert.equal(out.waterAfterReset, 0, '新会话合法 resetToday 后 state 应为 0');
    assert.equal(out.diskAfterReset, '0', '新会话合法 resetToday 后应落盘 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-16-12 — 兼容性保护：切换前 A 的合法饮水变更不得因修复而丢失
//            （A 本地落盘必须保留；切回 A 后仍能读到自己的数据）
// ===========================================================================
test('T-16-12 切换前 A 的合法饮水变更不得因修复而丢失', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const A = 'user-aaa', B = 'user-bbb';
const kA = buildHealthKeys(A);
await AS.setItem(kA.water, '500');
await AS.setItem(kA.maxWater, '2000');

// 云端写入失败 → 载荷必须保留在 pending（不得被静默丢弃）
const upserts = [];
globalThis.__UPSERT_IMPL__ = () => { upserts.push(1); return Promise.resolve({ error: { message: 'offline' } }); };
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：合法加一次水（本地落盘 + 排队云端）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
ctx.handleAddWater();
rt.settle();
await new Promise((r) => setTimeout(r, 700));
rt.settle();
const aDiskWater = await AS.getItem(kA.water);

// 2) 切到 B 再切回 A（新会话）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 2;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 40));
rt.settle();
const aWaterAfterReturn = ctx.waterAmount;

process.stdout.write(JSON.stringify({ aDiskWater, aWaterAfterReturn }));
`);
    assert.equal(out.aDiskWater, '501', 'A 切换前的合法饮水变更必须落盘保留（不得丢失）');
    assert.equal(out.aWaterAfterReturn, 501, '切回 A 后必须能读回自己的 501（不得被清空）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-17-01 — R4A-01：A 打开饮食详情 → 切 B → B 不得继承 A 的 selectedMeal
//
// 缺陷：selectedMeal 是 Provider 内的裸 useState，不随 userId/authEpoch 变化重置。
//       A 打开「早餐」后切到 B，B 的 context.selectedMeal 仍是「早餐」，
//       MealDetailSheet 会以 B 的身份继续展示 A 的弹窗。
// 期望（修复后）：身份切换后 selectedMeal 必须被清空（null）。
// ===========================================================================
test('T-17-01 A 打开饮食详情后切到 B，B 不得继承 A 的 selectedMeal', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：打开「早餐」详情
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
ctx.openMeal('早餐');
rt.settle();
const aSelected = ctx.selectedMeal;

// 2) 切到 B
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 40));
rt.settle();
const bSelected = ctx.selectedMeal;

process.stdout.write(JSON.stringify({ aSelected, bSelected }));
`);
    assert.equal(out.aSelected, '早餐', '前置条件：A 打开详情后 selectedMeal 应为「早餐」');
    assert.equal(out.bSelected, null, '切到 B 后 B 不得继承 A 的 selectedMeal（必须为 null）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-17-02 — R4A-01：A 的旧 openMeal / closeMeal 在 B 会话执行必须无效
//
// 缺陷：openMeal / closeMeal 无身份守卫，旧闭包在切号后仍能改 B 的 selectedMeal。
// 期望（修复后）：旧 openMeal 不得让 B 打开弹窗；旧 closeMeal 不得影响 B 的合法选中。
// ===========================================================================
test('T-17-02 A 的旧 openMeal/closeMeal 在 B 会话执行必须无效', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话：捕获旧回调
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const oldOpen = ctx.openMeal;
const oldClose = ctx.closeMeal;

// 2) 切到 B
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 40));
rt.settle();

// 3) A 的旧 openMeal 此刻执行 → 不得让 B 打开
oldOpen('午餐');
rt.settle();
const bAfterOldOpen = ctx.selectedMeal;

// 4) B 合法打开「晚餐」
ctx.openMeal('晚餐');
rt.settle();
const bLegitOpen = ctx.selectedMeal;

// 5) A 的旧 closeMeal 此刻执行 → 不得关闭 B 的合法弹窗
oldClose();
rt.settle();
const bAfterOldClose = ctx.selectedMeal;

process.stdout.write(JSON.stringify({ bAfterOldOpen, bLegitOpen, bAfterOldClose }));
`);
    assert.equal(out.bAfterOldOpen, null, 'A 的旧 openMeal 不得让 B 打开弹窗');
    assert.equal(out.bLegitOpen, '晚餐', '前置条件：B 合法 openMeal 后应选中「晚餐」');
    assert.equal(out.bAfterOldClose, '晚餐', 'A 的旧 closeMeal 不得关闭 B 的合法弹窗');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-17-03 — R4A-01：同账号新 authEpoch 后旧 openMeal 必须失效
//
// 缺陷：selectedMeal 不随 authEpoch 重置；旧 epoch 的 openMeal 仍可写入。
// 期望（修复后）：同账号重新登录（epoch 变化）后 selectedMeal 清空，旧 openMeal 无效。
// ===========================================================================
test('T-17-03 同账号新 authEpoch 后旧 openMeal 必须失效', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 1) A 会话 epoch=0：打开详情并捕获旧 openMeal
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
ctx.openMeal('早餐');
rt.settle();
const aSelectedEpoch0 = ctx.selectedMeal;
const oldOpen = ctx.openMeal;

// 2) 同账号新会话 epoch=1
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 40));
rt.settle();
const aSelectedEpoch1 = ctx.selectedMeal;

// 3) 旧 epoch=0 的 openMeal 此刻执行 → 必须无效
oldOpen('晚餐');
rt.settle();
const aAfterOldOpen = ctx.selectedMeal;

process.stdout.write(JSON.stringify({ aSelectedEpoch0, aSelectedEpoch1, aAfterOldOpen }));
`);
    assert.equal(out.aSelectedEpoch0, '早餐', '前置条件：epoch=0 打开详情后应选中「早餐」');
    assert.equal(out.aSelectedEpoch1, null, '同账号新 authEpoch 后 selectedMeal 必须清空');
    assert.equal(out.aAfterOldOpen, null, '旧 epoch 的 openMeal 不得写入新会话');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-17-04 — R4A-01 正向兼容：B 合法打开/关闭/确认/撤销仍正常
//            （回归保护，修复前后均应 PASS）
// ===========================================================================
test('T-17-04 B 合法打开/关闭/确认/撤销饮食详情仍正常', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 打开
ctx.openMeal('午餐');
rt.settle();
const opened = ctx.selectedMeal;

// 确认打卡
await ctx.confirmCheck();
rt.settle();
const checkedAfterConfirm = ctx.mealsStatus['午餐'];
const selectedAfterConfirm = ctx.selectedMeal;

// 再次打开并撤销
ctx.openMeal('午餐');
rt.settle();
ctx.undoCheck();
rt.settle();
const checkedAfterUndo = ctx.mealsStatus['午餐'];

// 关闭
ctx.openMeal('晚餐');
rt.settle();
ctx.closeMeal();
rt.settle();
const selectedAfterClose = ctx.selectedMeal;

process.stdout.write(JSON.stringify({
  opened, checkedAfterConfirm, selectedAfterConfirm, checkedAfterUndo, selectedAfterClose,
}));
`);
    assert.equal(out.opened, '午餐', 'B 合法 openMeal 应选中「午餐」');
    assert.equal(out.checkedAfterConfirm, true, 'B 合法 confirmCheck 应把「午餐」置为已打卡');
    assert.equal(out.selectedAfterConfirm, null, 'confirmCheck 后应关闭详情（selectedMeal=null）');
    assert.equal(out.checkedAfterUndo, false, 'B 合法 undoCheck 应把「午餐」置为未打卡');
    assert.equal(out.selectedAfterClose, null, 'B 合法 closeMeal 后 selectedMeal 应为 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-17-05 — R4A-02：旧 handleAddWater / handleMinusWater 不得污染新会话 userInteractedRef
//
// 缺陷：handleAddWater / handleMinusWater 在 setWaterDirect 之前就写
//       userInteractedRef.current = true，且无身份守卫。旧闭包在切号后执行时，
//       即使 setWaterDirect 内部 fail-closed，userInteractedRef 已被污染为 true。
//       后果：B 的 loadAllData 在 fetchMyRecord 往返期间若被旧回调污染，
//       云端 hydrate 会被 !userInteractedRef.current 条件永久拦截 → B 的合法云端数据无法回填。
//
// 观测设计（沙箱事实：fetchMyRecord 经 .single() → __PROFILE_QUERY__）：
//   1) B 本地 water=100，云端记录 water=777；
//   2) 用可控 Promise 卡住 __PROFILE_QUERY__（即 fetchMyRecord 在途）；
//   3) 在途期间执行 A 的旧包装回调（修复前会污染 userInteractedRef=true）；
//   4) 放行云端记录返回；
//   5) 修复后旧回调 fail-closed → ref 仍为 false → B 的云端 777 正常 hydrate；
//      修复前 ref 被污染 → hydrate 被拦截 → B 仍为 100。
// ===========================================================================
test('T-17-05 旧 handleAddWater/handleMinusWater 不得污染新会话 userInteractedRef', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const A = 'user-aaa', B = 'user-bbb';
const kB = buildHealthKeys(B);
// B 本地初始为 100，云端为 777（用于观测 hydrate 是否发生）
await AS.setItem(kB.water, '100');
await AS.setItem(kB.maxWater, '2000');

globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });

// fetchMyRecord 经 supabase.from('health_records').select()...single()，
// 沙箱中 single() 恒走 __PROFILE_QUERY__。用可控 Promise 卡住 B 的云端记录返回。
let releaseMyRecord;
const myRecordGate = new Promise((res) => { releaseMyRecord = res; });
globalThis.__PROFILE_QUERY__ = () => myRecordGate.then(() => ({
  data: { water_amount: 777, meals_status: { '早餐': false, '午餐': false, '晚餐': false } },
  error: null,
}));

// 1) A 会话：捕获旧包装回调
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
const oldAdd = ctx.handleAddWater;
const oldMinus = ctx.handleMinusWater;

// 2) 切到 B：loadAllData 启动，卡在 fetchMyRecord
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 40));
rt.settle();

// 3) B 的 loadAllData 仍在途（fetchMyRecord 未返回），此刻执行 A 的旧包装回调
oldAdd();
oldMinus();
rt.settle();

// 4) 放行 B 的云端记录返回
releaseMyRecord();
await new Promise((r) => setTimeout(r, 60));
rt.settle();

const bWater = ctx.waterAmount;

process.stdout.write(JSON.stringify({ bWater }));
`);
    assert.equal(
      out.bWater,
      777,
      '旧包装回调不得污染 userInteractedRef：B 的云端记录（777）必须能正常 hydrate'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-17-06 — R4A-02 正向兼容：新会话合法加减水与 500ms 防抖仍正常
//            （回归保护，修复前后均应 PASS）
// ===========================================================================
test('T-17-06 新会话合法 handleAddWater/handleMinusWater 与防抖仍正常', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const B = 'user-bbb';
const kB = buildHealthKeys(B);
await AS.setItem(kB.water, '900');
await AS.setItem(kB.maxWater, '2000');

const upserts = [];
globalThis.__UPSERT_IMPL__ = () => { upserts.push(1); return Promise.resolve({ error: null }); };
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 合法 +1 / -1
ctx.handleAddWater();
rt.settle();
ctx.handleAddWater();
rt.settle();
ctx.handleMinusWater();
rt.settle();
const waterAfterOps = ctx.waterAmount;

// 越过两层防抖（scheduleWaterSync 500ms + useHealthCloud DEBOUNCE_MS 1500ms），
// 确认云端 upsert 已真正发出。
await new Promise((r) => setTimeout(r, 2400));
rt.settle();
const diskWater = await AS.getItem(kB.water);
const upsertCount = upserts.length;

process.stdout.write(JSON.stringify({ waterAfterOps, diskWater, upsertCount }));
`);
    assert.equal(out.waterAfterOps, 901, '合法 +1 +1 -1 后水值应为 901');
    assert.equal(out.diskWater, '901', '合法操作后应落盘 901');
    assert.ok(out.upsertCount >= 1, '500ms 防抖后应至少发出一次云端同步');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 组件级沙箱：真实渲染 MealDetailSheet（含 JSX 转译 + 可控 Animated）
//
// 目的：T-17 系列只验证了 Provider 侧 selectedMeal 的派生结果，无法覆盖
//       MealDetailSheet 内部的 isVisible / 动画完成回调竞态。本沙箱用 Babel
//       把真实组件源码的 JSX 转译为 React.createElement，配合可控 Animated
//       stub（动画完成回调由测试手动触发），从而验证：
//         - meal→null 时 Modal 是否在**当前渲染**即不可见；
//         - 旧关闭动画的完成回调是否会误关新弹窗。
//
// 真实性声明：
//   - ✅ 真实执行：MealDetailSheet.js 源码原样复制，仅做 JSX→createElement 转译；
//   - ✅ 真实执行：useState/useEffect/useRef/useCallback 走同一 Hook 运行时；
//   - ⚠️ 模拟：Animated 是可控 stub，start(cb) 不自动完成，由测试调用 __finish()；
//   - ⚠️ 模拟：Modal/View/Text 等是普通对象桩，仅记录 props（visible 等）。
// ===========================================================================
function buildMealSheetSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't6b-sheet-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // react stub：复用同一 Hook 运行时 + createElement
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
${HOOK_RUNTIME_SRC}
let __singleton = null;
export function createHookRuntime() {
  if (!__singleton) __singleton = __createHookRuntime();
  return __singleton;
}
const __runtime = createHookRuntime();
export const useState = __runtime.useState;
export const useEffect = __runtime.useEffect;
export const useCallback = __runtime.useCallback;
export const useMemo = __runtime.useMemo;
export const useRef = __runtime.useRef;
export const useContext = __runtime.useContext;
export const createContext = __runtime.createContext;
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  // react-native stub：可控 Animated + 记录型基础组件
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
// 可控 Animated：每次 start(cb) 把 cb 压入 __ANIM_QUEUE__，由测试手动 __finish 触发。
// 这样可精确复现「旧关闭动画尚未完成 → 新打开 → 旧回调迟到」的竞态。
export const __ANIM_QUEUE__ = [];
let __animSeq = 0;
class AnimatedValue {
  constructor(v) { this.__v = v; this.__id = ++__animSeq; }
  setValue(v) { this.__v = v; }
  interpolate() { return this; }
}
function makeAnimation(kind, cfg) {
  return {
    kind, cfg,
    start(cb) {
      __ANIM_QUEUE__.push({ kind, cfg, cb, cancelled: false });
    },
    stop() {},
    reset() {},
  };
}
export const Animated = {
  Value: AnimatedValue,
  spring: (val, cfg) => makeAnimation('spring', cfg),
  timing: (val, cfg) => makeAnimation('timing', cfg),
  parallel: (anims) => ({
    kind: 'parallel',
    anims,
    start(cb) { __ANIM_QUEUE__.push({ kind: 'parallel', anims, cb, cancelled: false }); },
    stop() {},
  }),
  sequence: (anims) => ({
    kind: 'sequence',
    anims,
    start(cb) { __ANIM_QUEUE__.push({ kind: 'sequence', anims, cb, cancelled: false }); },
    stop() {},
  }),
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

  // expo-haptics stub（no-op，但记录调用供断言触感未被误触发）
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

  // 常量：真实复制（动画参数必须与生产一致，禁止在测试里写魔法数字）
  for (const rel of ['src/constants/motion.js', 'src/constants/haptics.js']) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  }

  // ThemeContext stub：useAppTheme 直接返回固定调色板（不参与生命周期断言）
  fs.mkdirSync(path.join(dir, 'src/context'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/context/ThemeContext.js'), `
export function useAppTheme() {
  return { colors: { card: '#fff', textPrimary: '#000', textSecondary: '#888', background: '#f5f5f5', primary: '#FF2D55' } };
}
export function ThemeProvider({ children }) { return children; }
`);

  // useHealthData stub：只提供 mealGuides（组件仅用此字段）
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
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'/index.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

// ===========================================================================
// 真实 Provider → MealDetailSheet 集成沙箱（FINAL-03 / FINAL-04）
//
// 目的：旧 T-19 用例在组件沙箱里**手写** ownerKey，与真实 Provider 语义不符
//       （真实 Provider 的 selectedMealOwnerKey 关闭后为 null），因此无法证明
//       真实数据契约。本沙箱把 useHealthData.js（HealthProvider）与
//       MealDetailSheet.js 放进**同一个**沙箱，让 Sheet 的 props 完全由
//       Provider 的 context value 派生，等价于 src/app/health/index.js 的接线。
//
// 真实性声明：
//   - ✅ 真实执行：useHealthData.js / MealDetailSheet.js 源码原样复制；
//   - ✅ 真实执行：useHealthStorage / useHealthCloud / useProfileCache 等依赖真实源码；
//   - ✅ 真实执行：身份来源 useAuth 为 __UID__/__EPOCH__ 驱动的可控 stub（与 T-16 一致）；
//   - ⚠️ 模拟：Animated 为可控 stub，动画完成由测试手动触发；
//   - ⚠️ 模拟：Modal/View/Text 为记录型桩，仅断言 visible。
// ===========================================================================
function buildProviderSheetSandbox() {
  const dir = buildHealthSandbox();
  const nm = path.join(dir, 'node_modules');

  // react stub：复用 buildHealthSandbox 的 Hook 运行时，但补上 createElement
  // （MealDetailSheet 经 Babel 转译后需要 React.createElement）
  const reactDir = path.join(nm, 'react');
  const reactSrc = fs.readFileSync(path.join(reactDir, 'index.js'), 'utf8');
  if (!reactSrc.includes('export const createElement')) {
    fs.writeFileSync(path.join(reactDir, 'index.js'), reactSrc + `
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
`);
  }

  // react-native stub：在 buildHealthSandbox 的 AppState stub 基础上补齐
  // 可控 Animated + 记录型基础组件（MealDetailSheet 需要）
  const rnDir = path.join(nm, 'react-native');
  const rnSrc = fs.readFileSync(path.join(rnDir, 'index.js'), 'utf8');
  fs.writeFileSync(path.join(rnDir, 'index.js'), rnSrc + `
// 可控 Animated：start(cb) 只入队，由测试手动 finishAnim 触发
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
`);

  // ThemeContext stub（MealDetailSheet 依赖 useAppTheme）
  fs.mkdirSync(path.join(dir, 'src/context'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/context/ThemeContext.js'), `
export function useAppTheme() {
  return { colors: { card: '#fff', textPrimary: '#000', textSecondary: '#888', background: '#f5f5f5', primary: '#FF2D55' } };
}
export function ThemeProvider({ children }) { return children; }
`);

  // 真实常量（动画参数必须与生产一致）
  for (const rel of ['src/constants/motion.js', 'src/constants/haptics.js']) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  }

  // 真实 MealDetailSheet 源码 + Babel JSX 转译
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

  return dir;
}

// 组件级 harness：渲染 MealDetailSheet，暴露最新一次渲染的 Modal props 与内部状态。
//
// 🛡️ FINAL-03 / FINAL-04（TASK-P0.3 最终封版）：
//   旧版 T-19 用例**手写** ownerKey（如 'user-bbb::0'）并假设它在关闭期间不变，
//   这与真实 Provider 的语义不一致 —— 真实 Provider 的 selectedMealOwnerKey
//   在关闭后就是 null。手写常量会让测试「自证」动画正常，却掩盖真实缺陷。
//   因此本 harness 新增「真实 Provider 契约」模式：
//     · 真实执行 useHealthData.js（HealthProvider），从 ctx 读取
//       currentSessionOwnerKey / selectedMealSelectionId / selectedMeal；
//     · 把 ctx 的输出**原样**作为 MealDetailSheet 的 props（与 health/index.js 一致）；
//     · 测试只通过 ctx.openMeal / ctx.closeMeal / ctx.confirmCheck / ctx.undoCheck
//       驱动，绝不手写身份或 selectionId。
//   这样验证的是 Provider → MealDetailSheet 的真实数据契约，而非两个组件各自自洽。
const MEAL_SHEET_HARNESS = String.raw`
const { createHookRuntime } = await import('react');
const RN = await import('react-native');
const { default: MealDetailSheet } = await import('./src/components/MealDetailSheet.js');

const rt = createHookRuntime();

// 渲染一次组件，返回其 React 元素树（createElement 产物）。
// ⚠️ 关键 1：把 props 存到外部变量，使 settle()/rerender() 复用**最新** props，
//    否则 rerender 会沿用首次 render 时闭包捕获的旧 props（导致断言读到陈旧树）。
// ⚠️ 关键 2：rt.render() 返回的是「effect 执行之前」计算出的元素树，
//    而 setIsVisible(true) 发生在 effect 内。因此断言前必须用 getEl()
//    重新渲染一次，才能读到 effect 生效后的真实树。
let __latestProps = null;
const __Comp = () => MealDetailSheet(__latestProps);
function renderSheet(props) {
  __latestProps = props;
  return rt.render(__Comp);
}
// 更新 props 后**只**重新渲染组件函数，不运行 effect。
// 用于精确模拟「父组件因身份切换重渲染、effect 尚未执行」的那一帧。
function setPropsAndRenderOnly(props) {
  __latestProps = props;
  return rt.renderOnly();
}
// 读取「当前」元素树：先跑完所有挂起 effect，再重新渲染一次并返回新树。
function getEl() {
  rt.settle();
  return rt.rerender();
}
// 仅重新渲染，**不**跑 effect（用于验证「同一渲染帧」语义：
// 若 Modal 可见性依赖 useEffect 关闭，此处仍会读到 true）
function renderNow() {
  return rt.renderOnly();
}

// 在元素树中查找 Modal 节点，读取 visible
function findModalVisible(el) {
  if (!el || typeof el !== 'object') return undefined;
  if (el.type === 'Modal') return el.props.visible;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) {
    const v = findModalVisible(k);
    if (v !== undefined) return v;
  }
  return undefined;
}

// 触发队列中第 idx 个动画的完成回调（finished 默认 true）
function finishAnim(idx, finished = true) {
  const item = RN.__ANIM_QUEUE__[idx];
  if (!item) throw new Error('no anim at index ' + idx);
  if (typeof item.cb === 'function') item.cb({ finished });
}
`;

// ===========================================================================
// 真实 Provider → MealDetailSheet 集成 harness（FINAL-03 / FINAL-04 专用）
//
// 与 MEAL_SHEET_HARNESS 的区别：
//   · 同时真实执行 useHealthData.js（HealthProvider）与 MealDetailSheet.js；
//   · MealDetailSheet 的 props **完全由 Provider 的 context value 派生**，
//     与 src/app/health/index.js 的真实接线逐字段一致：
//        meal            = ctx.selectedMeal
//        sessionOwnerKey = ctx.currentSessionOwnerKey
//        selectionId     = ctx.selectedMealSelectionId
//        checked         = ctx.selectedMeal ? ctx.mealsStatus[ctx.selectedMeal] : false
//        onClose         = ctx.closeMeal
//        onConfirm       = ctx.confirmCheck
//        onUndo          = ctx.undoCheck
//   · 测试只能通过 ctx.openMeal / closeMeal / confirmCheck / undoCheck 驱动，
//     不得手写 ownerKey / selectionId —— 这正是旧 T-19 用例的缺陷所在。
//
// 实现要点：
//   · 沙箱的 react stub 只暴露**单例** createHookRuntime()，Provider 与 Sheet
//     必须共享同一运行时（同一 hooks 数组），否则 Sheet 的 useRef 会拿到 undefined。
//   · 因此用一个「组合组件」按固定顺序调用 Hook：
//       1) HealthProvider({children:null})  —— 内部 hooks 先占位
//       2) MealDetailSheet(props)           —— 内部 hooks 紧随其后
//     每次渲染顺序恒定 → hooks 槽位稳定，符合 React 规则。
//   · 每次「父组件重渲染」= rt.render(Combined) 一帧完成 Provider + Sheet。
//   · 需要「只重渲染 Sheet、不跑 effect」时用 rt.renderOnly()。
const PROVIDER_SHEET_HARNESS = String.raw`
const { createHookRuntime } = await import('react');
const RN = await import('react-native');
const { HealthProvider } = await import('./src/hooks/useHealthData.js');
const { default: MealDetailSheet } = await import('./src/components/MealDetailSheet.js');

const rt = createHookRuntime();

let ctx = null;

// 与 src/app/health/index.js 完全一致的 props 派生
function sheetPropsFromCtx() {
  return {
    meal: ctx.selectedMeal,
    sessionOwnerKey: ctx.currentSessionOwnerKey,
    selectionId: ctx.selectedMealSelectionId,
    checked: ctx.selectedMeal ? !!(ctx.mealsStatus && ctx.mealsStatus[ctx.selectedMeal]) : false,
    onClose: ctx.closeMeal,
    onConfirm: ctx.confirmCheck,
    onUndo: ctx.undoCheck,
  };
}

// 组合组件：先 Provider（占位 hooks），再 Sheet（紧随其后）
const Combined = () => {
  const el = HealthProvider({ children: null });
  ctx = el && el.props ? el.props.value : null;
  return MealDetailSheet(sheetPropsFromCtx());
};

// 完整一帧：Provider + Sheet 一起渲染（各自 effect 都会执行）
function frame() {
  return rt.render(Combined);
}

// 只重渲染（不跑 effect）—— 模拟「父组件已重渲染、子组件 effect 尚未执行」
function sheetRenderOnly() {
  return rt.renderOnly();
}

// 读取当前元素树：先跑完挂起 effect，再重渲染一次
function getEl() {
  rt.settle();
  return rt.rerender();
}

function renderNow() { return rt.renderOnly(); }

function findModalVisible(el) {
  if (!el || typeof el !== 'object') return undefined;
  if (el.type === 'Modal') return el.props.visible;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) {
    const v = findModalVisible(k);
    if (v !== undefined) return v;
  }
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

function findActionBtn(el) {
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'TouchableOpacity') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = findActionBtn(k); if (r) return r; }
  return null;
}

function finishAnim(idx, finished = true) {
  const item = RN.__ANIM_QUEUE__[idx];
  if (!item) throw new Error('no anim at index ' + idx);
  if (typeof item.cb === 'function') item.cb({ finished });
}

// 等待 Provider 的异步加载（loadAllData / 云端同步）落定
async function boot(uid, epoch) {
  globalThis.__UID__ = uid;
  globalThis.__EPOCH__ = epoch;
  frame();
  await new Promise((r) => setTimeout(r, 30));
  frame();
}
`;

// ===========================================================================
// T-18-01 — 修复 1：meal 因身份切换变为 null 时，Modal 必须在**当前渲染**即不可见
//
// 缺陷（修复前）：isVisible 仅由 useEffect 关闭，存在一帧
//   「meal=null 但 isVisible=true」→ Modal 仍展示旧账号内容。
// 期望（修复后）：modalVisible = isVisible && !!meal，meal=null 当帧即 false。
// ===========================================================================
test('T-18-01 meal 变为 null 时 Modal 当帧不可见（不依赖 useEffect）', () => {
  const dir = buildMealSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${MEAL_SHEET_HARNESS}
const onClose = () => {};
// 1) 打开：meal='早餐' —— 先跑完 effect 再读树
renderSheet({ meal: '早餐', checked: false, onClose, onConfirm: () => {}, onUndo: () => {} });
const visibleWhenOpen = findModalVisible(getEl());

// 2) 身份切换：meal 直接变 null（模拟 Provider 派生 selectedMeal=null）
// ⚠️ 关键：使用 setPropsAndRenderOnly —— 只重渲染组件函数，**不**运行 effect。
//    这正是 React 中「父组件重渲染、子组件 effect 尚未执行」的真实一帧。
//    若 Modal 可见性依赖 useEffect 关闭，此处仍会读到 true（缺陷）；
//    修复后 modalVisible = isVisible && !!meal 当帧即为 false。
const visibleSameFrame = findModalVisible(
  setPropsAndRenderOnly({ meal: null, checked: false, onClose, onConfirm: () => {}, onUndo: () => {} })
);

process.stdout.write(JSON.stringify({ visibleWhenOpen, visibleSameFrame }));
`);
    assert.equal(out.visibleWhenOpen, true, '打开时 Modal 应可见');
    assert.equal(
      out.visibleSameFrame,
      false,
      'meal 变为 null 的同一渲染帧，Modal 必须立即不可见（不得等待 useEffect）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-18-02 — 修复 2：A 的旧关闭动画完成回调不得关闭 B 新打开的弹窗
//
// 缺陷（修复前）：handleClose 的 start(cb) 无条件 setIsVisible(false)+onClose()。
//   A 关闭动画未完成 → B 打开 → A 旧回调迟到 → 误关 B 弹窗。
// 期望（修复后）：令牌已变 / finished=false → 旧回调整体丢弃。
// ===========================================================================
test('T-18-02 A 旧关闭动画完成回调不得关闭 B 新打开的弹窗', () => {
  const dir = buildMealSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${MEAL_SHEET_HARNESS}
let closeCount = 0;
const onClose = () => { closeCount += 1; };
const props = (meal) => ({ meal, checked: false, onClose, onConfirm: () => {}, onUndo: () => {} });

// 1) A 打开 '早餐'
renderSheet(props('早餐'));
let el = getEl();
const openAnimIdx = RN.__ANIM_QUEUE__.length - 1;

// 2) A 触发关闭（动画开始，但**不**完成）
//    通过 Modal 的 onRequestClose 调用 handleClose
const modalEl = (function find(el){
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'Modal') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = find(k); if (r) return r; }
  return null;
})(el);
modalEl.props.onRequestClose();
const closeAnimIdx = RN.__ANIM_QUEUE__.length - 1;

// 3) 切到 B：meal 变 null（身份切换），随后 B 打开 '晚餐'
renderSheet(props(null));
getEl();
renderSheet(props('晚餐'));
el = getEl();
const visibleAfterBOpen = findModalVisible(el);

// 4) A 的旧关闭动画此刻才完成（迟到回调）
finishAnim(closeAnimIdx, true);
el = getEl();
const visibleAfterStaleCb = findModalVisible(el);
const closeCountAfterStale = closeCount;

process.stdout.write(JSON.stringify({ visibleAfterBOpen, visibleAfterStaleCb, closeCountAfterStale }));
`);
    assert.equal(out.visibleAfterBOpen, true, 'B 打开后 Modal 应可见');
    assert.equal(
      out.visibleAfterStaleCb,
      true,
      'A 的旧关闭回调迟到时，不得关闭 B 的弹窗'
    );
    assert.equal(
      out.closeCountAfterStale,
      0,
      'A 的旧关闭回调迟到时，不得触发 onClose（不得改写新会话状态）'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-18-03 — 修复 2：被新打开动画取代的旧关闭动画（finished=false）必须丢弃
// ===========================================================================
test('T-18-03 被新打开动画取代的旧关闭回调（finished=false）必须丢弃', () => {
  const dir = buildMealSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${MEAL_SHEET_HARNESS}
let closeCount = 0;
const onClose = () => { closeCount += 1; };
const props = (meal) => ({ meal, checked: false, onClose, onConfirm: () => {}, onUndo: () => {} });

renderSheet(props('早餐'));
let el = getEl();
const modalEl = (function find(el){
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'Modal') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = find(k); if (r) return r; }
  return null;
})(el);
modalEl.props.onRequestClose();
const closeAnimIdx = RN.__ANIM_QUEUE__.length - 1;

// 同账号重新打开同一餐次（不同会话可打开同一餐次 → 不能靠餐次字符串判断）
renderSheet(props(null));
getEl();
renderSheet(props('早餐'));
el = getEl();

// 旧关闭动画被取代 → finished=false
finishAnim(closeAnimIdx, false);
el = getEl();
const visibleAfterCancelled = findModalVisible(el);
const closeCountAfterCancelled = closeCount;

process.stdout.write(JSON.stringify({ visibleAfterCancelled, closeCountAfterCancelled }));
`);
    assert.equal(out.visibleAfterCancelled, true, 'finished=false 的旧回调不得关闭当前弹窗');
    assert.equal(out.closeCountAfterCancelled, 0, 'finished=false 的旧回调不得触发 onClose');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-18-04 — 正向兼容：B 正常打开/关闭仍保留原动画、触感与交互
// ===========================================================================
test('T-18-04 B 正常打开/关闭仍保留原动画、触感与交互', () => {
  const dir = buildMealSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${MEAL_SHEET_HARNESS}
let closeCount = 0;
const onClose = () => { closeCount += 1; };
const onConfirm = () => { (globalThis.__CONFIRM_LOG__ ||= []).push(1); };
const props = (meal, checked) => ({ meal, checked, onClose, onConfirm, onUndo: () => {} });

// 打开
renderSheet(props('午餐', false));
let el = getEl();
const visibleOpen = findModalVisible(el);
const animCountAfterOpen = RN.__ANIM_QUEUE__.length;

// 正常关闭：走 Modal.onRequestClose → handleClose → 动画完成
const modalEl = (function find(el){
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'Modal') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = find(k); if (r) return r; }
  return null;
})(el);
modalEl.props.onRequestClose();
const closeAnimIdx = RN.__ANIM_QUEUE__.length - 1;
// 关闭动画期间：meal 仍为真 → Modal 仍可见（保留退出动画）
const visibleDuringClose = findModalVisible(renderNow());
// 动画完成
finishAnim(closeAnimIdx, true);
el = getEl();
const visibleAfterClose = findModalVisible(el);

// 触感：确认打卡应触发 success
renderSheet(props('午餐', false));
el = getEl();
const actionBtn = (function findBtn(el){
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'TouchableOpacity') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = findBtn(k); if (r) return r; }
  return null;
})(el);
actionBtn.props.onPress();
const hapticLog = globalThis.__HAPTIC_LOG__ || [];
const confirmLog = globalThis.__CONFIRM_LOG__ || [];

process.stdout.write(JSON.stringify({
  visibleOpen, animCountAfterOpen, visibleDuringClose, visibleAfterClose,
  closeCount, hapticLog, confirmCount: confirmLog.length,
}));
`);
    assert.equal(out.visibleOpen, true, '正常打开应可见');
    assert.ok(out.animCountAfterOpen >= 1, '打开应启动入场动画');
    assert.equal(out.visibleDuringClose, true, '关闭动画期间 Modal 应保持可见（保留退出动画）');
    assert.equal(out.visibleAfterClose, false, '关闭动画完成后 Modal 应不可见');
    assert.equal(out.closeCount, 1, '正常关闭应触发一次 onClose');
    assert.ok(out.hapticLog.includes('notify:success'), '确认打卡应触发 success 触感');
    assert.equal(out.confirmCount, 1, '确认打卡应触发 onConfirm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-18-05 — 修复 1+2 组合：A→B→A 及同账号新 authEpoch 的完整竞态
// ===========================================================================
test('T-18-05 A→B→A 与同账号新 authEpoch 下旧回调均不得污染新会话', () => {
  const dir = buildMealSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${MEAL_SHEET_HARNESS}
let closeCount = 0;
const onClose = () => { closeCount += 1; };
const props = (meal) => ({ meal, checked: false, onClose, onConfirm: () => {}, onUndo: () => {} });
const findModal = (el) => {
  if (!el || typeof el !== 'object') return null;
  if (el.type === 'Modal') return el;
  const kids = el.props && el.props.children;
  const arr = Array.isArray(kids) ? kids : (kids ? [kids] : []);
  for (const k of arr) { const r = findModal(k); if (r) return r; }
  return null;
};

// A 打开 '早餐' → 关闭动画开始（不完成）
renderSheet(props('早餐'));
let el = getEl();
findModal(el).props.onRequestClose();
const aCloseIdx = RN.__ANIM_QUEUE__.length - 1;

// A→B：meal=null
renderSheet(props(null));
el = getEl();
const visibleAtB = findModalVisible(el);

// B 打开 '午餐'
renderSheet(props('午餐'));
el = getEl();
const visibleBOpen = findModalVisible(el);

// A 旧关闭回调迟到
finishAnim(aCloseIdx, true);
el = getEl();
const visibleAfterAStale = findModalVisible(el);
const closeAfterAStale = closeCount;

// B→A（同账号新 authEpoch 语义：meal=null 再打开同一餐次 '早餐'）
renderSheet(props(null));
getEl();
renderSheet(props('早餐'));
el = getEl();
const visibleReopenSameMeal = findModalVisible(el);

// 再触发一次旧回调（此时队列里还有 B 的关闭？没有；用 A 的旧索引再触发一次模拟重复迟到）
finishAnim(aCloseIdx, true);
el = getEl();
const visibleAfterRepeatStale = findModalVisible(el);
const closeAfterRepeatStale = closeCount;

process.stdout.write(JSON.stringify({
  visibleAtB, visibleBOpen, visibleAfterAStale, closeAfterAStale,
  visibleReopenSameMeal, visibleAfterRepeatStale, closeAfterRepeatStale,
}));
`);
    assert.equal(out.visibleAtB, false, 'A→B 后 meal=null，Modal 当帧不可见');
    assert.equal(out.visibleBOpen, true, 'B 打开后可见');
    assert.equal(out.visibleAfterAStale, true, 'A 旧回调迟到不得关闭 B 弹窗');
    assert.equal(out.closeAfterAStale, 0, 'A 旧回调迟到不得触发 onClose');
    assert.equal(out.visibleReopenSameMeal, true, '同账号重开同一餐次应可见');
    assert.equal(out.visibleAfterRepeatStale, true, '重复迟到回调仍不得关闭弹窗');
    assert.equal(out.closeAfterRepeatStale, 0, '重复迟到回调仍不得触发 onClose');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// T-19 — Round 4A 收尾（R4A-03）：异步状态与退出动画收尾
//
// 背景：GPT 独立复审 21_T6B_ROUND4A_MODAL_LIFECYCLE_DIFF.patch 后确认两处新缺口：
//   问题 1：撤销/确认打卡会先 setSelectedMeal(null) → meal 变 null → Modal 提前
//           不可见，退出动画被截断（原实现动画期间保持 visible=true）。
//   问题 2：confirmCheck 的迟到异步回调（await messages.insert 之后）会无条件
//           setSelectedMeal(null)，清空切号后新账号 / 同账号新实例的选择。
//
// 修复：
//   - MealDetailSheet：新增 closing 状态参与 modalVisible 派生 —— 合法用户关闭
//     期间即使 meal 已 null 也保持可见；身份失效关闭（无 handleClose）仍当帧隐藏。
//   - useHealthData：每次 openMeal 生成唯一 selectionId；confirmCheck/undoCheck
//     异步返回后校验「身份 + 选中实例」双重一致才清理。
// ===========================================================================

// ---------------------------------------------------------------------------
// T-19-01 — FINAL-03：点击撤销后，退出动画完成前 Modal 必须保持可见
//
// 🛡️ 本用例已改为**真实 Provider → MealDetailSheet 集成**：
//   · 身份 / meal / selectionId 全部来自真实 HealthProvider 的 context value；
//   · 不再手写 ownerKey（旧版手写 'user-bbb::0' 掩盖了真实缺陷：
//     真实 Provider 的 selectedMealOwnerKey 在关闭后就是 null）。
//
// 缺陷（修复前）：handleAction → onUndo() → Provider setSelectedMeal(null)
//   → meal 变 null → modalVisible=false，退出动画被截断。
// 期望（修复后）：closing 记录「当前认证身份 + 选择实例」，动画期间即使 meal=null
//   仍可见；动画完成后才真正隐藏并触发 onClose。
// ---------------------------------------------------------------------------
test('T-19-01 点击撤销后退出动画完成前 Modal 必须保持可见（真实 Provider 契约）', () => {
  const dir = buildProviderSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${PROVIDER_SHEET_HARNESS}
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });
globalThis.__INSERT_IMPL__ = () => Promise.resolve({ error: null });

await boot('user-bbb', 0);

// 1) 打开「午餐」→ 确认打卡（使 checked=true，点击走撤销分支）
ctx.openMeal('午餐');
frame();
await ctx.confirmCheck();
frame();
const checkedNow = !!(ctx.mealsStatus && ctx.mealsStatus['午餐']);

// 重新打开详情（真实 Provider 的 selectedMeal 由 openMeal 设置）
ctx.openMeal('午餐');
// frame() 返回的是「effect 执行前」的树；打开 effect 里 setIsVisible(true) 需 settle 后才生效，
// 因此读取可见性必须用 getEl()（settle + rerender）。
frame();
let el = getEl();
const visibleOpen = findModalVisible(el);
const ownerKeyAtOpen = ctx.currentSessionOwnerKey;
const selectionIdAtOpen = ctx.selectedMealSelectionId;

// 2) 点击操作按钮（撤销）：真实 ctx.undoCheck 会把 selectedMeal 置 null，
//    随后 handleClose 启动退出动画
findActionBtn(el).props.onPress();
const closeAnimIdx = RN.__ANIM_QUEUE__.length - 1;

// 3) Provider 因 selectedMeal=null 重渲染 → Sheet 只重渲染（不跑 effect）
//    此时 currentSessionOwnerKey 不变、selectedMealSelectionId 变 null
frame();
const visibleDuringExit = findModalVisible(sheetRenderOnly());
const ownerKeyDuringExit = ctx.currentSessionOwnerKey;
const selectionIdDuringExit = ctx.selectedMealSelectionId;

// 4) 退出动画完成 → 此时才真正隐藏并 onClose
finishAnim(closeAnimIdx, true);
el = getEl();
const visibleAfterExit = findModalVisible(el);
const selectedAfterExit = ctx.selectedMeal;

process.stdout.write(JSON.stringify({
  checkedNow, visibleOpen, ownerKeyAtOpen, selectionIdAtOpen,
  visibleDuringExit, ownerKeyDuringExit, selectionIdDuringExit,
  visibleAfterExit, selectedAfterExit,
}));
`);
    assert.equal(out.checkedNow, true, '前置条件：确认打卡后 mealsStatus 应为 true');
    assert.equal(out.visibleOpen, true, '前置条件：打开时 Modal 应可见');
    assert.equal(out.ownerKeyAtOpen, 'user-bbb::0', '前置条件：Provider 应暴露真实 currentSessionOwnerKey');
    assert.ok(out.selectionIdAtOpen > 0, '前置条件：Provider 应暴露非空 selectionId');
    assert.equal(
      out.visibleDuringExit,
      true,
      '撤销后退出动画完成前，即使 meal 已 null，Modal 仍必须保持可见（不得截断退出动画）'
    );
    assert.equal(
      out.ownerKeyDuringExit,
      'user-bbb::0',
      '关闭期间 currentSessionOwnerKey 必须保持不变（不得随 selectedMeal 变 null）'
    );
    assert.equal(
      out.selectionIdDuringExit,
      null,
      '关闭后 selectedMealSelectionId 应为 null（Provider 已清空选中态）'
    );
    assert.equal(out.visibleAfterExit, false, '退出动画完成后 Modal 应不可见');
    assert.equal(out.selectedAfterExit, null, '退出动画完成后 Provider 选中态应为 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T-19-02 — FINAL-03：确认打卡后正常退出动画不得被快速异步返回截断
//
// 🛡️ 同样改为真实 Provider → MealDetailSheet 集成（身份/selectionId 均来自 Provider）。
//
// 缺陷（修复前）：onConfirm 若同步/快速 setSelectedMeal(null)，Modal 立即隐藏。
// 期望（修复后）：closing 标记保证退出动画完整播放，动画完成后才 onClose。
// ---------------------------------------------------------------------------
test('T-19-02 确认打卡后正常退出动画不得被快速异步返回截断（真实 Provider 契约）', () => {
  const dir = buildProviderSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${PROVIDER_SHEET_HARNESS}
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });
globalThis.__INSERT_IMPL__ = () => Promise.resolve({ error: null });

await boot('user-bbb', 0);

// 打开「早餐」（未打卡 → checked=false → 点击走确认分支）
ctx.openMeal('早餐');
// 同 T-19-01：读取可见性必须用 getEl()（settle 后 effect 才把 isVisible 置 true）。
frame();
let el = getEl();
const visibleOpen = findModalVisible(el);
const ownerKeyAtOpen = ctx.currentSessionOwnerKey;
const selectionIdAtOpen = ctx.selectedMealSelectionId;

// 点击确认：真实 ctx.confirmCheck 会（快速）把 selectedMeal 置 null
findActionBtn(el).props.onPress();
const closeAnimIdx = RN.__ANIM_QUEUE__.length - 1;

// Provider 因 selectedMeal=null 重渲染 → Sheet 只重渲染（不跑 effect）
frame();
const visibleDuringExit = findModalVisible(sheetRenderOnly());
const ownerKeyDuringExit = ctx.currentSessionOwnerKey;
const selectionIdDuringExit = ctx.selectedMealSelectionId;

finishAnim(closeAnimIdx, true);
el = getEl();
const visibleAfterExit = findModalVisible(el);
const selectedAfterExit = ctx.selectedMeal;
const checkedAfter = !!(ctx.mealsStatus && ctx.mealsStatus['早餐']);

process.stdout.write(JSON.stringify({
  visibleOpen, ownerKeyAtOpen, selectionIdAtOpen,
  visibleDuringExit, ownerKeyDuringExit, selectionIdDuringExit,
  visibleAfterExit, selectedAfterExit, checkedAfter,
}));
`);
    assert.equal(out.visibleOpen, true, '前置条件：打开时 Modal 应可见');
    assert.equal(out.ownerKeyAtOpen, 'user-bbb::0', '前置条件：Provider 应暴露真实 currentSessionOwnerKey');
    assert.ok(out.selectionIdAtOpen > 0, '前置条件：Provider 应暴露非空 selectionId');
    assert.equal(
      out.visibleDuringExit,
      true,
      '确认打卡后退出动画完成前，Modal 必须保持可见（不得被快速异步返回截断）'
    );
    assert.equal(
      out.ownerKeyDuringExit,
      'user-bbb::0',
      '关闭期间 currentSessionOwnerKey 必须保持不变'
    );
    // ⚠️ confirmCheck 是 async：它要 await RPC / messages.insert 之后才 setSelectedMeal(null)。
    //    本用例点击后未 await 该 Promise，因此退出动画期间 selectedMeal 可能仍非空
    //    （selectionIdDuringExit 仍为打开时的实例 id）。这不是缺陷——恰恰说明退出动画
    //    在「异步清理尚未落地」时也必须完整播放。故此处只断言「身份不变 + 动画完整」，
    //    不断言 selectionId 已为 null（那是 undo 同步路径 T-19-01 的断言）。
    assert.equal(
      out.ownerKeyDuringExit,
      'user-bbb::0',
      '确认打卡退出动画期间 currentSessionOwnerKey 必须保持不变'
    );
    assert.equal(out.visibleAfterExit, false, '退出动画完成后 Modal 应不可见');
    assert.equal(out.selectedAfterExit, null, '退出动画完成后 Provider 选中态应为 null');
    assert.equal(out.checkedAfter, true, '确认打卡应真实写入 mealsStatus');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T-19-03 — 问题 2：A 的迟到 messages.insert 不得清空 B 新打开的选择
//
// 缺陷（修复前）：confirmCheck 在 await messages.insert 之后无条件
//   setSelectedMeal(null) → A 的 Promise 迟到返回时清空 B 刚打开的选择。
// 期望（修复后）：异步返回后校验身份 + selectionId，A 的迟到回调整体丢弃。
// ---------------------------------------------------------------------------
test('T-19-03 A 的迟到 messages.insert 不得清空 B 新打开的选择', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const A = 'user-aaa', B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: 'partner-x', error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

// 可控 messages.insert：把 resolve 句柄暴露给测试，手动决定何时返回
let releaseInsert;
globalThis.__INSERT_IMPL__ = () => new Promise((resolve) => { releaseInsert = () => resolve({ error: null }); });

// 1) A 会话：打开「早餐」并触发确认（进入 await messages.insert）
globalThis.__UID__ = A;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();
ctx.openMeal('早餐');
rt.settle();
const aSelected = ctx.selectedMeal;
const aConfirmPromise = ctx.confirmCheck();
rt.settle();

// 2) 切到 B（A 的 insert 仍未返回）
globalThis.__UID__ = B;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 40));
rt.settle();

// 3) B 打开「午餐」
ctx.openMeal('午餐');
rt.settle();
const bSelectedBefore = ctx.selectedMeal;

// 4) A 的 insert 此刻才返回 → A 的迟到回调不得清空 B 的选择
releaseInsert();
await aConfirmPromise;
rt.settle();
const bSelectedAfter = ctx.selectedMeal;

process.stdout.write(JSON.stringify({ aSelected, bSelectedBefore, bSelectedAfter }));
`);
    assert.equal(out.aSelected, '早餐', '前置条件：A 打开详情后应选中「早餐」');
    assert.equal(out.bSelectedBefore, '午餐', '前置条件：B 打开详情后应选中「午餐」');
    assert.equal(
      out.bSelectedAfter,
      '午餐',
      'A 的迟到 messages.insert 回调不得清空 B 新打开的选择'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T-19-04 — 问题 2：同账号顺序打开不同餐次，旧确认结果不得清空新选择
//
// 缺陷（修复前）：旧 confirmCheck 迟到返回时无条件 setSelectedMeal(null)，
//   清空同账号随后打开的另一餐次。
// 期望（修复后）：selectionId 不同 → 旧回调不清理新实例。
// ---------------------------------------------------------------------------
test('T-19-04 同账号顺序打开不同餐次，旧确认结果不得清空新选择', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: 'partner-x', error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

let releaseInsert;
globalThis.__INSERT_IMPL__ = () => new Promise((resolve) => { releaseInsert = () => resolve({ error: null }); });

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 1) 打开「早餐」并确认（进入 await insert）
ctx.openMeal('早餐');
rt.settle();
const firstSelected = ctx.selectedMeal;
const firstConfirm = ctx.confirmCheck();
rt.settle();

// 2) 同账号顺序打开「晚餐」（新实例）
ctx.openMeal('晚餐');
rt.settle();
const secondSelectedBefore = ctx.selectedMeal;

// 3) 「早餐」的 insert 迟到返回 → 不得清空「晚餐」选择
releaseInsert();
await firstConfirm;
rt.settle();
const secondSelectedAfter = ctx.selectedMeal;

process.stdout.write(JSON.stringify({ firstSelected, secondSelectedBefore, secondSelectedAfter }));
`);
    assert.equal(out.firstSelected, '早餐', '前置条件：首次打开应选中「早餐」');
    assert.equal(out.secondSelectedBefore, '晚餐', '前置条件：顺序打开应选中「晚餐」');
    assert.equal(
      out.secondSelectedAfter,
      '晚餐',
      '同账号旧确认结果迟到返回时，不得清空随后打开的另一餐次选择'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T-19-05 — 问题 2：同账号重开同一餐次，旧操作不得误关新实例
//
// 缺陷（修复前）：仅凭餐次字符串无法区分「同一餐次的不同打开实例」，
//   旧 confirmCheck 迟到返回会误关重开的新实例。
// 期望（修复后）：selectionId 不同 → 旧回调不清理新实例（即使餐次名相同）。
// ---------------------------------------------------------------------------
test('T-19-05 同账号重开同一餐次，旧操作不得误关新实例', () => {
  const dir = buildHealthSandbox();
  try {
    const out = runInSandbox(dir, `
${HEALTH_HARNESS}
const B = 'user-bbb';
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: 'partner-x', error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });

let releaseInsert;
globalThis.__INSERT_IMPL__ = () => new Promise((resolve) => { releaseInsert = () => resolve({ error: null }); });

globalThis.__UID__ = B;
globalThis.__EPOCH__ = 0;
rt.render(Comp);
rt.settle();
await new Promise((r) => setTimeout(r, 30));
rt.settle();

// 1) 打开「午餐」并确认（进入 await insert）
ctx.openMeal('午餐');
rt.settle();
const firstSelected = ctx.selectedMeal;
const firstConfirm = ctx.confirmCheck();
rt.settle();

// 2) 关闭后重新打开同一餐次「午餐」（新实例，餐次名相同）
ctx.closeMeal();
rt.settle();
ctx.openMeal('午餐');
rt.settle();
const reopenedBefore = ctx.selectedMeal;

// 3) 旧 confirmCheck 迟到返回 → 不得误关重开的新实例
releaseInsert();
await firstConfirm;
rt.settle();
const reopenedAfter = ctx.selectedMeal;

process.stdout.write(JSON.stringify({ firstSelected, reopenedBefore, reopenedAfter }));
`);
    assert.equal(out.firstSelected, '午餐', '前置条件：首次打开应选中「午餐」');
    assert.equal(out.reopenedBefore, '午餐', '前置条件：重开同一餐次应选中「午餐」');
    assert.equal(
      out.reopenedAfter,
      '午餐',
      '同账号重开同一餐次后，旧操作迟到返回不得误关新实例'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T-19-06 — FINAL-04：切号时旧详情仍当帧隐藏，旧动画完成回调仍被拦截
//
// 🛡️ 改为真实 Provider → MealDetailSheet 集成：切号通过 __UID__/__EPOCH__
//    驱动真实 useAuth stub，Provider 的 currentSessionOwnerKey 随之变化。
//
// 缺陷（修复前）：若为保留退出动画而简单删除 modalVisible 的身份保护，
//   切号时旧详情会继续展示（隐私泄漏）；旧动画回调也可能误关新弹窗。
// 期望（修复后）：身份失效关闭（meal=null 且无 handleClose）当帧隐藏；
//   旧关闭动画完成回调仍被令牌拦截，不触发 onClose。
// ---------------------------------------------------------------------------
test('T-19-06 切号时旧详情仍当帧隐藏且旧动画完成回调仍被拦截（真实 Provider 契约）', () => {
  const dir = buildProviderSheetSandbox();
  try {
    const out = runInSandbox(dir, `
${PROVIDER_SHEET_HARNESS}
globalThis.__UPSERT_IMPL__ = () => Promise.resolve({ error: null });
globalThis.__RPC_IMPL__ = () => Promise.resolve({ data: null, error: null });
globalThis.__PROFILE_QUERY__ = () => Promise.resolve({ data: null, error: null });
globalThis.__INSERT_IMPL__ = () => Promise.resolve({ error: null });

// 1) A 会话：打开「早餐」→ 触发关闭（动画开始，不完成）
await boot('user-aaa', 0);
ctx.openMeal('早餐');
let el = frame();
const ownerKeyA = ctx.currentSessionOwnerKey;
const selectionIdA = ctx.selectedMealSelectionId;
findModal(el).props.onRequestClose();
const aCloseIdx = RN.__ANIM_QUEUE__.length - 1;

// 2) 切号到 B：Provider 的 currentSessionOwnerKey 立即变为 B（身份失效关闭，
//    **未**走 handleClose）。Sheet 只重渲染 → 当帧必须不可见。
globalThis.__UID__ = 'user-bbb';
globalThis.__EPOCH__ = 1;
frame();
const ownerKeyB = ctx.currentSessionOwnerKey;
const visibleSameFrame = findModalVisible(sheetRenderOnly());

// 3) B 打开「晚餐」
ctx.openMeal('晚餐');
// 同 T-19-01：打开 effect 的 setIsVisible(true) 需 settle 后才生效，读取可见性用 getEl()。
frame();
el = getEl();
const visibleBOpen = findModalVisible(el);
const selectionIdB = ctx.selectedMealSelectionId;

// 4) A 的旧关闭动画此刻完成（迟到回调）→ 必须被令牌拦截
finishAnim(aCloseIdx, true);
el = getEl();
const visibleAfterStale = findModalVisible(el);
const selectedAfterStale = ctx.selectedMeal;

process.stdout.write(JSON.stringify({
  ownerKeyA, selectionIdA, ownerKeyB, selectionIdB,
  visibleSameFrame, visibleBOpen, visibleAfterStale, selectedAfterStale,
}));
`);
    assert.equal(out.ownerKeyA, 'user-aaa::0', '前置条件：A 会话身份应为 user-aaa::0');
    assert.ok(out.selectionIdA > 0, '前置条件：A 应有非空 selectionId');
    assert.equal(out.ownerKeyB, 'user-bbb::1', '前置条件：切号后身份应为 user-bbb::1');
    assert.equal(
      out.visibleSameFrame,
      false,
      '切号（身份失效关闭）时旧详情必须当帧隐藏，不得被 closing 标记掩盖'
    );
    assert.equal(out.visibleBOpen, true, 'B 打开后 Modal 应可见');
    assert.ok(out.selectionIdB > out.selectionIdA, 'B 的 selectionId 应大于 A（实例单调递增）');
    assert.equal(out.visibleAfterStale, true, 'A 的旧关闭动画完成回调不得关闭 B 的弹窗');
    assert.equal(out.selectedAfterStale, '晚餐', 'A 的旧关闭动画完成回调不得清空 B 的选中态');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- END OF FILE tests/security/t6bRuntime.test.mjs ---
