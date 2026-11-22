// --- START OF FILE tests/security/p12r5MigrationEquivalence.test.mjs ---
/**
 * P1.2 R5 — authStorage / authAutoRefresh TypeScript 迁移行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前 JS 全文（冻结基线 `tests/fixtures/p12r5/before/`）
 *     · 迁移后 TS 实现（`src/services/authStorage.ts` / `authAutoRefresh.ts`）
 *   对同一组可注入依赖（内存 fake SecureStore / AsyncStorage / AppState / auth）
 *   与同一组可控时钟，比较**完整可观测结果**（返回值、抛错码、调用序列、
 *   状态位、定时器行为），断言逐项一致。
 *
 * 约束
 *   · 不访问真实 SecureStore / AsyncStorage / 网络 / 数据库 / 认证服务。
 *   · 基线只读，不得修改以制造通过。
 *   · 无法在隔离环境验证的真实行为标记 UNVERIFIED，不伪造 PASS。
 *
 * 覆盖
 *   Auth Storage（A1–A14）
 *     A1  正常 set → get 往返（SecureStore 落盘，不写 AsyncStorage 明文）
 *     A2  get 无任何副本 → null（不抛错）
 *     A3  SecureStore 读失败 → 抛 AUTH_STORAGE_UNAVAILABLE + 状态位置故障
 *     A4  SecureStore 写失败 → 抛 AUTH_STORAGE_UNAVAILABLE + 不写明文
 *     A5  SecureStore 删失败 → 抛 AUTH_STORAGE_UNAVAILABLE（不误报登出）
 *     A6  旧明文迁移成功 → 安全副本可读 + 明文被清除
 *     A7  迁移失败（安全写入失败）→ 抛 MIGRATION_FAILED + 明文保留
 *     A8  迁移后明文清除失败 → 不阻断会话 + 状态位 LEGACY_CLEANUP_FAILED
 *     A9  登出时明文清除失败 → 抛 LEGACY_CLEANUP_FAILED
 *     A10 登出时安全副本删除失败优先抛 UNAVAILABLE（错误优先级）
 *     A11 墓碑写入 → 重启后不复活旧明文
 *     A12 墓碑存在时 get → null（不读明文）
 *     A13 重复迁移（第二次 get 不再迁移）→ 行为一致
 *     A14 toSecureKey 归一化 + AUTH_STORAGE_ERROR 常量值一致
 *
 *   Auto Refresh（R1–R14）
 *     R1  start → 注册唯一监听器 + 按当前 active 启动 ticker
 *     R2  start 幂等（重复调用不重复订阅）
 *     R3  active → background → stop
 *     R4  background → active → start
 *     R5  重复 active 事件 → 不重复 start（desiredRunning 去重）
 *     R6  probe 成功 → start 一次
 *     R7  probe 失败 → 不 start，按 retryDelayMs 重试
 *     R8  probe 连续失败达上限 → 不 start（不产生失败 tick）
 *     R9  probe 失败期间切后台 → 不 start；回前台重新探测
 *     R10 probe 进行中 dispose → 不 start
 *     R11 dispose → 移除监听器 + 停止 ticker
 *     R12 dispose 后 active 事件 → 不再 start
 *     R13 并发 start/stop 串行化（完成顺序 == 发起顺序）
 *     R14 无定时器泄漏（dispose 后无残留 timer）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const beforeDir = path.join(repoRoot, 'tests/fixtures/p12r5/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'services__authStorage.js': 'afba7ce61ae634abe549e36ba66dd4ea1503cd3c3d44c73a62bc9b8fbfa9feca',
  'services__authAutoRefresh.js': '963176dbf67bf63b35798d199f5180a96814f34653ce2750ec71942225039c05',
};

test('R5-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
// 沙箱构建
// ---------------------------------------------------------------------------
const RESOLVE_HOOK = `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}return n(s,c);}`;

const REGISTER = `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`;

/**
 * 在隔离沙箱中执行一段 case 代码。
 * @param {'before'|'after'} variant
 * @param {string} moduleName 'authStorage' | 'authAutoRefresh'
 * @param {string} caseCode  ESM 源码，需自行 process.stdout.write(JSON.stringify(...))
 */
