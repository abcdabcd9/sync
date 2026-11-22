// --- START OF FILE tests/security/p13r0DecouplingEquivalence.test.mjs ---
/**
 * P1.3 R0 — 浏览器导航 URL 决策解耦 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 解耦前实现：冻结基线 `tests/fixtures/p13r0/before/hooks__browser__useBrowserNavigation.js`
 *     · 解耦后实现：当前 `src/hooks/browser/useBrowserNavigation.js`
 *       （内部委托 `navigationUrlLogic.ts` 纯函数）
 *   对同一组输入比较**完整可观测结果**：
 *     - 状态值（currentUrl / inputUrl / isDesktopMode / canGoBack / canGoForward）
 *     - Ref 值（actualLoadedUrl / actualLoadedTitle）
 *     - 副作用序列（loadUrl / emitCommand / goCinema(router.replace) / injectJavaScript /
 *       reload / addHistory / onUrlVisited / Haptics）
 *     - 定时器行为（iOS goCinema 150ms 延迟）
 *     - Cleanup 行为（卸载时 clearTimeout）
 *     - 异常语义（非字符串输入时是否抛出 / 异常类型 / 异常消息）
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
 *
 * 覆盖
 *   E1  空输入 → 无副作用
 *   E2  纯空白输入 → 无副作用
 *   E3  明文 http:// 普通站点 → 升级 https + navigate
 *   E4  明文 http:// 直链 mp4 → 升级 https + video（loadUrl/emitCommand/goCinema）
 *   E5  https 直链 mp4 → video
 *   E6  https 直链 m3u8 带 query → video
 *   E7  https 普通站点 → navigate（原样）
 *   E8  非 URL 文本 → Bing 搜索拼接（encodeURIComponent）
 *   E9  大写 HTTP:// → 升级 https
 *   E10 直链 .MP4 大写扩展名 → video
 *   E11 直链 .mp4?x=1 带 query → video
 *   E12 直链 .mp4#frag 不匹配（正则仅允许 ?）→ navigate 走 Bing
 *   E13 toggleDesktopMode: m. → www.（桌面）
 *   E14 toggleDesktopMode: wap. → www.（桌面）
 *   E15 toggleDesktopMode: www. → m.（移动）
 *   E16 toggleDesktopMode: 无 m./wap./www. 前缀 → 不改写，reload
 *   E17 toggleDesktopMode: path 中含 "://m." 不被误伤
 *   E18 handleNavigationStateChange: 安全 URL 且不同于 inputUrl → 同步 inputUrl
 *   E19 handleNavigationStateChange: 相同 URL → 不同步
 *   E20 handleNavigationStateChange: cn.bing.com → 不同步
 *   E21 handleNavigationStateChange: 非安全 URL（http://）→ 不同步
 *   E22 handleNavigationStateChange: 标题 trim + 空标题保留空串
 *   E23 handleNavigationStateChange: loading=true → 不写历史
 *   E24 handleNavigationStateChange: loading=false → 写历史 + onUrlVisited
 *   E25 iOS goCinema 150ms 延迟（定时器行为）
 *   E26 Android goCinema 立即执行（无定时器）
 *   E27 卸载时清理 submitTimerRef（Cleanup）
 *   E28 连续两次 handleSubmitUrl（快速连续操作）副作用序列一致
 *   E29 injectUrl 非安全 URL → 无状态变化
 *   E30 injectUrl 安全 URL → 同步三处状态 + 复位 canGoBack/canGoForward
 *   E31 公开接口形状（导出名 / 返回对象键）不变
 *   E32 解耦后源码确实引用 navigationUrlLogic 纯函数（结构性证据）
 *   E33 数字输入 123 → 抛 TypeError（trim is not a function）
 *   E34 null 输入 → 抛 TypeError
 *   E35 undefined 输入 → 抛 TypeError
 *   E36 布尔输入 true → 抛 TypeError
 *   E37 普通对象（无 trim）→ 抛 TypeError
 *   E38 带自定义 trim 方法的对象 → 调用自定义 trim 并导航
 *   E39 正常字符串输入 → 正常导航
 *   E40 纯空白字符串输入 → 无副作用
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p13r0/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__browser__useBrowserNavigation.js':
    '6fb9c22cf35e8ba66ce485d567c129a86a17726c1aa65c223fc1b5a9162c3e2c',
};

test('P13R0-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 t6bRuntime.test.mjs 同构，独立复制以保持本测试自包含）
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
//   mode = 'after'  → 使用当前真实源码（解耦后，含 navigationUrlLogic.ts）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p13r0-${mode}-`));
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

  // react-native stub：记录型 Platform / Keyboard / LayoutAnimation / BackHandler
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __log = [];
export const Platform = { OS: process.env.P13R0_PLATFORM_OS || 'ios' };
export const Keyboard = { dismiss() { __log.push(['keyboard.dismiss']); } };
export const LayoutAnimation = {
  Presets: { easeInEaseOut: 'easeInEaseOut' },
  configureNext(preset) { __log.push(['layoutAnimation', preset]); },
};
export const BackHandler = {
  addEventListener(type, cb) { __log.push(['backHandler.add', type]); return { remove() { __log.push(['backHandler.remove', type]); } }; },
};
export default { Platform, Keyboard, LayoutAnimation, BackHandler };
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

  if (mode === 'before') {
    copyFile(
      path.join(beforeDir, 'hooks__browser__useBrowserNavigation.js'),
      'src/hooks/browser/useBrowserNavigation.js'
    );
  } else {
    // 🧩 TASK-P1.4 R0：after 源已迁移为 .ts，复制到 .ts 目标（Node 原生类型剥离执行）
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/useBrowserNavigation.ts'),
      'src/hooks/browser/useBrowserNavigation.ts'
    );
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/navigationUrlLogic.ts'),
      'src/hooks/browser/navigationUrlLogic.ts'
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
    env: { PATH: process.env.PATH, P13R0_PLATFORM_OS: platformOs || 'ios' },
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
const { useBrowserNavigation } = await import('./src/hooks/browser/useBrowserNavigation');

globalThis.__ROUTER_LOG__ = [];
globalThis.__NAV_OPTS_LOG__ = [];
globalThis.__HAPTIC_LOG__ = [];

// 异常捕获探针：执行 fn，若抛出则记录 {name, message} 到 __THROWN__，
// 否则记录 null。用于比较解耦前后对非字符串输入的运行时异常语义。
globalThis.__captureThrow__ = (fn) => {
  try {
    fn();
    globalThis.__THROWN__ = null;
  } catch (e) {
    globalThis.__THROWN__ = {
      name: e && e.name,
      message: e && e.message,
    };
  }
};

const rt = createHookRuntime();

// 可控 WebView ref
const webViewLog = [];
const webViewRef = { current: {
  goBack() { webViewLog.push(['goBack']); },
  goForward() { webViewLog.push(['goForward']); },
  reload() { webViewLog.push(['reload']); },
  injectJavaScript(s) { webViewLog.push(['inject', s]); },
} };

const loadUrlLog = [];
const emitCommandLog = [];
const addHistoryLog = [];
const onUrlVisitedLog = [];

let api = null;
const Comp = () => {
  api = useBrowserNavigation({
    startUrl: globalThis.__START_URL__,
    webViewRef,
    loadUrl: (u) => loadUrlLog.push(u),
    emitCommand: (...a) => emitCommandLog.push(a),
    addHistory: (...a) => addHistoryLog.push(a),
    closeMenu: () => { globalThis.__CLOSE_MENU_COUNT__ = (globalThis.__CLOSE_MENU_COUNT__ || 0) + 1; },
    onUrlVisited: (u) => onUrlVisitedLog.push(u),
  });
  return null;
};

function snapshot() {
  return {
    currentUrl: api.currentUrl,
    inputUrl: api.inputUrl,
    canGoBack: api.canGoBack,
    canGoForward: api.canGoForward,
    isDesktopMode: api.isDesktopMode,
    actualLoadedUrl: api.actualLoadedUrl.current,
    actualLoadedTitle: api.actualLoadedTitle.current,
    routerLog: globalThis.__ROUTER_LOG__.slice(),
    navOptsLog: globalThis.__NAV_OPTS_LOG__.slice(),
    hapticLog: globalThis.__HAPTIC_LOG__.slice(),
    webViewLog: webViewLog.slice(),
    loadUrlLog: loadUrlLog.slice(),
    emitCommandLog: emitCommandLog.slice(),
    addHistoryLog: addHistoryLog.slice(),
    onUrlVisitedLog: onUrlVisitedLog.slice(),
    closeMenuCount: globalThis.__CLOSE_MENU_COUNT__ || 0,
    // 可选探针（仅对应场景设置，未设置时为 null，两侧一致）
    titleProbe: globalThis.__TITLE_PROBE__ ?? null,
    immediateRouterLog: globalThis.__IMMEDIATE_ROUTER_LOG__ ?? null,
    apiKeys: globalThis.__API_KEYS__ ?? null,
    // 异常探针：仅当场景脚本调用 __captureThrow__ 时填充，否则为 null（两侧一致）
    thrown: globalThis.__THROWN__ ?? null,
  };
}
`;

/**
 * 执行单个场景：在 before 与 after 沙箱中各跑一次，返回两份快照。
 * @param {string} scenarioBody 场景脚本（可使用 SCENARIO_PRELUDE 提供的 api / rt / snapshot）
 */
