// --- START OF FILE tests/security/p12r6MigrationEquivalence.test.mjs ---
/**
 * P1.2 R6 — mediaCache TypeScript 迁移行为等价测试
 *
 * 目的
 *   在**隔离沙箱**中分别执行：
 *     · 迁移前 JS 全文（冻结基线 `tests/fixtures/p12r6/before/services__mediaCache.js`）
 *     · 迁移后 TS 实现（`src/services/mediaCache.ts`）
 *   对同一组可注入依赖（内存 fake FileSystem / AsyncStorage）与同一组可控时序，
 *   比较**完整可观测结果**（返回值、索引内容、文件操作序列、异常行为），断言逐项一致。
 *
 * 约束
 *   · 不访问真实文件系统 / AsyncStorage / 网络 / 数据库。
 *   · 基线只读，不得修改以制造通过。
 *   · 无法在隔离环境验证的真实行为标记 UNVERIFIED，不伪造 PASS。
 *
 * 覆盖（18 项 + 不变量）
 *   E1  init：索引从 AsyncStorage 载入
 *   E2  persistMedia 写入 → 文件落盘 + 索引写入
 *   E3  resolveLocalMedia 命中（索引 + 文件存在）
 *   E4  resolveLocalMedia 未命中 → null
 *   E5  resolveLocalMedia 索引存在但文件已删 → 清理索引并返回 null
 *   E6  索引持久化格式（kind:msgId -> {uri, ownerId}）
 *   E7  并发 persistMedia 同目标 → 串行提交、结果一致
 *   E8  文件系统异常（copyAsync 抛错）→ 返回源 uri（身份有效时）
 *   E9  AsyncStorage 异常（setItem 抛错）→ 不抛、索引内存态仍更新
 *   E10 未登录（ownerId=null）→ persistMedia / resolveLocalMedia / downloadToSandbox 全部 null
 *   E11 A→B 切换：B 无法读取 A 的缓存
 *   E12 A→B→A 切换：A 重新登录后仍可读取自己的缓存
 *   E13 迟到异步写回：发起时 A，完成时已切 B → 不写 B 的索引、返回 null
 *   E14 重复操作幂等（同 msgId 二次 persist 复用已有文件）
 *   E15 缓存删除失败（deleteAsync 抛错）→ clearMediaCache 返回 ok:false
 *   E16 索引损坏（JSON 非法）→ initIndex 不抛、索引为空
 *   E17 downloadToSandbox 并发去重（同 owner+epoch 复用同一 Promise）
 *   E18 normalizeKind 全输入域等价（经真实公开 API 间接观测，含原型键）
 *   E19 normalizeFileUri / isLocalUri 纯函数等价
 *   E20 getInfoAsync 调用参数等价（含 getMediaCacheSize 目录测量路径的 `{ size: true }`）
 *   E21 clearMediaCache 全局清理行为等价（旧 JS / 新 TS 逐项一致）
 *
 *   不变量（B3）
 *   INV1  A 的缓存不可被 B 读取
 *   INV2  账号切换不复用旧用户私有索引
 *   INV3  旧异步请求完成不写入新用户缓存
 *   INV4  并发索引写入受提交锁保护
 *   INV5  文件写失败不误判为成功
 *   INV6  物理路径按 owner 分区：A/B 同 msgId 各自独立落盘，互不覆盖
 *         （注：本项只验证「物理路径分区隔离」，**不**验证清理隔离；
 *           清理行为见 E21，且 clearMediaCache 为全局清理，非按账号选择性清理）
 *   INV7  非法 owner/userId 处理与旧实现一致
 *   INV8  索引持久化格式不变
 *   INV9  文件系统/存储异常沿原路径处理
 *   INV10 日志敏感信息处理不变（仅记录错误对象，不记录 uri 明文以外的隐私）
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
const beforeDir = path.join(repoRoot, 'tests/fixtures/p12r6/before');

// ---------------------------------------------------------------------------
// 基线完整性：先校验冻结夹具 SHA-256，防止基线被篡改
// ---------------------------------------------------------------------------
const EXPECTED_SHA = {
  'services__mediaCache.js': '688875fc641bd6b6dfb4f946b296daa3b798f63394de70565267d6b0e62d48cd',
};

test('R6-0 冻结基线完整性（SHA-256 未被篡改）', () => {
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
 * 内存 fake FileSystem（模拟 expo-file-system/legacy 的异步 API）。
 * 所有操作记录到 `ops` 数组，供比较「文件操作序列」。
 */