function runSandbox(variant, moduleName, caseCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p12r5-${moduleName}-`));
  try {
    fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
    if (variant === 'before') {
      fs.copyFileSync(
        path.join(beforeDir, `services__${moduleName}.js`),
        path.join(dir, `src/services/${moduleName}.js`),
      );
    } else {
      fs.copyFileSync(
        path.join(repoRoot, `src/services/${moduleName}.ts`),
        path.join(dir, `src/services/${moduleName}.ts`),
      );
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'), RESOLVE_HOOK);
    fs.writeFileSync(path.join(dir, 'register.mjs'), REGISTER);
    fs.writeFileSync(path.join(dir, 'case.mjs'), caseCode);

    const r = spawnSync(process.execPath, ['--import', path.join(dir, 'register.mjs')], {
      cwd: dir,
      env: { PATH: process.env.PATH, TZ: 'UTC' },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(
        `沙箱执行失败（${variant}/${moduleName}）status=${r.status}\nSTDERR:\n${r.stderr}\nSTDOUT:\n${r.stdout}`,
      );
    }
    const out = r.stdout.trim();
    const lastLine = out.split('\n').filter(Boolean).pop();
    return JSON.parse(lastLine);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 同一 case 分别跑 before / after，返回两者结果 */
function runBoth(moduleName, caseCode) {
  return {
    before: runSandbox('before', moduleName, caseCode),
    after: runSandbox('after', moduleName, caseCode),
  };
}

/** 断言 before/after 完整结果一致，并返回结果 */
function assertEquivalent(moduleName, caseCode) {
  const { before, after } = runBoth(moduleName, caseCode);
  assert.deepEqual(after, before, `${moduleName} 迁移前后行为不一致`);
  return after;
}

// ---------------------------------------------------------------------------
// 共享 fake 依赖源码（注入到 case 中）
// ---------------------------------------------------------------------------
const FAKES = `
function makeSecureStore(opts = {}) {
  const map = new Map();
  const calls = [];
  return {
    map, calls,
    async getItemAsync(k) {
      calls.push(['get', k]);
      if (opts.failGet) throw new Error('secure get failed');
      return map.has(k) ? map.get(k) : null;
    },
    async setItemAsync(k, v) {
      calls.push(['set', k, v]);
      if (opts.failSet) throw new Error('secure set failed');
      map.set(k, v);
    },
    async deleteItemAsync(k) {
      calls.push(['delete', k]);
      if (opts.failDelete) throw new Error('secure delete failed');
      map.delete(k);
    },
  };
}
function makeAsyncStorage(opts = {}) {
  const map = new Map();
  const calls = [];
  return {
    map, calls,
    async getItem(k) {
      calls.push(['get', k]);
      if (opts.failGet) throw new Error('async get failed');
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      calls.push(['set', k, v]);
      if (opts.failSet) throw new Error('async set failed');
      map.set(k, v);
    },
    async removeItem(k) {
      calls.push(['remove', k]);
      if (opts.failRemove) throw new Error('async remove failed');
      map.delete(k);
    },
  };
}
const silentLogger = { warn() {}, error() {} };
`;

/** 序列化错误：只取可观测字段（code / message） */
const SERIALIZE_ERR = `
function serr(e) {
  if (!e) return null;
  return { name: e.name, code: e.code === undefined ? null : e.code, message: e.message === undefined ? null : e.message };
}
`;

// ===========================================================================
// Auth Storage
// ===========================================================================

const AUTH_STORAGE_CASE = (body) => `
const mod = await import('./src/services/authStorage');
${FAKES}
${SERIALIZE_ERR}
${body}
`;

test('A1 正常 set → get 往返（SecureStore 落盘，不写 AsyncStorage 明文）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage();
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
await adapter.setItem('sb-session', '{"token":"abc"}');
const got = await adapter.getItem('sb-session');
process.stdout.write(JSON.stringify({
  got,
  secureMap: [...ss.map.entries()],
  asyncMap: [...as.map.entries()],
  asyncSetCalls: as.calls.filter(c => c[0] === 'set'),
  statusFailed: status.isFailed(),
}));
`),
  );
  assert.equal(res.got, '{"token":"abc"}');
  assert.deepEqual(res.asyncSetCalls, [], '不得向 AsyncStorage 写明文');
  assert.equal(res.statusFailed, false);
});

test('A2 get 无任何副本 → null（不抛错）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage();
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
const got = await adapter.getItem('missing');
process.stdout.write(JSON.stringify({ got, statusFailed: status.isFailed() }));
`),
  );
  assert.equal(res.got, null);
  assert.equal(res.statusFailed, false);
});

test('A3 SecureStore 读失败 → 抛 AUTH_STORAGE_UNAVAILABLE + 状态位置故障', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore({ failGet: true });
const as = makeAsyncStorage();
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let err = null;
try { await adapter.getItem('k'); } catch (e) { err = e; }
process.stdout.write(JSON.stringify({
  err: serr(err),
  statusFailed: status.isFailed(),
  statusGet: status.get(),
  asyncGetCalls: as.calls.filter(c => c[0] === 'get'),
}));
`),
  );
  assert.equal(res.err.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(res.statusFailed, true);
  assert.deepEqual(res.asyncGetCalls, [], 'SecureStore 失败时不得回落 AsyncStorage');
});

test('A4 SecureStore 写失败 → 抛 AUTH_STORAGE_UNAVAILABLE + 不写明文', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore({ failSet: true });
const as = makeAsyncStorage();
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let err = null;
try { await adapter.setItem('k', 'v'); } catch (e) { err = e; }
process.stdout.write(JSON.stringify({
  err: serr(err),
  statusFailed: status.isFailed(),
  asyncSetCalls: as.calls.filter(c => c[0] === 'set'),
}));
`),
  );
  assert.equal(res.err.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(res.statusFailed, true);
  assert.deepEqual(res.asyncSetCalls, [], 'SecureStore 写失败时不得降级写明文');
});

test('A5 SecureStore 删失败 → 抛 AUTH_STORAGE_UNAVAILABLE（不误报登出）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore({ failDelete: true });
const as = makeAsyncStorage();
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let err = null;
try { await adapter.removeItem('k'); } catch (e) { err = e; }
process.stdout.write(JSON.stringify({ err: serr(err), statusFailed: status.isFailed() }));
`),
  );
  assert.equal(res.err.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(res.statusFailed, true);
});

