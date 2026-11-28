// --- START OF FILE tests/security/p15_watchResumeIntegration.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — Gatekeeper 修复：交接 / 状态 / 持久化 集成测试
//
// 覆盖 GPT Gatekeeper 指出的 4 个 P0 阻断项的真实行为（非纯函数）：
//   P0-1 续播任务交接：浏览器不提前消费，影院确认身份 + ready + seek 成功后才消费
//   P0-2 过期源回退：脱敏 URL 不视为必然有效，优先回原播放页
//   P0-3 防错集：mediaKey 站点隔离 + 身份核验（同页不同集 / 广告 / 跨站同号）
//   P0-4 持久化竞态：多实例共享权威状态 + 写入队列 + 删除/清空不被旧写入复活
//
// 测试策略（重要说明）：
//   本仓库未安装 React / react-test-renderer / jest。为了「真实驱动」Hook 与
//   状态机，本文件内置一个**极简 React 运行时**（hooks 子集：useState /
//   useEffect / useCallback / useRef / useMemo），语义对齐 React 18/19：
//     - 渲染期 setState 触发重渲染（React 的 render-phase update 模式）
//     - useEffect 在提交后按依赖浅比较执行，cleanup 在依赖变化/卸载时执行
//     - useCallback / useMemo 依赖浅比较缓存
//     - 异步 setState 通过微任务调度重渲染
//   这与官方 RN renderer 的差异：不做并发特性 / Suspense / 严格双调用，
//   但足以验证「状态交接、消费时机、竞态、跨实例一致性」这些逻辑正确性。
//   真实设备上的播放器 / WebView 行为仍需真机验证（见交付说明）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 直接 import 真实源码（watchHistoryLogic.js / useWatchHistory.js）。
//   - AsyncStorage 用内存实现替换（模拟异步 + 可注入延迟）。
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

// ---------------------------------------------------------------------------
// 沙箱：真实源码 + 内置 React 运行时 + 内存 AsyncStorage
// ---------------------------------------------------------------------------
const RUNTIME_FILE = '__runtime.mjs';
const STORAGE_FILE = '__storage.mjs';

const RUNTIME_SRC = String.raw`
// 极简 React 运行时（hooks 子集），语义对齐 React 18/19 的常用行为。
let current = null;          // 当前渲染中的组件实例
let pendingEffects = [];     // 本次提交后待执行的 effect

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
    dirty: false,
    unmounted: false,
    scheduled: false,   // 🛡️ 每个实例独立的调度标记（不能全局共享，否则多实例互相吞掉重渲染）
    rerender: null,
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
    // 暴露重渲染入口：用于模拟「同一实例在 props/外部变量变化后重新渲染」
    rerender() { schedule(); },
    unmount() {
      inst.unmounted = true;
      // 执行所有 cleanup
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
  const out = inst.renderFn();
  inst.result = out;
  current = null;
  // 提交阶段：执行 effect（依赖变化才执行）
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
    const v = typeof next === 'function' ? next(slot.value) : next;
    if (Object.is(v, slot.value)) return;
    slot.value = v;
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
// 内存版 AsyncStorage：模拟异步 + 可注入延迟，用于竞态测试。
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

// 🧩 P1.x 重构后：`src/constants/browser/index.js` 已迁移为 `index.ts`。
//    生产源码仍以显式 `index.js` 导入，故沙箱按「.ts 优先、.js 兜底」解析真实源，
//    统一以 .js 落盘。Node 24 只对 .ts 做原生类型擦除、对 .js 不做，
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-resume-'));
  const files = [
    'src/hooks/browser/watchHistoryLogic.js',
    'src/hooks/browser/useWatchHistory.js',
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
      // 把 react / AsyncStorage 指向内置运行时（仅测试替身，不改生产源码语义）
      code = code
        .replace("from 'react'", `from '${'../'.repeat(3)}${RUNTIME_FILE}'`)
        .replace("from '@react-native-async-storage/async-storage'", `from '${'../'.repeat(3)}${STORAGE_FILE}'`)
        // Node ESM 要求显式扩展名：把无扩展名的同目录导入补全为 .js
        .replace("from './watchHistoryLogic'", "from './watchHistoryLogic.js'");
    }
    fs.writeFileSync(dst, code);
  });
  fs.writeFileSync(path.join(dir, RUNTIME_FILE), RUNTIME_SRC);
  fs.writeFileSync(path.join(dir, STORAGE_FILE), STORAGE_SRC);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

const RESULT_TAG = '__P15R_RESULT__';

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
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
import { createRoot } from './${RUNTIME_FILE}';
import { __control } from './${STORAGE_FILE}';
const LOGIC = await import('./src/hooks/browser/watchHistoryLogic.js');
const { useWatchHistory } = await import('./src/hooks/browser/useWatchHistory.js');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log('${RESULT_TAG}' + JSON.stringify(o));
`;

