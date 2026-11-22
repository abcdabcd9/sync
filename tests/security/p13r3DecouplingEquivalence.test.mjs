// --- START OF FILE tests/security/p13r3DecouplingEquivalence.test.mjs ---
/**
 * P1.3 R3 — 浏览器历史 / 书签「纯数据决策」解耦 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 解耦前实现：冻结基线 `tests/fixtures/p13r3/before/hooks__browser__useBrowserHistory.js`
 *     · 解耦后实现：当前 `src/hooks/browser/useBrowserHistory.js`
 *       （normalizeBookmark / normalizeBookmarkList / cleanHistoryList /
 *         buildHistoryEntry / mergeHistoryEntry 内部委托 `historyDataLogic.ts`）
 *   对同一组输入比较**完整可观测结果**：
 *     - 状态值（historyList / bookmarksList）
 *     - 派生值（isBookmarked 判定）
 *     - 副作用（AsyncStorage 写入的 key 与内容、写入次数）
 *     - 身份隔离（owner / authEpoch 迟到回调丢弃、A→B→A、渲染期清空）
 *     - 异常语义（非法缓存 JSON / 非数组 / 脏条目）
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实 Hook 源码：
 *   该运行时实现了 useState / useRef / useEffect / useCallback / useMemo 的最小语义，
 *   用于在 Node 环境中真实调用 Hook 并观察其状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证 Hook 源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / 真实 AsyncStorage（使用内存 Map 桩）。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行 Hook 源码，不复制内部函数做模拟。
 *
 * 覆盖（R3-1 … R3-24）
 *   R3-1  初始状态（空历史 / 空书签 / 无 owner 不读写）
 *   R3-2  公开接口键集合不变
 *   R3-3  首次加载落默认书签 + seed 版本
 *   R3-4  已有缓存 + seed 最新 → 原样读取
 *   R3-5  旧版纯 URL 字符串缓存归一化
 *   R3-6  书签按 url 去重（保留首次顺序）
 *   R3-7  非法书签条目丢弃（非 https / 非对象）
 *   R3-8  seed 版本落后 → 剔除旧默认 + 前置新默认 + 去重
 *   R3-9  历史读取脏数据过滤 + 上限截断
 *   R3-10 历史读取非数组 → 丢弃
 *   R3-11 历史读取非法 JSON → 丢弃（不抛）
 *   R3-12 addHistory 正常写入（去重 + 置顶）
 *   R3-13 addHistory 同一页面重复回调跳过
 *   R3-14 addHistory 非安全 URL 不写
 *   R3-15 addHistory cn.bing.com/search 不写
 *   R3-16 addHistory 上限 100 截断
 *   R3-17 deleteHistory 按 id / url 删除
 *   R3-18 clearHistory 清空 + removeItem
 *   R3-19 toggleBookmark 添加 / 取消 / 非法
 *   R3-20 removeBookmark 删除
 *   R3-21 isBookmarked 判定
 *   R3-22 身份隔离：A 迟到回调不得写 B key（T-X06）
 *   R3-23 身份隔离：authEpoch ABA 迟到回调丢弃（14-03）
 *   R3-24 身份隔离：渲染期切换 owner 清空内存态
 *   R3-25 纯函数直接单元测试（补充，不替代 Hook 层等价验证）
 *   R3-26 结构性委托证据
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p13r3/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__browser__useBrowserHistory.js':
    '7f72d99b035e1f92227cb8349089f66c1221d130b2362bde19e7deaac5f5828d',
};

test('P13R3-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 p13r0 / p13r1 / p13r2 测试同构，独立复制以保持自包含）
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
//   mode = 'after'  → 使用当前真实源码（解耦后，含 historyDataLogic.ts）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p13r3-${mode}-`));
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

  // AsyncStorage stub：内存 Map + 写入日志
  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
globalThis.__AS_LOG__ = [];
const api = {
  __store: store,
  async getItem(k){ return store.has(k) ? store.get(k) : null; },
  async setItem(k,v){ store.set(k, String(v)); globalThis.__AS_LOG__.push({ op: 'set', k, v: String(v) }); },
  async removeItem(k){ store.delete(k); globalThis.__AS_LOG__.push({ op: 'remove', k }); },
  async multiSet(pairs){ for (const [k,v] of pairs) { store.set(k, String(v)); globalThis.__AS_LOG__.push({ op: 'multiSet', k, v: String(v) }); } },
  async multiRemove(keys){ for (const k of keys) { store.delete(k); globalThis.__AS_LOG__.push({ op: 'multiRemove', k }); } },
  async getAllKeys(){ return [...store.keys()]; },
  async clear(){ store.clear(); },
};
export default api;
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
      path.join(beforeDir, 'hooks__browser__useBrowserHistory.js'),
      'src/hooks/browser/useBrowserHistory.js'
    );
  } else {
    // P1.4 R1：useBrowserHistory 已迁移为 .ts，after 沙箱必须复制迁移后的真实源码，
    // 并以 .ts 落盘（Node 24 原生类型擦除执行），确保执行的是迁移后实现而非旧 JS。
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/useBrowserHistory.ts'),
      'src/hooks/browser/useBrowserHistory.ts'
    );
    copyFile(
      path.join(repoRoot, 'src/hooks/browser/historyDataLogic.ts'),
      'src/hooks/browser/historyDataLogic.ts'
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
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory');
const { buildBrowserHistoryKey, buildBrowserBookmarksKey } = await import('./src/constants/browser/index.ts');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const rt = createHookRuntime();
let api = null;
const Comp = () => {
  api = useBrowserHistory(globalThis.__UID__ ?? null, globalThis.__EPOCH__ ?? 0);
  return null;
};

// 等待异步 effect（AsyncStorage 读写）落定。
// ⚠️ 异步 effect 内 setState 会 scheduleRender，但 settle() 是同步的；
//    因此 sleep 结束后必须再 settle 一次，让异步写入触发的重渲染真正提交，
//    否则 api 仍持有旧闭包，读到的是过期 state（测试假失败）。
const sleep = async (ms) => {
  await new Promise((r) => setTimeout(r, ms));
  rt.settle();
};

// ⚠️ 归一化非确定性字段：历史条目的 id / timestamp 由 Date.now() + Math.random()
//    生成，新旧两次执行必然不同。等价性只比较**确定性可观测字段**：
//    url / title / 顺序 / 条数 / 写入 key / 写入次数 / 身份隔离结果。
//    这里把 id 与 timestamp 替换为占位符，避免把随机值误判为行为差异。
const __normEntry = (it) => ({ id: '<id>', url: it.url, title: it.title, timestamp: '<ts>' });
const __normStored = (raw) => {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.map((it) => (it && typeof it === 'object' && 'timestamp' in it ? __normEntry(it) : it)));
    }
    return raw;
  } catch (_) {
    return raw;
  }
};

function snapshot() {
  const storeDump = {};
  for (const [k, v] of AS.__store) storeDump[k] = __normStored(v);
  return {
    historyList: api ? api.historyList.map(__normEntry) : null,
    bookmarksList: api ? api.bookmarksList.map((it) => ({ url: it.url, title: it.title })) : null,
    apiKeys: api ? Object.keys(api).sort() : null,
    asLog: globalThis.__AS_LOG__.map((o) => (o.v !== undefined ? { op: o.op, k: o.k, v: __normStored(o.v) } : o)),
    storeDump,
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
// R3-1 — 初始状态（无 owner：不读不写）
// ===========================================================================
test('P13R3-1 初始状态（无 owner 不读写）', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = null;
rt.render(Comp);
rt.settle();
await sleep(20);
`,
    'R3-1 初始状态'
  );
  assert.deepEqual(snap.historyList, [], '无 owner 历史为空');
  assert.deepEqual(snap.bookmarksList, [], '无 owner 书签为空');
  assert.deepEqual(snap.asLog, [], '无 owner 不得读写任何存储');
});

// ===========================================================================
// R3-2 — 公开接口键集合不变
// ===========================================================================
test('P13R3-2 公开接口键集合不变', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
`,
    'R3-2 接口形状'
  );
  assert.deepEqual(snap.apiKeys, [
    'addHistory',
    'bookmarksList',
    'clearHistory',
    'deleteHistory',
    'historyList',
    'isBookmarked',
    'removeBookmark',
    'toggleBookmark',
  ], '返回对象键集合必须与解耦前一致');
});

// ===========================================================================
// R3-3 — 首次加载落默认书签 + seed 版本
// ===========================================================================
test('P13R3-3 首次加载落默认书签 + seed 版本', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-3 首次默认书签'
  );
  assert.equal(snap.bookmarksList.length, 6, '首次应落 6 个默认书签');
  assert.equal(snap.bookmarksList[0].url, 'https://www.bing.com', '首个默认书签为 Bing');
  // ⚠️ multiSet 桩对每个 [key,value] pair 各记一条日志；
  //    首次落盘是一次 multiSet 调用写入「书签 key + seed key」两个 pair，
  //    因此日志为 2 条、去重后恰为 2 个不同 key。断言写入的 key 集合而非调用次数。
  const setOps = snap.asLog.filter((o) => o.op === 'multiSet');
  const setKeys = [...new Set(setOps.map((o) => o.k))].sort();
  assert.deepEqual(
    setKeys,
    ['@sync_browser_bookmarks_seed_v2_user-a', '@sync_browser_bookmarks_v2_user-a'],
    '首次应一次 multiSet 写入书签 key + seed key'
  );
  assert.equal(setOps.length, 2, 'multiSet 应写入 2 个 pair（书签 + seed）');
});

// ===========================================================================
// R3-4 — 已有缓存 + seed 最新 → 原样读取
// ===========================================================================
test('P13R3-4 已有缓存 + seed 最新 → 原样读取', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const bk = buildBrowserBookmarksKey('user-a');
const sk = '@sync_browser_bookmarks_seed_v2_user-a';
await AS.setItem(bk, JSON.stringify([{ url: 'https://mine.example.com', title: 'Mine' }]));
await AS.setItem(sk, '2');
globalThis.__AS_LOG__ = [];
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-4 原样读取'
  );
  assert.deepEqual(snap.bookmarksList, [{ url: 'https://mine.example.com', title: 'Mine' }], '应原样读取缓存');
  assert.equal(snap.asLog.filter((o) => o.op === 'multiSet').length, 0, 'seed 最新时不应重写');
});

// ===========================================================================
// R3-5 — 旧版纯 URL 字符串缓存归一化
// ===========================================================================
test('P13R3-5 旧版纯 URL 字符串缓存归一化', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const bk = buildBrowserBookmarksKey('user-a');
const sk = '@sync_browser_bookmarks_seed_v2_user-a';
await AS.setItem(bk, JSON.stringify(['https://old.example.com']));
await AS.setItem(sk, '2');
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-5 字符串归一化'
  );
  assert.deepEqual(snap.bookmarksList, [{ url: 'https://old.example.com', title: '' }], '字符串应归一化为 {url,title:""}');
});

// ===========================================================================
// R3-6 — 书签按 url 去重（保留首次顺序）
// ===========================================================================
test('P13R3-6 书签按 url 去重（保留首次顺序）', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const bk = buildBrowserBookmarksKey('user-a');
const sk = '@sync_browser_bookmarks_seed_v2_user-a';
await AS.setItem(bk, JSON.stringify([
  { url: 'https://a.example.com', title: 'A' },
  { url: 'https://b.example.com', title: 'B' },
  { url: 'https://a.example.com', title: 'A2' },
]));
await AS.setItem(sk, '2');
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-6 去重'
  );
  assert.deepEqual(snap.bookmarksList, [
    { url: 'https://a.example.com', title: 'A' },
    { url: 'https://b.example.com', title: 'B' },
  ], '重复 url 只保留首次出现');
});

// ===========================================================================
// R3-7 — 非法书签条目丢弃
// ===========================================================================
test('P13R3-7 非法书签条目丢弃', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const bk = buildBrowserBookmarksKey('user-a');
const sk = '@sync_browser_bookmarks_seed_v2_user-a';
await AS.setItem(bk, JSON.stringify([
  { url: 'http://insecure.example.com', title: 'Bad' },
  { url: 'https://ok.example.com', title: '  Trim Me  ' },
  null,
  42,
  { title: 'no url' },
]));
await AS.setItem(sk, '2');
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-7 非法丢弃'
  );
  assert.deepEqual(snap.bookmarksList, [{ url: 'https://ok.example.com', title: 'Trim Me' }], '仅保留合法 https 条目且 title trim');
});

// ===========================================================================
// R3-8 — seed 版本落后 → 剔除旧默认 + 前置新默认 + 去重
// ===========================================================================
test('P13R3-8 seed 版本落后 → 迁移', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const bk = buildBrowserBookmarksKey('user-a');
const sk = '@sync_browser_bookmarks_seed_v2_user-a';
const legacy = 'https://' + ['nnyy','in'].join('.') + '/';
await AS.setItem(bk, JSON.stringify([
  { url: legacy, title: 'Legacy' },
  { url: 'https://mine.example.com', title: 'Mine' },
]));
await AS.setItem(sk, '1');
globalThis.__AS_LOG__ = [];
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-8 种子迁移'
  );
  assert.equal(snap.bookmarksList.length, 7, '6 默认 + 1 用户自建（旧默认被剔除）');
  assert.equal(snap.bookmarksList[0].url, 'https://www.bing.com', '新默认前置');
  assert.ok(
    snap.bookmarksList.some((b) => b.url === 'https://mine.example.com'),
    '用户自建书签保留'
  );
  assert.ok(
    !snap.bookmarksList.some((b) => b.url.includes('nnyy')),
    '旧默认书签被剔除'
  );
  // 同 R3-3：一次 multiSet 调用写入「书签 key + seed key」两个 pair → 2 条日志。
  const migOps = snap.asLog.filter((o) => o.op === 'multiSet');
  const migKeys = [...new Set(migOps.map((o) => o.k))].sort();
  assert.deepEqual(
    migKeys,
    ['@sync_browser_bookmarks_seed_v2_user-a', '@sync_browser_bookmarks_v2_user-a'],
    '迁移后应一次 multiSet 写入书签 key + seed key'
  );
  assert.equal(migOps.length, 2, '迁移落盘应写入 2 个 pair（书签 + seed）');
});

// ===========================================================================
// R3-9 — 历史读取脏数据过滤 + 上限截断
// ===========================================================================
test('P13R3-9 历史读取脏数据过滤 + 上限截断', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const hk = buildBrowserHistoryKey('user-a');
const many = [];
for (let i = 0; i < 120; i++) many.push({ id: 'h' + i, url: 'https://site' + i + '.example.com', title: 'T' + i, timestamp: i });
many.push({ id: 'bad1', url: 'http://insecure.example.com', title: 'Bad', timestamp: 999 });
many.push({ id: 'bad2', title: 'no url', timestamp: 999 });
many.push(null);
await AS.setItem(hk, JSON.stringify(many));
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-9 历史过滤截断'
  );
  assert.equal(snap.historyList.length, 100, '上限 100 条');
  assert.ok(!snap.historyList.some((h) => h.url.startsWith('http://')), '非 https 被过滤');
  assert.equal(snap.historyList[0].url, 'https://site0.example.com', '保留原始顺序');
});

// ===========================================================================
// R3-10 — 历史读取非数组 → 丢弃
// ===========================================================================
test('P13R3-10 历史读取非数组 → 丢弃', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const hk = buildBrowserHistoryKey('user-a');
await AS.setItem(hk, JSON.stringify({ not: 'array' }));
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-10 非数组'
  );
  assert.deepEqual(snap.historyList, [], '非数组缓存应被丢弃');
});

// ===========================================================================
// R3-11 — 历史读取非法 JSON → 丢弃（不抛）
// ===========================================================================
test('P13R3-11 历史读取非法 JSON → 丢弃', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
const hk = buildBrowserHistoryKey('user-a');
await AS.setItem(hk, '{not valid json');
rt.render(Comp);
rt.settle();
await sleep(30);
`,
    'R3-11 非法 JSON'
  );
  assert.deepEqual(snap.historyList, [], '非法 JSON 应被 catch 丢弃');
});

// ===========================================================================
// R3-12 — addHistory 正常写入（去重 + 置顶）
// ===========================================================================
test('P13R3-12 addHistory 正常写入（去重 + 置顶）', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://one.example.com', 'One');
rt.settle();
api.addHistory('https://two.example.com', 'Two');
rt.settle();
api.addHistory('https://one.example.com', 'One Again');
rt.settle();
await sleep(20);
`,
    'R3-12 addHistory 去重置顶'
  );
  assert.equal(snap.historyList.length, 2, '同 url 去重后 2 条');
  assert.equal(snap.historyList[0].url, 'https://one.example.com', '最新一条置顶');
  assert.equal(snap.historyList[0].title, 'One Again', '标题更新为最新');
  assert.equal(snap.historyList[1].url, 'https://two.example.com', '旧条目保留');
});

// ===========================================================================
// R3-13 — addHistory 同一页面重复回调跳过
// ===========================================================================
test('P13R3-13 addHistory 同一页面重复回调跳过', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://same.example.com', 'Same');
rt.settle();
const lenAfterFirst = api.historyList.length;
api.addHistory('https://same.example.com', 'Same');
rt.settle();
globalThis.__PROBE__ = { lenAfterFirst, lenAfterSecond: api.historyList.length };
await sleep(20);
`,
    'R3-13 重复回调跳过'
  );
  assert.equal(snap.probe.lenAfterFirst, 1, '首次写入 1 条');
  assert.equal(snap.probe.lenAfterSecond, 1, '同一页面重复回调不新增');
});

// ===========================================================================
// R3-14 — addHistory 非安全 URL 不写
// ===========================================================================
test('P13R3-14 addHistory 非安全 URL 不写', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('http://insecure.example.com', 'Bad');
api.addHistory('javascript:alert(1)', 'Bad2');
rt.settle();
await sleep(20);
`,
    'R3-14 非安全不写'
  );
  assert.deepEqual(snap.historyList, [], '非 https URL 不得写入');
});

// ===========================================================================
// R3-15 — addHistory cn.bing.com/search 不写
// ===========================================================================
test('P13R3-15 addHistory cn.bing.com/search 不写', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://cn.bing.com/search?q=test', 'Search');
rt.settle();
await sleep(20);
`,
    'R3-15 搜索页不写'
  );
  assert.deepEqual(snap.historyList, [], 'cn.bing.com/search 不得写入');
});

// ===========================================================================
// R3-16 — addHistory 上限 100 截断
// ===========================================================================
test('P13R3-16 addHistory 上限 100 截断', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
for (let i = 0; i < 105; i++) {
  api.addHistory('https://s' + i + '.example.com', 'S' + i);
  rt.settle();
}
await sleep(20);
`,
    'R3-16 上限截断'
  );
  assert.equal(snap.historyList.length, 100, '历史上限 100 条');
  assert.equal(snap.historyList[0].url, 'https://s104.example.com', '最新一条置顶');
});

// ===========================================================================
// R3-17 — deleteHistory 按 id / url 删除
// ===========================================================================
test('P13R3-17 deleteHistory 按 id / url 删除', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://a.example.com', 'A');
rt.settle();
api.addHistory('https://b.example.com', 'B');
rt.settle();
const idA = api.historyList.find((h) => h.url === 'https://a.example.com').id;
api.deleteHistory(idA);
rt.settle();
const afterIdDelete = api.historyList.map((h) => h.url);
api.deleteHistory('https://b.example.com');
rt.settle();
globalThis.__PROBE__ = { afterIdDelete, afterUrlDelete: api.historyList.map((h) => h.url) };
await sleep(20);
`,
    'R3-17 deleteHistory'
  );
  assert.deepEqual(snap.probe.afterIdDelete, ['https://b.example.com'], '按 id 删除 A');
  assert.deepEqual(snap.probe.afterUrlDelete, [], '按 url 删除 B');
});

// ===========================================================================
// R3-18 — clearHistory 清空 + removeItem
// ===========================================================================
test('P13R3-18 clearHistory 清空 + removeItem', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://a.example.com', 'A');
rt.settle();
await sleep(10);
globalThis.__AS_LOG__ = [];
api.clearHistory();
rt.settle();
await sleep(20);
`,
    'R3-18 clearHistory'
  );
  assert.deepEqual(snap.historyList, [], '清空后历史为空');
  assert.equal(snap.asLog.filter((o) => o.op === 'remove').length, 1, '清空应 removeItem 一次');
});

// ===========================================================================
// R3-19 — toggleBookmark 添加 / 取消 / 非法
// ===========================================================================
test('P13R3-19 toggleBookmark 添加 / 取消 / 非法', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(30);
const r1 = await api.toggleBookmark('https://fav.example.com', 'Fav');
rt.settle();
const afterAdd = api.bookmarksList.map((b) => b.url);
const r2 = await api.toggleBookmark('https://fav.example.com', 'Fav');
rt.settle();
const afterRemove = api.bookmarksList.map((b) => b.url);
const r3 = await api.toggleBookmark('http://insecure.example.com', 'Bad');
globalThis.__PROBE__ = { r1, r2, r3, afterAdd, afterRemove };
await sleep(20);
`,
    'R3-19 toggleBookmark'
  );
  assert.deepEqual(snap.probe.r1, { ok: true, action: 'added' }, '首次收藏 added');
  assert.deepEqual(snap.probe.r2, { ok: true, action: 'removed' }, '再次取消 removed');
  assert.deepEqual(snap.probe.r3, { ok: false, action: 'invalid' }, '非安全 URL invalid');
  assert.ok(snap.probe.afterAdd.includes('https://fav.example.com'), '收藏后列表含该 url');
  assert.ok(!snap.probe.afterRemove.includes('https://fav.example.com'), '取消后列表不含该 url');
});

// ===========================================================================
// R3-20 — removeBookmark 删除
// ===========================================================================
test('P13R3-20 removeBookmark 删除', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(30);
await api.toggleBookmark('https://fav.example.com', 'Fav');
rt.settle();
await api.removeBookmark('https://fav.example.com');
rt.settle();
globalThis.__PROBE__ = { urls: api.bookmarksList.map((b) => b.url) };
await sleep(20);
`,
    'R3-20 removeBookmark'
  );
  assert.ok(!snap.probe.urls.includes('https://fav.example.com'), 'removeBookmark 后不含该 url');
});

// ===========================================================================
// R3-21 — isBookmarked 判定
// ===========================================================================
test('P13R3-21 isBookmarked 判定', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(30);
await api.toggleBookmark('https://fav.example.com', 'Fav');
rt.settle();
globalThis.__PROBE__ = {
  hit: api.isBookmarked('https://fav.example.com'),
  miss: api.isBookmarked('https://other.example.com'),
  empty: api.isBookmarked(''),
};
await sleep(20);
`,
    'R3-21 isBookmarked'
  );
  assert.equal(snap.probe.hit, true, '已收藏返回 true');
  assert.equal(snap.probe.miss, false, '未收藏返回 false');
  assert.equal(snap.probe.empty, false, '空 url 返回 false');
});

// ===========================================================================
// R3-22 — 身份隔离：A 迟到回调不得写 B key（T-X06）
// ===========================================================================
test('P13R3-22 A 迟到回调不得写 B key', () => {
  const snap = assertEquivalent(
    `
const A = 'user-aaa', B = 'user-bbb';
const hB = buildBrowserHistoryKey(B);
await AS.setItem(hB, JSON.stringify([{ id: 'b1', url: 'https://b.example.com', title: 'B', timestamp: 1 }]));

globalThis.__UID__ = A;
rt.render(Comp);
rt.settle();
await sleep(20);
const addHistoryA = api.addHistory;

globalThis.__UID__ = B;
rt.render(Comp);
rt.settle();
await sleep(20);

addHistoryA('https://a-late.example.com', 'A-late');
rt.settle();
await sleep(20);

const bHistory = JSON.parse(await AS.getItem(hB));
globalThis.__PROBE__ = { bUrls: bHistory.map((it) => it.url) };
`,
    'R3-22 T-X06'
  );
  assert.ok(!snap.probe.bUrls.includes('https://a-late.example.com'), 'A 迟到回调不得写 B key');
  assert.ok(snap.probe.bUrls.includes('https://b.example.com'), 'B 自身记录保留');
});

// ===========================================================================
// R3-23 — 身份隔离：authEpoch ABA 迟到回调丢弃（14-03）
// ===========================================================================
test('P13R3-23 authEpoch ABA 迟到回调丢弃', () => {
  const snap = assertEquivalent(
    `
const A = 'user-aaa';
const hA = buildBrowserHistoryKey(A);

globalThis.__UID__ = A;
globalThis.__EPOCH__ = 1;
rt.render(Comp);
rt.settle();
await sleep(20);
const addHistoryEpoch1 = api.addHistory;

// 模拟 A→登出→A：同 userId，但 authEpoch 推进到 2
globalThis.__EPOCH__ = 2;
rt.render(Comp);
rt.settle();
await sleep(20);

// epoch=1 的旧回调此刻才执行
addHistoryEpoch1('https://stale.example.com', 'Stale');
rt.settle();
await sleep(20);

const stored = await AS.getItem(hA);
const urls = stored ? JSON.parse(stored).map((it) => it.url) : [];
globalThis.__PROBE__ = { urls };
`,
    'R3-23 authEpoch ABA'
  );
  assert.ok(!snap.probe.urls.includes('https://stale.example.com'), '旧 epoch 回调不得写入');
});

// ===========================================================================
// R3-24 — 身份隔离：渲染期切换 owner 清空内存态
// ===========================================================================
test('P13R3-24 渲染期切换 owner 清空内存态', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://a.example.com', 'A');
rt.settle();
await sleep(20);
const beforeSwitch = api.historyList.map((h) => h.url);

// 切到 B（B 无缓存）
globalThis.__UID__ = 'user-b';
rt.render(Comp);
rt.settle();
const immediatelyAfterSwitch = api.historyList.map((h) => h.url);
await sleep(30);
globalThis.__PROBE__ = { beforeSwitch, immediatelyAfterSwitch, afterLoad: api.historyList.map((h) => h.url) };
`,
    'R3-24 切换清空'
  );
  assert.deepEqual(snap.probe.beforeSwitch, ['https://a.example.com'], 'A 身份下有 A 的记录');
  assert.deepEqual(snap.probe.immediatelyAfterSwitch, [], '切换 B 后内存态立即清空');
  assert.deepEqual(snap.probe.afterLoad, [], 'B 无缓存，加载后仍为空');
});

// ===========================================================================
// R3-25 — 纯函数直接单元测试（补充，不替代 Hook 层等价验证）
// ===========================================================================
test('P13R3-25 纯函数直接单元测试（真实执行 historyDataLogic.ts）', async () => {
  // 探针在隔离沙箱中**真实导入并执行** historyDataLogic.ts，返回真实函数输出。
  const mod = await import('../fixtures/p13r3/pureLogicProbe.mjs');
  const out = mod.runPureLogicProbe();
  assert.deepEqual(out.normalizeString, { url: 'https://x.example.com', title: '' }, '字符串归一化');
  assert.equal(out.normalizeInsecure, null, '非安全 URL → null');
  assert.equal(out.normalizeNonObject, null, '非对象 → null');
  assert.deepEqual(out.normalizeTrim, { url: 'https://y.example.com', title: 'T' }, 'title trim');
  assert.deepEqual(out.normalizeListDedup, [
    { url: 'https://a.example.com', title: 'A' },
    { url: 'https://b.example.com', title: 'B' },
  ], '批量去重保留首次');
  assert.deepEqual(out.normalizeListNonArray, [], '非数组 → []');
  assert.equal(out.cleanHistory.length, 2, '脏数据过滤后 2 条');
  assert.deepEqual(out.mergeSkip, { skip: true }, '同页面重复 → skip');
  assert.equal(out.mergeNext.length, 2, '合并后 2 条');
  assert.equal(out.mergeNext[0].url, 'https://new.example.com', '新条目置顶');
  // buildHistoryEntry 真实执行：timestampProvider 必须被调用一次，且返回值进入 timestamp
  assert.equal(out.buildEntry.providerCalls, 1, 'timestampProvider 应被调用一次');
  assert.equal(out.buildEntry.entry.timestamp, 4242, 'timestamp 来自 provider 返回值');
  assert.equal(out.buildEntry.entry.id, 'id-123', 'id 原样保留');
  assert.equal(out.buildEntry.entry.title, 'Build Title', '标题经 buildHistoryTitle 归一化');
});

// ===========================================================================
// R3-26 — 结构性委托证据
// ===========================================================================
test('P13R3-26 结构性委托证据（Hook 已委托纯函数模块）', () => {
  // P1.4 R1：Hook 已迁移为 .ts，结构性委托证据读取迁移后真实源码。
  const hookSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/useBrowserHistory.ts'),
    'utf8'
  );
  assert.ok(
    /from '\.\/historyDataLogic'/.test(hookSrc),
    'Hook 必须从 ./historyDataLogic 导入纯函数'
  );
  for (const fn of [
    'normalizeBookmark',
    'normalizeBookmarkList',
    'cleanHistoryList',
    'buildHistoryEntry',
    'mergeHistoryEntry',
  ]) {
    assert.ok(
      new RegExp(`\\b${fn}\\b`).test(hookSrc),
      `Hook 必须引用 ${fn}`
    );
  }
  // 解耦后 Hook 内不得再定义 normalizeBookmark 的旧内联实现
  assert.ok(
    !/const normalizeBookmark = \(item\) =>/.test(hookSrc),
    'Hook 内不得再保留 normalizeBookmark 内联定义'
  );
  assert.ok(
    !/const normalizeBookmarkList = \(list\) =>/.test(hookSrc),
    'Hook 内不得再保留 normalizeBookmarkList 内联定义'
  );

  // 纯函数模块不得依赖 React / AsyncStorage
  const logicSrc = fs.readFileSync(
    path.join(repoRoot, 'src/hooks/browser/historyDataLogic.ts'),
    'utf8'
  );
  assert.ok(!/from 'react'/.test(logicSrc), '纯函数模块不得依赖 react');
  assert.ok(!/async-storage/.test(logicSrc), '纯函数模块不得依赖 AsyncStorage');
  assert.ok(!/\buseState\b|\buseRef\b|\buseEffect\b/.test(logicSrc), '纯函数模块不得使用 Hook');
});
// --- END OF FILE tests/security/p13r3DecouplingEquivalence.test.mjs ---