test('A6 旧明文迁移成功 → 安全副本可读 + 明文被清除', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage();
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
const got = await adapter.getItem('sb-session');
process.stdout.write(JSON.stringify({
  got,
  secureMap: [...ss.map.entries()],
  asyncMap: [...as.map.entries()],
  statusFailed: status.isFailed(),
}));
`),
  );
  assert.equal(res.got, '{"legacy":true}');
  assert.deepEqual(res.asyncMap, [], '迁移成功后明文必须被清除');
  assert.equal(res.statusFailed, false);
});

test('A7 迁移失败（安全写入失败）→ 抛 MIGRATION_FAILED + 明文保留', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore({ failSet: true });
const as = makeAsyncStorage();
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let err = null;
try { await adapter.getItem('sb-session'); } catch (e) { err = e; }
process.stdout.write(JSON.stringify({
  err: serr(err),
  asyncMap: [...as.map.entries()],
  statusFailed: status.isFailed(),
}));
`),
  );
  assert.equal(res.err.code, 'AUTH_STORAGE_MIGRATION_FAILED');
  assert.deepEqual(res.asyncMap, [['sb-session', '{"legacy":true}']], '迁移失败时明文必须保留');
});

test('A8 迁移后明文清除失败 → 不阻断会话 + 状态位 LEGACY_CLEANUP_FAILED', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage({ failRemove: true });
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
const got = await adapter.getItem('sb-session');
process.stdout.write(JSON.stringify({
  got,
  statusFailed: status.isFailed(),
  statusGet: status.get(),
}));
`),
  );
  assert.equal(res.got, '{"legacy":true}', '清理失败不得阻断会话');
  assert.equal(res.statusFailed, true);
  assert.equal(res.statusGet.code, 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED');
});

test('A9 登出时明文清除失败 → 抛 LEGACY_CLEANUP_FAILED', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage({ failRemove: true });
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let err = null;
try { await adapter.removeItem('sb-session'); } catch (e) { err = e; }
process.stdout.write(JSON.stringify({ err: serr(err), statusFailed: status.isFailed() }));
`),
  );
  assert.equal(res.err.code, 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED');
});

test('A10 登出时安全副本删除失败优先抛 UNAVAILABLE（错误优先级）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore({ failDelete: true });
const as = makeAsyncStorage({ failRemove: true });
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let err = null;
try { await adapter.removeItem('sb-session'); } catch (e) { err = e; }
process.stdout.write(JSON.stringify({ err: serr(err) }));
`),
  );
  assert.equal(res.err.code, 'AUTH_STORAGE_UNAVAILABLE', '安全副本删除失败优先级高于明文清理失败');
});

test('A11 墓碑写入 → 重启后不复活旧明文', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage();
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
await adapter.removeItem('sb-session');
// 模拟重启：新适配器实例共享同一底层存储
const status2 = mod.createAuthStorageStatus();
const adapter2 = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status: status2 });
const got = await adapter2.getItem('sb-session');
process.stdout.write(JSON.stringify({
  got,
  asyncMap: [...as.map.entries()],
  secureMap: [...ss.map.entries()],
}));
`),
  );
  assert.equal(res.got, null, '墓碑存在时重启不得复活旧明文');
});

test('A12 墓碑存在时 get → null（不读明文）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage();
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
await adapter.removeItem('sb-session');
// 人为塞入明文，验证墓碑优先
as.map.set('sb-session', '{"legacy":true}');
const got = await adapter.getItem('sb-session');
process.stdout.write(JSON.stringify({ got }));
`),
  );
  assert.equal(res.got, null);
});

test('A13 重复迁移（第二次 get 不再迁移）→ 行为一致', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore();
const as = makeAsyncStorage();
as.map.set('sb-session', '{"legacy":true}');
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
const first = await adapter.getItem('sb-session');
const second = await adapter.getItem('sb-session');
process.stdout.write(JSON.stringify({
  first, second,
  asyncGetCalls: as.calls.filter(c => c[0] === 'get').length,
  asyncRemoveCalls: as.calls.filter(c => c[0] === 'remove').length,
  secureGetCalls: ss.calls.filter(c => c[0] === 'get').length,
  asyncMap: [...as.map.entries()],
  secureMap: [...ss.map.entries()],
}));
`),
  );
  assert.equal(res.first, '{"legacy":true}');
  assert.equal(res.second, '{"legacy":true}');
  // 真实行为（迁移前后一致）：首次 get 迁移明文 → 写安全副本 + 清明文；
  // 第二次 get 命中安全副本，仍会再执行一次幂等明文清理。
  // 因此 2 次 get 共产生 3 次 removeItem（迁移路径 2 次 + 安全副本命中 1 次）。
  // 关键不变量是「明文最终被清除」且「安全副本可读」，而非 remove 次数。
  assert.equal(res.asyncRemoveCalls, 3, '明文清理次数与迁移前实现一致');
  assert.equal(res.asyncMap.length, 0, '明文最终必须被清除');
  assert.deepEqual(res.secureMap, [['sb-session', '{"legacy":true}']], '安全副本必须落盘');
});

