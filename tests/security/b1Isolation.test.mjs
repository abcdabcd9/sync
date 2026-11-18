// --- START OF FILE tests/security/b1Isolation.test.mjs ---
// ============================================================================
// TASK-P0.3 / T4-B1 — 身份生命周期与账号作用域数据隔离 自动化回归测试
//
// 覆盖 AC-B1-01 .. AC-B1-09（可在纯 Node 环境验证的部分）：
//   01 健康本地数据跨账号隔离（含离线：无 userId 不读写）
//   02 浏览器历史/书签跨账号隔离 + A 重新登录仍读自己的 V2 key
//   03 旧全局数据保护（8 个健康 key + 浏览器旧 key 不被删除/覆盖/认领）
//   04 Profile Cache 旧请求迟到返回不污染新账号
//   05 Signed URL 竞态（A→B→A、A 旧 Promise 不误删 B 的 inflight）
//   06 登出失败安全（源码契约：失败分支不推进 epoch / 不清 user）
//   07 身份代际语义（同账号重新登录也必须失效旧请求）
//   08 账号删除范围（只删当前用户 V2 key，不误删其他账号）
//   09 无回归（V2 key 命名/纯函数行为与既有契约一致）
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token / 真实用户数据。
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// 通用：构建一个可运行真实源码的沙箱（stub AsyncStorage / supabase / react）
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-iso-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // 内存版 AsyncStorage：支持 getItem/setItem/removeItem/multiSet/multiRemove/getAllKeys
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

  // react stub：仅提供 Hook 依赖的最小实现（本测试不渲染组件）
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
export const useEffect = () => {};
export const useCallback = (fn) => fn;
export const useMemo = (fn) => fn();
export const useRef = (v) => ({ current: v });
export const createContext = (v) => ({ __ctx: v });
export const useContext = () => ({});
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext };
`,
  });

  // supabase stub：可注入 createSignedUrl / profiles 查询行为
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // 复制真实源码（仅被测模块及其直接依赖）
  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/hooks/health/useHealthStorage.js');
  copy('src/hooks/health/constants.js');
  copy('src/hooks/health/dateUtils.js');
  copy('src/constants/browser/index.js');
  copy('src/hooks/browser/useBrowserHistory.js');
  copy('src/hooks/profile/useProfileCache.js');
  copy('src/hooks/chat/useSignedMediaUrl.js');

  // 为 useProfileCache / useSignedMediaUrl 提供 supabase stub（真实模块 import ../../services/supabase）
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const supabase = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      single() { return globalThis.__PROFILE_QUERY__ ? globalThis.__PROFILE_QUERY__() : Promise.resolve({ data: null, error: null }); },
    };
  },
  storage: {
    from() {
      return {
        createSignedUrl(p, ttl) {
          return globalThis.__SIGN_IMPL__ ? globalThis.__SIGN_IMPL__(p, ttl) : Promise.resolve({ data: { signedUrl: 'https://x/' + p }, error: null });
        },
      };
    },
  },
};
export const authStorageStatus = { get: () => null };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // resolve hook：允许无扩展名相对导入
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  // 把 console 输出重定向到 stderr，避免被测源码的 console.log 污染 stdout 的 JSON 结果
  fs.writeFileSync(entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

// ---------------------------------------------------------------------------
// AC-B1-01 / 03：健康本地数据按账号隔离 + 旧全局数据保护
// ---------------------------------------------------------------------------
test('AC-B1-01/03 健康数据按账号隔离，旧全局 key 原样保留', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const kA = buildHealthKeys(A), kB = buildHealthKeys(B);

// 预置旧全局 key（无主历史数据）
const LEGACY = {
  '@waterAmount': '1234', '@mealsStatus': '{"早餐":true,"午餐":false,"晚餐":false}',
  '@maxWater': '2500', '@motto': '旧格言', '@mealGuides': '{"早餐":"旧"}',
  '@streakDays': '9', '@lastCheckInDate': '2026-01-01', '@lastActiveDate': '2026-01-02',
};
for (const [k,v] of Object.entries(LEGACY)) await AS.setItem(k, v);

// A 写入自己的 V2 数据
await AS.setItem(kA.water, '500');
await AS.setItem(kA.meals, '{"早餐":true,"午餐":false,"晚餐":false}');
await AS.setItem(kA.streak, '3');

// B 写入自己的 V2 数据
await AS.setItem(kB.water, '900');
await AS.setItem(kB.streak, '7');

// 读取校验
const aWater = await AS.getItem(kA.water);
const bWater = await AS.getItem(kB.water);
const aStreak = await AS.getItem(kA.streak);
const bStreak = await AS.getItem(kB.streak);

// 旧全局 key 未被改动
const legacyAfter = {};
for (const k of Object.keys(LEGACY)) legacyAfter[k] = await AS.getItem(k);

// 无 userId → buildHealthKeys 返回 null（不读写任何磁盘）
const nullKeys = buildHealthKeys(null);
const emptyKeys = buildHealthKeys('');

// key 命名契约
const allKeys = await AS.getAllKeys();

process.stdout.write(JSON.stringify({
  aWater, bWater, aStreak, bStreak,
  legacyAfter, legacyExpected: LEGACY,
  nullKeysIsNull: nullKeys === null,
  emptyKeysIsNull: emptyKeys === null,
  keyWaterA: kA.water, keyWaterB: kB.water,
  hasLegacyKeys: Object.keys(LEGACY).every((k) => allKeys.includes(k)),
  v2KeyCount: allKeys.filter((k) => k.startsWith('@sync_health_v2_')).length,
}));
`);
    assert.equal(out.aWater, '500', 'A 的饮水应为自己写入的值');
    assert.equal(out.bWater, '900', 'B 的饮水应为自己写入的值');
    assert.equal(out.aStreak, '3', 'A 的连续天数应为自己写入的值');
    assert.equal(out.bStreak, '7', 'B 的连续天数应为自己写入的值');
    assert.deepEqual(out.legacyAfter, out.legacyExpected, '旧全局健康 key 必须原样保留（不删除/不覆盖）');
    assert.equal(out.nullKeysIsNull, true, 'buildHealthKeys(null) 必须返回 null');
    assert.equal(out.emptyKeysIsNull, true, 'buildHealthKeys("") 必须返回 null');
    assert.equal(out.keyWaterA, '@sync_health_v2_user-aaa_water', 'A 的 water key 命名契约');
    assert.equal(out.keyWaterB, '@sync_health_v2_user-bbb_water', 'B 的 water key 命名契约');
    assert.equal(out.hasLegacyKeys, true, '旧全局 key 必须仍在存储中');
    assert.equal(out.v2KeyCount, 5, '仅应存在 A/B 各自的 V2 key（A:3 + B:2）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B1-02 / 03：浏览器历史/书签按账号隔离 + 旧全局 key 保护
// ---------------------------------------------------------------------------
test('AC-B1-02/03 浏览器历史/书签按账号隔离，旧全局 key 原样保留', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildBrowserHistoryKey, buildBrowserBookmarksKey, HISTORY_KEY } = await import('./src/constants/browser/index.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';
const hA = buildBrowserHistoryKey(A), hB = buildBrowserHistoryKey(B);
const bmA = buildBrowserBookmarksKey(A), bmB = buildBrowserBookmarksKey(B);

// 预置旧全局浏览器 key
await AS.setItem('@browser_history', JSON.stringify([{ id:'1', url:'https://old.example.com', title:'old' }]));
await AS.setItem('@browser_bookmarks', JSON.stringify([{ url:'https://old.example.com', title:'old' }]));

// A / B 各自写入
await AS.setItem(hA, JSON.stringify([{ id:'a1', url:'https://a.example.com', title:'A' }]));
await AS.setItem(hB, JSON.stringify([{ id:'b1', url:'https://b.example.com', title:'B' }]));
await AS.setItem(bmA, JSON.stringify([{ url:'https://a.example.com', title:'A' }]));
await AS.setItem(bmB, JSON.stringify([{ url:'https://b.example.com', title:'B' }]));

const readA = JSON.parse(await AS.getItem(hA));
const readB = JSON.parse(await AS.getItem(hB));
const legacyHistory = await AS.getItem('@browser_history');
const legacyBookmarks = await AS.getItem('@browser_bookmarks');

process.stdout.write(JSON.stringify({
  readA, readB, legacyHistory, legacyBookmarks,
  hA, hB, bmA, bmB,
  legacyConst: HISTORY_KEY,
  nullHistory: buildBrowserHistoryKey(null),
  nullBookmarks: buildBrowserBookmarksKey(''),
}));
`);
    assert.equal(out.readA[0].url, 'https://a.example.com', 'A 的历史应为自己的记录');
    assert.equal(out.readB[0].url, 'https://b.example.com', 'B 的历史应为自己的记录');
    assert.ok(out.legacyHistory.includes('old.example.com'), '旧全局历史必须原样保留');
    assert.ok(out.legacyBookmarks.includes('old.example.com'), '旧全局书签必须原样保留');
    assert.equal(out.hA, '@sync_browser_history_v2_user-aaa', 'A 历史 key 命名契约');
    assert.equal(out.hB, '@sync_browser_history_v2_user-bbb', 'B 历史 key 命名契约');
    assert.equal(out.bmA, '@sync_browser_bookmarks_v2_user-aaa', 'A 书签 key 命名契约');
    assert.equal(out.bmB, '@sync_browser_bookmarks_v2_user-bbb', 'B 书签 key 命名契约');
    assert.equal(out.legacyConst, '@browser_history', '旧全局常量必须保留（兼容）');
    assert.equal(out.nullHistory, null, 'buildBrowserHistoryKey(null) 必须返回 null');
    assert.equal(out.nullBookmarks, null, 'buildBrowserBookmarksKey("") 必须返回 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B1-04：Profile Cache owner 隔离 + 迟到写入拦截
// ---------------------------------------------------------------------------
test('AC-B1-04 Profile Cache 按 owner 隔离，旧请求迟到写入被拦截', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const PC = await import('./src/hooks/profile/useProfileCache.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;

const A = 'user-aaa', B = 'user-bbb';

// 预置旧全局 profile 缓存（无主）
await AS.setItem('@user_profile_cache', JSON.stringify({ id: 'ghost', username: 'ghost' }));

// 登记 owner = A，代际 g1
const g1 = PC.setProfileCacheOwner(A);
const okA = await PC.writeProfileCache({ id: A, username: 'alice' }, g1);
const readA = await PC.readProfileCache(A);

// 切到 B（代际自增）
const g2 = PC.setProfileCacheOwner(B);
// A 的旧请求迟到：携带 g1 写入 → 必须被拒绝
const lateA = await PC.writeProfileCache({ id: A, username: 'alice-late' }, g1);
// B 正常写入
const okB = await PC.writeProfileCache({ id: B, username: 'bob' }, g2);
const readB = await PC.readProfileCache(B);

// 读取 A 的缓存（应仍是 alice，不是 alice-late）
const readAAfter = await PC.readProfileCache(A);

// 旧全局 key 未被删除
const legacy = await AS.getItem('@user_profile_cache');

// 无 userId 读取 → null
const readNull = await PC.readProfileCache(null);

// 跨 owner 读取：B 读 A 的 key 内容应被 id 校验拒绝
await AS.setItem('@user_profile_cache_v2_' + B, JSON.stringify({ id: A, username: 'spoof' }));
const spoofRead = await PC.readProfileCache(B);

process.stdout.write(JSON.stringify({
  g1, g2, okA, okB, lateA,
  readA, readB, readAAfter, legacy, readNull, spoofRead,
  keyA: PC.buildProfileCacheKey(A), keyB: PC.buildProfileCacheKey(B),
  nullKey: PC.buildProfileCacheKey(null),
}));
`);
    assert.ok(out.g2 > out.g1, 'owner 变化必须推进代际');
    assert.equal(out.okA, true, 'A 在有效代际内写入应成功');
    assert.equal(out.okB, true, 'B 在有效代际内写入应成功');
    assert.equal(out.lateA, false, 'A 的迟到写入（旧代际）必须被拒绝');
    assert.equal(out.readA.username, 'alice', 'A 的缓存不应被迟到写入污染');
    assert.equal(out.readB.username, 'bob', 'B 的缓存应为自己的资料');
    assert.equal(out.readAAfter.username, 'alice', 'A 的缓存必须保持原值');
    assert.ok(out.legacy.includes('ghost'), '旧全局 profile 缓存必须原样保留');
    assert.equal(out.readNull, null, '无 userId 读取必须返回 null');
    assert.equal(out.spoofRead, null, 'id 与 owner 不符的缓存必须被拒绝');
    assert.equal(out.keyA, '@user_profile_cache_v2_user-aaa', 'A profile key 命名契约');
    assert.equal(out.keyB, '@user_profile_cache_v2_user-bbb', 'B profile key 命名契约');
    assert.equal(out.nullKey, null, 'buildProfileCacheKey(null) 必须返回 null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B1-05：Signed URL 竞态（A→B→A、旧 Promise 不误删 B 的 inflight）
// ---------------------------------------------------------------------------
test('AC-B1-05 Signed URL 缓存按 owner 隔离，旧 Promise 不污染新账号', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const SU = await import('./src/hooks/chat/useSignedMediaUrl.js');

const A = 'user-aaa', B = 'user-bbb';
const P = 'user-aaa/img_1.jpg';

// 场景 1：A 请求 → 完成 → 缓存命中
SU.setSignedUrlOwner(A);
let calls = 0;
globalThis.__SIGN_IMPL__ = async (p) => { calls += 1; return { data: { signedUrl: 'https://signed/' + p + '?v=' + calls }, error: null }; };
const urlA1 = await SU.getSignedUrl(P);
const urlA2 = await SU.getSignedUrl(P); // 应命中缓存，不再请求
const callsAfterA = calls;

// 场景 2：切到 B → 同路径请求必须重新签名（不命中 A 的缓存）
SU.setSignedUrlOwner(B);
const urlB = await SU.getSignedUrl(P);
const callsAfterB = calls;

// 场景 3：A→B→A，A 的旧缓存已被清空，必须重新签名
SU.setSignedUrlOwner(A);
const urlA3 = await SU.getSignedUrl(P);
const callsAfterA3 = calls;

// 场景 4：A 的旧 Promise 迟到，不得写入 B 的缓存
SU.setSignedUrlOwner(A);
let resolveOld;
const oldPromise = new Promise((res) => { resolveOld = res; });
globalThis.__SIGN_IMPL__ = () => oldPromise;
const pendingA = SU.getSignedUrl('user-aaa/img_race.jpg');
// 切到 B
SU.setSignedUrlOwner(B);
// A 的旧请求此刻返回
resolveOld({ data: { signedUrl: 'https://signed/OLD-A' }, error: null });
const oldResult = await pendingA;
// B 请求同路径
globalThis.__SIGN_IMPL__ = async () => ({ data: { signedUrl: 'https://signed/B' }, error: null });
const bRace = await SU.getSignedUrl('user-aaa/img_race.jpg');
// 同步内存缓存读取：B 不应拿到 OLD-A
const memB = SU.getMemoryCachedSignedUrl('user-aaa/img_race.jpg');

// 场景 5：A 的旧 Promise 不得误删 B 的同路径 inflight
SU.setSignedUrlOwner(A);
let resolveA2;
const a2 = new Promise((res) => { resolveA2 = res; });
globalThis.__SIGN_IMPL__ = () => a2;
const pA2 = SU.getSignedUrl('user-aaa/img_shared.jpg');
SU.setSignedUrlOwner(B);
let resolveB2;
const b2 = new Promise((res) => { resolveB2 = res; });
globalThis.__SIGN_IMPL__ = () => b2;
const pB2 = SU.getSignedUrl('user-aaa/img_shared.jpg');
// A 的旧 Promise 先完成
resolveA2({ data: { signedUrl: 'https://signed/A2' }, error: null });
await pA2;
// B 的 Promise 仍在 inflight：再次请求应复用（不新增网络请求）
// 注意：getSignedUrl 是 async，返回的 Promise 每次都是新包装对象，
//       因此不能用 Promise 引用相等判断，必须用「网络调用次数」验证去重。
let bCalls = 0;
globalThis.__SIGN_IMPL__ = async () => { bCalls += 1; return { data: { signedUrl: 'https://signed/B2' }, error: null }; };
const pB2again = SU.getSignedUrl('user-aaa/img_shared.jpg');
resolveB2({ data: { signedUrl: 'https://signed/B2' }, error: null });
const b2Result = await pB2again;

process.stdout.write(JSON.stringify({
  urlA1, urlA2, callsAfterA, urlB, callsAfterB, urlA3, callsAfterA3,
  oldResult, bRace, memB, b2Result, bCalls,
}));
`);
    assert.equal(out.urlA1, 'https://signed/user-aaa/img_1.jpg?v=1', 'A 首次请求应返回签名 URL');
    assert.equal(out.urlA2, out.urlA1, 'A 二次请求应命中缓存');
    assert.equal(out.callsAfterA, 1, 'A 二次请求不应新增网络调用');
    assert.equal(out.urlB, 'https://signed/user-aaa/img_1.jpg?v=2', 'B 请求同路径必须重新签名（不命中 A 缓存）');
    assert.equal(out.callsAfterB, 2, 'B 请求应新增一次网络调用');
    assert.equal(out.urlA3, 'https://signed/user-aaa/img_1.jpg?v=3', 'A→B→A 后 A 必须重新签名');
    assert.equal(out.callsAfterA3, 3, 'A→B→A 应新增一次网络调用');
    assert.equal(out.oldResult, null, 'A 的旧 Promise 迟到结果必须被丢弃（返回 null）');
    assert.equal(out.bRace, 'https://signed/B', 'B 应拿到自己的签名 URL');
    assert.equal(out.memB, 'https://signed/B', 'B 的内存缓存不得是 A 的旧 URL');
    assert.equal(out.b2Result, 'https://signed/B2', 'B 的 inflight Promise 应正常完成');
    assert.equal(out.bCalls, 0, 'A 旧 Promise 不得误删 B 的同路径 inflight（复用不应触发额外网络调用）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B1-06 / 07：useAuth 源码契约（登出失败安全 + 身份代际语义）
// ---------------------------------------------------------------------------
test('AC-B1-06/07 useAuth 登出失败安全与身份代际契约（源码静态核验）', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/hooks/useAuth.js'), 'utf8');

  // 登出失败安全：失败分支必须 setSignOutError 且 return，不得推进 epoch
  assert.match(src, /setIsIdentityTransitioning\(true\)/, 'signOut 开始必须置 transitioning=true');
  assert.match(src, /setSignOutError\(failure\)/, '失败分支必须写入 signOutError');
  assert.match(src, /if \(error\) \{[\s\S]*?setSignOutError\(failure\)[\s\S]*?return \{ error \};/, 'signOut 返回 error 时必须提前 return');
  assert.match(src, /AUTH_STORAGE_ERROR\.UNAVAILABLE[\s\S]*?setSignOutError\(err\)[\s\S]*?return \{ error: err \};/, 'SecureStore UNAVAILABLE 必须视为登出未完成');
  assert.match(src, /LEGACY_CLEANUP_FAILED[\s\S]*?console\.warn/, 'LEGACY_CLEANUP_FAILED 不应阻断登出');

  // 成功路径才推进 epoch
  const successIdx = src.indexOf('✅ 登出确认成功');
  const bumpIdx = src.indexOf('bumpAuthEpoch();', successIdx);
  assert.ok(successIdx !== -1 && bumpIdx > successIdx, '只有确认成功后才推进 authEpoch');

  // 身份代际：owner 变化或 token 轮换都必须 bump
  assert.match(src, /const ownerChanged = prevOwnerId !== nextOwnerId;/, '必须检测 owner 变化');
  // 🛡️ CR-06：正常 TOKEN_REFRESHED 不得视为身份转移。
  //    断言 tokenRotated 必须显式排除 isTokenRefresh（否则每次 JWT 刷新都会误推进代际）。
  assert.match(src, /const isTokenRefresh = event === 'TOKEN_REFRESHED';/, '必须识别 TOKEN_REFRESHED 事件');
  assert.match(
    src,
    /const tokenRotated =\s*!ownerChanged && !isTokenRefresh && !!nextOwnerId && prevAccessToken !== nextAccessToken;/,
    '必须检测同账号 token 轮换，且排除正常 TOKEN_REFRESHED'
  );
  assert.match(src, /if \(ownerChanged \|\| tokenRotated\) \{[\s\S]*?bumpAuthEpoch\(\);/, 'owner 变化或 token 轮换必须推进 epoch');

  // 认证回调内不得 await 网络/磁盘（先剥离注释，避免注释里的 "await" 误判）
  const applyStart = src.indexOf('const applySession = useCallback(');
  const applyEnd = src.indexOf('}, [bumpAuthEpoch]);', applyStart);
  const applyBody = src
    .slice(applyStart, applyEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bawait\s/.test(applyBody), 'applySession 内不得出现 await（避免阻塞 GoTrue 事件队列）');

  // 正常登出不得删除磁盘数据（不得出现 AsyncStorage.removeItem / multiRemove）
  const signOutStart = src.indexOf('signOut: async () => {');
  const signOutEnd = src.indexOf('// 注：signOut 内部直接读', signOutStart);
  const signOutBody = src.slice(signOutStart, signOutEnd);
  assert.ok(!/AsyncStorage\.(removeItem|multiRemove|clear)/.test(signOutBody), '正常登出不得删除本地持久化数据');

  // 下游 owner 登记：owner 变化时同步登记 Signed URL / Profile Cache
  assert.match(src, /if \(ownerChanged\) \{[\s\S]*?setSignedUrlOwner\(nextOwnerId\);[\s\S]*?setProfileCacheOwner\(nextOwnerId\);/, 'owner 变化必须同步登记下游缓存 owner');
  assert.match(src, /setSignedUrlOwner\(null\);[\s\S]*?setProfileCacheOwner\(null\);/, '登出成功必须清空下游缓存 owner');
});

// ---------------------------------------------------------------------------
// AC-B1-08：账号删除范围（只删当前用户 V2 key）
// ---------------------------------------------------------------------------
test('AC-B1-08 账号删除只清理当前用户 V2 key，不误删其他账号', () => {
  const dir = buildSandbox();
  try {
    // security.js 依赖 React/主题/导航，无法直接 import；这里复刻其纯匹配逻辑做等价验证，
    // 同时静态核验源码确实使用该精确匹配（防止未来退化为前缀一刀切）。
    const out = runInSandbox(dir, `
const USER_SCOPED_V2_KEY_PREFIXES = [
  '@sync_health_v2_',
  '@sync_browser_history_v2_',
  '@sync_browser_bookmarks_v2_',
  '@sync_browser_bookmarks_seed_v2_',
  '@user_profile_cache_v2_',
];
const isCurrentUserV2Key = (key, userId) => {
  if (!userId) return false;
  return USER_SCOPED_V2_KEY_PREFIXES.some((prefix) => {
    if (!key.startsWith(prefix)) return false;
    const rest = key.slice(prefix.length);
    return rest === userId || rest.startsWith(userId + '_');
  });
};

const A = 'user-aaa', B = 'user-bbb';
const keys = [
  '@sync_health_v2_user-aaa_water',
  '@sync_health_v2_user-aaa_meals',
  '@sync_health_v2_user-bbb_water',
  '@sync_browser_history_v2_user-aaa',
  '@sync_browser_history_v2_user-bbb',
  '@sync_browser_bookmarks_v2_user-aaa',
  '@sync_browser_bookmarks_seed_v2_user-aaa',
  '@user_profile_cache_v2_user-aaa',
  '@user_profile_cache_v2_user-bbb',
  '@waterAmount', '@browser_history',
  '@sync_health_v2_user-aaa-extra_water', // 前缀相似但非本用户
];

const matchedForA = keys.filter((k) => isCurrentUserV2Key(k, A));
const matchedForB = keys.filter((k) => isCurrentUserV2Key(k, B));
const matchedForNull = keys.filter((k) => isCurrentUserV2Key(k, null));

process.stdout.write(JSON.stringify({ matchedForA, matchedForB, matchedForNull }));
`);
    assert.deepEqual(out.matchedForA.sort(), [
      '@sync_health_v2_user-aaa_water',
      '@sync_health_v2_user-aaa_meals',
      '@sync_browser_history_v2_user-aaa',
      '@sync_browser_bookmarks_v2_user-aaa',
      '@sync_browser_bookmarks_seed_v2_user-aaa',
      '@user_profile_cache_v2_user-aaa',
    ].sort(), 'A 删除范围必须精确命中自己的 V2 key');
    assert.deepEqual(out.matchedForB.sort(), [
      '@sync_health_v2_user-bbb_water',
      '@sync_browser_history_v2_user-bbb',
      '@user_profile_cache_v2_user-bbb',
    ].sort(), 'B 删除范围必须精确命中自己的 V2 key');
    assert.deepEqual(out.matchedForNull, [], '无 userId 时不得匹配任何 key');

    // 静态核验：security.js 必须使用 isCurrentUserV2Key 精确匹配，且旧全局 key 仍在白名单
    const sec = fs.readFileSync(path.join(repoRoot, 'src/app/settings/security.js'), 'utf8');
    assert.match(sec, /const isCurrentUserV2Key = \(key, userId\) =>/, 'security.js 必须定义精确匹配函数');
    assert.match(sec, /USER_SCOPED_V2_KEY_PREFIXES\.some\(\(p\) => key\.startsWith\(p\)\)[\s\S]*?!isCurrentUserV2Key\(key, userId\)/, 'security.js 必须对 V2 key 做精确匹配守卫');
    assert.match(sec, /'@water', '@meals', '@maxWater', '@motto', '@mealGuides'/, '旧全局健康 key 必须仍在全局白名单');
    assert.match(sec, /'@browser_bookmarks', '@browser_history'/, '旧全局浏览器 key 必须仍在全局白名单');
    assert.ok(!/USER_SCOPED_V2_KEY_PREFIXES\.forEach\(\(p\) => keysToRemove\.add\(p\)\)/.test(sec), '禁止按 V2 前缀一刀切删除');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B1-09：无回归（V2 命名契约 + 纯函数行为）
// ---------------------------------------------------------------------------
test('AC-B1-09 无回归：V2 命名契约与纯函数行为一致', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const B = await import('./src/constants/browser/index.js');
const PC = await import('./src/hooks/profile/useProfileCache.js');

const uid = 'u1';
const hk = buildHealthKeys(uid);
const fields = Object.keys(hk).sort();

process.stdout.write(JSON.stringify({
  fields,
  water: hk.water,
  checkIn: hk.checkIn,
  active: hk.active,
  historyLimit: B.HISTORY_LIMIT,
  historyKey: B.buildBrowserHistoryKey(uid),
  bookmarksKey: B.buildBrowserBookmarksKey(uid),
  profileKey: PC.buildProfileCacheKey(uid),
  legacyProfile: PC.PROFILE_CACHE_KEY,
  legacyHistory: B.HISTORY_KEY,
  isAdUrl: B.isAdUrl('https://doubleclick.net/ad'),
  isAdUrlNormal: B.isAdUrl('https://example.com/page'),
  getDomain: B.getDomain('https://sub.example.com/a/b'),
  buildHistoryTitle: B.buildHistoryTitle('', 'https://example.com/x'),
}));
`);
    assert.deepEqual(out.fields, ['active', 'checkIn', 'guides', 'maxWater', 'meals', 'motto', 'streak', 'water'], '8 个健康字段必须齐全');
    assert.equal(out.water, '@sync_health_v2_u1_water', 'water key 命名契约');
    assert.equal(out.checkIn, '@sync_health_v2_u1_checkIn', 'checkIn key 命名契约');
    assert.equal(out.active, '@sync_health_v2_u1_active', 'active key 命名契约');
    assert.equal(out.historyLimit, 100, 'HISTORY_LIMIT 必须保持 100');
    assert.equal(out.historyKey, '@sync_browser_history_v2_u1', '历史 key 命名契约');
    assert.equal(out.bookmarksKey, '@sync_browser_bookmarks_v2_u1', '书签 key 命名契约');
    assert.equal(out.profileKey, '@user_profile_cache_v2_u1', 'profile key 命名契约');
    assert.equal(out.legacyProfile, '@user_profile_cache', '旧 profile 常量必须保留');
    assert.equal(out.legacyHistory, '@browser_history', '旧历史常量必须保留');
    assert.equal(out.isAdUrl, true, 'isAdUrl 对广告域名应返回 true');
    assert.equal(out.isAdUrlNormal, false, 'isAdUrl 对普通域名应返回 false');
    assert.equal(out.getDomain, 'sub.example.com', 'getDomain 行为不变');
    assert.equal(out.buildHistoryTitle, 'example.com', 'buildHistoryTitle 空标题回落域名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/b1Isolation.test.mjs ---
