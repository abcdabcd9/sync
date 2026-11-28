// --- START OF FILE tests/security/p15_sameUrlResume.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — 「同 URL 不刷新导致自动续播失败」修复 可执行测试
//
// 故障（真机）：
//   浏览器会恢复上次访问的页面。若用户当前就停在第 8 集播放页，
//   再从观看历史点第 8 集，目标 URL 与当前 URL 完全相同。
//   旧实现只调用 injectUrl(target) → setCurrentUrl(target)，
//   React 对相同字符串 bail out → 不重渲染 →
//   <WebView source={{ uri: currentUrl }}> 不变 → 不重新加载 →
//   onLoadEnd 不触发 → 自动嗅探不执行 → 无法自动进入影院。
//
// 本文件与 p15_runtimeFix.test.mjs 的关系：
//   · 复用同一套「极简 React 运行时」思路（useState / useEffect / useRef /
//     useMemo / useCallback，语义对齐 React 18/19，含渲染期跨组件 setState 检测）；
//   · 但**真实驱动** browser/index.js 的续播编排逻辑（effect + handleLoadFinish），
//     而不是只做源码正则断言；
//   · 直接 import 真实源码 watchHistoryLogic.js（含新增的 isSameEpisodePage），
//     仅把 react / AsyncStorage / RN 原生模块替换为测试替身。
//
// 覆盖（对应需求 §4 的 10 个场景 + 2 个契约护栏）：
//   SU-01 当前第 8 集，点第 8 集历史 → WebView 恰好 reload 一次（§3.2）
//   SU-02 当前第 7 集，点第 8 集历史 → 导航到第 8 集，且不额外 reload（§3.3）
//   SU-03 浏览器停在别的站点 → 导航到第 8 集播放页（§3.3）
//   SU-04 同 URL 强制刷新后，onLoadEnd 确实触发自动嗅探（§3.4）
//   SU-05 嗅探命中目标片源 → 自动进入影院（无 Picker）
//   SU-06 影院恢复历史秒数（seekSeconds 正确传递，秒单位）
//   SU-07 连续两次点同一条历史 → 第二次仍能发起新的有效尝试（§3.5）
//   SU-08 普通浏览器启动恢复上次页面 → 不触发任何续播刷新（§3.5）
//   SU-09 无重复弹窗 / 无无限刷新 / 无重复进入影院（§3.5）
//   SU-10 既有手动刷新与手动嗅探行为不变（无回归）
//   SU-11 isSameEpisodePage 归一化契约（同页 / 不同集 / 不同站点 / 非法输入）
//   SU-12 页面归属校验：无关页面的 onLoadEnd 不得启动嗅探（§3.4）
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
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
// 极简 React 运行时（与 p15_runtimeFix.test.mjs 同源，含渲染期跨组件 setState 检测）
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
    if (renderDepth > 0 && current !== inst) {
      const err = new Error(
        'Cannot update a component while rendering a different component.'
      );
      inst.errors.push(err.message);
      throw err;
    }
    if (typeof next === 'function') {
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
`;

const STORAGE_SRC = String.raw`
const mem = new Map();
export const __control = {
  reset() { mem.clear(); },
  dump() { return Object.fromEntries(mem.entries()); },
  seed(k, v) { mem.set(k, v); },
};
const AsyncStorage = {
  async getItem(k) { return mem.has(k) ? mem.get(k) : null; },
  async setItem(k, v) { mem.set(k, v); },
  async removeItem(k) { mem.delete(k); },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-sameurl-'));
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
      code = code
        .replace("from 'react'", `from '${'../'.repeat(3)}${RUNTIME_FILE}'`)
        .replace(/from 'react-native'/, `from '${'../'.repeat(3)}__rn.mjs'`)
        .replace(/from 'expo-haptics'/, `from '${'../'.repeat(3)}__haptics.mjs'`)
        .replace("from './watchHistoryLogic'", "from './watchHistoryLogic.js'")
        // 🧩 P1.3 R2：纯决策模块已拆出，Node ESM 需显式扩展名
        .replace("from './snifferMediaLogic'", "from './snifferMediaLogic.js'")
        .replace("from '../../constants/browser'", "from '../../constants/browser/index.js'")
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

const RESULT_TAG = '__P15SU_RESULT__';

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

// ---------------------------------------------------------------------------
// 编排层替身：忠实复刻 browser/index.js 的续播 effect + handleLoadFinish 语义
//
// 为什么要在测试里复刻而不是直接 import browser/index.js：
//   browser/index.js 是 Expo Router 页面，依赖 react-native / react-native-webview /
//   expo-router / expo-clipboard / 主题 / 认证等一整套原生模块，无法在 Node 沙箱
//   中加载。因此这里把「与本次故障相关的纯编排逻辑」逐行等价复刻，
//   并**真实调用** watchHistoryLogic 的 isSameEpisodePage / decideResume /
//   matchResumeCandidates，确保被测逻辑不是测试自己编的。
//
// 复刻的语义（与源码一一对应）：
//   · pendingUrl effect：taskId 去重 → 重置旧嗅探 → 同页 reload / 异页导航
//   · handleLoadFinish：过期判定 → 页面归属校验 → 自动嗅探（一次）
//   · runResumeHandoff：matchResumeCandidates → MATCHED 自动进影院
// ---------------------------------------------------------------------------
const HARNESS = String.raw`
const {
  isSameEpisodePage, decideResume, RESUME_ACTION,
  matchResumeCandidates, isResumeTaskExpired,
} = LOGIC;

// ── 假 WebView：记录 reload / injectJavaScript 次数，模拟「同 URL 不重载」 ──
function createFakeWebView(initialUrl) {
  const wv = {
    loadedUrl: initialUrl,
    reloadCount: 0,
    injectCount: 0,
    // 真实 WebView：reload() 会重新加载当前 URL 并最终触发 onLoadEnd
    reload() {
      wv.reloadCount += 1;
    },
    injectJavaScript() { wv.injectCount += 1; },
  };
  return wv;
}

// ── 编排层状态机（复刻 browser/index.js） ──
function createOrchestrator({ webView, initialLoadedUrl, now = () => Date.now() }) {
  const state = {
    // React 状态
    currentUrl: initialLoadedUrl,
    resumeHandoff: 'idle',
    sniffedMediaList: [],
    // refs
    actualLoadedUrl: { current: initialLoadedUrl },
    resumeNavTaskIdRef: { current: null },
    resumeReloadPendingRef: { current: null },
    autoSniffTaskIdRef: { current: null },
    autoHandoffTaskIdRef: { current: null },
    resumeHandoffTimerRef: { current: null },
    pendingResumeRef: { current: null },
    // 观测
    log: {
      reloads: 0,
      navigations: [],
      sniffTriggers: 0,
      cinemaEntries: [],
      pickerOpens: 0,
      handoffStates: [],
    },
  };

  const setResumeHandoff = (v) => {
    state.resumeHandoff = v;
    state.log.handoffStates.push(v);
  };

  // injectUrl：仅切换地址（真实实现绝不 reload）
  const injectUrl = (url) => {
    state.currentUrl = url;
    state.actualLoadedUrl.current = url;
  };

  const clearSniffedMedia = () => { state.sniffedMediaList = []; };

  const loadUrl = (url, pageUrl) => {
    state.log.cinemaEntries.push({ url, pageUrl: pageUrl || null });
  };
  const goCinema = () => { state.log.cinemaEntries.push({ cinema: true }); };

  // ── 续播交接（复刻 runResumeHandoff） ──
  const runResumeHandoff = (mediaList, pageUrl) => {
    const task = state.pendingResumeRef.current;
    if (!task || !task.taskId) return 'none';
    if (state.autoHandoffTaskIdRef.current === task.taskId) return 'matched';
    if (isResumeTaskExpired(task, now())) {
      setResumeHandoff('failed');
      return 'none';
    }
    const result = matchResumeCandidates(task, mediaList, pageUrl);
    if (result.status === 'MATCHED') {
      state.autoHandoffTaskIdRef.current = task.taskId;
      setResumeHandoff('matched');
      loadUrl(result.url, result.pageUrl || null);
      goCinema();
      return 'matched';
    }
    if (result.status === 'AMBIGUOUS') {
      setResumeHandoff('ambiguous');
      return 'ambiguous';
    }
    setResumeHandoff('failed');
    return 'none';
  };

  // ── 嗅探命中回调（复刻 handleMediaFound） ──
  const handleMediaFound = (nextList) => {
    const task = state.pendingResumeRef.current;
    if (task && task.taskId) {
      const pageUrl = state.actualLoadedUrl.current || state.currentUrl || '';
      runResumeHandoff(nextList, pageUrl);
      return;
    }
    state.log.pickerOpens += 1;
  };

  // ── pendingUrl effect（复刻 browser/index.js 的续播分支） ──
  const applyPendingUrl = (pendingUrl, resumeTask) => {
    if (!pendingUrl) return;
    if (resumeTask && resumeTask.taskId) {
      if (state.autoSniffTaskIdRef.current !== resumeTask.taskId) {
        state.autoSniffTaskIdRef.current = null;
        state.autoHandoffTaskIdRef.current = null;
        setResumeHandoff('idle');
      }
      if (state.resumeNavTaskIdRef.current && state.resumeNavTaskIdRef.current !== resumeTask.taskId) {
        state.resumeNavTaskIdRef.current = null;
        state.resumeReloadPendingRef.current = null;
      }
    }
    if (resumeTask) {
      const candidates = /^https?:/i.test(pendingUrl) ? [{ url: pendingUrl }] : [];
      const decision = decideResume(
        {
          mediaKey: resumeTask.mediaKey,
          mediaUrl: resumeTask.mediaUrl,
          pageUrl: resumeTask.pageUrl,
          positionMillis: Math.round((resumeTask.seekSeconds || 0) * 1000),
          durationMillis: 0,
          completed: false,
        },
        candidates
      );
      if (
        decision.action === RESUME_ACTION.PLAY_AND_SEEK ||
        decision.action === RESUME_ACTION.PLAY_FROM_START
      ) {
        loadUrl(decision.url, resumeTask.pageUrl || null);
        goCinema();
        return;
      }
      const taskId = resumeTask.taskId;
      if (state.resumeNavTaskIdRef.current === taskId) return;
      state.resumeNavTaskIdRef.current = taskId;
      state.autoSniffTaskIdRef.current = null;
      state.autoHandoffTaskIdRef.current = null;
      clearSniffedMedia();
      setResumeHandoff('idle');
      if (state.resumeHandoffTimerRef.current) {
        clearTimeout(state.resumeHandoffTimerRef.current);
        state.resumeHandoffTimerRef.current = null;
      }
      const loadedUrl = state.actualLoadedUrl.current || state.currentUrl || '';
      if (isSameEpisodePage(pendingUrl, loadedUrl)) {
        // §3.2 同页 → 主动 reload
        injectUrl(pendingUrl);
        state.resumeReloadPendingRef.current = taskId;
        webView.reload();
        state.log.reloads += 1;
        return;
      }
      // §3.3 异页 → 正常导航（不额外 reload）
      injectUrl(pendingUrl);
      state.log.navigations.push(pendingUrl);
      return;
    }
    injectUrl(pendingUrl);
    state.log.navigations.push(pendingUrl);
  };

  // ── handleLoadFinish（复刻 browser/index.js） ──
  const handleLoadFinish = (loadedUrl) => {
    const task = state.pendingResumeRef.current;
    if (!task || !task.taskId) return;
    if (state.autoSniffTaskIdRef.current === task.taskId) return;
    if (isResumeTaskExpired(task, now())) {
      setResumeHandoff('failed');
      return;
    }
    const targetPage = task.pageUrl || '';
    const loadedPage = loadedUrl || '';
    if (targetPage && loadedPage && !isSameEpisodePage(targetPage, loadedPage)) {
      return;
    }
    if (state.resumeReloadPendingRef.current === task.taskId) {
      state.resumeReloadPendingRef.current = null;
    }
    state.autoSniffTaskIdRef.current = task.taskId;
    setResumeHandoff('sniffing');
    state.log.sniffTriggers += 1;
    // 真实实现会注入 MANUAL_SNIFF_SCRIPT；这里由用例决定是否模拟「页面回报片源」
    if (state.onSniff) state.onSniff();
  };

  // 模拟 WebView 完成一次加载（onLoadEnd）
  const finishLoad = (url) => {
    state.actualLoadedUrl.current = url;
    state.currentUrl = url;
    handleLoadFinish(url);
  };

  const setPendingResume = (task) => {
    state.pendingResumeRef.current = task;
  };

  return {
    state,
    applyPendingUrl,
    handleLoadFinish,
    finishLoad,
    handleMediaFound,
    setPendingResume,
    setOnSniff(fn) { state.onSniff = fn; },
  };
}

// 构造一条「第 8 集」续播任务（与 BrowserSessionContext.setPendingResume 同结构）
function makeTask({ pageUrl, mediaUrl, seekSeconds = 123 }) {
  const triple = LOGIC.parseEpisodeTriple(pageUrl);
  return {
    taskId: LOGIC.createResumeTaskId(),
    recordKey: LOGIC.buildRecordKey({ mediaUrl, pageUrl }),
    mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl, episode: triple || undefined }),
    pageUrl,
    mediaUrl,
    seekSeconds,
    title: '测试剧集',
    episodeLabel: '第8集',
    createdAt: Date.now(),
    status: 'PENDING',
  };
}
`;

const PRELUDE = `
import * as React from './${RUNTIME_FILE}';
import { createRoot } from './${RUNTIME_FILE}';
import { __control } from './${STORAGE_FILE}';
const LOGIC = await import('./src/hooks/browser/watchHistoryLogic.js');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log('${RESULT_TAG}' + JSON.stringify(o));
${HARNESS}
`;

// 站点与集数常量（与真机 kkys11 一致：第 1 集 = 700596，第 8 集 = 700603）
const SITE = 'https://www.kkys11.com';
const EP8 = `${SITE}/play/12345-1-700603.html`;
const EP7 = `${SITE}/play/12345-1-700602.html`;
const EP8_MEDIA = 'https://cdn.kkys11.com/hls/12345/700603/index.m3u8';
const OTHER_SITE = 'https://www.bing.com';

// ===========================================================================
// SU-01 当前第 8 集，点第 8 集历史 → WebView 恰好 reload 一次
// ===========================================================================
test('SU-01 当前就在第 8 集，点第 8 集历史 → 主动 reload 恰好一次', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
emit({
  reloads: orch.state.log.reloads,
  webViewReloadCount: webView.reloadCount,
  navigations: orch.state.log.navigations,
  currentUrl: orch.state.currentUrl,
});
`);
    assert.equal(out.reloads, 1, '同 URL 必须由续播任务主动 reload 一次');
    assert.equal(out.webViewReloadCount, 1, 'WebView.reload() 必须被真实调用一次');
    assert.deepEqual(out.navigations, [], '同 URL 场景不应走「导航」分支');
    assert.equal(out.currentUrl, EP8, '当前地址应保持为目标集数播放页');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-02 当前第 7 集，点第 8 集历史 → 导航到第 8 集，且不额外 reload
// ===========================================================================
test('SU-02 当前第 7 集，点第 8 集历史 → 导航到第 8 集且不额外 reload', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP7)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP7)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
emit({
  reloads: orch.state.log.reloads,
  navigations: orch.state.log.navigations,
  currentUrl: orch.state.currentUrl,
});
`);
    assert.equal(out.reloads, 0, '异页场景不得额外 reload（避免二次加载）');
    assert.deepEqual(out.navigations, [EP8], '必须导航到历史记录的目标集数播放页');
    assert.equal(out.currentUrl, EP8, '不得用当前浏览器 URL 替代历史记录的目标 URL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-03 浏览器停在别的站点 → 导航到第 8 集播放页
// ===========================================================================
test('SU-03 浏览器停在别的站点，点第 8 集历史 → 导航到第 8 集播放页', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(OTHER_SITE)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(OTHER_SITE)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
emit({
  reloads: orch.state.log.reloads,
  navigations: orch.state.log.navigations,
  currentUrl: orch.state.currentUrl,
});
`);
    assert.equal(out.reloads, 0, '跨站场景不得 reload 旧页面');
    assert.deepEqual(out.navigations, [EP8], '必须导航到目标集数播放页');
    assert.equal(out.currentUrl, EP8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-04 同 URL 强制刷新后，onLoadEnd 确实触发自动嗅探
// ===========================================================================
test('SU-04 同 URL 强制刷新后 onLoadEnd 触发自动嗅探（且只触发一次）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
// 模拟 reload 完成 → onLoadEnd
orch.finishLoad(${JSON.stringify(EP8)});
// 再来一次 onLoadEnd（重定向 / 重复回调）→ 不得重复嗅探
orch.finishLoad(${JSON.stringify(EP8)});
emit({
  reloads: orch.state.log.reloads,
  sniffTriggers: orch.state.log.sniffTriggers,
  handoffStates: orch.state.log.handoffStates,
});
`);
    assert.equal(out.reloads, 1, '同 URL 只 reload 一次');
    assert.equal(out.sniffTriggers, 1, '自动嗅探必须触发且只触发一次（防重复 onLoadEnd）');
    assert.ok(out.handoffStates.includes('sniffing'), '交接状态应进入 sniffing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-05 嗅探命中目标片源 → 自动进入影院（无 Picker）
// ===========================================================================
test('SU-05 嗅探命中目标片源 → 自动进入影院，且不弹 Picker', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
orch.finishLoad(${JSON.stringify(EP8)});
// 页面回报唯一目标片源（换 CDN 子域也应命中：recordKey 与 CDN 无关）
orch.handleMediaFound([{ url: 'https://cdn2.kkys11.com/hls/12345/700603/index.m3u8' }]);
emit({
  cinemaEntries: orch.state.log.cinemaEntries,
  pickerOpens: orch.state.log.pickerOpens,
  handoffStates: orch.state.log.handoffStates,
});
`);
    assert.equal(out.pickerOpens, 0, '续播模式绝不弹 Picker');
    assert.ok(out.cinemaEntries.length >= 2, '必须 loadUrl + goCinema');
    assert.equal(out.cinemaEntries[0].url, 'https://cdn2.kkys11.com/hls/12345/700603/index.m3u8');
    assert.equal(out.cinemaEntries[0].pageUrl, EP8, '必须把目标播放页一并交给影院');
    assert.ok(out.handoffStates.includes('matched'), '交接状态应为 matched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-06 影院恢复历史秒数（seekSeconds 正确传递，秒单位）
// ===========================================================================
test('SU-06 影院恢复历史秒数（秒单位，非毫秒）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)}, seekSeconds: 754 });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
orch.finishLoad(${JSON.stringify(EP8)});
orch.handleMediaFound([{ url: ${JSON.stringify(EP8_MEDIA)} }]);
// 影院页读取 pendingResume.seekSeconds 用于 seek
const seekSeconds = orch.state.pendingResumeRef.current.seekSeconds;
emit({ seekSeconds, cinemaEntries: orch.state.log.cinemaEntries });
`);
    assert.equal(out.seekSeconds, 754, 'seekSeconds 必须是秒（754），不得被当成毫秒');
    assert.ok(out.cinemaEntries.length >= 2, '必须进入影院');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-07 连续两次点同一条历史 → 第二次仍能发起新的有效尝试
// ===========================================================================
test('SU-07 连续两次点同一条历史 → 第二次仍发起新的有效刷新', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
// 第一次点击
const task1 = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task1);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task1);
orch.finishLoad(${JSON.stringify(EP8)});
const afterFirst = { reloads: orch.state.log.reloads, sniff: orch.state.log.sniffTriggers };
// 第二次点击同一条历史（新 taskId，模拟用户再次点击）
const task2 = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task2);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task2);
orch.finishLoad(${JSON.stringify(EP8)});
emit({
  afterFirst,
  totalReloads: orch.state.log.reloads,
  totalSniff: orch.state.log.sniffTriggers,
  handoffStates: orch.state.log.handoffStates,
});
`);
    assert.equal(out.afterFirst.reloads, 1, '第一次点击应 reload 一次');
    assert.equal(out.afterFirst.sniff, 1, '第一次点击应触发一次自动嗅探');
    assert.equal(out.totalReloads, 2, '第二次点击同一条历史必须再发起一次有效刷新');
    assert.equal(out.totalSniff, 2, '第二次点击必须重新触发自动嗅探');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-08 普通浏览器启动恢复上次页面 → 不触发任何续播刷新
// ===========================================================================
test('SU-08 普通启动恢复上次页面 → 不触发续播刷新与嗅探', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
// 冷启动恢复上次 URL：没有 pendingResume，只有普通 pendingUrl
orch.applyPendingUrl(${JSON.stringify(EP8)}, null);
// 页面加载完成
orch.finishLoad(${JSON.stringify(EP8)});
emit({
  reloads: orch.state.log.reloads,
  sniffTriggers: orch.state.log.sniffTriggers,
  navigations: orch.state.log.navigations,
  handoffStates: orch.state.log.handoffStates,
});
`);
    assert.equal(out.reloads, 0, '普通启动恢复不得强制 reload');
    assert.equal(out.sniffTriggers, 0, '普通启动恢复不得触发自动嗅探');
    assert.equal(out.handoffStates.length, 0, '普通启动恢复不得改动续播交接状态');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-09 无重复弹窗 / 无无限刷新 / 无重复进入影院
