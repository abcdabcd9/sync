// --- START OF FILE tests/security/p12r2MigrationEquivalence.test.mjs ---
/**
 * TASK-P1.2 R2 — 第三批 JS → TS 迁移行为等价测试
 *
 * 目的：证明迁移后 `.ts` 模块的**公开导出、运行时值、异常行为**与迁移前
 *       `.js` 实现完全一致。基线值不是「复刻逻辑」，而是从迁移前 JS 全文
 *       （`tests/fixtures/p12r2/before/`，版本可控，见其 MANIFEST.md）中
 *       提取的真实字面量，逐字节比对。
 *
 * 沙箱策略（与既有安全测试一致）：
 *   · 复制真实源码到临时目录，用 resolve hook 支持无扩展名相对导入与 `.ts`；
 *   · 仅 stub 原生依赖（expo-haptics / react-native），不 stub 被测逻辑；
 *   · 每个用例在独立沙箱中 import 真实实现。
 *
 * 覆盖 7 个目标：
 *   1. src/constants/haptics.ts
 *   2. src/hooks/health/constants.ts
 *   3. src/hooks/health/dateUtils.ts
 *   4. src/hooks/health/authRevokeLogic.ts
 *   5. src/scripts/browser/index.ts
 *   6. src/scripts/browser/adGuard.ts
 *   7. src/scripts/browser/adCleanup.ts
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
// 迁移前基线夹具：版本可控，不依赖被 .gitignore 排除的 .internal/
// 来源与 SHA-256 见 tests/fixtures/p12r2/before/MANIFEST.md
const beforeDir = path.join(repoRoot, 'tests/fixtures/p12r2/before');

const readBefore = (name) => fs.readFileSync(path.join(beforeDir, name), 'utf8');

/**
 * 构建沙箱：复制被测源码 + 依赖，写入 resolve hook 与 stub，执行 case.mjs。
 * @param {(dir: string) => void} setup 额外准备（复制源码 / 写 stub）
 * @param {string} caseCode 在沙箱中执行的 ESM 代码（可 await import）
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runSandbox(setup, caseCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12r2-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };

  // resolve hook：无扩展名相对导入依次尝试 .js / .ts / /index.js / /index.ts
  fs.writeFileSync(
    path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}}return n(s,c);}`
  );
  fs.writeFileSync(
    path.join(dir, 'register.mjs'),
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
  );

  setup({ dir, copy });

  fs.writeFileSync(path.join(dir, 'case.mjs'), caseCode);
  const r = spawnSync(
    process.execPath,
    ['--import', path.join(dir, 'register.mjs')],
    { cwd: dir, encoding: 'utf8' }
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 在沙箱 node_modules 中写一个最小 ESM stub 包 */
function writeStub(dir, name, files) {
  const pkgDir = path.join(dir, 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' })
  );
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(pkgDir, file), content);
  }
}

/**
 * 断言沙箱执行成功，并返回解析后的 JSON 结果。
 * 注意：register.mjs 会把 case 内的 console.log 重定向到 stderr（避免污染
 * 模块加载日志），因此结果行需从 stderr 读取。
 */
