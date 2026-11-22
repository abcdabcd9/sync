// --- START OF FILE tests/security/p13r3TimestampOrder.test.mjs ---
/**
 * P1.3 R3-FIX — 历史条目构造「求值顺序」真实时序等价测试
 *
 * 背景（GPT Gatekeeper 复现的真实行为差异）：
 *   原 JS `addHistory` 使用对象字面量：
 *     { id: `${Date.now()}-${Math.random()...}`, url,
 *       title: buildHistoryTitle(title, url), timestamp: Date.now() }
 *   求值顺序为：ID（Date.now #1 + Math.random）→ url → 标题 → timestamp（Date.now #2）。
 *
 *   R3 初版把 timestamp 提前求值后作为参数传入 buildHistoryEntry，
 *   导致 timestamp 采样时机早于标题解析 —— 真实持久化行为差异。
 *
 * 本测试：
 *   · 在隔离沙箱中注入**受控时间源**（Date.now 按脚本推进、Math.random 固定），
 *   · 记录 Date.now / Math.random 的**调用次数与顺序**，
 *   · 分别真实执行冻结旧 Hook 与修复后 Hook，
 *   · 比较完整 id / title / timestamp / AsyncStorage 原始 JSON / 调用次数 / 调用顺序。
 *
 * ⚠️ 本测试**不**将 id / timestamp 归一化为占位符 —— 正是要证明它们逐字节一致。
 *
 * 覆盖场景：
 *   T1 无页面标题 → 回退域名
 *   T2 有有效页面标题
 *   T3 同一 URL 重复回调跳过
 *   T4 无效 URL 直接拒绝
 *   T5 旧 owner / epoch 回调拒绝
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

// 冻结基线完整性（与主 R3 测试同一 SHA，防止被篡改）
const EXPECTED_SHA =
  '7f72d99b035e1f92227cb8349089f66c1221d130b2362bde19e7deaac5f5828d';

test('P13R3-TS-0 冻结基线完整性（SHA-256 未被篡改）', () => {
  const p = path.join(beforeDir, 'hooks__browser__useBrowserHistory.js');
  const actual = spawnSync('shasum', ['-a', '256', p], { encoding: 'utf8' })
    .stdout.trim()
    .split(/\s+/)[0];
  assert.equal(actual, EXPECTED_SHA, '冻结基线被修改');
});

// ---------------------------------------------------------------------------
// 极简 Hook 运行时（与主 R3 测试同构，独立复制保持自包含）
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
  function ensureSlot(i) { if (!hooks[i]) hooks[i] = { kind: null }; return hooks[i]; }
  function useState(init) {
    const i = cursor++; const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'state'; slot.value = typeof init === 'function' ? init() : init; }
    const setter = (next) => {
      const resolved = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(resolved, slot.value)) return;
      slot.value = resolved; scheduleRender();
    };
    return [slot.value, setter];
  }
  function useRef(initial) {
    const i = cursor++; const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'ref'; slot.ref = { current: initial }; }
    return slot.ref;
  }
  function useEffect(fn, deps) {
    const i = cursor++; const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'effect'; slot.deps = deps; slot.cleanup = undefined; pendingEffects.push({ index: i, fn }); }
    else if (deps === undefined || !shallowEqual(slot.deps, deps)) { slot.deps = deps; pendingEffects.push({ index: i, fn }); }
  }
  function useCallback(fn, deps) {
    const i = cursor++; const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'callback'; slot.fn = fn; slot.deps = deps; return fn; }
    if (deps === undefined || !shallowEqual(slot.deps, deps)) { slot.fn = fn; slot.deps = deps; }
    return slot.fn;
  }
  function useMemo(fn, deps) {
    const i = cursor++; const slot = ensureSlot(i);
    if (slot.kind === null) { slot.kind = 'memo'; slot.value = fn(); slot.deps = deps; return slot.value; }
    if (deps === undefined || !shallowEqual(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; }
    return slot.value;
  }
  function useContext() { return {}; }
  function createContext(v) { return { __ctx: v }; }
  function scheduleRender() { scheduled = true; }
  function runPendingEffects() {
    const toRun = pendingEffects; pendingEffects = [];
    for (const { index, fn } of toRun) {
      const slot = hooks[index];
      if (slot.cleanup) { try { slot.cleanup(); } catch (_) {} slot.cleanup = undefined; }
      const ret = fn(); if (typeof ret === 'function') slot.cleanup = ret;
    }
  }
  function render(fn) { componentFn = fn; cursor = 0; scheduled = false; const out = fn(); runPendingEffects(); return out; }
  function rerender() { if (!componentFn) throw new Error('rerender before render'); cursor = 0; scheduled = false; const out = componentFn(); runPendingEffects(); return out; }
  function flushEffects() { runPendingEffects(); }
  function settle(maxRounds = 20) { let r = 0; while (scheduled && r < maxRounds) { rerender(); r += 1; } return r; }
  function unmount() { for (const s of hooks) { if (s && s.cleanup) { try { s.cleanup(); } catch (_) {} s.cleanup = undefined; } } componentFn = null; }
  return { useState, useRef, useEffect, useCallback, useMemo, useContext, createContext, render, rerender, flushEffects, settle, unmount };
}
`;

function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p13r3ts-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
${HOOK_RUNTIME_SRC}
let __singleton = null;
export function createHookRuntime() { if (!__singleton) __singleton = __createHookRuntime(); return __singleton; }
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
  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(relSrc, dst);
  };
  copyFile(path.join(repoRoot, 'src/constants/browser/index.ts'), 'src/constants/browser/index.ts');
  if (mode === 'before') {
    copyFile(path.join(beforeDir, 'hooks__browser__useBrowserHistory.js'), 'src/hooks/browser/useBrowserHistory.js');
  } else {
    // P1.4 R1：useBrowserHistory 已迁移为 .ts，after 沙箱复制迁移后真实源码并以 .ts 落盘。
    copyFile(path.join(repoRoot, 'src/hooks/browser/useBrowserHistory.ts'), 'src/hooks/browser/useBrowserHistory.ts');
    copyFile(path.join(repoRoot, 'src/hooks/browser/historyDataLogic.ts'), 'src/hooks/browser/historyDataLogic.ts');
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
// 受控时间源前置：注入 Date.now / Math.random，记录调用顺序
//   · Date.now 按 __CLOCK__ 数组依次返回（耗尽后返回最后一个）
//   · Math.random 固定返回 __RANDOM__
//   · 每次调用 push 到 __CALLS__（'now' / 'random'）
// ---------------------------------------------------------------------------
const CONTROLLED_CLOCK_PRELUDE = `
// 注意：__CLOCK__ / __RANDOM__ 由场景体在 prelude 之后设置，
// 因此必须在函数内部惰性读取 globalThis，不能在 prelude 顶层捕获。
globalThis.__CALLS__ = [];
globalThis.__clockIdx__ = 0;
Date.now = () => {
  globalThis.__CALLS__.push('now');
  const clock = globalThis.__CLOCK__ || [];
  const idx = globalThis.__clockIdx__;
  const v = idx < clock.length ? clock[idx] : clock[clock.length - 1];
  globalThis.__clockIdx__ = idx + 1;
  return v;
};
Math.random = () => { globalThis.__CALLS__.push('random'); return globalThis.__RANDOM__; };
`;

const SCENARIO_PRELUDE = `
const { createHookRuntime } = await import('react');
const { useBrowserHistory } = await import('./src/hooks/browser/useBrowserHistory');
const { buildBrowserHistoryKey } = await import('./src/constants/browser/index.ts');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const rt = createHookRuntime();
let api = null;
const Comp = () => {
  api = useBrowserHistory(globalThis.__UID__ ?? null, globalThis.__EPOCH__ ?? 0);
  return null;
};
const sleep = async (ms) => { await new Promise((r) => setTimeout(r, ms)); rt.settle(); };

function snapshot() {
  const storeDump = {};
  for (const [k, v] of AS.__store) storeDump[k] = v; // 原始 JSON，不归一化
  return {
    historyList: api ? api.historyList : null, // 完整 id/title/timestamp
    asLog: globalThis.__AS_LOG__,
    storeDump,
    calls: globalThis.__CALLS__,
  };
}
`;

function runScenario(scenarioBody) {
  const body = `${CONTROLLED_CLOCK_PRELUDE}\n${SCENARIO_PRELUDE}\n${scenarioBody}\nprocess.stdout.write(JSON.stringify(snapshot()));`;
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

function assertEquivalent(scenarioBody, label) {
  const { before, after } = runScenario(scenarioBody);
  assert.deepEqual(after, before, `${label}：解耦后完整时序必须与解耦前逐项一致`);
  return before;
}

// ===========================================================================
// T1 — 无页面标题 → 回退域名（timestamp 在标题解析之后采样）
// ===========================================================================
test('P13R3-TS-1 无标题回退域名：ID→标题→timestamp 顺序一致', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
globalThis.__CLOCK__ = [1000, 1010]; // #1 id 时间部分=1000；#2 timestamp=1010
globalThis.__RANDOM__ = 0.123456;
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://example.com/path', '');
await sleep(10);
`,
    'T1 无标题回退'
  );
  // 完整字段逐字节一致（deepEqual 已保证 before==after）
  const e = snap.historyList[0];
  assert.equal(e.id, '1000-4fzyo8', 'ID 时间部分=1000 + 固定随机后缀');
  assert.equal(e.timestamp, 1010, 'timestamp 采样于标题解析之后（第二次 Date.now）');
  assert.equal(e.title, 'example.com', '无标题回退域名');
  // 调用顺序：now(id) → random → now(timestamp)
  assert.deepEqual(snap.calls, ['now', 'random', 'now'], 'Date.now/Math.random 调用顺序');
  // 存储原始 JSON 一致
  assert.ok(
    Object.values(snap.storeDump).some((v) => v.includes('"timestamp":1010')),
    '落盘 JSON 中 timestamp=1010'
  );
});

// ===========================================================================
// T2 — 有有效页面标题
// ===========================================================================
test('P13R3-TS-2 有效标题：ID→标题→timestamp 顺序一致', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
globalThis.__CLOCK__ = [2000, 2050];
globalThis.__RANDOM__ = 0.5;
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://news.example.com/a', '  Breaking News  ');
await sleep(10);
`,
    'T2 有效标题'
  );
  const e = snap.historyList[0];
  assert.equal(e.id, '2000-i', 'ID 时间部分=2000 + 固定随机后缀');
  assert.equal(e.timestamp, 2050, 'timestamp=第二次 Date.now');
  assert.equal(e.title, 'Breaking News', '标题 trim');
  assert.deepEqual(snap.calls, ['now', 'random', 'now'], '调用顺序一致');
});

// ===========================================================================
// T3 — 同一 URL 重复回调跳过（第二次不产生新条目、不写盘）
// ===========================================================================
test('P13R3-TS-3 同 URL 重复回调跳过：不重复采样/写盘', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
globalThis.__CLOCK__ = [3000, 3010, 3020, 3030];
globalThis.__RANDOM__ = 0.25;
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('https://dup.example.com', 'Dup');
await sleep(10);
api.addHistory('https://dup.example.com', 'Dup');
await sleep(10);
`,
    'T3 重复跳过'
  );
  assert.equal(snap.historyList.length, 1, '同 URL 只保留一条');
  // 第一次 addHistory 消耗 now+random+now；第二次因 prev[0].url 相同而提前 return，
  // 但注意：原实现是在构造 entry 之后才判断 skip，故第二次仍会采样 now+random+now。
  assert.deepEqual(snap.calls, ['now', 'random', 'now', 'now', 'random', 'now'], '两次回调均完整采样（与原实现一致）');
});

// ===========================================================================
// T4 — 无效 URL 直接拒绝（不采样、不写盘）
// ===========================================================================
test('P13R3-TS-4 无效 URL 拒绝：不采样不写盘', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
globalThis.__CLOCK__ = [4000, 4010];
globalThis.__RANDOM__ = 0.75;
rt.render(Comp);
rt.settle();
await sleep(20);
api.addHistory('http://insecure.example.com', 'Bad');
await sleep(10);
`,
    'T4 无效 URL'
  );
  assert.equal(snap.historyList.length, 0, '无效 URL 不写历史');
  assert.deepEqual(snap.calls, [], '无效 URL 不触发任何 Date.now/Math.random');
});

// ===========================================================================
// T5 — 旧 owner / epoch 回调拒绝（不采样、不写盘）
// ===========================================================================
test('P13R3-TS-5 旧 owner/epoch 回调拒绝：不采样不写盘', () => {
  const snap = assertEquivalent(
    `
globalThis.__UID__ = 'user-a';
globalThis.__EPOCH__ = 1;
globalThis.__CLOCK__ = [5000, 5010];
globalThis.__RANDOM__ = 0.1;
rt.render(Comp);
rt.settle();
await sleep(20);
const staleAdd = api.addHistory; // 捕获 A/epoch1 的回调
// 切换到 B（owner 变化）
globalThis.__UID__ = 'user-b';
globalThis.__EPOCH__ = 2;
rt.rerender();
rt.settle();
await sleep(10);
staleAdd('https://stale.example.com', 'Stale'); // 旧回调应被拒绝
await sleep(10);
`,
    'T5 旧回调拒绝'
  );
  // 旧回调被 owner/epoch 校验拦截，不产生历史、不采样
  assert.deepEqual(snap.calls, [], '旧回调不触发 Date.now/Math.random');
  // B 的历史为空（A 的迟到事件未写入）
  assert.equal(snap.historyList.length, 0, '旧回调不写入任何历史');
});
// --- END OF FILE tests/security/p13r3TimestampOrder.test.mjs ---