const FAKE_FS = `
export const documentDirectory = 'file:///doc/';
const files = new Map(); // path -> { size, isDirectory }
const ops = [];
export const __files = files;
export const __ops = ops;
export const __reset = () => { files.clear(); ops.length = 0; };
export const __seed = (p, size) => { files.set(p, { size, isDirectory: false }); };
export const __seedDir = (p) => { files.set(p, { size: 0, isDirectory: true }); };
export const __failNext = (() => { let f = null; return { set: (fn) => { f = fn; }, take: () => { const x = f; f = null; return x; } }; })();
// ⚠️ 记录 getInfoAsync 的**完整参数**（path + options），用于断言迁移前后调用参数一致。
export async function getInfoAsync(p, opts) {
  ops.push(['getInfo', p, opts === undefined ? '__UNDEF__' : JSON.parse(JSON.stringify(opts))]);
  const f = files.get(p);
  if (!f) return { exists: false };
  return { exists: true, uri: p, size: f.size, isDirectory: f.isDirectory, modificationTime: 0 };
}
export async function makeDirectoryAsync(p) {
  ops.push(['mkdir', p]);
  files.set(p, { size: 0, isDirectory: true });
}
export async function copyAsync({ from, to }) {
  ops.push(['copy', from, to]);
  const fail = __failNext.take();
  if (fail) throw fail;
  const f = files.get(from);
  if (!f) throw new Error('ENOENT: ' + from);
  files.set(to, { size: f.size, isDirectory: false });
}
export async function downloadAsync(url, to) {
  ops.push(['download', url, to]);
  const fail = __failNext.take();
  if (fail) throw fail;
  files.set(to, { size: 100, isDirectory: false });
  return { uri: to, status: 200 };
}
// ⚠️ 正确模拟递归目录删除：删除目录时一并删除其下所有子路径。
export async function deleteAsync(p, opts) {
  ops.push(['delete', p]);
  const fail = __failNext.take();
  if (fail) throw fail;
  const exists = files.has(p);
  if (!exists && !(opts && opts.idempotent)) throw new Error('ENOENT: ' + p);
  const base = p.endsWith('/') ? p : p + '/';
  for (const k of Array.from(files.keys())) {
    if (k === p || k.startsWith(base)) files.delete(k);
  }
}
export async function readDirectoryAsync(p) {
  ops.push(['readdir', p]);
  const base = p.endsWith('/') ? p : p + '/';
  const out = [];
  for (const k of files.keys()) {
    if (k.startsWith(base) && k !== base) {
      // 目录条目可能以尾斜杠形式存储（如 'u1/'），需归一化后再判断层级
      const rest = k.slice(base.length).replace(/\\/+$/, '');
      if (rest && !rest.includes('/')) out.push(rest);
    }
  }
  return out;
}
`;

/**
 * 内存 fake AsyncStorage。
 */
const FAKE_ASYNC = `
const store = new Map();
export const __store = store;
export const __reset = () => store.clear();
export const __failNext = (() => { let f = null; return { set: (fn) => { f = fn; }, take: () => { const x = f; f = null; return x; } }; })();
export default {
  async getItem(k) { const f = __failNext.take(); if (f) throw f; return store.has(k) ? store.get(k) : null; },
  async setItem(k, v) { const f = __failNext.take(); if (f) throw f; store.set(k, v); },
  async removeItem(k) { const f = __failNext.take(); if (f) throw f; store.delete(k); },
};
`;

/**
 * 在隔离沙箱中执行一段 case 代码。
 * @param {'before'|'after'} variant
 * @param {string} caseCode ESM 源码，需自行 process.stdout.write(JSON.stringify(...))
 */