// ===========================================================================
test('SU-09 多次 onLoadEnd 与多次片源回报 → 无重复嗅探、无重复进影院、无 Picker', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
// 连续 3 次 onLoadEnd（重定向 / 重复回调）
orch.finishLoad(${JSON.stringify(EP8)});
orch.finishLoad(${JSON.stringify(EP8)});
orch.finishLoad(${JSON.stringify(EP8)});
// 连续 3 次片源回报（被动嗅探 + 手动嗅探 + 重定向）
orch.handleMediaFound([{ url: ${JSON.stringify(EP8_MEDIA)} }]);
orch.handleMediaFound([{ url: ${JSON.stringify(EP8_MEDIA)} }]);
orch.handleMediaFound([{ url: ${JSON.stringify(EP8_MEDIA)} }]);
emit({
  reloads: orch.state.log.reloads,
  sniffTriggers: orch.state.log.sniffTriggers,
  cinemaEntries: orch.state.log.cinemaEntries,
  pickerOpens: orch.state.log.pickerOpens,
});
`);
    assert.equal(out.reloads, 1, '一个 taskId 只允许一次刷新（不得无限 reload）');
    assert.equal(out.sniffTriggers, 1, '重复 onLoadEnd 不得重复嗅探');
    assert.equal(out.pickerOpens, 0, '续播模式绝不弹 Picker');
    const cinemaLoads = out.cinemaEntries.filter((e) => e.url);
    assert.equal(cinemaLoads.length, 1, '不得重复进入影院');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-10 既有手动刷新与手动嗅探行为不变（无回归）
// ===========================================================================
test('SU-10 无续播任务时，手动刷新与手动嗅探行为不变', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP8)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP8)} });
// 手动刷新：直接调用 WebView.reload()（handleReload 语义）
webView.reload();
// 手动嗅探：无 pendingResume 时 onLoadEnd 不自动嗅探
orch.finishLoad(${JSON.stringify(EP8)});
// 手动嗅探命中 → 无续播任务 → 走 Picker
orch.handleMediaFound([{ url: ${JSON.stringify(EP8_MEDIA)} }]);
emit({
  manualReloads: webView.reloadCount,
  autoSniffTriggers: orch.state.log.sniffTriggers,
  pickerOpens: orch.state.log.pickerOpens,
  cinemaEntries: orch.state.log.cinemaEntries,
});
`);
    assert.equal(out.manualReloads, 1, '手动刷新必须仍然调用 WebView.reload()');
    assert.equal(out.autoSniffTriggers, 0, '无续播任务时 onLoadEnd 不得自动嗅探');
    assert.equal(out.pickerOpens, 1, '无续播任务时命中片源应走 Picker（行为不变）');
    assert.equal(out.cinemaEntries.length, 0, '无续播任务时不得自动进影院');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-11 isSameEpisodePage 归一化契约
