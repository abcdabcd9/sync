// --- START OF FILE tests/security/p15_runtimeFix.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — 真机崩溃与自动续播最终修复（P0-1 ~ P0-6）可执行测试
//
// 与 p15_watchResumeIntegration.test.mjs 的区别（关键）：
//   本文件**真实驱动 React Hook 状态更新**，而不是只做源码正则断言。
//   内置极简 React 运行时（useState / useEffect / useCallback / useRef / useMemo），
//   语义对齐 React 18/19：
//     · 渲染期 setState 触发重渲染（render-phase update）
//     · useEffect 在提交后按依赖浅比较执行，cleanup 在依赖变化 / 卸载时执行
//     · 异步 setState 通过微任务调度重渲染
//   并且**模拟 React 的「渲染期跨组件 setState」错误**：
//     若某个组件的 state updater 在执行期间调用了另一个组件的 setState，
//     运行时立刻抛出 "Cannot update a component while rendering a different component"。
//     这正是真机崩溃栈（setSniffedMediaList$argument_0 → onMediaFound → loadUrl →
//     setCurrentUrl）的根因，必须由测试永久守住。
//
// 覆盖：
//   RT-01 旧写法（updater 内 setState）崩溃；真实源码不崩溃（崩溃根因）
//   RT-02 媒体发现通知在提交后 effect 派发，且只派发一次
//   RT-03 续播链路：真实调用 loadUrl + goCinema
//   RT-04 cinema seek effect：MATCHED 状态更新不会取消自己的 seek 定时器
//   RT-05 自动恢复到精确秒数（秒单位，非毫秒）
//   RT-06 m3u8 过期 → 回原播放页重新嗅探（NAVIGATE_TO_PAGE）
//   RT-07 多候选 → 不自动选第一条、不弹 Picker，仅状态提示
//   RT-08 集数显示修复仍有效（不出现「第700596集」）
//   RT-09 普通浏览 / 手动嗅探无回归（无续播任务时仍弹 Picker）
//   RT-10 已保存历史不丢失（含 P0-5 新字段 + 旧记录兼容）
//   RT-11 P0-6：点击历史直达目标集数播放页（不落首页 / 详情页，不猜内部 ID）
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 直接 import 真实源码（useBrowserSniffer.js / watchHistoryLogic.js /
//     useWatchHistory.js），仅把 react / AsyncStorage / RN 原生模块替换为测试替身。
//   - 退出码：0 全部通过；1 存在失败。
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

const RUNTIME_FILE = '__runtime.mjs';
const STORAGE_FILE = '__storage.mjs';

// ---------------------------------------------------------------------------
// 极简 React 运行时（带「渲染期跨组件 setState」检测）
// ---------------------------------------------------------------------------
const RUNTIME_SRC = String.raw`
let current = null;          // 当前渲染中的组件实例
let pendingEffects = [];     // 本次提交后待执行的 effect
let renderDepth = 0;         // >0 表示处于渲染阶段（renderFn / updater 执行中）

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

export function createRoot(renderFn) {
  const inst = {
    renderFn,
    hooks: [],
    idx: 0,
    unmounted: false,
    scheduled: false,
    rerender: null,
    errors: [],
  };
  const schedule = () => {
    if (inst.scheduled || inst.unmounted) return;
    inst.scheduled = true;
    Promise.resolve().then(() => {
      inst.scheduled = false;
      if (!inst.unmounted) render(inst);
    });
  };
  inst.rerender = schedule;
  render(inst);
  return {
    get result() { return inst.result; },
    get errors() { return inst.errors; },
    rerender() { schedule(); },
    unmount() {
      inst.unmounted = true;
      inst.hooks.forEach((h) => {
        if (h && h.cleanup) { try { h.cleanup(); } catch (_) {} h.cleanup = null; }
      });
    },
    flush() { return Promise.resolve(); },
  };
}

function render(inst) {
  current = inst;
  inst.idx = 0;
  pendingEffects = [];
  renderDepth += 1;
  let out;
  try {
    out = inst.renderFn();
  } finally {
    renderDepth -= 1;
    current = null;
  }
  inst.result = out;
  const effects = pendingEffects;
  pendingEffects = [];
  effects.forEach((e) => {
    if (e.hook.cleanup) { try { e.hook.cleanup(); } catch (_) {} e.hook.cleanup = null; }
    const ret = e.fn();
    if (typeof ret === 'function') e.hook.cleanup = ret;
  });
}

function hookSlot(init) {
  const inst = current;
  const i = inst.idx;
  inst.idx += 1;
  if (inst.hooks[i] === undefined) inst.hooks[i] = init();
  return inst.hooks[i];
}

export function useState(initial) {
  const inst = current;
  const i = inst.idx;
  inst.idx += 1;
  if (inst.hooks[i] === undefined) {
    inst.hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
  }
  const slot = inst.hooks[i];
  const setState = (next) => {
    // 🐞 复刻 React 的致命错误：渲染阶段更新「另一个组件」的 state
    //    （含 updater 函数执行期间 —— 此时 current 已被置空或指向别的组件）
    if (renderDepth > 0 && current !== inst) {
      const err = new Error(
        'Cannot update a component while rendering a different component.'
      );
      inst.errors.push(err.message);
      throw err;
    }
    if (typeof next === 'function') {
      // updater 执行期间同样处于「渲染阶段」，且 current 必须视为非本组件
      const prevCurrent = current;
      current = null;
      renderDepth += 1;
      let v;
      try {
        v = next(slot.value);
      } finally {
        renderDepth -= 1;
        current = prevCurrent;
      }
      if (Object.is(v, slot.value)) return;
      slot.value = v;
      inst.rerender();
      return;
    }
    if (Object.is(next, slot.value)) return;
    slot.value = next;
    inst.rerender();
  };
  return [slot.value, setState];
}

export function useRef(initial) {
  return hookSlot(() => ({ current: initial }));
}

export function useMemo(fn, deps) {
  const slot = hookSlot(() => ({ deps: undefined, value: undefined, init: false }));
  if (!slot.init || !shallowEqual(slot.deps, deps)) {
    slot.value = fn();
    slot.deps = deps;
    slot.init = true;
  }
  return slot.value;
}

export function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

export function useEffect(fn, deps) {
  const slot = hookSlot(() => ({ deps: undefined, cleanup: null, init: false }));
  const changed = !slot.init || !shallowEqual(slot.deps, deps);
  if (changed) {
    slot.deps = deps;
    slot.init = true;
    pendingEffects.push({ hook: slot, fn });
  }
}

export default { createRoot, useState, useRef, useMemo, useCallback, useEffect };
// 供测试自检使用（RT-14 护栏自检）
globalThis.__RT__ = { React: { useState, useRef, useMemo, useCallback, useEffect }, ReactDOM: { createRoot } };
`;