function runSandbox(variant, caseCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p12r6-${variant}-`));
  try {
    fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src/types'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/expo-file-system/legacy'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/@react-native-async-storage/async-storage'), { recursive: true });

    if (variant === 'before') {
      fs.copyFileSync(
        path.join(beforeDir, 'services__mediaCache.js'),
        path.join(dir, 'src/services/mediaCache.js'),
      );
    } else {
      fs.copyFileSync(
        path.join(repoRoot, 'src/services/mediaCache.ts'),
        path.join(dir, 'src/services/mediaCache.ts'),
      );
      // 迁移后 TS 依赖 src/types/media 的类型导入（type-only，运行时被擦除，
      // 但为稳妥仍提供最小声明文件，避免解析失败）。
      fs.writeFileSync(
        path.join(dir, 'src/types/media.ts'),
        'export type MediaCacheKind = "audio" | "image" | "video" | "thumb";\n' +
          'export interface MediaCacheIdentitySnapshot { ownerId: string | null; epoch: number; }\n',
      );
    }

    // 注入 fake 模块
    fs.writeFileSync(path.join(dir, 'node_modules/expo-file-system/legacy/index.mjs'), FAKE_FS);
    fs.writeFileSync(
      path.join(dir, 'node_modules/expo-file-system/package.json'),
      JSON.stringify({
        name: 'expo-file-system',
        type: 'module',
        exports: { './legacy': './legacy/index.mjs' },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'node_modules/@react-native-async-storage/async-storage/index.mjs'),
      FAKE_ASYNC,
    );
    fs.writeFileSync(
      path.join(dir, 'node_modules/@react-native-async-storage/async-storage/package.json'),
      JSON.stringify({
        name: '@react-native-async-storage/async-storage',
        type: 'module',
        main: 'index.mjs',
      }),
    );

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
        `沙箱执行失败（${variant}）status=${r.status}\nSTDERR:\n${r.stderr}\nSTDOUT:\n${r.stdout}`,
      );
    }
    const out = r.stdout.trim();
    const lastLine = out.split('\n').filter(Boolean).pop();
    return JSON.parse(lastLine);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 对 before / after 各跑一次同一 case，断言结果深度相等，并返回 after 结果。
 * `body` 为不含 prelude 的 case 主体；prelude 按变体注入正确扩展名。
 */
function assertEquivalent(body, label) {
  const before = runSandbox('before', prelude('js') + body);
  const after = runSandbox('after', prelude('ts') + body);
  assert.deepEqual(after, before, `${label}：迁移前后可观测行为不一致`);
  return after;
}

// ---------------------------------------------------------------------------
// 公共 case 前缀：导入 fake 模块 + 被测模块
// ---------------------------------------------------------------------------
/**
 * 生成 case 前缀。`ext` 为被测模块扩展名（before='js'，after='ts'）。
 * 显式扩展名导入不会触发 resolve-hook 的 .js→.ts 回退，故必须按变体区分。
 */
const prelude = (ext) => `
import * as FS from 'expo-file-system/legacy';
import AS, { __store, __reset as asReset, __failNext as asFailNext } from '@react-native-async-storage/async-storage';
AS.__store = __store;
AS.__reset = asReset;
AS.__failNext = asFailNext;
const mc = await import('./src/services/mediaCache.${ext}');
const out = (o) => process.stdout.write(JSON.stringify(o));
`;

// ---------------------------------------------------------------------------
// E1 init：索引从 AsyncStorage 载入
// ---------------------------------------------------------------------------
test('R6-E1 init 从 AsyncStorage 载入索引', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
FS.__seed('file:///doc/chat_media/u1/image/m1.jpg', 50);
AS.__store.set('@media_file_index', JSON.stringify({ 'image:m1': { uri: 'file:///doc/chat_media/u1/image/m1.jpg', ownerId: 'u1' } }));
mc.setMediaCacheOwner('u1');
const r = await mc.resolveLocalMedia('m1', 'image');
out({ r });
`,
    'E1',
  );
  assert.equal(res.r, 'file:///doc/chat_media/u1/image/m1.jpg');
});

// ---------------------------------------------------------------------------
// E2 persistMedia 写入 → 文件落盘 + 索引写入
// ---------------------------------------------------------------------------
test('R6-E2 persistMedia 落盘并写索引', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('u1');
const r = await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r, idx, ops: FS.__ops.filter(o => o[0] === 'copy') });
`,
    'E2',
  );
  assert.equal(res.r, 'file:///doc/chat_media/u1/image/m1.jpg');
  assert.deepEqual(res.idx['image:m1'], { uri: 'file:///doc/chat_media/u1/image/m1.jpg', ownerId: 'u1' });
});

// ---------------------------------------------------------------------------
// E3 resolveLocalMedia 命中
// ---------------------------------------------------------------------------
test('R6-E3 resolveLocalMedia 命中索引与文件', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
FS.__seed('file:///doc/chat_media/u1/image/m1.jpg', 50);
AS.__store.set('@media_file_index', JSON.stringify({ 'image:m1': { uri: 'file:///doc/chat_media/u1/image/m1.jpg', ownerId: 'u1' } }));
mc.setMediaCacheOwner('u1');
const r = await mc.resolveLocalMedia('m1', 'image');
out({ r });
`,
    'E3',
  );
  assert.equal(res.r, 'file:///doc/chat_media/u1/image/m1.jpg');
});

// ---------------------------------------------------------------------------
// E4 resolveLocalMedia 未命中 → null
// ---------------------------------------------------------------------------
test('R6-E4 resolveLocalMedia 未命中返回 null', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
mc.setMediaCacheOwner('u1');
const r = await mc.resolveLocalMedia('nope', 'image');
out({ r });
`,
    'E4',
  );
  assert.equal(res.r, null);
});

// ---------------------------------------------------------------------------
// E5 索引存在但文件已删 → 清理索引并返回 null
// ---------------------------------------------------------------------------
test('R6-E5 索引存在但文件缺失 → 清理索引返回 null', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
AS.__store.set('@media_file_index', JSON.stringify({ 'image:m1': { uri: 'file:///doc/chat_media/u1/image/m1.jpg', ownerId: 'u1' } }));
mc.setMediaCacheOwner('u1');
const r = await mc.resolveLocalMedia('m1', 'image');
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r, idx });
`,
    'E5',
  );
  assert.equal(res.r, null);
  assert.equal(res.idx['image:m1'], undefined);
});

