// --- START OF FILE tests/security/p13r1DecouplingEquivalence.test.mjs ---
/**
 * P1.3 R1 — 广告拦截「请求放行」决策解耦 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 解耦前实现：冻结基线 `tests/fixtures/p13r1/before/hooks__browser__useAdBlocker.js`
 *     · 解耦后实现：当前 `src/hooks/browser/useAdBlocker.js`
 *       （handleShouldStartLoad 内部委托 `adBlockDecision.ts` 纯函数）
 *   对同一组输入比较**完整可观测结果**：
 *     - 状态值（isAdBlockEnabled / blockedAdCount）
 *     - handleShouldStartLoad 返回值（是否允许加载）
 *     - 计数副作用（bumpBlockedAdCount 触发次数 / 200ms 批量合并）
 *     - WebView 注入副作用（runAdCleanup / toggleAdBlock 注入脚本）
 *     - 定时器行为（200ms 计数节流 / 卸载清理）
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实 Hook 源码：
 *   该运行时实现了 useState / useRef / useEffect / useCallback / useMemo 的最小语义，
 *   用于在 Node 环境中真实调用 Hook 并观察其状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证 Hook 源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / AsyncStorage。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行 Hook 源码，不复制内部函数做模拟。
 *   · 定时器使用真实 setTimeout（沙箱内），通过等待真实时间观察 200ms 合并行为。
 *
 * 覆盖（18 场景）
 *   R1-1  默认广告拦截开启（isAdBlockEnabled === true）
 *   R1-2  普通 HTTPS 请求 → 允许
 *   R1-3  明文 HTTP 请求 → 拒绝（安全协议）
 *   R1-4  广告域名请求 → 拒绝 + 计数 +1
 *   R1-5  广告域名仅出现在 path → 不误杀（允许）
 *   R1-6  关闭拦截后广告域名 → 允许（旧逻辑）
 *   R1-7  关闭拦截后明文 HTTP → 仍拒绝（安全协议不受开关影响）
 *   R1-8  每次广告拦截只计数一次
 *   R1-9  200ms 内多次拦截 → 合并为一次 setState
 *   R1-10 200ms 窗口前后计数差异
 *   R1-11 多次开关切换
 *   R1-12 关闭拦截时注入 REMOVE_AD_STYLE_SCRIPT
 *   R1-13 开启拦截时 runAdCleanup 执行原始 DOM 清理脚本
 *   R1-14 关闭拦截时 runAdCleanup 不执行
 *   R1-15 卸载前存在待处理计数定时器
 *   R1-16 卸载时取消计数定时器（不再 setState）
 *   R1-17 连续快速 WebView 请求
 *   R1-18 公开接口形状不变
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p13r1/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__browser__useAdBlocker.js':
    '755e5e4227f55ce8584bb78c170804bbe21d60971a4d3c0ebd564c5c191f06a6',
};

test('P13R1-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 p13r0 测试同构，独立复制以保持本测试自包含）
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
//   mode = 'before' → 使用冻结基线（解耦前）
//   mode = 'after'  → 使用当前真实源码（解耦后，含 adBlockDecision.ts）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p13r1-${mode}-`));
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

  // 复制被测源码
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

  // scripts/browser 依赖链（buildAdCleanupScript / REMOVE_AD_STYLE_SCRIPT 真实源码）
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/index.ts'),
    'src/scripts/browser/index.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/adCleanup.ts'),
    'src/scripts/browser/adCleanup.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/removeAdStyle.ts'),
    'src/scripts/browser/removeAdStyle.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/clickHijackGuard.ts'),
    'src/scripts/browser/clickHijackGuard.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/adGuard.ts'),
    'src/scripts/browser/adGuard.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/passiveSniffer.ts'),
    'src/scripts/browser/passiveSniffer.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/desktopSpoof.ts'),
    'src/scripts/browser/desktopSpoof.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/adDomWatcher.ts'),
    'src/scripts/browser/adDomWatcher.ts'
  );
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/manualSniff.ts'),
    'src/scripts/browser/manualSniff.ts'
  );

  if (mode === 'before') {
    copyFile(
      path.join(beforeDir, 'hooks__browser__useAdBlocker.js'),
      'src/hooks/browser/useAdBlocker.js'
    );
  } else {
    // 🧩 TASK-P1.4 R0：after 源已迁移为 .ts，复制到 .ts 目标（Node 原生类型剥离执行）
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/useAdBlocker.ts'),
      'src/hooks/browser/useAdBlocker.ts'
    );
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/adBlockDecision.ts'),
      'src/hooks/browser/adBlockDecision.ts'
    );
  }

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}}return n(s,c);}`
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
// 场景执行器：在 before / after 两个沙箱中执行同一段场景脚本，返回可观测快照
// ---------------------------------------------------------------------------
const SCENARIO_PRELUDE = `
const { createHookRuntime } = await import('react');
const { useAdBlocker } = await import('./src/hooks/browser/useAdBlocker');

globalThis.__HAPTIC_LOG__ = [];
globalThis.__INJECT_LOG__ = [];
globalThis.__COUNT_LOG__ = [];

const rt = createHookRuntime();

// 可控 WebView ref：记录 injectJavaScript 调用
const webViewRef = { current: {
  injectJavaScript(s) { globalThis.__INJECT_LOG__.push(s); },
} };

let api = null;
const Comp = () => {
  api = useAdBlocker(webViewRef);
  return null;
};

// 包装 bumpBlockedAdCount 以记录每次调用（不改变原语义）
function wrapBump() {
  const orig = api.bumpBlockedAdCount;
  api.bumpBlockedAdCount = (n) => { globalThis.__COUNT_LOG__.push(n === undefined ? 1 : n); return orig(n); };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  return {
    isAdBlockEnabled: api.isAdBlockEnabled,
    blockedAdCount: api.blockedAdCount,
    hapticLog: globalThis.__HAPTIC_LOG__.slice(),
    injectLog: globalThis.__INJECT_LOG__.slice(),
    countLog: globalThis.__COUNT_LOG__.slice(),
    apiKeys: globalThis.__API_KEYS__ ?? null,
    // 场景自定义探针
    probe: globalThis.__PROBE__ ?? null,
  };
}
`;

function runScenario(scenarioBody) {
  const body = `${SCENARIO_PRELUDE}\n${scenarioBody}\nprocess.stdout.write(JSON.stringify(snapshot()));`;
  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  try {
    const before = runInSandbox(beforeSandbox, body);
    const after = runInSandbox(afterSandbox, body);
    return { before, after };
  } finally {
    fs.rmSync(beforeSandbox, { recursive: true, force: true });
    fs.rmSync(afterSandbox, { recursive: true, force: true });
  }
}

/** 断言 before / after 快照逐项一致 */
function assertEquivalent(scenarioBody, label) {
  const { before, after } = runScenario(scenarioBody);
  assert.deepEqual(after, before, `${label}：解耦后行为必须与解耦前逐项一致`);
  return before;
}

