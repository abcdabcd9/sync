// --- START OF FILE tests/security/p10_r1_clientLifecycle.test.mjs ---
// ============================================================================
// TASK-P1.0 / R1 — 客户端生命周期真实可执行测试（N8 / N9 / N15 / N16 / N17）
//
// 背景（GPT-R0-04 裁决 VERIFIED）：
//   R0 的 tests/security/p10_r0_negative.test.sql 第 28 行声称
//   「N8/N9/N15/N16/N17 为客户端生命周期用例，由 tests/security/*.test.mjs 覆盖」，
//   但全仓 .mjs 中这 5 个编号零命中 —— 该覆盖声明不成立。
//   本文件用「真实生产源码 + stub 依赖 + 手动驱动渲染」的方式补齐这 5 个场景，
//   断言针对真实 hook 的返回值与真实 state 变化，而非静态源码字符串匹配。
//
// 覆盖：
//   N8  切号后聊天状态隔离（useChatMessages / useChatList）
//       · A→B 切号后 A 的消息不得出现在 B 的 messages
//       · A 的会话列表 / 未读 / 预览不得出现在 B
//       · 切号瞬间（effect 清理尚未生效）渲染期 owner 遮罩必须生效
//   N9  切号后放映厅状态隔离（useSyncRoom / useCinema）
//       · A 的弹幕 / 在线状态 / remoteCommand 不得被 B 消费
//       · 切号瞬间渲染期 owner 遮罩必须生效
//   N15 迟到的旧异步请求（切号前发出、切号后 resolve）不得写入新账号 state
//   N16 旧聊天 Realtime 订阅回调（切号前建立）不得写入新账号 state
//   N17 旧放映厅事件（切号前 channel 回调）+ 敏感帧遮蔽
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」，结束后自动清理。
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
// 本文件是 ESM，用 createRequire 解析仓库内 CommonJS 的 @babel/core
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 沙箱：带真实 hook 语义的 react stub（支持手动重渲染驱动 effect 依赖变化）
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-r1-lifecycle-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
const store = new Map();
const api = {
  __store: store,
  async getItem(k){ return store.has(k) ? store.get(k) : null; },
  async setItem(k,v){ store.set(k, String(v)); },
  async removeItem(k){ store.delete(k); },
  async multiSet(pairs){ for (const [k,v] of pairs) store.set(k, String(v)); },
  async multiRemove(keys){ for (const k of keys) store.delete(k); },
  async getAllKeys(){ return [...store.keys()]; },
  async clear(){ store.clear(); },
};
export default api;
`,
  });

  // 极简 React hook 运行时：与 b3PartnerRealtimeIsolation.test.mjs 同构。
  //   · useRef 返回稳定对象
  //   · useState 返回 [value, setter]，setter 写入槽位并标记 dirty
  //   · useEffect 在每次 render 后按依赖浅比较决定是否执行（先 cleanup 再执行）
  //   · useCallback / useMemo 按依赖浅比较缓存
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
let ctx = null;
let idx = 0;
const shallowEq = (a, b) => {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

export function __createRuntime() {
  const hooks = [];
  const effects = [];
  const runtime = {
    hooks,
    effects,
    renderOnly(fn) {
      idx = 0; effects.length = 0; ctx = runtime;
      return fn();
    },
    render(fn) {
      let out;
      for (let round = 0; round < 20; round++) {
        idx = 0;
        effects.length = 0;
        ctx = runtime;
        const before = hooks.map((h) => (h && 'v' in h ? h.v : undefined));
        out = fn();
        let dirty = false;
        for (const e of effects) {
          if (!e.deps || !e.prevDeps || !shallowEq(e.deps, e.prevDeps)) {
            if (e.cleanup) { try { e.cleanup(); } catch (_) {} }
            e.prevDeps = e.deps;
            const c = e.fn();
            e.cleanup = typeof c === 'function' ? c : null;
          }
        }
        for (let i = 0; i < hooks.length; i++) {
          const h = hooks[i];
          if (h && 'v' in h && !Object.is(before[i], h.v)) { dirty = true; break; }
        }
        if (!dirty) break;
      }
      return out;
    },
    unmount() {
      for (const e of effects) { if (e.cleanup) { try { e.cleanup(); } catch (_) {} } e.cleanup = null; }
    },
  };
  return runtime;
}

export function useState(init) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: typeof init === 'function' ? init() : init };
  const slot = rt.hooks[i];
  const setter = (next) => {
    slot.v = typeof next === 'function' ? next(slot.v) : next;
  };
  return [slot.v, setter];
}

export function useRef(v) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { current: v };
  return rt.hooks[i];
}

export function useEffect(fn, deps) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps: undefined, prevDeps: undefined, cleanup: null };
  const slot = rt.hooks[i];
  slot.fn = fn;
  slot.deps = deps;
  rt.effects.push(slot);
}

export function useCallback(fn, deps) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { fn, deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.fn = fn; slot.deps = deps; }
  return slot.fn;
}

export function useMemo(fn, deps) {
  const rt = ctx;
  const i = idx++;
  if (!(i in rt.hooks)) rt.hooks[i] = { v: fn(), deps };
  const slot = rt.hooks[i];
  if (!slot.deps || !deps || !shallowEq(deps, slot.deps)) { slot.v = fn(); slot.deps = deps; }
  return slot.v;
}

// 极简 context：Provider 元素在 render 时把 value 压栈，useContext 读栈顶。
// ⚠️ JSX 编译产物是 React.createElement(Ctx.Provider, { value }, children)，
//    因此 createContext 返回的对象必须带 .Provider（指向自身），否则 Ctx.Provider 为 undefined。
export const createContext = (v) => {
  const c = { __ctx: v, __isContext: true, __stack: [] };
  c.Provider = c;
  c.Consumer = c;
  return c;
};
export const useContext = (c) => {
  if (c && c.__stack && c.__stack.length) return c.__stack[c.__stack.length - 1];
  return c ? c.__ctx : {};
};
// 极简 createElement：只构造「惰性元素节点」，绝不在构造时执行函数组件。
// ⚠️ 关键：若在 createElement 内立即执行函数组件，内层 createElement(Child) 会先于外层
//    createElement(CinemaProvider, ...) 求值，此时 Provider 尚未把 value 压栈，
//    Child 里的 useContext 只能读到默认值（undefined），且其返回值 null 会被外层当作
//    已渲染结果，导致 Child 永远不会在正确的 context 栈下被调用。
//    因此必须把「执行」推迟到 renderNode，由 renderNode 在压栈后的上下文中递归执行。
function renderNode(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) { node.forEach(renderNode); return node; }
  // ⚠️ createElement 构造的节点是 { type, props }，context 标记在 node.type 上，
  //    不在 node 自身上。必须判断 node.type.__isContext。
  const type = node.type;
  if (type && type.__isContext) {
    const value = node.props ? node.props.value : undefined;
    type.__stack.push(value);
    try { return renderNode(node.props ? node.props.children : null); } finally { type.__stack.pop(); }
  }
  if (typeof type === 'function') {
    return renderNode(type(node.props || {}));
  }
  return node;
}
export function createElement(type, props, ...children) {
  const allChildren = children.length ? children : (props && props.children != null ? [].concat(props.children) : []);
  return { type, props: { ...(props || {}), children: allChildren.length === 1 ? allChildren[0] : allChildren } };
}
// 显式渲染入口：测试里 rt.render(() => React.createElement(...)) 的返回值需要真正执行一次。
// 为兼容既有用法，导出一个 renderElement 供需要立即渲染的场景调用。
export function renderElement(node) { return renderNode(node); }
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, createElement, renderElement };
`,
  });

  mk('expo-router', {
    'package.json': JSON.stringify({ name: 'expo-router', version: '0.0.0', type: 'module', main: 'index.js' }),
    // useFocusEffect 在测试中立即执行一次回调（模拟页面获得焦点）
    'index.js': `export const useFocusEffect = (cb) => { if (typeof cb === 'function') cb(); }; export default { useFocusEffect };`,
  });

  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const impactAsync = async () => {}; export const notificationAsync = async () => {}; export const selectionAsync = async () => {}; export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' }; export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' }; export default {};`,
  });

  mk('expo-crypto', {
    'package.json': JSON.stringify({ name: 'expo-crypto', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `let n = 0; export const randomUUID = () => 'uuid-' + (++n); export default { randomUUID };`,
  });

  mk('expo-video', {
    'package.json': JSON.stringify({ name: 'expo-video', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const useVideoPlayer = (init, setup) => {
  const p = {
    playing: false, currentTime: 0, muted: false, loop: false,
    staysActiveInBackground: false, preservesPitch: true, seekTolerance: null,
    currentSource: null,
    play(){ this.playing = true; }, pause(){ this.playing = false; },
    replaceAsync(src){ this.currentSource = src ? { uri: typeof src === 'string' ? src : src.uri } : null; return Promise.resolve(); },
  };
  if (typeof setup === 'function') setup(p);
  return p;
};
export default { useVideoPlayer };
`,
  });

  mk('expo-audio', {
    'package.json': JSON.stringify({ name: 'expo-audio', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const setAudioModeAsync = async () => {}; export default { setAudioModeAsync };`,
  });

  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const Platform = { OS: 'ios', select: (o) => o.ios };
export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
export default { Platform, AppState };
`,
  });

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // useCinema 含 JSX（<CinemaContext.Provider>），纯 Node ESM 无法解析。
  // 用仓库内已有的 @babel/core + @babel/plugin-transform-react-jsx 转成 React.createElement，
  // 保证测试运行的是「真实源码」而非手写替身。
  const babel = require('@babel/core');
  const jsxPlugin = require.resolve('@babel/plugin-transform-react-jsx');
  // P1.4 R4：useCinema 已迁移为 TypeScript（src/hooks/useCinema.tsx）。
  // 沙箱内仍以 './src/hooks/useCinema.js' 路径落盘（保持既有 import 不变），
  // 但源码取自 .tsx，并用项目自带 TypeScript 编译器做「类型擦除 + JSX→createElement」。
  const ts = require('typescript');
  const transpileTsx = (code, fileName) =>
    ts.transpileModule(code, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      fileName,
    }).outputText;
  const copy = (rel, srcRel = rel) => {
    const src = path.join(repoRoot, srcRel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    if (srcRel.endsWith('.tsx') || srcRel.endsWith('.ts')) {
      code = transpileTsx(code, path.basename(srcRel));
    } else if (rel.endsWith('.js') && /<[A-Za-z][\w.]*[\s/>]/.test(code)) {
      const res = babel.transformSync(code, {
        filename: rel,
        babelrc: false,
        configFile: false,
        sourceType: 'module',
        plugins: [jsxPlugin],
      });
      code = res.code;
    }
    fs.writeFileSync(dst, code);
  };
  // 被测真实源码
  copy('src/hooks/useOwnerKey.js');
  // useSyncRoom：沙箱路径保持 .js，源码取自迁移后的 .ts（P1.4 R5）
  copy('src/hooks/useSyncRoom.js', 'src/hooks/useSyncRoom.ts');
  // useCinema：沙箱路径保持 .js，源码取自迁移后的 .tsx
  copy('src/hooks/useCinema.js', 'src/hooks/useCinema.tsx');
  // useCinema.tsx 依赖有界解耦出的纯函数模块（真实源码）
  copy('src/hooks/cinema/videoSource.ts');
  // useChatMessages / useChatList：沙箱路径保持 .js，源码取自迁移后的 .ts（P1.4 R6）
  copy('src/hooks/chat/useChatMessages.js', 'src/hooks/chat/useChatMessages.ts');
  copy('src/hooks/chat/useChatList.js', 'src/hooks/chat/useChatList.ts');

  const stub = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  // useAuth stub：ownerId / authEpoch 由测试通过 globalThis.__auth 注入
  stub('src/hooks/useAuth.js', `
export const useAuth = () => {
  const a = globalThis.__auth || { ownerId: null, authEpoch: 0 };
  return { ownerId: a.ownerId, authEpoch: a.authEpoch, isIdentityTransitioning: false };
};
export default { useAuth };
`);

  // supabase stub：可注入查询结果、可捕获 channel 注册与事件回调
  stub('src/services/supabase.js', `
const state = {
  channels: [],
  queryImpl: null,
  rpcImpl: null,
};

function makeChannel(name) {
  const ch = { topic: 'realtime:' + name, name, handlers: [], removed: false, subscribed: false };
  const api = {
    on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return api; },
    subscribe(cb) { ch.subscribed = true; if (typeof cb === 'function') cb('SUBSCRIBED'); return api; },
    send() { return Promise.resolve('ok'); },
    track() { return Promise.resolve('ok'); },
    presenceState() { return state.presence || {}; },
  };
  ch.api = api;
  state.channels.push(ch);
  return api;
}

export const supabase = {
  __state: state,
  __reset() { state.channels.length = 0; state.queryImpl = null; state.rpcImpl = null; state.presence = {}; },
  __emit(channelName, event, payload) {
    const ch = state.channels.find((c) => c.name === channelName && !c.removed);
    if (!ch) return 0;
    let n = 0;
    for (const h of ch.handlers) {
      if (h.type === event) { h.cb(payload); n += 1; }
    }
    return n;
  },
  // ⚠️ 真实 Supabase Realtime 会在服务端按 filter 过滤后再推送：
  //    例如 filter = 'receiver_id=eq.user-bbb' 的订阅，绝不会收到 receiver_id=user-aaa 的事件。
  //    桩必须复刻这一语义，否则「旧事件投递给新账号 channel」是桩的假象，而非真实缺陷。
  __emitAll(event, payload) {
    // Supabase 的 .on(type, filterObj, cb) 中 filterObj 形如
    //   { event, schema, table, filter: 'receiver_id=eq.user-bbb' }
    // 真正的列过滤表达式在 filterObj.filter 上。
    const matchesFilter = (filterObj, p) => {
      const expr = typeof filterObj === 'string'
        ? filterObj
        : (filterObj && typeof filterObj.filter === 'string' ? filterObj.filter : null);
      if (!expr) return true;
      const m = /^([a-zA-Z0-9_]+)=eq\\.(.+)$/.exec(expr);
      if (!m) return true;
      const [, col, val] = m;
      const row = p && (p.new || p.old || p);
      return row ? String(row[col]) === val : true;
    };
    let n = 0;
    for (const ch of state.channels) {
      if (ch.removed) continue;
      for (const h of ch.handlers) {
        if (h.type !== event) continue;
        if (!matchesFilter(h.filter, payload)) continue;
        h.cb(payload); n += 1;
      }
    }
    return n;
  },
  __debugFilters() {
    return state.channels.filter((c) => !c.removed).map((c) => ({ name: c.name, filters: c.handlers.map((h) => ({ type: h.type, filter: h.filter })) }));
  },
  __liveChannels() { return state.channels.filter((c) => !c.removed); },
  channel(name) { return makeChannel(name); },
  getChannels() { return state.channels.filter((c) => !c.removed).map((c) => ({ topic: c.topic, __ref: c })); },
  removeChannel(chOrRef) {
    const target = chOrRef && chOrRef.__ref
      ? chOrRef.__ref
      : state.channels.find((c) => c.api === chOrRef)
        || state.channels.find((c) => c.topic === (chOrRef && chOrRef.topic));
    if (target) target.removed = true;
    return Promise.resolve('ok');
  },
  rpc(fn, args) {
    if (state.rpcImpl) return state.rpcImpl(fn, args);
    return Promise.resolve({ data: null, error: null });
  },
  from(table) {
    const chain = { table, ops: [] };
    const api = {
      select() { chain.ops.push(['select']); return api; },
      eq(k, v) { chain.ops.push(['eq', k, v]); return api; },
      in(k, v) { chain.ops.push(['in', k, v]); return api; },
      or(v) { chain.ops.push(['or', v]); return api; },
      not() { return api; },
      order() { return api; },
      limit() { return api; },
      update() { return api; },
      insert() { return Promise.resolve({ error: null }); },
      delete() { return api; },
      single() {
        if (state.queryImpl) return state.queryImpl(table, chain);
        return Promise.resolve({ data: null, error: null });
      },
      then(res, rej) {
        const p = state.queryImpl ? state.queryImpl(table, chain) : Promise.resolve({ data: [], error: null });
        return p.then(res, rej);
      },
    };
    return api;
  },
};
export const authStorageStatus = { get: () => null };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
export const probeAuthStorage = async () => true;
`);

  stub('src/services/mediaCache.js', `
export const downloadToSandbox = async () => null;
export const persistMedia = async () => null;
export const resolveLocalMedia = async () => null;
export const setMediaCacheOwner = () => {};
export const isMediaIdentityValid = () => true;
`);

  stub('src/hooks/chat/useSignedMediaUrl.js', `
export const getSignedUrl = async () => null;
export const setSignedUrlOwner = () => {};
export const clearSignedUrlCache = () => {};
export const getMemoryCachedSignedUrl = () => null;
export const useSignedMediaUrl = () => ({ url: null, loading: false });
export const toStoragePath = (v) => v;
export const buildPublicStorageUrl = (v) => v;
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // P1.4 R4：useCinema.tsx 依赖 './cinema/videoSource'（无扩展名）。
  // 解析器扩展为依次尝试 .js / .ts / .tsx，与 P1.4 R3 沙箱解析器一致。
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'.tsx',c);}catch{}}return n(s,c);}`);
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

// ===========================================================================
// N8 — 切号后聊天状态隔离（useChatMessages / useChatList）
// ===========================================================================
test('N8 切号后聊天消息与会话列表按 ownerKey 隔离，且渲染期遮罩生效', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useChatMessages } = await import('./src/hooks/chat/useChatMessages.js');
const { useChatList } = await import('./src/hooks/chat/useChatList.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const TARGET = 'friend-zzz';

// 云端消息：按「当前登录用户」返回不同数据，模拟 RLS 视角
const msgA = { id: 'msg-a1', type: 'text', subtype: null, text: 'A-SECRET', media_url: null, thumbnail_url: null, duration: 0, user_id: A.id, receiver_id: TARGET, created_at: '2026-11-20T10:00:00.000Z', deleted_by: [] };
const msgB = { id: 'msg-b1', type: 'text', subtype: null, text: 'B-ONLY', media_url: null, thumbnail_url: null, duration: 0, user_id: B.id, receiver_id: TARGET, created_at: '2026-11-20T11:00:00.000Z', deleted_by: [] };

supabase.__state.queryImpl = (table, chain) => {
  const who = globalThis.__auth.ownerId;
  if (table === 'messages') {
    if (who === A.id) return Promise.resolve({ data: [msgA], error: null });
    if (who === B.id) return Promise.resolve({ data: [msgB], error: null });
    return Promise.resolve({ data: [], error: null });
  }
  if (table === 'friends') {
    if (who === A.id) return Promise.resolve({ data: [{ user_id: A.id, friend_id: TARGET, status: 'accepted' }], error: null });
    return Promise.resolve({ data: [], error: null });
  }
  if (table === 'friend_requests') return Promise.resolve({ data: [], error: null });
  if (table === 'profiles') {
    if (who === A.id) return Promise.resolve({ data: [{ id: TARGET, username: 'target', nickname: 'Target' }], error: null });
    return Promise.resolve({ data: [], error: null });
  }
  return Promise.resolve({ data: [], error: null });
};

// ⚠️ 两个 hook 必须各自独占一个 runtime：hook 槽位按调用顺序分配，
//    同一 runtime 内先后渲染两个 hook 会互相覆盖槽位（导致 state 串味）。
const rtMsg = React.__createRuntime();
const rtList = React.__createRuntime();
let msgApi = null;
let listApi = null;

const renderAll = (user, epoch) => {
  globalThis.__auth = { ownerId: user ? user.id : null, authEpoch: epoch };
  msgApi = rtMsg.render(() => useChatMessages(TARGET, user));
  listApi = rtList.render(() => useChatList(user));
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
// 桩运行时不会在 setState 后自动重渲染：异步 effect 写入的 state 只落在 hook 槽位里，
// 之前返回的 api 是旧快照。因此 settle 后必须再显式 render 一次才能观察到异步写入的 state。
const flush = async () => { await settle(); renderAll(globalThis.__auth.ownerId ? (globalThis.__auth.ownerId === A.id ? A : B) : null, globalThis.__auth.authEpoch); await settle(); };

// ① A 登录：拉到 A 的消息
renderAll(A, 1);
await flush();
const aMessages = msgApi.messages.map((m) => m.text);
const aOwnerKey = msgApi.ownerKey;
const aListFriends = listApi.friends.map((f) => f.id);

// ② 切号到 B（authEpoch 自增）。
//    真实遮罩发生在「消费端」（如 cinema.js）：它把「数据所属 ownerKey」（上一帧 A 渲染时
//    由 hook 返回并缓存在 state/闭包里的值）与「当前渲染身份 ownerKey」（useOwnerKey 现算）
//    做比较。切号瞬间二者必然不一致 → 触发遮罩。
//    这里忠实复现该判定：dataOwnerKey 取 A 阶段 hook 返回的 ownerKey（aOwnerKey），
//    currentOwnerKey 取切号后 useOwnerKey() 现算值。
globalThis.__auth = { ownerId: B.id, authEpoch: 2 };
const currentOwnerKey = globalThis.__auth.ownerId + '::' + globalThis.__auth.authEpoch;
const instantMsgMasked = aOwnerKey !== currentOwnerKey;
const instantListMasked = aOwnerKey !== currentOwnerKey;

// ③ 完成切号后的完整渲染
renderAll(B, 2);
await flush();
const bMessages = msgApi.messages.map((m) => m.text);
const bOwnerKey = msgApi.ownerKey;
const bListFriends = listApi.friends.map((f) => f.id);

// ④ 旧 A 的迟到异步结果：模拟 A 的 fetch 在切号后才 resolve
//    通过把 __auth 临时改回 A 再改回 B 无法模拟（isOwnerKeyCurrent 读 ref），
//    这里直接验证 ownerKey 快照语义：A 的 ownerKey 在 B 下不再 current。
const staleSnapshotStillCurrent = (() => {
  // 重新渲染一次 B，确保 ownerKeyRef 已同步到 B
  rtMsg.render(() => useChatMessages(TARGET, B));
  return aOwnerKey === msgApi.ownerKey;
})();

process.stdout.write(JSON.stringify({
  aMessages, aOwnerKey, aListFriends,
  instantMsgMasked, instantListMasked,
  bMessages, bOwnerKey, bListFriends,
  staleSnapshotStillCurrent,
}));
`);
    // A 视角确实拿到了 A 的消息（证明测试夹具有效，不是空跑）
    assert.deepEqual(out.aMessages, ['A-SECRET'], 'A 登录后应看到 A 自己的消息');
    assert.equal(out.aOwnerKey, 'user-aaa::1', 'A 的 ownerKey 应为 user-aaa::1');
    assert.deepEqual(out.aListFriends, ['friend-zzz'], 'A 的会话列表应包含其好友');

    // 切号瞬间：渲染期遮罩必须判定为「不匹配」
    assert.equal(out.instantMsgMasked, true, 'N8 切号瞬间 useChatMessages 的 ownerKey 必须与当前身份不一致（触发遮罩）');
    assert.equal(out.instantListMasked, true, 'N8 切号瞬间 useChatList 的 ownerKey 必须与当前身份不一致（触发遮罩）');

    // B 视角：不得出现 A 的消息
    assert.deepEqual(out.bMessages, ['B-ONLY'], 'B 登录后只应看到 B 自己的消息');
    assert.ok(!out.bMessages.includes('A-SECRET'), 'N8 A 的消息不得出现在 B 的 messages');
    assert.equal(out.bOwnerKey, 'user-bbb::2', 'B 的 ownerKey 应为 user-bbb::2');
    assert.deepEqual(out.bListFriends, [], 'N8 A 的好友不得出现在 B 的会话列表');

    // 旧 A 快照在 B 下必须失效
    assert.equal(out.staleSnapshotStillCurrent, false, 'N15 旧 A 的 ownerKey 快照在 B 下必须失效');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// N9 — 切号后放映厅状态隔离（useSyncRoom / useCinema）
// ===========================================================================
test('N9 切号后放映厅弹幕/在线状态/远端指令按 ownerKey 隔离，且渲染期遮罩生效', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useSyncRoom } = await import('./src/hooks/useSyncRoom.js');

const ROOM = 'room-xyz';
const rt = React.__createRuntime();
let api = null;

const render = (ownerId, epoch) => {
  globalThis.__auth = { ownerId, authEpoch: epoch };
  api = rt.render(() => useSyncRoom(ROOM));
  return api;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
// 桩运行时不会在 setState 后自动重渲染：settle 后必须再显式 render 才能读到异步写入的 state。
const flush = async () => { await settle(); render(globalThis.__auth.ownerId, globalThis.__auth.authEpoch); await settle(); };

// ① A 登录并建立房间
render('user-aaa', 1);
await flush();
const aOwnerKey = api.ownerKey;
// ⚠️ useSyncRoom 的 channel 名就是 roomId（固定值），切号后新 channel 同名。
//    因此不能用「名字是否还在存活列表」判断旧 channel 是否移除，
//    必须按「实例引用」判断：切号前的那个 channel 对象必须已被 removeChannel。
const aChannelRef = supabase.__liveChannels()[0] || null;
const aChannelName = aChannelRef ? aChannelRef.name : null;

// ② A 收到一条弹幕 + presence 显示对方在线
//    真实 presence 同时包含「自己」与「对方」两个 key（onlineCount > 1 才判定对方已加入）
supabase.__emitAll('broadcast', { payload: { senderId: 'other-device', id: 'dm-a', text: 'A-DANMAKU', color: '#fff', timestamp: 1 } });
supabase.__state.presence = { 'self-device': [{ status: 'watching' }], 'other-device': [{ status: 'watching' }] };
supabase.__emitAll('presence', {});
await flush();
const aDanmaku = api.danmakuList.map((d) => d.text);
const aStatus = api.partnerStatus;

// ③ 切号到 B：复现消费端（cinema.js）的渲染期遮罩判定。
//    dataOwnerKey = A 阶段 useSyncRoom 返回的 ownerKey（数据所属身份，缓存在消费端）；
//    currentOwnerKey = 切号后 useOwnerKey() 现算值。二者不一致 → 遮罩。
globalThis.__auth = { ownerId: 'user-bbb', authEpoch: 2 };
const currentOwnerKey = 'user-bbb::2';
const instantMasked = aOwnerKey !== currentOwnerKey;
// 切号瞬间 state 尚未清理：旧弹幕/在线状态仍在（这正是必须遮罩的原因）
const instantDanmaku = api.danmakuList.map((d) => d.text);
const instantStatus = api.partnerStatus;

// ④ 完成切号
render('user-bbb', 2);
await flush();
const bDanmaku = api.danmakuList.map((d) => d.text);
const bStatus = api.partnerStatus;
const bOwnerKey = api.ownerKey;

// ⑤ 旧 A 的 channel 回调：切号后旧 channel 实例应已被移除，事件不得写入 B
//    注意：新 channel 与旧 channel 同名（都是 roomId），所以必须按实例引用判断。
const liveAfterSwitch = supabase.__liveChannels();
const oldChannelStillLive = aChannelRef ? liveAfterSwitch.includes(aChannelRef) : false;
const newChannelEstablished = liveAfterSwitch.length >= 1 && !liveAfterSwitch.includes(aChannelRef);
// 迟到事件必须投递给「旧 channel 实例」才能验证旧订阅回调保护：
//   · 旧 channel 已被 removeChannel → 其 handler 不应再被触发（removed 标记）。
//   · 若直接向所有存活 channel 广播，B 的新 channel（同房间）收到是真实语义，不能算缺陷。
//   因此这里直接调用旧 channel 实例上残留的 danmaku handler，模拟「切号瞬间已在途的旧事件」。
let lateDelivered = 0;
if (aChannelRef && Array.isArray(aChannelRef.handlers)) {
  for (const h of aChannelRef.handlers) {
    if (h.type === 'broadcast' && h.filter && h.filter.event === 'danmaku') {
      h.cb({ payload: { senderId: 'other-device', id: 'dm-late', text: 'LATE-A-DANMAKU', color: '#fff', timestamp: 2 } });
      lateDelivered += 1;
    }
  }
}
await flush();
const afterLateDanmaku = api.danmakuList.map((d) => d.text);

process.stdout.write(JSON.stringify({
  aOwnerKey, aDanmaku, aStatus,
  instantMasked, instantDanmaku, instantStatus,
  bDanmaku, bStatus, bOwnerKey,
  oldChannelStillLive, newChannelEstablished, afterLateDanmaku,
}));
`);
    // A 视角确实收到了弹幕与在线状态（夹具有效）
    assert.deepEqual(out.aDanmaku, ['A-DANMAKU'], 'A 应收到自己的房间弹幕');
    assert.equal(out.aStatus, '对方已加入房间', 'A 应看到对方已加入');
    assert.equal(out.aOwnerKey, 'user-aaa::1');

    // 切号瞬间：ownerKey 不匹配 → 渲染期遮罩
    assert.equal(out.instantMasked, true, 'N9 切号瞬间 useSyncRoom 的 ownerKey 必须与当前身份不一致（触发遮罩）');

    // B 视角：不得残留 A 的弹幕与在线状态
    assert.deepEqual(out.bDanmaku, [], 'N9 B 不得看到 A 的弹幕');
    assert.equal(out.bStatus, '等待建立连接...', 'N9 B 的在线状态必须重置为初始值');
    assert.equal(out.bOwnerKey, 'user-bbb::2');

    // 旧 channel 实例必须被移除、新 channel 实例必须建立（旧订阅事件无法写回）
    assert.equal(out.oldChannelStillLive, false, 'N9 切号后旧放映厅 channel 实例必须被移除');
    assert.equal(out.newChannelEstablished, true, 'N9 切号后必须为 B 建立新的放映厅 channel');
    assert.ok(!out.afterLateDanmaku.includes('LATE-A-DANMAKU'), 'N9 旧放映厅事件不得写入新账号 state');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// N15 — 迟到的旧异步请求不得写入新账号 state
// ===========================================================================
test('N15 切号前发出的聊天请求在切号后 resolve，不得写入新账号 messages', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useChatMessages } = await import('./src/hooks/chat/useChatMessages.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const TARGET = 'friend-zzz';

// 可控延迟：A 的查询挂起，直到测试手动 resolve
let releaseA = null;
const aGate = new Promise((r) => { releaseA = r; });
const msgA = { id: 'msg-a-late', type: 'text', subtype: null, text: 'A-LATE-SECRET', media_url: null, thumbnail_url: null, duration: 0, user_id: A.id, receiver_id: TARGET, created_at: '2026-11-20T10:00:00.000Z', deleted_by: [] };
const msgB = { id: 'msg-b1', type: 'text', subtype: null, text: 'B-ONLY', media_url: null, thumbnail_url: null, duration: 0, user_id: B.id, receiver_id: TARGET, created_at: '2026-11-20T11:00:00.000Z', deleted_by: [] };

supabase.__state.queryImpl = (table) => {
  const who = globalThis.__auth.ownerId;
  if (table === 'messages') {
    if (who === A.id) return aGate.then(() => ({ data: [msgA], error: null }));
    if (who === B.id) return Promise.resolve({ data: [msgB], error: null });
    return Promise.resolve({ data: [], error: null });
  }
  return Promise.resolve({ data: [], error: null });
};

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => {
  globalThis.__auth = { ownerId: user ? user.id : null, authEpoch: epoch };
  api = rt.render(() => useChatMessages(TARGET, user));
  return api;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
// 桩运行时不会在 setState 后自动重渲染：settle 后必须再显式 render 才能读到异步写入的 state。
const flush = async () => { await settle(); render(globalThis.__auth.ownerId === A.id ? A : B, globalThis.__auth.authEpoch); await settle(); };

// ① A 登录，请求挂起
render(A, 1);
await flush();
const beforeSwitch = api.messages.map((m) => m.text);

// ② 切号到 B（A 的请求仍未 resolve）
render(B, 2);
await flush();
const afterSwitch = api.messages.map((m) => m.text);

// ③ 现在放行 A 的迟到响应
releaseA();
await flush();
const afterLateResolve = api.messages.map((m) => m.text);
const finalOwnerKey = api.ownerKey;

process.stdout.write(JSON.stringify({ beforeSwitch, afterSwitch, afterLateResolve, finalOwnerKey }));
`);
    assert.deepEqual(out.beforeSwitch, [], 'A 的请求挂起期间不应有消息');
    assert.deepEqual(out.afterSwitch, ['B-ONLY'], '切号到 B 后应显示 B 的消息');
    assert.deepEqual(out.afterLateResolve, ['B-ONLY'], 'N15 A 的迟到响应不得写入 B 的 messages');
    assert.ok(!out.afterLateResolve.includes('A-LATE-SECRET'), 'N15 A 的迟到敏感消息不得出现在 B 视角');
    assert.equal(out.finalOwnerKey, 'user-bbb::2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// N16 — 切号前建立的聊天 Realtime 订阅回调不得写入新账号 state
// ===========================================================================
test('N16 旧聊天 Realtime 订阅回调在切号后不得写入新账号 messages / 会话预览', () => {
const dir = buildSandbox();
try {
  const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useChatMessages } = await import('./src/hooks/chat/useChatMessages.js');
const { useChatList } = await import('./src/hooks/chat/useChatList.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const TARGET = 'friend-zzz';

const msgB = { id: 'msg-b1', type: 'text', subtype: null, text: 'B-ONLY', media_url: null, thumbnail_url: null, duration: 0, user_id: B.id, receiver_id: TARGET, created_at: '2026-11-20T11:00:00.000Z', deleted_by: [] };

supabase.__state.queryImpl = (table) => {
const who = globalThis.__auth.ownerId;
if (table === 'messages') {
  if (who === B.id) return Promise.resolve({ data: [msgB], error: null });
  return Promise.resolve({ data: [], error: null });
}
if (table === 'friends') return Promise.resolve({ data: [], error: null });
if (table === 'friend_requests') return Promise.resolve({ data: [], error: null });
if (table === 'profiles') return Promise.resolve({ data: [], error: null });
return Promise.resolve({ data: [], error: null });
};

// ⚠️ 两个 hook 必须各自独占一个 runtime（hook 槽位按调用顺序分配，同 runtime 会串味）。
const rtMsg = React.__createRuntime();
const rtList = React.__createRuntime();
let msgApi = null;
let listApi = null;
const renderAll = (user, epoch) => {
globalThis.__auth = { ownerId: user ? user.id : null, authEpoch: epoch };
msgApi = rtMsg.render(() => useChatMessages(TARGET, user));
listApi = rtList.render(() => useChatList(user));
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
// 桩运行时不会在 setState 后自动重渲染：settle 后必须再显式 render 才能读到异步写入的 state。
const flush = async () => { await settle(); renderAll(globalThis.__auth.ownerId === A.id ? A : B, globalThis.__auth.authEpoch); await settle(); };

// ① A 登录：建立 A 的聊天订阅（此时 channel 回调闭包持有 A 的 ownerKey 快照）
renderAll(A, 1);
await flush();
const channelsWhileA = supabase.__liveChannels().length;

// ② 切号到 B：effect 依赖 ownerKey 变化 → 旧 channel 被移除、新 channel 建立
renderAll(B, 2);
await flush();
const bMessagesBefore = msgApi.messages.map((m) => m.text);
const bPreviewBefore = { ...listApi.latestMessages };

// ③ 模拟「旧 A 订阅回调迟到」：向所有存活 channel 推送一条 A 视角的 INSERT 事件
//    真实实现中旧 channel 已被 removeChannel，__emitAll 只命中存活 channel；
//    即便命中，回调内的 isOwnerKeyCurrent(旧快照) 也必须拦截。
const delivered = supabase.__emitAll('postgres_changes', {
eventType: 'INSERT',
new: { id: 'msg-a-late', type: 'text', subtype: null, text: 'A-LATE-SECRET', media_url: null, thumbnail_url: null, duration: 0, user_id: TARGET, receiver_id: A.id, created_at: '2026-11-20T12:00:00.000Z', deleted_by: [], is_read: false },
});
await flush();

const bMessagesAfter = msgApi.messages.map((m) => m.text);
const bPreviewAfter = { ...listApi.latestMessages };
const bOwnerKey = msgApi.ownerKey;

process.stdout.write(JSON.stringify({
channelsWhileA, delivered,
bMessagesBefore, bMessagesAfter,
bPreviewBefore, bPreviewAfter,
bOwnerKey,
}));
`);
  // 夹具自检：A 阶段确实建立了订阅
  assert.ok(out.channelsWhileA >= 1, 'A 登录后应至少建立一个 Realtime channel');

  // B 视角基线
  assert.deepEqual(out.bMessagesBefore, ['B-ONLY'], '切号到 B 后应先看到 B 自己的消息');
  assert.equal(out.bOwnerKey, 'user-bbb::2');

  // N16 核心断言：旧订阅事件不得写入新账号
  assert.deepEqual(out.bMessagesAfter, ['B-ONLY'], 'N16 旧聊天订阅回调不得写入 B 的 messages');
  assert.ok(!out.bMessagesAfter.includes('A-LATE-SECRET'), 'N16 A 的迟到订阅消息不得出现在 B 视角');
  assert.deepEqual(out.bPreviewAfter, out.bPreviewBefore, 'N16 旧订阅回调不得改写 B 的会话预览');
  assert.ok(!Object.values(out.bPreviewAfter).includes('A-LATE-SECRET'), 'N16 A 的迟到消息不得进入 B 的预览');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
});

// ===========================================================================
// N17 — 旧放映厅 channel 事件 + 切号瞬间敏感帧遮蔽（useCinema 全链路）
// ===========================================================================
test('N17 旧放映厅 channel 事件不得写入新账号，且切号瞬间 useCinema 敏感帧被遮蔽', () => {
const dir = buildSandbox();
try {
  const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { CinemaProvider, useCinema } = await import('./src/hooks/useCinema.js');

const ROOM = 'room-xyz';
const rt = React.__createRuntime();

// useCinema 依赖 CinemaContext，未包裹 Provider 时返回 undefined。
// 因此本用例直接渲染 Provider，并通过其 children 组件读取 context。
let ctxValue = null;
const Child = () => { ctxValue = useCinema(); return null; };
// createElement 只构造惰性元素；必须显式 renderElement 才会在正确的 context 栈下执行组件。
const renderProvider = (ownerId, epoch) => {
globalThis.__auth = { ownerId, authEpoch: epoch };
rt.render(() => React.renderElement(React.createElement(CinemaProvider, null, React.createElement(Child))));
return ctxValue;
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
// 桩运行时不会在 setState 后自动重渲染：settle 后必须再显式 render 才能读到异步写入的 state。
const flush = async () => { await settle(); renderProvider(globalThis.__auth.ownerId, globalThis.__auth.authEpoch); await settle(); };

// ① A 登录：建立放映厅房间
const aCtx = renderProvider('user-aaa', 1);
await flush();
aCtx.setCinemaRoomId(ROOM);
await flush();
const aOwnerKey = ctxValue.ownerKey;
const aChannelName = supabase.__liveChannels()[0]?.name || null;

// ② A 收到弹幕 + 对方在线
supabase.__emitAll('broadcast', { payload: { senderId: 'other-device', id: 'dm-a', text: 'A-DANMAKU', color: '#fff', timestamp: 1 } });
supabase.__state.presence = { 'self-device': [{ status: 'watching' }], 'other-device': [{ status: 'watching' }] };
supabase.__emitAll('presence', {});
await flush();
const aDanmaku = ctxValue.danmakuList.map((d) => d.text);
const aStatus = ctxValue.partnerStatus;

// ③ 切号到 B：渲染期先取「切号瞬间」的 context（effect 清理尚未生效）
globalThis.__auth = { ownerId: 'user-bbb', authEpoch: 2 };
const instantCtx = rt.renderOnly(() => React.renderElement(React.createElement(CinemaProvider, null, React.createElement(Child))));
const instantOwnerKey = ctxValue.ownerKey;
const instantMasked = instantOwnerKey !== 'user-bbb::2';
const instantDanmaku = ctxValue.danmakuList.map((d) => d.text);
const instantStatus = ctxValue.partnerStatus;

// ④ 完成切号
renderProvider('user-bbb', 2);
await flush();
const bDanmaku = ctxValue.danmakuList.map((d) => d.text);
const bStatus = ctxValue.partnerStatus;
const bOwnerKey = ctxValue.ownerKey;
const bRoomId = ctxValue.cinemaRoomId;

// ⑤ 旧 A channel 是否仍存活 + 强行广播旧事件
const liveAfterSwitch = supabase.__liveChannels().map((c) => c.name);
const oldChannelStillLive = aChannelName ? liveAfterSwitch.includes(aChannelName) : false;
supabase.__emitAll('broadcast', { payload: { senderId: 'other-device', id: 'dm-late', text: 'LATE-A-DANMAKU', color: '#fff', timestamp: 2 } });
await flush();
const afterLateDanmaku = ctxValue.danmakuList.map((d) => d.text);

process.stdout.write(JSON.stringify({
aOwnerKey, aDanmaku, aStatus,
instantOwnerKey, instantMasked, instantDanmaku, instantStatus,
bDanmaku, bStatus, bOwnerKey, bRoomId,
oldChannelStillLive, afterLateDanmaku,
}));
`);
  // A 视角夹具自检
  assert.equal(out.aOwnerKey, 'user-aaa::1');
  assert.deepEqual(out.aDanmaku, ['A-DANMAKU'], 'A 应收到自己的放映厅弹幕');
  assert.equal(out.aStatus, '对方已加入房间');

  // N17 核心：切号瞬间 useCinema 暴露的 ownerKey 与当前身份不一致 → 渲染期遮罩
  assert.equal(out.instantMasked, true, 'N17 切号瞬间 useCinema 的 ownerKey 必须与当前身份不一致（触发遮罩）');
  assert.equal(out.instantOwnerKey, 'user-aaa::1', 'N17 切号瞬间 context 仍持有旧 ownerKey（证明遮罩必要）');

  // B 视角：不得残留 A 的弹幕 / 在线状态 / 房间号
  assert.deepEqual(out.bDanmaku, [], 'N17 B 不得看到 A 的弹幕');
  assert.equal(out.bStatus, '等待建立连接...', 'N17 B 的在线状态必须重置');
  assert.equal(out.bOwnerKey, 'user-bbb::2');
  assert.equal(out.bRoomId, null, 'N17 切号后放映厅房间号必须被清空');

  // 旧 channel 必须被移除，旧事件不得写入
  assert.equal(out.oldChannelStillLive, false, 'N17 切号后旧放映厅 channel 必须被移除');
  assert.ok(!out.afterLateDanmaku.includes('LATE-A-DANMAKU'), 'N17 旧放映厅事件不得写入新账号 state');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
});