// ---------------------------------------------------------------------------
// E6 索引持久化格式
// ---------------------------------------------------------------------------
test('R6-E6 索引持久化格式为 kind:msgId -> {uri, ownerId}', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('u1');
await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const raw = AS.__store.get('@media_file_index');
const idx = JSON.parse(raw);
const keys = Object.keys(idx);
const val = idx[keys[0]];
out({ keys, valKeys: Object.keys(val).sort(), ownerId: val.ownerId });
`,
    'E6',
  );
  assert.deepEqual(res.keys, ['image:m1']);
  assert.deepEqual(res.valKeys, ['ownerId', 'uri']);
  assert.equal(res.ownerId, 'u1');
});

// ---------------------------------------------------------------------------
// E7 并发 persistMedia 同目标 → 串行提交、结果一致
// ---------------------------------------------------------------------------
test('R6-E7 并发 persistMedia 同目标串行提交', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
FS.__seed('file:///tmp/b.jpg', 90);
mc.setMediaCacheOwner('u1');
const [r1, r2] = await Promise.all([
  mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image'),
  mc.persistMedia('file:///tmp/b.jpg', 'm1', 'image'),
]);
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r1, r2, idx });
`,
    'E7',
  );
  assert.equal(res.r1, 'file:///doc/chat_media/u1/image/m1.jpg');
  assert.equal(res.r2, 'file:///doc/chat_media/u1/image/m1.jpg');
  assert.equal(res.idx['image:m1'].ownerId, 'u1');
});

// ---------------------------------------------------------------------------
// E8 文件系统异常（copyAsync 抛错）→ 返回源 uri（身份有效时）
// ---------------------------------------------------------------------------
test('R6-E8 copyAsync 抛错 → 身份有效时回退源 uri', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('u1');
FS.__failNext.set(new Error('disk full'));
const r = await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r, idx });
`,
    'E8',
  );
  assert.equal(res.r, 'file:///tmp/src.jpg');
  assert.equal(res.idx['image:m1'], undefined);
});

// ---------------------------------------------------------------------------
// E9 AsyncStorage 异常（setItem 抛错）→ 不抛、索引内存态仍更新
// ---------------------------------------------------------------------------
test('R6-E9 AsyncStorage setItem 抛错 → 不抛、内存索引仍更新', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('u1');
AS.__failNext.set(new Error('storage full'));
const r = await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const mem = mc.getMemoryLocalMedia('m1', 'image');
out({ r, mem });
`,
    'E9',
  );
  assert.equal(res.r, 'file:///doc/chat_media/u1/image/m1.jpg');
  assert.equal(res.mem, 'file:///doc/chat_media/u1/image/m1.jpg');
});

// ---------------------------------------------------------------------------
// E10 未登录 → 全部 null
// ---------------------------------------------------------------------------
test('R6-E10 未登录 fail-closed 全部返回 null', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner(null);
const p = await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const r = await mc.resolveLocalMedia('m1', 'image');
const d = await mc.downloadToSandbox('https://x/y.jpg', 'm1', 'image');
const m = mc.getMemoryLocalMedia('m1', 'image');
out({ p, r, d, m });
`,
    'E10',
  );
  assert.deepEqual(res, { p: null, r: null, d: null, m: null });
});

// ---------------------------------------------------------------------------
// E11 A→B 切换：B 无法读取 A 的缓存
// ---------------------------------------------------------------------------
test('R6-E11 A→B 切换后 B 无法读取 A 的缓存', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('A');
await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
const r = await mc.resolveLocalMedia('m1', 'image');
const m = mc.getMemoryLocalMedia('m1', 'image');
out({ r, m });
`,
    'E11',
  );
  assert.equal(res.r, null);
  assert.equal(res.m, null);
});

// ---------------------------------------------------------------------------
// E12 A→B→A 切换：A 重新登录后仍可读取自己的缓存
// ---------------------------------------------------------------------------
test('R6-E12 A→B→A 切换后 A 仍可读取自己的缓存', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('A');
await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
mc.setMediaCacheOwner('A');
const r = await mc.resolveLocalMedia('m1', 'image');
out({ r });
`,
    'E12',
  );
  assert.equal(res.r, 'file:///doc/chat_media/A/image/m1.jpg');
});

// ---------------------------------------------------------------------------
// E13 迟到异步写回：发起时 A，完成时已切 B → 不写 B 的索引、返回 null
// ---------------------------------------------------------------------------
test('R6-E13 迟到异步写回不污染新账号', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('A');
// 发起 persistMedia，但在 copyAsync 完成前切到 B
const p = mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
const r = await p;
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r, idx });
`,
    'E13',
  );
  // 身份失效 → 不返回旧账号 URI
  assert.equal(res.r, null);
  // 不得写入 B 的索引条目
  assert.equal(res.idx['image:m1'], undefined);
});

