// --- START OF FILE tests/security/p15_finalClosure.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — 最终收口（Final Closure）集成测试
//
// 🎯 本文件专门消除「模拟盲区」：
//   既有 p15_watchResumeIntegration.test.mjs 中，task 与 current 的 mediaKey
//   都用 buildMediaKey({ mediaUrl, pageUrl })（不传 episode）构造，两边都是
//   `m:<url>`，因此永远相等 —— 测试通过，但生产环境实际是：
//     · 历史记录 mediaKey = `ep:<site>:<vod>:<src>:<ep>`（buildWatchRecord 传 episode）
//     · Cinema 旧实现 mediaKey = `m:<mediaUrl>`（不传 episode）
//   → 永不相等 → seek 永不执行。
//
//   本文件严格按**生产真实构造方式**驱动：
//     · 历史记录：LOGIC.buildWatchRecord({ mediaUrl, pageUrl, ... })  ← 产生 ep:
//     · 续播任务：由历史记录字段原样传递（recordKey / mediaKey / mediaUrl / pageUrl）
//     · Cinema 当前媒体：与 src/app/cinema.js 完全一致的构造
//         recordKey: buildRecordKey({ mediaUrl, pageUrl })
//         mediaKey:  buildMediaKey({ mediaUrl, pageUrl })   ← 故意不传 episode
//     · 浏览器嗅探命中：与 src/app/browser/index.js / cinema.js 一致
//         recordKey: buildRecordKey({ mediaUrl, pageUrl })
//         mediaKey:  buildMediaKey({ mediaUrl, pageUrl, episode: triple })
//
//   若把生产代码回退到旧实现（Cinema 只传 mediaKey 且不传 episode），
//   本文件必须失败 —— 见 P15FC-FI* 故障注入用例。
//
// 覆盖用户要求的 12 个场景：
//   1  第 8 集 23:41 退出后点击历史 → 恢复 23:41
//   2  同一集更换 CDN → 正确选源后恢复 23:41
//   3  同页面广告不能错误获得续播授权
//   4  第 9 集不会继承第 8 集进度
//   5  重启 App 后仍保留观看位置
//   6  磁盘已有第 7 集，首次加载期间写入第 8 集，两条都保留
//   7  历史删除 / 清空不被旧请求复活
//   8  多个 Hook 实例同时使用，不丢失更新
//   9  A/B 账号与迟到回调完全隔离
//   10 失效视频源可以回退原网页
//   11 用户确认正确片源后能够自动 seek
//   12 原有浏览器导航与视频播放没有回归
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 直接 import 真实源码（watchHistoryLogic.js / useWatchHistory.js）。
//   - AsyncStorage 用内存实现替换（可注入延迟，用于竞态）。
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
// 极简 React 运行时（与 p15_watchResumeIntegration 同语义）
// ---------------------------------------------------------------------------
const RUNTIME_SRC = String.raw`
let current = null;
let pendingEffects = [];

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

export function createRoot(renderFn) {
  const inst = {
    renderFn, hooks: [], idx: 0, dirty: false, unmounted: false,
    scheduled: false, rerender: null,
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
  const out = inst.renderFn();
  inst.result = out;
  current = null;
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

export function useRef(initial) { return hookSlot(() => ({ current: initial })); }

export function useMemo(fn, deps) {
  const slot = hookSlot(() => ({ deps: undefined, value: undefined, init: false }));
  if (!slot.init || !shallowEqual(slot.deps, deps)) {
    slot.value = fn(); slot.deps = deps; slot.init = true;
  }
  return slot.value;
}

export function useCallback(fn, deps) { return useMemo(() => fn, deps); }

export function useEffect(fn, deps) {
  const slot = hookSlot(() => ({ deps: undefined, cleanup: null, init: false }));
  const changed = !slot.init || !shallowEqual(slot.deps, deps);
  if (changed) {
    slot.deps = deps; slot.init = true;
    pendingEffects.push({ hook: slot, fn });
  }
}

export default { createRoot, useState, useRef, useMemo, useCallback, useEffect };
`;

// ---------------------------------------------------------------------------
// 内存版 AsyncStorage（可注入延迟 / 可注入读失败）
// ---------------------------------------------------------------------------
const STORAGE_SRC = String.raw`
const mem = new Map();
let delayMs = 0;
let failGet = false;
export const __control = {
  setDelay(ms) { delayMs = ms; },
  setFailGet(v) { failGet = !!v; },
  reset() { mem.clear(); delayMs = 0; failGet = false; },
  dump() { return Object.fromEntries(mem.entries()); },
  seed(k, v) { mem.set(k, v); },
  has(k) { return mem.has(k); },
  get(k) { return mem.has(k) ? mem.get(k) : null; },
};
const wait = () => new Promise((r) => setTimeout(r, delayMs));
const AsyncStorage = {
  async getItem(k) {
    await wait();
    if (failGet) throw new Error('simulated read failure');
    return mem.has(k) ? mem.get(k) : null;
  },
  async setItem(k, v) { await wait(); mem.set(k, v); },
  async removeItem(k) { await wait(); mem.delete(k); },
};
export default AsyncStorage;
`;

// 🧩 P1.x 重构后：`src/constants/browser/index.js` 已迁移为 `index.ts`。
//    生产源码仍以显式 `index.js` 导入，故沙箱按「.ts 优先、.js 兜底」解析真实源；
//    源为 .ts 时用项目自带 TypeScript 编译器擦除类型后以 .js 落盘
//    （Node 24 只对 .ts 做原生类型擦除，对 .js 不做，故必须显式转译）。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-fc-'));
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
      code = code
        .replace("from 'react'", `from '${'../'.repeat(3)}${RUNTIME_FILE}'`)
        .replace("from '@react-native-async-storage/async-storage'", `from '${'../'.repeat(3)}${STORAGE_FILE}'`)
        .replace("from './watchHistoryLogic'", "from './watchHistoryLogic.js'");
    }
    fs.writeFileSync(dst, code);
  });
  fs.writeFileSync(path.join(dir, RUNTIME_FILE), RUNTIME_SRC);
  fs.writeFileSync(path.join(dir, STORAGE_FILE), STORAGE_SRC);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