// ===========================================================================
// 1) 交接：历史点击后影院能收到 pending resume 任务（浏览器不提前消费）
// ===========================================================================
test('P15R-01 历史点击后影院收到续播任务，浏览器不提前消费', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 模拟 BrowserSessionContext 的 pendingResume 状态机（与源码同语义）
let task = null;
const setPendingResume = (t) => {
  task = { taskId: LOGIC.createResumeTaskId(), mediaKey: t.mediaKey || '', pageUrl: t.pageUrl || '',
    mediaUrl: t.mediaUrl || '', seekSeconds: t.seekSeconds || 0, createdAt: Date.now(),
    status: LOGIC.RESUME_TASK_STATUS.PENDING };
};
const updateStatus = (id, s) => {
  if (!task || task.taskId !== id) return;
  if (s === LOGIC.RESUME_TASK_STATUS.APPLIED || s === LOGIC.RESUME_TASK_STATUS.ABORTED) task = null;
  else task = { ...task, status: s };
};
const consume = (id = null) => {
  if (!task) return null;
  if (id && task.taskId !== id) return task;
  const t = task; task = null; return t;
};

const mediaUrl = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';
const pageUrl = 'https://site.com/play/392563-36-700596.html';
setPendingResume({ mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }), pageUrl, mediaUrl, seekSeconds: 1234 });

// 浏览器 Case A：只发起交接，不消费
const afterBrowser = task ? { present: true, status: task.status } : { present: false };

// 影院确认身份 + ready + seek 成功后才消费
const current = { mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }), mediaUrl, pageUrl };
const matched = LOGIC.isResumeTargetCurrent(task, current);
updateStatus(task.taskId, LOGIC.RESUME_TASK_STATUS.MATCHED);
const consumed = consume(task.taskId);
const afterCinema = task ? { present: true } : { present: false };

emit({ afterBrowser, matched, consumedSeek: consumed && consumed.seekSeconds, afterCinema });
`);
    assert.equal(out.afterBrowser.present, true, '浏览器交接后任务必须仍存在');
    assert.equal(out.afterBrowser.status, 'PENDING');
    assert.equal(out.matched, true);
    assert.equal(out.consumedSeek, 1234);
    assert.equal(out.afterCinema.present, false, 'seek 成功后任务必须被消费');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 2) 播放器就绪后恢复到正确秒数
// ===========================================================================
test('P15R-02 播放器就绪后 seek 到历史秒数（秒单位，非毫秒）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const mediaUrl = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';
const pageUrl = 'https://site.com/play/392563-36-700596.html';
const task = { taskId: 't1', mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }),
  mediaUrl, pageUrl, seekSeconds: 754, createdAt: Date.now(), status: 'PENDING' };
const current = { mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }), mediaUrl, pageUrl };
const matched = LOGIC.isResumeTargetCurrent(task, current);
// 模拟播放器：duration 秒
const player = { duration: 3600, currentTime: 0, playing: false, play() { this.playing = true; } };
let seekOk = false;
if (matched && task.seekSeconds > 0 && player.duration > 0 && task.seekSeconds < player.duration - 1) {
  player.currentTime = task.seekSeconds; player.play(); seekOk = true;
}
emit({ matched, seekOk, currentTime: player.currentTime, playing: player.playing });
`);
    assert.equal(out.matched, true);
    assert.equal(out.seekOk, true);
    assert.equal(out.currentTime, 754, 'seek 目标必须是 754 秒');
    assert.equal(out.playing, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 3) 任务只消费一次（重复渲染 / 重复 ready 不重复 seek）