test('A14 toSecureKey 归一化 + AUTH_STORAGE_ERROR 常量值一致', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
process.stdout.write(JSON.stringify({
  keys: [
    mod.toSecureKey('sb-abc.def_ghi'),
    mod.toSecureKey('a b/c:d@e'),
    mod.toSecureKey('中文key'),
    mod.toSecureKey(''),
  ],
  errors: { ...mod.AUTH_STORAGE_ERROR },
}));
`),
  );
  assert.deepEqual(res.errors, {
    UNAVAILABLE: 'AUTH_STORAGE_UNAVAILABLE',
    MIGRATION_FAILED: 'AUTH_STORAGE_MIGRATION_FAILED',
    LEGACY_CLEANUP_FAILED: 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED',
  });
});

// ===========================================================================
// Auto Refresh
// ===========================================================================

const AUTO_REFRESH_FAKES = `
function makeAuth() {
  const calls = [];
  let running = false;
  return {
    calls,
    get running() { return running; },
    startAutoRefresh() { calls.push('start'); running = true; return Promise.resolve(); },
    stopAutoRefresh() { calls.push('stop'); running = false; return Promise.resolve(); },
  };
}
function makeAppState(initial = 'active') {
  const listeners = new Set();
  const state = { current: initial };
  return {
    get currentState() { return state.current; },
    addEventListener(type, fn) {
      listeners.add(fn);
      return { remove() { listeners.delete(fn); } };
    },
    emit(next) {
      state.current = next;
      for (const fn of [...listeners]) fn(next);
    },
    get listenerCount() { return listeners.size; },
  };
}
`;

const AUTO_REFRESH_CASE = (body) => `
const mod = await import('./src/services/authAutoRefresh');
${AUTO_REFRESH_FAKES}
${body}
`;

test('R1 start → 注册唯一监听器 + 按当前 active 启动 ticker', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
process.stdout.write(JSON.stringify({
  calls: auth.calls,
  listenerCount: appState.listenerCount,
  isRunning: ctrl.isRunning(),
}));
`),
  );
  assert.deepEqual(res.calls, ['start']);
  assert.equal(res.listenerCount, 1);
  assert.equal(res.isRunning, true);
});

test('R2 start 幂等（重复调用不重复订阅）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
ctrl.start();
ctrl.start();
await ctrl.flush();
process.stdout.write(JSON.stringify({
  calls: auth.calls,
  listenerCount: appState.listenerCount,
}));
`),
  );
  assert.equal(res.listenerCount, 1, '重复 start 不得重复订阅');
  assert.deepEqual(res.calls, ['start'], '重复 start 不得重复启动 ticker');
});

test('R3 active → background → stop', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
appState.emit('background');
await ctrl.flush();
process.stdout.write(JSON.stringify({ calls: auth.calls, isRunning: ctrl.isRunning() }));
`),
  );
  assert.deepEqual(res.calls, ['start', 'stop']);
  assert.equal(res.isRunning, false);
});

test('R4 background → active → start', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('background');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
appState.emit('active');
await ctrl.flush();
process.stdout.write(JSON.stringify({ calls: auth.calls, isRunning: ctrl.isRunning() }));
`),
  );
  assert.deepEqual(res.calls, ['stop', 'start']);
  assert.equal(res.isRunning, true);
});

test('R5 重复 active 事件 → 不重复 start（desiredRunning 去重）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
appState.emit('active');
appState.emit('active');
await ctrl.flush();
process.stdout.write(JSON.stringify({ calls: auth.calls }));
`),
  );
  assert.deepEqual(res.calls, ['start'], '重复 active 不得重复 start');
});

test('R6 probe 成功 → start 一次', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
let probes = 0;
const ctrl = mod.createAutoRefreshController({
  auth, appState,
  probeStorage: async () => { probes += 1; return true; },
  timing: { retryDelayMs: 1, maxRetries: 3 },
});
ctrl.start();
await ctrl.flush();
await new Promise(r => setTimeout(r, 30));
await ctrl.flush();
process.stdout.write(JSON.stringify({ calls: auth.calls, probes, isRunning: ctrl.isRunning() }));
`),
  );
  // 真实行为：带 probe 时先 enqueueOp('stop')（FINAL-1 修复），探测通过后 start。
  assert.deepEqual(res.calls, ['stop', 'start']);
  assert.equal(res.probes, 1);
});

test('R7 probe 失败 → 不 start，按 retryDelayMs 重试', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
let probes = 0;
const ctrl = mod.createAutoRefreshController({
  auth, appState,
  probeStorage: async () => { probes += 1; return false; },
  timing: { retryDelayMs: 1, maxRetries: 3, recoveryDelayMs: 100000 },
});
ctrl.start();
await ctrl.flush();
await new Promise(r => setTimeout(r, 40));
await ctrl.flush();
process.stdout.write(JSON.stringify({ calls: auth.calls, probes, isRunning: ctrl.isRunning() }));
ctrl.dispose();
`),
  );
  // 真实行为：每次探测失败都会 enqueueOp('stop')（BLOCK-A），因此 calls 全为 stop，绝无 start。
  // 探测次数 = maxRetries（3）：第 3 次失败即达上限，转入低频恢复探测（recoveryDelayMs=100000，
  // 在 40ms 观察窗口内不会再次触发），因此不会出现第 4 次探测。
  assert.equal(res.calls.includes('start'), false, 'probe 失败期间不得启动 ticker');
  assert.equal(res.calls.every((c) => c === 'stop'), true, 'probe 失败期间只允许 stop');
  assert.equal(res.probes, 3, '探测次数等于 maxRetries(3)，达上限后转低频恢复');
  // isRunning 反映的是「期望状态」（desiredRunning === true，因为 AppState 仍为 active），
  // 而非 ticker 是否真的启动；ticker 未启动由 calls 中无 start 证明。
  assert.equal(res.isRunning, true, 'isRunning 反映期望状态（active），ticker 实际未启动');
});