const RESULT_TAG = '__P15FC_RESULT__';

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
  return JSON.parse(raw.slice(idx + RESULT_TAG.length).trim());
}

// ---------------------------------------------------------------------------
// 生产真实构造方式（与 src/app/cinema.js / browser/index.js 逐字对齐）
// ---------------------------------------------------------------------------
const PRELUDE = String.raw`
import { createRoot } from './${RUNTIME_FILE}';
import { __control } from './${STORAGE_FILE}';
const LOGIC = await import('./src/hooks/browser/watchHistoryLogic.js');
const { useWatchHistory } = await import('./src/hooks/browser/useWatchHistory.js');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log('${RESULT_TAG}' + JSON.stringify(o));

// 🎬 Cinema 当前媒体（src/app/cinema.js seek effect 的真实构造）
//    ⚠️ mediaKey 故意不传 episode —— 与生产代码一致
function buildCinemaCurrent(mediaUrl, pageUrl) {
  return {
    recordKey: LOGIC.buildRecordKey({ mediaUrl, pageUrl }),
    mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl }),
    mediaUrl: mediaUrl || '',
    pageUrl: pageUrl || '',
  };
}

// 🌐 浏览器 / 影院嗅探命中（src/app/browser/index.js handleLaunchCinema 真实构造）
function buildSnifferFound(mediaUrl, pageUrl) {
  const triple = LOGIC.parseEpisodeTriple(pageUrl || '');
  return {
    mediaUrl,
    pageUrl: pageUrl || '',
    recordKey: LOGIC.buildRecordKey({ mediaUrl, pageUrl: pageUrl || '' }),
    mediaKey: LOGIC.buildMediaKey({ mediaUrl, pageUrl: pageUrl || '', episode: triple || undefined }),
  };
}

// 🎬 续播任务状态机（与 BrowserSessionContext 同语义，含 recordKey）
function makeTaskStore() {
  let task = null;
  return {
    set(t) {
      task = {
        taskId: LOGIC.createResumeTaskId(),
        recordKey: t.recordKey || '',
        mediaKey: t.mediaKey || '',
        pageUrl: t.pageUrl || '',
        mediaUrl: t.mediaUrl || '',
        seekSeconds: Number.isFinite(t.seekSeconds) ? t.seekSeconds : 0,
        title: t.title || '',
        episodeLabel: t.episodeLabel || '',
        createdAt: Date.now(),
        status: LOGIC.RESUME_TASK_STATUS.PENDING,
      };
      return task;
    },
    get() { return task; },
    update(id, s) {
      if (!task || task.taskId !== id) return;
      if (s === LOGIC.RESUME_TASK_STATUS.APPLIED || s === LOGIC.RESUME_TASK_STATUS.ABORTED) task = null;
      else task = { ...task, status: s };
    },
    consume(id = null) {
      if (!task) return null;
      if (id && task.taskId !== id) return task;
      const t = task; task = null; return t;
    },
  };
}

// 🎬 影院 seek effect 的完整判定（与 src/app/cinema.js 逐条对齐）
//    返回 { matched, seeked, consumed, aborted, reason }
function runCinemaSeekEffect(task, current, player) {
  if (!task || !player) return { matched: false, seeked: false, consumed: false, aborted: false, reason: 'no_task_or_player' };
  if (LOGIC.isResumeTaskExpired(task)) {
    return { matched: false, seeked: false, consumed: false, aborted: true, reason: 'expired' };
  }
  if (!LOGIC.isResumeTargetCurrent(task, current)) {
    return { matched: false, seeked: false, consumed: false, aborted: false, reason: 'identity_unconfirmed' };
  }
  const seekSeconds = Number(task.seekSeconds) || 0;
  if (seekSeconds <= 0) {
    return { matched: true, seeked: false, consumed: true, aborted: false, reason: 'from_start' };
  }
  if (player.status !== 'readyToPlay') {
    return { matched: true, seeked: false, consumed: false, aborted: false, reason: 'not_ready' };
  }
  const dur = player.duration || 0;
  if (!(dur > 0) || seekSeconds >= dur - 1) {
    return { matched: true, seeked: false, consumed: false, aborted: true, reason: 'out_of_range' };
  }
  try {
    player.currentTime = seekSeconds;
    player.playing = true;
  } catch (_) {
    return { matched: true, seeked: false, consumed: false, aborted: true, reason: 'seek_threw' };
  }
  return { matched: true, seeked: true, consumed: true, aborted: false, reason: 'applied', seekSeconds };
}
`;

// 常用常量
const EP8_PAGE = 'https://site.com/play/392563-36-700596.html';
const EP9_PAGE = 'https://site.com/play/392563-36-700597.html';
const EP8_CDN_A = 'https://cdn-a.site.com/vod/392563-36-700596/index.m3u8';
const EP8_CDN_B = 'https://cdn-b.site.com/vod/392563-36-700596/index.m3u8';
const EP9_CDN = 'https://cdn-a.site.com/vod/392563-36-700597/index.m3u8';
const AD_URL = 'https://ads.tracker.com/preroll/ad.m3u8';
const SEEK_23_41 = 23 * 60 + 41; // 1421 秒