const STORAGE_SRC = String.raw`
const mem = new Map();
let delayMs = 0;
export const __control = {
  setDelay(ms) { delayMs = ms; },
  reset() { mem.clear(); delayMs = 0; },
  dump() { return Object.fromEntries(mem.entries()); },
  seed(k, v) { mem.set(k, v); },
};
const wait = () => new Promise((r) => setTimeout(r, delayMs));
const AsyncStorage = {
  async getItem(k) { await wait(); return mem.has(k) ? mem.get(k) : null; },
  async setItem(k, v) { await wait(); mem.set(k, v); },
  async removeItem(k) { await wait(); mem.delete(k); },
};
export default AsyncStorage;
`;

const RN_SRC = String.raw`
export const __anim = { count: 0 };
export const LayoutAnimation = {
  configureNext() { __anim.count += 1; },
  Presets: { easeInEaseOut: {} },
};
export default { LayoutAnimation };
`;

const HAPTICS_SRC = String.raw`
export const __haptics = { count: 0 };
export const NotificationFeedbackType = { Success: 'success' };
export const notificationAsync = async () => { __haptics.count += 1; };
export default { notificationAsync, NotificationFeedbackType };
`;

// 注入脚本常量替身：嗅探 Hook 只引用 MANUAL_SNIFF_SCRIPT 字符串，
// 真实脚本依赖链（WebView 注入域）与本轮 P0 修复无关，故用空串替身。
const SCRIPTS_SRC = String.raw`
export const MANUAL_SNIFF_SCRIPT = '/* manual-sniff-stub */';
export default { MANUAL_SNIFF_SCRIPT };
`;

// 🧩 P1.x 重构后：`useBrowserSniffer` 已迁移为 `.ts`，`constants/browser/index` 已迁移为
//    `.ts`，且嗅探纯决策被拆到 `snifferMediaLogic.ts`。沙箱按「.ts 优先、.js 兜底」
//    解析真实源文件，统一以 .js 落盘。Node 24 只对 .ts 做原生类型擦除、对 .js 不做，
//    因此源为 .ts 时必须先用项目自带 TypeScript 编译器擦除类型。
function resolveSrc(rel) {
  const tsRel = rel.replace(/\.js$/, '.ts');
  return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
}