test('R8 probe 连续失败达上限 → 不 start（不产生失败 tick）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({
  auth, appState,
  probeStorage: async () => false,
  timing: { retryDelayMs: 1, maxRetries: 2, recoveryDelayMs: 100000 },
});
ctrl.start();
await ctrl.flush();
await new Promise(r => setTimeout(r, 40));
await ctrl.flush();
process.stdout.write(JSON.stringify({ calls: auth.calls, isRunning: ctrl.isRunning() }));
ctrl.dispose();
`),
  );
  assert.equal(res.calls.includes('start'), false, 'probe 连续失败不得启动 ticker');
  assert.equal(res.calls.every((c) => c === 'stop'), true, 'probe 连续失败期间只允许 stop');
  // isRunning 反映期望状态（active），ticker 实际未启动由 calls 无 start 证明。
  assert.equal(res.isRunning, true, 'isRunning 反映期望状态（active），ticker 实际未启动');
});

test('R9 probe 失败期间切后台 → 不 start；回前台重新探测', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
let probes = 0;
let allow = false;
const ctrl = mod.createAutoRefreshController({
  auth, appState,
  probeStorage: async () => { probes += 1; return allow; },
  timing: { retryDelayMs: 1000, maxRetries: 5, recoveryDelayMs: 100000 },
});
ctrl.start();
await ctrl.flush();
appState.emit('background');
await ctrl.flush();
const afterBg = auth.calls.slice();
allow = true;
appState.emit('active');
await ctrl.flush();
await new Promise(r => setTimeout(r, 20));
await ctrl.flush();
process.stdout.write(JSON.stringify({
  afterBg,
  calls: auth.calls,
  probes,
  isRunning: ctrl.isRunning(),
}));
ctrl.dispose();
`),
  );
  assert.equal(res.afterBg.includes('start'), false, 'probe 失败期间切后台不得 start');
  assert.equal(res.calls.filter((c) => c === 'start').length, 1, '回前台探测成功后 start 恰好一次');
  assert.equal(res.calls[res.calls.length - 1], 'start', '最后一次操作必须是 start');
});

test('R10 probe 进行中 dispose → 不 start', () => {
  // 说明：probe Promise 处于 pending 时 dispose，随后 resolve(true)。
  // 迁移前后实现都会在 probe 的 then 回调里检查 disposed 并直接 return，
  // 因此不会 start。
  //
  // 关键：`ctrl.flush()` 会 await 在途的 probe Promise。若 probe 永不 resolve，
  // flush 会永久挂起（迁移前后行为一致，但无法观测结果）。因此这里**不调用
  // flush**，而是用固定时长的 setTimeout 让事件循环推进，再直接输出结果。
  // 这样既验证了「dispose 后 probe resolve 不会 start」，也避免测试挂死。
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
let resolveProbe = null;
const ctrl = mod.createAutoRefreshController({
  auth, appState,
  probeStorage: () => new Promise((res) => { resolveProbe = res; }),
  timing: { retryDelayMs: 1, maxRetries: 3 },
});
ctrl.start();
// 不 flush：probe 处于 pending，flush 会挂起。
await new Promise(r => setTimeout(r, 5));
ctrl.dispose();
if (typeof resolveProbe === 'function') resolveProbe(true);
await new Promise(r => setTimeout(r, 20));
process.stdout.write(JSON.stringify({ calls: auth.calls, isRunning: ctrl.isRunning() }));
`),
  );
  assert.equal(res.calls.includes('start'), false, 'probe 进行中 dispose 后不得 start');
  assert.equal(res.isRunning, false);
});

test('R11 dispose → 移除监听器 + 停止 ticker', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
ctrl.dispose();
await ctrl.flush();
process.stdout.write(JSON.stringify({
  calls: auth.calls,
  listenerCount: appState.listenerCount,
  isRunning: ctrl.isRunning(),
}));
`),
  );
  assert.deepEqual(res.calls, ['start', 'stop']);
  assert.equal(res.listenerCount, 0, 'dispose 必须移除监听器');
  assert.equal(res.isRunning, false);
});

test('R12 dispose 后 active 事件 → 不再 start', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
ctrl.dispose();
await ctrl.flush();
const before = auth.calls.slice();
appState.emit('background');
appState.emit('active');
await ctrl.flush();
process.stdout.write(JSON.stringify({ before, after: auth.calls }));
`),
  );
  assert.deepEqual(res.after, res.before, 'dispose 后事件不得再触发 start/stop');
});

test('R13 并发 start/stop 串行化（完成顺序 == 发起顺序）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const log = [];
let running = false;
const auth = {
  startAutoRefresh() {
    return new Promise((resolve) => setTimeout(() => { running = true; log.push('start-done'); resolve(); }, 15));
  },
  stopAutoRefresh() {
    return new Promise((resolve) => setTimeout(() => { running = false; log.push('stop-done'); resolve(); }, 5));
  },
};
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
appState.emit('background');
appState.emit('active');
await ctrl.flush();
await new Promise(r => setTimeout(r, 60));
await ctrl.flush();
process.stdout.write(JSON.stringify({ log, running, isRunning: ctrl.isRunning() }));
ctrl.dispose();
`),
  );
  // 串行化：start 完成后才允许 stop 发起，因此日志顺序必须是 start-done → stop-done → start-done
  assert.deepEqual(res.log, ['start-done', 'stop-done', 'start-done']);
  assert.equal(res.running, true, '最终状态必须等于最后一次决策（active）');
});