// ---------------------------------------------------------------------------
// E14 重复操作幂等
// ---------------------------------------------------------------------------
test('R6-E14 同 msgId 二次 persist 复用已有文件', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('u1');
const r1 = await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const copies1 = FS.__ops.filter(o => o[0] === 'copy').length;
const r2 = await mc.persistMedia('file:///tmp/src.jpg', 'm1', 'image');
const copies2 = FS.__ops.filter(o => o[0] === 'copy').length;
out({ r1, r2, copies1, copies2 });
`,
    'E14',
  );
  assert.equal(res.r1, res.r2);
  // 第二次不应再 copy（已有合法文件复用）
  assert.equal(res.copies2, res.copies1);
});

// ---------------------------------------------------------------------------
// E15 缓存删除失败 → clearMediaCache 返回 ok:false
// ---------------------------------------------------------------------------
test('R6-E15 deleteAsync 抛错 → clearMediaCache ok:false', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
mc.setMediaCacheOwner('u1');
FS.__failNext.set(new Error('permission denied'));
const r = await mc.clearMediaCache();
out({ r });
`,
    'E15',
  );
  assert.equal(res.r.ok, false);
});

// ---------------------------------------------------------------------------
// E16 索引损坏（JSON 非法）→ initIndex 不抛、索引为空
// ---------------------------------------------------------------------------
test('R6-E16 索引 JSON 损坏 → 不抛、索引为空', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
AS.__store.set('@media_file_index', '{not valid json');
mc.setMediaCacheOwner('u1');
const r = await mc.resolveLocalMedia('m1', 'image');
out({ r });
`,
    'E16',
  );
  assert.equal(res.r, null);
});

// ---------------------------------------------------------------------------
// E17 downloadToSandbox 并发去重
// ---------------------------------------------------------------------------
test('R6-E17 downloadToSandbox 同 owner+epoch 并发去重', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
mc.setMediaCacheOwner('u1');
const [r1, r2] = await Promise.all([
  mc.downloadToSandbox('https://x/y.jpg', 'm1', 'image'),
  mc.downloadToSandbox('https://x/y.jpg', 'm1', 'image'),
]);
const downloads = FS.__ops.filter(o => o[0] === 'download').length;
out({ r1, r2, downloads });
`,
    'E17',
  );
  assert.equal(res.r1, res.r2);
  // 并发去重：只应下载一次
  assert.equal(res.downloads, 1);
});

// ---------------------------------------------------------------------------
// E18 纯函数等价
// ---------------------------------------------------------------------------
test('R6-E18 normalizeKind 全输入域等价（经真实公开 API 间接观测）', () => {
  // normalizeKind 未导出，故通过真实公开 API（persistMedia）间接观测其归一化结果：
  // 落盘路径中的 <kind> 目录段即 normalizeKind 的输出。
  // 覆盖：4 个合法 kind + 非法普通字符串 + 空字符串 + null/undefined + 数字
  //       + 原型链键 'toString' / 'constructor' / '__proto__'。
  // 旧实现 `KIND_DIRS[kind] ? kind : 'image'` 对原型键会返回该键本身，
  // 新实现必须保持完全一致（不得改为 hasOwnProperty 防御性硬化）。
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/src.jpg', 80);
mc.setMediaCacheOwner('u1');
const kinds = ['audio', 'image', 'video', 'thumb', 'bogus', '', null, undefined, 123, 'toString', 'constructor', '__proto__'];
const results = [];
for (let i = 0; i < kinds.length; i++) {
  const r = await mc.persistMedia('file:///tmp/src.jpg', 'm' + i, kinds[i]);
  results.push(r);
}
out({ results });
`,
    'E18',
  );
  // 逐项断言：原型键必须与旧实现完全一致。
  // 旧实现 `KIND_DIRS[kind] ? kind : 'image'` 对原型键返回该键本身，
  // 随后作为模板字符串插值进目录路径 → 触发原型键的 toString()：
  //   'toString'    → 'function toString() { [native code] }'
  //   'constructor' → 'function Object() { [native code] }'
  //   '__proto__'   → '[object Object]'
  // 这正是 Gatekeeper 实测到的旧 JS 真实行为，新 TS 必须逐字一致。
  assert.deepEqual(res.results, [
    'file:///doc/chat_media/u1/audio/m0.jpg',
    'file:///doc/chat_media/u1/image/m1.jpg',
    'file:///doc/chat_media/u1/video/m2.jpg',
    'file:///doc/chat_media/u1/thumb/m3.jpg',
    'file:///doc/chat_media/u1/image/m4.jpg',
    'file:///doc/chat_media/u1/image/m5.jpg',
    'file:///doc/chat_media/u1/image/m6.jpg',
    'file:///doc/chat_media/u1/image/m7.jpg',
    'file:///doc/chat_media/u1/image/m8.jpg',
    'file:///doc/chat_media/u1/function toString() { [native code] }/m9.jpg',
    'file:///doc/chat_media/u1/function Object() { [native code] }/m10.jpg',
    'file:///doc/chat_media/u1/[object Object]/m11.jpg',
  ]);
});

// ---------------------------------------------------------------------------
// E19 normalizeFileUri / isLocalUri 纯函数等价
// ---------------------------------------------------------------------------
test('R6-E19 normalizeFileUri / isLocalUri 纯函数等价', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
const uris = [
  'file:///a/b.jpg',
  'file:/a/b.jpg',
  'file:////a/b.jpg',
  '/a/b.jpg',
  'https://x/y.jpg',
  'content://a/b',
  'blob:abc',
  '',
  null,
  undefined,
  '  /a/b.jpg  ',
];
const uriOut = uris.map(u => mc.normalizeFileUri(u));
const isLocal = ['file:///a', 'https://x', 'content://a', 'data:x', 'ph://a', 'assets-library://a', '', null].map(u => mc.isLocalUri(u));
out({ uriOut, isLocal });
`,
    'E19',
  );
  assert.deepEqual(res.uriOut, [
    'file:///a/b.jpg',
    'file:///a/b.jpg',
    'file:///a/b.jpg',
    'file:///a/b.jpg',
    'https://x/y.jpg',
    'content://a/b',
    'blob:abc',
    null,
    null,
    null,
    'file:///a/b.jpg',
  ]);
  assert.deepEqual(res.isLocal, [true, false, true, true, true, true, false, false]);
});

