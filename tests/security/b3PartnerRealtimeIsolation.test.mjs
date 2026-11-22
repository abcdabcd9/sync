// --- START OF FILE tests/security/b3PartnerRealtimeIsolation.test.mjs ---
// ============================================================================
// TASK-P0.3 / B3 — 搭子绑定关系与 Supabase Realtime 生命周期隔离 自动化回归测试
//
// 覆盖 B3 诊断确认的 6 项缺陷（B3-01 ~ B3-06）：
//   AC-B3-01  同账号新 authEpoch 必须作废旧会话搭子状态（useHealthCloud 账号切换 effect）
//   AC-B3-02  fetchPartnerRecord 迟到结果在 epoch 变化后必须丢弃（不写 state / 不写缓存）
//   AC-B3-03  subscribeAuthorization 旧会话复验结果不得触发 onRevoked 清空新会话
//   AC-B3-04  subscribePartner 旧会话迟到实时事件不得写入新会话搭子数据
//   AC-B3-05  useHealthData 订阅 effect 依赖必须包含 authEpoch（源码契约）
//   AC-B3-06  bind_partner 页面级异步回调必须做身份快照校验（源码契约）
//
// 附加回归（防止 B3 修复误伤既有安全机制）：
//   AC-B3-07  A→B 切号后 A 的搭子数据不得出现在 B 视角
//   AC-B3-08  A→B→A 旧 A 会话的迟到结果不得写回（epoch 单调递增）
//   AC-B3-09  解绑后旧搭子迟到事件不得写回（authGeneration 闸门仍生效）
//   AC-B3-10  正常绑定/实时推送不回归（隔离不误伤）
//   AC-B3-11  重复订阅不产生重复 channel（channel 名唯一 + 旧 channel 清理）
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token / 真实用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」，结束后自动清理。
//   - 断言针对真实生产接口（useHealthCloud / authRevokeLogic 的导出契约）。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
// P1.4 R8：项目自带 TypeScript 编译器（.ts 类型擦除后以 .js 落盘供沙箱执行）。
const ts = createRequire(import.meta.url)('typescript');

// ---------------------------------------------------------------------------
// 沙箱：stub react（带真实 hook 语义的极简实现）/ AsyncStorage / supabase
//
// 关键点：B3 的修复全部依赖「ref 镜像 + 闭包快照」语义，因此 react stub
// 必须提供可用的 useRef / useCallback / useMemo / useState / useEffect，
// 并且允许测试手动「重渲染」以驱动 effect 依赖变化。
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-partner-'));
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

  // 极简 React hook 运行时：支持「手动重渲染」以驱动 effect 依赖变化。
  //   · useRef 返回稳定对象
  //   · useState 返回 [value, setter]，setter 记录值并标记 dirty
  //   · useEffect 在每次 render 后按依赖浅比较决定是否执行
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
    // 模拟 React 的「渲染 → 提交 effect → setState 触发重渲染」循环。
    //   · 每次 render 都从 hook 槽位读取最新 state（setState 已写入槽位）
    //   · effect 依赖变化时先执行 cleanup 再执行新 effect
    //   · 若 effect 内调用了 setState（槽位值变化），自动再渲染一轮（最多 20 轮）
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

export const createContext = (v) => ({ __ctx: v });
export const useContext = () => ({});
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext };
`,
  });

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // P1.4 R8：useHealthCloud 已迁移为 .ts，按 .ts 优先、.js 兜底解析，
  //   使沙箱始终复制当前真实源码（Node 24 原生类型擦除执行）。
  const resolveSrc = (rel) => {
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  const copy = (rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (actual.endsWith('.ts')) {
      const code = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      fs.writeFileSync(dst, code);
    } else {
      fs.copyFileSync(src, dst);
    }
  };
  copy('src/hooks/health/useHealthCloud.js');
  copy('src/hooks/health/authRevokeLogic.ts');

  // supabase stub：可注入 RPC 结果、可捕获 channel 注册与事件回调
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
const state = {
  channels: [],          // { topic, handlers: [{type, filter, cb}], removed: false }
  rpcImpl: null,         // (fn, args) => Promise<{data, error}>
  queryImpl: null,       // (table, chain) => Promise<{data, error}>
};

function makeChannel(name) {
  const ch = { topic: 'realtime:' + name, name, handlers: [], removed: false, subscribed: false };
  const api = {
    on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return api; },
    subscribe() { ch.subscribed = true; return api; },
  };
  ch.api = api;
  state.channels.push(ch);
  return api;
}

export const supabase = {
  __state: state,
  __reset() { state.channels.length = 0; state.rpcImpl = null; state.queryImpl = null; },
  __emit(channelName, payload) {
    const ch = state.channels.find((c) => c.name === channelName && !c.removed);
    if (!ch) return 0;
    let n = 0;
    for (const h of ch.handlers) { h.cb(payload); n += 1; }
    return n;
  },
  __liveChannels() { return state.channels.filter((c) => !c.removed); },
  channel(name) { return makeChannel(name); },
  getChannels() { return state.channels.filter((c) => !c.removed).map((c) => ({ topic: c.topic, __ref: c })); },
  removeChannel(chOrRef) {
    // 真实 Supabase 的 removeChannel(channel) 接受 channel 实例（即 makeChannel
    // 返回的 api 对象）并移除它。旧 stub 只按 topic 查找，而 api 对象没有 topic
    // 字段 → 永远找不到目标 → channel 永不 removed。这会让「cleanup 后旧 channel
    // 仍存活」以及「重复订阅去重失效」两个断言在毫秒级竞争下随机失败（HEAD 即存在）。
    // 修复：优先按 api 反向引用（ch.api === chOrRef）定位，其次按 __ref / topic。
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
      single() {
        if (state.queryImpl) return state.queryImpl(table, chain);
        return Promise.resolve({ data: null, error: null });
      },
      then(res, rej) {
        const p = state.queryImpl ? state.queryImpl(table, chain) : Promise.resolve({ data: null, error: null });
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

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}return n(s,c);}`);
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