function runScenario(scenarioBody, platformOs) {
  const body = `${SCENARIO_PRELUDE}\n${scenarioBody}\nprocess.stdout.write(JSON.stringify(snapshot()));`;
  const beforeDirSandbox = buildSandbox('before');
  const afterDirSandbox = buildSandbox('after');
  try {
    const before = runInSandbox(beforeDirSandbox, body, platformOs);
    const after = runInSandbox(afterDirSandbox, body, platformOs);
    return { before, after };
  } finally {
    fs.rmSync(beforeDirSandbox, { recursive: true, force: true });
    fs.rmSync(afterDirSandbox, { recursive: true, force: true });
  }
}

/** 断言 before / after 快照逐项一致 */
function assertEquivalent(scenarioBody, label, platformOs) {
  const { before, after } = runScenario(scenarioBody, platformOs);
  assert.deepEqual(after, before, `${label}：解耦后行为必须与解耦前逐项一致`);
  return before;
}

// ===========================================================================
// E1 / E2 — 空输入 / 纯空白输入
// ===========================================================================
test('P13R0-E1 空输入 → 无任何副作用', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E1 空输入'
  );
  assert.equal(snap.loadUrlLog.length, 0, '空输入不得 loadUrl');
  assert.equal(snap.emitCommandLog.length, 0, '空输入不得 emitCommand');
  assert.equal(snap.routerLog.length, 0, '空输入不得 router.replace');
  assert.equal(snap.currentUrl, 'https://www.bing.com', 'currentUrl 不变');
});