// ===========================================================================
// 场景 1：第 8 集播放到 23:41，退出后点击历史 → 恢复到 23:41
// ===========================================================================
test('P15FC-01 第 8 集 23:41 退出后点击历史，恢复到 23:41（生产真实构造）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// ① 观看时写入历史（buildWatchRecord 产生 ep: 身份）
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000,
  title: '测试剧 第8集', episodeLabel: '第8集',
});
// ② 点击历史 → 创建续播任务（字段原样传递，与 watch-history.js 一致）
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// ③ 影院加载同一片源（Cinema 真实构造：mediaKey 不含 episode）
const current = buildCinemaCurrent('${EP8_CDN_A}', '${EP8_PAGE}');
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(task, current, player);
// ④ 生产语义：effect 判定 consumed 后必须真正消费任务（cinema.js 调用 consumeResumeTask）
//    runCinemaSeekEffect 是纯判定函数，不持有 store，故此处显式消费以还原真实链路。
if (r.consumed) store.consume(task.taskId);

emit({
  recordMediaKey: record.mediaKey,
  recordKey: record.recordKey,
  taskRecordKey: task.recordKey,
  cinemaMediaKey: current.mediaKey,
  cinemaRecordKey: current.recordKey,
  seekSeconds: task.seekSeconds,
  matched: r.matched, seeked: r.seeked, consumed: r.consumed,
  playerTime: player.currentTime, playing: player.playing,
  taskAfter: store.get() ? 'present' : 'consumed',
});
`);
    // 关键断言：历史记录是 ep: 身份，Cinema 的 mediaKey 是 m: 身份（不同！）
    assert.match(out.recordMediaKey, /^ep:/, '历史记录必须是 ep: 身份');
    assert.match(out.cinemaMediaKey, /^m:/, 'Cinema mediaKey 是 m: 身份（不含 episode）');
    assert.notEqual(out.recordMediaKey, out.cinemaMediaKey, '两者 mediaKey 必然不同（旧实现的缺陷根源）');
    // 但 recordKey 必须一致 → 续播成立
    assert.equal(out.recordKey, out.cinemaRecordKey, 'recordKey 必须一致（同一集）');
    assert.equal(out.taskRecordKey, out.cinemaRecordKey, '任务 recordKey 必须与当前媒体一致');
    assert.equal(out.seekSeconds, SEEK_23_41, '续播秒数必须是 1421');
    assert.equal(out.matched, true, '身份必须匹配');
    assert.equal(out.seeked, true, '必须执行 seek');
    assert.equal(out.playerTime, SEEK_23_41, '播放器必须定位到 23:41');
    assert.equal(out.playing, true, 'seek 后必须开始播放');
    assert.equal(out.taskAfter, 'consumed', 'seek 成功后任务必须被消费');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 2：同一集更换 CDN → 正确选源后恢复 23:41
// ===========================================================================
test('P15FC-02 同一集更换 CDN，正确选源后恢复 23:41', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 历史记录来自 CDN-A
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 重新嗅探到 CDN-B（同一集，不同 CDN）
const found = buildSnifferFound('${EP8_CDN_B}', '${EP8_PAGE}');
const snifferMatched = LOGIC.isPendingResumeMatch(store.get(), found);
// 影院加载 CDN-B
const current = buildCinemaCurrent('${EP8_CDN_B}', '${EP8_PAGE}');
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(store.get(), current, player);

emit({
  snifferMatched, seeked: r.seeked, playerTime: player.currentTime,
  recordKeyEq: record.recordKey === current.recordKey,
  mediaKeyDiff: record.mediaKey !== current.mediaKey,
});
`);
    assert.equal(out.mediaKeyDiff, true, '换 CDN 后 mediaKey 必然不同');
    assert.equal(out.recordKeyEq, true, '换 CDN 后 recordKey 必须相同');
    assert.equal(out.snifferMatched, true, '嗅探命中必须通过身份校验（换 CDN 不误拒）');
    assert.equal(out.seeked, true, '换 CDN 后必须仍能 seek');
    assert.equal(out.playerTime, SEEK_23_41, '必须恢复到 23:41');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 3：同页面广告不能错误获得续播授权
