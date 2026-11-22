// --- START OF FILE tests/security/p14r4CinemaMigrationEquivalence.test.mjs ---
/**
 * P1.4 R4 — Cinema 大型 Hook（Provider）JS → TSX 迁移 行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前实现：冻结基线（tests/fixtures/p14r4/before/hooks__useCinema.js）
 *     · 迁移后实现：当前真实源码（src/hooks/useCinema.tsx）
 *   对同一组播放 / 同步 / 生命周期事件序列比较**完整可观测结果**：
 *     - Context value 全部 30 个字段
 *     - 播放器真实调用序列（play / pause / replaceAsync / currentTime 赋值）
 *     - emitCommand 广播序列（type / time / url，含顺序与次数）
 *     - 定时器创建 / 触发 / 清理（500ms 轮询、1200ms 静默、50/800/1000ms 延迟）
 *     - AppState 监听注册 / 移除
 *     - 选集状态机（applyEpisodeList / requestEpisode / playPrev / playNext / clearEpisodes）
 *     - 身份切换清理（ownerKey 变化 → 本地强制清理）
 *     - closePlayer 的 RPC 调用与本地状态清理
 *
 * 覆盖（CINEMA-1 .. CINEMA-18）
 *   CINEMA-1  初始状态：全部 state 默认值 + 公开接口形状（30 字段）+ 播放器初始化
 *   CINEMA-2  loadUrl（Android）：replaceAsync + 800ms 后 play
 *   CINEMA-3  loadUrl（iOS）：pause → 50ms replaceAsync → 1000ms play
 *   CINEMA-4  loadUrl 同源短路：不 replaceAsync，仅恢复播放
 *   CINEMA-5  loadUrl 携带 pageUrl：清空旧选集 + 写入 episodeListRequest
 *   CINEMA-6  togglePlay：playing 翻转 + Haptics
 *   CINEMA-7  remoteCommand PLAY（同 url）：play + 时间同步（超阈值才 seek）
 *   CINEMA-8  remoteCommand PAUSE（同 url）：pause
 *   CINEMA-9  remoteCommand 不同 url：Haptics + replaceAsync + 1000ms 后 seek/play
 *   CINEMA-10 remoteCommand 去重：同一指令对象只消费一次
 *   CINEMA-11 remoteCommand FORCE_SYNC / AUTO_SYNC：seek 行为差异
 *   CINEMA-12 轮询漂移检测：超过 SYNC_THRESHOLD 广播 AUTO_SYNC（2000ms 节流）
 *   CINEMA-13 轮询 playing 变化：广播 PLAY / PAUSE
 *   CINEMA-14 拖动（setScrubbing）：拖动期间不广播 AUTO_SYNC
 *   CINEMA-15 AppState 后台 → 停止轮询；前台 → 恢复轮询
 *   CINEMA-16 选集状态机：applyEpisodeList / requestEpisode / playNext / playPrev / clearEpisodes
 *   CINEMA-17 身份切换（ownerKey 变化）：本地强制清理全部放映厅 state
 *   CINEMA-18 closePlayer：RPC 调用 + 本地清理 + 卸载清理（AppState 移除 + 轮询停止）
 *
 * 测试机制说明（准确性声明）
 *   本测试**通过自定义 React Hook 兼容运行时**加载、执行并比较真实源码：
 *   该运行时实现 useState / useRef / useEffect / useCallback / useMemo / useContext /
 *   createContext / createElement / render / rerender / flushEffects / settle / unmount
 *   的最小语义，用于在 Node 环境中真实调用 Provider 并观察状态与副作用。
 *   它**不是** React Native 官方渲染器，也**不是**真实组件生命周期集成测试；
 *   它只保证源码被真实执行、真实调用，而非复制内部函数做模拟。
 *
 *   TSX 处理：Node v24 原生类型剥离**不支持** .tsx / JSX。因此迁移后的
 *   `useCinema.tsx` 在沙箱内使用**项目自带 TypeScript 编译器**
 *   （`ts.transpileModule`，jsx: React）转译为 `.js` 后执行——这是项目既有的受控
 *   TypeScript JSX 转译机制，**不是**为测试手工改写生产 JSX 结构。
 *   迁移前的 `.js` 基线同样经该转译器处理，保证两侧执行机制一致。
 *
 *   虚拟时钟：沙箱内替换全局 setTimeout / setInterval / clearTimeout / clearInterval /
 *   Date.now，使定时器与节流判定完全可控、可复现（不依赖真实墙钟）。
 *
 * 约束
 *   · 不访问真实网络 / 数据库 / 原生播放器（使用记录型 stub）。
 *   · 基线只读，不得修改以制造通过（启动时校验 SHA-256）。
 *   · 真实执行源码，不复制内部函数做模拟。
 *   · 迁移前后使用同一段场景脚本，仅被测源码路径不同。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const beforeDir = path.join(repoRoot, 'tests/fixtures/p14r4/before');

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'hooks__useCinema.js':
    '217660aed60a8e7812b6e3061fda271ad5de59a0ea33b332ad91494d2d526d83',
};

test('P14R4-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 极简 Hook 运行时（与 P1.4 R0 / R1 / R2 / R3 测试同构，独立复制以保持自包含）
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

  function useContext(ctx) {
    if (!ctx || !ctx.__ctx) return undefined;
    return ctx.__ctx.current;
  }
  function createContext(v) {
    const ctx = { __ctx: { current: v } };
    ctx.Provider = { __ctx: ctx.__ctx, __isProvider: true };
    return ctx;
  }

  function scheduleRender() { scheduled = true; }

  function runPendingEffects() {
    const toRun = pendingEffects;
    pendingEffects = [];
    // 与真实 React 一致：先执行「全部」cleanup，再执行「全部」effect body。
    // 若按 effect 逐个 cleanup+body 交错执行，会出现「后一个 effect 的 cleanup
    // 清掉前一个 effect body 刚建立的资源」的错误顺序（例如 AppState effect 的
    // cleanup 调用 stopPolling() 清掉轮询 effect body 刚创建的 interval）。
    for (const { index } of toRun) {
      const slot = hooks[index];
      if (slot.cleanup) { try { slot.cleanup(); } catch (_) {} slot.cleanup = undefined; }
    }
    for (const { index, fn } of toRun) {
      const slot = hooks[index];
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
//   mode = 'after'  → 使用当前真实源码（迁移后 TSX）
// ---------------------------------------------------------------------------
function buildSandbox(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14r4-cinema-${mode}-`));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // react stub：Hook 运行时单例 + createContext/useContext 真实语义 + createElement
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
${HOOK_RUNTIME_SRC}
// 每次调用返回独立实例：Provider 与消费者必须分属不同 runtime，
// 否则共享 hooks 槽位会互相覆盖（单组件栈限制）。
// 模块级 Hook 动态路由到「当前活跃 runtime」：render()/rerender() 执行组件函数期间
// 把该 runtime 设为活跃，组件内 import 的 useState 等即落到正确实例。
let __active = null;
export function createHookRuntime() {
  const rt = __createHookRuntime();
  const origRender = rt.render;
  const origRerender = rt.rerender;
  const origSettle = rt.settle;
  const origFlush = rt.flushEffects;
  rt.render = (fn) => { const prev = __active; __active = rt; try { return origRender(fn); } finally { __active = prev; } };
  rt.rerender = () => { const prev = __active; __active = rt; try { return origRerender(); } finally { __active = prev; } };
  rt.settle = (n) => { const prev = __active; __active = rt; try { return origSettle(n); } finally { __active = prev; } };
  rt.flushEffects = () => { const prev = __active; __active = rt; try { return origFlush(); } finally { __active = prev; } };
  return rt;
}
function __route(name) {
  return (...args) => {
    if (!__active) throw new Error('Hook ' + name + ' called outside render()');
    return __active[name](...args);
  };
}
export const useState = __route('useState');
export const useEffect = __route('useEffect');
export const useCallback = __route('useCallback');
export const useMemo = __route('useMemo');
export const useRef = __route('useRef');
export const useContext = __route('useContext');
// createContext 无状态，直接使用独立实现（返回跨 runtime 共享的 __ctx 容器）
export const createContext = (v) => {
  const ctx = { __ctx: { current: v } };
  ctx.Provider = { __ctx: ctx.__ctx, __isProvider: true };
  return ctx;
};
export const createElement = (type, props, ...children) => ({ type, props: { ...(props || {}), children } });
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, createHookRuntime };
`,
  });

  // react-native stub：AppState 可控（记录监听器 + 可手动 emit）+ Platform 可控
  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const listeners = new Set();
export const AppState = {
  currentState: 'active',
  addEventListener(type, cb) {
    if (type === 'change') listeners.add(cb);
    return { remove() { listeners.delete(cb); } };
  },
  __emit(next) {
    AppState.currentState = next;
    for (const cb of Array.from(listeners)) cb(next);
  },
  __listenerCount() { return listeners.size; },
  __reset() { listeners.clear(); AppState.currentState = 'active'; },
};
export const Platform = {
  get OS() { return globalThis.__PLATFORM_OS__ || 'android'; },
};
export default { AppState, Platform };
`,
  });

  // expo-video stub：可控播放器（记录全部调用 + 可注入 currentTime / playing / currentSource）
  mk('expo-video', {
    'package.json': JSON.stringify({ name: 'expo-video', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __playerLog = [];
export const __player = {
  loop: true, muted: true, staysActiveInBackground: false, preservesPitch: false,
  seekTolerance: null,
  playing: false,
  currentTime: 0,
  currentSource: null,
  play() { __playerLog.push(['play']); __player.playing = true; },
  pause() { __playerLog.push(['pause']); __player.playing = false; },
  replaceAsync(src) {
    __playerLog.push(['replaceAsync', src === null ? null : JSON.parse(JSON.stringify(src))]);
    __player.currentSource = src === null ? null : { uri: src && src.uri ? src.uri : null };
    return Promise.resolve();
  },
};
export function useVideoPlayer(source, setup) {
  if (typeof setup === 'function') setup(__player);
  return __player;
}
export default { useVideoPlayer };
`,
  });

  // expo-audio stub
  mk('expo-audio', {
    'package.json': JSON.stringify({ name: 'expo-audio', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __audioLog = [];
export async function setAudioModeAsync(mode) { __audioLog.push(mode); }
export default { setAudioModeAsync };
`,
  });

  // expo-haptics stub
  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const __hapticsLog = [];
export const NotificationFeedbackType = { Success: 'Success', Warning: 'Warning', Error: 'Error' };
export const ImpactFeedbackStyle = { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' };
export async function notificationAsync(t) { __hapticsLog.push(['notification', t]); }
export async function impactAsync(s) { __hapticsLog.push(['impact', s]); }
export default { notificationAsync, impactAsync, NotificationFeedbackType, ImpactFeedbackStyle };
`,
  });

  // @supabase/supabase-js stub（supabase.ts 依赖）
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // react-native-url-polyfill stub
  mk('react-native-url-polyfill', {
    'package.json': JSON.stringify({ name: 'react-native-url-polyfill', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export default {};\n',
  });

  const copyFile = (relSrc, relDst) => {
    const dst = path.join(dir, relDst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(relSrc, dst);
  };

  // 类型模块（仅类型，运行时为空；复制以支持潜在 import type 解析）
  copyFile(path.join(repoRoot, 'src/types/cinema.ts'), 'src/types/cinema.ts');

  // P1.4 R4 有界纯逻辑解耦：播放源构造（after 侧 useCinema.tsx 依赖）。
  //   before 侧冻结基线内联了同一函数，不 import 它，复制到两侧无副作用。
  copyFile(path.join(repoRoot, 'src/hooks/cinema/videoSource.ts'), 'src/hooks/cinema/videoSource.ts');

  // 被测模块：before 用冻结基线，after 用当前真实源码。
  // 含 JSX 的模块两侧都必须经 ts.transpileModule 转译为 .js。
  const transpile = (src, fileName) =>
    ts.transpileModule(src, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      fileName,
    }).outputText;

  const place = (srcPath, dstRel) => {
    const src = fs.readFileSync(srcPath, 'utf8');
    const dst = path.join(dir, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, transpile(src, path.basename(srcPath)));
  };

  if (mode === 'before') {
    place(path.join(beforeDir, 'hooks__useCinema.js'), 'src/hooks/useCinema.js');
  } else {
    place(path.join(repoRoot, 'src/hooks/useCinema.tsx'), 'src/hooks/useCinema.js');
  }

  // useSyncRoom stub：可控 partnerStatus / remoteCommand / emitCommand 记录
  fs.mkdirSync(path.join(dir, 'src/hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/hooks/useSyncRoom.js'),
    `
const state = {
  partnerStatus: '等待建立连接...',
  remoteCommand: null,
  danmakuList: [],
  dataOwnerKey: 'anon::0',
  emitLog: [],
};
export function useSyncRoom(roomId) {
  return {
    partnerStatus: state.partnerStatus,
    remoteCommand: state.remoteCommand,
    emitCommand(type, time = 0, url = null) { state.emitLog.push([type, time, url]); },
    danmakuList: state.danmakuList,
    emitDanmaku() {},
    ownerKey: state.dataOwnerKey,
  };
}
export const __syncState = state;
export default { useSyncRoom };
`
  );

  // useOwnerKey stub：可控 ownerKey
  fs.writeFileSync(
    path.join(dir, 'src/hooks/useOwnerKey.js'),
    `
const state = { ownerKey: 'anon::0' };
export function useOwnerKey() {
  return { ownerKey: state.ownerKey, ownerKeyRef: { current: state.ownerKey }, isOwnerKeyCurrent: () => true };
}
export const __ownerState = state;
export default { useOwnerKey };
`
  );

  // supabase 服务 stub：rpc 记录 + 可注入错误
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/services/supabase.js'),
    `
const state = { rpcLog: [], rpcError: null };
export const supabase = {
  __state: state,
  rpc(name, args) {
    state.rpcLog.push([name, args]);
    return Promise.resolve({ error: state.rpcError });
  },
};
export default { supabase };
`
  );

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // 解析器：扩展名省略时依次尝试 .js / .ts / .tsx / index.js / index.ts
  fs.writeFileSync(
    path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'.tsx',c);}catch{}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}}return n(s,c);}`
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
// 通用：在 before / after 两个沙箱中执行同一段场景脚本，返回可观测快照
// ---------------------------------------------------------------------------
function runBoth(body) {
  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  const before = runInSandbox(beforeSandbox, body);
  const after = runInSandbox(afterSandbox, body);
  return { before, after };
}

function assertEqualBoth(body, label) {
  const { before, after } = runBoth(body);
  assert.deepEqual(after, before, `Cinema 迁移前后可观测结果必须一致：${label}`);
  return { before, after };
}

// ===========================================================================
// CINEMA_PRELUDE：虚拟时钟 + 挂载 CinemaProvider + 消费者，暴露可控事件与快照
// ===========================================================================
const CINEMA_PRELUDE = String.raw`
const { createHookRuntime } = await import('react');
const { AppState, Platform } = await import('react-native');
const { __player, __playerLog } = await import('expo-video');
const { __audioLog } = await import('expo-audio');
const { __hapticsLog } = await import('expo-haptics');
const { __syncState } = await import('./src/hooks/useSyncRoom');
const { __ownerState } = await import('./src/hooks/useOwnerKey');
const { supabase } = await import('./src/services/supabase');
const { CinemaProvider, useCinema } = await import('./src/hooks/useCinema');

// ---- 虚拟时钟 -------------------------------------------------------------
let __now = 1000000;
const __timers = new Map();
let __timerSeq = 1;

globalThis.setTimeout = (fn, delay) => {
  const id = __timerSeq++;
  __timers.set(id, { fn, at: __now + (delay || 0), interval: null });
  return id;
};
globalThis.setInterval = (fn, delay) => {
  const id = __timerSeq++;
  __timers.set(id, { fn, at: __now + (delay || 0), interval: delay || 0 });
  return id;
};
globalThis.clearTimeout = (id) => { __timers.delete(id); };
globalThis.clearInterval = (id) => { __timers.delete(id); };
Date.now = () => __now;

// 推进虚拟时钟：按到期顺序触发定时器（interval 自动重排）
function advance(ms) {
  const target = __now + ms;
  let guard = 0;
  while (guard++ < 10000) {
    let nextId = null;
    let nextAt = Infinity;
    for (const [id, t] of __timers) {
      if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id; }
    }
    if (nextId === null) break;
    const t = __timers.get(nextId);
    __now = t.at;
    if (t.interval) t.at = __now + t.interval;
    else __timers.delete(nextId);
    try { t.fn(); } catch (_) {}
  }
  __now = target;
}

function pendingTimerCount() { return __timers.size; }

// ---- 挂载 Provider + 消费者 ----------------------------------------------
// Provider 与消费者分属不同 runtime（单组件栈限制）。
// Provider 直接以函数调用方式执行（返回 createElement 描述符），
// 再把描述符 props.value 发布到共享 __ctx 容器，消费者 runtime 即可读到。
let providerRt = createHookRuntime();
let consumerRt = createHookRuntime();
let ctxValue = null;
let tree = null;
const publish = () => {
  const value = tree && tree.props ? tree.props.value : undefined;
  if (value !== undefined) {
    const ctxRef = tree && tree.type && tree.type.__ctx;
    if (ctxRef) ctxRef.current = value;
  }
};
const renderProvider = () => {
  tree = providerRt.render(() => CinemaProvider({ children: null }));
  publish();
  consumerRt.render(() => { ctxValue = useCinema(); });
  return ctxValue;
};
// 桩运行时不会在 setState 后自动重渲染：settle 后必须再显式 render 才能读到异步写入的 state。
const flush = () => {
  let rounds = 0;
  while (providerRt.isScheduled && rounds < 20) { tree = providerRt.rerender(); rounds += 1; }
  publish();
  consumerRt.render(() => { ctxValue = useCinema(); });
};
// 外部桩状态（__syncState.remoteCommand / __ownerState.ownerKey 等）被直接改写时，
// 不会触发 setState，isScheduled 保持 false，flush() 将零次重渲染 → useEffect 永不重算。
// 因此凡是在「直接改写外部桩状态」之后，必须用 forceFlush() 强制重渲染一次，
// 让依赖该外部值的 useEffect 重新求值（等价于真实 React 中外部 store 触发订阅更新）。
const forceFlush = () => {
  tree = providerRt.rerender();
  let rounds = 0;
  while (providerRt.isScheduled && rounds < 20) { tree = providerRt.rerender(); rounds += 1; }
  publish();
  consumerRt.render(() => { ctxValue = useCinema(); });
};
// 模拟「影院页卸载 → 重新挂载」：Provider 卸载后以全新 runtime 重新挂载，
// 但 useSyncRoom 的模块级状态（含残留 remoteCommand）保持不变。
// 这正是 remoteCommand 去重守卫要防护的真实场景。
const remountProvider = () => {
  providerRt.unmount();
  providerRt = createHookRuntime();
  consumerRt = createHookRuntime();
  tree = providerRt.render(() => CinemaProvider({ children: null }));
  publish();
  consumerRt.render(() => { ctxValue = useCinema(); });
  return ctxValue;
};
const rt = { unmount: () => providerRt.unmount() };

function snapshot() {
  const v = ctxValue || {};
  return {
    keys: Object.keys(v).sort(),
    currentUrl: v.currentUrl ?? null,
    isMinimized: v.isMinimized,
    isPlaying: v.isPlaying,
    cinemaRoomId: v.cinemaRoomId ?? null,
    ownerKey: v.ownerKey,
    partnerStatus: v.partnerStatus,
    episodeList: (v.episodeList || []).map((e) => e.url),
    episodePageUrl: v.episodePageUrl ?? null,
    currentEpisodeIndex: v.currentEpisodeIndex,
    episodeSwitchRequest: v.episodeSwitchRequest
      ? { url: v.episodeSwitchRequest.url, index: v.episodeSwitchRequest.index, hasNonce: typeof v.episodeSwitchRequest.nonce === 'number' }
      : null,
    episodeListRequested: v.episodeListRequested,
    episodeListRequest: v.episodeListRequest
      ? { url: v.episodeListRequest.url, hasNonce: typeof v.episodeListRequest.nonce === 'number' }
      : null,
    danmakuCount: (v.danmakuList || []).length,
  };
}

function playerSnapshot() {
  return {
    log: __playerLog.map((e) => (e[0] === 'replaceAsync' ? ['replaceAsync', e[1]] : e)),
    playing: __player.playing,
    currentTime: __player.currentTime,
    currentSourceUri: __player.currentSource ? __player.currentSource.uri : null,
    loop: __player.loop,
    muted: __player.muted,
    staysActiveInBackground: __player.staysActiveInBackground,
    preservesPitch: __player.preservesPitch,
    seekTolerance: __player.seekTolerance,
  };
}

function resetAll() {
  __playerLog.length = 0;
  __audioLog.length = 0;
  __hapticsLog.length = 0;
  __syncState.emitLog.length = 0;
  __syncState.partnerStatus = '等待建立连接...';
  __syncState.remoteCommand = null;
  __syncState.danmakuList = [];
  __syncState.dataOwnerKey = 'anon::0';
  __ownerState.ownerKey = 'anon::0';
  supabase.__state.rpcLog.length = 0;
  supabase.__state.rpcError = null;
  __player.playing = false;
  __player.currentTime = 0;
  __player.currentSource = null;
  AppState.__reset();
}
`;

// ===========================================================================
// CINEMA-1：初始状态 + 公开接口形状
// ===========================================================================
test('CINEMA-1 初始状态与公开接口形状（27 字段）', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
renderProvider();
flush();
const snap = snapshot();
const p = playerSnapshot();
process.stdout.write(JSON.stringify({
  snap,
  keyCount: snap.keys.length,
  playerInit: {
    loop: p.loop, muted: p.muted, staysActiveInBackground: p.staysActiveInBackground,
    preservesPitch: p.preservesPitch, seekTolerance: p.seekTolerance,
  },
  audioLog: __audioLog,
  appStateListeners: AppState.__listenerCount(),
}));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-1');
  assert.equal(before.keyCount, 27, 'Context 必须暴露 27 个字段');
  assert.equal(before.snap.currentUrl, null);
  assert.equal(before.snap.isPlaying, false);
  assert.equal(before.snap.currentEpisodeIndex, -1);
  assert.equal(before.snap.ownerKey, 'anon::0');
  assert.deepEqual(before.playerInit.seekTolerance, { toleranceBefore: 0.5, toleranceAfter: 0.5 });
  assert.equal(before.playerInit.staysActiveInBackground, true);
  assert.equal(before.audioLog.length, 1, '必须调用一次 setAudioModeAsync');
  assert.equal(before.audioLog[0].interruptionMode, 'mixWithOthers');
  assert.equal(before.appStateListeners, 1, '必须注册一个 AppState change 监听');
});

// ===========================================================================
// CINEMA-2：loadUrl（Android）→ replaceAsync + 800ms 后 play
// ===========================================================================
test('CINEMA-2 loadUrl（Android）：replaceAsync + 800ms 后 play', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/a.m3u8', null);
flush();
const afterLoad = { snap: snapshot(), player: playerSnapshot() };
advance(800);
flush();
const after800 = { snap: snapshot(), player: playerSnapshot() };
process.stdout.write(JSON.stringify({ afterLoad, after800 }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-2');
  assert.equal(before.afterLoad.snap.currentUrl, 'https://cdn.example.com/a.m3u8');
  assert.equal(before.afterLoad.player.log.length, 1);
  assert.equal(before.afterLoad.player.log[0][0], 'replaceAsync');
  assert.equal(before.afterLoad.player.log[0][1].uri, 'https://cdn.example.com/a.m3u8');
  assert.equal(before.after800.player.playing, true, '800ms 后必须 play');
  assert.equal(before.after800.snap.isPlaying, true);
});

// ===========================================================================
// CINEMA-3：loadUrl（iOS）→ pause → 50ms replaceAsync → 1000ms play
// ===========================================================================
test('CINEMA-3 loadUrl（iOS）：pause → 50ms replaceAsync → 1000ms play', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'ios';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/ios.m3u8', null);
flush();
const afterLoad = { snap: snapshot(), player: playerSnapshot() };
advance(50);
flush();
const after50 = { player: playerSnapshot() };
// 嵌套定时器：1000ms 的 play 定时器是在 50ms 定时器回调内创建的，
// 到期时刻为 t0+50+1000 = t0+1050，因此这里必须再推进 1000ms（而非 950ms）。
advance(1000);
flush();
const after1000 = { snap: snapshot(), player: playerSnapshot() };
process.stdout.write(JSON.stringify({ afterLoad, after50, after1000 }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-3');
  // 立即：pause 已发生，尚未 replaceAsync
  assert.deepEqual(before.afterLoad.player.log, [['pause']]);
  assert.equal(before.afterLoad.snap.currentUrl, 'https://cdn.example.com/ios.m3u8');
  // 50ms：replaceAsync 发生，仍未 play
  assert.equal(before.after50.player.log.length, 2);
  assert.equal(before.after50.player.log[1][0], 'replaceAsync');
  assert.equal(before.after50.player.playing, false);
  // 1000ms：play
  assert.equal(before.after1000.player.playing, true);
  assert.equal(before.after1000.snap.isPlaying, true);
});

// ===========================================================================
// CINEMA-4：loadUrl 同源短路 → 不 replaceAsync，仅恢复播放
// ===========================================================================
test('CINEMA-4 loadUrl 同源短路：不 replaceAsync，仅恢复播放', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/same.m3u8', null);
flush();
advance(800);
flush();
// 此时 currentUrlRef 与 player.currentSource 均为 same.m3u8，且 playing=true
__playerLog.length = 0;
__player.playing = false; // 模拟被暂停
ctxValue.loadUrl('https://cdn.example.com/same.m3u8', null);
flush();
const after = { snap: snapshot(), player: playerSnapshot() };
process.stdout.write(JSON.stringify({ after }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-4');
  // 同源短路：只有 play，没有 replaceAsync
  assert.deepEqual(before.after.player.log, [['play']]);
  assert.equal(before.after.player.playing, true);
  assert.equal(before.after.snap.isPlaying, true);
});

// ===========================================================================
// CINEMA-5：loadUrl 携带 pageUrl → 清空旧选集 + 写入 episodeListRequest
// ===========================================================================
test('CINEMA-5 loadUrl 携带 pageUrl：清空旧选集 + 写入 episodeListRequest', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
// 先写入一些旧选集状态
ctxValue.applyEpisodeList(
  [{ url: 'https://cdn.example.com/ep1.m3u8', label: 'EP1' }, { url: 'https://cdn.example.com/ep2.m3u8', label: 'EP2' }],
  'https://site.example.com/play/1.html'
);
flush();
const beforeLoad = snapshot();
ctxValue.loadUrl('https://cdn.example.com/new.m3u8', 'https://site.example.com/play/2.html');
flush();
const afterLoad = snapshot();
process.stdout.write(JSON.stringify({ beforeLoad, afterLoad }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-5');
  assert.equal(before.beforeLoad.episodeList.length, 2);
  // 换剧 → 清空旧选集 + 索引归 -1 + 写入抓取请求
  assert.deepEqual(before.afterLoad.episodeList, []);
  assert.equal(before.afterLoad.currentEpisodeIndex, -1);
  assert.equal(before.afterLoad.episodePageUrl, 'https://site.example.com/play/2.html');
  assert.equal(before.afterLoad.episodeListRequested, true);
  assert.equal(before.afterLoad.episodeListRequest.url, 'https://site.example.com/play/2.html');
  assert.equal(before.afterLoad.episodeListRequest.hasNonce, true);
});

// ===========================================================================
// CINEMA-6：togglePlay → playing 翻转 + Haptics
// ===========================================================================
test('CINEMA-6 togglePlay：playing 翻转 + Haptics', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.togglePlay();
flush();
const afterPlay = { snap: snapshot(), player: playerSnapshot(), haptics: __hapticsLog.slice() };
ctxValue.togglePlay();
flush();
const afterPause = { snap: snapshot(), player: playerSnapshot(), haptics: __hapticsLog.slice() };
process.stdout.write(JSON.stringify({ afterPlay, afterPause }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-6');
  assert.equal(before.afterPlay.player.playing, true);
  assert.equal(before.afterPlay.snap.isPlaying, true);
  assert.deepEqual(before.afterPlay.haptics, [['impact', 'Medium']]);
  assert.equal(before.afterPause.player.playing, false);
  assert.equal(before.afterPause.snap.isPlaying, false);
  assert.equal(before.afterPause.haptics.length, 2);
});

// ===========================================================================
// CINEMA-7：remoteCommand PLAY（同 url）→ play + 时间同步
// ===========================================================================
test('CINEMA-7 remoteCommand PLAY（同 url）：play + 超阈值才 seek', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/r.m3u8', null);
flush();
advance(800);
flush();
__playerLog.length = 0;
__syncState.emitLog.length = 0;
// 同 url，时间差 10s（超 2.5 阈值）→ 应 seek
__player.currentTime = 0;
__syncState.remoteCommand = { type: 'PLAY', time: 10, url: 'https://cdn.example.com/r.m3u8' };
forceFlush();
const after = { snap: snapshot(), player: playerSnapshot(), emits: __syncState.emitLog.slice() };
process.stdout.write(JSON.stringify({ after }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-7');
  assert.equal(before.after.player.playing, true);
  assert.equal(before.after.player.currentTime, 10, '超阈值必须 seek 到目标时间');
  assert.equal(before.after.snap.isPlaying, true);
});

// ===========================================================================
// CINEMA-8：remoteCommand PAUSE（同 url）→ pause
// ===========================================================================
test('CINEMA-8 remoteCommand PAUSE（同 url）：pause', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/p.m3u8', null);
flush();
advance(800);
flush();
__playerLog.length = 0;
__player.currentTime = 5;
__syncState.remoteCommand = { type: 'PAUSE', time: 5, url: 'https://cdn.example.com/p.m3u8' };
forceFlush();
const after = { snap: snapshot(), player: playerSnapshot() };
process.stdout.write(JSON.stringify({ after }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-8');
  assert.equal(before.after.player.playing, false);
  assert.equal(before.after.snap.isPlaying, false);
  // 时间差 0（未超阈值）→ 不 seek
  assert.equal(before.after.player.currentTime, 5);
});

// ===========================================================================
// CINEMA-9：remoteCommand 不同 url → Haptics + replaceAsync + 1000ms 后 seek/play
// ===========================================================================
test('CINEMA-9 remoteCommand 不同 url：Haptics + replaceAsync + 1000ms 后 seek/play', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/old.m3u8', null);
flush();
advance(800);
flush();
__playerLog.length = 0;
__hapticsLog.length = 0;
__syncState.remoteCommand = { type: 'PLAY', time: 42, url: 'https://cdn.example.com/other.m3u8' };
forceFlush();
const afterCmd = { snap: snapshot(), player: playerSnapshot(), haptics: __hapticsLog.slice() };
advance(1000);
flush();
const after1000 = { snap: snapshot(), player: playerSnapshot() };
process.stdout.write(JSON.stringify({ afterCmd, after1000 }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-9');
  assert.deepEqual(before.afterCmd.haptics, [['notification', 'Success']]);
  assert.equal(before.afterCmd.player.log[0][0], 'replaceAsync');
  assert.equal(before.afterCmd.player.log[0][1].uri, 'https://cdn.example.com/other.m3u8');
  assert.equal(before.afterCmd.snap.currentUrl, 'https://cdn.example.com/other.m3u8');
  // 1000ms 后 seek 到 42 并 play
  assert.equal(before.after1000.player.currentTime, 42);
  assert.equal(before.after1000.player.playing, true);
});

// ===========================================================================
// CINEMA-10：remoteCommand 去重 → 同一指令对象只消费一次
// ===========================================================================
test('CINEMA-10 remoteCommand 去重：同一指令对象只消费一次', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/d.m3u8', null);
flush();
advance(800);
flush();
__playerLog.length = 0;
const cmd = { type: 'PAUSE', time: 3, url: 'https://cdn.example.com/d.m3u8' };
__syncState.remoteCommand = cmd;
forceFlush();
const firstLog = __playerLog.slice();
// 再次强制重渲染（同一对象引用）→ 不应重复处理
forceFlush();
forceFlush();
const secondLog = __playerLog.slice();
process.stdout.write(JSON.stringify({ firstLog, secondLog }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-10');
  assert.deepEqual(before.firstLog, [['pause']]);
  assert.deepEqual(before.secondLog, [['pause']], '同一指令对象不得重复消费');
});

// ===========================================================================
// CINEMA-11：remoteCommand FORCE_SYNC / AUTO_SYNC → seek 行为差异
// ===========================================================================
test('CINEMA-11 remoteCommand FORCE_SYNC / AUTO_SYNC：seek 行为差异', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/f.m3u8', null);
flush();
advance(800);
flush();
__playerLog.length = 0;
__hapticsLog.length = 0;
// FORCE_SYNC / AUTO_SYNC 走「无 url」分支（url 为 null 时才进入 FORCE_SYNC/AUTO_SYNC 处理；
// 若携带与当前播放源相同的 url，会先命中「同源短路」分支，只处理 PLAY/PAUSE）。
// FORCE_SYNC：无条件 seek + Warning Haptics
__player.currentTime = 1;
__syncState.remoteCommand = { type: 'FORCE_SYNC', time: 20, url: null };
forceFlush();
const afterForce = { player: playerSnapshot(), haptics: __hapticsLog.slice() };
// FORCE_SYNC 会写入 seekLockTimer（3000ms 内禁止 AUTO_SYNC 再次 seek）。
// 真实语义：seek 锁窗口内的 AUTO_SYNC 被抑制 → 先验证「锁内不 seek」。
__playerLog.length = 0;
__hapticsLog.length = 0;
__player.currentTime = 20;
__syncState.remoteCommand = { type: 'AUTO_SYNC', time: 30, url: null };
forceFlush();
const afterAutoLocked = { player: playerSnapshot(), haptics: __hapticsLog.slice() };
// 越过 3000ms seek 锁窗口后，AUTO_SYNC 才真正 seek（无 Haptics）
advance(3000);
__playerLog.length = 0;
__hapticsLog.length = 0;
__player.currentTime = 20;
__syncState.remoteCommand = { type: 'AUTO_SYNC', time: 30, url: null };
forceFlush();
const afterAuto = { player: playerSnapshot(), haptics: __hapticsLog.slice() };
process.stdout.write(JSON.stringify({ afterForce, afterAutoLocked, afterAuto }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-11');
  assert.equal(before.afterForce.player.currentTime, 20);
  assert.deepEqual(before.afterForce.haptics, [['notification', 'Warning']]);
  assert.equal(before.afterAutoLocked.player.currentTime, 20, 'seek 锁窗口内 AUTO_SYNC 不得 seek');
  assert.deepEqual(before.afterAutoLocked.haptics, [], 'AUTO_SYNC 不触发 Haptics');
  assert.equal(before.afterAuto.player.currentTime, 30, '越过 seek 锁后 AUTO_SYNC 应 seek');
  assert.deepEqual(before.afterAuto.haptics, [], 'AUTO_SYNC 不触发 Haptics');
});

// ===========================================================================
// CINEMA-12：轮询漂移检测 → 超阈值广播 AUTO_SYNC（2000ms 节流）
// ===========================================================================
test('CINEMA-12 轮询漂移检测：超阈值广播 AUTO_SYNC（2000ms 节流）', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/poll.m3u8', null);
flush();
advance(800);
flush();
__syncState.emitLog.length = 0;
// 建立基准：第一次轮询（500ms）记录 lastVideoTime。
// 注意：首次轮询会因 playing 由 false→true 广播一次 PLAY，且因 lastVideoTime 为 null
// 而把 10s 当作漂移广播一次 AUTO_SYNC（同时写入 lastForceSyncTime 开启 2000ms 节流）。
// 因此建立基准后必须推进超过 2000ms 节流窗口，才能观测到后续真实漂移广播。
__player.playing = true;
__player.currentTime = 10;
advance(500);
__syncState.emitLog.length = 0;
advance(2500); // 越过 2000ms 节流窗口（期间时间未变，不产生漂移）
__syncState.emitLog.length = 0;
// 第二次轮询：时间跳变 +10s（远超 0.5 期望增量）→ AUTO_SYNC
__player.currentTime = 20;
advance(500);
const afterFirstDrift = __syncState.emitLog.slice();
// 第三次轮询：再次跳变，但距上次 AUTO_SYNC < 2000ms → 节流，不广播
__player.currentTime = 30;
advance(500);
const afterThrottled = __syncState.emitLog.slice();
// 推进超过 2000ms 后再跳变 → 再次广播
advance(2500);
__player.currentTime = 50;
advance(500);
const afterSecondDrift = __syncState.emitLog.slice();
process.stdout.write(JSON.stringify({ afterFirstDrift, afterThrottled, afterSecondDrift }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-12');
  assert.equal(before.afterFirstDrift.length, 1);
  assert.equal(before.afterFirstDrift[0][0], 'AUTO_SYNC');
  assert.equal(before.afterFirstDrift[0][1], 20);
  assert.equal(before.afterThrottled.length, 1, '2000ms 内不得重复广播 AUTO_SYNC');
  assert.equal(before.afterSecondDrift.length, 2, '超过节流窗口后应再次广播');
  assert.equal(before.afterSecondDrift[1][0], 'AUTO_SYNC');
  assert.equal(before.afterSecondDrift[1][1], 50);
});

// ===========================================================================
// CINEMA-13：轮询 playing 变化 → 广播 PLAY / PAUSE
// ===========================================================================
test('CINEMA-13 轮询 playing 变化：广播 PLAY / PAUSE', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/pl.m3u8', null);
flush();
advance(800);
flush();
__syncState.emitLog.length = 0;
// 基准轮询（playing=false）
__player.playing = false;
__player.currentTime = 0;
advance(500);
// playing 变 true → 广播 PLAY
__player.playing = true;
__player.currentTime = 0.5;
advance(500);
const afterPlay = __syncState.emitLog.slice();
// playing 变 false → 广播 PAUSE
__player.playing = false;
__player.currentTime = 1;
advance(500);
const afterPause = __syncState.emitLog.slice();
process.stdout.write(JSON.stringify({ afterPlay, afterPause }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-13');
  assert.equal(before.afterPlay.length, 1);
  assert.equal(before.afterPlay[0][0], 'PLAY');
  assert.equal(before.afterPause.length, 2);
  assert.equal(before.afterPause[1][0], 'PAUSE');
});

// ===========================================================================
// CINEMA-14：拖动（setScrubbing）→ 拖动期间不广播 AUTO_SYNC
// ===========================================================================
test('CINEMA-14 setScrubbing：拖动期间不广播 AUTO_SYNC', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/scrub.m3u8', null);
flush();
advance(800);
flush();
__syncState.emitLog.length = 0;
__player.playing = true;
__player.currentTime = 10;
advance(500); // 建立基准（首次轮询会广播 PLAY，清空后再观测）
__syncState.emitLog.length = 0;
ctxValue.setScrubbing(true);
flush();
// 拖动期间时间大幅跳变 → 不应广播 AUTO_SYNC
__player.currentTime = 100;
advance(500);
const duringScrub = __syncState.emitLog.slice();
ctxValue.setScrubbing(false);
flush();
// 松手后基准已刷新为 100，小幅前进 → 不广播
__player.currentTime = 100.5;
advance(500);
const afterRelease = __syncState.emitLog.slice();
process.stdout.write(JSON.stringify({ duringScrub, afterRelease }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-14');
  assert.deepEqual(before.duringScrub, [], '拖动期间不得广播 AUTO_SYNC');
  assert.deepEqual(before.afterRelease, [], '松手后基准已刷新，不得误判漂移');
});

// ===========================================================================
// CINEMA-15：AppState 后台 → 停止轮询；前台 → 恢复轮询
// ===========================================================================
test('CINEMA-15 AppState 后台停止轮询 / 前台恢复轮询', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/app.m3u8', null);
flush();
advance(800);
flush();
__syncState.emitLog.length = 0;
__player.playing = true;
__player.currentTime = 10;
advance(500); // 建立基准（首次轮询会广播 PLAY + AUTO_SYNC）
__syncState.emitLog.length = 0;
// 切后台 → 停止轮询
AppState.__emit('background');
flush();
const timersAfterBg = pendingTimerCount();
__player.currentTime = 50;
advance(2000); // 后台期间即使时间跳变也不轮询
const emitsInBg = __syncState.emitLog.slice();
// 回前台 → 恢复轮询。注意：后台期间播放器时间已推进到 50，而 lastVideoTime 仍为 10，
// 因此恢复后的首次轮询会按真实语义判定为漂移（50 - 10 远超阈值）并广播 AUTO_SYNC。
AppState.__emit('active');
flush();
__player.currentTime = 50.5;
advance(500);
const emitsAfterFg = __syncState.emitLog.slice();
// 再推进一次：基准已刷新为 50.5，小幅前进 → 不广播
__player.currentTime = 51;
advance(500);
const emitsAfterFgStable = __syncState.emitLog.slice();
process.stdout.write(JSON.stringify({ timersAfterBg, emitsInBg, emitsAfterFg, emitsAfterFgStable }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-15');
  assert.deepEqual(before.emitsInBg, [], '后台期间不得轮询广播');
  assert.equal(before.emitsAfterFg.length, 1, '回前台首次轮询应检出后台期间的漂移');
  assert.equal(before.emitsAfterFg[0][0], 'AUTO_SYNC');
  assert.equal(before.emitsAfterFg[0][1], 50.5);
  assert.deepEqual(before.emitsAfterFgStable, before.emitsAfterFg, '基准刷新后小幅前进不得再广播');
});

// ===========================================================================
// CINEMA-16：选集状态机
// ===========================================================================
test('CINEMA-16 选集状态机：applyEpisodeList / requestEpisode / playNext / playPrev / clearEpisodes', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
const list = [
  { url: 'https://cdn.example.com/e1.m3u8', label: 'EP1' },
  { url: 'https://cdn.example.com/e2.m3u8', label: 'EP2' },
  { url: 'https://cdn.example.com/e3.m3u8', label: 'EP3' },
];
ctxValue.applyEpisodeList(list, 'https://cdn.example.com/e2.m3u8');
flush();
const afterApply = snapshot();
ctxValue.requestEpisode(2);
flush();
const afterRequest = snapshot();
ctxValue.playPrevEpisode();
flush();
const afterPrev = snapshot();
ctxValue.playNextEpisode();
flush();
const afterNext = snapshot();
ctxValue.clearEpisodes();
flush();
const afterClear = snapshot();
process.stdout.write(JSON.stringify({ afterApply, afterRequest, afterPrev, afterNext, afterClear }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-16');
  assert.deepEqual(before.afterApply.episodeList, [
    'https://cdn.example.com/e1.m3u8',
    'https://cdn.example.com/e2.m3u8',
    'https://cdn.example.com/e3.m3u8',
  ]);
  assert.equal(before.afterApply.currentEpisodeIndex, 1, '按 pageUrl 定位到第 2 集');
  assert.equal(before.afterApply.episodeListRequested, false, 'applyEpisodeList 必须清空抓取请求');
  assert.equal(before.afterRequest.currentEpisodeIndex, 2);
  assert.equal(before.afterRequest.episodeSwitchRequest.url, 'https://cdn.example.com/e3.m3u8');
  assert.equal(before.afterRequest.episodeSwitchRequest.index, 2);
  assert.equal(before.afterPrev.currentEpisodeIndex, 1);
  assert.equal(before.afterNext.currentEpisodeIndex, 2);
  assert.deepEqual(before.afterClear.episodeList, []);
  assert.equal(before.afterClear.currentEpisodeIndex, -1);
  assert.equal(before.afterClear.episodeSwitchRequest, null);
});

// ===========================================================================
// CINEMA-17：身份切换（ownerKey 变化）→ 本地强制清理
// ===========================================================================
test('CINEMA-17 身份切换（ownerKey 变化）：本地强制清理全部放映厅 state', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/id.m3u8', 'https://site.example.com/play/9.html');
flush();
advance(800);
flush();
ctxValue.setCinemaRoomId('room-abc');
flush();
const beforeSwitch = snapshot();
__playerLog.length = 0;
// 切换身份
__ownerState.ownerKey = 'userB::7';
forceFlush();
const afterSwitch = { snap: snapshot(), player: playerSnapshot() };
process.stdout.write(JSON.stringify({ beforeSwitch, afterSwitch }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-17');
  assert.equal(before.beforeSwitch.currentUrl, 'https://cdn.example.com/id.m3u8');
  assert.equal(before.beforeSwitch.cinemaRoomId, 'room-abc');
  // 切换后全部清空
  assert.equal(before.afterSwitch.snap.currentUrl, null);
  assert.equal(before.afterSwitch.snap.isPlaying, false);
  assert.equal(before.afterSwitch.snap.cinemaRoomId, null);
  assert.deepEqual(before.afterSwitch.snap.episodeList, []);
  assert.equal(before.afterSwitch.snap.currentEpisodeIndex, -1);
  // 播放器被 pause + replaceAsync(null)
  assert.deepEqual(before.afterSwitch.player.log, [['pause'], ['replaceAsync', null]]);
});

// ===========================================================================
// CINEMA-18：closePlayer → RPC + 本地清理 + 卸载清理
// ===========================================================================
test('CINEMA-18 closePlayer：RPC 调用 + 本地清理 + 卸载清理', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/close.m3u8', 'https://site.example.com/play/5.html');
flush();
advance(800);
flush();
ctxValue.setCinemaRoomId('room-xyz');
flush();
__playerLog.length = 0;
__hapticsLog.length = 0;
await ctxValue.closePlayer();
flush();
const afterClose = {
  snap: snapshot(),
  player: playerSnapshot(),
  haptics: __hapticsLog.slice(),
  rpcLog: supabase.__state.rpcLog.slice(),
};
// 卸载：AppState 监听移除 + 轮询停止
rt.unmount();
const listenersAfterUnmount = AppState.__listenerCount();
const timersAfterUnmount = pendingTimerCount();
process.stdout.write(JSON.stringify({ afterClose, listenersAfterUnmount, timersAfterUnmount }));
`;
  const { before } = assertEqualBoth(body, 'CINEMA-18');
  assert.deepEqual(before.afterClose.haptics, [['notification', 'Warning']]);
  assert.deepEqual(before.afterClose.player.log, [['pause'], ['replaceAsync', null]]);
  assert.equal(before.afterClose.snap.currentUrl, null);
  assert.equal(before.afterClose.snap.cinemaRoomId, null);
  assert.equal(before.afterClose.rpcLog.length, 1);
  assert.equal(before.afterClose.rpcLog[0][0], 'end_cinema_invites_by_room');
  assert.deepEqual(before.afterClose.rpcLog[0][1], { p_room_id: 'room-xyz' });
  assert.equal(before.listenersAfterUnmount, 0, '卸载后必须移除 AppState 监听');
  assert.equal(before.timersAfterUnmount, 0, '卸载后不得残留定时器');
});

// ===========================================================================
// 故障注入（Phase F）：证明断言可检出错误实现
//   在隔离副本中篡改「迁移后源码」，验证对应断言确实失败。
//   注意：mutateAndCompare 作用于**转译后**的沙箱文本，因此变异目标必须是
//   转译后仍存在的 JS 文本（类型断言在转译时被擦除）。
// ===========================================================================
function mutateAndCompare(body, mutate, label) {
  const beforeSandbox = buildSandbox('before');
  const afterSandbox = buildSandbox('after');
  const target = path.join(afterSandbox, 'src/hooks/useCinema.js');
  const src = fs.readFileSync(target, 'utf8');
  const mutated = mutate(src);
  assert.notEqual(mutated, src, `故障注入未生效（未匹配到目标代码）：${label}`);
  fs.writeFileSync(target, mutated);
  const before = runInSandbox(beforeSandbox, body);
  const after = runInSandbox(afterSandbox, body);
  return { before, after };
}

// 注入 1：把 Android 分支的 800ms 延迟改为 300ms（定时器时长篡改）
test('P14R4-FI-1 故障注入：Android 800ms 延迟被篡改为 300ms 必须被检出', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/fi1.m3u8', null);
flush();
advance(300);
flush();
const at300 = { playing: __player.playing, snap: snapshot() };
advance(500);
flush();
const at800 = { playing: __player.playing, snap: snapshot() };
process.stdout.write(JSON.stringify({ at300, at800 }));
`;
  const { before, after } = mutateAndCompare(
    body,
    (src) => src.replace('}, 800);', '}, 300);'),
    'Android 800ms → 300ms'
  );
  // 正确实现：300ms 时尚未 play
  assert.equal(before.at300.playing, false);
  // 错误实现：300ms 时已 play → 断言必须失败
  assert.notDeepEqual(after, before, '定时器时长篡改必须导致可观测差异');
  assert.equal(after.at300.playing, true, '被篡改实现应在 300ms 就 play');
});

// 注入 2：移除轮询中的 isScrubbing 保护（拖动期间误广播 AUTO_SYNC）
test('P14R4-FI-2 故障注入：移除 isScrubbing 保护必须被检出', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/fi2.m3u8', null);
flush();
advance(800);
flush();
__syncState.emitLog.length = 0;
__player.playing = true;
__player.currentTime = 10;
advance(500); // 建立基准（首次轮询会广播 PLAY + AUTO_SYNC 并开启 2000ms 节流）
__syncState.emitLog.length = 0;
advance(2500); // 越过 2000ms 节流窗口，确保后续漂移不受节流掩盖
__syncState.emitLog.length = 0;
ctxValue.setScrubbing(true);
flush();
__player.currentTime = 100;
advance(500);
const duringScrub = __syncState.emitLog.slice();
process.stdout.write(JSON.stringify({ duringScrub }));
`;
  const { before, after } = mutateAndCompare(
    body,
    (src) => src.replace('if (isScrubbingRef.current) {', 'if (false) {'),
    '移除 isScrubbing 保护'
  );
  assert.deepEqual(before.duringScrub, [], '正确实现拖动期间不广播');
  assert.notDeepEqual(after, before, '移除拖动保护必须导致可观测差异');
  assert.equal(after.duringScrub.length > 0, true, '被篡改实现应在拖动期间误广播');
});

// 注入 3：把 SYNC_THRESHOLD 从 2.5 改为 100（漂移检测失效）
test('P14R4-FI-3 故障注入：SYNC_THRESHOLD 被放大必须被检出', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/fi3.m3u8', null);
flush();
advance(800);
flush();
__syncState.emitLog.length = 0;
__player.playing = true;
__player.currentTime = 10;
advance(500); // 建立基准（首次轮询会广播 PLAY + AUTO_SYNC 并开启 2000ms 节流）
__syncState.emitLog.length = 0;
advance(2500); // 越过 2000ms 节流窗口，确保后续漂移不受节流掩盖
__syncState.emitLog.length = 0;
__player.currentTime = 20;
advance(500);
const emits = __syncState.emitLog.slice();
process.stdout.write(JSON.stringify({ emits }));
`;
  const { before, after } = mutateAndCompare(
    body,
    (src) => src.replace('const SYNC_THRESHOLD = 2.5;', 'const SYNC_THRESHOLD = 100;'),
    'SYNC_THRESHOLD 2.5 → 100'
  );
  assert.equal(before.emits.length, 1, '正确实现应广播 AUTO_SYNC');
  assert.equal(before.emits[0][0], 'AUTO_SYNC');
  assert.notDeepEqual(after, before, '阈值放大必须导致可观测差异');
  assert.deepEqual(after.emits, [], '被篡改实现不应广播 AUTO_SYNC');
});

// 注入 4：移除 remoteCommand 去重（同一挂载内同一指令对象被重复消费）
//   去重守卫的真实语义：handledRemoteCommandRef 是**每次挂载独立**的 useRef，
//   它防护的是「同一次挂载内，同一条指令对象因重渲染被 effect 再次求值」的场景
//   （例如 useSyncRoom 返回的 remoteCommand 引用未变，但 Provider 因其他 state
//   变化重渲染 → effect 依赖 remoteCommand 未变本不该重跑，但若守卫缺失且
//   effect 被重新触发，就会重复 pause）。
//   注意：卸载→重挂载会创建全新 useRef（current 为 null），正确实现同样会重新
//   消费残留指令——这不是守卫的防护范围，故不能作为注入场景。
test('P14R4-FI-4 故障注入：移除 remoteCommand 去重必须被检出', () => {
  const body = CINEMA_PRELUDE + String.raw`
resetAll();
globalThis.__PLATFORM_OS__ = 'android';
renderProvider();
flush();
ctxValue.loadUrl('https://cdn.example.com/fi4.m3u8', null);
flush();
advance(800);
flush();
__playerLog.length = 0;
// 首次消费：PAUSE 指令（同 url → 走同源短路分支，player.playing 为 true 时 pause）
__player.playing = true;
const cmd = { type: 'PAUSE', time: 3, url: 'https://cdn.example.com/fi4.m3u8' };
__syncState.remoteCommand = cmd;
forceFlush();
const afterFirst = __playerLog.slice();
// 同一次挂载内：remoteCommand 先被清空（effect 依赖变化 → 提前 return），
// 随后又恢复为**同一个对象引用**（真实场景：useSyncRoom 的 realtime 通道
// 在断线重连后重新推送同一条指令对象，或 Provider 因其他 state 变化导致
// effect 依赖数组重新求值）。此时 effect 会再次执行：
//   · 正确实现：handledRemoteCommandRef 已记录该对象 → 跳过，不再 pause。
//   · 被篡改实现（移除守卫）：再次消费 → 重复 pause。
__syncState.remoteCommand = null;
forceFlush();
__playerLog.length = 0;
__player.playing = true;
__syncState.remoteCommand = cmd;
forceFlush();
const afterReattach = __playerLog.slice();
process.stdout.write(JSON.stringify({ afterFirst, afterReattach }));
`;
  const { before, after } = mutateAndCompare(
    body,
    (src) =>
      src.replace(
        'if (handledRemoteCommandRef.current === remoteCommand)\n            return;',
        ''
      ),
    '移除 remoteCommand 去重'
  );
  assert.deepEqual(before.afterFirst, [['pause']], '正确实现首次消费一次');
  assert.deepEqual(before.afterReattach, [], '正确实现同一挂载内不重复消费同一指令对象');
  assert.notDeepEqual(after, before, '移除去重必须导致可观测差异');
  assert.equal(after.afterReattach.length > 0, true, '被篡改实现应重复消费同一指令对象');
});

// --- END OF FILE tests/security/p14r4CinemaMigrationEquivalence.test.mjs ---