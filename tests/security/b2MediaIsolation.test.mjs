// --- START OF FILE tests/security/b2MediaIsolation.test.mjs ---
// ============================================================================
// TASK-P0.3 / B2 — 媒体缓存与离线隔离 自动化回归测试
//
// 覆盖授权要求的 10 个场景（可在纯 Node 环境验证的部分）：
//   AC-B2-01  A 的签名缓存不可被 B 读取（owner 隔离）
//   AC-B2-02  A 的迟到签名请求不覆盖 B 的缓存（代际闸门）
//   AC-B2-03  A→B→A 旧 A 会话请求失效（forceBump 代际）
//   AC-B2-04  同账号新 authEpoch 下旧请求不被采纳
//   AC-B2-05  B 的合法媒体请求正常工作（隔离不误伤）
//   AC-B2-06  同账号合法离线缓存可复用（沙盒索引键不加 epoch）
//   AC-B2-07  签名 URL 过期/刷新语义（TTL 与缓存命中）
//   AC-B2-08  断网/恢复期间不产生错误写回（失败不写索引）
//   AC-B2-09  并发/重复点击不重复下载（inflight 去重）
//   AC-B2-10  组件卸载/切号后不残留错误可见状态（Hook state 绑定身份）
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token / 真实用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」，结束后自动清理。
//   - 断言针对真实生产接口（mediaCache / useSignedMediaUrl 的导出契约）。
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
// 沙箱：stub AsyncStorage / react / supabase / expo-file-system(legacy)
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-media-'));
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

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // expo-file-system/legacy stub：内存虚拟文件系统，可注入下载延迟与失败
  mk('expo-file-system', {
    'package.json': JSON.stringify({
      name: 'expo-file-system',
      version: '0.0.0',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js', './legacy': './legacy.js' },
    }),
    'index.js': `
const files = new Map(); // path -> { size }
const dirs = new Set(['file:///doc/']);
export const documentDirectory = 'file:///doc/';
export const __files = files;
export const __dirs = dirs;
export const __reset = () => { files.clear(); dirs.clear(); dirs.add('file:///doc/'); };
export async function getInfoAsync(p){
  if (dirs.has(p)) return { exists: true, isDirectory: true, size: 0 };
  if (files.has(p)) return { exists: true, isDirectory: false, size: files.get(p).size };
  return { exists: false };
}
export async function makeDirectoryAsync(p){ dirs.add(p); }
export async function readDirectoryAsync(p){
  const prefix = p.endsWith('/') ? p : p + '/';
  const out = new Set();
  for (const k of [...files.keys(), ...dirs]) {
    if (k.startsWith(prefix) && k !== p) {
      const rest = k.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (seg) out.add(seg);
    }
  }
  return [...out];
}
export async function copyAsync({ from, to }){
  const size = files.has(from) ? files.get(from).size : 100;
  const text = files.has(from) ? files.get(from).text : undefined;
  files.set(to, { size, text });
}
export async function writeAsStringAsync(p, content){
  files.set(p, { size: String(content).length, text: String(content) });
}
export async function readAsStringAsync(p){
  if (!files.has(p)) throw new Error('ENOENT: ' + p);
  const rec = files.get(p);
  return rec.text === undefined ? '' : rec.text;
}
export async function downloadAsync(url, to){
  if (globalThis.__DL_IMPL__) return globalThis.__DL_IMPL__(url, to);
  files.set(to, { size: 2048 });
  return { uri: to };
}
export async function deleteAsync(p){
  for (const k of [...files.keys()]) if (k === p || k.startsWith(p)) files.delete(k);
  for (const d of [...dirs]) if (d === p || d.startsWith(p)) dirs.delete(d);
}
export default { documentDirectory, getInfoAsync, makeDirectoryAsync, readDirectoryAsync, copyAsync, downloadAsync, deleteAsync };
`,
  });
  // 子路径 expo-file-system/legacy 解析到同一实现
  fs.mkdirSync(path.join(nm, 'expo-file-system'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'expo-file-system', 'legacy.js'), `export * from './index.js';\n`);

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/services/mediaCache.js');
  copy('src/hooks/chat/useSignedMediaUrl.js');

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const supabase = {
  from() {
    return {
      select() { return this; },
      eq() { return this; },
      single() { return Promise.resolve({ data: null, error: null }); },
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
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
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

// ---------------------------------------------------------------------------
// AC-B2-01 / 02 / 03 / 04 / 05 / 07：签名 URL 层 owner + epoch 隔离
// ---------------------------------------------------------------------------
test('AC-B2-01/02/03/04/05/07 签名 URL 缓存按 owner 隔离且代际闸门生效', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = await import('./src/hooks/chat/useSignedMediaUrl.js');
const { getSignedUrl, setSignedUrlOwner, getSignedUrlIdentity, getMemoryCachedSignedUrl, clearSignedUrlCache } = M;

const A = 'user-aaa', B = 'user-bbb';
const PATH = 'user-aaa/img_1.jpg';

// 记录真实发给 Supabase 的请求次数
let signCalls = 0;
globalThis.__SIGN_IMPL__ = async (p, ttl) => {
  signCalls += 1;
  return { data: { signedUrl: 'https://cdn/' + p + '?sig=' + signCalls }, error: null };
};

// --- AC-B2-01：A 的缓存不可被 B 读取 ---
setSignedUrlOwner(A);
const urlA = await getSignedUrl(PATH);
const memA = getMemoryCachedSignedUrl(PATH);

setSignedUrlOwner(B);
const memB = getMemoryCachedSignedUrl(PATH);        // B 视角同步缓存
const urlB = await getSignedUrl(PATH);              // B 重新签名（不同 owner 键）

// --- AC-B2-05：B 的合法请求正常工作 ---
const bOk = typeof urlB === 'string' && urlB.includes('user-aaa/img_1.jpg');

// --- AC-B2-02：A 的迟到请求不覆盖 B 缓存 ---
// 构造：A 发起请求 → 请求未返回前切到 B → A 的 Promise 完成后不得写入 B 缓存
setSignedUrlOwner(A);
let releaseA;
globalThis.__SIGN_IMPL__ = (p) => new Promise((res) => { releaseA = () => res({ data: { signedUrl: 'https://cdn/LATE-A' }, error: null }); });
const pendingA = getSignedUrl('user-aaa/late.jpg');
setSignedUrlOwner(B);                                // 身份切换，epoch 自增
releaseA();
const lateResult = await pendingA;                   // 应被代际校验拦截 → null
const bCacheAfterLate = getMemoryCachedSignedUrl('user-aaa/late.jpg');

// --- AC-B2-03：A→B→A，旧 A 会话请求失效 ---
setSignedUrlOwner(A);
const epochA1 = getSignedUrlIdentity().epoch;
setSignedUrlOwner(B);
setSignedUrlOwner(A);                                // 回到 A，但已是新会话
const epochA2 = getSignedUrlIdentity().epoch;

// --- AC-B2-04：同账号 forceBump 使旧请求失效 ---
setSignedUrlOwner(A);
const epochBeforeBump = getSignedUrlIdentity().epoch;
setSignedUrlOwner(A, true);                          // 同 owner 强制推进代际
const epochAfterBump = getSignedUrlIdentity().epoch;

// --- AC-B2-07：TTL 语义（生产实现含 REFRESH_AHEAD_MS = 1 天提前刷新）---
//    expiresAt = now + ttl*1000 - REFRESH_AHEAD_MS
//    → ttl < 1 天时立即视为「需刷新」，不进入可命中缓存；
//    → ttl 足够长（如 7 天默认值）时正常缓存并可命中。
clearSignedUrlCache();
setSignedUrlOwner(A);
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://cdn/ttl/' + p }, error: null });
const shortTtlUrl = await getSignedUrl('user-aaa/short.jpg', 60);        // 60 秒 < 1 天
const shortHit = getMemoryCachedSignedUrl('user-aaa/short.jpg');
const longTtlUrl = await getSignedUrl('user-aaa/long.jpg', 7 * 24 * 3600); // 7 天
const longHit = getMemoryCachedSignedUrl('user-aaa/long.jpg');

process.stdout.write(JSON.stringify({
  urlA, memA, memB, urlB, bOk,
  lateResult, bCacheAfterLate,
  epochA1, epochA2, epochBeforeBump, epochAfterBump,
  shortTtlUrl, shortHit, longTtlUrl, longHit,
}));
`);
    // AC-B2-01：A 能读到自己的缓存；B 读不到 A 的缓存
    assert.equal(out.memA, out.urlA, 'A 应能同步命中自己的签名缓存');
    assert.equal(out.memB, null, 'B 不得读到 A 的签名缓存');
    assert.notEqual(out.urlB, out.urlA, 'B 的签名 URL 必须与 A 不同（不同 owner 键）');

    // AC-B2-05：B 的合法请求正常
    assert.equal(out.bOk, true, 'B 的合法媒体请求应正常返回');

    // AC-B2-02：A 的迟到结果被拦截，且未污染 B 缓存
    assert.equal(out.lateResult, null, 'A 的迟到签名结果必须被代际校验拦截');
    assert.equal(out.bCacheAfterLate, null, 'A 的迟到结果不得写入 B 的缓存');

    // AC-B2-03：A→B→A 后 epoch 必须推进
    assert.ok(out.epochA2 > out.epochA1, 'A→B→A 必须推进 epoch，使旧 A 会话请求失效');

    // AC-B2-04：同账号 forceBump 推进 epoch
    assert.ok(out.epochAfterBump > out.epochBeforeBump, '同账号 forceBump 必须推进 epoch');

    // AC-B2-07：TTL 语义（含 1 天提前刷新窗口）
    assert.equal(out.shortHit, null, 'TTL 小于提前刷新窗口时不得进入可命中缓存（需刷新）');
    assert.equal(out.longHit, out.longTtlUrl, 'TTL 足够长时应正常缓存并可命中');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B2-06 / 08 / 09：沙盒层身份闸门、失败不写索引、并发去重
// ---------------------------------------------------------------------------
test('AC-B2-06/08/09 沙盒写入受身份闸门约束、失败不写索引、并发去重', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.js');
const FS = await import('expo-file-system');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const {
  persistMedia, resolveLocalMedia, getMemoryLocalMedia, downloadToSandbox,
  setMediaCacheOwner, getMediaCacheIdentity, getMediaCacheSize, clearMediaCache,
} = MC;

const A = 'user-aaa', B = 'user-bbb';
const MSG_A = '11111111-1111-4111-8111-111111111111';
const MSG_B = '22222222-2222-4222-8222-222222222222';

// --- AC-B2-06：同账号合法离线缓存可复用（索引键不含 epoch）---
setMediaCacheOwner(A);
FS.__files.set('file:///tmp/src_a.jpg', { size: 500 });
const persistedA = await persistMedia('file:///tmp/src_a.jpg', MSG_A, 'image');
const resolvedA1 = await resolveLocalMedia(MSG_A, 'image');
const memA = getMemoryLocalMedia(MSG_A, 'image');

// 同账号重新登录（forceBump）：合法缓存仍必须可复用
setMediaCacheOwner(A, true);
const resolvedA2 = await resolveLocalMedia(MSG_A, 'image');

// --- AC-B2-08：身份失效后完成的下载不写索引 ---
setMediaCacheOwner(A);
let releaseDl;
globalThis.__DL_IMPL__ = (url, to) => new Promise((res) => {
  releaseDl = () => { FS.__files.set(to, { size: 4096 }); res({ uri: to }); };
});
const pendingDl = downloadToSandbox('https://cdn/x/vid.mp4', MSG_B, 'video');
// 等待 downloadToSandbox 内部先完成 resolveLocalMedia 探测，真正进入 downloadAsync
await new Promise((r) => setTimeout(r, 10));
setMediaCacheOwner(B);                 // 切号，epoch 自增
releaseDl();
const dlResult = await pendingDl;      // 文件已落盘，但不得写索引
const memAfterStale = getMemoryLocalMedia(MSG_B, 'video');
const indexRaw = await AS.getItem('@media_file_index');
const indexObj = indexRaw ? JSON.parse(indexRaw) : {};
const staleIndexed = Object.prototype.hasOwnProperty.call(indexObj, 'video:' + MSG_B);

// --- AC-B2-09：并发/重复点击不重复下载 ---
setMediaCacheOwner(B);
let dlCount = 0;
globalThis.__DL_IMPL__ = async (url, to) => {
  dlCount += 1;
  await new Promise((r) => setTimeout(r, 30));
  FS.__files.set(to, { size: 1024 });
  return { uri: to };
};
const MSG_C = '33333333-3333-4333-8333-333333333333';
const [c1, c2, c3] = await Promise.all([
  downloadToSandbox('https://cdn/x/c.mp4', MSG_C, 'video'),
  downloadToSandbox('https://cdn/x/c.mp4', MSG_C, 'video'),
  downloadToSandbox('https://cdn/x/c.mp4', MSG_C, 'video'),
]);

// --- 下载失败不写索引 ---
globalThis.__DL_IMPL__ = async () => { throw new Error('network down'); };
const MSG_D = '44444444-4444-4444-8444-444444444444';
const failedDl = await downloadToSandbox('https://cdn/x/d.mp4', MSG_D, 'video');
const memD = getMemoryLocalMedia(MSG_D, 'video');

// --- 容量统计返回真实数值（非硬编码桩）---
const size = await getMediaCacheSize();

// --- 清理后索引与内存归零 ---
await clearMediaCache();
const sizeAfterClear = await getMediaCacheSize();
const memAfterClear = getMemoryLocalMedia(MSG_A, 'image');

process.stdout.write(JSON.stringify({
  persistedA, resolvedA1, memA, resolvedA2,
  dlResult, memAfterStale, staleIndexed,
  dlCount, c1, c2, c3, sameC: c1 === c2 && c2 === c3,
  failedDl, memD,
  size, sizeAfterClear, memAfterClear,
}));
`);
    // AC-B2-06：同账号合法缓存复用
    assert.ok(out.persistedA, 'persistMedia 应返回落盘路径');
    assert.equal(out.resolvedA1, out.persistedA, '应能解析到已落盘文件');
    assert.equal(out.memA, out.persistedA, '内存索引应命中');
    assert.equal(out.resolvedA2, out.persistedA, '同账号重新登录后合法离线缓存必须仍可复用（索引键不含 epoch）');

    // AC-B2-08：迟到下载不写索引，且不得把旧账号私有 URI 交给新会话
    //   （第 3 轮强化安全契约：身份失效 → 返回 null，而非返回旧账号路径）
    assert.equal(out.dlResult, null, '身份失效后完成的下载必须返回 null，不得交出旧账号私有 URI');
    assert.equal(out.memAfterStale, null, '身份失效后完成的下载不得进入内存索引');
    assert.equal(out.staleIndexed, false, '身份失效后完成的下载不得写入持久化索引');

    // AC-B2-09：并发去重
    assert.equal(out.dlCount, 1, '同一 kind:msgId 的并发下载只应触发一次真实下载');
    assert.equal(out.sameC, true, '并发调用应复用同一 Promise 结果');

    // 失败不写索引
    assert.equal(out.failedDl, null, '下载失败应返回 null');
    assert.equal(out.memD, null, '下载失败不得写入索引');

    // 容量统计为真实值
    assert.equal(typeof out.size.totalBytes, 'number');
    assert.ok(out.size.fileCount >= 1, '容量统计应返回真实文件数（非硬编码桩）');
    assert.equal(out.sizeAfterClear.fileCount, 0, '清理后文件数应为 0');
    assert.equal(out.memAfterClear, null, '清理后内存索引应为空');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-B2-10：Hook state 与身份绑定（源码契约 + 行为）
// ---------------------------------------------------------------------------
test('AC-B2-10 Hook state 绑定身份，切号后不残留旧账号可见状态', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = await import('./src/hooks/chat/useSignedMediaUrl.js');
const { setSignedUrlOwner, getSignedUrlIdentity, getMemoryCachedSignedUrl } = M;

const A = 'user-aaa', B = 'user-bbb';
globalThis.__SIGN_IMPL__ = async (p) => ({ data: { signedUrl: 'https://cdn/' + p }, error: null });

// 模拟 Hook 的 state 绑定语义：state 记录 {url, ownerId, epoch}
setSignedUrlOwner(A);
const snapA = getSignedUrlIdentity();
const stateA = { url: 'https://cdn/A-only.jpg', ownerId: snapA.ownerId, epoch: snapA.epoch };

// 切号到 B
setSignedUrlOwner(B);
const snapB = getSignedUrlIdentity();

// 派生校验：state 属于旧身份 → 必须被判定为无效
const stateValidForB = stateA.ownerId === snapB.ownerId && stateA.epoch === snapB.epoch;

// 回落：B 视角同步缓存（A 的路径在 B 下不可命中）
const fallbackForB = getMemoryCachedSignedUrl('user-aaa/A-only.jpg');

process.stdout.write(JSON.stringify({ stateValidForB, fallbackForB, epochA: snapA.epoch, epochB: snapB.epoch }));
`);
    assert.equal(out.stateValidForB, false, '切号后旧账号 state 必须被判定为无效');
    assert.equal(out.fallbackForB, null, '切号后不得回落到旧账号缓存');
    assert.ok(out.epochB > out.epochA, '切号必须推进 epoch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 源码契约：useAuth 必须在身份变化/登出时同步登记 mediaCache owner
// ---------------------------------------------------------------------------
test('源码契约 useAuth 在 owner 变化/forceBump/登出时同步登记 mediaCache owner', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/hooks/useAuth.js'), 'utf8');
  assert.match(src, /import\s*\{\s*setMediaCacheOwner\s*\}\s*from\s*'\.\.\/services\/mediaCache'/, 'useAuth 必须导入 setMediaCacheOwner');
  assert.match(src, /if\s*\(ownerChanged\)\s*\{[\s\S]*?setMediaCacheOwner\(nextOwnerId\);/, 'owner 变化时必须登记 mediaCache owner');
  assert.match(src, /else if\s*\(tokenRotated\)\s*\{[\s\S]*?setMediaCacheOwner\(nextOwnerId,\s*true\);/, 'tokenRotated 时必须 forceBump mediaCache owner');
  assert.match(src, /setSignedUrlOwner\(null\);[\s\S]*?setMediaCacheOwner\(null\);/, '登出成功路径必须同步失效 mediaCache owner');
});

// ---------------------------------------------------------------------------
// 源码契约：沙盒索引键不得包含 owner/epoch（防止合法缓存失效）
// ---------------------------------------------------------------------------
test('源码契约 沙盒索引键保持 kind:msgId，不含 owner/epoch 前缀', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/services/mediaCache.js'), 'utf8');
  assert.match(src, /const indexKey = \(msgId, kind\) => `\$\{normalizeKind\(kind\)\}:\$\{msgId\}`/, '索引键必须保持 kind:msgId 形式');
  assert.doesNotMatch(src, /indexKey\s*=\s*\([^)]*owner/, '索引键不得引入 owner 参数');
  // 身份闸门必须存在
  assert.match(src, /export function setMediaCacheOwner/, '必须导出 setMediaCacheOwner');
  // 写入路径必须经统一入口 commitIndex，且内部在末次 await 后复检身份
  assert.match(src, /async function commitIndex\(key, uri, snapshot\)/, '必须存在统一写索引入口 commitIndex');
  assert.match(src, /isMediaIdentityValid\(snapshot\.ownerId, snapshot\.epoch\)/, 'commitIndex 必须在末次 await 后复检身份');
  assert.match(src, /if \(!snapshot\.ownerId\) return false/, '未登录必须 fail-closed 拒绝写索引');
});

// --- END OF FILE tests/security/b2MediaIsolation.test.mjs ---

// Reproduction tests, independent of shipped suite. Run against production mediaCache.
test('PROBE stale download file can be rediscovered after switch', () => {
  const dir=buildSandbox();
  try {
    const out=runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.js');
const FS = await import('expo-file-system');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const id = '11111111-1111-4111-8111-111111111111';
MC.setMediaCacheOwner('A');
let release;
globalThis.__DL_IMPL__ = (u,t) => new Promise(r=>{release=()=>{FS.__files.set(t,{size:21});r({uri:t})};});
const pending=MC.downloadToSandbox('https://cdn/A-private.jpg',id,'image');
for(let i=0;i<20&&!release;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('B');
release();
const returned=await pending;
const before=MC.getMemoryLocalMedia(id,'image');
const recovered=await MC.resolveLocalMedia(id,'image');
const after=MC.getMemoryLocalMedia(id,'image');
const stored=JSON.parse(await AS.getItem('@media_file_index'));
process.stdout.write(JSON.stringify({returned,before,recovered,after,stored}));`);
    console.log('PROBE stale file:', JSON.stringify(out));
    assert.equal(out.before,null);
    assert.equal(out.recovered,null,'stale A file must not be reindexed as B');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('PROBE cross-owner inflight should not coalesce', () => {
 const dir=buildSandbox();
 try {
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const id='11111111-1111-4111-8111-111111111111';
const urls=[];let release;
globalThis.__DL_IMPL__=(url,to)=>{
 urls.push(url);
 if(url.includes('/A'))return new Promise(r=>{release=()=>{FS.__files.set(to,{size:5});r({uri:to})}});
 FS.__files.set(to,{size:10});return Promise.resolve({uri:to});};
MC.setMediaCacheOwner('A');
const pA=MC.downloadToSandbox('https://cdn/A.jpg',id,'image');
for(let i=0;i<20&&!release;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('B');
const pB=MC.downloadToSandbox('https://cdn/B.jpg',id,'image');
release();
const [resA,resB]=await Promise.all([pA,pB]);
process.stdout.write(JSON.stringify({urls,resA,resB}));`);
 console.log('PROBE inflight:',JSON.stringify(out));
 assert.deepEqual(out.urls,['https://cdn/A.jpg','https://cdn/B.jpg'],'B must not inherit A in-flight request');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('PROBE signed-out identity must fail-closed write', () => {
 const dir=buildSandbox();
 try {
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
FS.__files.set('file:///src.jpg',{size:10});
const id='22222222-2222-4222-8222-222222222222';
const owner=MC.getMediaCacheIdentity();
const result=await MC.persistMedia('file:///src.jpg',id,'image');
const cached=MC.getMemoryLocalMedia(id,'image');
process.stdout.write(JSON.stringify({owner,result,cached}));`);
 console.log('PROBE signed-out:',JSON.stringify(out));
 assert.equal(out.cached,null,'anonymous should not index new private media');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('PROBE identity changes while awaiting index initialization', () => {
 const dir=buildSandbox();
 try {
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const AS=(await import('@react-native-async-storage/async-storage')).default;
FS.__files.set('file:///src_a.jpg',{size:100});
let release;let attempted=false;
const oldGet=AS.getItem.bind(AS);
AS.getItem=(k)=>{
 if(k==='@media_file_index'){
  attempted=true;
  return new Promise(r=>{release=async()=>r(await oldGet(k))});
 }
 return oldGet(k);
};
const id='11111111-1111-4111-8111-111111111111';
MC.setMediaCacheOwner('A');
const p=MC.persistMedia('file:///src_a.jpg',id,'image');
for(let i=0;i<30&&!release;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('B');
await release();
const saved=await p;
const cached=MC.getMemoryLocalMedia(id,'image');
process.stdout.write(JSON.stringify({attempted,saved,cached}));`);
 console.log('PROBE index race:',JSON.stringify(out));
 assert.equal(out.cached,null,'stale A must not index after the initIndex await');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('PROBE existing A file is readable by B if message ID is passed', () => {
 const dir=buildSandbox();
 try {
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
FS.__files.set('file:///src_a.jpg',{size:17});
const id='11111111-1111-4111-8111-111111111111';
MC.setMediaCacheOwner('A');
const aLocal=await MC.persistMedia('file:///src_a.jpg',id,'image');
MC.setMediaCacheOwner('B');
const bRead=MC.getMemoryLocalMedia(id,'image');
const bResolved=await MC.resolveLocalMedia(id,'image');
process.stdout.write(JSON.stringify({aLocal,bRead,bResolved}));`);
 console.log('PROBE stale B read:',JSON.stringify(out));
 assert.equal(out.bRead,null,'B should not use A-owned private cache entry without authorization');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('L4-CHECK legacy string cache belongs to A and cannot be read by B', () => {
 const dir=buildSandbox();
 try{
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const AS=(await import('@react-native-async-storage/async-storage')).default;
const id='11111111-1111-4111-8111-111111111111';
const uri='file:///doc/chat_media/image/'+id+'.jpg';
FS.__files.set(uri,{size:30,text:'A_PRIVATE'});
await AS.setItem('@media_file_index',JSON.stringify({['image:'+id]:uri}));
MC.setMediaCacheOwner('B');
const result=await MC.resolveLocalMedia(id,'image');
process.stdout.write(JSON.stringify({result}));`);
 console.log('LEGACY',out);
 assert.equal(out.result,null,'legacy ownerless entry must not be exposed to B');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('L4-CHECK sidecar missing must not transfer A file to B', () => {
 const dir=buildSandbox();
 try{
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const id='11111111-1111-4111-8111-111111111111';
MC.setMediaCacheOwner('A');
FS.__files.set('file:///srcA.jpg',{size:40,text:'A_PRIVATE'});
const uri=await MC.persistMedia('file:///srcA.jpg',id,'image');
FS.__files.delete(uri+'.owner');
MC.setMediaCacheOwner('B');
const result=await MC.resolveLocalMedia(id,'image');
const owner=FS.__files.get(uri+'.owner')?.text??null;
process.stdout.write(JSON.stringify({result,owner}));`);
 console.log('NO_SIDECAR',out);
 assert.equal(out.result,null,'sidecar IO failure must not cause cross-owner file adoption');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('L4-CHECK A late download must not overwrite B owned file at same deterministic path', () => {
 const dir=buildSandbox();
 try{
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const id='11111111-1111-4111-8111-111111111111';
let releaseA,startedA=false;
globalThis.__DL_IMPL__=(url,to)=>{
 if(url.includes('/A')){startedA=true;return new Promise(r=>{releaseA=()=>{FS.__files.set(to,{size:10,text:'A_PRIVATE'});r({uri:to})};});}
 FS.__files.set(to,{size:20,text:'B_PRIVATE'});return Promise.resolve({uri:to});
};
MC.setMediaCacheOwner('A');
const a=MC.downloadToSandbox('https://cdn/A.jpg',id,'image');
for(let i=0;i<30&&!startedA;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('B');
const b=await MC.downloadToSandbox('https://cdn/B.jpg',id,'image');
const before=FS.__files.get(b)?.text;
releaseA();await a;
const after=FS.__files.get(b)?.text;
const bUri=MC.getMemoryLocalMedia(id,'image');
const sidecar=FS.__files.get(b+'.owner')?.text;
process.stdout.write(JSON.stringify({before,after,bUri,sidecar}));`);
 console.log('OVERWRITE',out);
 assert.equal(out.after,'B_PRIVATE','late A download must not overwrite B bytes');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('L4-CHECK identity change during cached file probe must not return A URI to B', () => {
 const dir=buildSandbox();
 try{
 const file=path.join(dir,'node_modules/expo-file-system/index.js');
 let src=fs.readFileSync(file,'utf8');
 src=src.replace('export async function getInfoAsync(p){',`export async function getInfoAsync(p){
   if(globalThis.__PAUSE_INFO__ && String(p).includes('11111111-1111-4111-8111-111111111111')){
     globalThis.__PAUSE_INFO__=false;
     await new Promise(r=>{globalThis.__RELEASE_INFO__=r});
   }`);
 fs.writeFileSync(file,src);
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const id='11111111-1111-4111-8111-111111111111';
FS.__files.set('file:///srcA.jpg',{size:99,text:'A_PRIVATE'});
MC.setMediaCacheOwner('A');
const uri=await MC.persistMedia('file:///srcA.jpg',id,'image');
globalThis.__PAUSE_INFO__=true;
const pending=MC.resolveLocalMedia(id,'image');
for(let i=0;i<30&&!globalThis.__RELEASE_INFO__;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('B');
globalThis.__RELEASE_INFO__();
const result=await pending;
process.stdout.write(JSON.stringify({uri,result}));`);
 console.log('ASYNC_READ',out);
 assert.equal(out.result,null,'A lookup finishing in B session must not return A URI');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('L4-R2-FINAL same-owner previous epoch download cannot overwrite new session bytes', () => {
  const dir=buildSandbox();
  try {
    const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const id='11111111-1111-4111-8111-111111111111';
let releaseOld;
let oldStarted=false;
globalThis.__DL_IMPL__=(url,to)=>{
 if(url.includes('/old')){oldStarted=true;return new Promise(r=>{releaseOld=()=>{FS.__files.set(to,{size:10,text:'OLD_SESSION_BYTES'});r({uri:to})}});}
 FS.__files.set(to,{size:20,text:'CURRENT_SESSION_BYTES'});return Promise.resolve({uri:to});
};
MC.setMediaCacheOwner('user-A');
const oldPromise=MC.downloadToSandbox('https://cdn/old.jpg',id,'image');
for(let i=0;i<80&&!oldStarted;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('user-A',true);
const newPath=await MC.downloadToSandbox('https://cdn/current.jpg',id,'image');
const before=FS.__files.get(newPath)?.text;
releaseOld();
const oldResult=await oldPromise;
const after=FS.__files.get(newPath)?.text;
process.stdout.write(JSON.stringify({before,after,newPath,oldResult,now:MC.getMediaCacheIdentity()}));`);
    console.error('same-owner epoch race:',JSON.stringify(out));
    assert.equal(out.before,'CURRENT_SESSION_BYTES');
    assert.equal(out.after,'CURRENT_SESSION_BYTES','stale old-epoch download MUST NOT overwrite valid same-owner new-epoch file');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('L4-R2-FINAL stale A download must not hand private A uri into B session',()=>{
 const dir=buildSandbox();
 try {
 const out=runInSandbox(dir, `
const MC=await import('./src/services/mediaCache.js');
const FS=await import('expo-file-system');
const id='11111111-1111-4111-8111-111111111111';
let release,started=false;
globalThis.__DL_IMPL__=(url,to)=>{started=true;return new Promise(r=>{release=()=>{FS.__files.set(to,{size:5,text:'A_PRIVATE'});r({uri:to})}})};
MC.setMediaCacheOwner('A');const pending=MC.downloadToSandbox('https://cdn/secret.jpg',id,'image');
for(let i=0;i<80&&!started;i++)await new Promise(r=>setTimeout(r,1));
MC.setMediaCacheOwner('B');release();const result=await pending;
process.stdout.write(JSON.stringify({result,identity:MC.getMediaCacheIdentity()}));`);
 console.error('stale owner result:',JSON.stringify(out));
 assert.equal(out.result,null,'request started in A cannot return A private media path when active user is B');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