const tick = 'await new Promise((r) => setTimeout(r, 0));';

// ---------------------------------------------------------------------------
// AC-B3-02 / 04 / 07 / 08 / 09 / 10：useHealthCloud 的 epoch 闸门与实时隔离
// ---------------------------------------------------------------------------
test('AC-B3-02/04/07/08/09/10 useHealthCloud 搭子数据与实时事件按 authEpoch 隔离', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const PARTNER = 'partner-xxx';
const DATE = '2026-11-19';
const getDateStr = () => DATE;

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => {
  api = rt.render(() => useHealthCloud(user, getDateStr, epoch));
  return api;
};

// 读取 hook 内部 state 的辅助。
// useHealthCloud 的 hook 槽位顺序（必须与源码一致）：
//   0=useState(partnerData) 1=useState(partnerId) 2=useRef(timerRef)
//   3=useRef(pendingMapRef) 4=useCallback(pendingKeyOf) 5=useRef(authGenerationRef)
//   6=useState(authGeneration) ...
const partnerData = () => rt.hooks[0].v;
const partnerIdState = () => rt.hooks[1].v;
const authGenState = () => rt.hooks[6].v;

// ⚠️ 关键：stub 的 setState 只改槽位值，不会自动重渲染。
//    React 真实语义下 setState 会触发重渲染，effect 依赖变化随之提交。
//    这里显式「重渲染」以模拟该行为（依赖未变时 effect 不会重跑）。
const rerender = (user, epoch) => render(user, epoch);

// ---------- 场景 1：A 正常绑定并收到实时推送（AC-B3-10 不误伤）----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
render(A, 1);
const cleanupSub = api.subscribePartner(PARTNER, DATE);
const liveAfterSubscribe = supabase.__liveChannels().length;
const chName = supabase.__liveChannels()[0].name;
supabase.__emit(chName, { new: { record_date: DATE, water_amount: 1500, meals_status: { '早餐': true } } });
const normalPush = JSON.parse(JSON.stringify(partnerData()));
cleanupSub();

// ---------- 场景 2：同账号新 authEpoch → 旧订阅迟到事件必须丢弃（AC-B3-04）----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
rerender(A, 1);
const cleanupOld = api.subscribePartner(PARTNER, DATE);
const oldCh = supabase.__liveChannels()[0].name;
// 同账号新会话：epoch 1 → 2（userId 不变）
rerender(A, 2);
const afterEpochBump = JSON.parse(JSON.stringify(partnerData()));
const afterEpochPartnerId = partnerIdState();
// 旧订阅的迟到事件（模拟 cleanup 尚未执行 / 事件已在队列中）
supabase.__emit(oldCh, { new: { record_date: DATE, water_amount: 9999, meals_status: { '早餐': true } } });
const afterLateOldEvent = JSON.parse(JSON.stringify(partnerData()));
cleanupOld();

// ---------- 场景 3：A→B 切号，A 的搭子数据不得出现在 B 视角（AC-B3-07）----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
rerender(A, 1);
const cleanupA = api.subscribePartner(PARTNER, DATE);
const aCh = supabase.__liveChannels()[0].name;
supabase.__emit(aCh, { new: { record_date: DATE, water_amount: 2000, meals_status: {} } });
const aData = JSON.parse(JSON.stringify(partnerData()));
rerender(B, 1);
const bPartnerIdAfterSwitch = partnerIdState();
const bDataAfterSwitch = JSON.parse(JSON.stringify(partnerData()));
supabase.__emit(aCh, { new: { record_date: DATE, water_amount: 7777, meals_status: {} } });
const bDataAfterLateA = JSON.parse(JSON.stringify(partnerData()));
cleanupA();

// ---------- 场景 4：A→B→A，旧 A 会话迟到结果不得写回（AC-B3-08）----------
// 注意：A1 订阅建立于 epoch=1；切到 B 再回到 A(epoch=2) 后，A1 的 epoch 快照
// 已过期，其迟到事件必须被丢弃。A2 订阅建立于 epoch=2，必须正常工作。
// 关键：A1 的 cleanup 必须在切号前执行（真实 React 中 effect cleanup 先于
// 新 effect 提交），否则旧 channel 会被新订阅的「同名清理」逻辑移除，
// 导致「迟到事件」根本不存在，测试就失去意义。
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
rerender(A, 1);
const cleanupA1 = api.subscribePartner(PARTNER, DATE);
const a1Ch = supabase.__liveChannels()[0].name;
cleanupA1();                        // 模拟 effect cleanup（channel 标记 removed）
rerender(B, 1);                     // 切到 B（epoch=1，userId 变化）
rerender(A, 2);                     // 回到 A，但已是新会话（epoch=2）
api.bindPartner(PARTNER);
rerender(A, 2);
const cleanupA2 = api.subscribePartner(PARTNER, DATE);
const a2Ch = supabase.__liveChannels().map((c) => c.name);
// 旧 A1 channel 已被 cleanup 标记 removed，__emit 不会命中它 —— 这正是真实
// 场景下「旧订阅已移除」的状态。为验证 epoch 闸门本身，直接调用旧 channel
// 上残留的 handler（模拟事件已在队列中、cleanup 尚未生效的竞争窗口）。
const staleHandler = supabase.__state.channels.find((c) => c.name === a1Ch).handlers[0].cb;
staleHandler({ new: { record_date: DATE, water_amount: 1111, meals_status: {} } });
const afterStaleA1 = JSON.parse(JSON.stringify(partnerData()));
supabase.__emit(a2Ch[0], { new: { record_date: DATE, water_amount: 3333, meals_status: {} } });
const afterFreshA2 = JSON.parse(JSON.stringify(partnerData()));
cleanupA2();

// ---------- 场景 5：解绑后旧搭子迟到事件不得写回（AC-B3-09）----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
rerender(A, 1);
const cleanupUnbind = api.subscribePartner(PARTNER, DATE);
const unbindCh = supabase.__liveChannels()[0].name;
api.clearPartner(PARTNER);
rerender(A, 1);
supabase.__emit(unbindCh, { new: { record_date: DATE, water_amount: 8888, meals_status: {} } });
const afterUnbindLate = JSON.parse(JSON.stringify(partnerData()));
const afterUnbindPartnerId = partnerIdState();
cleanupUnbind();

// ---------- 场景 6：fetchPartnerRecord 迟到结果在 epoch 变化后必须丢弃（AC-B3-02）----------
// 注意：fetchPartnerRecord 会先读缓存（此时 epoch 未变，缓存 500 会写入 state），
// 然后发起网络请求。网络请求在途期间 epoch 变化 → 网络结果必须丢弃，
// 且不得覆盖缓存。因此断言的是「缓存值 500 保留」而非「state 为 0」。
// 关键：场景 5 的 clearPartner 会异步清理 @partner_health_<id>_* 缓存，
// 必须等它完成后再写入本场景的缓存，否则会被场景 5 的清理删掉。
await new Promise((r) => setTimeout(r, 10));
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
rerender(A, 1);
const cacheKey6 = '@partner_health_' + PARTNER + '_' + DATE;
await AS.setItem(cacheKey6, JSON.stringify({ waterAmount: 500, mealsStatus: {} }));
let releaseFetch;
supabase.__state.queryImpl = () => new Promise((res) => {
  releaseFetch = () => res({ data: { water_amount: 4242, meals_status: { '午餐': true } }, error: null });
});
const pendingFetch = api.fetchPartnerRecord(PARTNER, DATE);
await new Promise((r) => setTimeout(r, 5));
rerender(A, 2);                      // 同账号新会话（清空 state）
releaseFetch();
const fetchResult = await pendingFetch;
const afterStaleFetch = JSON.parse(JSON.stringify(partnerData()));
const cacheAfterStaleFetch = await AS.getItem(cacheKey6);

// ---------- 场景 7：重复订阅不产生重复 channel（AC-B3-11）----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
rerender(A, 1);
const c1 = api.subscribePartner(PARTNER, DATE);
const c2 = api.subscribePartner(PARTNER, DATE);
const liveCount = supabase.__liveChannels().length;
c1(); c2();

process.stdout.write(JSON.stringify({
  normalPush,
  liveAfterSubscribe,
  afterEpochBump, afterEpochPartnerId, afterLateOldEvent,
  aData, bPartnerIdAfterSwitch, bDataAfterSwitch, bDataAfterLateA,
  afterStaleA1, afterFreshA2,
  afterUnbindLate, afterUnbindPartnerId,
  fetchResult, afterStaleFetch, cacheAfterStaleFetch,
  liveCount,
}));
`);
    // AC-B3-10：正常实时推送必须生效（隔离不误伤）
    assert.equal(out.liveAfterSubscribe, 1, '正常订阅应建立 1 个 channel');
    assert.equal(out.normalPush.waterAmount, 1500, '正常实时推送必须写入搭子数据');

    // AC-B3-04：同账号新 epoch 后旧订阅迟到事件必须丢弃
    assert.equal(out.afterEpochBump.waterAmount, 0, 'epoch 变化后搭子数据必须被清空');
    assert.equal(out.afterEpochPartnerId, null, 'epoch 变化后 partnerId 必须被清空');
    assert.equal(out.afterLateOldEvent.waterAmount, 0, '旧会话订阅的迟到事件不得写入新会话');

    // AC-B3-07：A→B 切号隔离
    assert.equal(out.aData.waterAmount, 2000, 'A 视角应正常收到自己的搭子数据');
    assert.equal(out.bPartnerIdAfterSwitch, null, '切到 B 后不得残留 A 的 partnerId');
    assert.equal(out.bDataAfterSwitch.waterAmount, 0, '切到 B 后不得残留 A 的搭子数据');
    assert.equal(out.bDataAfterLateA.waterAmount, 0, 'A 的迟到事件不得写入 B 视角');

    // AC-B3-08：A→B→A 旧 A 会话迟到结果不得写回
    assert.equal(out.afterStaleA1.waterAmount, 0, '旧 A 会话的迟到事件不得写入新 A 会话');
    assert.equal(out.afterFreshA2.waterAmount, 3333, '新 A 会话的订阅必须正常工作');

    // AC-B3-09：解绑后旧搭子迟到事件不得写回
    assert.equal(out.afterUnbindLate.waterAmount, 0, '解绑后旧搭子迟到事件不得写回');
    assert.equal(out.afterUnbindPartnerId, null, '解绑后 partnerId 必须为 null');

    // AC-B3-02：fetchPartnerRecord 迟到结果在 epoch 变化后必须丢弃
    assert.equal(out.fetchResult, null, 'epoch 变化后 fetchPartnerRecord 必须返回 null');
    // epoch 变化时账号切换 effect 已把 state 清空为 0；迟到网络结果（4242）不得写入
    assert.equal(out.afterStaleFetch.waterAmount, 0, 'epoch 变化后迟到 fetch 结果不得写入 state');
    // 迟到网络结果不得覆盖本地缓存：缓存必须仍是进入时的 500（而非 4242）
    assert.ok(out.cacheAfterStaleFetch, '本地缓存不得被删除');
    assert.equal(
      JSON.parse(out.cacheAfterStaleFetch).waterAmount,
      500,
      'epoch 变化后迟到 fetch 结果不得覆盖本地缓存'
    );

    // AC-B3-11：重复订阅不产生重复 channel
    assert.equal(out.liveCount, 1, '同名订阅重复调用不得产生重复 channel');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B3-03：subscribeAuthorization 旧会话复验结果不得触发 onRevoked
// ---------------------------------------------------------------------------
test('AC-B3-03 授权订阅在 epoch 变化后不得触发 onRevoked 清空新会话', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const PARTNER = 'partner-xxx';
const getDateStr = () => '2026-11-19';

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };

// ---------- 场景 1：正常撤销（服务端返回 null）必须触发 onRevoked（不误伤）----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
render(A, 1);
let revokedNormal = 0;
let releaseVerify;
supabase.__state.rpcImpl = () => new Promise((res) => { releaseVerify = () => res({ data: null, error: null }); });
const cleanupNormal = api.subscribeAuthorization(PARTNER, () => { revokedNormal += 1; });
const authCh = supabase.__liveChannels()[0].name;
supabase.__emit(authCh, { new: { requester_id: PARTNER, addressee_id: A.id, status: 'revoked' } });
await new Promise((r) => setTimeout(r, 5));
releaseVerify();
await new Promise((r) => setTimeout(r, 10));
cleanupNormal();

// ---------- 场景 2：epoch 变化后旧订阅复验结果不得触发 onRevoked ----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
render(A, 1);
let revokedStale = 0;
let releaseVerify2;
supabase.__state.rpcImpl = () => new Promise((res) => { releaseVerify2 = () => res({ data: null, error: null }); });
const cleanupStale = api.subscribeAuthorization(PARTNER, () => { revokedStale += 1; });
const authCh2 = supabase.__liveChannels()[0].name;
supabase.__emit(authCh2, { new: { requester_id: PARTNER, addressee_id: A.id, status: 'revoked' } });
await new Promise((r) => setTimeout(r, 5));
render(A, 2);                        // 复验在途期间同账号新会话
releaseVerify2();
await new Promise((r) => setTimeout(r, 10));
cleanupStale();

// ---------- 场景 3：epoch 变化后旧订阅的迟到事件不得触发复验 ----------
supabase.__reset();
render(A, 1);
api.bindPartner(PARTNER);
render(A, 1);
let revokedLate = 0;
let rpcCalls = 0;
supabase.__state.rpcImpl = () => { rpcCalls += 1; return Promise.resolve({ data: null, error: null }); };
const cleanupLate = api.subscribeAuthorization(PARTNER, () => { revokedLate += 1; });
const authCh3 = supabase.__liveChannels()[0].name;
render(A, 2);
supabase.__emit(authCh3, { new: { requester_id: PARTNER, addressee_id: A.id, status: 'revoked' } });
await new Promise((r) => setTimeout(r, 10));
cleanupLate();

process.stdout.write(JSON.stringify({ revokedNormal, revokedStale, revokedLate, rpcCalls }));
`);
    // 不误伤：正常撤销仍必须触发
    assert.equal(out.revokedNormal, 1, '服务端确认撤销时必须触发 onRevoked（隔离不误伤）');
    // AC-B3-03：epoch 变化后复验结果必须作废
    assert.equal(out.revokedStale, 0, 'epoch 变化后旧订阅复验结果不得触发 onRevoked');
    // AC-B3-03：epoch 变化后迟到事件不得触发复验
    assert.equal(out.revokedLate, 0, 'epoch 变化后旧订阅迟到事件不得触发 onRevoked');
    assert.equal(out.rpcCalls, 0, 'epoch 变化后旧订阅迟到事件不得发起复验 RPC');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B3-01：账号切换 effect 必须同时识别 userId 与 authEpoch 变化