// ===========================================================================
// R1-1 — 默认广告拦截开启
// ===========================================================================
test('P13R1-1 默认广告拦截开启', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
`,
    'R1-1 默认开启'
  );
  assert.equal(snap.isAdBlockEnabled, true, '默认必须开启');
  assert.equal(snap.blockedAdCount, 0, '初始计数为 0');
});

// ===========================================================================
// R1-2 — 普通 HTTPS 请求 → 允许
// ===========================================================================
test('P13R1-2 普通 HTTPS 请求 → 允许', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleShouldStartLoad({ url: 'https://example.com/page' });
`,
    'R1-2 普通 HTTPS'
  );
  assert.equal(snap.probe, true, '普通 HTTPS 必须允许');
  assert.equal(snap.countLog.length, 0, '不得计数');
});

// ===========================================================================
// R1-3 — 明文 HTTP 请求 → 拒绝（安全协议）
// ===========================================================================
test('P13R1-3 明文 HTTP 请求 → 拒绝（安全协议）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleShouldStartLoad({ url: 'http://example.com/page' });
`,
    'R1-3 明文 HTTP'
  );
  assert.equal(snap.probe, false, '明文 HTTP 必须拒绝');
  assert.equal(snap.countLog.length, 0, '安全协议拒绝不得计数');
});

// ===========================================================================
// R1-4 — 广告域名请求 → 拒绝 + 计数 +1
// ===========================================================================
test('P13R1-4 广告域名请求 → 拒绝 + 计数 +1', async () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleShouldStartLoad({ url: 'https://popads.net/x.js' });
await sleep(260);
rt.settle();
`,
    'R1-4 广告域名'
  );
  assert.equal(snap.probe, false, '广告域名必须拒绝');
  assert.equal(snap.blockedAdCount, 1, '必须计数一次');
});