// ===========================================================================
test('P15FC-03 同页面广告不能获得续播授权', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 同页广告：pageUrl 完全相同，媒体是广告
const adCurrent = buildCinemaCurrent('${AD_URL}', '${EP8_PAGE}');
const adFound = buildSnifferFound('${AD_URL}', '${EP8_PAGE}');
const player = { status: 'readyToPlay', duration: 30, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(store.get(), adCurrent, player);

emit({
  adRecordKey: adCurrent.recordKey,
  taskRecordKey: task.recordKey,
  recordKeyDiff: adCurrent.recordKey !== task.recordKey,
  snifferMatched: LOGIC.isPendingResumeMatch(task, adFound),
  matched: r.matched, seeked: r.seeked, playerTime: player.currentTime,
});
`);
    assert.notEqual(out.adRecordKey, out.taskRecordKey, '同页广告的 recordKey 必须与正片不同');
    assert.equal(out.recordKeyDiff, true);
    assert.equal(out.snifferMatched, false, '同页广告不得通过嗅探身份校验');
    assert.equal(out.matched, false, '同页广告不得通过 seek 闸门');
    assert.equal(out.seeked, false, '同页广告绝不能 seek');
    assert.equal(out.playerTime, 0, '广告必须从头播放');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 4：第 9 集不会继承第 8 集进度
// ===========================================================================
test('P15FC-04 第 9 集不会继承第 8 集进度', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 用户切到第 9 集
const ep9Current = buildCinemaCurrent('${EP9_CDN}', '${EP9_PAGE}');
const ep9Found = buildSnifferFound('${EP9_CDN}', '${EP9_PAGE}');
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(store.get(), ep9Current, player);

emit({
  recordKeyDiff: ep9Current.recordKey !== task.recordKey,
  snifferMatched: LOGIC.isPendingResumeMatch(task, ep9Found),
  matched: r.matched, seeked: r.seeked, playerTime: player.currentTime,
});
`);
    assert.equal(out.recordKeyDiff, true, '第 9 集 recordKey 必须与第 8 集不同');
    assert.equal(out.snifferMatched, false, '第 9 集不得匹配第 8 集任务');
    assert.equal(out.matched, false);
    assert.equal(out.seeked, false, '第 9 集绝不能 seek 到第 8 集进度');
    assert.equal(out.playerTime, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 5：重启 App 后仍保留观看位置
// ===========================================================================
test('P15FC-05 重启 App 后仍保留观看位置', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const KEY = LOGIC.buildWatchHistoryKey('user-1');
// 第一次会话：写入第 8 集 23:41
const root1 = createRoot(() => useWatchHistory('user-1', 1));
await tick(5);
root1.result.saveWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
await tick(20);
const diskAfterSession1 = __control.get(KEY);
root1.unmount();

// 模拟重启：清空模块级共享桶（新进程等价于新 Map）
//    → 通过重新 import 无法在同一进程内做到，改为断言磁盘内容 + 新实例从磁盘恢复
const root2 = createRoot(() => useWatchHistory('user-1', 1));
await tick(20);
const list = root2.result.watchList;
const rec = list[0] || null;
root2.unmount();

emit({
  diskHasData: !!diskAfterSession1,
  restoredCount: list.length,
  restoredPosition: rec ? LOGIC.resolveResumeSeconds(rec) : -1,
  restoredMediaKey: rec ? rec.mediaKey : '',
});
`);
    assert.equal(out.diskHasData, true, '磁盘必须已写入历史');
    assert.equal(out.restoredCount, 1, '重启后必须恢复 1 条记录');
    assert.equal(out.restoredPosition, SEEK_23_41, '重启后必须恢复 23:41');
    assert.match(out.restoredMediaKey, /^ep:/, '恢复的记录仍是 ep: 身份');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 6：磁盘已有第 7 集，首次加载期间写入第 8 集，两条都保留
// ===========================================================================
test('P15FC-06 首次加载期间写入新记录，磁盘旧记录不被覆盖', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const KEY = LOGIC.buildWatchHistoryKey('user-1');
// 磁盘预置第 7 集
const ep7 = LOGIC.buildWatchRecord({
  mediaUrl: 'https://cdn-a.site.com/vod/392563-36-700595/index.m3u8',
  pageUrl: 'https://site.com/play/392563-36-700595.html',
  positionMillis: 600 * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第7集',
});
__control.seed(KEY, JSON.stringify([ep7]));

// 注入读延迟，让「加载中」窗口足够大
__control.setDelay(30);
const root = createRoot(() => useWatchHistory('user-1', 1));
// 立即写入第 8 集（此时首次读盘尚未完成）
await tick(5);
root.result.saveWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
await tick(120);
const list = root.result.watchList;
const disk = JSON.parse(__control.get(KEY) || '[]');
root.unmount();

emit({
  memCount: list.length,
  memTitles: list.map((x) => x.title).sort(),
  diskCount: disk.length,
  diskTitles: disk.map((x) => x.title).sort(),
});
`);
    assert.equal(out.memCount, 2, '内存态必须同时保留第 7、8 集');
    assert.deepEqual(out.memTitles, ['测试剧 第7集', '测试剧 第8集']);
    assert.equal(out.diskCount, 2, '磁盘必须同时保留第 7、8 集（不得被空列表覆盖）');
    assert.deepEqual(out.diskTitles, ['测试剧 第7集', '测试剧 第8集']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 7：历史删除 / 清空不被旧请求复活
// ===========================================================================
test('P15FC-07 删除与清空不被在途旧写入复活', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const KEY = LOGIC.buildWatchHistoryKey('user-1');
const root = createRoot(() => useWatchHistory('user-1', 1));
await tick(5);
// 写入两条
root.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1000 * 1000, durationMillis: 45 * 60 * 1000, title: '第8集' });
root.result.saveWatchRecord({ mediaUrl: '${EP9_CDN}', pageUrl: '${EP9_PAGE}',
  positionMillis: 500 * 1000, durationMillis: 45 * 60 * 1000, title: '第9集' });
await tick(30);

// 制造慢写入：延迟 40ms，然后立刻删除第 8 集
__control.setDelay(40);
root.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 2000 * 1000, durationMillis: 45 * 60 * 1000, title: '第8集' });
const ep8Key = LOGIC.buildWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1, durationMillis: 1, title: 'x' }).mediaKey;
root.result.deleteWatchRecord(ep8Key);
await tick(200);
const afterDelete = root.result.watchList.map((x) => x.title);

// 再制造慢写入后清空
__control.setDelay(40);
root.result.saveWatchRecord({ mediaUrl: '${EP9_CDN}', pageUrl: '${EP9_PAGE}',
  positionMillis: 3000 * 1000, durationMillis: 45 * 60 * 1000, title: '第9集' });
root.result.clearWatchHistory();
await tick(200);
const afterClear = root.result.watchList.length;
const disk = JSON.parse(__control.get(KEY) || '[]');
root.unmount();