// ---------------------------------------------------------------------------
// E20 getInfoAsync 调用参数等价（含 getMediaCacheSize 目录测量路径）
// ---------------------------------------------------------------------------
test('R6-E20 getInfoAsync 调用参数等价（含 { size: true }）', () => {
  // 旧 JS 在 measureDir 中调用 getInfoAsync(path, { size: true })；
  // 迁移后必须保持完全相同的运行时参数（不得退化为 {}）。
  // fake FS 记录完整参数，逐项比较迁移前后调用序列。
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seedDir('file:///doc/chat_media/');
FS.__seedDir('file:///doc/chat_media/u1/');
FS.__seedDir('file:///doc/chat_media/u1/image/');
FS.__seed('file:///doc/chat_media/u1/image/m1.jpg', 50);
FS.__seed('file:///doc/chat_media/u1/image/m2.jpg', 70);
mc.setMediaCacheOwner('u1');
const size = await mc.getMediaCacheSize();
const getInfoOps = FS.__ops.filter(o => o[0] === 'getInfo');
out({ size, getInfoOps });
`,
    'E20',
  );
  // 目录测量结果一致
  assert.deepEqual(res.size, { totalBytes: 120, fileCount: 2 });
  // 迁移前后 getInfoAsync 的完整参数序列必须逐项一致。
  // 注意：measureDir 对每个条目先探测无尾斜杠形式，未命中再探测尾斜杠形式，
  // 因此目录条目会出现两次 getInfo（均带 `{ size: true }`）。
  assert.deepEqual(res.getInfoOps, [
    ['getInfo', 'file:///doc/chat_media/', '__UNDEF__'],
    ['getInfo', 'file:///doc/chat_media/u1', { size: true }],
    ['getInfo', 'file:///doc/chat_media/u1/', { size: true }],
    ['getInfo', 'file:///doc/chat_media/u1/image', { size: true }],
    ['getInfo', 'file:///doc/chat_media/u1/image/', { size: true }],
    ['getInfo', 'file:///doc/chat_media/u1/image/m1.jpg', { size: true }],
    ['getInfo', 'file:///doc/chat_media/u1/image/m2.jpg', { size: true }],
  ]);
});

// ---------------------------------------------------------------------------
// E21 clearMediaCache 全局清理行为等价
// ---------------------------------------------------------------------------
test('R6-E21 clearMediaCache 全局清理行为等价（旧 JS / 新 TS 一致）', () => {
  // 诚实记录：clearMediaCache 删除整个 MEDIA_ROOT（全局清理），
  // 并非「仅清理当前账号」。本用例验证迁移前后该全局清理行为完全一致，
  // 且**不**声称实现了按账号选择性清理。
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
FS.__seed('file:///tmp/b.jpg', 90);
mc.setMediaCacheOwner('A');
await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
await mc.persistMedia('file:///tmp/b.jpg', 'm1', 'image');
const beforeA = FS.__files.has('file:///doc/chat_media/A/image/m1.jpg');
const beforeB = FS.__files.has('file:///doc/chat_media/B/image/m1.jpg');
const r = await mc.clearMediaCache();
const afterA = FS.__files.has('file:///doc/chat_media/A/image/m1.jpg');
const afterB = FS.__files.has('file:///doc/chat_media/B/image/m1.jpg');
const idxRaw = AS.__store.get('@media_file_index');
out({ beforeA, beforeB, r, afterA, afterB, idxRaw: idxRaw === undefined ? null : idxRaw });
`,
    'E21',
  );
  // 清理前两账号文件均存在
  assert.equal(res.beforeA, true);
  assert.equal(res.beforeB, true);
  // 清理成功
  assert.deepEqual(res.r, { ok: true, removedBytes: 0, removedFiles: 0 });
  // 全局清理：两账号文件均被删除（这是当前实现的真实行为，非按账号选择性清理）
  assert.equal(res.afterA, false);
  assert.equal(res.afterB, false);
  // 索引被移除
  assert.equal(res.idxRaw, null);
});

