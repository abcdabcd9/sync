// --- START OF FILE tests/security/p04_b1HealthKeysFull.test.mjs ---
// ============================================================================
// TASK-P0.4 / B1 — 健康 8 个 V2 存储 key 全量枚举回归测试
//
// 目的：P0.3 的 b1Isolation.test.mjs 只抽查了 water/meals/streak 等 5 个 key，
//       未对「8 个 key 全部存在且命名精确」做穷举断言。本测试补齐：
//         P04-B1-01 buildHealthKeys 必须返回恰好 8 个字段，命名精确匹配契约；
//         P04-B1-02 8 个 key 全部按 userId 隔离（A/B 互不覆盖）；
//         P04-B1-03 无 userId / 非字符串 → 返回 null（fail-closed，不读写磁盘）；
//         P04-B1-04 旧全局 key 不被 buildHealthKeys 产出（命名空间隔离）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub 模块 + 临时目录运行「真实源码」useHealthStorage.js。
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

// 8 个字段的精确后缀契约（与 useHealthStorage.js FIELD_SUFFIX 一致）
const EXPECTED_FIELDS = ['water', 'meals', 'maxWater', 'motto', 'guides', 'streak', 'checkIn', 'active'];
const PREFIX = '@sync_health_v2_';

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-b1keys-'));
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

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/hooks/health/useHealthStorage.js');
  copy('src/hooks/health/constants.js');
  copy('src/hooks/health/dateUtils.js');

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
// P04-B1-01：buildHealthKeys 必须返回恰好 8 个字段，命名精确
// ---------------------------------------------------------------------------
test('P04-B1-01 buildHealthKeys 返回恰好 8 个字段且命名精确', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const uid = 'user-xyz';
const keys = buildHealthKeys(uid);
process.stdout.write(JSON.stringify({
  keys,
  fieldCount: keys ? Object.keys(keys).length : -1,
  fields: keys ? Object.keys(keys).sort() : [],
}));
`);
    assert.equal(out.fieldCount, 8, 'buildHealthKeys 必须返回恰好 8 个字段');
    assert.deepEqual(out.fields, [...EXPECTED_FIELDS].sort(), '字段集合必须与契约完全一致');
    for (const f of EXPECTED_FIELDS) {
      assert.equal(out.keys[f], `${PREFIX}user-xyz_${f}`, `字段 ${f} 的 key 命名必须精确匹配契约`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-B1-02：8 个 key 全部按 userId 隔离（A/B 互不覆盖）
// ---------------------------------------------------------------------------
test('P04-B1-02 8 个 key 全部按账号隔离，A/B 互不覆盖', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const AS = (await import('@react-native-async-storage/async-storage')).default;
const A = 'user-aaa', B = 'user-bbb';
const kA = buildHealthKeys(A), kB = buildHealthKeys(B);
const fields = ${JSON.stringify(EXPECTED_FIELDS)};
// 每个字段写入不同值
for (const f of fields) { await AS.setItem(kA[f], 'A:' + f); }
for (const f of fields) { await AS.setItem(kB[f], 'B:' + f); }
const readA = {}, readB = {};
for (const f of fields) { readA[f] = await AS.getItem(kA[f]); readB[f] = await AS.getItem(kB[f]); }
// 交叉校验：A 的 key 与 B 的 key 必须完全不同
const overlap = fields.filter((f) => kA[f] === kB[f]);
process.stdout.write(JSON.stringify({ readA, readB, overlap, totalKeys: (await AS.getAllKeys()).length }));
`);
    for (const f of EXPECTED_FIELDS) {
      assert.equal(out.readA[f], `A:${f}`, `A 的 ${f} 必须为自己写入的值`);
      assert.equal(out.readB[f], `B:${f}`, `B 的 ${f} 必须为自己写入的值`);
    }
    assert.deepEqual(out.overlap, [], 'A/B 的 8 个 key 不得有任何重叠');
    assert.equal(out.totalKeys, 16, '应恰好存在 16 个 key（A:8 + B:8）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-B1-03：无 userId / 非字符串 → null（fail-closed）
// ---------------------------------------------------------------------------
test('P04-B1-03 无有效 userId 时 buildHealthKeys 返回 null（fail-closed）', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
process.stdout.write(JSON.stringify({
  nullArg: buildHealthKeys(null),
  undefinedArg: buildHealthKeys(undefined),
  emptyStr: buildHealthKeys(''),
  numberArg: buildHealthKeys(123),
  objectArg: buildHealthKeys({}),
}));
`);
    assert.equal(out.nullArg, null, 'null → null');
    assert.equal(out.undefinedArg, null, 'undefined → null');
    assert.equal(out.emptyStr, null, '空串 → null');
    assert.equal(out.numberArg, null, '数字 → null（非字符串）');
    assert.equal(out.objectArg, null, '对象 → null（非字符串）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-B1-04：旧全局 key 不被 buildHealthKeys 产出（命名空间隔离）
// ---------------------------------------------------------------------------
test('P04-B1-04 buildHealthKeys 不产出任何旧全局 key', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildHealthKeys } = await import('./src/hooks/health/useHealthStorage.js');
const keys = buildHealthKeys('user-xyz');
const values = Object.values(keys);
const LEGACY = ['@waterAmount','@mealsStatus','@maxWater','@motto','@mealGuides','@streakDays','@lastCheckInDate','@lastActiveDate'];
process.stdout.write(JSON.stringify({
  allPrefixed: values.every((v) => v.startsWith('${PREFIX}')),
  legacyHits: values.filter((v) => LEGACY.includes(v)),
}));
`);
    assert.equal(out.allPrefixed, true, '所有 key 必须以 V2 前缀开头');
    assert.deepEqual(out.legacyHits, [], '不得产出任何旧全局 key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_b1HealthKeysFull.test.mjs ---