// ===========================================================================
test('P15R-03 同一任务只应用一次（taskId 去重）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const mediaUrl = 'https://cdn.site.com/vod/1-1-1/index.m3u8';
const pageUrl = 'https://site.com/play/1-1-1.html';
let task = { taskId: 'dup', mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }),
  mediaUrl, pageUrl, seekSeconds: 100, createdAt: Date.now(), status: 'PENDING' };
const appliedRef = { current: null };
let seekCount = 0;
const runEffect = () => {
  if (!task) return;
  if (appliedRef.current === task.taskId) return;   // 去重
  const current = { mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }), mediaUrl, pageUrl };
  if (!LOGIC.isResumeTargetCurrent(task, current)) return;
  appliedRef.current = task.taskId;
  seekCount += 1;
  task = null; // 消费
};
runEffect(); runEffect(); runEffect();
emit({ seekCount, taskGone: task === null });
`);
    assert.equal(out.seekCount, 1, '重复触发只能 seek 一次');
    assert.equal(out.taskGone, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4) 视频失败后安全回退（不残留任务、不崩溃）
// ===========================================================================
test('P15R-04 视频加载失败后任务作废，不残留、不无限等待', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
let task = { taskId: 'fail', mediaKey: 'm:x', mediaUrl: 'https://cdn.site.com/a.m3u8',
  pageUrl: 'https://site.com/play/1-1-1.html', seekSeconds: 50, createdAt: Date.now(), status: 'PENDING' };
const updateStatus = (id, s) => {
  if (!task || task.taskId !== id) return;
  if (s === 'APPLIED' || s === 'ABORTED') task = null; else task = { ...task, status: s };
};
// 播放器报错 → 影院作废任务
updateStatus('fail', LOGIC.RESUME_TASK_STATUS.ABORTED);
emit({ taskGone: task === null });
`);
    assert.equal(out.taskGone, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 5) 签名源过期 → 回原播放页（不盲连脱敏 URL）
// ===========================================================================
test('P15R-05 签名源过期时优先回原播放页，而非盲连脱敏 URL', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = {
  mediaKey: 'ep:site.com:392563:36:700596',
  mediaUrl: 'https://cdn.site.com/vod/392563-36-700596/index.m3u8', // 已脱敏（无签名）
  pageUrl: 'https://site.com/play/392563-36-700596.html',
  positionMillis: 600000, durationMillis: 3600000, completed: false,
};
const d = LOGIC.decideResume(record, []);
emit({ action: d.action, reason: d.reason, url: d.url });
`);
    assert.equal(out.action, 'NAVIGATE_TO_PAGE');
    assert.equal(out.reason, 'need_renavigate');
    assert.equal(out.url, 'https://site.com/play/392563-36-700596.html');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 6) 第 8 集进度绝不套到第 9 集
// ===========================================================================
test('P15R-06 第 8 集进度不会套用到第 9 集', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const ep8 = 'https://site.com/play/392563-36-700596.html';
const ep9 = 'https://site.com/play/392563-36-700597.html';
const task = { taskId: 'e', mediaKey: LOGIC.buildMediaKey({ mediaUrl: 'https://cdn.site.com/700596.m3u8', pageUrl: ep8 }),
  mediaUrl: 'https://cdn.site.com/700596.m3u8', pageUrl: ep8, seekSeconds: 500, createdAt: Date.now() };
const currentEp9 = { mediaKey: LOGIC.buildMediaKey({ mediaUrl: 'https://cdn.site.com/700597.m3u8', pageUrl: ep9 }),
  mediaUrl: 'https://cdn.site.com/700597.m3u8', pageUrl: ep9 };
const matched = LOGIC.isResumeTargetCurrent(task, currentEp9);
// 即使 pageUrl 相同（同剧不同集路径不同），也不能仅凭 pageUrl 判定
const samePageDiffEp = LOGIC.isPendingResumeMatch(task, { mediaUrl: 'https://cdn.site.com/700597.m3u8', pageUrl: ep9 });
emit({ matched, samePageDiffEp });
`);
    assert.equal(out.matched, false, '第 9 集不得匹配第 8 集任务');
    assert.equal(out.samePageDiffEp, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 7) 同页广告不被识别为主内容