// ---------------------------------------------------------------------------
// 不变量 INV1–INV10（显式断言，与 E 系列互补）
// ---------------------------------------------------------------------------
test('R6-INV1 A 的缓存不可被 B 读取', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('A');
await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
const r = await mc.resolveLocalMedia('m1', 'image');
const m = mc.getMemoryLocalMedia('m1', 'image');
out({ r, m });
`,
    'INV1',
  );
  assert.deepEqual(res, { r: null, m: null });
});

test('R6-INV2 账号切换不复用旧用户私有索引', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('A');
await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
// B 写自己的 m1，不得覆盖 A 的物理文件
FS.__seed('file:///tmp/b.jpg', 90);
const rb = await mc.persistMedia('file:///tmp/b.jpg', 'm1', 'image');
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ rb, idx });
`,
    'INV2',
  );
  assert.equal(res.rb, 'file:///doc/chat_media/B/image/m1.jpg');
  // 索引键相同但 ownerId 已切换为 B（物理路径不同，A 文件仍在 A 分区）
  assert.equal(res.idx['image:m1'].ownerId, 'B');
});

test('R6-INV3 旧异步请求完成不写入新用户缓存', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('A');
const p = mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
const r = await p;
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r, idx });
`,
    'INV3',
  );
  assert.equal(res.r, null);
  assert.equal(res.idx['image:m1'], undefined);
});

test('R6-INV4 并发索引写入受提交锁保护（无丢失更新）', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
FS.__seed('file:///tmp/b.jpg', 90);
mc.setMediaCacheOwner('u1');
await Promise.all([
  mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image'),
  mc.persistMedia('file:///tmp/b.jpg', 'm2', 'image'),
]);
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ keys: Object.keys(idx).sort() });
`,
    'INV4',
  );
  assert.deepEqual(res.keys, ['image:m1', 'image:m2']);
});

test('R6-INV5 文件写失败不误判为成功', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('u1');
FS.__failNext.set(new Error('copy failed'));
const r = await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ r, idx });
`,
    'INV5',
  );
  // 失败时回退源 uri（身份有效），但不得写索引
  assert.equal(res.r, 'file:///tmp/a.jpg');
  assert.equal(res.idx['image:m1'], undefined);
});

test('R6-INV6 物理路径按 owner 分区：A/B 同 msgId 各自独立落盘、互不覆盖', () => {
  // 本项只验证「物理路径分区隔离」这一真实性质：
  // 同一 msgId 在不同 owner 下落到不同物理路径，且内容互不覆盖。
  // 注意：本项**不**验证清理隔离；clearMediaCache 为全局清理（见 E21）。
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
FS.__seed('file:///tmp/b.jpg', 90);
mc.setMediaCacheOwner('A');
const ra = await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
mc.setMediaCacheOwner('B');
const rb = await mc.persistMedia('file:///tmp/b.jpg', 'm1', 'image');
const aPath = 'file:///doc/chat_media/A/image/m1.jpg';
const bPath = 'file:///doc/chat_media/B/image/m1.jpg';
const aExists = FS.__files.has(aPath);
const bExists = FS.__files.has(bPath);
const aSize = FS.__files.get(aPath)?.size;
const bSize = FS.__files.get(bPath)?.size;
out({ ra, rb, aExists, bExists, aSize, bSize });
`,
    'INV6',
  );
  assert.equal(res.ra, 'file:///doc/chat_media/A/image/m1.jpg');
  assert.equal(res.rb, 'file:///doc/chat_media/B/image/m1.jpg');
  assert.equal(res.aExists, true);
  assert.equal(res.bExists, true);
  // 内容互不覆盖：A 保留 80，B 为 90
  assert.equal(res.aSize, 80);
  assert.equal(res.bSize, 90);
});