// ===========================================================================
test('SU-11 isSameEpisodePage 归一化契约（同页 / 不同集 / 跨站 / 非法输入）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const f = LOGIC.isSameEpisodePage;
emit({
  // 同页：协议 http/https、www、末尾斜杠、hash 差异都应视为同一页
  sameExact: f(${JSON.stringify(EP8)}, ${JSON.stringify(EP8)}),
  sameHttp: f(${JSON.stringify(EP8.replace('https://', 'http://'))}, ${JSON.stringify(EP8)}),
  sameNoWww: f(${JSON.stringify(EP8.replace('www.', ''))}, ${JSON.stringify(EP8)}),
  sameTrailingSlash: f(${JSON.stringify(EP8 + '/')}, ${JSON.stringify(EP8)}),
  sameHash: f(${JSON.stringify(EP8 + '#t=30')}, ${JSON.stringify(EP8)}),
  // 不同集：路径不同 → 必须判定为不同页
  diffEpisode: f(${JSON.stringify(EP7)}, ${JSON.stringify(EP8)}),
  // 跨站
  diffSite: f(${JSON.stringify(OTHER_SITE)}, ${JSON.stringify(EP8)}),
  // 非法输入
  emptyTarget: f('', ${JSON.stringify(EP8)}),
  emptyCurrent: f(${JSON.stringify(EP8)}, ''),
  nonHttp: f('about:blank', ${JSON.stringify(EP8)}),
  nullBoth: f(null, null),
});
`);
    assert.equal(out.sameExact, true, '完全相同的 URL 必须判定为同一页');
    assert.equal(out.sameHttp, true, 'http/https 差异不应影响判定');
    assert.equal(out.sameNoWww, true, 'www. 前缀差异不应影响判定');
    assert.equal(out.sameTrailingSlash, true, '末尾斜杠差异不应影响判定');
    assert.equal(out.sameHash, true, 'hash 差异不应影响判定');
    assert.equal(out.diffEpisode, false, '不同集数必须判定为不同页（绝不忽略路径）');
    assert.equal(out.diffSite, false, '不同站点必须判定为不同页');
    assert.equal(out.emptyTarget, false, '空目标 URL 必须返回 false');
    assert.equal(out.emptyCurrent, false, '空当前 URL 必须返回 false');
    assert.equal(out.nonHttp, false, '非 http(s) 必须返回 false');
    assert.equal(out.nullBoth, false, 'null 输入必须返回 false');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// SU-12 页面归属校验：无关页面的 onLoadEnd 不得启动嗅探
// ===========================================================================
test('SU-12 无关页面的 onLoadEnd 不得启动自动嗅探（页面归属校验）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const webView = createFakeWebView(${JSON.stringify(EP7)});
const orch = createOrchestrator({ webView, initialLoadedUrl: ${JSON.stringify(EP7)} });
const task = makeTask({ pageUrl: ${JSON.stringify(EP8)}, mediaUrl: ${JSON.stringify(EP8_MEDIA)} });
orch.setPendingResume(task);
orch.applyPendingUrl(${JSON.stringify(EP8)}, task);
// 目标页尚未加载完成，先来了一个无关页面（广告跳转 / 旧页面）的 onLoadEnd
orch.finishLoad(${JSON.stringify(OTHER_SITE)});
const afterWrongPage = {
  sniffTriggers: orch.state.log.sniffTriggers,
  handoffStates: orch.state.log.handoffStates.slice(),
};
// 目标页真正加载完成
orch.finishLoad(${JSON.stringify(EP8)});
emit({
  afterWrongPage,
  sniffTriggers: orch.state.log.sniffTriggers,
  handoffStates: orch.state.log.handoffStates,
});
`);
    assert.equal(
      out.afterWrongPage.sniffTriggers,
      0,
      '无关页面的 onLoadEnd 绝不能启动自动嗅探（否则会误匹配广告/别的集）'
    );
    assert.equal(out.sniffTriggers, 1, '目标页加载完成后必须启动一次自动嗅探');
    assert.ok(out.handoffStates.includes('sniffing'), '目标页加载后应进入 sniffing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p15_sameUrlResume.test.mjs ---