test('P13R0-E2 纯空白输入 → 无任何副作用', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('   \\t  ');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E2 纯空白输入'
  );
  assert.equal(snap.loadUrlLog.length, 0);
  assert.equal(snap.currentUrl, 'https://www.bing.com');
});

// ===========================================================================
// E3 / E4 — 明文 http:// 升级
// ===========================================================================
test('P13R0-E3 明文 http:// 普通站点 → 升级 https + navigate', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('http://example.com/page');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E3 http 普通站点'
  );
  assert.equal(snap.currentUrl, 'https://example.com/page', '必须升级为 https');
  assert.equal(snap.actualLoadedUrl, 'https://example.com/page');
  assert.equal(snap.loadUrlLog.length, 0, '普通站点不 loadUrl');
  assert.equal(snap.emitCommandLog.length, 0);
});

test('P13R0-E4 明文 http:// 直链 mp4 → 升级 https + video 副作用', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('http://cdn.example.com/v.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E4 http 直链 mp4'
  );
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/v.mp4'], '必须先升级 https 再 loadUrl');
  assert.deepEqual(snap.emitCommandLog, [['PLAY', 0, 'https://cdn.example.com/v.mp4']]);
  assert.deepEqual(snap.hapticLog, [['impact', 'heavy']], '直链视频触发 Heavy 触感');
});

// ===========================================================================
// E5 / E6 / E10 / E11 / E12 — 直链视频判定
// ===========================================================================
test('P13R0-E5 https 直链 mp4 → video', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/v.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E5 https mp4'
  );
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/v.mp4']);
  assert.equal(snap.currentUrl, 'https://www.bing.com', 'video 分支不改 currentUrl');
});