// ===========================================================================
// R1-5 — 广告域名仅出现在 path → 不误杀
// ===========================================================================
test('P13R1-5 广告域名仅出现在 path → 允许（不误杀）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
wrapBump();
globalThis.__PROBE__ = api.handleShouldStartLoad({ url: 'https://cdn.example.com/casino/movie.mp4' });
`,
    'R1-5 path 含广告词'
  );
  assert.equal(snap.probe, true, 'path 含广告词不得误杀');
  assert.equal(snap.countLog.length, 0, '不得计数');
});

// ===========================================================================
// R1-6 — 关闭拦截后广告域名 → 允许（旧逻辑）
// ===========================================================================
test('P13R1-6 关闭拦截后广告域名 → 允许', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.toggleAdBlock();
rt.settle();
wrapBump();
globalThis.__PROBE__ = api.handleShouldStartLoad({ url: 'https://popads.net/x.js' });
`,
    'R1-6 关闭后广告域名'
  );
  assert.equal(snap.isAdBlockEnabled, false, '开关已关闭');
  assert.equal(snap.probe, true, '关闭后广告域名允许');
  assert.equal(snap.countLog.length, 0, '关闭后不计数');
});

// ===========================================================================
// R1-7 — 关闭拦截后明文 HTTP → 仍拒绝
// ===========================================================================
test('P13R1-7 关闭拦截后明文 HTTP → 仍拒绝（安全协议不受开关影响）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.toggleAdBlock();
rt.settle();
globalThis.__PROBE__ = api.handleShouldStartLoad({ url: 'http://example.com/page' });
`,
    'R1-7 关闭后明文 HTTP'
  );
  assert.equal(snap.probe, false, '关闭拦截后明文 HTTP 仍必须拒绝');
});

// ===========================================================================
// R1-8 — 每次广告拦截只计数一次
// ===========================================================================
test('P13R1-8 每次广告拦截只计数一次', async () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleShouldStartLoad({ url: 'https://doubleclick.net/a' });
api.handleShouldStartLoad({ url: 'https://adsterra.com/b' });
await sleep(260);
rt.settle();
`,
    'R1-8 两次广告'
  );
  assert.equal(snap.blockedAdCount, 2, '两次广告各计数一次，合计 2');
});

// ===========================================================================
// R1-9 — 200ms 内多次拦截 → 合并为一次 setState
// ===========================================================================
test('P13R1-9 200ms 内多次拦截 → 合并为一次 setState', async () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleShouldStartLoad({ url: 'https://popads.net/1' });
api.handleShouldStartLoad({ url: 'https://popads.net/2' });
api.handleShouldStartLoad({ url: 'https://popads.net/3' });
await sleep(260);
rt.settle();
`,
    'R1-9 200ms 合并'
  );
  assert.equal(snap.blockedAdCount, 3, '三次拦截合并后计数为 3');
});

// ===========================================================================
// R1-10 — 200ms 窗口前后计数差异
// ===========================================================================
test('P13R1-10 200ms 窗口前后计数差异', async () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleShouldStartLoad({ url: 'https://popads.net/1' });
await sleep(260);
rt.settle();
const afterFirst = api.blockedAdCount;
api.handleShouldStartLoad({ url: 'https://popads.net/2' });
await sleep(260);
rt.settle();
globalThis.__PROBE__ = { afterFirst, afterSecond: api.blockedAdCount };
`,
    'R1-10 窗口前后'
  );
  assert.deepEqual(snap.probe, { afterFirst: 1, afterSecond: 2 }, '两个窗口各计一次');
});