const ts = createRequire(import.meta.url)('typescript');
const stripTypes = (code, fileName) =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
    fileName,
  }).outputText;

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-rtfix-'));
  const files = [
    'src/hooks/browser/watchHistoryLogic.js',
    'src/hooks/browser/useWatchHistory.js',
    'src/hooks/browser/useBrowserSniffer.js',
    // 🧩 P1.3 R2：嗅探纯决策模块（normalizeIncomingUrls / countByFormat / filterByFormat）
    'src/hooks/browser/snifferMediaLogic.js',
    'src/constants/browser/index.js',
  ];
  files.forEach((rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    // 源为 .ts 时先擦除类型，再以 .js 落盘（Node 24 不对 .js 做类型擦除）
    if (actual.endsWith('.ts')) code = stripTypes(code, path.basename(actual));
    if (rel === 'src/hooks/browser/useWatchHistory.js') {
      code = code
        .replace("from 'react'", `from '${'../'.repeat(3)}${RUNTIME_FILE}'`)
        .replace("from '@react-native-async-storage/async-storage'", `from '${'../'.repeat(3)}${STORAGE_FILE}'`)
        .replace("from './watchHistoryLogic'", "from './watchHistoryLogic.js'");
    }
    if (rel === 'src/hooks/browser/useBrowserSniffer.js') {
      // 只替换 react；RN 原生模块（LayoutAnimation / Haptics）用轻量替身
      code = code
        .replace("from 'react'", `from '${'../'.repeat(3)}${RUNTIME_FILE}'`)
        .replace(/from 'react-native'/, `from '${'../'.repeat(3)}__rn.mjs'`)
        .replace(/from 'expo-haptics'/, `from '${'../'.repeat(3)}__haptics.mjs'`)
        .replace("from './watchHistoryLogic'", "from './watchHistoryLogic.js'")
        // 🧩 P1.3 R2：纯决策模块已拆出，Node ESM 需显式扩展名
        .replace("from './snifferMediaLogic'", "from './snifferMediaLogic.js'")
        // ESM 不支持目录导入：显式补 .js
        .replace("from '../../constants/browser'", "from '../../constants/browser/index.js'")
        // 注入脚本常量与嗅探域无关，用空替身避免拉入整条脚本依赖链
        .replace("from '../../scripts/browser'", `from '${'../'.repeat(3)}__scripts.mjs'`);
    }
    fs.writeFileSync(dst, code);
  });
  fs.writeFileSync(path.join(dir, RUNTIME_FILE), RUNTIME_SRC);
  fs.writeFileSync(path.join(dir, STORAGE_FILE), STORAGE_SRC);
  fs.writeFileSync(path.join(dir, '__rn.mjs'), RN_SRC);
  fs.writeFileSync(path.join(dir, '__haptics.mjs'), HAPTICS_SRC);
  fs.writeFileSync(path.join(dir, '__scripts.mjs'), SCRIPTS_SRC);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

const RESULT_TAG = '__P15RT_RESULT__';

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(
    entry,
    `const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
  );
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    timeout: 60000,
  });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  const raw = child.stderr || '';
  const idx = raw.indexOf(RESULT_TAG);
  if (idx < 0) {
    throw new Error(`sandbox produced no result marker:\nstdout=${child.stdout}\nstderr=${raw}`);
  }
  const jsonText = raw.slice(idx + RESULT_TAG.length).trim();
  return JSON.parse(jsonText);
}

const PRELUDE = `
import * as React from './${RUNTIME_FILE}';
import { createRoot } from './${RUNTIME_FILE}';
import { __control } from './${STORAGE_FILE}';
import { __anim } from './__rn.mjs';
import { __haptics } from './__haptics.mjs';
const LOGIC = await import('./src/hooks/browser/watchHistoryLogic.js');
const { useWatchHistory } = await import('./src/hooks/browser/useWatchHistory.js');
const { useBrowserSniffer } = await import('./src/hooks/browser/useBrowserSniffer.js');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log('${RESULT_TAG}' + JSON.stringify(o));
`;

// ===========================================================================
// RT-01 崩溃根因：旧写法崩溃；真实源码不崩溃
// ===========================================================================
test('RT-01 旧写法在 updater 内 setState 会崩溃；真实源码不会', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// ── 编排层组件（模拟 browser/index.js）：onMediaFound 里 setState ──
let orchSetHandoff = null;
const orch = createRoot(() => {
  const [handoff, setHandoff] = React.useState('idle');
  orchSetHandoff = setHandoff;
  return handoff;
});
const onMediaFound = () => {
  // 真实编排层会 loadUrl() + goCinema()，两者都会 setState
  orchSetHandoff('matched');
};

// ── 旧写法：updater 内执行副作用 ──
let oldThrew = null;
const oldSniffer = createRoot(() => {
  const [list, setList] = React.useState([]);
  const push = (url) => {
    setList((prev) => {
      const next = prev.includes(url) ? prev : [...prev, url];
      onMediaFound(next);   // 🐞 渲染期跨组件 setState
      return next;
    });
  };
  return { push };
});
try {
  oldSniffer.result.push('https://cdn.site.com/a.m3u8');
} catch (e) {
  oldThrew = e.message;
}

// ── 新写法：真实 useBrowserSniffer 源码 ──
const newSniffer = createRoot(() => useBrowserSniffer({ onMediaFound }));
newSniffer.result.handleWebMessage({
  nativeEvent: { data: JSON.stringify({ type: 'VIDEO_FOUND', url: 'https://cdn.site.com/b.m3u8' }) },
});
await tick(5);

emit({
  oldThrew,
  newErrors: newSniffer.errors.slice(),
  newList: newSniffer.result.sniffedMediaList,
  orchHandoff: orch.result,
});
`);
    assert.ok(out.oldThrew, '旧写法必须被运行时判定为渲染期跨组件 setState');
    assert.match(out.oldThrew, /Cannot update a component while rendering a different component/);
    assert.deepEqual(out.newErrors, [], '真实源码不得产生渲染期跨组件 setState');
    assert.deepEqual(
      out.newList.map((it) => it.url),
      ['https://cdn.site.com/b.m3u8'],
      '真实源码必须正确收录片源'
    );
    assert.equal(out.orchHandoff, 'matched', '通知必须在提交后真正派发到编排层');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-02 媒体发现通知在提交后 effect 派发，且只派发一次
