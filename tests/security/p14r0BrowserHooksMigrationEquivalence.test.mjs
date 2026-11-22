// --- START OF FILE tests/security/p14r0BrowserHooksMigrationEquivalence.test.mjs ---
/**
 * P1.4 R0 — 浏览器 Hooks 成批 JS → TypeScript 迁移 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前实现：冻结基线 `tests/fixtures/p14r0/before/hooks__browser__useX.js`
 *       （P1.3 全部修复后的最新 JS 源码，逐字节冻结）
 *     · 迁移后实现：当前 `src/hooks/browser/useX.ts`
 *       （严格 TypeScript，Node 原生类型剥离执行）
 *   对同一组输入比较**完整可观测结果**（状态 / Ref / 副作用序列 / 定时器 / Cleanup /
 *   异常语义 / 公开接口形状）。
 *
 * 覆盖 4 个 Hook：
 *   · useBrowserNavigation（导航域）
 *   · useBrowserProgress（进度条动画域）
 *   · useAdBlocker（广告拦截域）
 *   · useBrowserSniffer（视频嗅探域）
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实 Hook 源码：
 *   该运行时实现了 useState / useRef / useEffect / useCallback / useMemo / useContext /
 *   createContext / render / rerender / flushEffects / settle / unmount 的最小语义，
 *   用于在 Node 环境中真实调用 Hook 并观察其状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证 Hook 源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / AsyncStorage。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行 Hook 源码，不复制内部函数做模拟。
 *   · 迁移前后使用同一段场景脚本，仅被测源码路径不同。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r0/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__browser__useBrowserNavigation.js':
    '22092a184c8f7d7e363cde0c444c616506cc9f68b5566a77b1e8aab39321ff10',
  'hooks__browser__useBrowserProgress.js':
    'b4bb416a80edfc0a7aae2200ef1b97beacf117f68bbd840eb5bdf6ca3a88fe64',
  'hooks__browser__useAdBlocker.js':
    '67158f163b61d2bea2a2f1e183e4f1530eccf20f621c5267b2c3711e14d7816f',
  'hooks__browser__useBrowserSniffer.js':
    'ae4b3432f5e6f3e52dda2d687d10905be534c0da96326af31cd8b6b839863373',
};

test('P14R0-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 P1.3 测试同构，独立复制以保持本测试自包含）
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
      // 首次挂载必须记录 deps，否则后续 rerender 时 shallowEqual(undefined, deps)
      // 恒为 false，会误判为依赖变化而重复执行 effect（并触发上一次 cleanup）。
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
//   mode = 'after'  → 使用当前真实源码（迁移后 TS，含 P1.3 纯函数模块）
// ---------------------------------------------------------------------------
function buildSandbox(mode, hookName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r0-${hookName}-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // react stub：Hook 运行时单例
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

  // react-native stub：记录型 Platform / Keyboard / LayoutAnimation / BackHandler / Animated
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __log = [];
export const Platform = { OS: process.env.P14R0_PLATFORM_OS || 'ios' };
export const Keyboard = { dismiss() { __log.push(['keyboard.dismiss']); } };
export const LayoutAnimation = {
  Presets: { easeInEaseOut: 'easeInEaseOut' },
  configureNext(preset) { __log.push(['layoutAnimation', preset]); },
};
export const BackHandler = {
  addEventListener(type, cb) { __log.push(['backHandler.add', type]); return { remove() { __log.push(['backHandler.remove', type]); } }; },
};
// Animated stub：记录 setValue / timing / interpolate / stopAnimation
export const Animated = {
  Value: class AnimatedValue {
    constructor(v) { this.__v = v; this.__calls = []; }
    setValue(v) { this.__v = v; this.__calls.push(['setValue', v]); }
    stopAnimation() { this.__calls.push(['stopAnimation']); }
    interpolate(cfg) { this.__calls.push(['interpolate', cfg]); return { __interpolated: cfg }; }
  },
  timing(value, cfg) {
    globalThis.__ANIM_LOG__.push(['timing', cfg.toValue, cfg.duration, cfg.useNativeDriver]);
    return { start(cb) { globalThis.__ANIM_LOG__.push(['start']); if (typeof cb === 'function') cb(); } };
  },
};
export default { Platform, Keyboard, LayoutAnimation, BackHandler, Animated };
`,
  });

  // expo-router stub：记录 router.replace / router.back；navigation.setOptions
  mk('expo-router', {
    'package.json': JSON.stringify({ name: 'expo-router', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export function useRouter() {
  return {
    replace(p) { globalThis.__ROUTER_LOG__.push(['replace', p]); },
    back() { globalThis.__ROUTER_LOG__.push(['back']); },
  };
}
export function useNavigation() {
  return { setOptions(o) { globalThis.__NAV_OPTS_LOG__.push(o); } };
}
export default { useRouter, useNavigation };
`,
  });

  // expo-haptics stub：记录调用
  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export async function impactAsync(style) { globalThis.__HAPTIC_LOG__.push(['impact', style]); }
export async function notificationAsync(type) { globalThis.__HAPTIC_LOG__.push(['notification', type]); }
export async function selectionAsync() { globalThis.__HAPTIC_LOG__.push(['selection']); }
export default { ImpactFeedbackStyle, NotificationFeedbackType, impactAsync, notificationAsync, selectionAsync };
`,
  });

  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(relSrc, dst);
  };

  // 常量模块（真实源码，纯函数无原生依赖）
  copyFile(
    path.join(repoRoot, 'src/constants/browser/index.ts'),
    'src/constants/browser/index.ts'
  );

  // 脚本模块（真实源码，纯字符串工厂）
  for (const f of [
    'index.ts',
    'adCleanup.ts',
    'adDomWatcher.ts',
    'adGuard.ts',
    'clickHijackGuard.ts',
    'desktopSpoof.ts',
    'manualSniff.ts',
    'passiveSniffer.ts',
    'removeAdStyle.ts',
    'hiddenSnifferScripts.ts',
  ]) {
    copyFile(path.join(repoRoot, `src/scripts/browser/${f}`), `src/scripts/browser/${f}`);
  }

  // 类型模块（仅类型，运行时为空；复制以支持潜在 import type 解析）
  copyFile(path.join(repoRoot, 'src/types/browser.ts'), 'src/types/browser.ts');

  // 被测 Hook 源码 + 其 P1.3 纯函数依赖
  const hookDeps = {
    useBrowserNavigation: ['navigationUrlLogic.ts'],
    useBrowserProgress: [],
    useAdBlocker: ['adBlockDecision.ts'],
    useBrowserSniffer: ['snifferMediaLogic.ts'],
  };

  // P1.3 纯函数依赖：迁移前 JS 与迁移后 TS 都 import 同一批模块，
  // 两种模式都必须复制，否则 before 沙箱无法解析依赖。
  for (const dep of hookDeps[hookName]) {
    copyFile(
      path.join(repoRoot, `src/hooks/browser/${dep}`),
      `src/hooks/browser/${dep}`
    );
  }

  if (mode === 'before') {
    copyFile(
      path.join(beforeDir, `hooks__browser__${hookName}.js`),
      `src/hooks/browser/${hookName}.js`
    );
  } else {
    copyFile(
      path.join(repoRoot, `src/hooks/browser/${hookName}.ts`),
      `src/hooks/browser/${hookName}.ts`
    );
  }

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}}return n(s,c);}`
  );
  return dir;
}

function runInSandbox(dir, body, platformOs) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(
    entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
  );
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, P14R0_PLATFORM_OS: platformOs || 'ios' },
  });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

// ---------------------------------------------------------------------------
// 通用：在 before / after 两个沙箱中执行同一段场景脚本，返回可观测快照
// ---------------------------------------------------------------------------
function runBoth(hookName, body, platformOs) {
  const beforeDirSandbox = buildSandbox('before', hookName);
  const afterDirSandbox = buildSandbox('after', hookName);
  const before = runInSandbox(beforeDirSandbox, body, platformOs);
  const after = runInSandbox(afterDirSandbox, body, platformOs);
  return { before, after };
}

function assertEqualBoth(hookName, body, platformOs, label) {
  const { before, after } = runBoth(hookName, body, platformOs);
  assert.deepEqual(after, before, `${hookName} 迁移前后可观测结果必须一致：${label}`);
  return { before, after };
}

// ===========================================================================
// useBrowserNavigation — 导航域
// ===========================================================================
const NAV_PRELUDE = `
const { createHookRuntime } = await import('react');
const { useBrowserNavigation } = await import('./src/hooks/browser/useBrowserNavigation');

globalThis.__ROUTER_LOG__ = [];
globalThis.__NAV_OPTS_LOG__ = [];
globalThis.__HAPTIC_LOG__ = [];
globalThis.__LOAD_LOG__ = [];
globalThis.__EMIT_LOG__ = [];
globalThis.__HISTORY_LOG__ = [];
globalThis.__VISITED_LOG__ = [];
globalThis.__INJECT_LOG__ = [];
globalThis.__RELOAD_LOG__ = [];

globalThis.__captureThrow__ = (fn) => {
  try { fn(); return null; } catch (e) { return { name: e && e.name, message: e && e.message }; }
};

function makeWebView() {
  return {
    goBack() { globalThis.__NAV_OPTS_LOG__.push(['goBack']); },
    goForward() { globalThis.__NAV_OPTS_LOG__.push(['goForward']); },
    reload() { globalThis.__RELOAD_LOG__.push(['reload']); },
    injectJavaScript(s) { globalThis.__INJECT_LOG__.push(s); },
  };
}

// 代理对象：属性访问始终转发到「最新一次 render 的 api」。
// 必须用 Proxy 而非 getter —— 测试里 const { api } = mountXxx() 解构会
// 立即求值 getter 并把首次 render 的 api 固化为局部常量，导致 rerender
// 后的状态读取全部过期（曾导致 SNIFF-3 / SENS-2 / SENS-3 假失败）。
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

function mountNav(opts) {
  const rt = createHookRuntime();
  const webViewRef = { current: opts.webView === false ? null : makeWebView() };
  const params = {
    startUrl: opts.startUrl,
    webViewRef,
    loadUrl: (u, p) => globalThis.__LOAD_LOG__.push([u, p === undefined ? null : p]),
    emitCommand: (t, time, u) => globalThis.__EMIT_LOG__.push([t, time, u]),
    addHistory: (u, t) => globalThis.__HISTORY_LOG__.push([u, t === undefined ? null : t]),
    closeMenu: () => globalThis.__NAV_OPTS_LOG__.push(['closeMenu']),
    onUrlVisited: opts.onUrlVisited === false ? undefined : (u) => globalThis.__VISITED_LOG__.push(u),
  };
  let api;
  rt.render(() => { api = useBrowserNavigation(params); });
  return { rt, api: liveApi(() => api), webViewRef };
}

function snapshot(api) {
  return {
    currentUrl: api.currentUrl,
    inputUrl: api.inputUrl,
    canGoBack: api.canGoBack,
    canGoForward: api.canGoForward,
    isDesktopMode: api.isDesktopMode,
    actualLoadedUrl: api.actualLoadedUrl.current,
    actualLoadedTitle: api.actualLoadedTitle.current,
    keys: Object.keys(api).sort(),
  };
}
`;

test('P14R0-NAV-1 初始状态与公开接口形状一致', () => {
  const body = `${NAV_PRELUDE}
const { api } = mountNav({ startUrl: 'https://example.com' });
process.stdout.write(JSON.stringify({ snap: snapshot(api) }));
`;
  const { before } = assertEqualBoth('useBrowserNavigation', body, 'ios', '初始状态');
  assert.deepEqual(before.snap.keys, [
    'actualLoadedTitle', 'actualLoadedUrl', 'canGoBack', 'canGoForward', 'currentUrl',
    'goCinema', 'handleClose', 'handleGoBack', 'handleGoForward', 'handleNavigationStateChange',
    'handleSubmitUrl', 'injectUrl', 'inputUrl', 'isDesktopMode', 'launchTimerRef',
    'loadUrlInWebView', 'setInputUrl', 'toggleDesktopMode',
  ]);
});

test('P14R0-NAV-2 handleSubmitUrl 各分支副作用序列一致', () => {
  const body = `${NAV_PRELUDE}
const results = [];
for (const input of ['', '   ', 'http://a.com/x', 'http://a.com/v.mp4', 'https://a.com/v.m3u8?x=1', 'https://a.com/page', 'hello world', 'HTTP://B.COM']) {
  globalThis.__ROUTER_LOG__.length = 0;
  globalThis.__LOAD_LOG__.length = 0;
  globalThis.__EMIT_LOG__.length = 0;
  globalThis.__HAPTIC_LOG__.length = 0;
  const { rt, api } = mountNav({ startUrl: 'https://start.example' });
  api.setInputUrl(input);
  rt.settle();
  const thrown = globalThis.__captureThrow__(() => api.handleSubmitUrl());
  rt.settle();
  results.push({
    input,
    thrown,
    snap: snapshot(api),
    router: globalThis.__ROUTER_LOG__.slice(),
    load: globalThis.__LOAD_LOG__.slice(),
    emit: globalThis.__EMIT_LOG__.slice(),
    haptic: globalThis.__HAPTIC_LOG__.slice(),
  });
}
process.stdout.write(JSON.stringify({ results }));
`;
  assertEqualBoth('useBrowserNavigation', body, 'ios', 'handleSubmitUrl 分支');
});

test('P14R0-NAV-3 toggleDesktopMode 主机名改写 + 注入/reload 一致', () => {
  const body = `${NAV_PRELUDE}
const results = [];
for (const start of ['https://m.example.com/a', 'https://wap.example.com/b', 'https://www.example.com/c', 'https://example.com/d', 'https://x.com/path://m.foo']) {
  globalThis.__INJECT_LOG__.length = 0;
  globalThis.__RELOAD_LOG__.length = 0;
  globalThis.__HAPTIC_LOG__.length = 0;
  const { rt, api } = mountNav({ startUrl: start });
  api.toggleDesktopMode();
  rt.settle();
  results.push({
    start,
    snap: snapshot(api),
    inject: globalThis.__INJECT_LOG__.slice(),
    reload: globalThis.__RELOAD_LOG__.slice(),
    haptic: globalThis.__HAPTIC_LOG__.slice(),
  });
}
process.stdout.write(JSON.stringify({ results }));
`;
  assertEqualBoth('useBrowserNavigation', body, 'ios', 'toggleDesktopMode');
});

test('P14R0-NAV-4 handleNavigationStateChange 同步 + 历史写入一致', () => {
  const body = `${NAV_PRELUDE}
const results = [];
const cases = [
  { url: 'https://new.example.com', title: '  Title  ', loading: false, canGoBack: true, canGoForward: false },
  { url: 'https://same.example.com', title: '', loading: false, canGoBack: false, canGoForward: true },
  { url: 'https://cn.bing.com/search?q=x', title: 'Bing', loading: false, canGoBack: true, canGoForward: true },
  { url: 'http://insecure.com', title: 'X', loading: false, canGoBack: true, canGoForward: false },
  { url: 'https://loading.example.com', title: 'L', loading: true, canGoBack: true, canGoForward: false },
  { url: '', title: 'E', loading: false, canGoBack: false, canGoForward: false },
];
for (const c of cases) {
  globalThis.__HISTORY_LOG__.length = 0;
  globalThis.__VISITED_LOG__.length = 0;
  const { rt, api } = mountNav({ startUrl: 'https://same.example.com' });
  api.handleNavigationStateChange(c);
  rt.settle();
  results.push({
    c,
    snap: snapshot(api),
    history: globalThis.__HISTORY_LOG__.slice(),
    visited: globalThis.__VISITED_LOG__.slice(),
  });
}
process.stdout.write(JSON.stringify({ results }));
`;
  assertEqualBoth('useBrowserNavigation', body, 'ios', 'handleNavigationStateChange');
});

test('P14R0-NAV-5 injectUrl / loadUrlInWebView 状态变化一致', () => {
  const body = `${NAV_PRELUDE}
const results = [];
for (const u of ['https://safe.example.com', 'javascript:alert(1)', 'http://insecure.com']) {
  const { rt, api } = mountNav({ startUrl: 'https://start.example' });
  api.injectUrl(u);
  rt.settle();
  results.push({ op: 'injectUrl', u, snap: snapshot(api) });
}
for (const u of ['https://loaded.example.com']) {
  const { rt, api } = mountNav({ startUrl: 'https://start.example' });
  api.loadUrlInWebView(u);
  rt.settle();
  results.push({ op: 'loadUrlInWebView', u, snap: snapshot(api) });
}
process.stdout.write(JSON.stringify({ results }));
`;
  assertEqualBoth('useBrowserNavigation', body, 'ios', 'injectUrl/loadUrlInWebView');
});

test('P14R0-NAV-6 iOS goCinema 150ms 延迟 / Android 立即（定时器行为）', () => {
  const body = `${NAV_PRELUDE}
const results = [];
for (const os of ['ios', 'android']) {
  globalThis.__ROUTER_LOG__.length = 0;
  const { rt, api } = mountNav({ startUrl: 'https://start.example' });
  api.goCinema();
  const immediate = globalThis.__ROUTER_LOG__.slice();
  rt.unmount();
  results.push({ os, immediate });
}
process.stdout.write(JSON.stringify({ results }));
`;
  // 注意：Platform.OS 由沙箱环境变量决定，故分别以 ios / android 运行
  const ios = runBoth('useBrowserNavigation', body, 'ios');
  assert.deepEqual(ios.after, ios.before, 'iOS goCinema 定时器行为一致');
  const android = runBoth('useBrowserNavigation', body, 'android');
  assert.deepEqual(android.after, android.before, 'Android goCinema 立即行为一致');
});

test('P14R0-NAV-7 卸载清理定时器（Cleanup）一致', () => {
  const body = `${NAV_PRELUDE}
const { rt, api } = mountNav({ startUrl: 'https://start.example' });
api.goCinema();
const beforeUnmount = globalThis.__ROUTER_LOG__.slice();
rt.unmount();
process.stdout.write(JSON.stringify({ beforeUnmount, launchTimerNull: api.launchTimerRef.current === null }));
`;
  assertEqualBoth('useBrowserNavigation', body, 'ios', '卸载清理');
});

// ===========================================================================
// useBrowserProgress — 进度条动画域
// ===========================================================================
const PROGRESS_PRELUDE = `
const { createHookRuntime } = await import('react');
const { useBrowserProgress } = await import('./src/hooks/browser/useBrowserProgress');

globalThis.__ANIM_LOG__ = [];
globalThis.__FINISH_LOG__ = [];

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

function mountProgress(opts) {
  const rt = createHookRuntime();
  let api;
  rt.render(() => { api = useBrowserProgress(opts); });
  return { rt, api: liveApi(() => api) };
}
`;

test('P14R0-PROG-1 初始动画值与公开接口形状一致', () => {
  const body = `${PROGRESS_PRELUDE}
const { api } = mountProgress({});
process.stdout.write(JSON.stringify({
  keys: Object.keys(api).sort(),
  animValue: api.progressAnim.__v,
  opacityValue: api.progressOpacity.__v,
  width: api.progressWidth,
}));
`;
  const { before } = assertEqualBoth('useBrowserProgress', body, 'ios', '初始动画值');
  assert.deepEqual(before.keys, [
    'handleLoadEnd', 'handleLoadProgress', 'handleLoadStart',
    'progressAnim', 'progressOpacity', 'progressWidth',
  ]);
});

test('P14R0-PROG-2 onLoadStart / onLoadProgress / onLoadEnd 动画调用序列一致', () => {
  const body = `${PROGRESS_PRELUDE}
globalThis.__ANIM_LOG__.length = 0;
globalThis.__FINISH_LOG__.length = 0;
const { rt, api } = mountProgress({ onFinish: (e) => globalThis.__FINISH_LOG__.push(e) });
api.handleLoadStart();
api.handleLoadProgress({ nativeEvent: { progress: 0.42 } });
api.handleLoadProgress({ nativeEvent: { progress: 'bad' } });
api.handleLoadEnd({ nativeEvent: { url: 'https://x' } });
rt.settle();
process.stdout.write(JSON.stringify({
  anim: globalThis.__ANIM_LOG__.slice(),
  finish: globalThis.__FINISH_LOG__.slice(),
  animValue: api.progressAnim.__v,
  opacityValue: api.progressOpacity.__v,
}));
`;
  assertEqualBoth('useBrowserProgress', body, 'ios', '动画调用序列');
});

test('P14R0-PROG-3 卸载停止动画（Cleanup）一致', () => {
  const body = `${PROGRESS_PRELUDE}
const { rt, api } = mountProgress({});
api.handleLoadStart();
rt.unmount();
process.stdout.write(JSON.stringify({
  animCalls: api.progressAnim.__calls.slice(),
  opacityCalls: api.progressOpacity.__calls.slice(),
}));
`;
  assertEqualBoth('useBrowserProgress', body, 'ios', '卸载停止动画');
});

// ===========================================================================
// useAdBlocker — 广告拦截域
// ===========================================================================
const AD_PRELUDE = `
const { createHookRuntime } = await import('react');
const { useAdBlocker } = await import('./src/hooks/browser/useAdBlocker');

globalThis.__HAPTIC_LOG__ = [];
globalThis.__INJECT_LOG__ = [];

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

function makeWebView() {
  return { injectJavaScript(s) { globalThis.__INJECT_LOG__.push(s); } };
}

function mountAd(opts) {
  const rt = createHookRuntime();
  const webViewRef = { current: opts && opts.webView === false ? null : makeWebView() };
  let api;
  rt.render(() => { api = useAdBlocker(webViewRef); });
  return { rt, api: liveApi(() => api), webViewRef };
}
`;

test('P14R0-AD-1 初始状态与公开接口形状一致', () => {
  const body = `${AD_PRELUDE}
const { api } = mountAd({});
process.stdout.write(JSON.stringify({
  keys: Object.keys(api).sort(),
  isAdBlockEnabled: api.isAdBlockEnabled,
  blockedAdCount: api.blockedAdCount,
}));
`;
  const { before } = assertEqualBoth('useAdBlocker', body, 'ios', '初始状态');
  assert.deepEqual(before.keys, [
    'blockedAdCount', 'bumpBlockedAdCount', 'handleShouldStartLoad',
    'isAdBlockEnabled', 'runAdCleanup', 'toggleAdBlock',
  ]);
});

test('P14R0-AD-2 handleShouldStartLoad 判定 + 计数合并一致', () => {
  const body = `${AD_PRELUDE}
const results = [];
for (const req of [
  { url: 'https://safe.example.com' },
  { url: 'https://doubleclick.net/ad.js' },
  { url: 'http://insecure.com' },
  null,
  undefined,
  {},
]) {
  const { rt, api } = mountAd({});
  const allow = api.handleShouldStartLoad(req);
  rt.settle();
  results.push({ req: req === undefined ? '__undef__' : req, allow, count: api.blockedAdCount });
}
process.stdout.write(JSON.stringify({ results }));
`;
  assertEqualBoth('useAdBlocker', body, 'ios', 'handleShouldStartLoad');
});

test('P14R0-AD-3 toggleAdBlock 开关 + 注入恢复脚本一致', () => {
  const body = `${AD_PRELUDE}
globalThis.__INJECT_LOG__.length = 0;
globalThis.__HAPTIC_LOG__.length = 0;
const { rt, api } = mountAd({});
api.toggleAdBlock();
rt.settle();
const afterOff = { enabled: api.isAdBlockEnabled, inject: globalThis.__INJECT_LOG__.slice(), haptic: globalThis.__HAPTIC_LOG__.slice() };
api.toggleAdBlock();
rt.settle();
const afterOn = { enabled: api.isAdBlockEnabled, inject: globalThis.__INJECT_LOG__.slice(), haptic: globalThis.__HAPTIC_LOG__.slice() };
process.stdout.write(JSON.stringify({ afterOff, afterOn }));
`;
  assertEqualBoth('useAdBlocker', body, 'ios', 'toggleAdBlock');
});

test('P14R0-AD-4 runAdCleanup 注入清理脚本一致', () => {
  const body = `${AD_PRELUDE}
globalThis.__INJECT_LOG__.length = 0;
const { rt, api } = mountAd({});
api.runAdCleanup();
rt.settle();
const withWebView = globalThis.__INJECT_LOG__.slice();
globalThis.__INJECT_LOG__.length = 0;
const noRef = mountAd({ webView: false });
noRef.api.runAdCleanup();
noRef.rt.settle();
const withoutWebView = globalThis.__INJECT_LOG__.slice();
process.stdout.write(JSON.stringify({ withWebView, withoutWebView }));
`;
  assertEqualBoth('useAdBlocker', body, 'ios', 'runAdCleanup');
});

// ---------------------------------------------------------------------------
// useBrowserSniffer
// ---------------------------------------------------------------------------

const SNIFF_PRELUDE = `
const { createHookRuntime } = await import('react');
const { useBrowserSniffer } = await import('./src/hooks/browser/useBrowserSniffer');

globalThis.__INJECT_LOG__ = [];
globalThis.__HAPTIC_LOG__ = [];

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

function mountSniff(opts) {
  const found = [];
  const onMediaFound = (list) => { found.push(list.map((m) => m.url)); };
  const rt = createHookRuntime();
  let api;
  rt.render(() => { api = useBrowserSniffer({ onMediaFound }); });
  return { rt, api: liveApi(() => api), found };
}
function msg(payload) {
  return { nativeEvent: { data: JSON.stringify(payload) } };
}
`;

test('P14R0-SNIFF-1 初始状态与公开接口形状一致', () => {
  const body = `${SNIFF_PRELUDE}
const { api } = mountSniff({});
process.stdout.write(JSON.stringify({
  keys: Object.keys(api).sort(),
  list: api.sniffedMediaList,
  filterFormat: api.filterFormat,
  isSniffing: api.isSniffing,
  filtered: api.filteredMediaList,
  counts: api.formatCounts,
}));
`;
  const { before } = assertEqualBoth('useBrowserSniffer', body, 'ios', '初始状态');
  assert.deepEqual(before.keys, [
    'clearSniffedMedia', 'filterFormat', 'filteredMediaList', 'formatCounts',
    'handleWebMessage', 'isSniffing', 'removeMediaItem', 'setFilterFormat',
    'sniffedMediaList', 'triggerManualSniff',
  ]);
});

test('P14R0-SNIFF-2 handleWebMessage 协议分支一致（VIDEO_FOUND / LIST / MANUAL_DONE / 非法）', () => {
  const body = `${SNIFF_PRELUDE}
const { rt, api, found } = mountSniff({});
const out = [];
out.push({ step: 'video', ret: api.handleWebMessage(msg({ type: 'VIDEO_FOUND', url: 'https://cdn.example.com/a.mp4' })) });
rt.settle();
out.push({ step: 'list', ret: api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['https://cdn.example.com/b.m3u8', 'https://cdn.example.com/a.mp4'] })) });
rt.settle();
out.push({ step: 'manual', ret: api.handleWebMessage(msg({ type: 'MANUAL_SNIFF_DONE' })) });
rt.settle();
out.push({ step: 'unknown', ret: api.handleWebMessage(msg({ type: 'NOPE' })) });
out.push({ step: 'badjson', ret: api.handleWebMessage({ nativeEvent: { data: 'not-json' } }) });
out.push({ step: 'empty', ret: api.handleWebMessage({ nativeEvent: { data: '' } }) });
rt.settle();
process.stdout.write(JSON.stringify({
  out,
  list: api.sniffedMediaList.map((m) => m.url),
  counts: api.formatCounts,
  found,
}));
`;
  assertEqualBoth('useBrowserSniffer', body, 'ios', 'handleWebMessage');
});

test('P14R0-SNIFF-3 removeMediaItem / clearSniffedMedia / setFilterFormat 一致', () => {
  const body = `${SNIFF_PRELUDE}
const { rt, api } = mountSniff({});
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: [
  'https://cdn.example.com/a.mp4',
  'https://cdn.example.com/b.m3u8',
  'https://cdn.example.com/c.mp4',
] }));
rt.settle();
const afterAdd = api.sniffedMediaList.map((m) => m.url);
const firstId = api.sniffedMediaList[0].id;
api.removeMediaItem(firstId);
rt.settle();
const afterRemove = api.sniffedMediaList.map((m) => m.url);
api.setFilterFormat('MP4');
rt.settle();
const mp4Filtered = api.filteredMediaList.map((m) => m.url);
api.setFilterFormat('ALL');
rt.settle();
api.clearSniffedMedia();
rt.settle();
process.stdout.write(JSON.stringify({
  afterAdd, afterRemove, mp4Filtered,
  afterClear: api.sniffedMediaList,
  countsAfterClear: api.formatCounts,
}));
`;
  assertEqualBoth('useBrowserSniffer', body, 'ios', 'remove/clear/filter');
});

test('P14R0-SNIFF-4 triggerManualSniff 注入脚本 + 2000ms 兜底定时器一致', () => {
  // 使用真实 setTimeout：等待 2100ms 观察兜底定时器是否把 isSniffing 复位。
  const body = `${SNIFF_PRELUDE}
globalThis.__INJECT_LOG__.length = 0;
const { rt, api } = mountSniff({});
const webViewRef = { current: { injectJavaScript: (s) => globalThis.__INJECT_LOG__.push(s) } };
api.triggerManualSniff(webViewRef);
rt.settle();
const injected = globalThis.__INJECT_LOG__.slice();
const isSniffingAfterTrigger = api.isSniffing;
await new Promise((r) => setTimeout(r, 2100));
rt.settle();
process.stdout.write(JSON.stringify({
  injected,
  isSniffingAfterTrigger,
  isSniffingAfterTimeout: api.isSniffing,
}));
`;
  assertEqualBoth('useBrowserSniffer', body, 'ios', 'triggerManualSniff');
});

// ---------------------------------------------------------------------------
// 故障注入敏感性验证：证明测试不是无条件通过
//   做法：在 after 沙箱副本中注入一处可观测的行为偏差，验证其与 before 基线
//   产生差异；若测试对行为变化不敏感，则此处会失败。
// ---------------------------------------------------------------------------

function mutateAndCompare(hookName, relFile, from, to, body, platformOs, label) {
  const dir = buildSandbox('after', hookName);
  const target = path.join(dir, relFile);
  const original = fs.readFileSync(target, 'utf8');
  const mutated = original.replace(from, to);
  assert.notEqual(mutated, original, `故障注入必须实际改变源码：${label}`);
  fs.writeFileSync(target, mutated, 'utf8');

  const mutatedOut = runInSandbox(dir, body, platformOs);

  const baselineDir = buildSandbox('before', hookName);
  const baselineOut = runInSandbox(baselineDir, body, platformOs);

  assert.notDeepEqual(
    mutatedOut,
    baselineOut,
    `篡改后的 after 副本必须与 before 基线产生差异，否则测试无敏感性：${label}`,
  );
}

test('P14R0-SENS-1 故障注入：篡改 navigationUrlLogic 桌面主机改写应被检出', () => {
  const body = `${NAV_PRELUDE}
const { rt, api } = mountNav({ startUrl: 'https://m.example.com/a' });
api.toggleDesktopMode();
rt.settle();
process.stdout.write(JSON.stringify({ snap: snapshot(api), inject: globalThis.__INJECT_LOG__.slice() }));
`;
  // 桌面模式主机改写实际位于 navigationUrlLogic.ts（P1.3 解耦后的纯函数），
  // 把替换目标 '$1www.' 改为 '$1wwwx.'，会改变改写后的 URL。
  mutateAndCompare(
    'useBrowserNavigation',
    'src/hooks/browser/navigationUrlLogic.ts',
    "'$1www.'",
    "'$1wwwx.'",
    body,
    'ios',
    'toggleDesktopMode 主机改写',
  );
});

test('P14R0-SENS-2 故障注入：篡改 useAdBlocker 计数合并窗口应被检出', () => {
  const body = `${AD_PRELUDE}
const { rt, api } = mountAd({});
api.bumpBlockedAdCount(1);
api.bumpBlockedAdCount(1);
rt.settle();
const beforeFlush = api.blockedAdCount;
await new Promise((r) => setTimeout(r, 260));
rt.settle();
process.stdout.write(JSON.stringify({ beforeFlush, afterFlush: api.blockedAdCount }));
`;
  // 把 200ms 合并窗口改为 5000ms，260ms 后仍不会 flush，计数差异可观测。
  // 必须精确匹配定时器实参 `}, 200);`，避免命中注释中的 "200"。
  mutateAndCompare(
    'useAdBlocker',
    'src/hooks/browser/useAdBlocker.ts',
    '}, 200);',
    '}, 5000);',
    body,
    'ios',
    '计数合并窗口',
  );
});

test('P14R0-SENS-3 故障注入：篡改 useBrowserSniffer 兜底定时器应被检出', () => {
  const body = `${SNIFF_PRELUDE}
const { rt, api } = mountSniff({});
const webViewRef = { current: { injectJavaScript: () => {} } };
api.triggerManualSniff(webViewRef);
rt.settle();
const afterTrigger = api.isSniffing;
await new Promise((r) => setTimeout(r, 2100));
rt.settle();
process.stdout.write(JSON.stringify({ afterTrigger, afterTimeout: api.isSniffing }));
// 篡改副本把兜底定时器改为 60000ms，会留下一个长挂起的定时器；
// 显式退出避免子进程被该定时器拖住（不影响已写入 stdout 的观测结果）。
process.exit(0);
`;
  // 把 2000ms 兜底改为 60000ms，2100ms 后仍处于嗅探中，差异可观测
  mutateAndCompare(
    'useBrowserSniffer',
    'src/hooks/browser/useBrowserSniffer.ts',
    '2000',
    '60000',
    body,
    'ios',
    '兜底定时器',
  );
});