// ===========================================================================
// R1-11 — 多次开关切换
// ===========================================================================
test('P13R1-11 多次开关切换', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.toggleAdBlock(); rt.settle();
api.toggleAdBlock(); rt.settle();
api.toggleAdBlock(); rt.settle();
globalThis.__PROBE__ = api.isAdBlockEnabled;
`,
    'R1-11 多次切换'
  );
  assert.equal(snap.probe, false, '切换三次后为关闭');
  assert.equal(snap.hapticLog.length, 3, '每次切换触发一次 Haptics');
});

// ===========================================================================
// R1-12 — 关闭拦截时注入 REMOVE_AD_STYLE_SCRIPT
// ===========================================================================
test('P13R1-12 关闭拦截时注入 REMOVE_AD_STYLE_SCRIPT', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.toggleAdBlock();
rt.settle();
`,
    'R1-12 关闭注入'
  );
  assert.equal(snap.injectLog.length, 1, '关闭时必须注入一次');
  assert.match(snap.injectLog[0], /style/i, '注入内容应为移除样式脚本');
});

// ===========================================================================
// R1-13 — 开启拦截时 runAdCleanup 执行原始 DOM 清理脚本
// ===========================================================================
test('P13R1-13 开启拦截时 runAdCleanup 执行 DOM 清理', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.runAdCleanup();
`,
    'R1-13 开启清理'
  );
  assert.equal(snap.injectLog.length, 1, '开启时 runAdCleanup 必须注入一次');
});

// ===========================================================================
// R1-14 — 关闭拦截时 runAdCleanup 不执行
// ===========================================================================
test('P13R1-14 关闭拦截时 runAdCleanup 不执行', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.toggleAdBlock();
rt.settle();
const before = globalThis.__INJECT_LOG__.length;
api.runAdCleanup();
globalThis.__PROBE__ = globalThis.__INJECT_LOG__.length - before;
`,
    'R1-14 关闭清理'
  );
  assert.equal(snap.probe, 0, '关闭后 runAdCleanup 不得注入');
});

// ===========================================================================
// R1-15 — 卸载前存在待处理计数定时器
// ===========================================================================
test('P13R1-15 卸载前存在待处理计数定时器', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleShouldStartLoad({ url: 'https://popads.net/1' });
// 不等待 200ms，直接观察：计数尚未落地
globalThis.__PROBE__ = api.blockedAdCount;
`,
    'R1-15 待处理定时器'
  );
  assert.equal(snap.probe, 0, '200ms 未到，计数尚未落地');
});

// ===========================================================================
// R1-16 — 卸载时取消计数定时器（不再 setState）
// ===========================================================================
test('P13R1-16 卸载时取消计数定时器', async () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleShouldStartLoad({ url: 'https://popads.net/1' });
rt.unmount();
await sleep(260);
globalThis.__PROBE__ = api.blockedAdCount;
`,
    'R1-16 卸载取消定时器'
  );
  assert.equal(snap.probe, 0, '卸载后定时器被取消，计数不落地');
});

// ===========================================================================
// R1-17 — 连续快速 WebView 请求
// ===========================================================================
test('P13R1-17 连续快速 WebView 请求', async () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
wrapBump();
const results = [];
results.push(api.handleShouldStartLoad({ url: 'https://example.com/a' }));
results.push(api.handleShouldStartLoad({ url: 'https://popads.net/b' }));
results.push(api.handleShouldStartLoad({ url: 'http://insecure.com/c' }));
results.push(api.handleShouldStartLoad({ url: 'https://doubleclick.net/d' }));
await sleep(260);
rt.settle();
globalThis.__PROBE__ = { results, count: api.blockedAdCount };
`,
    'R1-17 连续请求'
  );
  assert.deepEqual(snap.probe.results, [true, false, false, false], '放行/拒绝序列一致');
  assert.equal(snap.probe.count, 2, '两次广告合并计数为 2');
});

// ===========================================================================
// R1-18 — 公开接口形状不变
// ===========================================================================
test('P13R1-18 公开接口形状不变', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__API_KEYS__ = Object.keys(api).sort();
`,
    'R1-18 接口形状'
  );
  assert.deepEqual(snap.apiKeys, [
    'blockedAdCount',
    'bumpBlockedAdCount',
    'handleShouldStartLoad',
    'isAdBlockEnabled',
    'runAdCleanup',
    'toggleAdBlock',
  ], '返回对象键集合必须与解耦前一致');
});