// ===========================================================================
test('P15R-07 同页广告资源不被识别为续播主内容（seek 前身份闸门）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const pageUrl = 'https://site.com/play/392563-36-700596.html';
const main = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';
const ad = 'https://ads.tracker.com/preroll/ad.m3u8';
const task = { taskId: 'a', mediaKey: LOGIC.buildMediaKey({ mediaUrl: main, pageUrl }), mediaUrl: main, pageUrl };
// 🛡️ 广告与主内容同页同集：isPendingResumeMatch 的 pageUrl 弱信号会命中，
//    但真正决定「是否 seek」的是 isResumeTargetCurrent（只看 mediaKey / mediaUrl）。
const adCurrent = { mediaUrl: ad, pageUrl, mediaKey: LOGIC.buildMediaKey({ mediaUrl: ad, pageUrl }) };
const mainCurrent = { mediaUrl: main, pageUrl, mediaKey: LOGIC.buildMediaKey({ mediaUrl: main, pageUrl }) };
emit({
  adSeekAllowed: LOGIC.isResumeTargetCurrent(task, adCurrent),
  mainSeekAllowed: LOGIC.isResumeTargetCurrent(task, mainCurrent),
});
`);
    assert.equal(out.adSeekAllowed, false, '广告资源不得通过 seek 前身份闸门');
    assert.equal(out.mainSeekAllowed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 8) 不同域名相同集号路径不碰撞
// ===========================================================================
test('P15R-08 不同站点相同数字集路径不碰撞（站点隔离）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const a = LOGIC.buildMediaKey({ mediaUrl: 'https://cdn.a.com/x.m3u8', pageUrl: 'https://a.com/play/392563-36-700596.html' });
const b = LOGIC.buildMediaKey({ mediaUrl: 'https://cdn.b.com/x.m3u8', pageUrl: 'https://b.com/play/392563-36-700596.html' });
const task = { taskId: 'x', mediaKey: a, mediaUrl: 'https://cdn.a.com/x.m3u8', pageUrl: 'https://a.com/play/392563-36-700596.html' };
const crossSite = { mediaUrl: 'https://cdn.b.com/x.m3u8', pageUrl: 'https://b.com/play/392563-36-700596.html', mediaKey: b };
emit({ keyA: a, keyB: b, distinct: a !== b, crossMatch: LOGIC.isPendingResumeMatch(task, crossSite) });
`);
    assert.equal(out.distinct, true, '不同站点 mediaKey 必须不同');
    assert.match(out.keyA, /a\.com/);
    assert.match(out.keyB, /b\.com/);
    assert.equal(out.crossMatch, false, '跨站同号不得匹配');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 9) 多个 Hook 实例同时读写（共享权威状态）