test('P13R0-E6 https 直链 m3u8 带 query → video', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/index.m3u8?token=abc');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E6 m3u8 query'
  );
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/index.m3u8?token=abc']);
});

test('P13R0-E10 直链 .MP4 大写扩展名 → video', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/V.MP4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E10 大写 MP4'
  );
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/V.MP4']);
});

test('P13R0-E11 直链 .mp4?x=1 带 query → video', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/v.mp4?x=1');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E11 mp4 query'
  );
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/v.mp4?x=1']);
});

test('P13R0-E12 直链 .mp4#frag 不匹配正则 → 走 Bing 搜索', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/v.mp4#t=10');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E12 mp4#frag'
  );
  // 正则 /\.(mp4|m3u8)(\?.*)?$/i 不允许 #，因此不是 video；
  // 但已是 https://，所以不拼 Bing，直接 navigate 原样
  assert.equal(snap.loadUrlLog.length, 0, '不匹配直链视频正则');
  assert.equal(snap.currentUrl, 'https://cdn.example.com/v.mp4#t=10');
});

// ===========================================================================
// E7 / E8 / E9 — 普通导航 / Bing 搜索 / 大写协议
// ===========================================================================
test('P13R0-E7 https 普通站点 → navigate 原样', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://example.com/a/b?c=1');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E7 https 普通站点'
  );
  assert.equal(snap.currentUrl, 'https://example.com/a/b?c=1');
  assert.equal(snap.loadUrlLog.length, 0);
});

test('P13R0-E8 非 URL 文本 → Bing 搜索拼接', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('hello world & more');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E8 Bing 搜索'
  );
  assert.equal(
    snap.currentUrl,
    'https://cn.bing.com/search?q=' + encodeURIComponent('hello world & more'),
    '必须 encodeURIComponent 拼接'
  );
});

test('P13R0-E9 大写 HTTP:// → 升级 https', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('HTTP://EXAMPLE.COM/x');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E9 大写 HTTP'
  );
  assert.equal(snap.currentUrl, 'https://EXAMPLE.COM/x', '协议大小写不敏感升级');
});

// ===========================================================================
// E13 ~ E17 — toggleDesktopMode 主机名改写
// ===========================================================================
test('P13R0-E13 toggleDesktopMode: m. → www.（桌面）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://m.example.com/a';
rt.render(Comp);
rt.settle();
api.toggleDesktopMode();
rt.settle();
`,
    'E13 m→www'
  );
  assert.equal(snap.currentUrl, 'https://www.example.com/a');
  assert.equal(snap.inputUrl, 'https://www.example.com/a');
  assert.equal(snap.isDesktopMode, true);
  assert.deepEqual(snap.webViewLog, [['inject', 'window.location.replace("https://www.example.com/a"); true;']]);
});

test('P13R0-E14 toggleDesktopMode: wap. → www.（桌面）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://wap.example.com/a';
rt.render(Comp);
rt.settle();
api.toggleDesktopMode();
rt.settle();
`,
    'E14 wap→www'
  );
  assert.equal(snap.currentUrl, 'https://www.example.com/a');
});

test('P13R0-E15 toggleDesktopMode: www. → m.（移动）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.example.com/a';
rt.render(Comp);
rt.settle();
// 先切到桌面（www 无变化 → reload），再切回移动（www → m）
api.toggleDesktopMode();
rt.settle();
api.toggleDesktopMode();
rt.settle();
`,
    'E15 www→m'
  );
  assert.equal(snap.currentUrl, 'https://m.example.com/a');
  assert.equal(snap.isDesktopMode, false);
});

test('P13R0-E16 toggleDesktopMode: 无前缀 → 不改写，reload', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://example.com/a';
rt.render(Comp);
rt.settle();
api.toggleDesktopMode();
rt.settle();
`,
    'E16 无前缀 reload'
  );
  assert.equal(snap.currentUrl, 'https://example.com/a', 'URL 不变');
  assert.deepEqual(snap.webViewLog, [['reload']], '无改写时 reload');
  assert.equal(snap.isDesktopMode, true);
});

