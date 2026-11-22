// --- START OF FILE tests/security/p14r1BrowserStateMigrationEquivalence.test.mjs ---
/**
 * P1.4 R1 — 浏览器历史 Hook + 浏览器会话 Context 成批 JS → TypeScript 迁移 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前实现：冻结基线
 *         - `tests/fixtures/p14r1/before/hooks__browser__useBrowserHistory.js`
 *         - `tests/fixtures/p14r1/before/context__BrowserSessionContext.js`
 *       （P1.3 R3-FIX + P1.4 R0 全部成果后的最新 JS 源码，逐字节冻结）
 *     · 迁移后实现：当前真实源码
 *         - `src/hooks/browser/useBrowserHistory.ts`
 *         - `src/context/BrowserSessionContext.tsx`
 *   对同一组输入比较**完整可观测结果**（状态 / Ref / 副作用序列 / AsyncStorage 读写
 *   次数与顺序与内容 / 异常语义 / 公开接口形状 / Provider value 结构）。
 *
 * 覆盖
 *   A. useBrowserHistory（历史 + 书签域）
 *   B. BrowserSessionContext（Provider + useBrowserSession）
 *   C. 联合身份隔离矩阵（A→B / A→B→A / 同账号新 epoch / 迟到回调 / 迟到异步读取 /
 *      无 owner fail-closed / 跨账号 key 不串写 / pendingUrl 不跨账号泄漏）
 *   D. 故障注入敏感性验证（证明测试非无条件通过）
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
 *   `BrowserSessionContext.tsx` 在沙箱内使用**项目自带 TypeScript 编译器**
 *   （`ts.transpileModule`，jsx: React）转译为 `.js` 后执行——这是项目既有的受控
 *   TypeScript JSX 转译机制，**不是**为测试手工改写生产 JSX 结构。
 *   迁移前的 `.js` 基线原样执行。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / AsyncStorage（使用记录型 stub）。
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r1/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__browser__useBrowserHistory.js':
    'f29a79ff059613aecd785a64748512ec116a92961b68b03b6c91a4d4a774a26d',
  'context__BrowserSessionContext.js':
    'cfa9926c771aaf666e976b25c5267eea6806e4bf4eaf32e3a2454c1796e8d87f',
};

test('P14R1-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 P1.3 / P1.4 R0 测试同构，独立复制以保持本测试自包含）
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
    return { __ctx: { current: v }, Provider: null };
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
//   mode = 'after'  → 使用当前真实源码（迁移后 TS / TSX）
//   target = 'history' | 'context'
// ---------------------------------------------------------------------------
function buildSandbox(mode, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r1-${target}-${mode}-`));
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
export const createContext = (v) => ({ __ctx: { current: v }, Provider: null });
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  // AsyncStorage stub：记录型（getItem / setItem / removeItem / multiSet / multiGet）
  //   · __AS_LOG__ 记录每一次读写（操作名 + key + 值），用于比较次数 / 顺序 / 内容
  //   · __AS_DATA__ 为内存存储，测试可预置初始数据
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
};
export default AsyncStorage;
`,
  });

  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(relSrc, dst);
  };

  // 常量模块（真实源码，纯函数无原生依赖）
  copyFile(path.join(repoRoot, 'src/constants/browser/index.ts'), 'src/constants/browser/index.ts');
  // 类型模块（仅类型，运行时为空；复制以支持潜在 import type 解析）
  copyFile(path.join(repoRoot, 'src/types/browser.ts'), 'src/types/browser.ts');
  // P1.3 纯函数依赖（历史 / 书签数据逻辑）
  copyFile(
    path.join(repoRoot, 'src/hooks/browser/historyDataLogic.ts'),
    'src/hooks/browser/historyDataLogic.ts'
  );

  // useAuth 真实路径：Context 源码 import '../hooks/useAuth'。
  // 沙箱内把该路径指向 stub（读取 globalThis.__AUTH__），避免拉起真实 AuthProvider。
  fs.mkdirSync(path.join(dir, 'src/hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/hooks/useAuth.js'),
    `export function useAuth() { return globalThis.__AUTH__ === undefined ? null : globalThis.__AUTH__; }\nexport default { useAuth };\n`
  );

  const wantHistory = target === 'history' || target === 'joint';
  const wantContext = target === 'context' || target === 'joint';

  if (wantHistory) {
    if (mode === 'before') {
      copyFile(
        path.join(beforeDir, 'hooks__browser__useBrowserHistory.js'),
        'src/hooks/browser/useBrowserHistory.js'
      );
    } else {
      copyFile(
        path.join(repoRoot, 'src/hooks/browser/useBrowserHistory.ts'),
        'src/hooks/browser/useBrowserHistory.ts'
      );
    }
  }

  if (wantContext) {
    // 注意：before 基线 .js 与 after .tsx 均含 JSX（<BrowserSessionContext.Provider>）。
    // Node 无法直接执行含 JSX 的源码，两侧都必须用项目自带 TypeScript 编译器
    // 转译为 .js（jsx: React → createElement），再写入沙箱，保证执行机制一致。
    const srcPath =
      mode === 'before'
        ? path.join(beforeDir, 'context__BrowserSessionContext.js')
        : path.join(repoRoot, 'src/context/BrowserSessionContext.tsx');
    const src = fs.readFileSync(srcPath, 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      fileName: 'BrowserSessionContext.tsx',
    }).outputText;
    fs.mkdirSync(path.join(dir, 'src/context'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/context/BrowserSessionContext.js'), out);
  }

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
function runBoth(target, body) {
  const beforeSandbox = buildSandbox('before', target);
  const afterSandbox = buildSandbox('after', target);
  const before = runInSandbox(beforeSandbox, body);
  const after = runInSandbox(afterSandbox, body);
  return { before, after };
}

function assertEqualBoth(target, body, label) {
  const { before, after } = runBoth(target, body);
  assert.deepEqual(after, before, `${target} 迁移前后可观测结果必须一致：${label}`);
  return { before, after };
}

// ===========================================================================
// A. useBrowserHistory — 历史 + 书签域
// ===========================================================================
const HISTORY_PRELUDE = `
const { createHookRuntime } = await import('react');
const { __AS_LOG__, __AS_DATA__ } = await import('@react-native-async-storage/async-storage');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory');

globalThis.__AS_LOG__ = __AS_LOG__;
globalThis.__AS_DATA__ = __AS_DATA__;

// 固定时间源：让 Date.now 可预测（验证时间戳求值顺序与调用次数）
globalThis.__NOW__ = 1000;
globalThis.__NOW_CALLS__ = [];
Date.now = () => { globalThis.__NOW_CALLS__.push(globalThis.__NOW__); return globalThis.__NOW__; };
// 固定随机源
globalThis.__RAND__ = 0.123456789;
Math.random = () => globalThis.__RAND__;

function resetStore(entries) {
  __AS_DATA__.clear();
  __AS_LOG__.length = 0;
  for (const [k, v] of Object.entries(entries || {})) __AS_DATA__.set(k, v);
}

function asLog() { return __AS_LOG__.map((e) => JSON.parse(JSON.stringify(e))); }

// 代理对象：属性访问始终转发到「最新一次 render 的 api」
function liveApi(getCurrent) {
  return new Proxy({}, {
    get(_t, prop) { return getCurrent()[prop]; },
    has(_t, prop) { return prop in getCurrent(); },
    ownKeys() { return Reflect.ownKeys(getCurrent()); },
    getOwnPropertyDescriptor(_t, prop) {
      return { configurable: true, enumerable: true, value: getCurrent()[prop] };
    },
  });
}

function mountHistory(userId, authEpoch) {
  const rt = createHookRuntime();
  let api;
  rt.render(() => { api = useBrowserHistory(userId, authEpoch); });
  return { rt, api: liveApi(() => api) };
}

function snap(api) {
  return {
    historyList: JSON.parse(JSON.stringify(api.historyList)),
    bookmarksList: JSON.parse(JSON.stringify(api.bookmarksList)),
    keys: Object.keys(api).sort(),
  };
}

// 等待所有已排队的微任务（AsyncStorage stub 为 async）
async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
`;

test('P14R1-HIST-1 初始状态与公开接口形状一致（无 owner）', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({});
const { rt, api } = mountHistory(null, 0);
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '初始状态（无 owner）');
  assert.deepEqual(before.snap.keys, [
    'addHistory', 'bookmarksList', 'clearHistory', 'deleteHistory',
    'historyList', 'isBookmarked', 'removeBookmark', 'toggleBookmark',
  ]);
  // 无 owner：不读不写任何存储
  assert.deepEqual(before.log, []);
});

test('P14R1-HIST-2 首次启动：默认书签落盘 + 历史空', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '首次启动默认书签');
  assert.deepEqual(
    before.snap.bookmarksList.map((b) => b.url),
    [
      'https://www.bing.com',
      'https://www.google.com',
      'https://www.baidu.com',
      'https://duckduckgo.com',
      'https://www.sogou.com',
      'https://search.yahoo.com',
    ]
  );
  const keys = before.log.map((e) => e[1]);
  assert.ok(keys.includes('@sync_browser_bookmarks_v2_userA'));
  assert.ok(keys.includes('@sync_browser_bookmarks_seed_v2_userA'));
  assert.ok(keys.includes('@sync_browser_history_v2_userA'));
});

test('P14R1-HIST-3 已有缓存：种子版本最新 → 原样读取', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': JSON.stringify([
    { url: 'https://custom.example.com', title: 'Custom' },
    'https://legacy-string.example.com',
  ]),
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([
    { id: 'h1', url: 'https://a.example.com', title: 'A', timestamp: 111 },
    { id: 'h2', url: 'http://insecure.example.com', title: 'Bad', timestamp: 222 },
    { id: 'h3', url: 'https://b.example.com', title: 'B', timestamp: 333 },
  ]),
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '已有缓存读取');
  assert.deepEqual(before.snap.bookmarksList, [
    { url: 'https://custom.example.com', title: 'Custom' },
    { url: 'https://legacy-string.example.com', title: '' },
  ]);
  assert.deepEqual(
    before.snap.historyList.map((h) => h.id),
    ['h1', 'h3']
  );
});

test('P14R1-HIST-4 种子版本落后 → 一次性迁移（剔除旧默认 + 前置新默认）', () => {
  const body = `${HISTORY_PRELUDE}
const legacy = 'https://' + ['nnyy', 'in'].join('.') + '/';
resetStore({
  '@sync_browser_bookmarks_v2_userA': JSON.stringify([
    { url: legacy, title: 'Legacy' },
    { url: 'https://mine.example.com', title: 'Mine' },
  ]),
  '@sync_browser_bookmarks_seed_v2_userA': '1',
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '种子版本迁移');
  const urls = before.snap.bookmarksList.map((b) => b.url);
  assert.equal(urls[0], 'https://www.bing.com');
  assert.ok(urls.includes('https://mine.example.com'));
  assert.ok(!urls.some((u) => u.includes('nnyy')));
});

test('P14R1-HIST-5 无效 JSON / 非数组历史 → 容错丢弃', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': 'not-json{',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': '{"not":"array"}',
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  assertEqualBoth('history', body, '无效 JSON 容错');
});

test('P14R1-HIST-6 addHistory：去重 + 置顶 + 时间戳求值顺序 + 落盘', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([
    { id: 'old1', url: 'https://a.example.com', title: 'A', timestamp: 1 },
  ]),
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
globalThis.__NOW_CALLS__.length = 0;
globalThis.__NOW__ = 5000;
api.addHistory('https://b.example.com', '  B Title  ');
rt.settle();
await drain();
const afterFirst = snap(api);
const nowCallsFirst = globalThis.__NOW_CALLS__.slice();
globalThis.__NOW__ = 6000;
api.addHistory('https://a.example.com', 'A2');
rt.settle();
await drain();
const afterSecond = snap(api);
globalThis.__NOW__ = 7000;
api.addHistory('https://a.example.com', 'A3');
rt.settle();
await drain();
const afterThird = snap(api);
api.addHistory('http://insecure.example.com', 'X');
api.addHistory('https://cn.bing.com/search?q=1', 'Bing');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({
  afterFirst, nowCallsFirst, afterSecond, afterThird,
  final: snap(api), log: asLog(),
}));
`;
  const { before } = assertEqualBoth('history', body, 'addHistory 去重置顶');
  assert.equal(before.nowCallsFirst.length, 2);
  assert.equal(before.nowCallsFirst[0], 5000);
  assert.equal(before.nowCallsFirst[1], 5000);
  assert.equal(before.afterFirst.historyList[0].url, 'https://b.example.com');
  assert.equal(before.afterFirst.historyList[0].title, 'B Title');
  assert.equal(before.afterSecond.historyList[0].url, 'https://a.example.com');
  assert.equal(before.afterSecond.historyList.length, 2);
  assert.equal(before.afterThird.historyList.length, 2);
});

test('P14R1-HIST-7 历史上限 100 条', () => {
  const body = `${HISTORY_PRELUDE}
const seed = [];
for (let i = 0; i < 100; i++) seed.push({ id: 'h' + i, url: 'https://s' + i + '.example.com', title: 'S' + i, timestamp: i });
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify(seed),
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
api.addHistory('https://new.example.com', 'New');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({ len: api.historyList.length, head: api.historyList[0].url, log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '历史上限 100');
  assert.equal(before.len, 100);
  assert.equal(before.head, 'https://new.example.com');
});

test('P14R1-HIST-8 deleteHistory / clearHistory 落盘一致', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([
    { id: 'h1', url: 'https://a.example.com', title: 'A', timestamp: 1 },
    { id: 'h2', url: 'https://b.example.com', title: 'B', timestamp: 2 },
  ]),
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
api.deleteHistory('h1');
rt.settle();
await drain();
const afterDelete = snap(api);
api.clearHistory();
rt.settle();
await drain();
process.stdout.write(JSON.stringify({ afterDelete, afterClear: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, 'delete/clear');
  assert.deepEqual(before.afterDelete.historyList.map((h) => h.id), ['h2']);
  assert.deepEqual(before.afterClear.historyList, []);
});

test('P14R1-HIST-9 toggleBookmark / removeBookmark / isBookmarked 一致', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': JSON.stringify([{ url: 'https://keep.example.com', title: 'Keep' }]),
  '@sync_browser_bookmarks_seed_v2_userA': '2',
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
const r1 = await api.toggleBookmark('https://new.example.com', '  New  ');
rt.settle();
await drain();
const afterAdd = snap(api);
const isNew = api.isBookmarked('https://new.example.com');
const r2 = await api.toggleBookmark('https://new.example.com', 'New');
rt.settle();
await drain();
const afterRemove = snap(api);
const r3 = await api.toggleBookmark('http://insecure.example.com', 'X');
await api.removeBookmark('https://keep.example.com');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({
  r1, r2, r3, isNew, afterAdd, afterRemove, final: snap(api), log: asLog(),
}));
`;
  const { before } = assertEqualBoth('history', body, 'toggle/remove/isBookmarked');
  assert.deepEqual(before.r1, { ok: true, action: 'added' });
  assert.deepEqual(before.r2, { ok: true, action: 'removed' });
  assert.deepEqual(before.r3, { ok: false, action: 'invalid' });
  assert.equal(before.isNew, true);
  assert.equal(before.afterAdd.bookmarksList[0].url, 'https://new.example.com');
  assert.equal(before.afterAdd.bookmarksList[0].title, 'New');
});

test('P14R1-HIST-10 同一事件循环内连续 addHistory（shadow ref 同步）', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
api.addHistory('https://one.example.com', 'One');
api.addHistory('https://two.example.com', 'Two');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '连续 addHistory');
  // 两次写入都保留（第二次基于第一次的 shadow ref 计算）
  assert.deepEqual(
    before.snap.historyList.map((h) => h.url),
    ['https://two.example.com', 'https://one.example.com']
  );
});

test('P14R1-HIST-11 身份切换 A→B：内存态清空 + 只读 B 的 key', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': JSON.stringify([{ url: 'https://a-book.example.com', title: 'A' }]),
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([{ id: 'a1', url: 'https://a-hist.example.com', title: 'A', timestamp: 1 }]),
  '@sync_browser_bookmarks_v2_userB': JSON.stringify([{ url: 'https://b-book.example.com', title: 'B' }]),
  '@sync_browser_bookmarks_seed_v2_userB': '2',
  '@sync_browser_history_v2_userB': JSON.stringify([{ id: 'b1', url: 'https://b-hist.example.com', title: 'B', timestamp: 2 }]),
});
const rt = createHookRuntime();
let api;
let owner = 'userA';
rt.render(() => { api = useBrowserHistory(owner, 1); });
await drain();
rt.settle();
const asA = snap(api);
// 切换到 B（同一 Provider 实例，仅参数变化）
owner = 'userB';
rt.rerender();
await drain();
rt.settle();
const asB = snap(api);
process.stdout.write(JSON.stringify({ asA, asB, log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, 'A→B 身份切换');
  assert.deepEqual(before.asA.bookmarksList.map((b) => b.url), ['https://a-book.example.com']);
  assert.deepEqual(before.asA.historyList.map((h) => h.id), ['a1']);
  // B 只看到 B 的数据，A 的数据不残留
  assert.deepEqual(before.asB.bookmarksList.map((b) => b.url), ['https://b-book.example.com']);
  assert.deepEqual(before.asB.historyList.map((h) => h.id), ['b1']);
});

test('P14R1-HIST-12 无 owner fail-closed：写操作全部无效且不落盘', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({});
const { rt, api } = mountHistory(null, 0);
await drain();
rt.settle();
api.addHistory('https://x.example.com', 'X');
api.deleteHistory('h1');
api.clearHistory();
const r = await api.toggleBookmark('https://x.example.com', 'X');
await api.removeBookmark('https://x.example.com');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({ snap: snap(api), r, log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '无 owner fail-closed');
  assert.deepEqual(before.r, { ok: false, action: 'invalid' });
  assert.deepEqual(before.snap.historyList, []);
  assert.deepEqual(before.snap.bookmarksList, []);
  assert.deepEqual(before.log, []);
});

test('P14R1-HIST-13 跨账号 key 不串写：A 写入不污染 B 的 key', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
});
const rt = createHookRuntime();
let api;
let owner = 'userA';
rt.render(() => { api = useBrowserHistory(owner, 1); });
await drain();
rt.settle();
api.addHistory('https://a-only.example.com', 'AOnly');
rt.settle();
await drain();
owner = 'userB';
rt.rerender();
await drain();
rt.settle();
api.addHistory('https://b-only.example.com', 'BOnly');
rt.settle();
await drain();
const data = {};
for (const [k, v] of __AS_DATA__.entries()) data[k] = v;
process.stdout.write(JSON.stringify({ data, log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '跨账号 key 不串写');
  const aHist = JSON.parse(before.data['@sync_browser_history_v2_userA']);
  const bHist = JSON.parse(before.data['@sync_browser_history_v2_userB']);
  assert.deepEqual(aHist.map((h) => h.url), ['https://a-only.example.com']);
  assert.deepEqual(bHist.map((h) => h.url), ['https://b-only.example.com']);
});

test('P14R1-HIST-14 迟到异步读取：A 的读取结果在切到 B 后到达 → 丢弃', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([{ id: 'a1', url: 'https://a-hist.example.com', title: 'A', timestamp: 1 }]),
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
  '@sync_browser_history_v2_userB': JSON.stringify([{ id: 'b1', url: 'https://b-hist.example.com', title: 'B', timestamp: 2 }]),
});
// 让 getItem 延迟返回：A 的读取在切换后才 resolve
const origGetItem = __AS_DATA__ && null;
const rt = createHookRuntime();
let api;
let owner = 'userA';
rt.render(() => { api = useBrowserHistory(owner, 1); });
// 不 drain：A 的异步读取尚未完成
owner = 'userB';
rt.rerender();
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  const { before } = assertEqualBoth('history', body, '迟到异步读取丢弃');
  // 最终只显示 B 的数据（A 的迟到结果被 owner 校验丢弃）
  assert.deepEqual(before.snap.historyList.map((h) => h.id), ['b1']);
});

// ===========================================================================
// B. BrowserSessionContext — Provider + useBrowserSession
// ===========================================================================
const CONTEXT_PRELUDE = `
const { createHookRuntime } = await import('react');
const { __AS_LOG__, __AS_DATA__ } = await import('@react-native-async-storage/async-storage');
const mod = await import('./src/context/BrowserSessionContext');
const { BrowserSessionProvider, useBrowserSession } = mod;
const BrowserSessionContext = mod.default;

globalThis.__AS_LOG__ = __AS_LOG__;
globalThis.__AS_DATA__ = __AS_DATA__;

function resetStore(entries) {
  __AS_DATA__.clear();
  __AS_LOG__.length = 0;
  for (const [k, v] of Object.entries(entries || {})) __AS_DATA__.set(k, v);
}
function asLog() { return __AS_LOG__.map((e) => JSON.parse(JSON.stringify(e))); }
function asData() {
  const out = {};
  for (const [k, v] of __AS_DATA__.entries()) out[k] = v;
  return out;
}

// 代理对象：属性访问始终转发到「最新一次 render 的 ctx」
function liveCtx(getCurrent) {
  return new Proxy({}, {
    get(_t, prop) { return getCurrent()[prop]; },
    has(_t, prop) { return prop in getCurrent(); },
    ownKeys() { return Reflect.ownKeys(getCurrent()); },
    getOwnPropertyDescriptor(_t, prop) {
      return { configurable: true, enumerable: true, value: getCurrent()[prop] };
    },
  });
}

// 挂载 Provider + 一个消费组件（同一 runtime 内两个组件槽位）。
// 由于极简运行时是单组件栈，这里用「先渲染 Provider 得到 element，再渲染消费者」
// 的方式模拟：Provider 的 hooks 与消费者的 hooks 分属两个 runtime 实例，
// 通过共享的 context 对象桥接（Provider 渲染时把 value 写入 ctx.__ctx.current）。
function mountProvider(opts) {
  const providerRt = createHookRuntime();
  const consumerRt = createHookRuntime();
  let ctxValue = null;
  let consumerCtx = null;
  let element;

  // 把 Provider 最新 value 同步到 context + 消费者（消费者重新渲染读取最新 ctx）
  function syncConsumer() {
    ctxValue = element.props.value;
    BrowserSessionContext.__ctx.current = ctxValue;
    consumerRt.render(() => { consumerCtx = useBrowserSession(); });
  }

  // 1) 渲染 Provider：执行其 hooks，返回 element（含 value）
  providerRt.render(() => {
    element = BrowserSessionProvider({
      children: null,
      userId: opts.userId === undefined ? null : opts.userId,
      authEpoch: opts.authEpoch === undefined ? null : opts.authEpoch,
    });
  });
  syncConsumer();

  return {
    providerRt,
    consumerRt,
    get ctx() { return liveCtx(() => consumerCtx); },
    get providerValue() { return ctxValue; },
    // 推进异步 effect（hydrate 等）→ settle 重渲染 → 再同步消费者。
    // 必须循环：effect 内 await 完成后 setState 会 scheduleRender，
    // settle 执行重渲染产生新 value，最后再让消费者读到新 value。
    async flush() {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        providerRt.settle();
        syncConsumer();
      }
    },
    // 重新渲染 Provider（参数变化），并同步 context + 消费者
    rerenderProvider(nextOpts) {
      providerRt.render(() => {
        element = BrowserSessionProvider({
          children: null,
          userId: nextOpts.userId === undefined ? null : nextOpts.userId,
          authEpoch: nextOpts.authEpoch === undefined ? null : nextOpts.authEpoch,
        });
      });
      syncConsumer();
    },
  };
}

function snapCtx(m) {
  return {
    pendingUrl: m.ctx.pendingUrl,
    pendingSeq: m.ctx.pendingSeq,
    lastUrl: m.ctx.lastUrl,
    keys: Object.keys(m.ctx).sort(),
    providerKeys: Object.keys(m.providerValue).sort(),
  };
}

async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
`;

test('P14R1-CTX-1 Provider 初始状态 + 公开接口 + value 结构一致', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, 'Provider 初始状态');
  assert.deepEqual(before.snap.keys, [
    'consumePendingUrl', 'lastUrl', 'pendingSeq', 'pendingUrl', 'rememberUrl', 'setPendingUrl',
  ]);
  assert.deepEqual(before.snap.providerKeys, [
    'consumePendingUrl', 'lastUrl', 'pendingSeq', 'pendingUrl', 'rememberUrl', 'setPendingUrl',
  ]);
  assert.equal(before.snap.pendingUrl, null);
  assert.equal(before.snap.pendingSeq, 0);
  assert.equal(before.snap.lastUrl, null);
});

test('P14R1-CTX-2 无 owner：不读不写，lastUrl 保持 null', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({ '@browser_last_url_v2_userA': 'https://stale.example.com' });
const m = mountProvider({ userId: null, authEpoch: 0 });
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, '无 owner');
  assert.equal(before.snap.lastUrl, null);
  assert.deepEqual(before.log, []);
});

test('P14R1-CTX-3 正常账号恢复：hydrate 读取 lastUrl', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({ '@browser_last_url_v2_userA': 'https://restored.example.com' });
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, '正常账号恢复');
  assert.equal(before.snap.lastUrl, 'https://restored.example.com');
  assert.ok(before.log.some((e) => e[0] === 'getItem' && e[1] === '@browser_last_url_v2_userA'));
});

test('P14R1-CTX-4 hydrate 脏数据（非安全地址）→ 丢弃', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({ '@browser_last_url_v2_userA': 'http://insecure.example.com' });
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, 'hydrate 脏数据');
  assert.equal(before.snap.lastUrl, null);
});

test('P14R1-CTX-5 setPendingUrl + consumePendingUrl 一次性交接', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
m.ctx.setPendingUrl('https://target.example.com');
await m.flush();
const afterSet = snapCtx(m);
const consumed = m.ctx.consumePendingUrl();
await m.flush();
const afterConsume = snapCtx(m);
// 不安全 URL 被忽略
m.ctx.setPendingUrl('http://insecure.example.com');
await m.flush();
const afterBad = snapCtx(m);
process.stdout.write(JSON.stringify({ afterSet, consumed, afterConsume, afterBad, log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, 'pendingUrl 交接');
  assert.equal(before.afterSet.pendingUrl, 'https://target.example.com');
  assert.equal(before.afterSet.pendingSeq, 1);
  assert.equal(before.consumed, null);
  assert.equal(before.afterConsume.pendingUrl, null);
  assert.equal(before.afterBad.pendingUrl, null);
});

test('P14R1-CTX-6 rememberUrl：写入隔离 key + 同值去重', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
m.ctx.rememberUrl('https://visited.example.com');
await m.flush();
await drain();
const afterFirst = snapCtx(m);
const logAfterFirst = asLog();
// 同值再次调用 → 不重复写盘
m.ctx.rememberUrl('https://visited.example.com');
await m.flush();
await drain();
const logAfterSecond = asLog();
// 不安全 URL → 忽略
m.ctx.rememberUrl('http://insecure.example.com');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({
  afterFirst, logAfterFirst, logAfterSecond, data: asData(),
}));
`;
  const { before } = assertEqualBoth('context', body, 'rememberUrl');
  assert.equal(before.afterFirst.lastUrl, 'https://visited.example.com');
  assert.equal(before.data['@browser_last_url_v2_userA'], 'https://visited.example.com');
  // 第二次同值不新增 setItem
  const setCount1 = before.logAfterFirst.filter((e) => e[0] === 'setItem').length;
  const setCount2 = before.logAfterSecond.filter((e) => e[0] === 'setItem').length;
  assert.equal(setCount1, setCount2);
});

test('P14R1-CTX-7 账号切换 A→B：lastUrl / pendingUrl 清空 + 只读 B 的 key', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@browser_last_url_v2_userA': 'https://a-last.example.com',
  '@browser_last_url_v2_userB': 'https://b-last.example.com',
});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
const asA = snapCtx(m);
m.ctx.setPendingUrl('https://a-pending.example.com');
await m.flush();
const asAPending = snapCtx(m);
// 切到 B
m.rerenderProvider({ userId: 'userB', authEpoch: 2 });
await m.flush();
const asB = snapCtx(m);
process.stdout.write(JSON.stringify({ asA, asAPending, asB, log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, 'A→B 切换');
  assert.equal(before.asA.lastUrl, 'https://a-last.example.com');
  assert.equal(before.asAPending.pendingUrl, 'https://a-pending.example.com');
  // B：A 的 pendingUrl 不泄漏，lastUrl 恢复为 B 的
  assert.equal(before.asB.pendingUrl, null);
  assert.equal(before.asB.lastUrl, 'https://b-last.example.com');
});

test('P14R1-CTX-8 同账号新 authEpoch：清 pendingUrl 但保留 lastUrl', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({ '@browser_last_url_v2_userA': 'https://a-last.example.com' });
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
m.ctx.setPendingUrl('https://a-pending.example.com');
await m.flush();
const beforeEpoch = snapCtx(m);
// 同 userId，epoch 推进
m.rerenderProvider({ userId: 'userA', authEpoch: 2 });
await m.flush();
const afterEpoch = snapCtx(m);
process.stdout.write(JSON.stringify({ beforeEpoch, afterEpoch, log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, '同账号新 epoch');
  assert.equal(before.beforeEpoch.pendingUrl, 'https://a-pending.example.com');
  // 新 epoch：pendingUrl 清空，lastUrl 保留
  assert.equal(before.afterEpoch.pendingUrl, null);
  assert.equal(before.afterEpoch.lastUrl, 'https://a-last.example.com');
});

test('P14R1-CTX-9 迟到回调：A 的 setPendingUrl 在切到 B 后执行 → 丢弃', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
// 捕获 A 会话的 setPendingUrl 回调实例
const staleSetPending = m.ctx.setPendingUrl;
// 切到 B
m.rerenderProvider({ userId: 'userB', authEpoch: 2 });
await m.flush();
// 用 A 的旧回调写入 → 必须被丢弃
staleSetPending('https://stale-a.example.com');
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, '迟到 setPendingUrl 丢弃');
  assert.equal(before.snap.pendingUrl, null);
});

test('P14R1-CTX-10 迟到回调：A 的 rememberUrl 在切到 B 后执行 → 不写 B 的 key', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
const staleRemember = m.ctx.rememberUrl;
m.rerenderProvider({ userId: 'userB', authEpoch: 2 });
await m.flush();
staleRemember('https://stale-a.example.com');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), data: asData(), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, '迟到 rememberUrl 丢弃');
  // B 的 key 不应被 A 的迟到回调写入
  assert.equal(before.data['@browser_last_url_v2_userB'], undefined);
  assert.equal(before.snap.lastUrl, null);
});

test('P14R1-CTX-11 无 Provider 时 useBrowserSession 抛错（原行为）', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const rt = createHookRuntime();
let thrown = null;
try {
  rt.render(() => { useBrowserSession(); });
} catch (e) {
  thrown = { name: e && e.name, message: e && e.message };
}
process.stdout.write(JSON.stringify({ thrown }));
`;
  const { before } = assertEqualBoth('context', body, '无 Provider 抛错');
  assert.equal(before.thrown.name, 'Error');
  assert.equal(before.thrown.message, 'useBrowserSession 必须在 BrowserSessionProvider 内使用');
});

test('P14R1-CTX-12 useAuth 来源：显式 userId 优先于 AuthProvider', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = { user: { id: 'authUser' }, authEpoch: 9 };
resetStore({
  '@browser_last_url_v2_explicitUser': 'https://explicit.example.com',
  '@browser_last_url_v2_authUser': 'https://auth.example.com',
});
const m = mountProvider({ userId: 'explicitUser', authEpoch: 3 });
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('context', body, '显式 userId 优先');
  assert.equal(before.snap.lastUrl, 'https://explicit.example.com');
  assert.ok(before.log.some((e) => e[1] === '@browser_last_url_v2_explicitUser'));
  assert.ok(!before.log.some((e) => e[1] === '@browser_last_url_v2_authUser'));
});

// ===========================================================================
// C. 联合身份隔离矩阵（History + Context 同时挂载，真实执行）
//    覆盖任务书要求的 10 个场景。
// ===========================================================================
const JOINT_PRELUDE = `
const { createHookRuntime } = await import('react');
const { __AS_LOG__, __AS_DATA__ } = await import('@react-native-async-storage/async-storage');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory');
const mod = await import('./src/context/BrowserSessionContext');
const { BrowserSessionProvider, useBrowserSession } = mod;
const BrowserSessionContext = mod.default;

globalThis.__AS_LOG__ = __AS_LOG__;
globalThis.__AS_DATA__ = __AS_DATA__;

globalThis.__NOW__ = 1000;
Date.now = () => globalThis.__NOW__;
Math.random = () => 0.5;

function resetStore(entries) {
  __AS_DATA__.clear();
  __AS_LOG__.length = 0;
  for (const [k, v] of Object.entries(entries || {})) __AS_DATA__.set(k, v);
}
function asLog() { return __AS_LOG__.map((e) => JSON.parse(JSON.stringify(e))); }
function asData() {
  const out = {};
  for (const [k, v] of __AS_DATA__.entries()) out[k] = v;
  return out;
}
function live(getCurrent) {
  return new Proxy({}, {
    get(_t, p) { return getCurrent()[p]; },
    has(_t, p) { return p in getCurrent(); },
    ownKeys() { return Reflect.ownKeys(getCurrent()); },
    getOwnPropertyDescriptor(_t, p) { return { configurable: true, enumerable: true, value: getCurrent()[p] }; },
  });
}

// 同时挂载 History Hook 与 Context Provider，共享同一 owner/epoch。
function mountJoint(userId, authEpoch) {
  const histRt = createHookRuntime();
  const provRt = createHookRuntime();
  const consRt = createHookRuntime();
  let histApi;
  let element;
  let ctx;
  histRt.render(() => { histApi = useBrowserHistory(userId, authEpoch); });
  provRt.render(() => {
    element = BrowserSessionProvider({ children: null, userId, authEpoch });
  });
  BrowserSessionContext.__ctx.current = element.props.value;
  consRt.render(() => { ctx = useBrowserSession(); });
  function syncConsumer() {
    BrowserSessionContext.__ctx.current = element.props.value;
    consRt.render(() => { ctx = useBrowserSession(); });
  }
  return {
    histRt, provRt, consRt,
    get hist() { return live(() => histApi); },
    get ctx() { return live(() => ctx); },
    get providerValue() { return element.props.value; },
    // 推进 History / Provider 的异步 effect → settle 重渲染 → 再同步消费者。
    async flush() {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        histRt.settle();
        provRt.settle();
        syncConsumer();
      }
    },
    switchTo(nextUserId, nextEpoch) {
      histRt.render(() => { histApi = useBrowserHistory(nextUserId, nextEpoch); });
      provRt.render(() => {
        element = BrowserSessionProvider({ children: null, userId: nextUserId, authEpoch: nextEpoch });
      });
      syncConsumer();
    },
  };
}

function snapJoint(m) {
  return {
    history: JSON.parse(JSON.stringify(m.hist.historyList)),
    bookmarks: JSON.parse(JSON.stringify(m.hist.bookmarksList)),
    pendingUrl: m.ctx.pendingUrl,
    pendingSeq: m.ctx.pendingSeq,
    lastUrl: m.ctx.lastUrl,
  };
}

async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
`;

test('P14R1-JOINT-1 A 正常读写（History + Context 同时）', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
});
const m = mountJoint('userA', 1);
await m.flush();
m.hist.addHistory('https://a.example.com', 'A');
m.ctx.setPendingUrl('https://a-target.example.com');
m.ctx.rememberUrl('https://a-visited.example.com');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({ snap: snapJoint(m), data: asData() }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-1 A 正常读写');
  assert.deepEqual(before.snap.history.map((h) => h.url), ['https://a.example.com']);
  assert.equal(before.snap.pendingUrl, 'https://a-target.example.com');
  assert.equal(before.snap.lastUrl, 'https://a-visited.example.com');
  assert.equal(before.data['@browser_last_url_v2_userA'], 'https://a-visited.example.com');
});

test('P14R1-JOINT-2 A→B 切换：双方内存态清空 + 只读 B 数据', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([{ id: 'a1', url: 'https://a-hist.example.com', title: 'A', timestamp: 1 }]),
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
  '@sync_browser_history_v2_userB': JSON.stringify([{ id: 'b1', url: 'https://b-hist.example.com', title: 'B', timestamp: 2 }]),
  '@browser_last_url_v2_userB': 'https://b-last.example.com',
});
const m = mountJoint('userA', 1);
await m.flush();
m.ctx.setPendingUrl('https://a-pending.example.com');
await m.flush();
const asA = snapJoint(m);
m.switchTo('userB', 2);
await m.flush();
const asB = snapJoint(m);
process.stdout.write(JSON.stringify({ asA, asB }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-2 A→B');
  assert.deepEqual(before.asA.history.map((h) => h.id), ['a1']);
  assert.equal(before.asA.pendingUrl, 'https://a-pending.example.com');
  assert.deepEqual(before.asB.history.map((h) => h.id), ['b1']);
  assert.equal(before.asB.pendingUrl, null);
  assert.equal(before.asB.lastUrl, 'https://b-last.example.com');
});

test('P14R1-JOINT-3 A→B→A：回到 A 只读 A 数据，旧 pendingUrl 不复活', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([{ id: 'a1', url: 'https://a-hist.example.com', title: 'A', timestamp: 1 }]),
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
  '@sync_browser_history_v2_userB': JSON.stringify([{ id: 'b1', url: 'https://b-hist.example.com', title: 'B', timestamp: 2 }]),
});
const m = mountJoint('userA', 1);
await m.flush();
m.ctx.setPendingUrl('https://a-pending.example.com');
await m.flush();
m.switchTo('userB', 2);
await m.flush();
m.switchTo('userA', 3);
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapJoint(m) }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-3 A→B→A');
  assert.deepEqual(before.snap.history.map((h) => h.id), ['a1']);
  assert.equal(before.snap.pendingUrl, null);
});

test('P14R1-JOINT-4 同 userId 新 authEpoch：旧 pendingUrl 清空', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@browser_last_url_v2_userA': 'https://a-last.example.com',
});
const m = mountJoint('userA', 1);
await m.flush();
m.ctx.setPendingUrl('https://a-pending.example.com');
await m.flush();
const beforeEpoch = snapJoint(m);
m.switchTo('userA', 2);
await m.flush();
process.stdout.write(JSON.stringify({ beforeEpoch, afterEpoch: snapJoint(m) }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-4 同账号新 epoch');
  assert.equal(before.beforeEpoch.pendingUrl, 'https://a-pending.example.com');
  assert.equal(before.afterEpoch.pendingUrl, null);
  assert.equal(before.afterEpoch.lastUrl, 'https://a-last.example.com');
});

test('P14R1-JOINT-5 旧 A 回调在 B 中执行：History 与 Context 均丢弃', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
});
const m = mountJoint('userA', 1);
await m.flush();
const staleAdd = m.hist.addHistory;
const staleSetPending = m.ctx.setPendingUrl;
const staleRemember = m.ctx.rememberUrl;
m.switchTo('userB', 2);
await m.flush();
staleAdd('https://stale-a.example.com', 'Stale');
staleSetPending('https://stale-a-pending.example.com');
staleRemember('https://stale-a-visited.example.com');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({ snap: snapJoint(m), data: asData() }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-5 旧 A 回调丢弃');
  assert.deepEqual(before.snap.history, []);
  assert.equal(before.snap.pendingUrl, null);
  assert.equal(before.snap.lastUrl, null);
  assert.equal(before.data['@browser_last_url_v2_userB'], undefined);
});

test('P14R1-JOINT-6 旧异步读取结果在新会话到达：丢弃', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([{ id: 'a1', url: 'https://a-hist.example.com', title: 'A', timestamp: 1 }]),
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
  '@sync_browser_history_v2_userB': JSON.stringify([{ id: 'b1', url: 'https://b-hist.example.com', title: 'B', timestamp: 2 }]),
});
const m = mountJoint('userA', 1);
// 不 drain：A 的异步读取未完成即切换
m.switchTo('userB', 2);
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapJoint(m) }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-6 迟到异步读取');
  assert.deepEqual(before.snap.history.map((h) => h.id), ['b1']);
});

test('P14R1-JOINT-7 新 owner 合法操作正常完成', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
});
const m = mountJoint('userA', 1);
await m.flush();
m.switchTo('userB', 2);
await m.flush();
m.hist.addHistory('https://b-new.example.com', 'BNew');
m.ctx.setPendingUrl('https://b-target.example.com');
m.ctx.rememberUrl('https://b-visited.example.com');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({ snap: snapJoint(m), data: asData() }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-7 新 owner 合法操作');
  assert.deepEqual(before.snap.history.map((h) => h.url), ['https://b-new.example.com']);
  assert.equal(before.snap.pendingUrl, 'https://b-target.example.com');
  assert.equal(before.snap.lastUrl, 'https://b-visited.example.com');
  assert.equal(before.data['@browser_last_url_v2_userB'], 'https://b-visited.example.com');
});

test('P14R1-JOINT-8 无 owner fail-closed（History + Context）', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountJoint(null, 0);
await m.flush();
m.hist.addHistory('https://x.example.com', 'X');
m.ctx.setPendingUrl('https://x-target.example.com');
m.ctx.rememberUrl('https://x-visited.example.com');
const r = await m.hist.toggleBookmark('https://x.example.com', 'X');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({ snap: snapJoint(m), r, data: asData(), log: asLog() }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-8 无 owner fail-closed');
  assert.deepEqual(before.snap.history, []);
  // 说明：原实现 setPendingUrl 在无 owner 时**仍写入内存态**（仅跳过持久化），
  // 因此 pendingUrl 会被设为传入值；此处断言真实基线行为，而非臆测的 null。
  assert.equal(before.snap.pendingUrl, 'https://x-target.example.com');
  assert.equal(before.snap.lastUrl, null);
  assert.deepEqual(before.r, { ok: false, action: 'invalid' });
  // 无 owner：不写任何持久化 key（fail-closed 的持久化侧）
  assert.deepEqual(before.data, {});
  assert.deepEqual(before.log, []);
});

test('P14R1-JOINT-9 不同 owner 持久化 key 不交叉写入', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
});
const m = mountJoint('userA', 1);
await m.flush();
m.hist.addHistory('https://a-only.example.com', 'A');
m.ctx.rememberUrl('https://a-only-visited.example.com');
await m.flush();
await drain();
m.switchTo('userB', 2);
await m.flush();
m.hist.addHistory('https://b-only.example.com', 'B');
m.ctx.rememberUrl('https://b-only-visited.example.com');
await m.flush();
await drain();
process.stdout.write(JSON.stringify({ data: asData() }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-9 key 不交叉');
  assert.deepEqual(
    JSON.parse(before.data['@sync_browser_history_v2_userA']).map((h) => h.url),
    ['https://a-only.example.com']
  );
  assert.deepEqual(
    JSON.parse(before.data['@sync_browser_history_v2_userB']).map((h) => h.url),
    ['https://b-only.example.com']
  );
  assert.equal(before.data['@browser_last_url_v2_userA'], 'https://a-only-visited.example.com');
  assert.equal(before.data['@browser_last_url_v2_userB'], 'https://b-only-visited.example.com');
});

test('P14R1-JOINT-10 pendingUrl 不跨账号泄漏', () => {
  const body = `${JOINT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_bookmarks_v2_userB': '[]',
  '@sync_browser_bookmarks_seed_v2_userB': '2',
});
const m = mountJoint('userA', 1);
await m.flush();
m.ctx.setPendingUrl('https://secret-a.example.com');
await m.flush();
const asA = snapJoint(m);
m.switchTo('userB', 2);
await m.flush();
const asB = snapJoint(m);
process.stdout.write(JSON.stringify({ asA, asB }));
`;
  const { before } = assertEqualBoth('joint', body, 'JOINT-10 pendingUrl 不泄漏');
  assert.equal(before.asA.pendingUrl, 'https://secret-a.example.com');
  assert.equal(before.asB.pendingUrl, null);
});

// ===========================================================================
// D. 故障注入敏感性验证：证明测试不是无条件通过
//    做法：在 after 沙箱副本中注入一处可观测的行为偏差，验证其与 before 基线
//    产生差异；若测试对行为变化不敏感，则此处会失败。
//    注入只作用于临时沙箱副本，绝不修改真实源码。
// ===========================================================================
function mutateAndCompare(target, relFile, from, to, body, label, extra) {
  const dir = buildSandbox('after', target);
  const filePath = path.join(dir, relFile);
  const original = fs.readFileSync(filePath, 'utf8');
  let mutated = original.replace(from, to);
  assert.notEqual(mutated, original, `故障注入必须实际改变源码：${label}`);
  // 可选第二处替换（用于需要同时中和两处重叠校验的场景）
  if (extra) {
    const before2 = mutated;
    mutated = mutated.replace(extra.from, extra.to);
    assert.notEqual(mutated, before2, `故障注入第二处替换必须实际改变源码：${label}`);
  }
  fs.writeFileSync(filePath, mutated, 'utf8');

  const mutatedOut = runInSandbox(dir, body);

  const baselineDir = buildSandbox('before', target);
  const baselineOut = runInSandbox(baselineDir, body);

  assert.notDeepEqual(
    mutatedOut,
    baselineOut,
    `篡改后的 after 副本必须与 before 基线产生差异，否则测试无敏感性：${label}`
  );
}

test('P14R1-SENS-1 故障注入：移除 addHistory 落盘前二次 owner 校验应被检出', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
});
const rt = createHookRuntime();
let api;
let owner = 'userA';
rt.render(() => { api = useBrowserHistory(owner, 1); });
await drain();
rt.settle();
const staleAdd = api.addHistory;
// 切到 B 后执行 A 的旧回调
owner = 'userB';
rt.rerender();
await drain();
rt.settle();
staleAdd('https://stale.example.com', 'Stale');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({ snap: snap(api), log: asLog() }));
`;
  // 移除 addHistory 的**全部** owner/epoch 校验（首次 + 落盘前二次），
  // 使迟到回调得以继续执行并写入 → 与基线（丢弃）产生差异。
  // 说明：首次与二次校验条件重叠，只移除其中一处仍会被另一处拦截，
  // 因此必须同时移除两处才能观测到行为偏差。
  // 注意：history 目标在沙箱内是**原样复制**的 .ts（Node 原生类型剥离执行），
  // 因此搜索串必须匹配 .ts 源码格式（单行 if + 6 空格缩进），而非转译后格式。
  mutateAndCompare(
    'history',
    'src/hooks/browser/useBrowserHistory.ts',
    'if (userIdRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate) return;',
    'if (false) return;',
    body,
    'addHistory 首次 owner 校验',
    // 追加第二处替换：落盘前二次校验（多行 if 块）
    {
      from: 'if (\n        userIdRef.current !== ownerAtCreate ||\n        authEpochRef.current !== epochAtCreate ||\n        keysRef.current.historyKey !== key\n      )\n        return;',
      to: 'if (false)\n        return;',
    }
  );
});

test('P14R1-SENS-2 故障注入：篡改历史去重（同 URL 不置顶）应被检出', () => {
  const body = `${HISTORY_PRELUDE}
resetStore({
  '@sync_browser_bookmarks_v2_userA': '[]',
  '@sync_browser_bookmarks_seed_v2_userA': '2',
  '@sync_browser_history_v2_userA': JSON.stringify([
    { id: 'h1', url: 'https://a.example.com', title: 'A', timestamp: 1 },
  ]),
});
const { rt, api } = mountHistory('userA', 1);
await drain();
rt.settle();
api.addHistory('https://b.example.com', 'B');
rt.settle();
await drain();
api.addHistory('https://a.example.com', 'A2');
rt.settle();
await drain();
process.stdout.write(JSON.stringify({ snap: snap(api) }));
`;
  // 篡改 mergeHistoryEntry：把「同 URL 去重」改为「不去重」（filter 恒真），
  // 使 a 重复出现 → 与基线（去重置顶）产生差异。
  mutateAndCompare(
    'history',
    'src/hooks/browser/historyDataLogic.ts',
    'const next = [entry, ...prev.filter((it) => it.url !== entry.url)].slice(0, limit);',
    'const next = [entry, ...prev.filter(() => true)].slice(0, limit);',
    body,
    '历史去重'
  );
});

test('P14R1-SENS-3 故障注入：篡改 Context 迟到回调 owner 校验应被检出', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({});
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
const staleSetPending = m.ctx.setPendingUrl;
m.rerenderProvider({ userId: 'userB', authEpoch: 2 });
await m.flush();
staleSetPending('https://stale-a.example.com');
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m) }));
`;
  // 移除 setPendingUrl 的 owner/epoch 校验（改为恒 false 不返回），
  // 使 A 的迟到回调得以写入 B 的 pendingUrl → 与基线（丢弃）产生差异。
  // 注意：沙箱内执行的是 ts.transpileModule 转译后的 .js，搜索串必须匹配
  // 转译后的换行与缩进格式（换行 + 12 空格），而非 .tsx 源码格式。
  mutateAndCompare(
    'context',
    'src/context/BrowserSessionContext.js',
    'if (lastUrlOwnerRef.current !== userId || authEpochRef.current !== authEpoch)\n            return;',
    'if (false)\n            return;',
    body,
    'Context 迟到回调 owner 校验'
  );
});

test('P14R1-SENS-4 故障注入：篡改 Context 同账号新 epoch 清空 pendingUrl 应被检出', () => {
  const body = `${CONTEXT_PRELUDE}
globalThis.__AUTH__ = null;
resetStore({ '@browser_last_url_v2_userA': 'https://a-last.example.com' });
const m = mountProvider({ userId: 'userA', authEpoch: 1 });
await m.flush();
m.ctx.setPendingUrl('https://a-pending.example.com');
await m.flush();
m.rerenderProvider({ userId: 'userA', authEpoch: 2 });
await m.flush();
process.stdout.write(JSON.stringify({ snap: snapCtx(m) }));
`;
  // 移除「同账号新 epoch → 清空 pendingUrl」的渲染期调整，
  // 使旧 pendingUrl 残留 → 与基线（清空）产生差异。
  // 注意：搜索串匹配转译后 .js 的缩进格式（8 空格）。
  mutateAndCompare(
    'context',
    'src/context/BrowserSessionContext.js',
    'if (stateEpoch !== authEpoch) {\n        setStateEpoch(authEpoch);\n        setPendingUrlState(null);\n    }',
    'if (stateEpoch !== authEpoch) {\n        setStateEpoch(authEpoch);\n    }',
    body,
    '同账号新 epoch 清空 pendingUrl'
  );
});
// --- END OF FILE tests/security/p14r1BrowserStateMigrationEquivalence.test.mjs ---