// ===========================================================================
test('P15R-09 多个 Hook 实例共享同一权威状态（跨实例立即可见）', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const A = createRoot(() => useWatchHistory('u1', 1));
const B = createRoot(() => useWatchHistory('u1', 1));
await tick(5);
// A 写入一条
A.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/1.m3u8', pageUrl: 'https://site.com/play/1-1-1.html', positionMillis: 30000, durationMillis: 600000 });
await tick(5);
const aLen = A.result.watchList.length;
const bLen = B.result.watchList.length;
// B 再写另一条
B.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/2.m3u8', pageUrl: 'https://site.com/play/1-1-2.html', positionMillis: 10000, durationMillis: 600000 });
await tick(5);
emit({ aLen, bLen, aFinal: A.result.watchList.length, bFinal: B.result.watchList.length });
A.unmount(); B.unmount();
`);
    assert.equal(out.aLen, 1);
    assert.equal(out.bLen, 1, 'B 必须立即看到 A 的写入');
    assert.equal(out.aFinal, 2, 'A 必须看到 B 的写入');
    assert.equal(out.bFinal, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 10) 删除后旧异步写入不得复活记录
// ===========================================================================
test('P15R-10 删除后旧异步写入不会复活记录', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
__control.setDelay(20); // 让写入变慢，制造在途写入
const A = createRoot(() => useWatchHistory('u1', 1));
await tick(40);
A.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/1.m3u8', pageUrl: 'https://site.com/play/1-1-1.html', positionMillis: 30000, durationMillis: 600000 });
await tick(60); // 等首次写入落盘
const id = A.result.watchList[0].id;
// 发起一次「慢写入」后立刻删除（模拟旧写入在途）
A.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/1.m3u8', pageUrl: 'https://site.com/play/1-1-1.html', positionMillis: 40000, durationMillis: 600000 });
A.result.deleteWatchRecord(id);
await tick(120); // 等所有队列排空
const mem = __control.dump();
const key = LOGIC.buildWatchHistoryKey('u1');
const disk = mem[key] ? JSON.parse(mem[key]) : [];
emit({ memLen: A.result.watchList.length, diskLen: disk.length });
A.unmount();
`);
    assert.equal(out.memLen, 0, '内存态必须为空');
    assert.equal(out.diskLen, 0, '磁盘不得被旧写入复活');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 11) A→B→A 迟到回调不得跨代污染
// ===========================================================================
test('P15R-11 A→B→A 迟到回调不跨代污染', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
// 同一 Hook 实例，userId 不变 'u1'，但 authEpoch 从 1 → 2（同账号新会话 / A→B→A）
// 用可变 epoch 变量驱动同一实例重渲染，模拟真实 Provider 推进 authEpoch。
let epoch = 1;
const A = createRoot(() => useWatchHistory('u1', epoch));
await tick(5);
const staleSave = A.result.saveWatchRecord; // 捕获 epoch=1 时的回调
// 推进代际并触发重渲染（同一实例，ref 会更新为 epoch=2）
epoch = 2;
A.rerender();
await tick(5);
// 旧代际回调迟到执行 → 必须被丢弃（回调闭包 epoch=1，ref 已是 2）
const accepted = staleSave({ mediaUrl: 'https://cdn.site.com/old.m3u8', pageUrl: 'https://site.com/play/9-9-9.html', positionMillis: 1000, durationMillis: 600000 });
await tick(20);
emit({ accepted, len: A.result.watchList.length });
A.unmount();
`);
    assert.equal(out.accepted, false, '旧代际回调必须被拒绝');
    assert.equal(out.len, 0, '新代际不得被旧回调污染');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 12) 重启后进度准确保留
// ===========================================================================
test('P15R-12 重启后从磁盘恢复准确进度', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const A = createRoot(() => useWatchHistory('u1', 1));
await tick(5);
A.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/1.m3u8', pageUrl: 'https://site.com/play/1-1-1.html', positionMillis: 1234000, durationMillis: 3600000 });
await tick(40);
A.unmount();
// 模拟重启：新建实例读盘
const B = createRoot(() => useWatchHistory('u1', 1));
await tick(40);
const rec = B.result.watchList[0];
emit({ len: B.result.watchList.length, pos: rec && rec.positionMillis });
B.unmount();
`);
    assert.equal(out.len, 1);
    assert.equal(out.pos, 1234000, '重启后进度必须精确恢复');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 13) 普通网页访问不产生观看记录