test('P13R0-E17 toggleDesktopMode: path 中含 "://m." 不被误伤', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://example.com/redirect?to=https://m.evil.com/';
rt.render(Comp);
rt.settle();
api.toggleDesktopMode();
rt.settle();
`,
    'E17 path 不误伤'
  );
  assert.equal(
    snap.currentUrl,
    'https://example.com/redirect?to=https://m.evil.com/',
    '仅改写主机名，path/query 中的 ://m. 不得被替换'
  );
  assert.deepEqual(snap.webViewLog, [['reload']]);
});

// ===========================================================================
// E18 ~ E24 — handleNavigationStateChange
// ===========================================================================
test('P13R0-E18 安全 URL 且不同于 inputUrl → 同步 inputUrl', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://example.com/x', title: 'X', canGoBack: true, canGoForward: false, loading: true });
rt.settle();
`,
    'E18 同步 inputUrl'
  );
  assert.equal(snap.inputUrl, 'https://example.com/x');
  assert.equal(snap.canGoBack, true);
  assert.equal(snap.actualLoadedUrl, 'https://example.com/x');
  assert.equal(snap.actualLoadedTitle, 'X');
});

test('P13R0-E19 相同 URL → 不同步 inputUrl', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://www.bing.com', title: 'Bing', canGoBack: false, canGoForward: false, loading: true });
rt.settle();
`,
    'E19 相同 URL'
  );
  assert.equal(snap.inputUrl, 'https://www.bing.com', '相同 URL 不重复 setInputUrl');
});

test('P13R0-E20 cn.bing.com → 不同步 inputUrl', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://cn.bing.com/search?q=x', title: 'S', canGoBack: true, canGoForward: false, loading: true });
rt.settle();
`,
    'E20 cn.bing.com'
  );
  assert.equal(snap.inputUrl, 'https://www.bing.com', 'cn.bing.com 不同步到地址栏');
});

test('P13R0-E21 非安全 URL（http://）→ 不同步 inputUrl', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'http://insecure.example.com/', title: 'I', canGoBack: true, canGoForward: false, loading: true });
rt.settle();
`,
    'E21 非安全 URL'
  );
  assert.equal(snap.inputUrl, 'https://www.bing.com', 'http:// 不得同步到地址栏');
  assert.equal(snap.actualLoadedUrl, 'http://insecure.example.com/', 'actualLoadedUrl 仍记录真实 URL');
});

test('P13R0-E22 标题 trim + 空标题保留空串', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://example.com/a', title: '  Hello  ', canGoBack: false, canGoForward: false, loading: true });
rt.settle();
const t1 = api.actualLoadedTitle.current;
api.handleNavigationStateChange({ url: 'https://example.com/b', title: '   ', canGoBack: false, canGoForward: false, loading: true });
rt.settle();
const t2 = api.actualLoadedTitle.current;
api.handleNavigationStateChange({ url: 'https://example.com/c', title: undefined, canGoBack: false, canGoForward: false, loading: true });
rt.settle();
const t3 = api.actualLoadedTitle.current;
globalThis.__TITLE_PROBE__ = [t1, t2, t3];
`,
    'E22 标题 trim'
  );
  assert.equal(snap.actualLoadedTitle, '', '非字符串标题 → 空串');
  assert.deepEqual(
    snap.titleProbe,
    ['Hello', '', ''],
    '标题必须 trim；纯空白 → 空串；undefined → 空串'
  );
});

// ===========================================================================
// E23 / E24 — loading 标志决定是否兜底写历史
// ===========================================================================
test('P13R0-E23 loading=true → 不写历史、不 onUrlVisited', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://example.com/loading', title: 'L', canGoBack: true, canGoForward: false, loading: true });
rt.settle();
`,
    'E23 loading=true'
  );
  assert.equal(snap.addHistoryLog.length, 0, 'loading 中不得写历史');
  assert.equal(snap.onUrlVisitedLog.length, 0, 'loading 中不得记录上次访问');
  assert.equal(snap.actualLoadedUrl, 'https://example.com/loading', '但 actualLoadedUrl 仍同步');
});

test('P13R0-E24 loading=false → 写历史 + onUrlVisited', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://example.com/done', title: 'D', canGoBack: true, canGoForward: false, loading: false });
rt.settle();
`,
    'E24 loading=false'
  );
  assert.deepEqual(snap.addHistoryLog, [['https://example.com/done', 'D']], '写历史参数必须原样透传');
  assert.deepEqual(snap.onUrlVisitedLog, ['https://example.com/done'], '记录上次访问');
});