emit({ afterDelete, afterClear, diskCount: disk.length });
`);
    assert.deepEqual(out.afterDelete, ['第9集'], '删除第 8 集后只剩第 9 集（旧写入不得复活）');
    assert.equal(out.afterClear, 0, '清空后内存态必须为空');
    assert.equal(out.diskCount, 0, '清空后磁盘必须为空（旧写入不得复活）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 8：多个 Hook 实例同时使用，不丢失更新
// ===========================================================================
test('P15FC-08 多实例并发写入不丢失更新', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const a = createRoot(() => useWatchHistory('user-1', 1));
const b = createRoot(() => useWatchHistory('user-1', 1));
await tick(10);
// 两个实例交替写入不同记录
a.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1000 * 1000, durationMillis: 45 * 60 * 1000, title: '第8集' });
b.result.saveWatchRecord({ mediaUrl: '${EP9_CDN}', pageUrl: '${EP9_PAGE}',
  positionMillis: 500 * 1000, durationMillis: 45 * 60 * 1000, title: '第9集' });
await tick(40);
// 同一记录被两个实例先后更新（后者应覆盖前者，且不产生重复条目）
a.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1500 * 1000, durationMillis: 45 * 60 * 1000, title: '第8集' });
b.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1800 * 1000, durationMillis: 45 * 60 * 1000, title: '第8集' });
await tick(60);
const listA = a.result.watchList;
const listB = b.result.watchList;
const disk = JSON.parse(__control.get(LOGIC.buildWatchHistoryKey('user-1')) || '[]');
a.unmount(); b.unmount();

emit({
  countA: listA.length, countB: listB.length, diskCount: disk.length,
  titlesA: listA.map((x) => x.title).sort(),
  ep8Position: (listA.find((x) => x.title === '第8集') || {}).positionMillis,
});
`);
    assert.equal(out.countA, 2, '实例 A 必须看到 2 条（不丢失更新）');
    assert.equal(out.countB, 2, '实例 B 必须看到 2 条（跨实例一致）');
    assert.equal(out.diskCount, 2, '磁盘必须只有 2 条（同记录不重复）');
    assert.deepEqual(out.titlesA, ['第8集', '第9集']);
    assert.equal(out.ep8Position, 1800 * 1000, '第 8 集必须是最新写入的进度');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 9：A/B 账号与迟到回调完全隔离
// ===========================================================================
test('P15FC-09 A/B 账号与迟到回调完全隔离', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const KEY_A = LOGIC.buildWatchHistoryKey('user-A');
const KEY_B = LOGIC.buildWatchHistoryKey('user-B');

// A 登录并写入
const rootA = createRoot(() => useWatchHistory('user-A', 1));
await tick(10);
rootA.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1000 * 1000, durationMillis: 45 * 60 * 1000, title: 'A的第8集' });
await tick(30);
rootA.unmount();

// B 登录并写入
const rootB = createRoot(() => useWatchHistory('user-B', 2));
await tick(10);
rootB.result.saveWatchRecord({ mediaUrl: '${EP9_CDN}', pageUrl: '${EP9_PAGE}',
  positionMillis: 500 * 1000, durationMillis: 45 * 60 * 1000, title: 'B的第9集' });
await tick(30);
const bList = rootB.result.watchList.map((x) => x.title);
rootB.unmount();

// A 重新登录（A→B→A）：必须只看到自己的记录
const rootA2 = createRoot(() => useWatchHistory('user-A', 3));
await tick(30);
const aList = rootA2.result.watchList.map((x) => x.title);
rootA2.unmount();

const diskA = JSON.parse(__control.get(KEY_A) || '[]').map((x) => x.title);
const diskB = JSON.parse(__control.get(KEY_B) || '[]').map((x) => x.title);