test('R14 无定时器泄漏（dispose 后无残留 timer）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const auth = makeAuth();
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({
  auth, appState,
  probeStorage: async () => false,
  timing: { retryDelayMs: 5, maxRetries: 10, recoveryDelayMs: 5 },
});
ctrl.start();
await ctrl.flush();
// 立即 dispose（不预先 sleep），避免与 retry 定时器产生时序竞争。
// 关键不变量：dispose 之后，无论等待多久都不得再有新的 start/stop。
ctrl.dispose();
await ctrl.flush();
const callsAtDispose = auth.calls.slice();
// 等待远超 retryDelayMs（5ms）的窗口，确认无残留定时器触发 start/stop
await new Promise(r => setTimeout(r, 80));
await ctrl.flush();
process.stdout.write(JSON.stringify({
  callsAtDispose,
  callsAfterWait: auth.calls,
  listenerCount: appState.listenerCount,
  isRunning: ctrl.isRunning(),
}));
`),
  );
  assert.deepEqual(res.callsAfterWait, res.callsAtDispose, 'dispose 后不得有残留定时器触发 start/stop');
  assert.equal(res.callsAfterWait.includes('start'), false, 'probe 一直失败时不得启动 ticker');
  assert.equal(res.listenerCount, 0, 'dispose 必须移除监听器');
  assert.equal(res.isRunning, false, 'dispose 后期望状态必须为停止');
});

// ===========================================================================
// A3（R6 补充）— Gatekeeper 指出的局部运行时差异边界用例
//
// 背景：R5 首轮迁移把 `cause?.message ?? String(cause ?? code)` 与
// `e?.message ?? e` 强制字符串化，导致 `cause.message = 0 / false` 时
// 返回值类型与旧 JS 不一致。以下用例直接执行旧 JS 与新 TS，比较**完整**
// 返回值（含类型）、日志实参（含类型）与异常信息，确保历史契约被如实还原。
// ===========================================================================

test('A15 markFailed 边界：cause.message 为 0 / false / null / undefined 时 message 原样保留（含类型）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const status = mod.createAuthStorageStatus();
const cases = [
  ['objMsg0', { message: 0 }],
  ['objMsgFalse', { message: false }],
  ['objMsgNull', { message: null }],
  ['objMsgUndef', { message: undefined }],
  ['objMsgStr', { message: 'boom' }],
  ['objMsgEmpty', { message: '' }],
  ['objNoMsg', {}],
  ['causeNull', null],
  ['causeUndef', undefined],
  ['causeZero', 0],
  ['causeFalse', false],
  ['causeStr', 'plain'],
];
const out = {};
for (const [name, cause] of cases) {
  const st = mod.createAuthStorageStatus();
  const f = st.markFailed('AUTH_STORAGE_UNAVAILABLE', cause);
  out[name] = { code: f.code, value: f.message, type: typeof f.message };
}
process.stdout.write(JSON.stringify(out));
`),
  );
  // 历史契约：对象且 message 存在 → 原样返回（0/false 保持 number/boolean）
  assert.deepEqual(res.objMsg0, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 0, type: 'number' });
  assert.deepEqual(res.objMsgFalse, { code: 'AUTH_STORAGE_UNAVAILABLE', value: false, type: 'boolean' });
  assert.deepEqual(res.objMsgStr, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 'boom', type: 'string' });
  assert.deepEqual(res.objMsgEmpty, { code: 'AUTH_STORAGE_UNAVAILABLE', value: '', type: 'string' });
  // message 为 null/undefined → 走 ?? 右侧 String(cause ?? code)
  assert.deepEqual(res.objMsgNull, { code: 'AUTH_STORAGE_UNAVAILABLE', value: '[object Object]', type: 'string' });
  assert.deepEqual(res.objMsgUndef, { code: 'AUTH_STORAGE_UNAVAILABLE', value: '[object Object]', type: 'string' });
  assert.deepEqual(res.objNoMsg, { code: 'AUTH_STORAGE_UNAVAILABLE', value: '[object Object]', type: 'string' });
  // 原始值 cause → String(cause ?? code)
  assert.deepEqual(res.causeNull, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 'AUTH_STORAGE_UNAVAILABLE', type: 'string' });
  assert.deepEqual(res.causeUndef, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 'AUTH_STORAGE_UNAVAILABLE', type: 'string' });
  assert.deepEqual(res.causeZero, { code: 'AUTH_STORAGE_UNAVAILABLE', value: '0', type: 'string' });
  assert.deepEqual(res.causeFalse, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 'false', type: 'string' });
  assert.deepEqual(res.causeStr, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 'plain', type: 'string' });
});