test('P13R0-E24b loading=false 但 url 为空 → 不写历史', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: '', title: 'E', canGoBack: false, canGoForward: false, loading: false });
rt.settle();
`,
    'E24b 空 url'
  );
  assert.equal(snap.addHistoryLog.length, 0, '空 url 不得写历史');
  assert.equal(snap.onUrlVisitedLog.length, 0);
});

// ===========================================================================
// E25 / E26 — goCinema 定时器行为（iOS 150ms 延迟 / Android 立即）
// ===========================================================================
test('P13R0-E25 iOS goCinema 延迟 150ms 执行 router.replace', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/v.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
// 立即快照：定时器尚未触发
const immediateRouterLog = globalThis.__ROUTER_LOG__.slice();
globalThis.__IMMEDIATE_ROUTER_LOG__ = immediateRouterLog;
// 等待 200ms 让 150ms 定时器触发
await new Promise((r) => setTimeout(r, 200));
`,
    'E25 iOS goCinema 延迟',
    'ios'
  );
  assert.deepEqual(snap.immediateRouterLog, [], 'iOS 提交瞬间不得立即 router.replace');
  assert.deepEqual(snap.routerLog, [['replace', '/cinema']], '150ms 后必须 router.replace(/cinema)');
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/v.mp4'], 'loadUrl 立即执行');
});

test('P13R0-E26 Android goCinema 立即执行（无定时器）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/v.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E26 Android goCinema 立即',
    'android'
  );
  assert.deepEqual(snap.routerLog, [['replace', '/cinema']], 'Android 立即 router.replace');
});

// ===========================================================================
// E27 — 卸载清理定时器
// ===========================================================================
test('P13R0-E27 卸载时清理 submitTimerRef（iOS 延迟跳转被取消）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/v.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
// 定时器已排入（150ms），立即卸载
rt.unmount();
await new Promise((r) => setTimeout(r, 200));
`,
    'E27 卸载清理定时器',
    'ios'
  );
  assert.deepEqual(snap.routerLog, [], '卸载后 150ms 定时器必须被 clearTimeout，不得 router.replace');
  assert.deepEqual(snap.loadUrlLog, ['https://cdn.example.com/v.mp4'], '卸载前 loadUrl 已发生');
});

// ===========================================================================
// E28 — 快速连续 handleSubmitUrl
// ===========================================================================
test('P13R0-E28 连续两次 handleSubmitUrl → 副作用序列一致', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://cdn.example.com/a.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
api.setInputUrl('https://cdn.example.com/b.mp4');
rt.settle();
api.handleSubmitUrl();
rt.settle();
`,
    'E28 连续提交',
    'android'
  );
  assert.deepEqual(
    snap.loadUrlLog,
    ['https://cdn.example.com/a.mp4', 'https://cdn.example.com/b.mp4'],
    '两次 loadUrl 顺序必须一致'
  );
  assert.deepEqual(snap.emitCommandLog, [
    ['PLAY', 0, 'https://cdn.example.com/a.mp4'],
    ['PLAY', 0, 'https://cdn.example.com/b.mp4'],
  ]);
  assert.deepEqual(snap.routerLog, [['replace', '/cinema'], ['replace', '/cinema']]);
  assert.deepEqual(snap.hapticLog, [['impact', 'heavy'], ['impact', 'heavy']]);
});

// ===========================================================================
// E29 / E30 — injectUrl 安全判定与状态复位
// ===========================================================================
test('P13R0-E29 injectUrl 非安全 URL → 无任何状态变化', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://example.com/x', title: 'X', canGoBack: true, canGoForward: true, loading: true });
rt.settle();
api.injectUrl('http://insecure.example.com/');
rt.settle();
`,
    'E29 injectUrl 非安全'
  );
  assert.equal(snap.currentUrl, 'https://www.bing.com', '非安全 URL 不得改 currentUrl');
  assert.equal(snap.inputUrl, 'https://example.com/x', '非安全 URL 不得改 inputUrl');
  assert.equal(snap.canGoBack, true, '非安全 URL 不得复位 canGoBack');
  assert.equal(snap.canGoForward, true, '非安全 URL 不得复位 canGoForward');
});

test('P13R0-E30 injectUrl 安全 URL → 同步三处状态 + 复位前进/后退', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.handleNavigationStateChange({ url: 'https://example.com/x', title: 'X', canGoBack: true, canGoForward: true, loading: true });
rt.settle();
api.injectUrl('https://example.com/injected');
rt.settle();
`,
    'E30 injectUrl 安全'
  );
  assert.equal(snap.currentUrl, 'https://example.com/injected');
  assert.equal(snap.inputUrl, 'https://example.com/injected');
  assert.equal(snap.actualLoadedUrl, 'https://example.com/injected');
  assert.equal(snap.canGoBack, false, '注入后必须复位 canGoBack');
  assert.equal(snap.canGoForward, false, '注入后必须复位 canGoForward');
});