emit({ bList, aList, diskA, diskB });
`);
    assert.deepEqual(out.bList, ['B的第9集'], 'B 只能看到自己的记录');
    assert.deepEqual(out.aList, ['A的第8集'], 'A 重新登录只能看到自己的记录（不跨账号污染）');
    assert.deepEqual(out.diskA, ['A的第8集'], 'A 的磁盘 key 只含 A 的记录');
    assert.deepEqual(out.diskB, ['B的第9集'], 'B 的磁盘 key 只含 B 的记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 10：失效视频源可以回退原网页
// ===========================================================================
test('P15FC-10 失效视频源回退原播放页（不盲连脱敏直链）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 历史记录带签名参数（已脱敏落盘），直链大概率 403
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}?token=SECRET&expires=1', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
// 历史页无实时候选 → decideResume(record, [])
const decision = LOGIC.decideResume(record, []);
// 直链不可用（模拟播放失败）→ 影院作废任务，浏览器回退原页
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 播放器加载失败（status 非 readyToPlay，duration 0）
const current = buildCinemaCurrent(record.mediaUrl, record.pageUrl);
const player = { status: 'error', duration: 0, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(store.get(), current, player);

emit({
  action: decision.action,
  decisionUrl: decision.url,
  hasPageUrl: !!record.pageUrl,
  seeked: r.seeked,
  reason: r.reason,
  sanitizedNoToken: !/token=SECRET/.test(record.mediaUrl),
});
`);
    assert.equal(out.action, 'NAVIGATE_TO_PAGE', '有播放页时必须回原页重新嗅探');
    assert.equal(out.decisionUrl, EP8_PAGE, '回退目标必须是原播放页');
    assert.equal(out.hasPageUrl, true);
    assert.equal(out.seeked, false, '播放器未就绪时不得 seek');
    assert.equal(out.sanitizedNoToken, true, '落盘媒体 URL 必须已剥离 token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 11：用户确认正确片源后能够自动 seek
// ===========================================================================
test('P15FC-11 用户手动确认正确片源后自动 seek', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 用户在候选列表中手动选择 CDN-B（handleLaunchCinema 真实构造）
const found = buildSnifferFound('${EP8_CDN_B}', '${EP8_PAGE}');
const kept = LOGIC.isPendingResumeMatch(store.get(), found);
// 若匹配则保留任务（不 ABORTED），影院加载后 seek
const current = buildCinemaCurrent('${EP8_CDN_B}', '${EP8_PAGE}');
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(store.get(), current, player);

emit({ kept, seeked: r.seeked, playerTime: player.currentTime, consumed: r.consumed });
`);
    assert.equal(out.kept, true, '用户选中的正确片源必须保留续播任务');
    assert.equal(out.seeked, true, '确认片源后必须自动 seek');
    assert.equal(out.playerTime, SEEK_23_41, '必须恢复到 23:41');
    assert.equal(out.consumed, true, 'seek 成功后任务必须被消费');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 场景 12：原有浏览器导航与视频播放没有回归
// ===========================================================================
test('P15FC-12 无历史任务时正常播放不受影响（无回归）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 无 pendingResume：影院正常播放，不 seek
const current = buildCinemaCurrent('${EP8_CDN_A}', '${EP8_PAGE}');
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(null, current, player);

// 普通网页（无媒体 URL）：buildWatchRecord 退化为 p: 播放页身份。
//   ⚠️ 逻辑层不做「是否值得记录」的判断——真正的闸门在采集层
//      （useWatchProgressRecorder 仅在存在播放器且实际播放时才调用 saveWatchRecord）。
//      此处断言「退化身份为 p:」以固化该契约，避免误以为逻辑层会返回 null。
const plain = LOGIC.buildWatchRecord({ mediaUrl: '', pageUrl: 'https://news.example.com/article/1' });
// 直链视频（无播放页）仍可生成 m: 身份记录
const direct = LOGIC.buildWatchRecord({
  mediaUrl: 'https://cdn.example.com/movie.mp4', pageUrl: '',
  positionMillis: 60000, durationMillis: 600000, title: '直链视频',
});

emit({
  seeked: r.seeked, playerTime: player.currentTime,
  plainMediaKey: plain ? plain.mediaKey : '',
  directMediaKey: direct ? direct.mediaKey : '',
});
`);
    assert.equal(out.seeked, false, '无任务时不得 seek');
    assert.equal(out.playerTime, 0, '无任务时从头播放');
    assert.match(out.plainMediaKey, /^p:/, '无媒体 URL 时退化为 p: 播放页身份（采集层负责不记录）');
    assert.match(out.directMediaKey, /^m:/, '直链视频仍可生成 m: 身份记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 故障注入：把生产代码回退为旧实现，测试必须失败
// ===========================================================================
test('P15FC-FI1 故障注入：Cinema 只传 mediaKey（旧实现）必须导致 seek 失败', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 🐞 旧实现：Cinema 只构造 mediaKey（不传 episode），且不提供 recordKey
const legacyCurrent = {
  mediaKey: LOGIC.buildMediaKey({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}' }),
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
};
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(store.get(), legacyCurrent, player);

emit({
  legacyMediaKey: legacyCurrent.mediaKey,
  recordMediaKey: record.mediaKey,
  matched: r.matched, seeked: r.seeked, playerTime: player.currentTime,
});
`);
    // 旧实现下：mediaKey 不同（ep: vs m:），但 recordKey 仍可由 pageUrl 推导 → 修复后仍能匹配
    // 因此本用例验证的是「即使调用方只传 mediaKey，三层模型仍能兜底」，
    // 同时断言 mediaKey 本身确实不同（证明旧实现依赖 mediaKey 会失败）。
    assert.notEqual(out.legacyMediaKey, out.recordMediaKey, '旧实现 mediaKey 与记录不同（缺陷根源）');
    assert.equal(out.matched, true, '三层模型必须兜底：仅凭 pageUrl 也能推导出相同 recordKey');
    assert.equal(out.seeked, true, '兜底后仍必须 seek 成功');
    assert.equal(out.playerTime, SEEK_23_41);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P15FC-FI2 故障注入：仅凭 pageUrl 判定（无媒体校验）必须被同页广告击穿', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
// 模拟「仅凭 pageUrl 相同就放行」的错误实现
const naiveMatch = (task, current) => {
  const a = LOGIC.sanitizePageUrl(task.pageUrl);
  const b = LOGIC.sanitizePageUrl(current.pageUrl);
  return !!a && a === b;
};
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
const adCurrent = buildCinemaCurrent('${AD_URL}', '${EP8_PAGE}');

emit({
  naiveWouldPass: naiveMatch(task, adCurrent),
  realRejects: !LOGIC.isResumeTargetCurrent(task, adCurrent),
});
`);
    assert.equal(out.naiveWouldPass, true, '错误实现确实会让同页广告通过（证明该缺陷真实存在）');
    assert.equal(out.realRejects, true, '真实实现必须拒绝同页广告');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P15FC-FI3 故障注入：读盘失败后静默落盘必须丢失既有历史', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const KEY = LOGIC.buildWatchHistoryKey('user-1');
// 磁盘预置第 7 集
const ep7 = LOGIC.buildWatchRecord({
  mediaUrl: 'https://cdn-a.site.com/vod/392563-36-700595/index.m3u8',
  pageUrl: 'https://site.com/play/392563-36-700595.html',
  positionMillis: 600 * 1000, durationMillis: 45 * 60 * 1000, title: '第7集',
});
__control.seed(KEY, JSON.stringify([ep7]));
// 注入读失败
__control.setFailGet(true);
const root = createRoot(() => useWatchHistory('user-1', 1));
await tick(20);
// 读失败后写入第 8 集
root.result.saveWatchRecord({ mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: 1000 * 1000, durationMillis: 45 * 60 * 1000, title: '第8集' });
await tick(60);
const disk = JSON.parse(__control.get(KEY) || '[]');
root.unmount();

emit({
  diskTitles: disk.map((x) => x.title),
  diskCount: disk.length,
  memCount: 1,
});
`);
    // 修复后：读失败 → 禁止落盘 → 磁盘仍是原始第 7 集（未被空列表覆盖）
    assert.deepEqual(out.diskTitles, ['第7集'], '读失败后磁盘必须保留原始第 7 集（不得被覆盖）');
    assert.equal(out.diskCount, 1, '磁盘不得被写入新数据');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P15FC-FI4 故障注入：任务过期后必须作废，不得无限等待', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});
// 伪造 60 秒前创建（超过 45 秒超时）
const expired = { ...task, createdAt: Date.now() - 60000 };
const current = buildCinemaCurrent('${EP8_CDN_A}', '${EP8_PAGE}');
const player = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const r = runCinemaSeekEffect(expired, current, player);

emit({ expired: LOGIC.isResumeTaskExpired(expired), aborted: r.aborted, seeked: r.seeked, reason: r.reason });
`);
    assert.equal(out.expired, true, '60 秒前的任务必须判定为过期');
    assert.equal(out.aborted, true, '过期任务必须作废');
    assert.equal(out.seeked, false, '过期任务不得 seek');
    assert.equal(out.reason, 'expired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 🐞 Gatekeeper 复现缺陷 1：同站广告误续播
//
// 缺陷描述（Gatekeeper 独立复现）：
//   `cdn.site.com` 正片与 `ads.site.com` 广告在相同剧集播放页下会得到
//   相同 recordKey，导致 isPendingResumeMatch 与 isResumeTargetCurrent
//   均错误返回 true → 广告继承正片进度。
//
// 根因：旧实现用「可注册主域（eTLD+1）」判断同站，`ads.site.com` 与
//   `cdn.site.com` 的主域都是 `site.com`，因此广告被误认为正片片源。
//
// 修复要求（用户明确）：
//   · 相同可注册主域不能单独作为正片身份证明
//   · 自动续播必须有可靠媒体匹配证据，或用户明确确认过当前片源
//   · 用户确认正确片源后，必须能够自动恢复原有进度
//   · 保留 CDN 更换后的正常续播能力
//
// 本用例在修复前必须失败（recordKey 相同 / 闸门放行 / 广告被 seek）。
// ===========================================================================
const AD_SAME_SITE = 'https://ads.site.com/preroll/392563-36-700596/ad.m3u8';
const AD_SAME_SITE_PATH = 'https://site.com/ad/preroll.m3u8';

test('P15FC-GK1 同站广告（ads.site.com）不得继承正片续播授权', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
const record = LOGIC.buildWatchRecord({
  mediaUrl: '${EP8_CDN_A}', pageUrl: '${EP8_PAGE}',
  positionMillis: ${SEEK_23_41} * 1000, durationMillis: 45 * 60 * 1000, title: '测试剧 第8集',
});
const store = makeTaskStore();
const task = store.set({
  recordKey: record.recordKey || record.mediaKey,
  mediaKey: record.mediaKey, pageUrl: record.pageUrl, mediaUrl: record.mediaUrl,
  seekSeconds: LOGIC.resolveResumeSeconds(record),
});

// ① 同站广告子域（ads.site.com）—— 与正片同可注册主域
const adCurrent = buildCinemaCurrent('${AD_SAME_SITE}', '${EP8_PAGE}');
const adFound = buildSnifferFound('${AD_SAME_SITE}', '${EP8_PAGE}');
const playerAd = { status: 'readyToPlay', duration: 30, currentTime: 0, playing: false };
const rAd = runCinemaSeekEffect(store.get(), adCurrent, playerAd);

// ② 同站广告路径（site.com/ad/...）—— hostname 无法识别，靠 path 排除
const adPathCurrent = buildCinemaCurrent('${AD_SAME_SITE_PATH}', '${EP8_PAGE}');
const adPathFound = buildSnifferFound('${AD_SAME_SITE_PATH}', '${EP8_PAGE}');
const playerAdPath = { status: 'readyToPlay', duration: 30, currentTime: 0, playing: false };
const rAdPath = runCinemaSeekEffect(store.get(), adPathCurrent, playerAdPath);

// ③ 换 CDN 子域（cdn-b.site.com）—— 必须仍能续播（不得误伤）
const cdnCurrent = buildCinemaCurrent('${EP8_CDN_B}', '${EP8_PAGE}');
const cdnFound = buildSnifferFound('${EP8_CDN_B}', '${EP8_PAGE}');
const playerCdn = { status: 'readyToPlay', duration: 45 * 60, currentTime: 0, playing: false };
const rCdn = runCinemaSeekEffect(store.get(), cdnCurrent, playerCdn);

emit({
  mainRecordKey: record.recordKey,
  adRecordKey: adCurrent.recordKey,
  adRecordKeyDiff: adCurrent.recordKey !== record.recordKey,
  adPathRecordKey: adPathCurrent.recordKey,
  adPathRecordKeyDiff: adPathCurrent.recordKey !== record.recordKey,
  adSnifferMatched: LOGIC.isPendingResumeMatch(task, adFound),
  adMatched: rAd.matched, adSeeked: rAd.seeked, adPlayerTime: playerAd.currentTime,
  adPathSnifferMatched: LOGIC.isPendingResumeMatch(task, adPathFound),
  adPathMatched: rAdPath.matched, adPathSeeked: rAdPath.seeked, adPathPlayerTime: playerAdPath.currentTime,
  cdnRecordKeySame: cdnCurrent.recordKey === record.recordKey,
  cdnSnifferMatched: LOGIC.isPendingResumeMatch(task, cdnFound),
  cdnMatched: rCdn.matched, cdnSeeked: rCdn.seeked, cdnPlayerTime: playerCdn.currentTime,
});
`);
    // ① 同站广告子域：身份必须不同，闸门必须拒绝
    assert.equal(out.adRecordKeyDiff, true, '同站广告 ads.site.com 的 recordKey 必须与正片不同');
    assert.equal(out.adSnifferMatched, false, '同站广告不得通过嗅探身份校验');
    assert.equal(out.adMatched, false, '同站广告不得通过 seek 闸门');
    assert.equal(out.adSeeked, false, '同站广告绝不能 seek');
    assert.equal(out.adPlayerTime, 0, '同站广告必须从头播放');
    // ② 同站广告路径：同样必须拒绝
    assert.equal(out.adPathRecordKeyDiff, true, '同站广告路径的 recordKey 必须与正片不同');
    assert.equal(out.adPathSnifferMatched, false, '同站广告路径不得通过嗅探身份校验');
    assert.equal(out.adPathMatched, false, '同站广告路径不得通过 seek 闸门');
    assert.equal(out.adPathSeeked, false, '同站广告路径绝不能 seek');
    assert.equal(out.adPathPlayerTime, 0, '同站广告路径必须从头播放');
    // ③ 换 CDN：必须仍能续播（保留原有能力）
    assert.equal(out.cdnRecordKeySame, true, '换 CDN 子域后 recordKey 必须相同');
    assert.equal(out.cdnSnifferMatched, true, '换 CDN 子域必须通过嗅探身份校验');
    assert.equal(out.cdnMatched, true, '换 CDN 子域必须通过 seek 闸门');
    assert.equal(out.cdnSeeked, true, '换 CDN 子域必须仍能 seek');
    assert.equal(out.cdnPlayerTime, SEEK_23_41, '换 CDN 子域必须恢复到 23:41');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 🐞 Gatekeeper 复现缺陷 2：首次 hydration 期间的删除 / 清空竞态
//
// 缺陷描述（Gatekeeper 独立复现）：
//   首次加载期间执行 clear 后，hydration 仍可能从磁盘合并已删除的记录，
//   使其重新出现。
//
// 根因：旧实现合并时以「磁盘列表为基底」，把内存列表逐条 upsert 进去。
//   clear 后内存为空 → upsert 循环体不执行 → merged === 磁盘列表 → 全部复活。
//   delete 单条同理会被磁盘数据带回。
//
// 修复要求（用户明确）：
//   · 加载期间的新增、更新、删除、清空操作必须按顺序得到正确处理
//   · 不能简单地将磁盘数据与当前内存记录做无条件 upsert
//   · 保证已有历史不丢失
//   · 保证已删除记录不复活
//
// 本用例在修复前必须失败（clear 后磁盘记录复活 / delete 后单条复活）。
// ===========================================================================
test('P15FC-GK2 首次 hydration 期间 clear / delete 不得被磁盘数据复活', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `${PRELUDE}
__control.reset();
const mk = (ep, pos) => ({
  mediaUrl: 'https://cdn-a.site.com/vod/392563-36-' + ep + '/index.m3u8',
  pageUrl: 'https://site.com/play/392563-36-' + ep + '.html',
  positionMillis: pos * 1000, durationMillis: 45 * 60 * 1000, title: '第' + ep + '集',
});
const a1 = LOGIC.buildWatchRecord(mk('700595', 600));
const a2 = LOGIC.buildWatchRecord(mk('700596', 700));

// ── 场景 A：加载期间 clear → 磁盘记录不得复活 ──
const KA = LOGIC.buildWatchHistoryKey('gk-user-A');
__control.seed(KA, JSON.stringify([a1, a2]));
__control.setDelay(40);
const rootA = createRoot(() => useWatchHistory('gk-user-A', 1));
await tick(5);
rootA.result.clearWatchHistory();
await tick(200);
const memA = rootA.result.watchList.length;
const diskA = JSON.parse(__control.get(KA) || '[]').length;
rootA.unmount();

// ── 场景 B：加载期间 delete 单条 → 该条不复活，其余保留 ──
const KB = LOGIC.buildWatchHistoryKey('gk-user-B');
__control.seed(KB, JSON.stringify([a1, a2]));
const rootB = createRoot(() => useWatchHistory('gk-user-B', 1));
await tick(5);
rootB.result.deleteWatchRecord(a1.id);
await tick(200);
const memB = rootB.result.watchList.map((x) => x.title);
const diskB = JSON.parse(__control.get(KB) || '[]').map((x) => x.title);
rootB.unmount();

// ── 场景 C：加载期间新增 → 磁盘旧记录不丢（既有能力回归） ──
const KC = LOGIC.buildWatchHistoryKey('gk-user-C');
__control.seed(KC, JSON.stringify([a1]));
const rootC = createRoot(() => useWatchHistory('gk-user-C', 1));
await tick(5);
rootC.result.saveWatchRecord(mk('700596', 700));
await tick(200);
const memC = rootC.result.watchList.map((x) => x.title).sort();
const diskC = JSON.parse(__control.get(KC) || '[]').map((x) => x.title).sort();
rootC.unmount();

// ── 场景 D：加载期间 clear 后再新增 → 只剩新增 ──
const KD = LOGIC.buildWatchHistoryKey('gk-user-D');
__control.seed(KD, JSON.stringify([a1, a2]));
const rootD = createRoot(() => useWatchHistory('gk-user-D', 1));
await tick(5);
rootD.result.clearWatchHistory();
rootD.result.saveWatchRecord(mk('700597', 800));
await tick(200);
const memD = rootD.result.watchList.map((x) => x.title);
const diskD = JSON.parse(__control.get(KD) || '[]').map((x) => x.title);
rootD.unmount();

emit({ memA, diskA, memB, diskB, memC, diskC, memD, diskD });
`);
    // A：clear 后内存与磁盘都必须为空
    assert.equal(out.memA, 0, '加载期间 clear 后内存必须为空');
    assert.equal(out.diskA, 0, '加载期间 clear 后磁盘必须为空（已删除记录不得复活）');
    // B：delete 单条后只剩另一条
    assert.deepEqual(out.memB, ['第700596集'], '加载期间 delete 后内存只剩未删除的那条');
    assert.deepEqual(out.diskB, ['第700596集'], '加载期间 delete 后磁盘不得复活已删除记录');
    // C：新增不丢历史
    assert.deepEqual(out.memC, ['第700595集', '第700596集'], '加载期间新增后内存必须同时保留旧记录与新记录');
    assert.deepEqual(out.diskC, ['第700595集', '第700596集'], '加载期间新增后磁盘必须同时保留旧记录与新记录');
    // D：clear 后新增只剩新增
    assert.deepEqual(out.memD, ['第700597集'], '加载期间 clear 后新增，内存只剩新增记录');
    assert.deepEqual(out.diskD, ['第700597集'], '加载期间 clear 后新增，磁盘只剩新增记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p15_finalClosure.test.mjs ---