test('A16 markFailed 首个故障优先（后续不同 code 不覆盖根因）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const st = mod.createAuthStorageStatus();
const first = st.markFailed('AUTH_STORAGE_UNAVAILABLE', { message: 0 });
const second = st.markFailed('AUTH_STORAGE_MIGRATION_FAILED', { message: 'later' });
const got = st.get();
process.stdout.write(JSON.stringify({
  first: { code: first.code, value: first.message, type: typeof first.message },
  second: { code: second.code, value: second.message, type: typeof second.message },
  got: { code: got.code, value: got.message, type: typeof got.message },
}));
`),
  );
  assert.deepEqual(res.first, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 0, type: 'number' });
  assert.deepEqual(res.second, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 0, type: 'number' }, '第二个故障不得覆盖首个');
  assert.deepEqual(res.got, { code: 'AUTH_STORAGE_UNAVAILABLE', value: 0, type: 'number' });
});

test('A17 日志分支：SecureStore 抛出的异常 message 为 0 / false 时 logger 实参原样（含类型）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const logs = [];
const logger = { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) };
function makeThrowingSecureStore(errValue) {
  return {
    async getItemAsync() { throw errValue; },
    async setItemAsync() { throw errValue; },
    async deleteItemAsync() { throw errValue; },
  };
}
const as = makeAsyncStorage();
const out = {};
for (const [name, errValue] of [
  ['msg0', { message: 0 }],
  ['msgFalse', { message: false }],
  ['msgStr', { message: 'secure boom' }],
  ['noMsg', {}],
  ['rawStr', 'raw string'],
]) {
  logs.length = 0;
  const st = mod.createAuthStorageStatus();
  const adapter = mod.createSecureStoreAdapter({
    secureStore: makeThrowingSecureStore(errValue),
    asyncStorage: as,
    logger,
    status: st,
  });
  let caught = null;
  try { await adapter.getItem('sb-x'); } catch (e) { caught = { code: e.code, message: e.message }; }
  out[name] = {
    caught,
    logs: logs.map((row) => row.map((v) => (typeof v === 'object' && v !== null ? { __obj: true } : { value: v, type: typeof v }))),
  };
}
process.stdout.write(JSON.stringify(out));
`),
  );
  // 关键：日志第二实参必须与旧 JS 完全一致（0 / false 不得被字符串化）
  assert.deepEqual(res.msg0.logs[0][2], { value: 0, type: 'number' });
  assert.deepEqual(res.msgFalse.logs[0][2], { value: false, type: 'boolean' });
  assert.deepEqual(res.msgStr.logs[0][2], { value: 'secure boom', type: 'string' });
  assert.deepEqual(res.rawStr.logs[0][2], { value: 'raw string', type: 'string' });
  // 抛出的错误码必须保持 AUTH_STORAGE_UNAVAILABLE
  assert.equal(res.msg0.caught.code, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(res.msgFalse.caught.code, 'AUTH_STORAGE_UNAVAILABLE');
});

test('A18 日志分支：AsyncStorage 抛出的异常 message 为 0 / false 时 logger 实参原样（含类型）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const logs = [];
const logger = { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) };
function makeThrowingAsyncStorage(errValue) {
  return {
    async getItem() { throw errValue; },
    async setItem() { throw errValue; },
    async removeItem() { throw errValue; },
  };
}
const ss = makeSecureStore();
const out = {};
for (const [name, errValue] of [
  ['msg0', { message: 0 }],
  ['msgFalse', { message: false }],
  ['msgStr', { message: 'async boom' }],
  ['noMsg', {}],
]) {
  logs.length = 0;
  const st = mod.createAuthStorageStatus();
  const adapter = mod.createSecureStoreAdapter({
    secureStore: ss,
    asyncStorage: makeThrowingAsyncStorage(errValue),
    logger,
    status: st,
  });
  let caught = null;
  try { await adapter.getItem('sb-y'); } catch (e) { caught = { code: e.code, message: e.message }; }
  out[name] = {
    caught,
    logs: logs.map((row) => row.map((v) => (typeof v === 'object' && v !== null ? { __obj: true } : { value: v, type: typeof v }))),
  };
}
process.stdout.write(JSON.stringify(out));
`),
  );
  assert.deepEqual(res.msg0.logs[0][2], { value: 0, type: 'number' });
  assert.deepEqual(res.msgFalse.logs[0][2], { value: false, type: 'boolean' });
  assert.deepEqual(res.msgStr.logs[0][2], { value: 'async boom', type: 'string' });
});

test('A19 失败优先级不变：安全副本删除失败优先于明文清理失败（UNAVAILABLE 优先）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const ss = makeSecureStore({ failDelete: true });
const as = makeAsyncStorage({ failRemove: true });
const status = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger: silentLogger, status });
let caught = null;
try { await adapter.removeItem('sb-session'); } catch (e) { caught = { code: e.code }; }
const got = status.get();
process.stdout.write(JSON.stringify({ caught, statusCode: got ? got.code : null }));
`),
  );
  assert.equal(res.caught.code, 'AUTH_STORAGE_UNAVAILABLE', '安全副本删除失败必须优先抛 UNAVAILABLE');
  assert.equal(res.statusCode, 'AUTH_STORAGE_UNAVAILABLE');
});

test('A20 异常对象无 message 字段时日志实参为异常对象本身（不字符串化）', () => {
  const res = assertEquivalent(
    'authStorage',
    AUTH_STORAGE_CASE(`
const logs = [];
const logger = { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) };
const errObj = { code: 'X' };
const ss = {
  async getItemAsync() { throw errObj; },
  async setItemAsync() { throw errObj; },
  async deleteItemAsync() { throw errObj; },
};
const as = makeAsyncStorage();
const st = mod.createAuthStorageStatus();
const adapter = mod.createSecureStoreAdapter({ secureStore: ss, asyncStorage: as, logger, status: st });
try { await adapter.getItem('sb-z'); } catch {}
process.stdout.write(JSON.stringify({
  logCount: logs.length,
  secondArgIsSameObject: logs.length > 0 ? logs[0][2] === errObj : null,
  secondArgType: logs.length > 0 ? typeof logs[0][2] : null,
}));
`),
  );
  assert.equal(res.secondArgIsSameObject, true, '无 message 时必须原样透传异常对象');
  assert.equal(res.secondArgType, 'object');
});