// ===========================================================================
// E31 — 公开接口形状（导出名 / 返回对象键）不得变化
// ===========================================================================
test('P13R0-E31 公开接口形状与解耦前完全一致', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
globalThis.__API_KEYS__ = Object.keys(api).sort();
`,
    'E31 接口形状'
  );
  assert.deepEqual(snap.apiKeys, [
    'actualLoadedTitle',
    'actualLoadedUrl',
    'canGoBack',
    'canGoForward',
    'currentUrl',
    'goCinema',
    'handleClose',
    'handleGoBack',
    'handleGoForward',
    'handleNavigationStateChange',
    'handleSubmitUrl',
    'injectUrl',
    'inputUrl',
    'isDesktopMode',
    'launchTimerRef',
    'loadUrlInWebView',
    'setInputUrl',
    'toggleDesktopMode',
  ], '返回对象键集合必须与解耦前一致（无新增/删除/改名）');
});

// ===========================================================================
// E32 — 解耦后模块确实委托纯函数（结构性证据，非行为断言）
// ===========================================================================
test('P13R0-E32 解耦后源码确实引用 navigationUrlLogic 纯函数', () => {
  const afterSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/useBrowserNavigation.ts'),
    'utf8'
  );
  assert.match(afterSrc, /from '\.\/navigationUrlLogic'/, '必须从 navigationUrlLogic 导入');
  assert.match(afterSrc, /resolveSubmitTarget\(/, '必须调用 resolveSubmitTarget');
  assert.match(afterSrc, /rewriteDesktopHost\(/, '必须调用 rewriteDesktopHost');
  assert.match(afterSrc, /shouldSyncInputUrl\(/, '必须调用 shouldSyncInputUrl');

  const logicSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/navigationUrlLogic.ts'),
    'utf8'
  );
  assert.match(logicSrc, /export const resolveSubmitTarget/, '纯函数必须导出');
  assert.match(logicSrc, /export const rewriteDesktopHost/, '纯函数必须导出');
  assert.match(logicSrc, /export const shouldSyncInputUrl/, '纯函数必须导出');
  // 纯函数模块不得引入 React / 原生依赖
  assert.doesNotMatch(logicSrc, /from 'react'/, '纯函数模块不得依赖 react');
  assert.doesNotMatch(logicSrc, /from 'react-native'/, '纯函数模块不得依赖 react-native');
});

// ===========================================================================
// E33–E40 — 非字符串输入：运行时异常语义必须与解耦前逐项一致
//
// 背景（P1.3 R1 Gatekeeper 发现）
//   解耦前 handleSubmitUrl 直接调用 `inputUrl.trim()`，非字符串输入会抛出
//   `TypeError: inputUrl.trim is not a function`。R0 初版纯函数误加了
//   `typeof rawInput === 'string'` 防御判断，把异常吞成空串，导致行为不等价。
//   以下用例通过公开 setInputUrl 注入异常输入，调用 handleSubmitUrl，
//   捕获异常并比较：是否抛出 / 异常类型 / 异常消息 / 相关状态 / 副作用。
// ===========================================================================

test('P13R0-E33 数字输入 123 → 与解耦前一致（抛 TypeError）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl(123);
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E33 数字输入'
  );
  assert.equal(snap.thrown && snap.thrown.name, 'TypeError', '数字输入必须抛 TypeError');
  assert.match(snap.thrown.message, /trim is not a function/, '异常消息必须与解耦前一致');
  assert.equal(snap.loadUrlLog.length, 0, '抛异常时不得 loadUrl');
  assert.equal(snap.routerLog.length, 0, '抛异常时不得 router.replace');
});

test('P13R0-E34 null 输入 → 与解耦前一致（抛 TypeError）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl(null);
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E34 null 输入'
  );
  assert.equal(snap.thrown && snap.thrown.name, 'TypeError', 'null 输入必须抛 TypeError');
  // null 上访问 .trim 时 V8 报 "Cannot read properties of null (reading 'trim')"；
  // 关键是与解耦前逐项一致（assertEquivalent 已保证），此处再显式锚定消息形态。
  assert.match(snap.thrown.message, /null.*trim/, '异常消息必须与解耦前一致');
  assert.equal(snap.loadUrlLog.length, 0);
});

test('P13R0-E35 undefined 输入 → 与解耦前一致（抛 TypeError）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl(undefined);
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E35 undefined 输入'
  );
  assert.equal(snap.thrown && snap.thrown.name, 'TypeError', 'undefined 输入必须抛 TypeError');
  // undefined 上访问 .trim 时 V8 报 "Cannot read properties of undefined (reading 'trim')"；
  // 关键是与解耦前逐项一致（assertEquivalent 已保证），此处再显式锚定消息形态。
  assert.match(snap.thrown.message, /undefined.*trim/, '异常消息必须与解耦前一致');
  assert.equal(snap.loadUrlLog.length, 0);
});

test('P13R0-E36 布尔输入 true → 与解耦前一致（抛 TypeError）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl(true);
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E36 布尔输入'
  );
  assert.equal(snap.thrown && snap.thrown.name, 'TypeError', '布尔输入必须抛 TypeError');
  assert.match(snap.thrown.message, /trim is not a function/, '异常消息必须与解耦前一致');
  assert.equal(snap.loadUrlLog.length, 0);
});

test('P13R0-E37 普通对象（无 trim）→ 与解耦前一致（抛 TypeError）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl({ foo: 'bar' });
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E37 普通对象输入'
  );
  assert.equal(snap.thrown && snap.thrown.name, 'TypeError', '普通对象输入必须抛 TypeError');
  assert.match(snap.thrown.message, /trim is not a function/, '异常消息必须与解耦前一致');
  assert.equal(snap.loadUrlLog.length, 0);
});

test('P13R0-E38 带自定义 trim 方法的对象 → 与解耦前一致（调用自定义 trim）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl({ trim: () => 'https://custom.example.com' });
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E38 自定义 trim 对象'
  );
  assert.equal(snap.thrown, null, '带 trim 方法的对象不得抛异常');
  assert.equal(snap.currentUrl, 'https://custom.example.com', 'currentUrl 必须更新为自定义 trim 结果');
  assert.equal(snap.actualLoadedUrl, 'https://custom.example.com', 'actualLoadedUrl 必须同步');
  assert.equal(snap.loadUrlLog.length, 0, 'navigate 分支不调用 loadUrl（与解耦前一致）');
});

test('P13R0-E39 正常字符串输入 → 与解耦前一致（正常导航）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('https://example.com/ok');
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E39 正常字符串'
  );
  assert.equal(snap.thrown, null, '正常字符串不得抛异常');
  assert.equal(snap.currentUrl, 'https://example.com/ok');
  assert.equal(snap.actualLoadedUrl, 'https://example.com/ok');
  assert.equal(snap.loadUrlLog.length, 0, 'navigate 分支不调用 loadUrl（与解耦前一致）');
});

test('P13R0-E40 纯空白字符串输入 → 与解耦前一致（无副作用）', () => {
  const snap = assertEquivalent(
    `
globalThis.__START_URL__ = 'https://www.bing.com';
rt.render(Comp);
rt.settle();
api.setInputUrl('   ');
rt.settle();
globalThis.__captureThrow__(() => api.handleSubmitUrl());
rt.settle();
`,
    'E40 纯空白字符串'
  );
  assert.equal(snap.thrown, null, '纯空白字符串不得抛异常');
  assert.equal(snap.loadUrlLog.length, 0, '纯空白字符串不得 loadUrl');
  assert.equal(snap.currentUrl, 'https://www.bing.com', 'currentUrl 不变');
});