// ---------------------------------------------------------------------------
test('AC-B3-01 账号切换 effect 同时识别 userId 与 authEpoch 变化', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');

const A = { id: 'user-aaa' };
const B = { id: 'user-bbb' };
const PARTNER = 'partner-xxx';
const getDateStr = () => '2026-11-19';

const rt = React.__createRuntime();
let api = null;
const render = (user, epoch) => { api = rt.render(() => useHealthCloud(user, getDateStr, epoch)); return api; };
// 槽位顺序：0=partnerData, 1=partnerId, 6=authGeneration（详见文件顶部说明）
const partnerIdState = () => rt.hooks[1].v;
const authGenState = () => rt.hooks[6].v;

// 初始渲染：不应误触发清理
supabase.__reset();
render(A, 1);
const genInitial = authGenState();

// 同账号同 epoch 重渲染：不得自增代际
render(A, 1);
const genSameRender = authGenState();

// 同账号新 epoch：必须自增代际并清空 partnerId
api.bindPartner(PARTNER);
render(A, 1);
const partnerBeforeEpoch = partnerIdState();
const genBeforeEpoch = authGenState();
render(A, 2);
const partnerAfterEpoch = partnerIdState();
const genAfterEpoch = authGenState();

// 换账号：必须自增代际并清空 partnerId
api.bindPartner(PARTNER);
render(A, 2);
const genBeforeUserSwitch = authGenState();
render(B, 1);
const partnerAfterUserSwitch = partnerIdState();
const genAfterUserSwitch = authGenState();

process.stdout.write(JSON.stringify({
  genInitial, genSameRender,
  partnerBeforeEpoch, genBeforeEpoch, partnerAfterEpoch, genAfterEpoch,
  genBeforeUserSwitch, partnerAfterUserSwitch, genAfterUserSwitch,
}));
`);
    assert.equal(out.genSameRender, out.genInitial, '同账号同 epoch 重渲染不得自增授权代际');
    assert.equal(out.partnerBeforeEpoch, 'partner-xxx', '绑定后 partnerId 应生效');
    assert.equal(out.partnerAfterEpoch, null, '同账号新 epoch 必须清空 partnerId');
    assert.ok(out.genAfterEpoch > out.genBeforeEpoch, '同账号新 epoch 必须自增授权代际');
    assert.equal(out.partnerAfterUserSwitch, null, '换账号必须清空 partnerId');
    assert.ok(out.genAfterUserSwitch > out.genBeforeUserSwitch, '换账号必须自增授权代际');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B3-05：源码契约 —— useHealthData 订阅 effect 依赖必须包含 authEpoch
// ---------------------------------------------------------------------------
test('AC-B3-05 源码契约 useHealthData 订阅 effect 依赖包含 authEpoch 且向 useHealthCloud 传入 authEpoch', () => {
  // P1.4 R6：useHealthData 已迁移为 .tsx，按 .tsx 优先、.js 兜底解析真实源码。
  const healthDataRel = ['src/hooks/useHealthData.tsx', 'src/hooks/useHealthData.js']
    .find((rel) => fs.existsSync(path.join(repoRoot, rel)));
  assert.ok(healthDataRel, '应能定位 useHealthData 源码（.tsx 或 .js）');
  const src = fs.readFileSync(path.join(repoRoot, healthDataRel), 'utf8');
  assert.match(
    src,
    /useHealthCloud\(\s*user\b[^,]*,\s*getDateStr,\s*authEpoch\s*\)/,
    'useHealthData 必须把 authEpoch 传给 useHealthCloud'
  );
  assert.match(
    src,
    /\[partnerId,\s*todayStr,\s*authGeneration,\s*authEpoch,\s*subscribePartner\]/,
    'subscribePartner effect 依赖必须包含 authEpoch'
  );
  assert.match(
    src,
    /\[partnerId,\s*authEpoch,\s*subscribeAuthorization,\s*clearPartner\]/,
    'subscribeAuthorization effect 依赖必须包含 authEpoch'
  );
});

// ---------------------------------------------------------------------------
// AC-B3-06：源码契约 —— bind_partner 页面级异步回调必须做身份快照校验
// ---------------------------------------------------------------------------
test('AC-B3-06 源码契约 bind_partner 页面级异步回调做身份快照校验', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/app/bind_partner.js'), 'utf8');
  assert.match(
    src,
    /import React,\s*\{\s*useState,\s*useEffect,\s*useRef,\s*useCallback\s*\}\s*from 'react'/,
    'bind_partner 必须导入 useRef / useCallback'
  );
  assert.match(src, /const \{ user, authEpoch \} = useAuth\(\)/, 'bind_partner 必须读取 authEpoch');
  assert.match(src, /const identityRef = useRef\(\{ userId: user\?\.id \?\? null, epoch: authEpoch \}\)/, '必须建立身份快照 ref');
  assert.match(src, /const isIdentityCurrent = useCallback\(/, '必须提供 isIdentityCurrent 校验函数');
  // loadData 的每个 await 边界后必须有校验
  const loadDataBlock = src.slice(src.indexOf('const loadData = async () => {'), src.indexOf('loadData();'));
  const guardCount = (loadDataBlock.match(/if \(!isIdentityCurrent\(origin\)\) return;/g) || []).length;
  assert.ok(guardCount >= 4, `loadData 内身份校验次数应 >= 4，实际 ${guardCount}`);
  // 绑定/解绑回调也必须有校验
  const bindBlock = src.slice(src.indexOf('const handleBindPartner'), src.indexOf('const handleUnbind'));
  assert.ok(
    (bindBlock.match(/if \(!isIdentityCurrent\(origin\)\) return;/g) || []).length >= 2,
    'handleBindPartner 内身份校验次数应 >= 2'
  );
  const unbindBlock = src.slice(src.indexOf('const handleUnbind'));
  assert.ok(
    (unbindBlock.match(/if \(!isIdentityCurrent\(origin\)\) return;/g) || []).length >= 1,
    'handleUnbind 内身份校验次数应 >= 1'
  );
  assert.match(
    src,
    /\}, \[user, authEpoch, globalPartnerId, isIdentityCurrent\]\);/,
    'loadData effect 依赖必须包含 authEpoch'
  );
});

// ---------------------------------------------------------------------------
// 源码契约：useHealthCloud 必须把 authEpoch 纳入全部搭子数据/订阅路径
// ---------------------------------------------------------------------------
test('源码契约 useHealthCloud 全路径纳入 authEpoch 闸门', () => {
  // P1.4 R8：useHealthCloud 已迁移为 .ts，按 .ts 优先、.js 兜底解析真实源码。
  const cloudRel = ['src/hooks/health/useHealthCloud.ts', 'src/hooks/health/useHealthCloud.js']
    .find((rel) => fs.existsSync(path.join(repoRoot, rel)));
  assert.ok(cloudRel, '应能定位 useHealthCloud 源码（.ts 或 .js）');
  const src = fs.readFileSync(path.join(repoRoot, cloudRel), 'utf8');

  // 1. 签名必须接收 authEpoch（默认 0，向后兼容）
  //    P1.4 R8：迁移后的 .ts 签名可能跨多行，正则需容忍换行与缩进。
  assert.match(
    src,
    /export function useHealthCloud\(\s*user\b[^,]*,\s*getDateStr\b[^,]*,\s*authEpoch\b[^=]*=\s*0\s*\)/,
    'useHealthCloud 签名必须接收 authEpoch'
  );

  // 2. 必须有 authEpochRef 镜像（供异步回调同步读取）
  assert.match(src, /const authEpochRef = useRef\(authEpoch\);/, '必须建立 authEpochRef 镜像');
  assert.match(src, /authEpochRef\.current = authEpoch;/, 'authEpochRef 必须随 authEpoch 同步更新');

  // 3. fetchPartnerRecord 必须同时比对 authGeneration 与 authEpoch（B3-02）
  const fetchBlock = src.slice(src.indexOf('const fetchPartnerRecord = useCallback'), src.indexOf('const applyPartnerRecord'));
  assert.match(
    fetchBlock,
    /const isStale = \(\)(?::\s*boolean)?\s*=>\s*gen !== authGenerationRef\.current \|\| epoch !== authEpochRef\.current;/,
    'fetchPartnerRecord 的 isStale 必须同时比对 authGeneration 与 authEpoch'
  );
  assert.doesNotMatch(
    fetchBlock,
    /gen !== authGenerationRef\.current\)/,
    'fetchPartnerRecord 不得残留仅比对 authGeneration 的旧判断'
  );

  // 4. subscribeAuthorization 必须同时比对 authGeneration 与 authEpoch（B3-03）
  const authSubBlock = src.slice(src.indexOf('const subscribeAuthorization = useCallback'), src.indexOf('const subscribePartner = useCallback'));
  assert.match(
    authSubBlock,
    /const isStale = \(\)(?::\s*boolean)?\s*=>\s*gen !== authGenerationRef\.current \|\| epoch !== authEpochRef\.current;/,
    'subscribeAuthorization 的 isStale 必须同时比对 authGeneration 与 authEpoch'
  );
  assert.match(authSubBlock, /isStale,\s*\n\s*\/\/[^\n]*\n\s*verify:/, '复验协调器必须使用统一的 isStale');
  assert.match(authSubBlock, /if \(isStale\(\)\) return;/, '授权事件回调必须使用 isStale 闸门');

  // 5. subscribePartner 必须比对 authEpoch（B3-04）
  const partnerSubBlock = src.slice(src.indexOf('const subscribePartner = useCallback'), src.indexOf('// 🔑 T6.1/FIX-05：账号切换时必须重置授权代际'));
  assert.match(partnerSubBlock, /const epoch = authEpochRef\.current;/, 'subscribePartner 必须快照 authEpoch');
  assert.match(
    partnerSubBlock,
    /if \(epoch !== authEpochRef\.current\) return;/,
    'subscribePartner 回调必须比对 authEpoch'
  );
  // 既有 partnerIdRef 闸门不得被移除（防回归）
  assert.match(
    partnerSubBlock,
    /if \(partnerIdRef\.current !== pId\) return;/,
    'subscribePartner 必须保留 partnerIdRef 闸门（防回归）'
  );

  // 6. 账号切换 effect 必须同时识别 userId 与 authEpoch（B3-01）
  assert.match(src, /const lastEpochRef = useRef\(authEpoch\);/, '必须建立 lastEpochRef');
  assert.match(src, /const epochChanged = lastEpochRef\.current !== nextEpoch;/, '必须计算 epochChanged');
  assert.match(src, /if \(!userChanged && !epochChanged\) return;/, 'userId 与 epoch 均未变时才提前返回');
  assert.match(
    src,
    /\}, \[user\?\.id, authEpoch, bumpAuthGeneration, tryFlushPending\]\);/,
    '账号切换 effect 依赖必须包含 authEpoch'
  );
});
// --- END OF FILE tests/security/b3PartnerRealtimeIsolation.test.mjs ---
// L4 boundary probes — run the actual bind_partner component logic with JSX rendering
// replaced by a state snapshot. The production async handlers and their awaits stay intact.
function makePartnerPageHarness(options = {}) {
  const source = fs.readFileSync(path.join(repoRoot, 'src/app/bind_partner.js'), 'utf8');
  const start = source.indexOf('export default function BindPartnerScreen() {');
  const stop = source.indexOf('  return (\n    <SafeAreaView', start);
  assert.ok(start >= 0 && stop > start, 'expected component source shape');
  const runnable = source.slice(start, stop).replace('export default function', 'function') +
    '  return {friends, boundPartnerId, loading, visibleFriends, visibleBoundPartnerId, visibleLoading, stateIsCurrentOwner, handleBindPartner, handleUnbind};\n}';
  const slots = [];
  let cursor = 0;
  let effects = [];
  let auth = {user: {id:'A'}, authEpoch: 1};
  const activity = { alerts: [], pushes: [], haptics: [] };
  const useState = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = {v: init};
    return [slots[i].v, (v) => { slots[i].v = typeof v === 'function' ? v(slots[i].v) : v; }];
  };
  const useRef = (v) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = {current: v};
    return slots[i];
  };
  const context = {
    useState, useRef,
    useEffect: (fn) => { cursor++; effects.push(fn); },
    useCallback: (fn) => { cursor++; return fn; },
    useAuth: () => auth,
    useAppTheme: () => ({colors: {}}),
    useRouter: () => ({back() { activity.back = true; }}),
    useHealthData: () => ({partnerId: (typeof options.globalPartnerId === 'function' ? options.globalPartnerId(auth.user?.id) : options.globalPartnerId) || null, refreshPartner: options.refreshPartner || (() => Promise.resolve())}),
    buildProfileCacheKey: (id) => `@user_profile_${id}`,
    AsyncStorage: {getItem: options.getItem || (() => Promise.resolve(null)), setItem: options.setItem || (() => Promise.resolve())},
    supabase: {
      rpc: options.rpc || (() => new Promise(() => {})),
      from: () => ({ select() {return this;}, eq() {return this;}, or() {return new Promise(() => {});}, in() {return new Promise(() => {});} }),
    },
    Alert: {alert(...args) { activity.alerts.push(args); }},
    Haptics: {
      ImpactFeedbackStyle: {Medium: 'Medium'}, NotificationFeedbackType: {Success:'Success'},
      impactAsync() {}, notificationAsync(value) {activity.haptics.push(value);},
    },
    sendPushNotification(...args) {activity.pushes.push(args);},
    Set, Date, JSON, console,
  };
  const component = vm.runInNewContext(runnable + '\nBindPartnerScreen;', context);
  return {
    slots, activity,
    render(id, epoch) {
      auth = {user: id ? {id} : null, authEpoch: epoch};
      cursor = 0; effects = [];
      const result = component();
      for (const effect of effects) effect();
      return result;
    },
  };
}
function l4Deferred() {
  let resolve;
  return {promise: new Promise((r) => {resolve = r;}), resolve: (v) => resolve(v)};
}
async function l4Flush() { for (let i=0;i<16;i++) await Promise.resolve(); }

test('L4-PROBE-01 delayed A local cache cannot populate B partner page', async () => {
  const late = l4Deferred();
  const page = makePartnerPageHarness({getItem: (key) => key === '@partner_page_data_A' ? late.promise : Promise.resolve(null)});
  page.render('A', 1);
  page.render('B', 2);
  late.resolve(JSON.stringify({friends:[{id:'A_friend'}], boundPartnerId:'A_partner'}));
  await l4Flush();
  assert.equal(page.slots[0].v.some((x) => x.id === 'A_friend'), false,
    'old A cache getItem must not put A friends into B state');
  assert.notEqual(page.slots[1].v, 'A_partner', 'old A cached partner cannot appear in B state');
});

test('L4-PROBE-02 old invite must not send push or show success after asynchronous cache write and account switch', async () => {
  const pendingWrite = l4Deferred();
  const page = makePartnerPageHarness({
    rpc: (name) => name === 'request_partner' ? Promise.resolve({data:'invite-1',error:null}) : new Promise(() => {}),
    setItem: (key) => key.startsWith('@chatMessages_') ? pendingWrite.promise : Promise.resolve(),
  });
  const a = page.render('A', 1);
  a.handleBindPartner('P','Partner');
  const dialog = page.activity.alerts.at(-1);
  const action = dialog[2].find((option) => option.text === '发送邀请').onPress();
  await l4Flush();
  page.render('B', 2);
  pendingWrite.resolve();
  await action;
  assert.equal(page.activity.pushes.length, 0, 'old A callback must not send push after session switch');
  assert.equal(page.activity.alerts.some((a) => a[0] === '邀请已发送'), false,
    'old A callback must not display success dialog in B session');
});

test('L4-PROBE-03 old unbind must not apply success haptics or loading state after asynchronous refresh and account switch', async () => {
  const pendingRefresh = l4Deferred();
  const page = makePartnerPageHarness({
    rpc: (name) => name === 'unbind_partner' ? Promise.resolve({error:null}) : new Promise(() => {}),
    refreshPartner: () => pendingRefresh.promise,
  });
  const a = page.render('A',1);
  a.handleUnbind();
  const dialog = page.activity.alerts.at(-1);
  const action = dialog[2].find((option) => option.text === '解除').onPress();
  await l4Flush();
  page.render('B',2);
  pendingRefresh.resolve(); await action;
  assert.equal(page.activity.haptics.length, 0,
    'old A async refresh completion must not signal a success haptic in B session');
});

test('L4-PROBE-04 rebinding same partner invalidates old authorization generation realtime callback', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React = await import('react');
const { supabase } = await import('./src/services/supabase.js');
const { useHealthCloud } = await import('./src/hooks/health/useHealthCloud.js');
const rt=React.__createRuntime(); const A={id:'A'}, P='P', D='2026-11-19';
let api=rt.render(()=>useHealthCloud(A,()=>D,1));
api.bindPartner(P); api=rt.render(()=>useHealthCloud(A,()=>D,1));
const unsubscribe=api.subscribePartner(P,D);
const oldHandler=supabase.__liveChannels()[0].handlers[0].cb;
api.bindPartner(P); // same partner, new authorization generation
oldHandler({new:{record_date:D, water_amount:9999, meals_status:{}}});
const staleData=rt.hooks[0].v.waterAmount;
unsubscribe(); process.stdout.write(JSON.stringify({staleData}));
`);
    assert.equal(out.staleData, 0,
      'old channel must be rejected immediately upon authGeneration change even when partnerId/epoch match');
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test('L4-PROBE-05 partner state must be owner/epoch masked during first render before effects', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const React=await import('react');
const {supabase}=await import('./src/services/supabase.js');
const {useHealthCloud}=await import('./src/hooks/health/useHealthCloud.js');
const rt=React.__createRuntime(); const A={id:'A'},B={id:'B'},P='P',D='2026-11-19';
let api=rt.render(()=>useHealthCloud(A,()=>D,1));
api.bindPartner(P);api=rt.render(()=>useHealthCloud(A,()=>D,1));
const cleanup=api.subscribePartner(P,D);
supabase.__emit(supabase.__liveChannels()[0].name,{new:{record_date:D,water_amount:777,meals_status:{}}});
// First B render occurs before useEffect cleans up the old A identity.
const firstB=rt.renderOnly(()=>useHealthCloud(B,()=>D,2));
cleanup();process.stdout.write(JSON.stringify({water:firstB.partnerData.waterAmount,partner:firstB.partnerId}));
`);
    assert.equal(out.partner, null, 'B first render must not expose A partner id');
    assert.equal(out.water, 0, 'B first render must not expose A partner health data');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('L4-R1-VERIFY-06 owner claim before B friends fetch does not resurrect A friends', async () => {
  const bRPC = l4Deferred();
  const page = makePartnerPageHarness({
    getItem: (key) => key==='@partner_page_data_A'
      ? Promise.resolve(JSON.stringify({friends:[{id:'A_private_friend'}], boundPartnerId:'A_partner'}))
      : Promise.resolve(null),
    rpc: (name) => name==='get_active_partner_id' ? bRPC.promise : new Promise(() => {}),
  });
  page.render('A',1); await l4Flush();
  const a = page.render('A',1);
  assert.ok(a.visibleFriends.some((f) => f.id==='A_private_friend'), 'A cached friend should be visible in A');
  page.render('B',2); await l4Flush();
  const bBefore = page.render('B',2);
  assert.equal(bBefore.visibleFriends.length,0, 'B first render should mask A');
  bRPC.resolve({data:'B_partner',error:null}); await l4Flush();
  const bAfter = page.render('B',2);
  assert.equal(bAfter.visibleFriends.some((f) => f.id==='A_private_friend'),false,
    'after B RPC but before B profiles fetch, A cached friends must remain invisible');
});

test('L4-R1-VERIFY-07 offline B account cache becomes visible after account switch even if RPC fails', async () => {
  const page = makePartnerPageHarness({
    getItem: (key) => {
      if (key==='@partner_page_data_A') return Promise.resolve(JSON.stringify({friends:[{id:'A_friend'}], boundPartnerId:'A_partner'}));
      if (key==='@partner_page_data_B') return Promise.resolve(JSON.stringify({friends:[{id:'B_friend'}], boundPartnerId:'B_partner'}));
      return Promise.resolve(null);
    },
    rpc: () => Promise.reject(new Error('offline')),
  });
  page.render('A',1); await l4Flush();
  const a = page.render('A',1);
  assert.equal(a.visibleFriends.some(f=>f.id==='A_friend'),true);
  page.render('B',2); await l4Flush();
  const b = page.render('B',2);
  assert.equal(b.visibleFriends.some(f=>f.id==='B_friend'),true,
    'B valid offline cached friends should be shown after switch even when RPC is unavailable');
  assert.equal(b.visibleBoundPartnerId,'B_partner', 'B cached partner should be shown');
  assert.equal(b.visibleLoading,false, 'B offline valid cache should leave loading state');
});

// L4-R2 targeted offline UX regression: current-owner global partner fallback.
test('L4-R2-FINAL B global partner must survive switch from cached A when B has no page cache offline', async () => {
  const page = makePartnerPageHarness({
    globalPartnerId: (id) => id === 'A' ? 'A_partner' : id === 'B' ? 'B_partner' : null,
    getItem: (key) => key === '@partner_page_data_A'
      ? Promise.resolve(JSON.stringify({friends:[{id:'A_friend'}], boundPartnerId:'A_partner'}))
      : Promise.resolve(null),
    rpc: () => Promise.reject(new Error('offline')),
  });
  page.render('A', 1); await l4Flush(); page.render('A', 1);
  page.render('B', 2); await l4Flush();
  const b = page.render('B', 2);
  assert.equal(b.visibleBoundPartnerId, 'B_partner',
    'B current global partner fallback must not be skipped by stale A raw boundPartnerId');
  assert.equal(b.visibleFriends.some(f => f.id === 'A_friend'), false,
    'A friends must remain invisible after B fallback');
  assert.equal(b.visibleLoading, false, 'offline fallback must stop loading');
});
