// --- START OF FILE tests/security/p13r2DecouplingEquivalence.test.mjs ---
/**
 * P1.3 R2 — 浏览器媒体嗅探「列表决策」解耦 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 解耦前实现：冻结基线 `tests/fixtures/p13r2/before/hooks__browser__useBrowserSniffer.js`
 *     · 解耦后实现：当前 `src/hooks/browser/useBrowserSniffer.js`
 *       （pushMedia / formatCounts / filteredMediaList 内部委托 `snifferMediaLogic.ts`）
 *   对同一组输入比较**完整可观测结果**：
 *     - 状态值（sniffedMediaList / filterFormat / isSniffing）
 *     - 派生值（filteredMediaList 内容与**引用相等性** / formatCounts）
 *     - 副作用（LayoutAnimation / Haptics / onMediaFound 调用次数与参数）
 *     - 定时器（2000ms 兜底：创建次数 / 取消 / 卸载清理）
 *     - 消息解析（VIDEO_FOUND / VIDEO_FOUND_LIST / MANUAL_SNIFF_DONE / 非法 JSON）
 *     - 异常语义（非标准输入）
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实 Hook 源码：
 *   该运行时实现了 useState / useRef / useEffect / useCallback / useMemo 的最小语义，
 *   用于在 Node 环境中真实调用 Hook 并观察其状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证 Hook 源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 * 相对 R1 测试的精度改进（回应 R1 Gatekeeper 意见）
 *   · 定时器：直接记录 `setTimeout` / `clearTimeout` 的**调用次数与延迟参数**，
 *     不依赖最终状态推断。
 *   · 副作用：`onMediaFound` 通过真实 Hook 参数传入并记录每次调用的**参数快照**，
 *     不通过替换返回对象属性来伪造计数。
 *   · 引用相等：`filteredMediaList === sniffedMediaList` 在 ALL 分支被显式断言。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / AsyncStorage。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行 Hook 源码，不复制内部函数做模拟。
 *   · 定时器使用沙箱内可控假定时器（记录调用，不真实等待 2s）。
 *
 * 覆盖（R2-1 … R2-24）
 *   R2-1  初始状态（空列表 / ALL / 未嗅探）
 *   R2-2  公开接口键集合不变
 *   R2-3  FILTER_OPTIONS 内容与顺序不变
 *   R2-4  VIDEO_FOUND 单条命中 → 入列 + 副作用
 *   R2-5  VIDEO_FOUND_LIST 批量命中 → 入列顺序
 *   R2-6  VIDEO_FOUND_LIST 空数组 → 静默（无副作用）
 *   R2-7  VIDEO_FOUND 缺 url → 不消费（返回 false）
 *   R2-8  非法 JSON → 返回 false，无副作用
 *   R2-9  非对象 JSON（数字/字符串/null）→ 返回 false
 *   R2-10 非嗅探消息（AD_BLOCKED）→ 返回 false
 *   R2-11 MANUAL_SNIFF_DONE → 返回 true，isSniffing 复位
 *   R2-12 M-5 白名单：javascript:/data:/file:/intent:/http:// 全部丢弃
 *   R2-13 M-5 白名单：https:// 与 http:// 放行（大小写不敏感）
 *   R2-14 非字符串媒体项（null/数字/对象）被丢弃
 *   R2-15 URL 前后空白被 trim
 *   R2-16 重复 URL 去重（同批 + 跨批）
 *   R2-17 多批合并顺序（新项在前）
 *   R2-18 formatCounts 各格式计数（含无法识别的 'media'）
 *   R2-19 filteredMediaList：ALL 分支**返回原数组同一引用**
 *   R2-20 filteredMediaList：具体格式过滤 + 顺序保持
 *   R2-21 removeMediaItem / clearSniffedMedia 行为
 *   R2-22 triggerManualSniff：注入脚本 + 2000ms 定时器创建
 *   R2-23 triggerManualSniff：重复触发先 clearTimeout 再新建
 *   R2-24 卸载清理定时器（clearTimeout 被调用）
 *   R2-25 纯函数直接单元测试（补充，不替代 Hook 层等价验证）
 *   R2-26 结构性委托证据
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p13r2/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__browser__useBrowserSniffer.js':
    '6b0d945f80f0f1e1368776eb28a1feb76bc65cb04a6edb30dff7504e4d38a5eb',
};

test('P13R2-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 p13r0 / p13r1 测试同构，独立复制以保持本测试自包含）
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
      // ⚠️ 首次挂载必须记录真实 deps（而非 undefined），否则第二次渲染
      //    会误判 deps 变化而提前执行 cleanup，导致定时器被过早清理。
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
//   mode = 'before' → 使用冻结基线（解耦前）
//   mode = 'after'  → 使用当前真实源码（解耦后，含 snifferMediaLogic.ts）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p13r2-${mode}-`));
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

  // react-native stub：LayoutAnimation 记录调用
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const LayoutAnimation = {
  configureNext(cfg) { globalThis.__LAYOUT_LOG__.push(cfg === undefined ? null : 'cfg'); },
  Presets: { easeInEaseOut: { __preset: 'easeInEaseOut' } },
};
export const Platform = { OS: 'ios' };
export default { LayoutAnimation, Platform };
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

  // scripts/browser 依赖链（MANUAL_SNIFF_SCRIPT 真实源码）
  copyFile(
    path.join(repoRoot, 'src/scripts/browser/index.ts'),
    'src/scripts/browser/index.ts'
  );
  for (const f of [
    'adCleanup.ts',
    'removeAdStyle.ts',
    'clickHijackGuard.ts',
    'adGuard.ts',
    'passiveSniffer.ts',
    'desktopSpoof.ts',
    'adDomWatcher.ts',
    'manualSniff.ts',
    'hiddenSnifferScripts.ts',
  ]) {
    copyFile(path.join(repoRoot, `src/scripts/browser/${f}`), `src/scripts/browser/${f}`);
  }

  if (mode === 'before') {
    copyFile(
      path.join(beforeDir, 'hooks__browser__useBrowserSniffer.js'),
      'src/hooks/browser/useBrowserSniffer.js'
    );
  } else {
    // 🧩 TASK-P1.4 R0：after 源已迁移为 .ts，复制到 .ts 目标（Node 原生类型剥离执行）
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/useBrowserSniffer.ts'),
      'src/hooks/browser/useBrowserSniffer.ts'
    );
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/snifferMediaLogic.ts'),
      'src/hooks/browser/snifferMediaLogic.ts'
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
const hookMod = await import('./src/hooks/browser/useBrowserSniffer');
const { useBrowserSniffer } = hookMod;

globalThis.__HAPTIC_LOG__ = [];
globalThis.__LAYOUT_LOG__ = [];
globalThis.__INJECT_LOG__ = [];
globalThis.__FOUND_LOG__ = [];
globalThis.__TIMER_LOG__ = [];

// 可控假定时器：记录 setTimeout / clearTimeout 调用（不真实等待）
const __realSetTimeout = globalThis.setTimeout;
const __realClearTimeout = globalThis.clearTimeout;
let __timerSeq = 0;
globalThis.setTimeout = (fn, ms) => {
  const id = ++__timerSeq;
  globalThis.__TIMER_LOG__.push({ op: 'set', id, ms });
  return { __fakeId: id, fn, ms };
};
globalThis.clearTimeout = (handle) => {
  const id = handle && handle.__fakeId ? handle.__fakeId : null;
  globalThis.__TIMER_LOG__.push({ op: 'clear', id });
};

const rt = createHookRuntime();

// 可控 WebView ref：记录 injectJavaScript 调用
const webViewRef = { current: {
  injectJavaScript(s) { globalThis.__INJECT_LOG__.push(s); },
} };

let api = null;
const Comp = () => {
  api = useBrowserSniffer({ onMediaFound: (list) => {
    globalThis.__FOUND_LOG__.push(list.map((m) => m.url));
  } });
  return null;
};

// 构造 WebView onMessage 事件
const msg = (payload) => ({ nativeEvent: { data: typeof payload === 'string' ? payload : JSON.stringify(payload) } });

// 记录 filteredMediaList 与 sniffedMediaList 的引用相等性
function refEqual() {
  return api.filteredMediaList === api.sniffedMediaList;
}

function snapshot() {
  return {
    sniffedUrls: api.sniffedMediaList.map((m) => m.url),
    sniffedItems: api.sniffedMediaList.map((m) => ({ id: m.id, url: m.url, ext: m.ext, domain: m.domain })),
    filterFormat: api.filterFormat,
    isSniffing: api.isSniffing,
    filteredUrls: api.filteredMediaList.map((m) => m.url),
    formatCounts: api.formatCounts,
    apiKeys: globalThis.__API_KEYS__ ?? null,
    filterOptions: globalThis.__FILTER_OPTIONS__ ?? null,
    hapticLog: globalThis.__HAPTIC_LOG__.slice(),
    layoutLog: globalThis.__LAYOUT_LOG__.slice(),
    injectLog: globalThis.__INJECT_LOG__.slice(),
    foundLog: globalThis.__FOUND_LOG__.slice(),
    timerLog: globalThis.__TIMER_LOG__.slice(),
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
// R2-1 — 初始状态
// ===========================================================================
test('P13R2-1 初始状态（空列表 / ALL / 未嗅探）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
`,
    'R2-1 初始状态'
  );
  assert.deepEqual(snap.sniffedUrls, [], '初始列表为空');
  assert.equal(snap.filterFormat, 'ALL', '默认筛选 ALL');
  assert.equal(snap.isSniffing, false, '默认未嗅探');
  assert.deepEqual(snap.formatCounts, { ALL: 0, MP4: 0, M3U8: 0, MOV: 0 }, '初始计数全 0');
});

// ===========================================================================
// R2-2 — 公开接口键集合不变
// ===========================================================================
test('P13R2-2 公开接口键集合不变', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__API_KEYS__ = Object.keys(api).sort();
`,
    'R2-2 接口形状'
  );
  assert.deepEqual(snap.apiKeys, [
    'clearSniffedMedia',
    'filterFormat',
    'filteredMediaList',
    'formatCounts',
    'handleWebMessage',
    'isSniffing',
    'removeMediaItem',
    'setFilterFormat',
    'sniffedMediaList',
    'triggerManualSniff',
  ], '返回对象键集合必须与解耦前一致');
});

// ===========================================================================
// R2-3 — FILTER_OPTIONS 内容与顺序不变
// ===========================================================================
test('P13R2-3 FILTER_OPTIONS 内容与顺序不变', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__FILTER_OPTIONS__ = hookMod.FILTER_OPTIONS.slice();
`,
    'R2-3 筛选选项'
  );
  assert.deepEqual(snap.filterOptions, ['ALL', 'MP4', 'M3U8', 'MOV'], '筛选选项顺序必须一致');
});

// ===========================================================================
// R2-4 — VIDEO_FOUND 单条命中
// ===========================================================================
test('P13R2-4 VIDEO_FOUND 单条命中 → 入列 + 副作用', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleWebMessage(msg({ type: 'VIDEO_FOUND', url: 'https://cdn.example.com/a.mp4' }));
rt.settle();
`,
    'R2-4 单条命中'
  );
  assert.equal(snap.probe, true, 'VIDEO_FOUND 必须被消费');
  assert.deepEqual(snap.sniffedUrls, ['https://cdn.example.com/a.mp4'], '入列一条');
  assert.equal(snap.isSniffing, false, '命中后复位嗅探状态');
  assert.equal(snap.layoutLog.length, 1, '触发一次 LayoutAnimation');
  assert.equal(snap.hapticLog.length, 1, '触发一次 Haptics');
  assert.deepEqual(snap.foundLog, [['https://cdn.example.com/a.mp4']], 'onMediaFound 收到新列表');
});

// ===========================================================================
// R2-5 — VIDEO_FOUND_LIST 批量命中顺序
// ===========================================================================
test('P13R2-5 VIDEO_FOUND_LIST 批量命中 → 入列顺序', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: ['https://a.com/1.mp4', 'https://b.com/2.m3u8', 'https://c.com/3.mov'],
}));
rt.settle();
`,
    'R2-5 批量命中'
  );
  assert.equal(snap.probe, true, 'VIDEO_FOUND_LIST 必须被消费');
  assert.deepEqual(
    snap.sniffedUrls,
    ['https://a.com/1.mp4', 'https://b.com/2.m3u8', 'https://c.com/3.mov'],
    '批量入列顺序与消息顺序一致'
  );
  assert.equal(snap.layoutLog.length, 1, '整批只触发一次 LayoutAnimation');
  assert.equal(snap.foundLog.length, 1, '整批只通知一次 onMediaFound');
});

// ===========================================================================
// R2-6 — VIDEO_FOUND_LIST 空数组 → 静默
// ===========================================================================
test('P13R2-6 VIDEO_FOUND_LIST 空数组 → 静默（无副作用）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: [] }));
rt.settle();
`,
    'R2-6 空批量'
  );
  assert.equal(snap.probe, true, '空批量仍被消费');
  assert.deepEqual(snap.sniffedUrls, [], '列表保持为空');
  assert.equal(snap.layoutLog.length, 0, '不得触发动画');
  assert.equal(snap.hapticLog.length, 0, '不得触发震动');
  assert.equal(snap.foundLog.length, 0, '不得通知 onMediaFound');
});

// ===========================================================================
// R2-7 — VIDEO_FOUND 缺 url → 不消费
// ===========================================================================
test('P13R2-7 VIDEO_FOUND 缺 url → 不消费（返回 false）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleWebMessage(msg({ type: 'VIDEO_FOUND' }));
rt.settle();
`,
    'R2-7 缺 url'
  );
  assert.equal(snap.probe, false, '缺 url 不得被嗅探域消费');
  assert.deepEqual(snap.sniffedUrls, [], '列表保持为空');
});

// ===========================================================================
// R2-8 — 非法 JSON
// ===========================================================================
test('P13R2-8 非法 JSON → 返回 false，无副作用', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleWebMessage({ nativeEvent: { data: '{not json' } });
rt.settle();
`,
    'R2-8 非法 JSON'
  );
  assert.equal(snap.probe, false, '非法 JSON 返回 false');
  assert.equal(snap.layoutLog.length, 0, '无动画副作用');
});

// ===========================================================================
// R2-9 — 非对象 JSON
// ===========================================================================
test('P13R2-9 非对象 JSON（数字/字符串/null）→ 返回 false', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
const r = [];
r.push(api.handleWebMessage(msg(123)));
r.push(api.handleWebMessage(msg('hello')));
r.push(api.handleWebMessage(msg(null)));
globalThis.__PROBE__ = r;
rt.settle();
`,
    'R2-9 非对象 JSON'
  );
  assert.deepEqual(snap.probe, [false, false, false], '非对象 JSON 一律返回 false');
});

// ===========================================================================
// R2-10 — 非嗅探消息
// ===========================================================================
test('P13R2-10 非嗅探消息（AD_BLOCKED）→ 返回 false', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
globalThis.__PROBE__ = api.handleWebMessage(msg({ type: 'AD_BLOCKED', count: 3 }));
rt.settle();
`,
    'R2-10 非嗅探消息'
  );
  assert.equal(snap.probe, false, 'AD_BLOCKED 不属于嗅探域');
  assert.deepEqual(snap.sniffedUrls, [], '列表保持为空');
});

// ===========================================================================
// R2-11 — MANUAL_SNIFF_DONE
// ===========================================================================
test('P13R2-11 MANUAL_SNIFF_DONE → 返回 true，isSniffing 复位', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.triggerManualSniff(webViewRef);
rt.settle();
const before = api.isSniffing;
globalThis.__PROBE__ = { before, ret: api.handleWebMessage(msg({ type: 'MANUAL_SNIFF_DONE' })) };
rt.settle();
`,
    'R2-11 手动完成'
  );
  assert.equal(snap.probe.before, true, '触发后处于嗅探中');
  assert.equal(snap.probe.ret, true, 'MANUAL_SNIFF_DONE 被消费');
  assert.equal(snap.isSniffing, false, '完成后复位');
});

// ===========================================================================
// R2-12 — M-5 白名单：危险协议全部丢弃
// ===========================================================================
test('P13R2-12 M-5 白名单：危险协议全部丢弃（http 明文按原规则放行）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: [
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'file:///etc/passwd',
    'intent://x#Intent;end',
    'ftp://x.com/a.mp4',
    'https://',
    '   ',
    '',
  ],
}));
rt.settle();
`,
    'R2-12 危险协议'
  );
  // ⚠️ M-5 白名单正则为 ^https?:\/\/\S+，明文 http:// 属于放行范围（原始行为，本批次不改）
  assert.deepEqual(snap.sniffedUrls, [], '危险协议与空主机全部丢弃');
  assert.equal(snap.layoutLog.length, 0, '全部丢弃时不得触发动画');
  assert.equal(snap.foundLog.length, 0, '全部丢弃时不得通知');
});

// ===========================================================================
// R2-13 — M-5 白名单：https / http 放行（大小写不敏感）
// ===========================================================================
test('P13R2-13 M-5 白名单：https:// 与 http:// 放行（大小写不敏感）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: [
    'https://a.com/1.mp4',
    'HTTP://b.com/2.mp4',
    'HtTpS://c.com/3.mp4',
  ],
}));
rt.settle();
`,
    'R2-13 协议放行'
  );
  assert.deepEqual(
    snap.sniffedUrls,
    ['https://a.com/1.mp4', 'HTTP://b.com/2.mp4', 'HtTpS://c.com/3.mp4'],
    'http/https 大小写不敏感放行，且保留原始大小写'
  );
});

// ===========================================================================
// R2-14 — 非字符串媒体项被丢弃
// ===========================================================================
test('P13R2-14 非字符串媒体项（null/数字/对象）被丢弃', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: [null, 123, { url: 'https://x.com/a.mp4' }, true, 'https://ok.com/a.mp4'],
}));
rt.settle();
`,
    'R2-14 非字符串项'
  );
  assert.deepEqual(snap.sniffedUrls, ['https://ok.com/a.mp4'], '仅字符串项入列');
});

// ===========================================================================
// R2-15 — URL 前后空白被 trim
// ===========================================================================
test('P13R2-15 URL 前后空白被 trim', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: ['  https://a.com/1.mp4  ', '\\thttps://b.com/2.mp4\\n'],
}));
rt.settle();
`,
    'R2-15 trim'
  );
  assert.deepEqual(
    snap.sniffedUrls,
    ['https://a.com/1.mp4', 'https://b.com/2.mp4'],
    '入列前必须 trim'
  );
});

// ===========================================================================
// R2-16 — 重复 URL 去重（同批 + 跨批）
// ===========================================================================
test('P13R2-16 重复 URL 去重（同批 + 跨批）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: ['https://a.com/1.mp4', 'https://a.com/1.mp4', 'https://b.com/2.mp4'],
}));
rt.settle();
const afterFirst = api.sniffedMediaList.length;
const layoutAfterFirst = globalThis.__LAYOUT_LOG__.length;
api.handleWebMessage(msg({ type: 'VIDEO_FOUND', url: 'https://a.com/1.mp4' }));
rt.settle();
globalThis.__PROBE__ = {
  afterFirst,
  layoutAfterFirst,
  afterSecond: api.sniffedMediaList.length,
  layoutAfterSecond: globalThis.__LAYOUT_LOG__.length,
  foundAfterSecond: globalThis.__FOUND_LOG__.length,
};
`,
    'R2-16 去重'
  );
  assert.equal(snap.probe.afterFirst, 2, '同批重复只入列 2 条');
  assert.equal(snap.probe.afterSecond, 2, '跨批重复不再入列');
  assert.equal(snap.probe.layoutAfterFirst, 1, '首批触发一次动画');
  assert.equal(snap.probe.layoutAfterSecond, 1, '全重复批次不得触发动画');
  assert.equal(snap.probe.foundAfterSecond, 1, '全重复批次不得通知 onMediaFound');
});

// ===========================================================================
// R2-17 — 多批合并顺序（新项在前）
// ===========================================================================
test('P13R2-17 多批合并顺序（新项在前）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['https://a.com/1.mp4', 'https://b.com/2.mp4'] }));
rt.settle();
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['https://c.com/3.mp4', 'https://d.com/4.mp4'] }));
rt.settle();
`,
    'R2-17 多批合并'
  );
  assert.deepEqual(
    snap.sniffedUrls,
    ['https://c.com/3.mp4', 'https://d.com/4.mp4', 'https://a.com/1.mp4', 'https://b.com/2.mp4'],
    '新批次整体置顶，批内顺序保持'
  );
  assert.equal(snap.layoutLog.length, 2, '每批各触发一次动画');
  assert.equal(snap.foundLog.length, 2, '每批各通知一次');
});

// ===========================================================================
// R2-18 — formatCounts 各格式计数
// ===========================================================================
test('P13R2-18 formatCounts 各格式计数（含无法识别的 media）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: [
    'https://a.com/1.mp4',
    'https://a.com/2.MP4',
    'https://a.com/3.m3u8',
    'https://a.com/4.mov',
    'https://a.com/5.flv',
    'https://a.com/6.mkv',
    'https://a.com/7',
  ],
}));
rt.settle();
`,
    'R2-18 格式计数'
  );
  assert.deepEqual(
    snap.formatCounts,
    { ALL: 7, MP4: 2, M3U8: 1, MOV: 1 },
    'ALL 计全部；MP4 大小写不敏感；flv/mkv/无扩展名只计入 ALL'
  );
});

// ===========================================================================
// R2-19 — filteredMediaList：ALL 分支返回原数组同一引用
// ===========================================================================
test('P13R2-19 filteredMediaList：ALL 分支返回原数组同一引用', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['https://a.com/1.mp4', 'https://b.com/2.m3u8'] }));
rt.settle();
globalThis.__PROBE__ = { sameRef: refEqual(), filterFormat: api.filterFormat };
`,
    'R2-19 ALL 引用'
  );
  assert.equal(snap.probe.sameRef, true, 'ALL 分支必须返回 sniffedMediaList 同一引用');
  assert.equal(snap.probe.filterFormat, 'ALL', '当前筛选为 ALL');
  assert.deepEqual(snap.filteredUrls, snap.sniffedUrls, '内容一致');
});

// ===========================================================================
// R2-20 — filteredMediaList：具体格式过滤 + 顺序保持
// ===========================================================================
test('P13R2-20 filteredMediaList：具体格式过滤 + 顺序保持', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: ['https://a.com/1.mp4', 'https://b.com/2.m3u8', 'https://c.com/3.MP4', 'https://d.com/4.mov'],
}));
rt.settle();
const allRef = refEqual();
api.setFilterFormat('MP4');
rt.settle();
const mp4Ref = refEqual();
const mp4Urls = api.filteredMediaList.map((m) => m.url);
api.setFilterFormat('M3U8');
rt.settle();
const m3u8Urls = api.filteredMediaList.map((m) => m.url);
api.setFilterFormat('MOV');
rt.settle();
const movUrls = api.filteredMediaList.map((m) => m.url);
api.setFilterFormat('ALL');
rt.settle();
globalThis.__PROBE__ = { allRef, mp4Ref, mp4Urls, m3u8Urls, movUrls, backToAllRef: refEqual() };
`,
    'R2-20 格式过滤'
  );
  assert.equal(snap.probe.allRef, true, 'ALL 分支引用相等');
  assert.equal(snap.probe.mp4Ref, false, '具体格式分支必须新建数组');
  assert.deepEqual(snap.probe.mp4Urls, ['https://a.com/1.mp4', 'https://c.com/3.MP4'], 'MP4 过滤大小写不敏感且保持顺序');
  assert.deepEqual(snap.probe.m3u8Urls, ['https://b.com/2.m3u8'], 'M3U8 过滤');
  assert.deepEqual(snap.probe.movUrls, ['https://d.com/4.mov'], 'MOV 过滤');
  assert.equal(snap.probe.backToAllRef, true, '切回 ALL 后引用再次相等');
});

// ===========================================================================
// R2-21 — removeMediaItem / clearSniffedMedia
// ===========================================================================
test('P13R2-21 removeMediaItem / clearSniffedMedia 行为', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['https://a.com/1.mp4', 'https://b.com/2.mp4'] }));
rt.settle();
const layoutBefore = globalThis.__LAYOUT_LOG__.length;
const hapticBefore = globalThis.__HAPTIC_LOG__.length;
api.removeMediaItem('https://a.com/1.mp4');
rt.settle();
const afterRemove = api.sniffedMediaList.map((m) => m.url);
const layoutAfterRemove = globalThis.__LAYOUT_LOG__.length;
const hapticAfterRemove = globalThis.__HAPTIC_LOG__.length;
api.clearSniffedMedia();
rt.settle();
globalThis.__PROBE__ = {
  layoutBefore, hapticBefore,
  afterRemove, layoutAfterRemove, hapticAfterRemove,
  afterClear: api.sniffedMediaList.map((m) => m.url),
  layoutAfterClear: globalThis.__LAYOUT_LOG__.length,
  hapticAfterClear: globalThis.__HAPTIC_LOG__.length,
  foundCount: globalThis.__FOUND_LOG__.length,
};
`,
    'R2-21 列表操作'
  );
  assert.deepEqual(snap.probe.afterRemove, ['https://b.com/2.mp4'], '按 id 移除');
  assert.equal(snap.probe.layoutAfterRemove, snap.probe.layoutBefore + 1, '移除触发一次动画');
  assert.equal(snap.probe.hapticAfterRemove, snap.probe.hapticBefore + 1, '移除触发一次 Haptics');
  assert.deepEqual(snap.probe.afterClear, [], '清空后为空');
  assert.equal(snap.probe.layoutAfterClear, snap.probe.layoutAfterRemove + 1, '清空触发一次动画');
  assert.equal(snap.probe.hapticAfterClear, snap.probe.hapticAfterRemove + 1, '清空触发一次 Haptics');
  assert.equal(snap.probe.foundCount, 1, '列表操作不得触发 onMediaFound');
});

// ===========================================================================
// R2-22 — triggerManualSniff：注入脚本 + 2000ms 定时器创建
// ===========================================================================
test('P13R2-22 triggerManualSniff：注入脚本 + 2000ms 定时器创建', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.triggerManualSniff(webViewRef);
rt.settle();
globalThis.__PROBE__ = { isSniffing: api.isSniffing };
`,
    'R2-22 手动嗅探'
  );
  assert.equal(snap.probe.isSniffing, true, '触发后进入嗅探中');
  assert.equal(snap.injectLog.length, 1, '必须注入一次脚本');
  assert.equal(snap.hapticLog.length, 1, '触发一次 Warning Haptics');
  assert.deepEqual(snap.hapticLog[0], ['notification', 'warning'], 'Haptics 类型为 Warning');
  const sets = snap.timerLog.filter((t) => t.op === 'set');
  assert.equal(sets.length, 1, '必须创建 1 个定时器');
  assert.equal(sets[0].ms, 2000, '定时器延迟必须为 2000ms');
});

// ===========================================================================
// R2-23 — triggerManualSniff 重复触发：先 clearTimeout 再新建
// ===========================================================================
test('P13R2-23 triggerManualSniff 重复触发：先 clearTimeout 再新建', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.triggerManualSniff(webViewRef);
rt.settle();
api.triggerManualSniff(webViewRef);
rt.settle();
api.triggerManualSniff(webViewRef);
rt.settle();
`,
    'R2-23 重复触发'
  );
  const sets = snap.timerLog.filter((t) => t.op === 'set');
  const clears = snap.timerLog.filter((t) => t.op === 'clear');
  assert.equal(sets.length, 3, '三次触发创建 3 个定时器');
  assert.equal(clears.length, 2, '第 2、3 次触发各清理前一个定时器');
  // 顺序：set, clear, set, clear, set
  assert.deepEqual(
    snap.timerLog.map((t) => t.op),
    ['set', 'clear', 'set', 'clear', 'set'],
    '定时器操作顺序必须为 set→clear→set→clear→set'
  );
  assert.equal(snap.injectLog.length, 3, '每次触发各注入一次脚本');
});

// ===========================================================================
// R2-24 — 卸载清理定时器
// ===========================================================================
test('P13R2-24 卸载清理定时器（clearTimeout 被调用）', () => {
  const snap = assertEquivalent(
    `
rt.render(Comp);
rt.settle();
api.triggerManualSniff(webViewRef);
rt.settle();
const clearsBefore = globalThis.__TIMER_LOG__.filter((t) => t.op === 'clear').length;
rt.unmount();
const clearsAfter = globalThis.__TIMER_LOG__.filter((t) => t.op === 'clear').length;
globalThis.__PROBE__ = {
  clearsBefore,
  clearsAfter,
  lastOp: globalThis.__TIMER_LOG__[globalThis.__TIMER_LOG__.length - 1],
};
`,
    'R2-24 卸载清理'
  );
  assert.equal(
    snap.probe.clearsAfter,
    snap.probe.clearsBefore + 1,
    '卸载时必须额外调用一次 clearTimeout'
  );
  assert.equal(snap.probe.lastOp.op, 'clear', '卸载时最后一次定时器操作为 clear');
});

// ===========================================================================
// R2-25 — 纯函数直接单元测试（补充，不替代 Hook 层等价验证）
// ===========================================================================
test('P13R2-25 snifferMediaLogic 纯函数直接单元测试', () => {
  const dir = buildSandbox('after');
  try {
    const body = `
const m = await import('./src/hooks/browser/snifferMediaLogic.ts');
const out = {
  filterOptions: m.FILTER_OPTIONS.slice(),
  safe: {
    https: m.isSafeMediaUrl('https://a.com/x.mp4'),
    http: m.isSafeMediaUrl('http://a.com/x.mp4'),
    upper: m.isSafeMediaUrl('HTTPS://A.COM/X.MP4'),
    js: m.isSafeMediaUrl('javascript:alert(1)'),
    data: m.isSafeMediaUrl('data:video/mp4;base64,AA'),
    file: m.isSafeMediaUrl('file:///etc/passwd'),
    emptyHost: m.isSafeMediaUrl('https://'),
    blank: m.isSafeMediaUrl('   '),
    empty: m.isSafeMediaUrl(''),
    num: m.isSafeMediaUrl(123),
    nul: m.isSafeMediaUrl(null),
    undef: m.isSafeMediaUrl(undefined),
    obj: m.isSafeMediaUrl({}),
    padded: m.isSafeMediaUrl('  https://a.com/x.mp4  '),
  },
  norm: {
    notArray: m.normalizeIncomingUrls('https://a.com/x.mp4'),
    nul: m.normalizeIncomingUrls(null),
    undef: m.normalizeIncomingUrls(undefined),
    mixed: m.normalizeIncomingUrls([null, 1, 'https://a.com/x.mp4', 'javascript:x', '  https://b.com/y.mp4  ']),
    allBad: m.normalizeIncomingUrls(['javascript:x', 'file:///a']),
    empty: m.normalizeIncomingUrls([]),
  },
  counts: {
    empty: m.countByFormat([]),
    mixed: m.countByFormat([
      { ext: 'mp4' }, { ext: 'MP4' }, { ext: 'm3u8' }, { ext: 'mov' },
      { ext: 'flv' }, { ext: 'media' }, { ext: '' }, {},
    ]),
  },
};
const list = [{ ext: 'mp4', url: 'a' }, { ext: 'm3u8', url: 'b' }];
const all = m.filterByFormat(list, 'ALL');
const mp4 = m.filterByFormat(list, 'MP4');
const none = m.filterByFormat(list, 'MOV');
out.filter = {
  allSameRef: all === list,
  mp4Urls: mp4.map((x) => x.url),
  mp4NewArray: mp4 !== list,
  noneLen: none.length,
  unknownFormat: m.filterByFormat(list, 'WEBM').length,
};
process.stdout.write(JSON.stringify(out));
`;
    const out = runInSandbox(dir, body);

    assert.deepEqual(out.filterOptions, ['ALL', 'MP4', 'M3U8', 'MOV']);
    assert.deepEqual(out.safe, {
      https: true, http: true, upper: true,
      js: false, data: false, file: false,
      emptyHost: false, blank: false, empty: false,
      num: false, nul: false, undef: false, obj: false,
      padded: true,
    }, 'isSafeMediaUrl 白名单语义');
    assert.deepEqual(out.norm, {
      notArray: [],
      nul: [],
      undef: [],
      mixed: ['https://a.com/x.mp4', 'https://b.com/y.mp4'],
      allBad: [],
      empty: [],
    }, 'normalizeIncomingUrls 归一化语义');
    assert.deepEqual(out.counts.empty, { ALL: 0, MP4: 0, M3U8: 0, MOV: 0 });
    assert.deepEqual(out.counts.mixed, { ALL: 8, MP4: 2, M3U8: 1, MOV: 1 }, 'countByFormat 计数语义');
    assert.equal(out.filter.allSameRef, true, 'ALL 分支返回同一引用');
    assert.deepEqual(out.filter.mp4Urls, ['a']);
    assert.equal(out.filter.mp4NewArray, true, '具体格式分支新建数组');
    assert.equal(out.filter.noneLen, 0);
    assert.equal(out.filter.unknownFormat, 0, '未知格式过滤为空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// R2-26 — 结构性委托证据
// ===========================================================================
test('P13R2-26 解耦后源码确实引用 snifferMediaLogic 纯函数', () => {
  const afterSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/useBrowserSniffer.ts'),
    'utf8'
  );
  assert.match(afterSrc, /from '\.\/snifferMediaLogic'/, '必须从 snifferMediaLogic 导入');
  assert.match(afterSrc, /normalizeIncomingUrls\(/, 'pushMedia 必须调用 normalizeIncomingUrls');
  assert.match(afterSrc, /countByFormat\(/, 'formatCounts 必须调用 countByFormat');
  assert.match(afterSrc, /filterByFormat\(/, 'filteredMediaList 必须调用 filterByFormat');
  assert.match(afterSrc, /export \{ FILTER_OPTIONS \}/, 'FILTER_OPTIONS 必须重新导出以保持公开接口');
  // 原内联实现必须已移除
  assert.doesNotMatch(afterSrc, /const isSafeMediaUrl = /, '原内联 isSafeMediaUrl 必须已移除');
  assert.doesNotMatch(afterSrc, /acc\.ALL \+= 1/, '原内联 reduce 必须已移除');

  const logicSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/snifferMediaLogic.ts'),
    'utf8'
  );
  assert.match(logicSrc, /export const isSafeMediaUrl/, 'isSafeMediaUrl 必须导出');
  assert.match(logicSrc, /export const normalizeIncomingUrls/, 'normalizeIncomingUrls 必须导出');
  assert.match(logicSrc, /export const countByFormat/, 'countByFormat 必须导出');
  assert.match(logicSrc, /export const filterByFormat/, 'filterByFormat 必须导出');
  assert.doesNotMatch(logicSrc, /from 'react'/, '纯函数模块不得依赖 react');
  assert.doesNotMatch(logicSrc, /from 'react-native'/, '纯函数模块不得依赖 react-native');
  assert.doesNotMatch(logicSrc, /\bsetTimeout\s*\(/, '纯函数模块不得调用 setTimeout');
  assert.doesNotMatch(logicSrc, /\bsetState\s*\(/, '纯函数模块不得调用 setState');
  assert.doesNotMatch(logicSrc, /\buseRef\s*\(/, '纯函数模块不得调用 useRef');
  assert.doesNotMatch(logicSrc, /injectJavaScript/, '纯函数模块不得调用 WebView');
});

// ===========================================================================
// R2-27 — 故障注入①：篡改白名单判断 → 等价性必须被检测到
//   证明测试不是「永远通过」：把 isSafeMediaUrl 改成恒 true，
//   危险协议将被放行，after 快照必须与 before 不同。
// ===========================================================================
test('P13R2-27 故障注入：篡改白名单 → 检测到行为差异', () => {
  const scenario = `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({
  type: 'VIDEO_FOUND_LIST',
  urls: ['javascript:alert(1)', 'https://ok.com/a.mp4'],
}));
rt.settle();
`;
  const body = `${SCENARIO_PRELUDE}\n${scenario}\nprocess.stdout.write(JSON.stringify(snapshot()));`;

  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  try {
    // 篡改 after 沙箱中的纯函数：白名单恒 true
    const logicPath = path.join(afterSandbox, 'src/hooks/browser/snifferMediaLogic.ts');
    const orig = fs.readFileSync(logicPath, 'utf8');
    const mutated = orig.replace(
      /export const isSafeMediaUrl = \(url: unknown\): boolean => \{[\s\S]*?\n\};/,
      'export const isSafeMediaUrl = (url: unknown): boolean => true;'
    );
    assert.notEqual(mutated, orig, '故障注入必须成功替换 isSafeMediaUrl');
    fs.writeFileSync(logicPath, mutated);

    const before = runInSandbox(beforeSandbox, body);
    const after = runInSandbox(afterSandbox, body);
    // 原始 before：javascript: 被丢弃，仅 https 入列
    assert.deepEqual(before.sniffedUrls, ['https://ok.com/a.mp4'], 'before 丢弃危险协议');
    // 篡改后 after：javascript: 被放行 → 快照不同 → 等价性被破坏
    assert.notDeepEqual(after, before, '篡改白名单后必须检测到差异（证明测试有效）');
    assert.ok(
      after.sniffedUrls.includes('javascript:alert(1)'),
      '篡改后危险协议被放行，证明等价性断言确实在比较真实行为'
    );
  } finally {
    fs.rmSync(beforeSandbox, { recursive: true, force: true });
    fs.rmSync(afterSandbox, { recursive: true, force: true });
  }
});

// ===========================================================================
// R2-28 — 故障注入②：篡改合并顺序 → 等价性必须被检测到
//   把 filterByFormat 的 ALL 分支改为返回副本（破坏引用相等语义），
//   或把 countByFormat 的 ALL 计数改错，after 必须与 before 不同。
// ===========================================================================
test('P13R2-28 故障注入：篡改计数逻辑 → 检测到行为差异', () => {
  const scenario = `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['https://a.com/1.mp4', 'https://b.com/2.m3u8'] }));
rt.settle();
`;
  const body = `${SCENARIO_PRELUDE}\n${scenario}\nprocess.stdout.write(JSON.stringify(snapshot()));`;

  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  try {
    const logicPath = path.join(afterSandbox, 'src/hooks/browser/snifferMediaLogic.ts');
    const orig = fs.readFileSync(logicPath, 'utf8');
    // 把 ALL 计数改为 +2（错误），制造可观测差异
    const mutated = orig.replace('acc.ALL += 1;', 'acc.ALL += 2;');
    assert.notEqual(mutated, orig, '故障注入必须成功替换计数逻辑');
    fs.writeFileSync(logicPath, mutated);

    const before = runInSandbox(beforeSandbox, body);
    const after = runInSandbox(afterSandbox, body);
    assert.equal(before.formatCounts.ALL, 2, 'before ALL 计数为 2');
    assert.equal(after.formatCounts.ALL, 4, '篡改后 ALL 计数为 4');
    assert.notDeepEqual(after, before, '篡改计数后必须检测到差异');
  } finally {
    fs.rmSync(beforeSandbox, { recursive: true, force: true });
    fs.rmSync(afterSandbox, { recursive: true, force: true });
  }
});

// ===========================================================================
// R2-29 — 故障注入③：篡改去重/合并 → 等价性必须被检测到
//   把 normalizeIncomingUrls 的 trim 去掉，制造 URL 空白差异。
// ===========================================================================
test('P13R2-29 故障注入：篡改归一化（去 trim）→ 检测到行为差异', () => {
  const scenario = `
rt.render(Comp);
rt.settle();
api.handleWebMessage(msg({ type: 'VIDEO_FOUND_LIST', urls: ['  https://a.com/1.mp4  '] }));
rt.settle();
`;
  const body = `${SCENARIO_PRELUDE}\n${scenario}\nprocess.stdout.write(JSON.stringify(snapshot()));`;

  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  try {
    const logicPath = path.join(afterSandbox, 'src/hooks/browser/snifferMediaLogic.ts');
    const orig = fs.readFileSync(logicPath, 'utf8');
    const mutated = orig.replace('.map((url) => (url as string).trim());', '.map((url) => url as string);');
    assert.notEqual(mutated, orig, '故障注入必须成功移除 trim');
    fs.writeFileSync(logicPath, mutated);

    const before = runInSandbox(beforeSandbox, body);
    const after = runInSandbox(afterSandbox, body);
    assert.deepEqual(before.sniffedUrls, ['https://a.com/1.mp4'], 'before 已 trim');
    assert.notDeepEqual(after, before, '去掉 trim 后必须检测到差异');
  } finally {
    fs.rmSync(beforeSandbox, { recursive: true, force: true });
    fs.rmSync(afterSandbox, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p13r2DecouplingEquivalence.test.mjs ---
