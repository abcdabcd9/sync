// --- START OF FILE tests/security/d07MediaCacheReuse.test.mjs ---
// ============================================================================
// TASK-P0.3 / VERIFY-03 (D-07) — 媒体缓存「实际网络请求计数」验证
//
// 目的：D-07 手工测试确认「媒体缓存可用」，但「重复下载」未验证。
//       本测试不依赖肉眼观察，而是**统计真实 downloadAsync 网络调用次数**，
//       证明：
//         D07-A 同一媒体第二次打开（缓存命中）不触发第二次网络下载；
//         D07-B 同账号重新登录（forceBump）后合法缓存仍复用，不重复下载；
//         D07-C 跨账号缓存隔离：B 不能命中 A 的缓存，且 B 首次打开会真实下载一次；
//         D07-D 冷启动（新进程、索引持久化）后仍命中缓存，不重复下载。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」mediaCache.js。
//   - 断言针对真实生产接口（downloadToSandbox / resolveLocalMedia）。
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
// 与 b2MediaIsolation.test.mjs 保持一致的虚拟文件系统契约。
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd07-media-'));
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
  fs.mkdirSync(path.join(nm, 'expo-file-system'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'expo-file-system', 'legacy.js'), `export * from './index.js';\n`);

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/services/mediaCache.js');

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
// D07-A / D07-B / D07-C：同进程内网络请求计数
// ---------------------------------------------------------------------------
test('D07-A/B/C 缓存命中不重复下载、同账号重登复用、跨账号隔离', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.js');
const FS = await import('expo-file-system');
const {
  downloadToSandbox, resolveLocalMedia, getMemoryLocalMedia, setMediaCacheOwner,
} = MC;

const A = 'user-aaa', B = 'user-bbb';
const MSG = '11111111-1111-4111-8111-111111111111';
const URL = 'https://cdn/x/photo.jpg';

// 统计真实网络下载次数
let dlCount = 0;
globalThis.__DL_IMPL__ = async (url, to) => {
  dlCount += 1;
  FS.__files.set(to, { size: 4096 });
  return { uri: to };
};

// --- D07-A：首次打开 → 真实下载 1 次 ---
setMediaCacheOwner(A);
const first = await downloadToSandbox(URL, MSG, 'image');
const afterFirst = dlCount;

// 第二次打开同一媒体（缓存命中路径）→ 不得再下载
const second = await downloadToSandbox(URL, MSG, 'image');
const afterSecond = dlCount;

// 直接走 resolveLocalMedia（UI 打开时的解析路径）→ 同样不得下载
const resolved = await resolveLocalMedia(MSG, 'image');
const afterResolve = dlCount;

// --- D07-B：同账号重新登录（forceBump）→ 合法缓存仍复用，不重复下载 ---
setMediaCacheOwner(A, true);
const afterRelogin = await downloadToSandbox(URL, MSG, 'image');
const afterReloginCount = dlCount;

// --- D07-C：跨账号隔离 → B 不得命中 A 的缓存 ---
setMediaCacheOwner(B);
const memForB = getMemoryLocalMedia(MSG, 'image');
const resolvedForB = await resolveLocalMedia(MSG, 'image');
const countBeforeBDownload = dlCount;
const bDownload = await downloadToSandbox(URL, MSG, 'image');
const countAfterBDownload = dlCount;

process.stdout.write(JSON.stringify({
  first, afterFirst,
  second, afterSecond,
  resolved, afterResolve,
  afterRelogin, afterReloginCount,
  memForB, resolvedForB,
  countBeforeBDownload, bDownload, countAfterBDownload,
}));
`);
    // D07-A：首次真实下载 1 次；第二次打开不再下载
    assert.ok(out.first, '首次打开应返回本地路径');
    assert.equal(out.afterFirst, 1, '首次打开应触发 1 次真实网络下载');
    assert.equal(out.second, out.first, '第二次打开应命中同一缓存文件');
    assert.equal(out.afterSecond, 1, '第二次打开不得触发新的网络下载（缓存命中）');
    assert.equal(out.resolved, out.first, 'resolveLocalMedia 应命中已缓存文件');
    assert.equal(out.afterResolve, 1, 'resolveLocalMedia 不得触发网络下载');

    // D07-B：同账号重登复用
    assert.equal(out.afterRelogin, out.first, '同账号重新登录后应复用同一缓存文件');
    assert.equal(out.afterReloginCount, 1, '同账号重新登录后不得重复下载');

    // D07-C：跨账号隔离
    assert.equal(out.memForB, null, 'B 不得命中 A 的内存缓存');
    assert.equal(out.resolvedForB, null, 'B 不得解析到 A 的缓存文件');
    assert.equal(out.countBeforeBDownload, 1, 'B 首次打开前不应有额外下载');
    assert.ok(out.bDownload, 'B 首次打开应能正常下载自己的缓存');
    assert.equal(out.countAfterBDownload, 2, 'B 首次打开应触发 1 次真实下载（累计 2 次）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D07-D：冷启动（新进程 + 持久化索引）后仍命中缓存，不重复下载
// ---------------------------------------------------------------------------
test('D07-D 冷启动后持久化索引命中，不重复下载', () => {
  const dir = buildSandbox();
  try {
    // 第一阶段：下载并落盘（进程结束，索引写入 AsyncStorage 持久层）
    const phase1 = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.js');
const FS = await import('expo-file-system');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const MSG = '22222222-2222-4222-8222-222222222222';
const URL = 'https://cdn/x/cold.jpg';
let dlCount = 0;
globalThis.__DL_IMPL__ = async (url, to) => { dlCount += 1; FS.__files.set(to, { size: 4096 }); return { uri: to }; };
MC.setMediaCacheOwner('user-aaa');
const first = await MC.downloadToSandbox(URL, MSG, 'image');
const indexRaw = await AS.getItem('@media_file_index');
// 把虚拟文件系统与索引快照导出，供第二阶段还原（模拟冷启动持久化）
const filesDump = [...FS.__files.entries()];
const dirsDump = [...FS.__dirs];
process.stdout.write(JSON.stringify({ first, dlCount, indexRaw, filesDump, dirsDump }));
`);

    assert.ok(phase1.first, '第一阶段应成功下载');
    assert.equal(phase1.dlCount, 1, '第一阶段应触发 1 次真实下载');
    assert.ok(phase1.indexRaw, '第一阶段应写入持久化索引');

    // 第二阶段：新进程，还原持久化文件系统 + 索引，再次打开 → 不得下载
    const phase2 = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.js');
