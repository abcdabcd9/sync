// --- START OF FILE tests/security/p04_d3d4CacheCount.test.mjs ---
// ============================================================================
// TASK-P0.4 / D3 + D4 — 媒体缓存「请求计数」与「容量统计/清理」回归测试
//
// 目的：P0.3 的 d07MediaCacheReuse 覆盖了「缓存命中不重复下载」，但未对以下
//       两点做可执行断言：
//         D3 请求计数（fail-closed + 并发去重）：
//            · 未登录（无 owner）时 downloadToSandbox 必须 fail-closed，
//              不发起任何网络下载、不落盘、返回 null；
//            · 同一 owner+epoch 的并发下载必须复用同一 Promise，
//              真实网络下载次数恰好为 1（并发去重）。
//         D4 容量统计与清理：
//            · getMediaCacheSize 必须递归统计 chat_media/ 下所有 owner 分区的
//              文件数与字节数；
//            · clearMediaCache 必须删除整个 chat_media/ 目录、清空索引，
//              返回 { ok:true }，且清理后容量归零。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub（AsyncStorage / expo-file-system legacy）+ 临时目录运行
//     「真实源码」mediaCache.js，统计真实 downloadAsync 调用次数。
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

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-d3d4-'));
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

  // expo-file-system（legacy）：虚拟文件系统，与 d07 测试契约一致。
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

  // P1.2 R6：mediaCache 已迁移为 TypeScript。按 .ts 优先、.js 兜底解析，
  // 使沙箱始终复制当前真实源码（迁移后为 .ts，Node 24 原生类型擦除执行）。
  const resolveSrc = (rel) => {
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  const copy = (rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    const dst = path.join(dir, actual);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/services/mediaCache.js');

  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const supabase = {
  from() { return { select() { return this; }, eq() { return this; }, single() { return Promise.resolve({ data: null, error: null }); } }; },
  storage: { from() { return { createSignedUrl(p) { return Promise.resolve({ data: { signedUrl: 'https://x/' + p }, error: null }); } }; } },
};
export const authStorageStatus = { get: () => null };
export const AUTH_STORAGE_ERROR = { UNAVAILABLE: 'UNAVAILABLE', MIGRATION_FAILED: 'MIGRATION_FAILED', LEGACY_CLEANUP_FAILED: 'LEGACY_CLEANUP_FAILED' };
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

// ---------------------------------------------------------------------------
// P04-D3-01：未登录（无 owner）时 downloadToSandbox fail-closed，零网络请求
// ---------------------------------------------------------------------------
test('P04-D3-01 无 owner 时 downloadToSandbox fail-closed 且不发起网络下载', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.ts');
const FS = await import('expo-file-system');
let dlCount = 0;
globalThis.__DL_IMPL__ = async (url, to) => { dlCount += 1; FS.__files.set(to, { size: 4096 }); return { uri: to }; };
// 未调用 setMediaCacheOwner → owner 为 null
const r = await MC.downloadToSandbox('https://cdn/x/a.jpg', 'msg-1', 'image');
process.stdout.write(JSON.stringify({ r, dlCount, fileCount: FS.__files.size }));
`);
    assert.equal(out.r, null, '无 owner 时必须返回 null（fail-closed）');
    assert.equal(out.dlCount, 0, '无 owner 时不得发起任何网络下载');
    assert.equal(out.fileCount, 0, '无 owner 时不得落盘任何文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-D3-02：同 owner+epoch 并发下载去重，真实网络下载恰好 1 次
// ---------------------------------------------------------------------------
test('P04-D3-02 同 owner 并发下载去重，网络请求恰好 1 次', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.ts');
const FS = await import('expo-file-system');
let dlCount = 0;
globalThis.__DL_IMPL__ = async (url, to) => {
  dlCount += 1;
  // 模拟网络延迟，确保两个调用真正并发重叠
  await new Promise((r) => setTimeout(r, 20));
  FS.__files.set(to, { size: 4096 });
  return { uri: to };
};
MC.setMediaCacheOwner('user-A');
const URL = 'https://cdn/x/photo.jpg';
const MSG = 'msg-concurrent';
const [r1, r2, r3] = await Promise.all([
  MC.downloadToSandbox(URL, MSG, 'image'),
  MC.downloadToSandbox(URL, MSG, 'image'),
  MC.downloadToSandbox(URL, MSG, 'image'),
]);
process.stdout.write(JSON.stringify({ r1, r2, r3, dlCount }));
`);
    assert.equal(out.dlCount, 1, '并发下载必须去重，真实网络下载恰好 1 次');
    assert.ok(out.r1 && out.r2 && out.r3, '三个并发调用都应返回有效 uri');
    assert.equal(out.r1, out.r2, '并发调用应复用同一结果 uri');
    assert.equal(out.r2, out.r3, '并发调用应复用同一结果 uri');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-D4-01：getMediaCacheSize 递归统计多 owner 分区的文件数与字节数
// ---------------------------------------------------------------------------
test('P04-D4-01 getMediaCacheSize 递归统计所有 owner 分区的文件与字节', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.ts');
const FS = await import('expo-file-system');
globalThis.__DL_IMPL__ = async (url, to) => { FS.__files.set(to, { size: 1000 }); return { uri: to }; };
// A 下载 2 个、B 下载 1 个 → 共 3 个文件，每个 1000 字节
MC.setMediaCacheOwner('user-A');
await MC.downloadToSandbox('https://cdn/a/1.jpg', 'a1', 'image');
await MC.downloadToSandbox('https://cdn/a/2.mp4', 'a2', 'video');
MC.setMediaCacheOwner('user-B');
await MC.downloadToSandbox('https://cdn/b/3.jpg', 'b1', 'image');
const size = await MC.getMediaCacheSize();
process.stdout.write(JSON.stringify({ size }));
`);
    assert.equal(out.size.fileCount, 3, '应统计到 3 个文件（跨 2 个 owner 分区）');
    assert.equal(out.size.totalBytes, 3000, '应统计到 3000 字节（3 × 1000）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-D4-02：clearMediaCache 删除全部缓存并清空索引，容量归零
// ---------------------------------------------------------------------------
test('P04-D4-02 clearMediaCache 清空缓存目录与索引，容量归零', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const MC = await import('./src/services/mediaCache.ts');
const FS = await import('expo-file-system');
const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
globalThis.__DL_IMPL__ = async (url, to) => { FS.__files.set(to, { size: 500 }); return { uri: to }; };
MC.setMediaCacheOwner('user-A');
await MC.downloadToSandbox('https://cdn/a/1.jpg', 'a1', 'image');
await MC.downloadToSandbox('https://cdn/a/2.jpg', 'a2', 'image');
const before = await MC.getMediaCacheSize();
const indexBefore = await AsyncStorage.getItem('@media_file_index');
const clearResult = await MC.clearMediaCache();
const after = await MC.getMediaCacheSize();
const indexAfter = await AsyncStorage.getItem('@media_file_index');
const filesLeft = FS.__files.size;
process.stdout.write(JSON.stringify({ before, indexBefore, clearResult, after, indexAfter, filesLeft }));
`);
    assert.equal(out.before.fileCount, 2, '清理前应有 2 个文件');
    assert.ok(out.indexBefore, '清理前应存在媒体索引');
    assert.equal(out.clearResult.ok, true, 'clearMediaCache 应返回 ok:true');
    assert.equal(out.after.fileCount, 0, '清理后文件数应归零');
    assert.equal(out.after.totalBytes, 0, '清理后字节数应归零');
    assert.equal(out.indexAfter, null, '清理后媒体索引应被移除');
    assert.equal(out.filesLeft, 0, '清理后虚拟文件系统不应残留任何缓存文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_d3d4CacheCount.test.mjs ---