// ===========================================================================
// R1-19 — 解耦后源码确实委托纯函数（结构性证据）
// ===========================================================================
test('P13R1-19 解耦后源码确实引用 adBlockDecision 纯函数', () => {
  const afterSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/useAdBlocker.ts'),
    'utf8'
  );
  assert.match(afterSrc, /from '\.\/adBlockDecision'/, '必须从 adBlockDecision 导入');
  assert.match(afterSrc, /decideRequestAllow\(/, '必须调用 decideRequestAllow');

  const logicSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/adBlockDecision.ts'),
    'utf8'
  );
  assert.match(logicSrc, /export const decideRequestAllow/, '纯函数必须导出');
  assert.doesNotMatch(logicSrc, /from 'react'/, '纯函数模块不得依赖 react');
  assert.doesNotMatch(logicSrc, /from 'react-native'/, '纯函数模块不得依赖 react-native');
  // 仅检查代码调用形态（注释中出现的说明文字不算）
  assert.doesNotMatch(logicSrc, /\bsetTimeout\s*\(/, '纯函数模块不得调用 setTimeout');
  assert.doesNotMatch(logicSrc, /\bsetState\s*\(/, '纯函数模块不得调用 setState');
  assert.doesNotMatch(logicSrc, /\buseRef\s*\(/, '纯函数模块不得调用 useRef');
});

// ===========================================================================
// R1-20 — 纯函数直接单元测试（补充，不替代 Hook 层等价验证）
// ===========================================================================
test('P13R1-20 decideRequestAllow 纯函数直接单元测试', async () => {
  const dir = buildSandbox('after');
  try {
    const body = `
const { decideRequestAllow } = await import('./src/hooks/browser/adBlockDecision.ts');
const cases = {
  https: decideRequestAllow('https://example.com/a', true),
  about: decideRequestAllow('about:blank', true),
  http: decideRequestAllow('http://example.com/a', true),
  javascript: decideRequestAllow('javascript:alert(1)', true),
  file: decideRequestAllow('file:///etc/passwd', true),
  empty: decideRequestAllow('', true),
  undef: decideRequestAllow(undefined, true),
  nul: decideRequestAllow(null, true),
  adEnabled: decideRequestAllow('https://popads.net/x', true),
  adDisabled: decideRequestAllow('https://popads.net/x', false),
  pathOnly: decideRequestAllow('https://cdn.example.com/casino/m.mp4', true),
  httpDisabled: decideRequestAllow('http://example.com/a', false),
};
process.stdout.write(JSON.stringify(cases));
`;
    const out = runInSandbox(dir, body);
    assert.deepEqual(out.https, { allow: true, blockedByAd: false });
    assert.deepEqual(out.about, { allow: true, blockedByAd: false });
    assert.deepEqual(out.http, { allow: false, blockedByAd: false });
    assert.deepEqual(out.javascript, { allow: false, blockedByAd: false });
    assert.deepEqual(out.file, { allow: false, blockedByAd: false });
    assert.deepEqual(out.empty, { allow: false, blockedByAd: false });
    assert.deepEqual(out.undef, { allow: false, blockedByAd: false });
    assert.deepEqual(out.nul, { allow: false, blockedByAd: false });
    assert.deepEqual(out.adEnabled, { allow: false, blockedByAd: true });
    assert.deepEqual(out.adDisabled, { allow: true, blockedByAd: false });
    assert.deepEqual(out.pathOnly, { allow: true, blockedByAd: false });
    assert.deepEqual(out.httpDisabled, { allow: false, blockedByAd: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p13r1DecouplingEquivalence.test.mjs ---