// ===========================================================================
// A3（R6 补充）— Auto Refresh 默认参数与调用顺序边界用例
// ===========================================================================

test('R15 无参调用 createAutoRefreshController() → 抛原始 TypeError（默认参数语义）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
let caught = null;
try { mod.createAutoRefreshController(); } catch (e) { caught = { name: e.name, message: e.message }; }
let caughtUndef = null;
try { mod.createAutoRefreshController(undefined); } catch (e) { caughtUndef = { name: e.name, message: e.message }; }
let caughtEmpty = null;
try { mod.createAutoRefreshController({}); } catch (e) { caughtEmpty = { name: e.name, message: e.message }; }
process.stdout.write(JSON.stringify({ caught, caughtUndef, caughtEmpty }));
`),
  );
  assert.equal(res.caught.name, 'TypeError', '无参调用必须抛 TypeError（而非解构崩溃）');
  assert.equal(res.caughtUndef.name, 'TypeError');
  assert.equal(res.caughtEmpty.name, 'TypeError');
  assert.deepEqual(res.caught, res.caughtUndef, 'undefined 与无参行为一致');
});

test('R16 同步抛错：startAutoRefresh 同步 throw → 错误上报且不残留 pending', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const errors = [];
const auth = {
  startAutoRefresh() { throw new Error('sync start boom'); },
  stopAutoRefresh() { return Promise.resolve(); },
};
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState, onError: (e) => errors.push(e.message) });
ctrl.start();
await ctrl.flush();
process.stdout.write(JSON.stringify({ errors, isRunning: ctrl.isRunning(), listenerCount: appState.listenerCount }));
`),
  );
  assert.deepEqual(res.errors, ['sync start boom'], '同步抛错必须被上报');
  assert.equal(res.listenerCount, 1);
});

test('R17 异步抛错：startAutoRefresh 返回 rejected Promise → 错误上报且 flush 不挂起', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const errors = [];
const auth = {
  startAutoRefresh() { return Promise.reject(new Error('async start boom')); },
  stopAutoRefresh() { return Promise.resolve(); },
};
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState, onError: (e) => errors.push(e.message) });
ctrl.start();
await ctrl.flush();
process.stdout.write(JSON.stringify({ errors, isRunning: ctrl.isRunning() }));
`),
  );
  assert.deepEqual(res.errors, ['async start boom'], '异步抛错必须被上报');
});

test('R18 调用顺序：active→background→active 的 start/stop 可观测顺序完全一致', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const order = [];
const auth = {
  startAutoRefresh() { order.push('start'); return Promise.resolve(); },
  stopAutoRefresh() { order.push('stop'); return Promise.resolve(); },
};
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
appState.emit('background');
await ctrl.flush();
appState.emit('active');
await ctrl.flush();
appState.emit('background');
await ctrl.flush();
process.stdout.write(JSON.stringify({ order, isRunning: ctrl.isRunning() }));
`),
  );
  assert.deepEqual(res.order, ['start', 'stop', 'start', 'stop'], '可观测调用顺序必须与旧 JS 一致');
  assert.equal(res.isRunning, false);
});

test('R19 并发 start/stop 微任务顺序：不引入额外异步步骤（order 与旧 JS 逐项一致）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const order = [];
const auth = {
  startAutoRefresh() { order.push('start'); return Promise.resolve(); },
  stopAutoRefresh() { order.push('stop'); return Promise.resolve(); },
};
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
// 同一 tick 内连续发起，验证串行化与微任务时序
ctrl.start();
appState.emit('background');
appState.emit('active');
await ctrl.flush();
process.stdout.write(JSON.stringify({ order, isRunning: ctrl.isRunning() }));
`),
  );
  // 关键：若迁移引入额外 .then 步骤，order 会变化；此处要求逐项一致。
  // 真实行为（迁移前后一致）：`start()` 只是把 start 操作入队（异步），
  // 随后同步 emit('background') 又入队 stop，emit('active') 再入队 start。
  // 由于 start 的 seq 在后续决策后已过期，首个 start 被短路跳过，
  // 因此可观测顺序为 stop → start（最终 active）。
  assert.deepEqual(res.order, ['stop', 'start']);
  assert.equal(res.isRunning, true);
});

test('R20 dispose 时 stop 入队先于 disposed 置位（dispose 后 ticker 必须停止）', () => {
  const res = assertEquivalent(
    'authAutoRefresh',
    AUTO_REFRESH_CASE(`
const order = [];
const auth = {
  startAutoRefresh() { order.push('start'); return Promise.resolve(); },
  stopAutoRefresh() { order.push('stop'); return Promise.resolve(); },
};
const appState = makeAppState('active');
const ctrl = mod.createAutoRefreshController({ auth, appState });
ctrl.start();
await ctrl.flush();
ctrl.dispose();
await ctrl.flush();
process.stdout.write(JSON.stringify({ order, isRunning: ctrl.isRunning(), listenerCount: appState.listenerCount }));
`),
  );
  assert.deepEqual(res.order, ['start', 'stop'], 'dispose 必须入队并执行 stop');
  assert.equal(res.isRunning, false);
  assert.equal(res.listenerCount, 0);
});
// --- END OF FILE tests/security/p12r5MigrationEquivalence.test.mjs ---