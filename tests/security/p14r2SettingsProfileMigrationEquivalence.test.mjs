// --- START OF FILE tests/security/p14r2SettingsProfileMigrationEquivalence.test.mjs ---
/**
 * P1.4 R2 — Settings / Theme / Profile 成批 JS → TypeScript 迁移 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前实现：冻结基线（tests/fixtures/p14r2/before/）
 *         - `context__ThemeContext.js`
 *         - `hooks__useAppSettings.js`
 *         - `hooks__profile__useProfileCache.js`
 *     · 迁移后实现：当前真实源码
 *         - `src/context/ThemeContext.tsx`
 *         - `src/hooks/useAppSettings.ts`
 *         - `src/hooks/profile/useProfileCache.ts`
 *   对同一组输入比较**完整可观测结果**（状态 / Ref / 副作用序列 / AsyncStorage
 *   读写次数与顺序与内容 / 异常语义 / 公开接口形状 / Provider value 结构）。
 *
 * 覆盖
 *   A. ThemeContext（默认主题 / Provider 初始态 / 系统主题变化 / 手动切换 /
 *      持久化 / 恢复 / 非法存储值 / Effect 清理 / 无 Provider 抛错 / Provider JSX 结构）
 *   B. useAppSettings（默认值 / 恢复 / 持久化 / 非法存储 / 未知键 / 连续快速更新 /
 *      重置 / Effect 清理 / 公开接口）
 *   C. useProfileCache（首读 / 命中 / 未命中 / 写入 / 代际失效 / 快速重复请求 /
 *      A→B→A / 同账号新代际 / 迟到结果 / 卸载后异步返回 / 公开接口）
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
 *   `ThemeContext.tsx` 在沙箱内使用**项目自带 TypeScript 编译器**
 *   （`ts.transpileModule`，jsx: React）转译为 `.js` 后执行——这是项目既有的受控
 *   TypeScript JSX 转译机制，**不是**为测试手工改写生产 JSX 结构。
 *   迁移前的 `.js` 基线同样经该转译器处理，保证两侧执行机制一致。
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r2/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'context__ThemeContext.js':
    '9f18af253073ed242f8adc9586b1a51787a67919b5499e9036974c09fd3d3afd',
  'hooks__useAppSettings.js':
    '6e4111c8667bd17056c459f8addcf2629c29b2abfdeb9f77338a5665e88f9c42',
  'hooks__profile__useProfileCache.js':
    '426cfa5cb3ac1f793348d420c867c8b05606851f9d088bf69b268b52d6a57f7d',
};

test('P14R2-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 P1.3 / P1.4 R0 / R1 测试同构，独立复制以保持自包含）
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
//   mode   = 'before' → 使用冻结基线（迁移前 JS）
//   mode   = 'after'  → 使用当前真实源码（迁移后 TS / TSX）
//   target = 'theme' | 'settings' | 'profile'
// ---------------------------------------------------------------------------
function buildSandbox(mode, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r2-${target}-${mode}-`));
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
// Provider 标识对象自身携带 __ctx 引用，便于测试侧把 value 写入正确的容器。
export const createContext = (v) => {
  const ctx = { __ctx: { current: v } };
  ctx.Provider = { __ctx: ctx.__ctx, __isProvider: true };
  return ctx;
};
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  // react-native stub：useColorScheme 读取 globalThis.__SCHEME__（可切换）
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export function useColorScheme() {
  return globalThis.__SCHEME__ === undefined ? null : globalThis.__SCHEME__;
}
export default { useColorScheme };
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
  copyFile(path.join(repoRoot, 'src/constants/colors.ts'), 'src/constants/colors.ts');
  copyFile(path.join(repoRoot, 'src/constants/theme.ts'), 'src/constants/theme.ts');
  // 类型模块（仅类型，运行时为空；复制以支持潜在 import type 解析）
  copyFile(path.join(repoRoot, 'src/types/settings.ts'), 'src/types/settings.ts');
  copyFile(path.join(repoRoot, 'src/types/user.ts'), 'src/types/user.ts');

  // supabase stub：可控 profiles 查询（globalThis.__PROFILE_QUERY__ 注入）
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/services/supabase.js'),
    `
export const supabase = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      single() {
        return globalThis.__PROFILE_QUERY__
          ? globalThis.__PROFILE_QUERY__()
          : Promise.resolve({ data: null, error: null });
      },
    };
  },
};
export default { supabase };
`
  );

  // 被测模块：before 用冻结基线，after 用当前真实源码。
  // 含 JSX 的模块（ThemeContext）两侧都必须经 ts.transpileModule 转译为 .js。
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

  if (target === 'theme') {
    if (mode === 'before') {
      place(path.join(beforeDir, 'context__ThemeContext.js'), 'src/context/ThemeContext.js', true);
    } else {
      place(path.join(repoRoot, 'src/context/ThemeContext.tsx'), 'src/context/ThemeContext.js', true);
    }
  }

  // 迁移后的 .ts 含 `import type` / 类型注解，Node 原生类型剥离无法处理
  // `import type { X } from` 的具名导入形式，因此统一经 ts.transpileModule 转译。
  if (target === 'settings') {
    if (mode === 'before') {
      place(path.join(beforeDir, 'hooks__useAppSettings.js'), 'src/hooks/useAppSettings.js', false);
    } else {
      place(path.join(repoRoot, 'src/hooks/useAppSettings.ts'), 'src/hooks/useAppSettings.js', true);
    }
  }

  if (target === 'profile') {
    if (mode === 'before') {
      place(
        path.join(beforeDir, 'hooks__profile__useProfileCache.js'),
        'src/hooks/profile/useProfileCache.js',
        false
      );
    } else {
      place(
        path.join(repoRoot, 'src/hooks/profile/useProfileCache.ts'),
        'src/hooks/profile/useProfileCache.js',
        true
      );
    }
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
// A. ThemeContext
// ===========================================================================
const THEME_PRELUDE = `
const { createHookRuntime } = await import('react');
const { __AS_LOG__, __AS_DATA__ } = await import('@react-native-async-storage/async-storage');
const { ThemeProvider, useAppTheme, THEME_MODES } = await import('./src/context/ThemeContext');

globalThis.__AS_LOG__ = __AS_LOG__;
globalThis.__AS_DATA__ = __AS_DATA__;

function resetStore(entries) {
  __AS_DATA__.clear();
  __AS_LOG__.length = 0;
  for (const [k, v] of Object.entries(entries || {})) __AS_DATA__.set(k, v);
}
function asLog() { return __AS_LOG__.map((e) => JSON.parse(JSON.stringify(e))); }
async function drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

// 挂载 Provider + 消费者：Provider 与消费者分属不同 runtime
function mountTheme(initialScheme) {
  globalThis.__SCHEME__ = initialScheme === undefined ? null : initialScheme;
  const providerRt = createHookRuntime();
  const consumerRt = createHookRuntime();
  let ctx;
  let tree;
  // Provider 返回 <ThemeContext.Provider value={...}>，其 value 需写入 Context 容器，
  // 供消费者 useContext 读取（模拟 React 的 Provider 传播语义）。
  // 注意：ThemeContext 模块内的 createContext 实例与消费者共享同一 __ctx 容器，
  // 因此这里通过 Provider 元素携带的 context 引用写入 value。
  const publish = () => {
    const ctxObj = tree && tree.props ? tree.props.value : undefined;
    if (ctxObj !== undefined) {
      globalThis.__THEME_VALUE__ = ctxObj;
      const ctxRef = tree && tree.type && tree.type.__ctx;
      if (ctxRef) ctxRef.current = ctxObj;
    }
  };
  const renderTree = () => {
    tree = providerRt.render(() => ThemeProvider({ children: null }));
    publish();
    consumerRt.render(() => { ctx = useAppTheme(); });
  };
  renderTree();
  return {
    providerRt,
    consumerRt,
    get ctx() { return ctx; },
    get tree() { return tree; },
    // 重新渲染 Provider 后必须重新发布 value（Provider 元素是每次渲染新建的），
    // 否则消费者读到的仍是首帧 value。
    rerenderProvider() { renderTree(); },
    // 状态更新（setState）后 Provider 重渲染，需要重新发布 value 并同步消费者。
    // 这是测试运行时对 React「Provider 重渲染 → 消费者重渲染」语义的模拟。
    // 注意：settle() 内部重渲染但不返回新树，必须用 rerender() 循环捕获最新树，
    // 否则 publish() 读到的仍是首帧 tree（value 停留在初始值）。
    sync() {
      let rounds = 0;
      while (providerRt.isScheduled && rounds < 20) {
        tree = providerRt.rerender();
        rounds += 1;
      }
      publish();
      consumerRt.render(() => { ctx = useAppTheme(); });
    },
    setScheme(s) { globalThis.__SCHEME__ = s; },
  };
}

function snapTheme(m) {
  const c = m.ctx;
  return {
    themeMode: c.themeMode,
    isDark: c.isDark,
    isThemeLoaded: c.isThemeLoaded,
    colorKeys: Object.keys(c.colors).sort(),
    isDarkColor: c.colors.isDark,
    radiusCard: c.colors.radiusCard,
    radiusList: c.colors.radiusList,
    padding: c.colors.padding,
    typographyKeys: Object.keys(c.colors.typography || {}).sort(),
    primary: c.colors.primary,
    background: c.colors.background,
    card: c.colors.card,
    ctxKeys: Object.keys(c).sort(),
    modes: THEME_MODES.slice(),
    treeType: m.tree && m.tree.type ? String(m.tree.type) : null,
    treeHasValue: !!(m.tree && m.tree.props && m.tree.props.value),
  };
}
`;

test('P14R2-THEME-1 默认主题（无存储，system + 浅色）', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('theme', body, '默认主题');
  assert.equal(before.snap.themeMode, 'system');
  assert.equal(before.snap.isDark, false);
  assert.equal(before.snap.isThemeLoaded, true);
  assert.deepEqual(before.snap.modes, ['system', 'light', 'dark']);
  assert.equal(before.log.length, 1);
  assert.equal(before.log[0][0], 'getItem');
  assert.equal(before.log[0][1], '@app_theme_mode');
});

test('P14R2-THEME-2 系统深色 + system 模式 → isDark true', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('dark');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m) }));
`;
  const { before } = assertEqualBoth('theme', body, '系统深色');
  assert.equal(before.snap.isDark, true);
  assert.equal(before.snap.isDarkColor, true);
});

test('P14R2-THEME-3 系统主题变化（system 模式下跟随）', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
const first = snapTheme(m);
m.setScheme('dark');
m.rerenderProvider();
await drain();
m.sync();
const second = snapTheme(m);
process.stdout.write(JSON.stringify({ first, second }));
`;
  const { before } = assertEqualBoth('theme', body, '系统主题变化');
  assert.equal(before.first.isDark, false);
  assert.equal(before.second.isDark, true);
});

test('P14R2-THEME-4 恢复持久化的 dark 模式', () => {
  const body = `${THEME_PRELUDE}
resetStore({ '@app_theme_mode': 'dark' });
const m = mountTheme('light');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('theme', body, '恢复 dark');
  assert.equal(before.snap.themeMode, 'dark');
  assert.equal(before.snap.isDark, true);
});

test('P14R2-THEME-5 恢复持久化的 light 模式（系统深色下仍为浅色）', () => {
  const body = `${THEME_PRELUDE}
resetStore({ '@app_theme_mode': 'light' });
const m = mountTheme('dark');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m) }));
`;
  const { before } = assertEqualBoth('theme', body, '恢复 light');
  assert.equal(before.snap.themeMode, 'light');
  assert.equal(before.snap.isDark, false);
});

test('P14R2-THEME-6 非法存储值 → 回退 system', () => {
  const body = `${THEME_PRELUDE}
resetStore({ '@app_theme_mode': 'purple' });
const m = mountTheme('dark');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m) }));
`;
  const { before } = assertEqualBoth('theme', body, '非法存储值');
  assert.equal(before.snap.themeMode, 'system');
  assert.equal(before.snap.isDark, true);
});

test('P14R2-THEME-7 手动切换主题并持久化', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
m.ctx.setThemeMode('dark');
await drain();
m.sync();
const afterDark = snapTheme(m);
m.ctx.setThemeMode('light');
await drain();
m.sync();
const afterLight = snapTheme(m);
process.stdout.write(JSON.stringify({ afterDark, afterLight, log: asLog() }));
`;
  const { before } = assertEqualBoth('theme', body, '手动切换');
  assert.equal(before.afterDark.themeMode, 'dark');
  assert.equal(before.afterDark.isDark, true);
  assert.equal(before.afterLight.themeMode, 'light');
  assert.equal(before.afterLight.isDark, false);
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.deepEqual(
    setLogs.map((e) => [e[1], e[2]]),
    [
      ['@app_theme_mode', 'dark'],
      ['@app_theme_mode', 'light'],
    ]
  );
});

test('P14R2-THEME-8 非法模式入参 → 忽略且不落盘', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
const beforeLog = asLog().length;
m.ctx.setThemeMode('neon');
m.ctx.setThemeMode(null);
m.ctx.setThemeMode(123);
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m), log: asLog(), beforeLog }));
`;
  const { before } = assertEqualBoth('theme', body, '非法模式入参');
  assert.equal(before.snap.themeMode, 'system');
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 0);
});

test('P14R2-THEME-9 Effect 清理：卸载后迟到的存储读取不写 state', () => {
  const body = `${THEME_PRELUDE}
resetStore({ '@app_theme_mode': 'dark' });
const m = mountTheme('light');
// 不 drain：让 getItem 的 Promise 尚未 resolve 就卸载
m.providerRt.unmount();
await drain();
process.stdout.write(JSON.stringify({ snap: snapTheme(m) }));
`;
  const { before } = assertEqualBoth('theme', body, 'Effect 清理');
  // 卸载后 cancelled=true，themeMode 保持初始 system
  assert.equal(before.snap.themeMode, 'system');
});

test('P14R2-THEME-10 无 Provider 时 useAppTheme 抛错', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const rt = createHookRuntime();
let err = null;
try {
  rt.render(() => { useAppTheme(); });
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
process.stdout.write(JSON.stringify({ err }));
`;
  const { before } = assertEqualBoth('theme', body, '无 Provider 抛错');
  assert.equal(before.err.message, 'useAppTheme 必须在 <ThemeProvider> 内部使用');
});

test('P14R2-THEME-11 Provider JSX 结构与 value 形状', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m) }));
`;
  const { before } = assertEqualBoth('theme', body, 'Provider JSX 结构');
  assert.deepEqual(before.snap.ctxKeys, ['colors', 'isDark', 'isThemeLoaded', 'setThemeMode', 'themeMode']);
  assert.equal(before.snap.treeHasValue, true);
  assert.ok(before.snap.colorKeys.includes('primary'));
  assert.ok(before.snap.colorKeys.includes('background'));
  assert.ok(before.snap.colorKeys.includes('card'));
  assert.ok(before.snap.colorKeys.includes('isDark'));
  assert.ok(before.snap.colorKeys.includes('radiusCard'));
  assert.ok(before.snap.colorKeys.includes('radiusList'));
  assert.ok(before.snap.colorKeys.includes('padding'));
  assert.ok(before.snap.colorKeys.includes('typography'));
});

// ---------------------------------------------------------------------------
// THEME-12..14：Gatekeeper 实测差异回归（Symbol 入参 / 导出数组运行时变化）
//   原 JS 用 `THEME_MODES.includes(mode)` 判定成员，并在告警模板 `${mode}` 中
//   直接插值。Symbol 无法隐式转字符串 → 抛 TypeError。迁移后若加 typeof 过滤
//   或改成 String(mode)，行为就会偏离。以下测试逐字段比对异常与副作用。
// ---------------------------------------------------------------------------
test('P14R2-THEME-12 Symbol 非法模式 → 新旧均抛 TypeError 且无持久化副作用', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
const beforeLog = asLog().length;
let err = null;
try {
  m.ctx.setThemeMode(Symbol('invalid'));
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  err,
  snap: snapTheme(m),
  setItemCount: asLog().filter((e) => e[0] === 'setItem').length,
  logLenAfter: asLog().length - beforeLog,
}));
`;
  const { before } = assertEqualBoth('theme', body, 'Symbol 非法模式');
  // 原始模板插值 `${Symbol()}` 必然抛 TypeError（Cannot convert a Symbol value to a string）
  assert.equal(before.err.name, 'TypeError');
  assert.match(before.err.message, /Symbol/);
  // 抛错发生在 setState / setItem 之前 → 主题状态与持久化均无变化
  assert.equal(before.snap.themeMode, 'system');
  assert.equal(before.setItemCount, 0);
});

test('P14R2-THEME-13 导出 THEME_MODES 运行时追加成员 → 新旧判定一致', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
// 运行时向导出数组追加一个成员：原 JS 的 includes 会立即接受它。
THEME_MODES.push('sepia');
m.ctx.setThemeMode('sepia');
await drain();
m.sync();
const afterPush = snapTheme(m);
// 再移除该成员：此后 'sepia' 应重新变为非法。
THEME_MODES.pop();
m.ctx.setThemeMode('sepia');
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  afterPush,
  afterPop: snapTheme(m),
  setItemCount: asLog().filter((e) => e[0] === 'setItem').length,
}));
`;
  const { before } = assertEqualBoth('theme', body, '导出数组运行时变化');
  // 追加后 'sepia' 被接受并落盘
  assert.equal(before.afterPush.themeMode, 'sepia');
  assert.equal(before.setItemCount, 1);
  // 移除后 'sepia' 再次非法 → 状态停留在 sepia（未被覆盖），且无新增落盘
  assert.equal(before.afterPop.themeMode, 'sepia');
});

test('P14R2-THEME-14 包装 String 对象与普通字符串成员判定一致', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
// new String('dark') 是对象，includes 用 SameValueZero 比较 → 不等于 'dark'，应判非法。
let wrappedErr = null;
try {
  m.ctx.setThemeMode(new String('dark'));
} catch (e) {
  wrappedErr = { name: e && e.name, message: e && e.message };
}
await drain();
m.sync();
const afterWrapped = snapTheme(m);
// 普通字符串 'dark' 合法
m.ctx.setThemeMode('dark');
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  wrappedErr,
  afterWrapped,
  afterPlain: snapTheme(m),
  setItemCount: asLog().filter((e) => e[0] === 'setItem').length,
}));
`;
  const { before } = assertEqualBoth('theme', body, '包装 String 对象');
  // 包装对象被 includes 判为非法（不抛错，仅告警忽略）
  assert.equal(before.wrappedErr, null);
  assert.equal(before.afterWrapped.themeMode, 'system');
  // 普通字符串合法并落盘
  assert.equal(before.afterPlain.themeMode, 'dark');
  assert.equal(before.setItemCount, 1);
});

// ===========================================================================
// B. useAppSettings
// ===========================================================================
const SETTINGS_PRELUDE = `
const { createHookRuntime } = await import('react');
const { __AS_LOG__, __AS_DATA__ } = await import('@react-native-async-storage/async-storage');
const mod = await import('./src/hooks/useAppSettings');
const useAppSettings = mod.useAppSettings;
const DEFAULT_SETTINGS = mod.DEFAULT_SETTINGS;

globalThis.__AS_LOG__ = __AS_LOG__;
globalThis.__AS_DATA__ = __AS_DATA__;

function resetStore(entries) {
  __AS_DATA__.clear();
  __AS_LOG__.length = 0;
  for (const [k, v] of Object.entries(entries || {})) __AS_DATA__.set(k, v);
}
function asLog() { return __AS_LOG__.map((e) => JSON.parse(JSON.stringify(e))); }
async function drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

function mountSettings() {
  const rt = createHookRuntime();
  let api;
  rt.render(() => { api = useAppSettings(); });
  return { rt, get api() { return api; } };
}

function snapSettings(m) {
  const a = m.api;
  return {
    settings: JSON.parse(JSON.stringify(a.settings)),
    isLoading: a.isLoading,
    keys: Object.keys(a).sort(),
    defaults: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  };
}
`;

test('P14R2-SET-1 默认设置（无存储）', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('settings', body, '默认设置');
  assert.equal(before.snap.isLoading, false);
  assert.deepEqual(before.snap.settings, before.snap.defaults);
  assert.deepEqual(before.snap.keys, ['isLoading', 'resetSettings', 'settings', 'updateSetting']);
  assert.equal(before.log.length, 1);
  assert.equal(before.log[0][1], '@app_settings');
});

test('P14R2-SET-2 恢复持久化设置（与默认值合并）', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({ '@app_settings': JSON.stringify({ notifySound: false, language: 'en' }) });
const m = mountSettings();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('settings', body, '恢复持久化设置');
  assert.equal(before.snap.isLoading, false);
  assert.equal(before.snap.settings.notifySound, false);
  assert.equal(before.snap.settings.language, 'en');
  // 未持久化的字段回落到默认值
  assert.equal(before.snap.settings.notifyMessage, true);
  assert.equal(before.snap.settings.momentsVisibility, 'friends');
  assert.equal(before.log.length, 1);
  assert.equal(before.log[0][0], 'getItem');
  assert.equal(before.log[0][1], '@app_settings');
});

test('P14R2-SET-3 更新单项设置并持久化完整对象', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
m.api.updateSetting('notifyPartner', false);
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('settings', body, '更新单项设置');
  assert.equal(before.snap.settings.notifyPartner, false);
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.equal(setLogs.length, 1);
  assert.equal(setLogs[0][1], '@app_settings');
  const persisted = JSON.parse(setLogs[0][2]);
  assert.equal(persisted.notifyPartner, false);
  assert.equal(persisted.notifyMessage, true);
  assert.deepEqual(Object.keys(persisted).sort(), Object.keys(before.snap.defaults).sort());
});

test('P14R2-SET-4 连续快速更新（每次均落盘，最终态为最后一次）', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
m.api.updateSetting('notifySound', false);
m.api.updateSetting('notifySound', true);
m.api.updateSetting('notifySound', false);
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('settings', body, '连续快速更新');
  assert.equal(before.snap.settings.notifySound, false);
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.equal(setLogs.length, 3);
  assert.deepEqual(
    setLogs.map((e) => JSON.parse(e[2]).notifySound),
    [false, true, false]
  );
});

test('P14R2-SET-5 未知设置键 → 忽略且不落盘', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
const beforeLog = asLog().length;
m.api.updateSetting('notARealKey', 123);
m.api.updateSetting(null, 1);
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m), log: asLog(), beforeLog }));
`;
  const { before } = assertEqualBoth('settings', body, '未知设置键');
  assert.deepEqual(before.snap.settings, before.snap.defaults);
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 0);
});

test('P14R2-SET-6 重置设置 → 回到默认值并落盘', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({ '@app_settings': JSON.stringify({ notifySound: false, language: 'en' }) });
const m = mountSettings();
await drain();
m.rt.settle();
const restored = snapSettings(m);
m.api.resetSettings();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ restored, snap: snapSettings(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('settings', body, '重置设置');
  assert.equal(before.restored.settings.notifySound, false);
  assert.deepEqual(before.snap.settings, before.snap.defaults);
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.equal(setLogs.length, 1);
  assert.deepEqual(JSON.parse(setLogs[0][2]), before.snap.defaults);
});

test('P14R2-SET-7 非法 JSON 存储 → 回退默认值且不抛错', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({ '@app_settings': '{not-json' });
const m = mountSettings();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('settings', body, '非法 JSON 存储');
  assert.equal(before.snap.isLoading, false);
  assert.deepEqual(before.snap.settings, before.snap.defaults);
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 0);
});

test('P14R2-SET-8 非对象 JSON 存储（数组 / 字符串）→ 回退默认值', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({ '@app_settings': '[1,2,3]' });
const m = mountSettings();
await drain();
m.rt.settle();
const arr = snapSettings(m);
resetStore({ '@app_settings': '"hello"' });
const m2 = mountSettings();
await drain();
m2.rt.settle();
process.stdout.write(JSON.stringify({ arr, str: snapSettings(m2) }));
`;
  const { before } = assertEqualBoth('settings', body, '非对象 JSON 存储');
  // 数组 JSON 被对象展开后会产生数字键（真实行为，新旧一致），
  // 因此断言「含数字键且非纯默认值」而非「等于默认值」。
  assert.equal(before.arr.settings['0'], 1);
  assert.equal(before.arr.settings['2'], 3);
  assert.notDeepEqual(before.arr.settings, before.arr.defaults);
  // 字符串 JSON 展开后无自有可枚举键，回退为默认值。
  assert.deepEqual(before.str.settings, before.str.defaults);
});

test('P14R2-SET-9 Effect 清理：卸载后迟到的存储读取不写 state', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({ '@app_settings': JSON.stringify({ notifySound: false }) });
const m = mountSettings();
// 不 drain：让 getItem 的 Promise 尚未 resolve 就卸载
m.rt.unmount();
await drain();
process.stdout.write(JSON.stringify({ snap: snapSettings(m) }));
`;
  const { before } = assertEqualBoth('settings', body, 'Effect 清理');
  // 卸载后 cancelled=true，settings 保持默认值、isLoading 保持初始 true
  assert.deepEqual(before.snap.settings, before.snap.defaults);
  assert.equal(before.snap.isLoading, true);
});

test('P14R2-SET-10 公开接口形状与默认值常量', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m) }));
`;
  const { before } = assertEqualBoth('settings', body, '公开接口形状');
  assert.deepEqual(before.snap.keys, ['isLoading', 'resetSettings', 'settings', 'updateSetting']);
  assert.deepEqual(Object.keys(before.snap.defaults).sort(), [
    'allowFriendRequest',
    'allowSearch',
    'autoDownloadFile',
    'autoDownloadImage',
    'autoDownloadVideo',
    'careMode',
    'chatBackground',
    'earpieceMode',
    'language',
    'messagePreview',
    'momentsVisibility',
    'notifyMessage',
    'notifyPartner',
    'notifySound',
  ]);
});

// ---------------------------------------------------------------------------
// SET-11..14：Gatekeeper 实测差异回归（对象键 toString 强制转换 / Symbol 键）
//   原 JS 用 `key in DEFAULT_SETTINGS` 判定，`in` 会对对象键执行 ToPropertyKey
//   （即调用 toString），因此 `{ toString: () => 'notifySound' }` 是合法键。
//   迁移后若加 `typeof key === 'string'` 过滤，就会拒绝该对象键。
//   原 JS 告警模板 `${key}` 对 Symbol 抛 TypeError；改成 String(key) 则不抛。
// ---------------------------------------------------------------------------
test('P14R2-SET-11 自定义 toString 对象键 → 新旧均按 notifySound 生效并落盘 1 次', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
const beforeSnap = snapSettings(m);
let err = null;
try {
  m.api.updateSetting({ toString: () => 'notifySound' }, false);
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.rt.settle();
const setLogs = asLog().filter((e) => e[0] === 'setItem');
process.stdout.write(JSON.stringify({
  err,
  beforeSnap,
  snap: snapSettings(m),
  setItemCount: setLogs.length,
  lastWritten: setLogs.length ? JSON.parse(setLogs[setLogs.length - 1][2]) : null,
}));
`;
  const { before } = assertEqualBoth('settings', body, '自定义 toString 对象键');
  // 对象键经 ToPropertyKey 转为 'notifySound' → 合法，不抛错
  assert.equal(before.err, null);
  assert.equal(before.beforeSnap.settings.notifySound, true);
  // 生效：notifySound 被置为 false，且落盘 1 次，写入内容含 notifySound=false
  assert.equal(before.snap.settings.notifySound, false);
  assert.equal(before.setItemCount, 1);
  assert.equal(before.lastWritten.notifySound, false);
});

test('P14R2-SET-12 Symbol 非法键 → 新旧均抛 TypeError 且无落盘', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
let err = null;
try {
  m.api.updateSetting(Symbol('invalid'), 123);
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({
  err,
  snap: snapSettings(m),
  setItemCount: asLog().filter((e) => e[0] === 'setItem').length,
}));
`;
  const { before } = assertEqualBoth('settings', body, 'Symbol 非法键');
  // 原始模板插值 `${Symbol()}` 必然抛 TypeError
  assert.equal(before.err.name, 'TypeError');
  assert.match(before.err.message, /Symbol/);
  // 抛错发生在 setState / setItem 之前 → 设置保持默认值、无落盘
  assert.deepEqual(before.snap.settings, before.snap.defaults);
  assert.equal(before.setItemCount, 0);
});

test('P14R2-SET-13 包装 String 对象键 → 新旧均按字符串键生效', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
let err = null;
try {
  // new String('notifySound') 经 ToPropertyKey 转为 'notifySound' → 合法
  m.api.updateSetting(new String('notifySound'), false);
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.rt.settle();
const setLogs = asLog().filter((e) => e[0] === 'setItem');
process.stdout.write(JSON.stringify({
  err,
  snap: snapSettings(m),
  setItemCount: setLogs.length,
  lastWritten: setLogs.length ? JSON.parse(setLogs[setLogs.length - 1][2]) : null,
}));
`;
  const { before } = assertEqualBoth('settings', body, '包装 String 对象键');
  assert.equal(before.err, null);
  assert.equal(before.snap.settings.notifySound, false);
  assert.equal(before.setItemCount, 1);
  assert.equal(before.lastWritten.notifySound, false);
});

test('P14R2-SET-14 普通字符串合法键 → 新旧均生效并落盘', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
m.api.updateSetting('language', 'en');
await drain();
m.rt.settle();
const setLogs = asLog().filter((e) => e[0] === 'setItem');
process.stdout.write(JSON.stringify({
  snap: snapSettings(m),
  setItemCount: setLogs.length,
  lastWritten: setLogs.length ? JSON.parse(setLogs[setLogs.length - 1][2]) : null,
}));
`;
  const { before } = assertEqualBoth('settings', body, '普通字符串合法键');
  assert.equal(before.snap.settings.language, 'en');
  assert.equal(before.setItemCount, 1);
  assert.equal(before.lastWritten.language, 'en');
});

// ===========================================================================
// C. useProfileCache
// ===========================================================================
const PROFILE_PRELUDE = `
const { createHookRuntime } = await import('react');
const { __AS_LOG__, __AS_DATA__ } = await import('@react-native-async-storage/async-storage');
const mod = await import('./src/hooks/profile/useProfileCache');
const useProfileCache = mod.useProfileCache;
const setProfileCacheOwner = mod.setProfileCacheOwner;
const getProfileCacheGeneration = mod.getProfileCacheGeneration;
const readProfileCache = mod.readProfileCache;
const writeProfileCache = mod.writeProfileCache;
const clearProfileCache = mod.clearProfileCache;
const normalizeProfile = mod.normalizeProfile;
const buildProfileCacheKey = mod.buildProfileCacheKey;
const PROFILE_CACHE_KEY = mod.PROFILE_CACHE_KEY;
const PROFILE_CACHE_KEY_PREFIX = mod.PROFILE_CACHE_KEY_PREFIX;

globalThis.__AS_LOG__ = __AS_LOG__;
globalThis.__AS_DATA__ = __AS_DATA__;

function resetStore(entries) {
  __AS_DATA__.clear();
  __AS_LOG__.length = 0;
  for (const [k, v] of Object.entries(entries || {})) __AS_DATA__.set(k, v);
}
function asLog() { return __AS_LOG__.map((e) => JSON.parse(JSON.stringify(e))); }
async function drain() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

// 云端查询注入：默认返回 null（离线），测试可覆盖
function setCloud(fn) { globalThis.__PROFILE_QUERY__ = fn; }

function mountProfile(user) {
  const rt = createHookRuntime();
  let api;
  rt.render(() => { api = useProfileCache(user); });
  return { rt, get api() { return api; } };
}

function snapProfile(m) {
  const a = m.api;
  return {
    profile: a.profile ? JSON.parse(JSON.stringify(a.profile)) : null,
    loading: a.loading,
    keys: Object.keys(a).sort(),
  };
}
`;

test('P14R2-PROF-1 首读：缓存命中即秒开（loading 立即 false）', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice', nickname: 'Alice' }) });
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '首读缓存命中');
  assert.equal(before.snap.loading, false);
  assert.equal(before.snap.profile.id, 'u1');
  assert.equal(before.snap.profile.nickname, 'Alice');
  assert.equal(before.snap.profile.sync_id, 'alice');
});

test('P14R2-PROF-2 缓存未命中 + 云端成功 → 写入缓存', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: { id: 'u1', username: 'alice', nickname: 'Alice' }, error: null }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '缓存未命中');
  assert.equal(before.snap.loading, false);
  assert.equal(before.snap.profile.id, 'u1');
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.equal(setLogs.length, 1);
  assert.equal(setLogs[0][1], '@user_profile_cache_v2_u1');
  assert.equal(JSON.parse(setLogs[0][2]).nickname, 'Alice');
});

test('P14R2-PROF-3 未登录（user 为 null）→ profile null 且 loading false', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: null, error: null }));
setProfileCacheOwner(null);
const m = mountProfile(null);
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '未登录');
  assert.equal(before.snap.profile, null);
  assert.equal(before.snap.loading, false);
  assert.equal(before.log.length, 0);
});

test('P14R2-PROF-4 云端失败 → 保留缓存不清空 profile', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }) });
setCloud(() => Promise.resolve({ data: null, error: new Error('network-down') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '云端失败降级');
  assert.equal(before.snap.profile.id, 'u1');
  assert.equal(before.snap.loading, false);
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 0);
});

test('P14R2-PROF-5 缓存归属校验：磁盘记录 id 与 userId 不符 → 视为未命中', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'other', username: 'evil' }) });
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '缓存归属校验');
  assert.equal(before.snap.profile, null);
  assert.equal(before.snap.loading, false);
});

test('P14R2-PROF-6 切换账号 A→B：清空内存态并读取 B 缓存', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({
  '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }),
  '@user_profile_cache_v2_u2': JSON.stringify({ id: 'u2', username: 'bob' }),
});
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const rt = createHookRuntime();
let api;
let user = { id: 'u1' };
rt.render(() => { api = useProfileCache(user); });
await drain();
rt.settle();
const first = { profile: api.profile ? JSON.parse(JSON.stringify(api.profile)) : null, loading: api.loading };
setProfileCacheOwner('u2');
user = { id: 'u2' };
rt.rerender();
await drain();
rt.settle();
const second = { profile: api.profile ? JSON.parse(JSON.stringify(api.profile)) : null, loading: api.loading };
process.stdout.write(JSON.stringify({ first, second, log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '切换账号 A→B');
  assert.equal(before.first.profile.id, 'u1');
  assert.equal(before.second.profile.id, 'u2');
  assert.equal(before.second.profile.username, 'bob');
});

test('P14R2-PROF-7 迟到结果丢弃：A 请求在途时切到 B，A 结果不得进入 state', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
// 只捕获「A 的首次请求」的 resolve；后续 B 的请求返回一个永不 resolve 的 Promise，
// 避免覆盖 resolveA（否则 resolveA 会指向 B 的请求，场景失真）。
let resolveA;
let cloudCalls = 0;
setCloud(() => {
  cloudCalls += 1;
  if (cloudCalls === 1) return new Promise((res) => { resolveA = res; });
  return new Promise(() => {});
});
setProfileCacheOwner('u1');
const rt = createHookRuntime();
let api;
let user = { id: 'u1' };
rt.render(() => { api = useProfileCache(user); });
await drain();
// A 的云端请求仍在途，切到 B（B 的请求永不返回）
setProfileCacheOwner('u2');
user = { id: 'u2' };
rt.rerender();
await drain();
// 现在 A 的迟到结果返回
resolveA({ data: { id: 'u1', username: 'alice' }, error: null });
await drain();
rt.settle();
process.stdout.write(JSON.stringify({ snap: { profile: api.profile ? JSON.parse(JSON.stringify(api.profile)) : null, loading: api.loading }, log: asLog() }));
// B 的云端请求永不 resolve，其 30s 超时定时器会挂住进程；
// stdout 已同步写出，显式退出避免测试等待真实超时。
process.exit(0);
`;
  const { before } = assertEqualBoth('profile', body, '迟到结果丢弃');
  // A 的迟到结果必须被代际校验丢弃：B 无缓存、B 云端未返回 → profile 仍为 null
  assert.equal(before.snap.profile, null);
  // A 的结果也不得落盘
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 0);
});

test('P14R2-PROF-8 同账号新代际（forceBump）→ 旧请求结果丢弃', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
let resolveOld;
setCloud(() => new Promise((res) => { resolveOld = res; }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
// 同一 ownerId 但会话更换：强制自增代际
setProfileCacheOwner('u1', true);
resolveOld({ data: { id: 'u1', username: 'alice' }, error: null });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '同账号新代际');
  assert.equal(before.snap.profile, null);
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 0);
});

test('P14R2-PROF-9 卸载后异步返回不写 state', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }) });
setCloud(() => Promise.resolve({ data: { id: 'u1', username: 'alice', nickname: 'A' }, error: null }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
m.rt.unmount();
await drain();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '卸载后异步返回');
  assert.equal(before.snap.profile, null);
  assert.equal(before.snap.loading, true);
});

test('P14R2-PROF-10 updateLocalProfile 乐观更新并回写缓存', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }) });
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
m.api.updateLocalProfile({ nickname: 'Alice2' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '乐观更新');
  assert.equal(before.snap.profile.nickname, 'Alice2');
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.equal(setLogs.length, 1);
  assert.equal(JSON.parse(setLogs[0][2]).nickname, 'Alice2');
});

test('P14R2-PROF-11 公开接口形状', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: null, error: null }));
setProfileCacheOwner(null);
const m = mountProfile(null);
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m) }));
`;
  const { before } = assertEqualBoth('profile', body, '公开接口形状');
  assert.deepEqual(before.snap.keys, ['loading', 'profile', 'refresh', 'updateLocalProfile']);
});

test('P14R2-PROF-12 纯函数：buildProfileCacheKey / normalizeProfile / 常量', () => {
  const body = `${PROFILE_PRELUDE}
const out = {
  keyNull: buildProfileCacheKey(null),
  keyEmpty: buildProfileCacheKey(''),
  keyNum: buildProfileCacheKey(123),
  keyOk: buildProfileCacheKey('u9'),
  prefix: PROFILE_CACHE_KEY_PREFIX,
  legacy: PROFILE_CACHE_KEY,
  normNull: normalizeProfile(null),
  normEmpty: normalizeProfile({}),
  normFallback: normalizeProfile({ id: 'u1', username: 'alice' }),
  normKeep: normalizeProfile({ id: 'u1', username: 'alice', sync_id: 'S1', nickname: 'N1', bound_partner_nickname: 'P1' }),
};
process.stdout.write(JSON.stringify({ out }));
`;
  const { before } = assertEqualBoth('profile', body, '纯函数');
  assert.equal(before.out.keyNull, null);
  assert.equal(before.out.keyEmpty, null);
  assert.equal(before.out.keyNum, null);
  assert.equal(before.out.keyOk, '@user_profile_cache_v2_u9');
  assert.equal(before.out.legacy, '@user_profile_cache');
  assert.equal(before.out.normNull, null);
  assert.equal(before.out.normEmpty.sync_id, null);
  assert.equal(before.out.normEmpty.nickname, null);
  assert.equal(before.out.normEmpty.bound_partner_nickname, null);
  assert.equal(before.out.normFallback.sync_id, 'alice');
  assert.equal(before.out.normFallback.nickname, 'alice');
  assert.equal(before.out.normKeep.sync_id, 'S1');
  assert.equal(before.out.normKeep.nickname, 'N1');
  assert.equal(before.out.normKeep.bound_partner_nickname, 'P1');
});

test('P14R2-PROF-13 writeProfileCache fail-closed：owner 未登记时拒绝写入', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setProfileCacheOwner(null);
const r1 = await writeProfileCache({ id: 'u1', username: 'alice' });
const r2 = await writeProfileCache({ id: 'u1', username: 'alice' }, 0);
process.stdout.write(JSON.stringify({ r1, r2, log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, 'fail-closed 写入');
  assert.equal(before.r1, false);
  assert.equal(before.r2, false);
  assert.equal(before.log.length, 0);
});

test('P14R2-PROF-14 writeProfileCache：owner 不匹配 / 代际不匹配均拒绝', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setProfileCacheOwner('u1');
const gen = getProfileCacheGeneration();
const ok = await writeProfileCache({ id: 'u1', username: 'alice' }, gen);
const wrongOwner = await writeProfileCache({ id: 'u2', username: 'bob' }, gen);
const wrongGen = await writeProfileCache({ id: 'u1', username: 'alice' }, gen + 99);
const noId = await writeProfileCache({ username: 'x' }, gen);
process.stdout.write(JSON.stringify({ ok, wrongOwner, wrongGen, noId, log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '写入闸门');
  assert.equal(before.ok, true);
  assert.equal(before.wrongOwner, false);
  assert.equal(before.wrongGen, false);
  assert.equal(before.noId, false);
  assert.equal(before.log.filter((e) => e[0] === 'setItem').length, 1);
});

test('P14R2-PROF-15 readProfileCache / clearProfileCache 边界', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }) });
const noUser = await readProfileCache(null);
const hit = await readProfileCache('u1');
await clearProfileCache('u1');
const afterClear = await readProfileCache('u1');
await clearProfileCache(null);
process.stdout.write(JSON.stringify({ noUser, hit, afterClear, log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '读写清除边界');
  assert.equal(before.noUser, null);
  assert.equal(before.hit.username, 'alice');
  assert.equal(before.afterClear, null);
  assert.equal(before.log.filter((e) => e[0] === 'removeItem').length, 1);
});

test('P14R2-PROF-16 fetchProfileFromCloud：无 userId 返回 no-user 错误', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: { id: 'u1' }, error: null }));
const mod2 = await import('./src/hooks/profile/useProfileCache');
const r = await mod2.fetchProfileFromCloud(null);
process.stdout.write(JSON.stringify({ data: r.data, errMsg: r.error && r.error.message }));
`;
  const { before } = assertEqualBoth('profile', body, 'fetch 无 userId');
  assert.equal(before.data, null);
  assert.equal(before.errMsg, 'no-user');
});

test('P14R2-PROF-17 fetchProfileFromCloud：成功返回规范化数据', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: { id: 'u1', username: 'alice' }, error: null }));
const mod2 = await import('./src/hooks/profile/useProfileCache');
const r = await mod2.fetchProfileFromCloud('u1');
process.stdout.write(JSON.stringify({ data: r.data, err: r.error }));
`;
  const { before } = assertEqualBoth('profile', body, 'fetch 成功');
  assert.equal(before.data.id, 'u1');
  assert.equal(before.data.sync_id, 'alice');
  assert.equal(before.err, null);
});

test('P14R2-PROF-18 fetchProfileFromCloud：云端 error 原样返回', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } }));
const mod2 = await import('./src/hooks/profile/useProfileCache');
const r = await mod2.fetchProfileFromCloud('u1');
process.stdout.write(JSON.stringify({ data: r.data, err: r.error }));
`;
  const { before } = assertEqualBoth('profile', body, 'fetch 云端错误');
  assert.equal(before.data, null);
  assert.equal(before.err.code, 'PGRST116');
});

test('P14R2-PROF-19 fetchProfileFromCloud：查询抛异常 → 降级为 error', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => { throw new Error('boom'); });
const mod2 = await import('./src/hooks/profile/useProfileCache');
const r = await mod2.fetchProfileFromCloud('u1');
process.stdout.write(JSON.stringify({ data: r.data, errMsg: r.error && r.error.message }));
`;
  const { before } = assertEqualBoth('profile', body, 'fetch 抛异常');
  assert.equal(before.data, null);
  assert.equal(before.errMsg, 'boom');
});

test('P14R2-PROF-20 快速重复 refresh：多次调用均按代际校验收敛', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }) });
setCloud(() => Promise.resolve({ data: { id: 'u1', username: 'alice', nickname: 'A' }, error: null }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
await m.api.refresh();
await m.api.refresh();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '快速重复 refresh');
  assert.equal(before.snap.profile.id, 'u1');
  assert.equal(before.snap.loading, false);
});

test('P14R2-PROF-21 A→B→A：回到 A 后读取 A 缓存，B 结果不污染', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({
  '@user_profile_cache_v2_u1': JSON.stringify({ id: 'u1', username: 'alice' }),
  '@user_profile_cache_v2_u2': JSON.stringify({ id: 'u2', username: 'bob' }),
});
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const rt = createHookRuntime();
let api;
let user = { id: 'u1' };
rt.render(() => { api = useProfileCache(user); });
await drain();
rt.settle();
const s1 = api.profile ? api.profile.id : null;
setProfileCacheOwner('u2');
user = { id: 'u2' };
rt.rerender();
await drain();
rt.settle();
const s2 = api.profile ? api.profile.id : null;
setProfileCacheOwner('u1');
user = { id: 'u1' };
rt.rerender();
await drain();
rt.settle();
const s3 = api.profile ? api.profile.id : null;
process.stdout.write(JSON.stringify({ s1, s2, s3 }));
`;
  const { before } = assertEqualBoth('profile', body, 'A→B→A');
  assert.equal(before.s1, 'u1');
  assert.equal(before.s2, 'u2');
  assert.equal(before.s3, 'u1');
});

test('P14R2-PROF-22 新账号合法请求：B 的云端结果正常写入 B 缓存', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setCloud(() => Promise.resolve({ data: { id: 'u2', username: 'bob', nickname: 'Bob' }, error: null }));
setProfileCacheOwner('u2');
const m = mountProfile({ id: 'u2' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '新账号合法请求');
  assert.equal(before.snap.profile.id, 'u2');
  const setLogs = before.log.filter((e) => e[0] === 'setItem');
  assert.equal(setLogs.length, 1);
  assert.equal(setLogs[0][1], '@user_profile_cache_v2_u2');
});

test('P14R2-PROF-23 缓存 JSON 损坏 → 视为未命中且不抛错', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': '{{{bad' });
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m), log: asLog() }));
`;
  const { before } = assertEqualBoth('profile', body, '缓存 JSON 损坏');
  assert.equal(before.snap.profile, null);
  assert.equal(before.snap.loading, false);
});

test('P14R2-PROF-24 缓存非对象 JSON → 视为未命中', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': '"just-a-string"' });
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m) }));
`;
  const { before } = assertEqualBoth('profile', body, '缓存非对象');
  assert.equal(before.snap.profile, null);
});

test('P14R2-PROF-25 setProfileCacheOwner 代际语义', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
const g0 = getProfileCacheGeneration();
const g1 = setProfileCacheOwner('u1');
const g2 = setProfileCacheOwner('u1');
const g3 = setProfileCacheOwner('u1', true);
const g4 = setProfileCacheOwner(null);
const g5 = setProfileCacheOwner(null);
process.stdout.write(JSON.stringify({ g0, g1, g2, g3, g4, g5 }));
`;
  const { before } = assertEqualBoth('profile', body, '代际语义');
  assert.equal(before.g1, before.g0 + 1);
  assert.equal(before.g2, before.g1);
  assert.equal(before.g3, before.g2 + 1);
  assert.equal(before.g4, before.g3 + 1);
  assert.equal(before.g5, before.g4);
});

// ===========================================================================
// D. 故障注入敏感性验证
//    证明上述等价断言确实能检测出行为差异（非无条件通过）。
//    做法：把「迁移后源码」复制到临时目录并注入一处语义改动，
//    用同一段场景脚本执行，断言结果与未注入版本不同。
// ===========================================================================
function mutateAndCompare(target, body, mutate, label) {
  const dir = buildSandbox('after', target);
  const relByTarget = {
    theme: 'src/context/ThemeContext.js',
    settings: 'src/hooks/useAppSettings.js',
    profile: 'src/hooks/profile/useProfileCache.js',
  };
  const rel = relByTarget[target];
  const p = path.join(dir, rel);
  const original = fs.readFileSync(p, 'utf8');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `故障注入未生效（未匹配到目标代码）：${label}`);
  fs.writeFileSync(p, mutated);
  const injected = runInSandbox(dir, body);
  const clean = runInSandbox(buildSandbox('after', target), body);
  assert.notDeepEqual(injected, clean, `故障注入未被检测到（断言可能过弱）：${label}`);
  return { injected, clean };
}

test('P14R2-SENS-1 Theme 故障注入：忽略持久化主题 → 断言可检测', () => {
  const body = `${THEME_PRELUDE}
resetStore({ '@app_theme_mode': 'dark' });
const m = mountTheme('light');
await drain();
m.sync();
process.stdout.write(JSON.stringify({ snap: snapTheme(m) }));
`;
  mutateAndCompare(
    'theme',
    body,
    (src) => src.replace('setThemeModeState(saved)', 'void saved'),
    'Theme 忽略持久化'
  );
});

test('P14R2-SENS-2 Settings 故障注入：不合并默认值 → 断言可检测', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({ '@app_settings': JSON.stringify({ notifySound: false }) });
const m = mountSettings();
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapSettings(m) }));
`;
  mutateAndCompare(
    'settings',
    body,
    (src) => src.replace('setSettings({ ...DEFAULT_SETTINGS, ...parsed })', 'setSettings({ ...parsed })'),
    'Settings 不合并默认值'
  );
});

test('P14R2-SENS-3 Profile 故障注入：放宽写入闸门 → 断言可检测', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({});
setProfileCacheOwner(null);
const r1 = await writeProfileCache({ id: 'u1', username: 'alice' });
process.stdout.write(JSON.stringify({ r1, log: asLog() }));
`;
  mutateAndCompare(
    'profile',
    body,
    (src) => src.replace(
      'if (!currentOwnerId || profile.id !== currentOwnerId)\n        return false;',
      'if (currentOwnerId && profile.id !== currentOwnerId)\n        return false;'
    ),
    'Profile 放宽写入闸门'
  );
});

test('P14R2-SENS-4 Profile 故障注入：去掉缓存归属校验 → 断言可检测', () => {
  const body = `${PROFILE_PRELUDE}
resetStore({ '@user_profile_cache_v2_u1': JSON.stringify({ id: 'other', username: 'evil' }) });
setCloud(() => Promise.resolve({ data: null, error: new Error('offline') }));
setProfileCacheOwner('u1');
const m = mountProfile({ id: 'u1' });
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({ snap: snapProfile(m) }));
`;
  mutateAndCompare(
    'profile',
    body,
    (src) => src.replace(
      'if (record.id && record.id !== userId)\n            return null;',
      'void 0;'
    ),
    'Profile 去掉归属校验'
  );
});

// ---------------------------------------------------------------------------
// SENS-5..7：针对本轮 Gatekeeper 实测差异的故障注入
//   把「错误实现」注入临时副本，确认新增边界测试确实能检测出差异。
//   注意：只改临时副本，绝不修改真实源码。
// ---------------------------------------------------------------------------
test('P14R2-SENS-5 Theme 故障注入：String(mode) 吞掉 Symbol TypeError → 断言可检测', () => {
  const body = `${THEME_PRELUDE}
resetStore({});
const m = mountTheme('light');
await drain();
m.sync();
let err = null;
try {
  m.ctx.setThemeMode(Symbol('invalid'));
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.sync();
process.stdout.write(JSON.stringify({
  err,
  snap: snapTheme(m),
  setItemCount: asLog().filter((e) => e[0] === 'setItem').length,
}));
`;
  // 注入错误实现：把 `${mode}` 改回 `${String(mode)}`（本轮 Gatekeeper 发现的差异）
  mutateAndCompare(
    'theme',
    body,
    (src) => src.replace('${mode}，已忽略', '${String(mode)}，已忽略'),
    'Theme String(mode) 吞掉 Symbol TypeError'
  );
});

test('P14R2-SENS-6 Settings 故障注入：typeof 过滤拒绝对象键 → 断言可检测', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
let err = null;
try {
  m.api.updateSetting({ toString: () => 'notifySound' }, false);
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.rt.settle();
const setLogs = asLog().filter((e) => e[0] === 'setItem');
process.stdout.write(JSON.stringify({
  err,
  snap: snapSettings(m),
  setItemCount: setLogs.length,
  lastWritten: setLogs.length ? JSON.parse(setLogs[setLogs.length - 1][2]) : null,
}));
`;
  // 注入错误实现：给 isSettingsKey 加回 `typeof key === 'string'` 过滤
  // （本轮 Gatekeeper 发现的差异）。转译后该函数为单行箭头函数。
  mutateAndCompare(
    'settings',
    body,
    (src) => src.replace(
      'const isSettingsKey = (key) => key in DEFAULT_SETTINGS;',
      'const isSettingsKey = (key) => typeof key === "string" && key in DEFAULT_SETTINGS;'
    ),
    'Settings typeof 过滤拒绝对象键'
  );
});

test('P14R2-SENS-7 Settings 故障注入：String(key) 吞掉 Symbol TypeError → 断言可检测', () => {
  const body = `${SETTINGS_PRELUDE}
resetStore({});
const m = mountSettings();
await drain();
m.rt.settle();
let err = null;
try {
  m.api.updateSetting(Symbol('invalid'), 123);
} catch (e) {
  err = { name: e && e.name, message: e && e.message };
}
await drain();
m.rt.settle();
process.stdout.write(JSON.stringify({
  err,
  snap: snapSettings(m),
  setItemCount: asLog().filter((e) => e[0] === 'setItem').length,
}));
`;
  mutateAndCompare(
    'settings',
    body,
    (src) => src.replace('${key}，已忽略', '${String(key)}，已忽略'),
    'Settings String(key) 吞掉 Symbol TypeError'
  );
});

// --- END OF FILE tests/security/p14r2SettingsProfileMigrationEquivalence.test.mjs ---