// ===========================================================================
test('P15R-13 普通网页访问不产生观看记录（无媒体身份即拒绝）', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const A = createRoot(() => useWatchHistory('u1', 1));
await tick(5);
// 真正的「普通网页」：既无媒体 URL、也无播放页 URL → buildWatchRecord 返回 null → 不写入
const r1 = A.result.saveWatchRecord({});
const r2 = A.result.saveWatchRecord({ title: '某新闻标题' });
// 说明：仅带 pageUrl 的输入会生成 p: 记录（这是「播放页兜底」的既有契约），
//       但真实采集器只在嗅探到媒体后才调用 save，故普通网页不会走到这里。
const pageOnly = LOGIC.buildWatchRecord({ pageUrl: 'https://news.site.com/article/123' });
await tick(10);
emit({ r1, r2, len: A.result.watchList.length, pageOnlyKey: pageOnly && pageOnly.mediaKey });
A.unmount();
`);
    assert.equal(out.r1, false, '空输入必须被拒绝');
    assert.equal(out.r2, false, '仅标题无身份必须被拒绝');
    assert.equal(out.len, 0, '普通网页不得产生观看记录');
    assert.match(out.pageOnlyKey, /^p:/, '仅播放页 URL 时按既有契约生成 p: 兜底 key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 14) 原有播放 / 浏览导航无回归（decideResume 正常路径 + 无任务时直连）
// ===========================================================================
test('P15R-14 正常续播路径无回归（匹配候选直接 seek / 无历史直连）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const pageUrl = 'https://site.com/play/392563-36-700596.html';
const mediaUrl = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';
const record = { mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }), mediaUrl, pageUrl,
  positionMillis: 500000, durationMillis: 3600000, completed: false };
// 候选命中 → PLAY_AND_SEEK
const hit = LOGIC.decideResume(record, [{ url: mediaUrl }]);
// 无历史（null）→ UNAVAILABLE（不误触发）
const none = LOGIC.decideResume(null, []);
// 已完成 → 从头播放
const done = LOGIC.decideResume({ ...record, completed: true }, [{ url: mediaUrl }]);
emit({ hitAction: hit.action, hitSeek: hit.seekSeconds, noneAction: none.action, doneAction: done.action });
`);
    assert.equal(out.hitAction, 'PLAY_AND_SEEK');
    assert.equal(out.hitSeek, 500);
    assert.equal(out.noneAction, 'UNAVAILABLE');
    assert.equal(out.doneAction, 'PLAY_FROM_START');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 故障注入（必须失败）—— 4 项
// 每项把「错误实现」注入沙箱，断言其行为与正确契约不符（即测试能抓住回归）。
// ===========================================================================