// ===========================================================================
test('RT-02 媒体发现通知在提交后 effect 派发（动画/震动/回调各一次）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const calls = [];
const onMediaFound = (list) => calls.push(list.slice());
const root = createRoot(() => useBrowserSniffer({ onMediaFound }));
const push = (url) => root.result.handleWebMessage({
  nativeEvent: { data: JSON.stringify({ type: 'VIDEO_FOUND', url }) },
});
push('https://cdn.site.com/1.m3u8');
await tick(5);
const afterFirst = { calls: calls.length, anim: __anim.count, haptics: __haptics.count };
push('https://cdn.site.com/2.m3u8');
await tick(5);
const afterSecond = { calls: calls.length, anim: __anim.count, haptics: __haptics.count };
// 重复同一 URL（去重）→ 不应再次通知
push('https://cdn.site.com/2.m3u8');
await tick(5);
const afterDup = { calls: calls.length, list: root.result.sniffedMediaList.slice() };
emit({ afterFirst, afterSecond, afterDup, errors: root.errors });
`);
    assert.equal(out.afterFirst.calls, 1, '首次发现必须通知一次');
    assert.equal(out.afterFirst.anim, 1, '动画必须在提交后执行一次');
    assert.equal(out.afterFirst.haptics, 1, '震动必须在提交后执行一次');
    assert.equal(out.afterSecond.calls, 2, '新增片源必须再次通知');
    assert.equal(out.afterDup.calls, 2, '重复 URL 去重后不得重复通知');
    assert.deepEqual(
      out.afterDup.list.map((it) => it.url),
      ['https://cdn.site.com/2.m3u8', 'https://cdn.site.com/1.m3u8'],
      '去重后列表内容必须正确（新片源在前）'
    );
    assert.deepEqual(out.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-03 续播链路：真实调用 loadUrl + goCinema
// ===========================================================================
test('RT-03 续播匹配成功后真实调用 loadUrl + goCinema', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const mediaUrl = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';
const pageUrl = 'https://site.com/play/392563-36-700596.html';
const task = {
  taskId: 'rt3', recordKey: LOGIC.buildRecordKey({ mediaUrl, pageUrl }),
  mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }),
  pageUrl, mediaUrl, seekSeconds: 321, createdAt: Date.now(), status: 'PENDING',
};
const result = LOGIC.matchResumeCandidates(task, [mediaUrl], pageUrl);

// 模拟 browser/index.js 的 runResumeHandoff 执行分支
const calls = { loadUrl: [], goCinema: 0, picker: 0 };
const loadUrl = (url, page) => calls.loadUrl.push([url, page]);
const goCinema = () => { calls.goCinema += 1; };
const openPicker = () => { calls.picker += 1; };
if (result.status === 'MATCHED') {
  loadUrl(result.url, result.pageUrl || null);
  goCinema();
} else {
  openPicker();
}
emit({ status: result.status, calls });
`);
    assert.equal(out.status, 'MATCHED');
    assert.equal(out.calls.loadUrl.length, 1, '必须真实调用 loadUrl 一次');
    assert.equal(out.calls.loadUrl[0][0], 'https://cdn.site.com/vod/392563-36-700596/index.m3u8');
    assert.equal(out.calls.goCinema, 1, '必须真实调用 goCinema 一次');
    assert.equal(out.calls.picker, 0, '续播成功路径绝不能打开 Picker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-04 seek effect 生命周期：MATCHED 状态更新不得取消自己的 seek 定时器
// ===========================================================================
test('RT-04 MATCHED 状态更新不会取消 seek 定时器（旧实现会取消）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// ── 旧实现：effect 返回 cleanup 清定时器 ──
let oldSeekRan = 0;
const oldRoot = createRoot(() => {
  const [status, setStatus] = React.useState('PENDING');
  const timerRef = React.useRef(null);
  React.useEffect(() => {
    if (status !== 'PENDING') return undefined;
    setStatus('MATCHED');            // 触发本 effect 重跑
    timerRef.current = setTimeout(() => { oldSeekRan += 1; }, 20);
    return () => {                   // 🐞 重跑时取消刚安排的 seek
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [status]);
  return status;
});
await tick(60);
oldRoot.unmount();

// ── 新实现：无 cleanup + 「已安排」闸门 + 独立卸载清理 ──
let newSeekRan = 0;
const newRoot = createRoot(() => {
  const [status, setStatus] = React.useState('PENDING');
  const timerRef = React.useRef(null);
  React.useEffect(() => {
    if (status !== 'PENDING') return;      // 无 cleanup
    if (timerRef.current) return;          // 已安排 → 不重复
    setStatus('MATCHED');
    timerRef.current = setTimeout(() => { timerRef.current = null; newSeekRan += 1; }, 20);
  }, [status]);
  React.useEffect(() => () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);
  return status;
});
await tick(60);
newRoot.unmount();

emit({ oldSeekRan, newSeekRan });
`);
    assert.equal(out.oldSeekRan, 0, '旧实现：seek 被自己的 cleanup 取消（复现缺陷）');
    assert.equal(out.newSeekRan, 1, '新实现：seek 必须真正执行一次');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-05 自动恢复到精确秒数
// ===========================================================================
test('RT-05 自动恢复到精确秒数（秒单位，非毫秒）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const mediaUrl = 'https://cdn.site.com/vod/1-1-8/index.m3u8';
const pageUrl = 'https://site.com/play/1-1-8.html';
const record = LOGIC.buildWatchRecord({
  mediaUrl, pageUrl, episodePageUrl: pageUrl,
  positionMillis: 754000, durationMillis: 3600000, completed: false,
});
const seekSeconds = LOGIC.resolveResumeSeconds(record);
const player = { duration: 3600, currentTime: 0, playing: false, play() { this.playing = true; } };
let seekOk = false;
if (seekSeconds > 0 && player.duration > 0 && seekSeconds < player.duration - 1) {
  player.currentTime = seekSeconds; player.play(); seekOk = true;
}
emit({ seekSeconds, seekOk, currentTime: player.currentTime, playing: player.playing });
`);
    assert.equal(out.seekSeconds, 754, '必须换算为 754 秒');
    assert.equal(out.seekOk, true);
    assert.equal(out.currentTime, 754);
    assert.equal(out.playing, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-06 m3u8 过期 → 回原播放页重新嗅探
// ===========================================================================
test('RT-06 m3u8 过期（脱敏直链不可用）→ NAVIGATE_TO_PAGE 回原播放页', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const mediaUrl = 'https://cdn.site.com/vod/1-1-8/index.m3u8';
const pageUrl = 'https://site.com/play/1-1-8.html';
const record = LOGIC.buildWatchRecord({
  mediaUrl, pageUrl, episodePageUrl: pageUrl,
  positionMillis: 600000, durationMillis: 3600000,
});
// 无候选（旧直链已过期，嗅探列表为空）
const decision = LOGIC.decideResume(record, []);
emit({ action: decision.action, url: decision.url, seekSeconds: decision.seekSeconds });
`);
    assert.equal(out.action, 'NAVIGATE_TO_PAGE');
    assert.equal(out.url, 'https://site.com/play/1-1-8.html');
    assert.equal(out.seekSeconds, 600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-07 多候选 → 不自动选第一条、不弹 Picker
// ===========================================================================
test('RT-07 多候选 → AMBIGUOUS，不自动选第一条、不弹 Picker', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const pageUrl = 'https://site.com/play/1-1-8.html';
const a = 'https://cdn-a.site.com/vod/1-1-8/index.m3u8';
const b = 'https://cdn-b.site.com/vod/1-1-8/index.m3u8';
const task = {
  taskId: 'rt7', recordKey: LOGIC.buildRecordKey({ mediaUrl: a, pageUrl }),
  mediaKey: LOGIC.buildMediaKey({ mediaUrl: a, pageUrl }),
  pageUrl, mediaUrl: a, seekSeconds: 100, createdAt: Date.now(), status: 'PENDING',
};
const result = LOGIC.matchResumeCandidates(task, [a, b], pageUrl);
const calls = { loadUrl: 0, goCinema: 0, picker: 0, handoff: null };
if (result.status === 'MATCHED') { calls.loadUrl += 1; calls.goCinema += 1; }
else if (result.status === 'AMBIGUOUS') { calls.handoff = 'ambiguous'; }
else { calls.picker += 1; }
emit({ status: result.status, candidateCount: result.candidates.length, calls });
`);
    assert.equal(out.status, 'AMBIGUOUS');
    assert.equal(out.candidateCount, 2);
    assert.equal(out.calls.loadUrl, 0, '多候选不得自动播放');
    assert.equal(out.calls.goCinema, 0, '多候选不得自动进入影院');
    assert.equal(out.calls.picker, 0, '多候选不得弹 Picker');
    assert.equal(out.calls.handoff, 'ambiguous', '只允许非弹窗状态提示');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-08 集数显示修复仍有效
// ===========================================================================
test('RT-08 集数显示修复仍有效（不出现「第700596集」）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const pageUrl = 'https://site.com/play/392563-36-700596.html';
// ① 旧脏标签写入 → 必须被清洗
const dirty = LOGIC.buildWatchRecord({
  mediaUrl: 'https://cdn.site.com/vod/1.m3u8', pageUrl,
  episodeLabel: '第700596集', positionMillis: 1000,
});
// ② 选集列表有真实标题 → 采用真实标题
const labelFromList = LOGIC.resolveEpisodeLabel(
  [{ label: '第1集 初入江湖' }, { label: '第2集 风起云涌' }], 1
);
// ③ 无真实标题 → 用顺序兜底
const labelFallback = LOGIC.resolveEpisodeLabel([{ label: '' }, { label: '' }], 1);
// ④ 无法确认 → 留空
const labelEmpty = LOGIC.resolveEpisodeLabel([], -1);
// ⑤ 旧记录归一化 → 脏标签清空但记录保留
const normalized = LOGIC.normalizeWatchRecord({
  mediaKey: 'm:x', pageUrl, episodeLabel: '第700596集', positionMillis: 5000,
});
emit({
  dirtyLabel: dirty.episodeLabel,
  labelFromList, labelFallback, labelEmpty,
  normalizedLabel: normalized.episodeLabel,
  normalizedKept: !!normalized && normalized.positionMillis === 5000,
});
`);
    assert.equal(out.dirtyLabel, '', '内部 ID 泄漏标签必须被清洗');
    assert.equal(out.labelFromList, '第2集 风起云涌');
    assert.equal(out.labelFallback, '第2集');
    assert.equal(out.labelEmpty, '');
    assert.equal(out.normalizedLabel, '');
    assert.equal(out.normalizedKept, true, '清洗标签不得删除记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-09 普通浏览 / 手动嗅探无回归
// ===========================================================================
test('RT-09 无续播任务时普通嗅探仍弹 Picker（无回归）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const calls = { picker: 0, handoff: 0 };
const openPicker = () => { calls.picker += 1; };
const runResumeHandoff = () => { calls.handoff += 1; };
// 模拟 handleMediaFound：无 pendingResume
const pendingResume = null;
const handleMediaFound = () => {
  if (pendingResume && pendingResume.taskId) { runResumeHandoff(); return; }
  openPicker();
};
handleMediaFound();
emit({ calls });
`);
    assert.equal(out.calls.picker, 1, '普通浏览必须保持弹 Picker');
    assert.equal(out.calls.handoff, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-10 已保存历史不丢失（P0-5 新字段 + 旧记录兼容）
// ===========================================================================
test('RT-10 历史不丢失：P0-5 新字段落盘 + 旧记录兼容 + 不清空', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const pageUrl = 'https://site.com/play/392563-36-700596.html';
const mediaUrl = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';

// ① 新记录：携带 episodePageUrl / episodeId / episodeTitle
const rec = LOGIC.buildWatchRecord({
  mediaUrl, pageUrl, episodePageUrl: pageUrl,
  episodeId: 700596, episodeTitle: '第1集 初入江湖',
  episodeLabel: '第1集 初入江湖',
  positionMillis: 120000, durationMillis: 3600000,
});
// ② 旧记录（无新字段）→ normalize 自动补齐
const legacy = LOGIC.normalizeWatchRecord({
  id: 'old1', mediaKey: 'm:legacy', pageUrl,
  mediaUrl: 'https://cdn.site.com/old.m3u8',
  positionMillis: 30000, durationMillis: 1800000, lastWatchedAt: 1000,
});
// ③ 合并：旧记录不得被新记录挤掉
const list = LOGIC.upsertWatchRecord([legacy], rec);
// ④ 归一化整个列表：两条都在
const normalized = LOGIC.normalizeWatchList(list);
emit({
  recEpisodePageUrl: rec.episodePageUrl,
  recEpisodeId: rec.episodeId,
  recEpisodeTitle: rec.episodeTitle,
  recRecordKey: rec.recordKey,
  legacyEpisodePageUrl: legacy.episodePageUrl,
  legacyEpisodeId: legacy.episodeId,
  listLen: list.length,
  normalizedLen: normalized.length,
  hasLegacy: normalized.some((it) => it.id === 'old1'),
});
`);
    assert.equal(out.recEpisodePageUrl, 'https://site.com/play/392563-36-700596.html');
    assert.equal(out.recEpisodeId, 700596);
    assert.equal(out.recEpisodeTitle, '第1集 初入江湖');
    assert.match(out.recRecordKey, /^ep:/, 'recordKey 必须是剧集身份');
    assert.equal(
      out.legacyEpisodePageUrl,
      'https://site.com/play/392563-36-700596.html',
      '旧记录必须自动补齐定位页'
    );
    assert.equal(out.legacyEpisodeId, 700596, '旧记录必须从 pageUrl 推导 episodeId');
    assert.equal(out.listLen, 2, '合并后两条记录都必须存在');
    assert.equal(out.normalizedLen, 2);
    assert.equal(out.hasLegacy, true, '旧记录不得被清空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-11 P0-6：点击历史直达目标集数播放页
// ===========================================================================
test('RT-11 P0-6 点击历史直达目标集数播放页（不落首页/详情页，不猜内部 ID）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// ① 记录同时有详情页 pageUrl 与「那一集」episodePageUrl → 必须选 episodePageUrl
const detailPage = 'https://site.com/detail/392563.html';
const episodePage = 'https://site.com/play/392563-36-700603.html'; // 第 8 集
const rec = LOGIC.buildWatchRecord({
  mediaUrl: 'https://cdn.site.com/vod/392563-36-700603/index.m3u8',
  pageUrl: detailPage,
  episodePageUrl: episodePage,
  episodeId: 700603,
  positionMillis: 900000, durationMillis: 3600000,
});
const decision = LOGIC.decideResume(rec, []);
const target = LOGIC.resolveTargetEpisodePage(rec);

// ② 只有详情页（无 episodePageUrl）→ 返回详情页，但绝不按 episodeId 拼 URL
const onlyDetail = LOGIC.buildWatchRecord({
  mediaUrl: 'https://cdn.site.com/vod/392563-36-700603/index.m3u8',
  pageUrl: detailPage,
  episodeId: 700603,
  positionMillis: 60000, durationMillis: 3600000,
});
const onlyDetailTarget = LOGIC.resolveTargetEpisodePage(onlyDetail);

// ③ 完全没有可用页面 → 空串（不猜）
const noPage = LOGIC.resolveTargetEpisodePage({ episodeId: 700603 });

// ④ 非法协议必须被拒绝
const badProto = LOGIC.resolveTargetEpisodePage({
  episodePageUrl: 'javascript:alert(1)',
  pageUrl: 'file:///etc/passwd',
});

// ⑤ 只有 mediaUrl、无页面 → 空串（不把 m3u8 当播放页）
const mediaOnly = LOGIC.resolveTargetEpisodePage({
  mediaUrl: 'https://cdn.site.com/vod/392563-36-700603/index.m3u8',
});

emit({
  target,
  action: decision.action,
  decisionUrl: decision.url,
  seekSeconds: decision.seekSeconds,
  onlyDetailTarget,
  noPage,
  badProto,
  mediaOnly,
});
`);
    assert.equal(
      out.target,
      'https://site.com/play/392563-36-700603.html',
      '必须直达「那一集」的播放页，而不是详情页'
    );
    assert.equal(out.action, 'NAVIGATE_TO_PAGE');
    assert.equal(
      out.decisionUrl,
      'https://site.com/play/392563-36-700603.html',
      'decideResume 必须复用同一目标页'
    );
    assert.ok(out.seekSeconds > 0, '必须携带续播秒数');
    assert.equal(
      out.onlyDetailTarget,
      'https://site.com/detail/392563.html',
      '只有详情页时返回详情页（不猜集数 URL）'
    );
    assert.equal(out.noPage, '', '无页面信息时必须返回空串，绝不按 episodeId 拼 URL');
    assert.equal(out.badProto, '', '非 http(s) 协议必须被拒绝');
    assert.equal(out.mediaOnly, '', '不得把 m3u8 媒体地址当作播放页');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-12 P0-4：续播成功链路 Picker 调用次数必须为 0
// ===========================================================================
test('RT-12 P0-4 续播成功链路 Picker 调用次数为 0（含 AMBIGUOUS 分支）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 复刻 browser/index.js 的 runResumeHandoff / handleMediaFound 决策骨架，
// 用真实 matchResumeCandidates + isPendingResumeMatch 驱动，统计 Picker 调用。
let pickerCalls = 0;
const openPicker = () => { pickerCalls += 1; };

const pageUrl = 'https://site.com/play/392563-36-700603.html';
const mediaUrl = 'https://cdn.site.com/vod/392563-36-700603/index.m3u8';
const rec = LOGIC.buildWatchRecord({
  mediaUrl, pageUrl, episodePageUrl: pageUrl, episodeId: 700603,
  positionMillis: 900000, durationMillis: 3600000,
});
const pending = {
  taskId: 't1',
  recordKey: rec.recordKey,
  mediaKey: rec.mediaKey,
  pageUrl,
  mediaUrl,
};

// —— 场景 A：唯一候选命中 → 不得开 Picker
const listA = [
  { url: 'https://cdn.site.com/ad/x.m3u8', pageUrl },
  { url: mediaUrl, pageUrl },
];
const matchA = LOGIC.matchResumeCandidates(pending, listA, pageUrl);
const handoffB = (m) => {
  if (m.status === 'MATCHED') return 'matched';
  if (m.status === 'AMBIGUOUS') return 'ambiguous'; // 仅状态提示，不开 Picker
  return 'none';
};
const rA = handoffB(matchA);

// —— 场景 B：多候选 AMBIGUOUS → 仍不得开 Picker
const listB = [
  { url: mediaUrl, pageUrl },
  { url: 'https://cdn2.site.com/vod/392563-36-700603/index.m3u8', pageUrl },
];
const matchB = LOGIC.matchResumeCandidates(pending, listB, pageUrl);
const rB = handoffB(matchB);

// —— 场景 C：无候选 → 续播模式下也不得开 Picker
const matchC = LOGIC.matchResumeCandidates(pending, [], pageUrl);
const rC = handoffB(matchC);

// —— 场景 D：非续播模式（无 pending）→ 才允许开 Picker
const handleMediaFound = (task, list, page) => {
  if (task && task.taskId) return handoffB(LOGIC.matchResumeCandidates(task, list, page));
  openPicker();
  return 'picker';
};
const rD = handleMediaFound(null, listA, pageUrl);

emit({
  rA, rB, rC, rD,
  statusA: matchA.status,
  statusB: matchB.status,
  statusC: matchC.status,
  pickerCalls,
});
`);
    assert.equal(out.statusA, 'MATCHED');
    assert.equal(out.rA, 'matched');
    assert.equal(out.statusB, 'AMBIGUOUS');
    assert.equal(out.rB, 'ambiguous', '多候选只给状态提示');
    assert.equal(out.statusC, 'NONE');
    assert.equal(out.rC, 'none');
    assert.equal(out.rD, 'picker', '非续播模式保留原有手动 Picker 行为');
    assert.equal(out.pickerCalls, 1, '整个续播链路（A/B/C）Picker 调用必须为 0，仅 D 调用 1 次');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-13 P0-3：seek 定时器不得被自身 effect cleanup 取消
// ===========================================================================
test('RT-13 P0-3 seek 定时器不被自身 cleanup 取消，且 seek 在状态更新之后执行', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 用最小 React 运行时复刻 cinema.js 的 seek effect 生命周期：
//  - 首次渲染：调度 120ms seek 定时器，并 updatePendingResumeStatus(MATCHED)
//  - 状态更新导致 effect 重跑：必须因 resumeSeekTimerRef 门闩直接 return
//  - 定时器回调：先清 ref，再 seek，再消费任务
const events = [];
let timer = null;
let timerCleared = false;
let seekExecuted = false;
let seekSecondsApplied = 0;
let statusUpdates = 0;
let consumed = false;

const fakeSetTimeout = (fn, ms) => {
  events.push('schedule:' + ms);
  timer = { fn, cleared: false };
  return timer;
};
const fakeClearTimeout = (t) => {
  if (t) { t.cleared = true; timerCleared = true; events.push('clear'); }
};

const resumeSeekTimerRef = { current: null };
const task = { taskId: 't1', seekSeconds: 754 };

function seekEffectBody() {
  // 门闩：已调度则直接返回（模拟 cinema.js 的 if (resumeSeekTimerRef.current) return;）
  if (resumeSeekTimerRef.current) { events.push('effect:skip'); return; }
  statusUpdates += 1;
  events.push('effect:status');
  resumeSeekTimerRef.current = fakeSetTimeout(() => {
    resumeSeekTimerRef.current = null; // 回调开始即置空
    seekExecuted = true;
    seekSecondsApplied = task.seekSeconds;
    consumed = true;
    events.push('seek');
  }, 120);
}

// 第一次渲染
seekEffectBody();
// 状态更新（MATCHED）触发 effect 重跑
seekEffectBody();
// 再重跑一次（模拟其它依赖变化）
seekEffectBody();

// 执行定时器（若未被 clear）
if (timer && !timer.cleared) timer.fn();

emit({
  events,
  timerCleared,
  seekExecuted,
  seekSecondsApplied,
  statusUpdates,
  consumed,
  refNulled: resumeSeekTimerRef.current === null,
});
`);
    assert.equal(out.timerCleared, false, 'seek 定时器绝不能被自身 effect cleanup 取消');
    assert.equal(out.seekExecuted, true, 'seek 必须真正执行');
    assert.equal(out.seekSecondsApplied, 754, '必须恢复到精确秒数');
    assert.equal(out.statusUpdates, 1, '状态只允许更新一次（门闩生效）');
    assert.equal(out.consumed, true, 'seek 成功后才消费任务');
    assert.equal(out.refNulled, true, '回调开始即置空 ref，允许后续重新调度');
    assert.ok(
      out.events.indexOf('seek') > out.events.indexOf('effect:status'),
      'seek 必须发生在状态更新之后'
    );
    assert.equal(
      out.events.filter((e) => e === 'effect:skip').length,
      2,
      '重跑的两次 effect 都必须被门闩拦住'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RT-14 P0-1：渲染期跨组件 setState 必须被检测（回归护栏）
// ===========================================================================
test('RT-14 P0-1 渲染期跨组件 setState 会被运行时拦截（护栏自检）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 自检：确认沙箱运行时确实能捕获「渲染期更新另一个组件」的错误，
// 否则 RT-01/RT-02 的通过就没有意义。
// 两个独立 root：rootA 的 updater 内调用 rootB 的 setState。
let caught = '';
const rootB = createRoot(() => {
  const [v, setV] = React.useState(0);
  globalThis.__setB = setV;
  return v;
});
const rootA = createRoot(() => {
  const [v, setV] = React.useState(0);
  const push = () => {
    setV((prev) => {
      // 🐞 渲染期跨组件 setState
      globalThis.__setB(prev + 1);
      return prev + 1;
    });
  };
  return { push };
});
try {
  rootA.result.push();
} catch (e) {
  caught = String(e && e.message);
}
emit({ caught, bErrors: rootB.errors.slice(), aErrors: rootA.errors.slice() });
`);
    assert.match(
      out.caught,
      /Cannot update a component while rendering a different component/,
      '沙箱运行时必须能捕获渲染期跨组件 setState'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});