test('R6-INV7 非法 owner/userId 处理与旧实现一致', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
// 空字符串 owner 视为未登录（fail-closed）
mc.setMediaCacheOwner('');
const p1 = await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
// null msgId
mc.setMediaCacheOwner('u1');
const p2 = await mc.persistMedia('file:///tmp/a.jpg', null, 'image');
// 空 uri
const p3 = await mc.persistMedia('', 'm1', 'image');
// 非法 kind 归一化为 image
const p4 = await mc.persistMedia('file:///tmp/a.jpg', 'm2', 'bogus');
const idx = JSON.parse(AS.__store.get('@media_file_index') || '{}');
out({ p1, p2, p3, p4, keys: Object.keys(idx).sort() });
`,
    'INV7',
  );
  assert.equal(res.p1, null);
  assert.equal(res.p2, null);
  assert.equal(res.p3, null);
  assert.equal(res.p4, 'file:///doc/chat_media/u1/image/m2.jpg');
  assert.deepEqual(res.keys, ['image:m2']);
});

test('R6-INV8 索引持久化格式不变（kind:msgId -> {uri, ownerId}）', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('u1');
await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'audio');
const raw = AS.__store.get('@media_file_index');
const idx = JSON.parse(raw);
const key = Object.keys(idx)[0];
const val = idx[key];
out({ key, valKeys: Object.keys(val).sort(), uri: val.uri, ownerId: val.ownerId });
`,
    'INV8',
  );
  assert.equal(res.key, 'audio:m1');
  assert.deepEqual(res.valKeys, ['ownerId', 'uri']);
  assert.equal(res.ownerId, 'u1');
});

test('R6-INV9 文件系统/存储异常沿原路径处理', () => {
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('u1');
// getInfoAsync 在 ensureDir 中抛错 → 仍返回 dirPath（旧实现行为）
const origGetInfo = FS.getInfoAsync;
let callCount = 0;
// 通过 failNext 让 copyAsync 抛错，验证异常路径
FS.__failNext.set(new Error('io error'));
const r = await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
// AsyncStorage getItem 抛错 → initIndex 不抛
AS.__failNext.set(new Error('storage error'));
const r2 = await mc.resolveLocalMedia('m1', 'image');
out({ r, r2 });
`,
    'INV9',
  );
  assert.equal(res.r, 'file:///tmp/a.jpg');
  assert.equal(res.r2, null);
});

test('R6-INV10 日志敏感信息处理不变（仅记录错误对象）', () => {
  // 沙箱 REGISTER 仅重定向 console.log/info，console.warn 仍为原生实现，
  // 故直接捕获 console.warn。验证迁移前后日志调用形态一致：
  // 首个参数为固定文案，第二个为错误对象（不展开敏感字段）。
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('u1');
const logs = [];
const origWarn = console.warn;
console.warn = (...a) => { logs.push(a.map(x => (x && x.message) ? 'ERR:' + x.message : (typeof x === 'string' ? x : typeof x))); };
FS.__failNext.set(new Error('copy failed'));
await mc.persistMedia('file:///tmp/a.jpg', 'm1', 'image');
console.warn = origWarn;
out({ logs });
`,
    'INV10',
  );
  // 迁移前后日志参数形态一致（首个参数为固定文案，第二个为错误对象）
  assert.equal(res.logs.length, 1);
  assert.equal(res.logs[0][0], '持久化媒体异常:');
  assert.equal(res.logs[0][1], 'ERR:copy failed');
});

// ---------------------------------------------------------------------------
// 补充：normalizeKind 严格等价（Gatekeeper FIX-1 后，无任何有意差异）
// ---------------------------------------------------------------------------
test('R6-DOC normalizeKind 严格等价（无有意差异，原型键行为与旧实现一致）', () => {
  // Gatekeeper FIX-1 已恢复旧实现原始表达式 `KIND_DIRS[kind] ? kind : 'image'`，
  // 因此迁移前后对**全部**输入（含原型键）行为完全一致，不存在任何「有意差异」。
  // 本用例对真实 kind 值做端到端确认（原型键的完整覆盖见 E18）。
  const res = assertEquivalent(
    `
FS.__reset(); AS.__reset();
FS.__seed('file:///tmp/a.jpg', 80);
mc.setMediaCacheOwner('u1');
const realKinds = ['audio', 'image', 'video', 'thumb'];
const results = [];
for (const k of realKinds) {
  const r = await mc.persistMedia('file:///tmp/a.jpg', 'm-' + k, k);
  results.push(r);
}
out({ results });
`,
    'DOC',
  );
  // 注意：inferExt 从**源 uri** 推断扩展名（此处源为 a.jpg），
  // 因此四种 kind 的落盘扩展名均为 .jpg —— 这正是旧实现的真实行为。
  assert.deepEqual(res.results, [
    'file:///doc/chat_media/u1/audio/m-audio.jpg',
    'file:///doc/chat_media/u1/image/m-image.jpg',
    'file:///doc/chat_media/u1/video/m-video.jpg',
    'file:///doc/chat_media/u1/thumb/m-thumb.jpg',
  ]);
});
// --- END OF FILE tests/security/p12r6MigrationEquivalence.test.mjs ---