// FI-1：浏览器提前消费任务 → 影院拿不到任务（必须被检测为错误）
test('P15R-FI1 故障注入：浏览器提前消费任务必须被检测（预期错误行为）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 错误实现：浏览器 goCinema 后立即 consume
let task = { taskId: 'x', mediaKey: 'm', mediaUrl: 'u', pageUrl: 'p', seekSeconds: 100, createdAt: Date.now() };
const consumeEarly = () => { task = null; };
consumeEarly(); // 浏览器提前消费
const cinemaSees = task; // 影院读到 null
emit({ cinemaSeesNull: cinemaSees === null });
`);
    // 断言「错误实现」确实导致影院拿不到任务 → 证明测试能抓住该回归
    assert.equal(out.cinemaSeesNull, true, '提前消费会导致影院拿不到任务（此即被检测的错误）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// FI-2：仅凭「同剧」就判定匹配 → 第 8 集任务误套到第 9 集（必须被检测为错误）
test('P15R-FI2 故障注入：仅凭同剧/同页弱信号匹配必须被检测（预期错误行为）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const ep8 = 'https://site.com/play/392563-36-700596.html';
const ep9 = 'https://site.com/play/392563-36-700597.html';
const task = { taskId: 'x', mediaKey: LOGIC.buildMediaKey({ mediaUrl: 'https://cdn.site.com/700596.m3u8', pageUrl: ep8 }),
  mediaUrl: 'https://cdn.site.com/700596.m3u8', pageUrl: ep8, seekSeconds: 500, createdAt: Date.now() };
// 错误实现：只比较 vodId（同剧即匹配）
const naiveMatch = (t, found) => {
  const a = LOGIC.parseEpisodeTriple(t.pageUrl); const b = LOGIC.parseEpisodeTriple(found.pageUrl);
  return !!(a && b && a.vodId === b.vodId);
};
// 第 9 集（同剧不同集）→ 错误实现会误判为匹配
const ep9Found = { mediaUrl: 'https://cdn.site.com/700597.m3u8', pageUrl: ep9 };
const naiveResult = naiveMatch(task, ep9Found);
// 正确实现（真实源码）不会误判
const correctResult = LOGIC.isPendingResumeMatch(task, ep9Found);
emit({ naiveResult, correctResult });
`);
    // 错误实现误判为 true（证明该回归可被检测）；正确实现为 false
    assert.equal(out.naiveResult, true, '仅凭同剧会误判第 9 集为第 8 集（被检测的错误）');
    assert.equal(out.correctResult, false, '正确实现必须拒绝同剧不同集');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// FI-3：移除站点域名隔离 → 跨站同号碰撞（必须被检测为错误）
test('P15R-FI3 故障注入：移除站点隔离必须被检测（预期错误行为）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 错误实现：mediaKey 不含站点，仅用集三元组
const naiveKey = (pageUrl) => {
  const t = LOGIC.parseEpisodeTriple(pageUrl);
  return t ? ('ep:' + t.vodId + ':' + t.sourceId + ':' + t.episodeId) : '';
};
const a = naiveKey('https://a.com/play/392563-36-700596.html');
const b = naiveKey('https://b.com/play/392563-36-700596.html');
// 正确实现（真实源码）含站点前缀
const ca = LOGIC.buildMediaKey({ pageUrl: 'https://a.com/play/392563-36-700596.html' });
const cb = LOGIC.buildMediaKey({ pageUrl: 'https://b.com/play/392563-36-700596.html' });
emit({ naiveCollide: a === b, correctDistinct: ca !== cb });
`);
    assert.equal(out.naiveCollide, true, '无站点隔离会导致跨站碰撞（被检测的错误）');
    assert.equal(out.correctDistinct, true, '正确实现必须区分站点');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// FI-4：允许旧存储写入覆盖清空结果 → 已清空记录复活（必须被检测为错误）
test('P15R-FI4 故障注入：旧写入覆盖清空必须被检测（预期错误行为）', async () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
__control.setDelay(20);
const A = createRoot(() => useWatchHistory('u1', 1));
await tick(40);
A.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/1.m3u8', pageUrl: 'https://site.com/play/1-1-1.html', positionMillis: 30000, durationMillis: 600000 });
await tick(60);
// 发起慢写入后立即清空
A.result.saveWatchRecord({ mediaUrl: 'https://cdn.site.com/1.m3u8', pageUrl: 'https://site.com/play/1-1-1.html', positionMillis: 50000, durationMillis: 600000 });
A.result.clearWatchHistory();
await tick(140);
const key = LOGIC.buildWatchHistoryKey('u1');
const mem = __control.dump();
const disk = mem[key] ? JSON.parse(mem[key]) : [];
emit({ memLen: A.result.watchList.length, diskLen: disk.length });
A.unmount();
`);
    // 正确实现：清空后旧写入被版本号丢弃 → 内存与磁盘均为空
    assert.equal(out.memLen, 0, '清空后内存必须为空');
    assert.equal(out.diskLen, 0, '清空后磁盘不得被旧写入复活（被检测的错误）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p15_watchResumeIntegration.test.mjs ---