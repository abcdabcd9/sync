// --- START OF FILE tests/security/p14r3AuthMigrationEquivalence.test.mjs ---
/**
 * P1.4 R3 — Auth 身份权威模块 JS → TSX 迁移 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前实现：冻结基线（tests/fixtures/p14r3/before/hooks__useAuth.js）
 *     · 迁移后实现：当前真实源码（src/hooks/useAuth.tsx）
 *   对同一组认证事件序列比较**完整可观测结果**：
 *     - Context value 全部字段（user / session / isAuthLoading / authError /
 *       ownerId / authEpoch / isIdentityTransitioning / signOutError / 公开方法形状）
 *     - 下游 owner 登记真实内部状态（signedUrl / profileCache / mediaCache 的
 *       ownerId 与 epoch，通过各模块真实 getter 读取，不做调用拦截）
 *     - supabase.auth 调用序列（getSession / signOut / signInWithPassword / signUp /
 *       profiles.update 次数与顺序）
 *     - authStorageStatus 读取次数
 *     - 自动刷新控制器生命周期（startAutoRefresh / stopAutoRefresh 调用与 AppState 监听）
 *     - 异常语义（signOut 失败分支 / 重入锁返回值）
 *
 * 覆盖（AUTH-1 .. AUTH-16）
 *   AUTH-1  冷启动：getSession 返回 null → 未登录终态
 *   AUTH-2  冷启动：getSession 返回会话 → 已登录 + owner 登记
 *   AUTH-3  冷启动：getSession 抛错 → authError 显式失败（不当作已登出）
 *   AUTH-4  冷启动：存储故障位 → authError 且不 applySession
 *   AUTH-5  SIGNED_IN：A 登录 → owner 登记 + epoch 推进
 *   AUTH-6  SIGNED_OUT：A 登出（事件驱动）→ owner 清空 + epoch 推进
 *   AUTH-7  TOKEN_REFRESHED：同账号刷新 → epoch 不变、下游不强制失效
 *   AUTH-8  同账号真实重新登录（token 轮换，非 TOKEN_REFRESHED）→ epoch 推进 + 下游 forceBump
 *   AUTH-9  A→B→A：两次 owner 变化 → epoch 单调推进、下游 owner 跟随
 *   AUTH-10 迟到 Promise：init getSession 挂起期间收到 SIGNED_IN → 旧结果丢弃
 *   AUTH-11 retrySession：挂起期间收到更晚事件 → 旧结果丢弃（不覆盖 loading/error）
 *   AUTH-12 signOut 成功：profiles 更新 → signOut → epoch/eventSeq 推进 → 清空
 *   AUTH-13 signOut 重入锁：第二次调用返回 AUTH_SIGN_OUT_IN_PROGRESS
 *   AUTH-14 signOut 失败（signOut 返回 error）：保留会话 + signOutError
 *   AUTH-15 signOut 失败（存储 UNAVAILABLE）：保留会话 + 显式错误
 *   AUTH-16 自动刷新生命周期：AppState active/background 驱动 start/stop，卸载清理
 *   AUTH-17 公开接口形状与 Context 默认值（createContext 无默认值 → undefined）
 *   AUTH-18 卸载清理：init 订阅 unsubscribe + 自动刷新 dispose
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实源码：
 *   该运行时实现 useState / useRef / useEffect / useCallback / useMemo / useContext /
 *   createContext / createElement / render / rerender / flushEffects / settle / unmount
 *   的最小语义，用于在 Node 环境中真实调用 Hook / Provider 并观察状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 *   TSX 处理：Node v24 原生类型剥离**不支持** .tsx / JSX。因此迁移后的
 *   `useAuth.tsx` 在沙箱内使用**项目自带 TypeScript 编译器**
 *   （`ts.transpileModule`，jsx: React）转译为 `.js` 后执行——这是项目既有的受控
 *   TypeScript JSX 转译机制，**不是**为测试手工改写生产 JSX 结构。
 *   迁移前的 `.js` 基线同样经该转译器处理，保证两侧执行机制一致。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / SecureStore / AsyncStorage（使用记录型 stub）。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行源码，不复制内部函数做模拟。
 *   · 迁移前后使用同一段场景脚本，仅被测源码路径不同。
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r3/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__useAuth.js':
    'e21f018bb51a92eaf6443cd62d5fc2ce2349031c034e25ef1c9b08b5f292dcfe',
};

test('P14R3-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 P1.3 / P1.4 R0 / R1 / R2 测试同构，独立复制以保持自包含）
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

  function useContext(ctx) {
    if (!ctx || !ctx.__ctx) return undefined;
    return ctx.__ctx.current;
  }
  function createContext(v) {
    const ctx = { __ctx: { current: v } };
    ctx.Provider = { __ctx: ctx.__ctx, __isProvider: true };
    return ctx;
  }

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
    useState, useRef, useEffect, useCallback, useMemo, useContext, createContext,
    render, rerender, flushEffects, settle, unmount,
    get renderCount() { return renderCount; },
    get isScheduled() { return scheduled; },
  };
}
`;

// ---------------------------------------------------------------------------
// 沙箱构建
//   mode = 'before' → 使用冻结基线（迁移前 JS）
//   mode = 'after'  → 使用当前真实源码（迁移后 TSX）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r3-auth-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // react stub：Hook 运行时单例 + createContext/useContext 真实语义 + createElement
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
${HOOK_RUNTIME_SRC}
// 每次调用返回独立实例：Provider 与消费者必须分属不同 runtime，
// 否则共享 hooks 槽位会互相覆盖（单组件栈限制）。
// 模块级 Hook 动态路由到「当前活跃 runtime」：render()/rerender() 执行组件函数期间
// 把该 runtime 设为活跃，组件内 import 的 useState 等即落到正确实例。
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
export const useContext = __route('useContext');
// createContext 无状态，直接使用独立实现（返回跨 runtime 共享的 __ctx 容器）
// Provider 必须是可被 createElement 承载的组件标识；其 value 通过 __ctx 容器共享，
// 这样 Provider 与消费者即使分属不同 runtime 也能读到同一份 value。
export const createContext = (v) => {
  const ctx = { __ctx: { current: v } };
  ctx.Provider = { __ctx: ctx.__ctx, __isProvider: true };
  return ctx;
};
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  // react-native stub：AppState 可控（记录监听器 + 可手动 emit）
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

  // AsyncStorage stub：记录型（mediaCache / useProfileCache 可能间接使用）
  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({
      name: '@react-native-async-storage/async-storage',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
    }),
    'index.js': `
export const __AS_LOG__ = [];
export const __AS_DATA__ = new Map();
const store = __AS_DATA__;
const log = __AS_LOG__;
const AsyncStorage = {
  async getItem(key) {
    const v = store.has(key) ? store.get(key) : null;
    log.push(['getItem', key, v]);
    return v;
  },
  async setItem(key, value) {
    store.set(key, value);
    log.push(['setItem', key, value]);
  },
  async removeItem(key) {
    store.delete(key);
    log.push(['removeItem', key]);
  },
  async multiSet(pairs) {
    for (const [k, v] of pairs) store.set(k, v);
    log.push(['multiSet', pairs.map((p) => [p[0], p[1]])]);
  },
  async multiGet(keys) {
    const out = keys.map((k) => [k, store.has(k) ? store.get(k) : null]);
    log.push(['multiGet', keys.slice()]);
    return out;
  },
  async getAllKeys() { return [...store.keys()]; },
  async clear() { store.clear(); },
};
export default AsyncStorage;
`,
  });

  // expo-file-system stub（mediaCache 依赖；本测试不触发真实磁盘写入）
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

  // @supabase/supabase-js stub（supabase.ts 依赖；本测试用自建 supabase 服务 stub）
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // react-native-url-polyfill stub（supabase.ts 可能 import）
  mk('react-native-url-polyfill', {
    'package.json': JSON.stringify({ name: 'react-native-url-polyfill', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export default {};\n',
  });

  // expo-secure-store stub（authStorage 依赖）
  mk('expo-secure-store', {
    'package.json': JSON.stringify({ name: 'expo-secure-store', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
export async function getItemAsync(k){ return store.has(k) ? store.get(k) : null; }
export async function setItemAsync(k,v){ store.set(k, String(v)); }
export async function deleteItemAsync(k){ store.delete(k); }
export default { getItemAsync, setItemAsync, deleteItemAsync };
`,
  });

  // 复制真实源码到沙箱。
  // P1.4 R5 起 useSignedMediaUrl 已迁移为 .ts（.js 原件删除），
  // 因此当 .js 源不存在时回退到同名 .ts 并转译为 .js 落盘，
  // 保证 R3 测试的 import 路径（无扩展名）语义完全不变。
  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(relSrc)) {
      fs.copyFileSync(relSrc, dst);
      return;
    }
    const tsSrc = relSrc.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsSrc)) {
      const out = ts.transpileModule(fs.readFileSync(tsSrc, 'utf8'), {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(tsSrc),
      }).outputText;
      fs.writeFileSync(dst, out);
      return;
    }
    throw new Error(`copyFile: 源文件不存在（.js/.ts 均缺失）: ${relSrc}`);
  };

  // 类型模块（仅类型，运行时为空；复制以支持潜在 import type 解析）
  copyFile(path.join(repoRoot, 'src/types/auth.ts'), 'src/types/auth.ts');
  copyFile(path.join(repoRoot, 'src/types/result.ts'), 'src/types/result.ts');
  copyFile(path.join(repoRoot, 'src/types/user.ts'), 'src/types/user.ts');

  // 下游 owner 登记模块：真实源码（用于观测真实内部 owner/epoch 状态）
  copyFile(path.join(repoRoot, 'src/hooks/chat/useSignedMediaUrl.js'), 'src/hooks/chat/useSignedMediaUrl.js');
  copyFile(path.join(repoRoot, 'src/hooks/profile/useProfileCache.ts'), 'src/hooks/profile/useProfileCache.ts');
  copyFile(path.join(repoRoot, 'src/services/mediaCache.ts'), 'src/services/mediaCache.ts');
  // 自动刷新控制器：真实实现（非 stub），保证沙箱执行生产代码
  copyFile(path.join(repoRoot, 'src/services/authAutoRefresh.ts'), 'src/services/authAutoRefresh.ts');
  // P1.4 R3 有界纯逻辑解耦：身份转移决策（after 侧 useAuth.tsx 依赖）。
  //   before 侧冻结基线不 import 它，复制到两侧无副作用。
  copyFile(
    path.join(repoRoot, 'src/hooks/auth/identityTransitionLogic.ts'),
    'src/hooks/auth/identityTransitionLogic.ts',
  );

  // 被测模块：before 用冻结基线，after 用当前真实源码。
  // 含 JSX 的模块两侧都必须经 ts.transpileModule 转译为 .js。
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

  const place = (srcPath, dstRel, needsTranspile) => {
    const src = fs.readFileSync(srcPath, 'utf8');
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, needsTranspile ? transpile(src, path.basename(srcPath)) : src);
  };

  if (mode === 'before') {
    place(path.join(beforeDir, 'hooks__useAuth.js'), 'src/hooks/useAuth.js', true);
  } else {
    place(path.join(repoRoot, 'src/hooks/useAuth.tsx'), 'src/hooks/useAuth.js', true);
  }

  // supabase 服务 stub：可控 auth 事件 + 可注入 getSession / signOut / profiles.update
  //   · __state 暴露全部注入点与调用日志
  //   · __emitAuth 手动派发认证事件
  //   · authStorageStatus.get 可注入故障位
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/services/supabase.js'),
    `
const state = {
  authListeners: [],
  sessionImpl: () => Promise.resolve({ data: { session: null }, error: null }),
  signOutImpl: () => Promise.resolve({ error: null }),
  profileUpdateImpl: () => Promise.resolve({ error: null }),
  storageFailure: null,
  calls: [],
  autoRefreshLog: [],
  storageReads: 0,
};
export const supabase = {
  __state: state,
  auth: {
    getSession() {
      state.calls.push(['getSession']);
      return state.sessionImpl();
    },
    onAuthStateChange(cb) {
      state.calls.push(['onAuthStateChange']);
      state.authListeners.push(cb);
      return { data: { subscription: { unsubscribe() {
        state.calls.push(['unsubscribe']);
        const i = state.authListeners.indexOf(cb);
        if (i >= 0) state.authListeners.splice(i, 1);
      } } } };
    },
    signOut() {
      state.calls.push(['signOut']);
      return state.signOutImpl();
    },
    signInWithPassword(args) {
      state.calls.push(['signInWithPassword', args && args.email]);
      return Promise.resolve({ data: null, error: null });
    },
    signUp(args) {
      state.calls.push(['signUp', args && args.email]);
      return Promise.resolve({ data: null, error: null });
    },
    async startAutoRefresh() { state.autoRefreshLog.push('start'); },
    async stopAutoRefresh() { state.autoRefreshLog.push('stop'); },
  },
  from(table) {
    const api = {
      update(row) {
        state.calls.push(['profiles.update', table, row]);
        return api;
      },
      eq(col, val) {
        state.calls.push(['profiles.eq', col, val]);
        return state.profileUpdateImpl();
      },
    };
    return api;
  },
  __emitAuth(event, session) {
    state.calls.push(['emitAuth', event]);
    for (const cb of state.authListeners.slice()) cb(event, session);
  },
  __listenerCount() { return state.authListeners.length; },
};
export const authStorageStatus = {
  get() {
    state.storageReads += 1;
    return state.storageFailure;
  },
};
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
export const probeAuthStorage = async () => true;
`
  );

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // 解析器：扩展名省略时依次尝试 .js / .ts / .tsx / index.js / index.ts
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

// ---------------------------------------------------------------------------
// 通用：在 before / after 两个沙箱中执行同一段场景脚本，返回可观测快照
// ---------------------------------------------------------------------------
function runBoth(body) {
  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  const before = runInSandbox(beforeSandbox, body);
  const after = runInSandbox(afterSandbox, body);
  return { before, after };
}

function assertEqualBoth(body, label) {
  const { before, after } = runBoth(body);
  assert.deepEqual(after, before, `Auth 迁移前后可观测结果必须一致：${label}`);
  return { before, after };
}

// ===========================================================================
// AUTH_PRELUDE：挂载 AuthProvider + 消费者，暴露可控认证事件与快照
// ===========================================================================
const AUTH_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { AppState } = await import('react-native');
const { supabase } = await import('./src/services/supabase');
const { AuthProvider, useAuth } = await import('./src/hooks/useAuth');
const signedMod = await import('./src/hooks/chat/useSignedMediaUrl');
const profileMod = await import('./src/hooks/profile/useProfileCache');
const mediaMod = await import('./src/services/mediaCache');

const state = supabase.__state;

function resetState() {
  state.authListeners.length = 0;
  state.sessionImpl = () => Promise.resolve({ data: { session: null }, error: null });
  state.signOutImpl = () => Promise.resolve({ error: null });
  state.profileUpdateImpl = () => Promise.resolve({ error: null });
  state.storageFailure = null;
  state.calls.length = 0;
  state.autoRefreshLog.length = 0;
  state.storageReads = 0;
}

async function drain(n = 20) { for (let i = 0; i < n; i++) await Promise.resolve(); }

function makeSession(id, token) {
  return { access_token: token, user: { id } };
}

// 挂载 Provider + 消费者：Provider 与消费者分属不同 runtime
function mountAuth() {
  const providerRt = createHookRuntime();
  const consumerRt = createHookRuntime();
  let ctx;
  let tree;
  const publish = () => {
    const value = tree && tree.props ? tree.props.value : undefined;
    if (value !== undefined) {
      const ctxRef = tree && tree.type && tree.type.__ctx;
      if (ctxRef) ctxRef.current = value;
    }
  };
  const renderTree = () => {
    tree = providerRt.render(() => AuthProvider({ children: null }));
    publish();
    consumerRt.render(() => { ctx = useAuth(); });
  };
  renderTree();
  return {
    providerRt,
    consumerRt,
    get ctx() { return ctx; },
    get tree() { return tree; },
    rerenderProvider() { renderTree(); },
    sync() {
      let rounds = 0;
      while (providerRt.isScheduled && rounds < 20) {
        tree = providerRt.rerender();
        rounds += 1;
      }
      publish();
      consumerRt.render(() => { ctx = useAuth(); });
    },
    unmount() { providerRt.unmount(); },
  };
}

// 下游 owner 登记真实内部状态（通过真实 getter 读取，不做调用拦截）
function ownerSnapshot() {
  const s = signedMod.getSignedUrlIdentity();
  const m = mediaMod.getMediaCacheIdentity();
  return {
    signed: { ownerId: s.ownerId, epoch: s.epoch },
    profileGeneration: profileMod.getProfileCacheGeneration(),
    media: { ownerId: m.ownerId, epoch: m.epoch },
  };
}

function snapAuth(m) {
  const c = m.ctx;
  return {
    user: c.user ? { id: c.user.id } : null,
    session: c.session ? { access_token: c.session.access_token, userId: c.session.user && c.session.user.id } : null,
    isAuthLoading: c.isAuthLoading,
    authError: c.authError ? { code: c.authError.code, message: String(c.authError.message) } : null,
    ownerId: c.ownerId,
    authEpoch: c.authEpoch,
    isIdentityTransitioning: c.isIdentityTransitioning,
    signOutError: c.signOutError ? { code: c.signOutError.code, message: String(c.signOutError.message) } : null,
    keys: Object.keys(c).sort(),
    fnTypes: {
      retrySession: typeof c.retrySession,
      signIn: typeof c.signIn,
      signUp: typeof c.signUp,
      signOut: typeof c.signOut,
    },
    owner: ownerSnapshot(),
  };
}

function calls() { return state.calls.map((c) => JSON.parse(JSON.stringify(c))); }
function autoRefresh() { return state.autoRefreshLog.slice(); }
`;

// ===========================================================================
// AUTH-1 冷启动：getSession 返回 null → 未登录终态
// ===========================================================================
test('P14R3-AUTH-1 冷启动 getSession=null → 未登录终态', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m), calls: calls(), listeners: supabase.__listenerCount() }));
`;
  const { before } = assertEqualBoth(body, '冷启动 null');
  assert.equal(before.snap.user, null);
  assert.equal(before.snap.isAuthLoading, false);
  assert.equal(before.snap.ownerId, null);
  assert.equal(before.snap.authEpoch, 0);
  assert.equal(before.snap.authError, null);
  assert.equal(before.listeners, 1);
});

// ===========================================================================
// AUTH-2 冷启动：getSession 返回会话 → 已登录 + owner 登记
// ===========================================================================
test('P14R3-AUTH-2 冷启动 getSession=会话 → 已登录 + owner 登记', () => {
  const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.resolve({ data: { session: makeSession('u1', 'tok-1') }, error: null });
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m), calls: calls() }));
`;
  const { before } = assertEqualBoth(body, '冷启动会话');
  assert.equal(before.snap.user.id, 'u1');
  assert.equal(before.snap.ownerId, 'u1');
  assert.equal(before.snap.isAuthLoading, false);
  assert.equal(before.snap.authEpoch, 1);
  assert.equal(before.snap.owner.signed.ownerId, 'u1');
  assert.equal(before.snap.owner.media.ownerId, 'u1');
  assert.ok(before.snap.owner.profileGeneration >= 1);
});

// ===========================================================================
// AUTH-3 冷启动：getSession 抛错 → authError 显式失败（不当作已登出）
// ===========================================================================
test('P14R3-AUTH-3 冷启动 getSession 抛错 → authError 显式失败', () => {
  const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.reject(Object.assign(new Error('storage boom'), { code: 'AUTH_STORAGE_UNAVAILABLE' }));
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, '冷启动抛错');
  assert.equal(before.snap.user, null);
  assert.equal(before.snap.isAuthLoading, false);
  assert.equal(before.snap.authError.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(before.snap.authError.message, 'storage boom');
});

// ===========================================================================
// AUTH-4 冷启动：存储故障位 → authError 且不 applySession
// ===========================================================================
test('P14R3-AUTH-4 冷启动存储故障位 → authError 且不 applySession', () => {
  const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.resolve({ data: { session: makeSession('u1', 'tok-1') }, error: null });
state.storageFailure = { code: 'AUTH_STORAGE_UNAVAILABLE', message: 'keychain locked' };
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m), storageReads: state.storageReads }));
`;
  const { before } = assertEqualBoth(body, '冷启动存储故障位');
  assert.equal(before.snap.user, null);
  assert.equal(before.snap.ownerId, null);
  assert.equal(before.snap.authEpoch, 0);
  assert.equal(before.snap.authError.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(before.snap.authError.message, 'keychain locked');
  assert.ok(before.storageReads >= 1);
});

// ===========================================================================
// AUTH-5 SIGNED_IN：A 登录 → owner 登记 + epoch 推进
// ===========================================================================
test('P14R3-AUTH-5 SIGNED_IN → owner 登记 + epoch 推进', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
const initial = snapAuth(m);
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ initial, after: snapAuth(m), calls: calls() }));
`;
  const { before } = assertEqualBoth(body, 'SIGNED_IN');
  assert.equal(before.initial.authEpoch, 0);
  assert.equal(before.after.user.id, 'u1');
  assert.equal(before.after.ownerId, 'u1');
  assert.equal(before.after.authEpoch, 1);
  assert.equal(before.after.isAuthLoading, false);
  assert.equal(before.after.owner.signed.ownerId, 'u1');
  assert.equal(before.after.owner.media.ownerId, 'u1');
});

// ===========================================================================
// AUTH-6 SIGNED_OUT：A 登出（事件驱动）→ owner 清空 + epoch 推进
// ===========================================================================
test('P14R3-AUTH-6 SIGNED_OUT（事件驱动）→ owner 清空 + epoch 推进', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
supabase.__emitAuth('SIGNED_OUT', null);
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, signedOut: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'SIGNED_OUT');
  assert.equal(before.signedIn.authEpoch, 1);
  assert.equal(before.signedOut.user, null);
  assert.equal(before.signedOut.ownerId, null);
  assert.equal(before.signedOut.authEpoch, 2);
  assert.equal(before.signedOut.owner.signed.ownerId, null);
  assert.equal(before.signedOut.owner.media.ownerId, null);
});

// ===========================================================================
// AUTH-7 TOKEN_REFRESHED：同账号刷新 → epoch 不变、下游不强制失效
// ===========================================================================
test('P14R3-AUTH-7 TOKEN_REFRESHED → epoch 不变、下游不强制失效', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
supabase.__emitAuth('TOKEN_REFRESHED', makeSession('u1', 'tok-2'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, refreshed: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'TOKEN_REFRESHED');
  assert.equal(before.signedIn.authEpoch, 1);
  assert.equal(before.refreshed.authEpoch, 1, 'TOKEN_REFRESHED 不得推进 epoch');
  assert.equal(before.refreshed.session.access_token, 'tok-2');
  assert.equal(before.refreshed.owner.signed.epoch, before.signedIn.owner.signed.epoch, '下游 signed epoch 不得因刷新变化');
  assert.equal(before.refreshed.owner.media.epoch, before.signedIn.owner.media.epoch, '下游 media epoch 不得因刷新变化');
  assert.equal(before.refreshed.owner.profileGeneration, before.signedIn.owner.profileGeneration, '下游 profile 代际不得因刷新变化');
});

// ===========================================================================
// AUTH-8 同账号真实重新登录（token 轮换，非 TOKEN_REFRESHED）→ epoch 推进 + 下游 forceBump
// ===========================================================================
test('P14R3-AUTH-8 同账号 token 轮换（非 TOKEN_REFRESHED）→ epoch 推进 + 下游 forceBump', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-2'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, rotated: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, '同账号 token 轮换');
  assert.equal(before.signedIn.authEpoch, 1);
  assert.equal(before.rotated.authEpoch, 2, '同账号真实重新登录必须推进 epoch');
  assert.equal(before.rotated.ownerId, 'u1');
  assert.equal(before.rotated.owner.signed.epoch, before.signedIn.owner.signed.epoch + 1, '下游 signed 必须 forceBump');
  assert.equal(before.rotated.owner.media.epoch, before.signedIn.owner.media.epoch + 1, '下游 media 必须 forceBump');
  assert.equal(before.rotated.owner.profileGeneration, before.signedIn.owner.profileGeneration + 1, '下游 profile 必须 forceBump');
});

// ===========================================================================
// AUTH-9 A→B→A：两次 owner 变化 → epoch 单调推进、下游 owner 跟随
// ===========================================================================
test('P14R3-AUTH-9 A→B→A → epoch 单调推进、下游 owner 跟随', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('A', 'tok-a1'));
await drain();
m.sync();
const a1 = snapAuth(m);
supabase.__emitAuth('SIGNED_IN', makeSession('B', 'tok-b1'));
await drain();
m.sync();
const b1 = snapAuth(m);
supabase.__emitAuth('SIGNED_IN', makeSession('A', 'tok-a2'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ a1, b1, a2: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'A→B→A');
  assert.equal(before.a1.ownerId, 'A');
  assert.equal(before.b1.ownerId, 'B');
  assert.equal(before.a2.ownerId, 'A');
  assert.ok(before.a1.authEpoch < before.b1.authEpoch);
  assert.ok(before.b1.authEpoch < before.a2.authEpoch);
  assert.equal(before.a2.owner.signed.ownerId, 'A');
  assert.equal(before.a2.owner.media.ownerId, 'A');
});

// ===========================================================================
// AUTH-10 迟到 Promise：init getSession 挂起期间收到 SIGNED_IN → 旧结果丢弃
// ===========================================================================
test('P14R3-AUTH-10 迟到 init getSession 结果被更晚认证事件取代 → 丢弃', () => {
  const body = `${AUTH_PRELUDE}
resetState();
let resolveInit;
state.sessionImpl = () => new Promise((res) => { resolveInit = res; });
const m = mountAuth();
await drain();
// init getSession 仍挂起，此时派发更晚的 SIGNED_IN(B)
supabase.__emitAuth('SIGNED_IN', makeSession('B', 'tok-b'));
await drain();
m.sync();
const afterEvent = snapAuth(m);
// 现在让旧的 init getSession 返回 A 的会话（迟到）
resolveInit({ data: { session: makeSession('A', 'tok-a') }, error: null });
await drain();
m.sync();
process.stdout.write(JSON.stringify({ afterEvent, afterLate: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, '迟到 init 结果');
  assert.equal(before.afterEvent.ownerId, 'B');
  assert.equal(before.afterLate.ownerId, 'B', '迟到的旧 init 结果不得回滚身份');
  assert.equal(before.afterLate.authEpoch, before.afterEvent.authEpoch, '迟到结果不得推进 epoch');
  assert.equal(before.afterLate.isAuthLoading, false);
});

// ===========================================================================
// AUTH-11 retrySession：挂起期间收到更晚事件 → 旧结果丢弃
// ===========================================================================
test('P14R3-AUTH-11 retrySession 挂起期间更晚事件 → 旧结果丢弃', () => {
  const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.reject(Object.assign(new Error('first fail'), { code: 'AUTH_STORAGE_UNAVAILABLE' }));
const m = mountAuth();
await drain();
m.sync();
const failed = snapAuth(m);
let resolveRetry;
state.sessionImpl = () => new Promise((res) => { resolveRetry = res; });
const retryPromise = m.ctx.retrySession();
await drain();
// retry 挂起期间派发更晚的 SIGNED_IN(B)
supabase.__emitAuth('SIGNED_IN', makeSession('B', 'tok-b'));
await drain();
m.sync();
const afterEvent = snapAuth(m);
resolveRetry({ data: { session: makeSession('A', 'tok-a') }, error: null });
await retryPromise;
await drain();
m.sync();
process.stdout.write(JSON.stringify({ failed, afterEvent, afterRetry: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'retrySession 迟到');
  assert.equal(before.failed.authError.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(before.afterEvent.ownerId, 'B');
  assert.equal(before.afterRetry.ownerId, 'B', '迟到的 retry 结果不得回滚身份');
  assert.equal(before.afterRetry.authError, null, '迟到的 retry 不得写回 authError');
  assert.equal(before.afterRetry.isAuthLoading, false);
});

// ===========================================================================
// AUTH-12 signOut 成功：profiles 更新 → signOut → epoch/eventSeq 推进 → 清空
// ===========================================================================
test('P14R3-AUTH-12 signOut 成功 → 清空 + epoch 推进 + 下游清空', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
state.calls.length = 0;
const result = await m.ctx.signOut();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, result, after: snapAuth(m), calls: calls() }));
`;
  const { before } = assertEqualBoth(body, 'signOut 成功');
  assert.equal(before.result.error, null);
  assert.equal(before.after.user, null);
  assert.equal(before.after.ownerId, null);
  assert.equal(before.after.authEpoch, before.signedIn.authEpoch + 1);
  assert.equal(before.after.isIdentityTransitioning, false);
  assert.equal(before.after.signOutError, null);
  assert.equal(before.after.owner.signed.ownerId, null);
  assert.equal(before.after.owner.media.ownerId, null);
  const callNames = before.calls.map((c) => c[0]);
  assert.ok(callNames.includes('profiles.update'));
  assert.ok(callNames.includes('signOut'));
  assert.ok(callNames.indexOf('profiles.update') < callNames.indexOf('signOut'), 'profiles 更新必须先于 signOut');
});

// ===========================================================================
// AUTH-13 signOut 重入锁：第二次调用返回 AUTH_SIGN_OUT_IN_PROGRESS
// ===========================================================================
test('P14R3-AUTH-13 signOut 重入锁 → 第二次返回 AUTH_SIGN_OUT_IN_PROGRESS', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
let resolveSignOut;
state.signOutImpl = () => new Promise((res) => { resolveSignOut = res; });
const p1 = m.ctx.signOut();
await drain();
const second = await m.ctx.signOut();
resolveSignOut({ error: null });
const first = await p1;
await drain();
m.sync();
process.stdout.write(JSON.stringify({ first, second, after: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'signOut 重入锁');
  assert.equal(before.second.error.code, 'AUTH_SIGN_OUT_IN_PROGRESS');
  assert.equal(before.second.error.message, '登出正在进行中');
  assert.equal(before.first.error, null);
  assert.equal(before.after.user, null);
});

// ===========================================================================
// AUTH-14 signOut 失败（signOut 返回 error）：保留会话 + signOutError
// ===========================================================================
test('P14R3-AUTH-14 signOut 返回 error → 保留会话 + signOutError', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
state.signOutImpl = () => Promise.resolve({ error: { code: 'AUTH_SIGN_OUT_FAILED', message: 'network down' } });
const result = await m.ctx.signOut();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, result, after: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'signOut 返回 error');
  assert.equal(before.result.error.code, 'AUTH_SIGN_OUT_FAILED');
  assert.equal(before.after.user.id, 'u1', '登出失败不得清空 user');
  assert.equal(before.after.ownerId, 'u1');
  assert.equal(before.after.authEpoch, before.signedIn.authEpoch, '登出失败不得推进 epoch');
  assert.equal(before.after.signOutError.code, 'AUTH_SIGN_OUT_FAILED');
  assert.equal(before.after.authError.code, 'AUTH_SIGN_OUT_FAILED');
  assert.equal(before.after.isIdentityTransitioning, false);
});

// ===========================================================================
// AUTH-15 signOut 失败（存储 UNAVAILABLE）：保留会话 + 显式错误
// ===========================================================================
test('P14R3-AUTH-15 signOut 后存储 UNAVAILABLE → 保留会话 + 显式错误', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
state.signOutImpl = () => {
  state.storageFailure = { code: 'UNAVAILABLE', message: 'delete failed' };
  return Promise.resolve({ error: null });
};
const result = await m.ctx.signOut();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, result, after: snapAuth(m) }));
`;
  const { before } = assertEqualBoth(body, 'signOut 存储 UNAVAILABLE');
  assert.equal(before.result.error.code, 'UNAVAILABLE');
  assert.equal(before.result.error.message, '安全存储删除失败，登出未完成');
  assert.equal(before.after.user.id, 'u1', '存储删除失败不得清空 user');
  assert.equal(before.after.authEpoch, before.signedIn.authEpoch, '存储删除失败不得推进 epoch');
  assert.equal(before.after.signOutError.code, 'UNAVAILABLE');
});

// ===========================================================================
// AUTH-16 自动刷新生命周期：AppState active/background 驱动 start/stop，卸载清理
// ===========================================================================
test('P14R3-AUTH-16 自动刷新生命周期（AppState 驱动 + 卸载清理）', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
const listenersAfterMount = AppState.__listenerCount();
AppState.__emit('background');
await drain();
AppState.__emit('active');
await drain();
const logBeforeUnmount = autoRefresh();
m.unmount();
await drain();
process.stdout.write(JSON.stringify({
  listenersAfterMount,
  logBeforeUnmount,
  listenersAfterUnmount: AppState.__listenerCount(),
}));
`;
  const { before } = assertEqualBoth(body, '自动刷新生命周期');
  assert.equal(before.listenersAfterMount, 1, '必须只注册一个 AppState 监听器');
  assert.ok(before.logBeforeUnmount.includes('start'), 'active 必须 startAutoRefresh');
  assert.ok(before.logBeforeUnmount.includes('stop'), 'background 必须 stopAutoRefresh');
  assert.equal(before.listenersAfterUnmount, 0, '卸载必须移除 AppState 监听器');
});

// ===========================================================================
// AUTH-17 公开接口形状与 Context 默认值（createContext 无默认值 → undefined）
// ===========================================================================
test('P14R3-AUTH-17 公开接口形状 + Context 无默认值', () => {
  // 注意：必须在任何 mountAuth() 之前检查「无 Provider」语义，
  // 否则 mountAuth 的 publish() 已把 value 写入共享 __ctx 容器，
  // 后续裸消费者会读到陈旧 value（测试运行时语义，非源码行为）。
  const body = `${AUTH_PRELUDE}
resetState();
// 先检查无 Provider 时 useAuth() 必须返回 undefined（createContext() 无默认值）
const bareRt = createHookRuntime();
let bareValue;
bareRt.render(() => { bareValue = useAuth(); });
const bareIsUndefined = bareValue === undefined;
// 再挂载 Provider 检查公开接口形状
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  snap: snapAuth(m),
  bareIsUndefined,
  exports: { AuthProvider: typeof AuthProvider, useAuth: typeof useAuth },
}));
`;
  const { before } = assertEqualBoth(body, '公开接口形状');
  assert.deepEqual(before.snap.keys, [
    'authEpoch',
    'authError',
    'isAuthLoading',
    'isIdentityTransitioning',
    'ownerId',
    'retrySession',
    'session',
    'signIn',
    'signOut',
    'signOutError',
    'signUp',
    'user',
  ]);
  assert.deepEqual(before.snap.fnTypes, {
    retrySession: 'function',
    signIn: 'function',
    signUp: 'function',
    signOut: 'function',
  });
  assert.equal(before.bareIsUndefined, true, 'useAuth() 在 Provider 外必须返回 undefined');
  assert.deepEqual(before.exports, { AuthProvider: 'function', useAuth: 'function' });
});

// ===========================================================================
// AUTH-18 卸载清理：init 订阅 unsubscribe + 自动刷新 dispose
// ===========================================================================
test('P14R3-AUTH-18 卸载清理 → 订阅 unsubscribe', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
const listenersBefore = supabase.__listenerCount();
m.unmount();
await drain();
process.stdout.write(JSON.stringify({
  listenersBefore,
  listenersAfter: supabase.__listenerCount(),
  calls: calls(),
}));
`;
  const { before } = assertEqualBoth(body, '卸载清理');
  assert.equal(before.listenersBefore, 1);
  assert.equal(before.listenersAfter, 0, '卸载必须 unsubscribe 认证订阅');
  assert.ok(before.calls.some((c) => c[0] === 'unsubscribe'));
});

// ===========================================================================
// E. 故障注入敏感性验证
//    证明上述等价断言确实能检测出行为差异（非无条件通过）。
//    做法：把「迁移后源码」复制到临时目录并注入一处语义改动，
//    用同一段场景脚本执行，断言结果与未注入版本不同。
// ===========================================================================
function mutateAndCompare(body, mutate, label, rel = 'src/hooks/useAuth.js') {
  const dir = buildSandbox('after');
  const p = path.join(dir, rel);
  const original = fs.readFileSync(p, 'utf8');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `故障注入未生效（未匹配到目标代码）：${label}`);
  fs.writeFileSync(p, mutated);
  const injected = runInSandbox(dir, body);
  const clean = runInSandbox(buildSandbox('after'), body);
  assert.notDeepEqual(injected, clean, `故障注入未被检测到（断言可能过弱）：${label}`);
  return { injected, clean };
}

test('P14R3-SENS-1 故障注入：TOKEN_REFRESHED 也推进 epoch → 断言可检测', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
supabase.__emitAuth('TOKEN_REFRESHED', makeSession('u1', 'tok-2'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ signedIn, refreshed: snapAuth(m) }));
`;
  // 注入错误实现：把 isTokenRefresh 恒为 false（使 TOKEN_REFRESHED 被当作 token 轮换）。
  //   P1.4 R3 起该判定已提取到纯逻辑模块 identityTransitionLogic.ts，
  //   因此注入目标改为该模块（useAuth.tsx 通过它间接执行同一决策）。
  mutateAndCompare(
    body,
    (src) => src.replace("const isTokenRefresh = event === 'TOKEN_REFRESHED';", 'const isTokenRefresh = false;'),
    'TOKEN_REFRESHED 误推进 epoch',
    'src/hooks/auth/identityTransitionLogic.ts'
  );
});

test('P14R3-SENS-2 故障注入：owner 变化不登记下游 → 断言可检测', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m) }));
`;
  // 注入错误实现：owner 变化时不调用 setSignedUrlOwner
  mutateAndCompare(
    body,
    (src) => src.replace('setSignedUrlOwner(nextOwnerId);', 'void nextOwnerId;'),
    'owner 变化不登记 signedUrl'
  );
});

test('P14R3-SENS-3 故障注入：signOut 成功不清空 user → 断言可检测', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const result = await m.ctx.signOut();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ result, after: snapAuth(m) }));
`;
  // 注入错误实现：登出成功路径不 setUser(null)
  // 注意：匹配**转译后**文本（缩进为 16 空格，非源码 8 空格）。
  mutateAndCompare(
    body,
    (src) => src.replace('setSession(null);\n                setUser(null);', 'setSession(null);'),
    'signOut 成功不清空 user'
  );
});

test('P14R3-SENS-4 故障注入：去掉 signOut 重入锁 → 断言可检测', () => {
  // 设计说明（测试运行时正确性）：
  //   · signOutImpl 每次调用都返回一个**独立**的 pending Promise，resolver 收集到数组，
  //     因此无论重入锁是否存在，所有 signOut 调用都能被显式 resolve，
  //     不会出现「resolver 被覆盖导致某个 await 永不结算」的假失败。
  //   · 第二次 signOut() 不 await，只记录其 promise，避免在锁被移除时阻塞主流程。
  //   · 断言点：有锁时第二次调用立即返回 AUTH_SIGN_OUT_IN_PROGRESS 且 auth.signOut 只被调用 1 次；
  //     无锁时第二次调用真正进入实现 → auth.signOut 被调用 2 次 → 快照差异可被检出。
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const resolvers = [];
state.signOutImpl = () => new Promise((res) => { resolvers.push(res); });
const p1 = m.ctx.signOut();
await drain();
const p2 = m.ctx.signOut();
await drain();
const signOutCallCount = state.calls.filter((c) => c === 'auth.signOut').length;
resolvers.forEach((res) => res({ error: null }));
const first = await p1;
const second = await p2;
await drain();
m.sync();
process.stdout.write(JSON.stringify({ first, second, signOutCallCount, after: snapAuth(m) }));
`;
  // 注入错误实现：去掉重入锁判断（只匹配 signOut 内部那一处，避免误伤 init Effect 的 CR-08 守卫）
  mutateAndCompare(
    body,
    (src) => src.replace("if (signOutInFlightRef.current) {\n                return { error: { code: 'AUTH_SIGN_OUT_IN_PROGRESS'", "if (false) {\n                return { error: { code: 'AUTH_SIGN_OUT_IN_PROGRESS'"),
    '去掉 signOut 重入锁'
  );
});

test('P14R3-SENS-5 故障注入：迟到 init 结果不校验序号 → 断言可检测', () => {
  const body = `${AUTH_PRELUDE}
resetState();
let resolveInit;
state.sessionImpl = () => new Promise((res) => { resolveInit = res; });
const m = mountAuth();
await drain();
supabase.__emitAuth('SIGNED_IN', makeSession('B', 'tok-b'));
await drain();
m.sync();
const afterEvent = snapAuth(m);
resolveInit({ data: { session: makeSession('A', 'tok-a') }, error: null });
await drain();
m.sync();
process.stdout.write(JSON.stringify({ afterEvent, afterLate: snapAuth(m) }));
`;
  // 注入错误实现：init then 分支去掉 isInitStale 守卫
  // 注意：匹配**转译后**文本（`if (isInitStale())` 与 `return;` 分行，缩进 16 空格）。
  mutateAndCompare(
    body,
    (src) => src.replace('if (isInitStale())\n                return;\n            if (error)', 'if (error)'),
    '迟到 init 结果不校验序号'
  );
});

// ===========================================================================
// P1.4 R3-FIX — Gatekeeper 发现的两处真实运行时差异回归测试
//   Work A：signOut 必须原样透传 SDK error 对象（引用 + 全部附加字段）
//   Work B：readErrField 必须保持 `e?.code` / `e?.message` 可选链语义
// ===========================================================================

// ---------------------------------------------------------------------------
// C1：signOut 返回 SDK error → 必须原样返回同一对象引用与全部字段
// ---------------------------------------------------------------------------
test('P14R3-FIX-C1 signOut 透传 SDK error 原始对象（引用 + status/name/detail）', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const signedIn = snapAuth(m);
// 构造带完整附加字段的 SDK 错误（模拟 AuthApiError）
const sdkError = {
  code: 'AUTH_SIGN_OUT_FAILED',
  message: 'network down',
  status: 503,
  name: 'AuthApiError',
  detail: 'retryable',
};
state.signOutImpl = () => Promise.resolve({ error: sdkError });
const result = await m.ctx.signOut();
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  signedIn,
  // 引用相等性：必须与注入的 sdkError 是同一个对象
  sameRef: result.error === sdkError,
  // 全部字段必须保留（含 SDK 附加字段）
  errorKeys: result.error ? Object.keys(result.error).sort() : null,
  errorCode: result.error ? result.error.code : null,
  errorMessage: result.error ? result.error.message : null,
  errorStatus: result.error ? result.error.status : null,
  errorName: result.error ? result.error.name : null,
  errorDetail: result.error ? result.error.detail : null,
  after: snapAuth(m),
}));
`;
  const { before, after } = assertEqualBoth(body, 'signOut 透传 SDK error 原始对象');

  // 新旧实现必须都满足「原样透传」语义
  for (const [label, r] of [['before', before], ['after', after]]) {
    assert.equal(r.sameRef, true, `${label}: result.error 必须是注入的同一对象引用`);
    assert.equal(r.errorCode, 'AUTH_SIGN_OUT_FAILED', `${label}: code 必须保留`);
    assert.equal(r.errorMessage, 'network down', `${label}: message 必须保留`);
    assert.equal(r.errorStatus, 503, `${label}: status 附加字段必须保留`);
    assert.equal(r.errorName, 'AuthApiError', `${label}: name 附加字段必须保留`);
    assert.equal(r.errorDetail, 'retryable', `${label}: detail 附加字段必须保留`);
    assert.deepEqual(
      r.errorKeys,
      ['code', 'detail', 'message', 'name', 'status'],
      `${label}: 不得克隆/重建/删字段`
    );
    // 状态与身份不变量
    assert.equal(r.after.user.id, 'u1', `${label}: 登出失败不得清空 user`);
    assert.equal(r.after.ownerId, 'u1', `${label}: owner 不得变化`);
    assert.equal(r.after.authEpoch, r.signedIn.authEpoch, `${label}: 不得推进 epoch`);
    assert.deepEqual(r.after.owner, r.signedIn.owner, `${label}: 下游 owner 不得变化`);
    assert.equal(r.after.signOutError.code, 'AUTH_SIGN_OUT_FAILED', `${label}: signOutError 仍写入规范化 failure`);
    assert.equal(r.after.authError.code, 'AUTH_SIGN_OUT_FAILED', `${label}: authError 仍写入规范化 failure`);
    assert.equal(r.after.isIdentityTransitioning, false, `${label}: finally 必须复位过渡态`);
  }
});

// ---------------------------------------------------------------------------
// C2：getSession 拒绝一个「函数对象」（带 code/message）→ 必须能读到错误码
// ---------------------------------------------------------------------------
test('P14R3-FIX-C2 函数对象异常 → readErrField 必须读取 code/message', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const err = function codedRejection() {};
err.code = 'FUNCTION_ERROR_CODE';
err.message = 'function error message';
state.sessionImpl = () => Promise.reject(err);
const m = mountAuth();
await drain();
m.sync();
const failed = snapAuth(m);
// 后续合法状态恢复能力：再派发 SIGNED_IN，必须能正常进入已登录态
supabase.__emitAuth('SIGNED_IN', makeSession('u2', 'tok-2'));
await drain();
m.sync();
process.stdout.write(JSON.stringify({ failed, recovered: snapAuth(m) }));
`;
  const { before, after } = assertEqualBoth(body, '函数对象异常');

  for (const [label, r] of [['before', before], ['after', after]]) {
    assert.equal(r.failed.authError.code, 'FUNCTION_ERROR_CODE', `${label}: 必须读取函数对象上的 code`);
    assert.equal(r.failed.authError.message, 'function error message', `${label}: 必须读取函数对象上的 message`);
    assert.equal(r.failed.isAuthLoading, false, `${label}: 失败后不得停留在 loading`);
    assert.equal(r.failed.user, null, `${label}: 失败态不得有 user`);
    // 恢复能力
    assert.equal(r.recovered.user.id, 'u2', `${label}: 后续合法事件必须能恢复登录态`);
    assert.equal(r.recovered.authError, null, `${label}: 恢复后 authError 必须清空`);
  }
});

// ---------------------------------------------------------------------------
// C3：其他异常边界（普通 Error / 无 code / null / undefined / 自定义 getter / Proxy）
// ---------------------------------------------------------------------------
test('P14R3-FIX-C3a 普通 Error 实例（带 code）→ 读取 code/message', () => {
  const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.reject(Object.assign(new Error('plain boom'), { code: 'PLAIN_CODE' }));
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m) }));
`;
  const { before, after } = assertEqualBoth(body, '普通 Error 实例');
  for (const [label, r] of [['before', before], ['after', after]]) {
    assert.equal(r.snap.authError.code, 'PLAIN_CODE', `${label}: 必须读取 Error 上的 code`);
    assert.equal(r.snap.authError.message, 'plain boom', `${label}: 必须读取 Error.message`);
  }
});

test('P14R3-FIX-C3b 无 code 的 Error → code 走默认值、message 保留', () => {
  const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.reject(new Error('no code here'));
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m) }));
`;
  const { before, after } = assertEqualBoth(body, '无 code 的 Error');
  for (const [label, r] of [['before', before], ['after', after]]) {
    assert.equal(r.snap.authError.code, 'AUTH_SESSION_RESTORE_FAILED', `${label}: 无 code 时必须走默认错误码`);
    assert.equal(r.snap.authError.message, 'no code here', `${label}: message 必须保留`);
  }
});

test('P14R3-FIX-C3c reject null / undefined → 走默认错误码且不抛异常', () => {
  for (const [tag, expr] of [['null', 'null'], ['undefined', 'undefined']]) {
    const body = `${AUTH_PRELUDE}
resetState();
state.sessionImpl = () => Promise.reject(${expr});
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m) }));
`;
    const { before, after } = assertEqualBoth(body, `reject ${tag}`);
    for (const [label, r] of [['before', before], ['after', after]]) {
      assert.equal(r.snap.authError.code, 'AUTH_SESSION_RESTORE_FAILED', `${label}/${tag}: 必须走默认错误码`);
      assert.equal(r.snap.isAuthLoading, false, `${label}/${tag}: 不得停留在 loading`);
    }
  }
});

test('P14R3-FIX-C3d 自定义 getter 错误对象 → getter 读取次数与顺序不变', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const reads = [];
const getterErr = {};
Object.defineProperty(getterErr, 'code', {
  get() { reads.push('code'); return 'GETTER_CODE'; },
  enumerable: true,
});
Object.defineProperty(getterErr, 'message', {
  get() { reads.push('message'); return 'getter message'; },
  enumerable: true,
});
state.sessionImpl = () => Promise.reject(getterErr);
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ reads, snap: snapAuth(m) }));
`;
  const { before, after } = assertEqualBoth(body, '自定义 getter 错误对象');
  for (const [label, r] of [['before', before], ['after', after]]) {
    assert.equal(r.snap.authError.code, 'GETTER_CODE', `${label}: 必须读取 getter code`);
    assert.equal(r.snap.authError.message, 'getter message', `${label}: 必须读取 getter message`);
  }
  // getter 读取次数与顺序必须完全一致（不得因 typeof/in 判断而多读或少读）
  assert.deepEqual(after.reads, before.reads, 'getter 读取次数与顺序必须与迁移前一致');
});

test('P14R3-FIX-C3e Proxy 错误对象 → 不得引入原 JS 不存在的 has trap 行为', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const traps = [];
const target = { code: 'PROXY_CODE', message: 'proxy message' };
const proxyErr = new Proxy(target, {
  has(t, k) { traps.push('has:' + String(k)); return Reflect.has(t, k); },
  get(t, k, r) { traps.push('get:' + String(k)); return Reflect.get(t, k, r); },
});
state.sessionImpl = () => Promise.reject(proxyErr);
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ traps, snap: snapAuth(m) }));
`;
  const { before, after } = assertEqualBoth(body, 'Proxy 错误对象');
  for (const [label, r] of [['before', before], ['after', after]]) {
    assert.equal(r.snap.authError.code, 'PROXY_CODE', `${label}: 必须读取 Proxy code`);
    assert.equal(r.snap.authError.message, 'proxy message', `${label}: 必须读取 Proxy message`);
  }
  // 关键：迁移前 JS 只做属性读取，不触发 has trap。修复后必须同样不触发。
  assert.deepEqual(
    after.traps.filter((t) => t.startsWith('has:')),
    before.traps.filter((t) => t.startsWith('has:')),
    'Proxy has trap 触发情况必须与迁移前一致'
  );
  assert.deepEqual(after.traps, before.traps, 'Proxy trap 序列必须与迁移前完全一致');
});

// ---------------------------------------------------------------------------
// C4：故障注入 —— 证明新增断言能检出两种错误实现
// ---------------------------------------------------------------------------
test('P14R3-FIX-C4a 故障注入：signOut 返回规范化 failure 而非原始 error → 可检出', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const m = mountAuth();
await drain();
m.sync();
supabase.__emitAuth('SIGNED_IN', makeSession('u1', 'tok-1'));
await drain();
m.sync();
const sdkError = { code: 'AUTH_SIGN_OUT_FAILED', message: 'network down', status: 503, name: 'AuthApiError', detail: 'retryable' };
state.signOutImpl = () => Promise.resolve({ error: sdkError });
const result = await m.ctx.signOut();
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  sameRef: result.error === sdkError,
  errorKeys: result.error ? Object.keys(result.error).sort() : null,
  errorStatus: result.error ? result.error.status : null,
  errorName: result.error ? result.error.name : null,
  errorDetail: result.error ? result.error.detail : null,
}));
`;
  // 注入错误实现：恢复成 `return { error: failure }`（克隆/重建，丢失引用与附加字段）
  // ⚠️ 匹配**转译后**文本：TypeScript 的 `as unknown as AuthErrorLike` 在转译时被擦除，
  //    沙箱中的实际代码是 `return { error: error };`。
  mutateAndCompare(
    body,
    (src) => src.replace('return { error: error };', 'return { error: failure };'),
    'signOut 返回规范化 failure 而非原始 error'
  );
});

test('P14R3-FIX-C4b 故障注入：readErrField 加回 typeof/in 判断 → 可检出', () => {
  const body = `${AUTH_PRELUDE}
resetState();
const err = function codedRejection() {};
err.code = 'FUNCTION_ERROR_CODE';
err.message = 'function error message';
state.sessionImpl = () => Promise.reject(err);
const m = mountAuth();
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapAuth(m) }));
`;
  // 注入错误实现：恢复成 `typeof e === 'object' && key in e`（排除函数对象）
  // ⚠️ 匹配**转译后**文本：类型断言被擦除，沙箱中的实际代码是 `return e?.[key];`。
  mutateAndCompare(
    body,
    (src) =>
      src.replace(
        'return e?.[key];',
        "if (e && typeof e === 'object' && key in e) {\n    return e[key];\n  }\n  return undefined;"
      ),
    'readErrField 加回 typeof/in 判断'
  );
});

// --- END OF FILE tests/security/p14r3AuthMigrationEquivalence.test.mjs ---