const FS = await import('expo-file-system');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const MSG = '22222222-2222-4222-8222-222222222222';
const URL = 'https://cdn/x/cold.jpg';
const seed = ${JSON.stringify({ filesDump: phase1.filesDump, dirsDump: phase1.dirsDump, indexRaw: phase1.indexRaw })};
// 还原「上次运行」的持久化状态
for (const [k, v] of seed.filesDump) FS.__files.set(k, v);
for (const d of seed.dirsDump) FS.__dirs.add(d);
await AS.setItem('@media_file_index', seed.indexRaw);
let dlCount = 0;
globalThis.__DL_IMPL__ = async (url, to) => { dlCount += 1; FS.__files.set(to, { size: 4096 }); return { uri: to }; };
MC.setMediaCacheOwner('user-aaa');
const reopened = await MC.downloadToSandbox(URL, MSG, 'image');
const resolved = await MC.resolveLocalMedia(MSG, 'image');
process.stdout.write(JSON.stringify({ reopened, resolved, dlCount }));
`);

    assert.equal(phase2.reopened, phase1.first, '冷启动后应命中同一缓存文件');
    assert.equal(phase2.resolved, phase1.first, '冷启动后 resolveLocalMedia 应命中缓存');
    assert.equal(phase2.dlCount, 0, '冷启动后打开已缓存媒体不得触发任何网络下载');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- END OF FILE tests/security/d07MediaCacheReuse.test.mjs ---