function expectOk(r) {
  assert.equal(r.status, 0, `沙箱执行失败:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  const line = r.stderr.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `沙箱未输出结果行:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// 1. haptics.ts —— 公开导出完整性 + 调用安全性
// ---------------------------------------------------------------------------
test('R2-EQ-01 haptics 导出方法与迁移前完全一致（7 个方法）', () => {
  const r = runSandbox(
    ({ dir, copy }) => {
      copy('src/constants/haptics.ts');
      writeStub(dir, 'react-native', {
        'index.js': `export const Platform = { OS: 'android' };`,
      });
      writeStub(dir, 'expo-haptics', {
        'index.js': `export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export const impactAsync = () => Promise.resolve();
export const notificationAsync = () => Promise.resolve();
export const selectionAsync = () => Promise.resolve();`,
      });
    },
    `const { haptic } = await import('./src/constants/haptics.ts');
console.log(JSON.stringify({ keys: Object.keys(haptic).sort(), types: Object.keys(haptic).map(k => typeof haptic[k]) }));`
  );
  const out = expectOk(r);
  const expected = ['light', 'medium', 'heavy', 'success', 'warning', 'error', 'selection'];
  assert.deepEqual(out.keys, [...expected].sort());
  assert.ok(out.types.every((t) => t === 'function'));

  const before = readBefore('constants__haptics.js');
  for (const k of expected) {
    assert.ok(before.includes(`${k}: () =>`), `迁移前源码应包含 ${k}`);
  }
});

test('R2-EQ-02 haptics 调用不抛错（非 iOS 环境为 no-op）', () => {
  const r = runSandbox(
    ({ dir, copy }) => {
      copy('src/constants/haptics.ts');
      writeStub(dir, 'react-native', {
        'index.js': `export const Platform = { OS: 'android' };`,
      });
      writeStub(dir, 'expo-haptics', {
        'index.js': `export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' };
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' };
export const impactAsync = () => { throw new Error('should not be called on android'); };
export const notificationAsync = () => { throw new Error('should not be called on android'); };
export const selectionAsync = () => { throw new Error('should not be called on android'); };`,
      });
    },
    `const { haptic } = await import('./src/constants/haptics.ts');
const errors = [];
for (const k of Object.keys(haptic)) { try { haptic[k](); } catch (e) { errors.push(k + ':' + e.message); } }
console.log(JSON.stringify({ errors }));`
  );
  const out = expectOk(r);
  assert.deepEqual(out.errors, [], 'Android 下所有方法应为 no-op，不调用原生 API');
});

// ---------------------------------------------------------------------------
// 2. health/constants.ts —— DEFAULT_MEALS 逐字节等价
// ---------------------------------------------------------------------------
test('R2-EQ-03 DEFAULT_MEALS 键集合与迁移前一致', async () => {
  const { DEFAULT_MEALS } = await import('../../src/hooks/health/constants.ts');
  assert.deepEqual(Object.keys(DEFAULT_MEALS), ['早餐', '午餐', '晚餐']);
});

test('R2-EQ-04 DEFAULT_MEALS 文案逐字节等于迁移前 JS 字面量', async () => {
  const { DEFAULT_MEALS } = await import('../../src/hooks/health/constants.ts');
  const before = readBefore('hooks__health__constants.js');
  for (const key of ['早餐', '午餐', '晚餐']) {
    const re = new RegExp(`'${key}':\\s*'((?:[^'\\\\]|\\\\.)*)'`);
    const m = before.match(re);
    assert.ok(m, `迁移前源码应包含 ${key} 字面量`);
    const literal = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    assert.equal(DEFAULT_MEALS[key], literal, `${key} 文案必须逐字节一致`);
    assert.ok(DEFAULT_MEALS[key].length > 0);
  }
});

// ---------------------------------------------------------------------------
// 3. health/dateUtils.ts —— 纯函数等价
// ---------------------------------------------------------------------------
test('R2-EQ-05 formatDateStr 单位数月/日补零', async () => {
  const { formatDateStr } = await import('../../src/hooks/health/dateUtils.ts');
  assert.equal(formatDateStr(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(formatDateStr(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(formatDateStr(new Date(2024, 1, 29)), '2024-02-29');
});

test('R2-EQ-06 calculateDiffDays 边界值', async () => {
  const { calculateDiffDays } = await import('../../src/hooks/health/dateUtils.ts');
  assert.equal(calculateDiffDays('2026-01-01', '2026-01-01'), 0);
  assert.equal(calculateDiffDays('2026-01-01', '2026-01-02'), 1);
  assert.equal(calculateDiffDays('2026-01-02', '2026-01-01'), 1, '反向参数取绝对值');
  assert.equal(calculateDiffDays('2025-12-31', '2026-01-01'), 1, '跨年');
  assert.equal(calculateDiffDays('2024-02-28', '2024-03-01'), 2, '跨闰日');
  assert.equal(calculateDiffDays('2026-01-01', '2027-01-01'), 365);
});

test('R2-EQ-07 calculateDiffDays 非法输入返回 NaN（与迁移前一致）', async () => {
  const { calculateDiffDays } = await import('../../src/hooks/health/dateUtils.ts');
  assert.ok(Number.isNaN(calculateDiffDays('not-a-date', '2026-01-01')));
});

test('R2-EQ-08 dateUtils 导出集合与迁移前一致', async () => {
  const mod = await import('../../src/hooks/health/dateUtils.ts');
  assert.deepEqual(Object.keys(mod).sort(), ['calculateDiffDays', 'formatDateStr']);
  const before = readBefore('hooks__health__dateUtils.js');
  assert.ok(before.includes('export const formatDateStr'));
  assert.ok(before.includes('export const calculateDiffDays'));
});

// ---------------------------------------------------------------------------
// 4. health/authRevokeLogic.ts —— FIX-05 决策语义等价
// ---------------------------------------------------------------------------
const P_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

test('R2-EQ-09 isAuthEventRelevant 边界用例', async () => {
  const { isAuthEventRelevant } = await import('../../src/hooks/health/authRevokeLogic.ts');
  assert.equal(isAuthEventRelevant({ new: { requester_id: P_ID } }, ''), false);
  assert.equal(isAuthEventRelevant({ new: { requester_id: P_ID } }, null), false);
  assert.equal(isAuthEventRelevant(null, P_ID), true);
  assert.equal(isAuthEventRelevant(undefined, P_ID), true);
  assert.equal(isAuthEventRelevant({ new: { requester_id: P_ID } }, P_ID), true);
  assert.equal(isAuthEventRelevant({ new: { addressee_id: P_ID } }, P_ID), true);
  assert.equal(
    isAuthEventRelevant({ new: { requester_id: 'x', addressee_id: 'y' } }, P_ID),
    false
  );
  assert.equal(isAuthEventRelevant({ new: { id: 'auth-1' } }, P_ID), true);
  assert.equal(isAuthEventRelevant({ old: { id: 'auth-1' }, new: {} }, P_ID), true);
});

test('R2-EQ-10 shouldRevokeOnAuthChange 边界用例', async () => {
  const { shouldRevokeOnAuthChange } = await import('../../src/hooks/health/authRevokeLogic.ts');
  assert.equal(shouldRevokeOnAuthChange(null, P_ID), false);
  assert.equal(shouldRevokeOnAuthChange(undefined, P_ID), false);
  assert.equal(shouldRevokeOnAuthChange({ error: { message: 'net' } }, P_ID), false);
  assert.equal(shouldRevokeOnAuthChange({ data: null, error: null }, P_ID), true);
  assert.equal(shouldRevokeOnAuthChange({ data: P_ID, error: null }, P_ID), false);
  assert.equal(shouldRevokeOnAuthChange({ data: 'other', error: null }, P_ID), true);
});

test('R2-EQ-11 createRevokeVerifier 单次触发 + 并发合并 + isStale 丢弃', async () => {
  const { createRevokeVerifier } = await import('../../src/hooks/health/authRevokeLogic.ts');

  let calls = 0;
  const results = [];
  const v1 = createRevokeVerifier({
    verify: async () => {
      calls += 1;
      return { data: P_ID, error: null };
    },
    onResult: (r) => results.push(r),
  });
  assert.equal(v1.isVerifying(), false);
  await v1.trigger();
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(v1.isVerifying(), false);

  let calls2 = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const results2 = [];
  const v2 = createRevokeVerifier({
    verify: async () => {
      calls2 += 1;
      if (calls2 === 1) await gate;
      return { data: null, error: null };
    },
    onResult: (r) => results2.push(r),
  });
  const p = v2.trigger();
  await v2.trigger();
  await v2.trigger();
  release();
  await p;
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(calls2, 2, '连续事件应合并为 2 次复验（首次 + 一次补充）');
  assert.equal(results2.length, 2);

  let staleCalls = 0;
  const v3 = createRevokeVerifier({
    verify: async () => {
      staleCalls += 1;
      return { data: null, error: null };
    },
    onResult: () => {},
    isStale: () => true,
  });
  await v3.trigger();
  assert.equal(staleCalls, 0);
});

test('R2-EQ-12 authRevokeLogic 导出集合与迁移前一致', async () => {
  const mod = await import('../../src/hooks/health/authRevokeLogic.ts');
  assert.deepEqual(Object.keys(mod).sort(), [
    'createRevokeVerifier',
    'isAuthEventRelevant',
    'shouldRevokeOnAuthChange',
  ]);
  const before = readBefore('hooks__health__authRevokeLogic.js');
  for (const name of ['isAuthEventRelevant', 'shouldRevokeOnAuthChange', 'createRevokeVerifier']) {
    assert.ok(before.includes(`export function ${name}`), `迁移前应导出 ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 5-7. scripts/browser —— 模板字符串逐字节等价（沙箱内，因无扩展名相对导入）
// ---------------------------------------------------------------------------
// R2 迁移 index / adGuard / adCleanup；R3 迁移其余 6 个脚本为 .ts。
// 至此 scripts/browser 下全部为 .ts，沙箱复制按真实扩展名。
const BROWSER_FILES = [
  'src/scripts/browser/index.ts',
  'src/scripts/browser/adGuard.ts',
  'src/scripts/browser/adCleanup.ts',
  'src/scripts/browser/adDomWatcher.ts',
  'src/scripts/browser/clickHijackGuard.ts',
  'src/scripts/browser/passiveSniffer.ts',
  'src/scripts/browser/desktopSpoof.ts',
  'src/scripts/browser/manualSniff.ts',
  'src/scripts/browser/removeAdStyle.ts',
  'src/constants/browser/index.ts',
  'src/types/browser.ts',
];

const copyBrowser = ({ copy }) => {
  for (const rel of BROWSER_FILES) copy(rel);
};

/**
 * 在沙箱中**真实执行迁移前 JS**（before/ 全文），返回其构建的脚本文本。
 * 这是最严格的等价证明：不靠字符串切片还原转义，而是让旧实现自己跑一遍。
 * before/ 文件头尾带有 `// --- START/END OF FILE ---` 注释，直接作为 ESM 执行即可。
 */
function runBeforeScript(beforeName, exportName) {
  const beforeSrc = readBefore(beforeName);
  const r = runSandbox(
    ({ dir, copy }) => {
      // 旧实现依赖 constants/browser 的 AD_DOMAIN_REGEX，按真实路径复制
      copy('src/constants/browser/index.ts');
      copy('src/types/browser.ts');
      const dst = path.join(dir, 'src/scripts/browser/legacy.js');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, beforeSrc);
    },
    `const mod = await import('./src/scripts/browser/legacy.js');
console.log(JSON.stringify({ s: mod.${exportName}() }));`
  );
  return expectOk(r).s;
}

test('R2-EQ-13 adGuard 脚本逐字节等于迁移前 JS 真实执行结果', () => {
  const r = runSandbox(copyBrowser, `const { buildAdGuardScript } = await import('./src/scripts/browser/adGuard.ts');
console.log(JSON.stringify({ s: buildAdGuardScript() }));`);
  const out = expectOk(r);
  const expected = runBeforeScript('scripts__browser__adGuard.js', 'buildAdGuardScript');
  assert.equal(out.s, expected);
});

test('R2-EQ-14 adCleanup 脚本逐字节等于迁移前 JS 真实执行结果', () => {
  const r = runSandbox(copyBrowser, `const { buildAdCleanupScript } = await import('./src/scripts/browser/adCleanup.ts');
console.log(JSON.stringify({ s: buildAdCleanupScript() }));`);
  const out = expectOk(r);
  const expected = runBeforeScript('scripts__browser__adCleanup.js', 'buildAdCleanupScript');
  assert.equal(out.s, expected);
});

test('R2-EQ-15 buildBeforeLoadScript 两种 isDesktopMode 取值逐字节等价', () => {
  const r = runSandbox(copyBrowser, `const { buildBeforeLoadScript } = await import('./src/scripts/browser/index.ts');
console.log(JSON.stringify({ def: buildBeforeLoadScript(), empty: buildBeforeLoadScript({}), f: buildBeforeLoadScript({ isDesktopMode: false }), t: buildBeforeLoadScript({ isDesktopMode: true }) }));`);
  const out = expectOk(r);
  assert.equal(out.def, out.empty);
  assert.equal(out.def, out.f);
  assert.notEqual(out.def, out.t);
  // 桌面模式应包含 DESKTOP_SPOOF_SCRIPT，移动模式不含
  assert.ok(out.t.length > out.def.length);
  assert.ok(out.def.endsWith('    true;\n  '));
  assert.ok(out.t.endsWith('    true;\n  '));
});

test('R2-EQ-16 scripts/browser/index 导出集合与迁移前一致', () => {
  const r = runSandbox(copyBrowser, `const mod = await import('./src/scripts/browser/index.ts');
console.log(JSON.stringify({ keys: Object.keys(mod).sort() }));`);
  const out = expectOk(r);
  assert.deepEqual(out.keys, [
    'AD_DOM_WATCHER_SCRIPT',
    'MANUAL_SNIFF_SCRIPT',
    'REMOVE_AD_STYLE_SCRIPT',
    'buildAdCleanupScript',
    'buildBeforeLoadScript',
  ]);
  const before = readBefore('scripts__browser__index.js');
  for (const name of [
    'AD_DOM_WATCHER_SCRIPT',
    'buildAdCleanupScript',
    'MANUAL_SNIFF_SCRIPT',
    'REMOVE_AD_STYLE_SCRIPT',
    'buildBeforeLoadScript',
  ]) {
    assert.ok(before.includes(name), `迁移前应导出 ${name}`);
  }
});

test('R2-EQ-17 再导出脚本与源模块逐字节一致（无二次加工）', () => {
  const r = runSandbox(copyBrowser, `const idx = await import('./src/scripts/browser/index.ts');
const watcher = await import('./src/scripts/browser/adDomWatcher.ts');
const manual = await import('./src/scripts/browser/manualSniff.ts');
const removeStyle = await import('./src/scripts/browser/removeAdStyle.ts');
const cleanup = await import('./src/scripts/browser/adCleanup.ts');
console.log(JSON.stringify({
  w: idx.AD_DOM_WATCHER_SCRIPT === watcher.AD_DOM_WATCHER_SCRIPT,
  m: idx.MANUAL_SNIFF_SCRIPT === manual.MANUAL_SNIFF_SCRIPT,
  r: idx.REMOVE_AD_STYLE_SCRIPT === removeStyle.REMOVE_AD_STYLE_SCRIPT,
  c: idx.buildAdCleanupScript === cleanup.buildAdCleanupScript,
}));`);
  const out = expectOk(r);
  assert.equal(out.w, true);
  assert.equal(out.m, true);
  assert.equal(out.r, true);
  assert.equal(out.c, true);
});
// --- END OF FILE tests/security/p12r2MigrationEquivalence.test.mjs ---
