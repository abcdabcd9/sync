// --- START OF FILE tests/security/p12r3MigrationEquivalence.test.mjs ---
/**
 * TASK-P1.2 R3 — 浏览器脚本层 JS → TS 迁移行为等价测试
 *
 * 目的：证明迁移后 `.ts` 模块的**公开导出、脚本字符串、组装结果**与迁移前
 *       `.js` 实现完全一致。基线不是「复刻逻辑」，而是从迁移前 JS 全文
 *       （`tests/fixtures/p12r3/before/`，版本可控，见其 MANIFEST.md）中
 *       **真实执行**得到的输出，逐字节比对。
 *
 * 沙箱策略（与既有安全测试一致）：
 *   · 复制真实源码到临时目录，用 resolve hook 支持无扩展名相对导入与 `.ts`；
 *   · 不 stub 被测逻辑，脚本模块本身无原生依赖，直接 import 真实实现；
 *   · 每个用例在独立沙箱中 import 真实实现。
 *
 * 覆盖 7 个目标：
 *   1. src/scripts/browser/adDomWatcher.ts
 *   2. src/scripts/browser/manualSniff.ts
 *   3. src/scripts/browser/removeAdStyle.ts
 *   4. src/scripts/browser/clickHijackGuard.ts
 *   5. src/scripts/browser/passiveSniffer.ts
 *   6. src/scripts/browser/desktopSpoof.ts
 *   7. src/scripts/browser/hiddenSnifferScripts.ts
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
// 来源与 SHA-256 见 tests/fixtures/p12r3/before/MANIFEST.md
const beforeDir = path.join(repoRoot, 'tests/fixtures/p12r3/before');

const readBefore = (name) => fs.readFileSync(path.join(beforeDir, name), 'utf8');

/**
 * 构建沙箱：复制被测源码 + 依赖，写入 resolve hook，执行 case.mjs。
 * @param {(dir: string) => void} setup 额外准备（复制源码 / 写 stub）
 * @param {string} caseCode 在沙箱中执行的 ESM 代码（可 await import）
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runSandbox(setup, caseCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12r3-'));
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

/**
 * 在沙箱中**真实执行迁移前 JS**（before/ 全文），返回其导出的脚本文本。
 * 这是最严格的等价证明：不靠字符串切片还原转义，而是让旧实现自己跑一遍。
 * before/ 文件头尾带有 `// --- START/END OF FILE ---` 注释，直接作为 ESM 执行即可。
 */
function runBeforeScript(beforeName, exportName) {
  const beforeSrc = readBefore(beforeName);
  const r = runSandbox(
    ({ dir }) => {
      const dst = path.join(dir, 'src/scripts/browser/legacy.js');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, beforeSrc);
    },
    `const mod = await import('./src/scripts/browser/legacy.js');
console.log(JSON.stringify({ s: mod.${exportName} }));`
  );
  return expectOk(r).s;
}

// ---------------------------------------------------------------------------
// 1-6. 单常量脚本 —— 逐字节等于迁移前 JS 真实执行结果
// ---------------------------------------------------------------------------
const SINGLE_CONST_CASES = [
  ['R3-EQ-01', 'adDomWatcher', 'scripts__browser__adDomWatcher.js', 'AD_DOM_WATCHER_SCRIPT'],
  ['R3-EQ-02', 'manualSniff', 'scripts__browser__manualSniff.js', 'MANUAL_SNIFF_SCRIPT'],
  ['R3-EQ-03', 'removeAdStyle', 'scripts__browser__removeAdStyle.js', 'REMOVE_AD_STYLE_SCRIPT'],
  ['R3-EQ-04', 'clickHijackGuard', 'scripts__browser__clickHijackGuard.js', 'CLICK_HIJACK_GUARD'],
  ['R3-EQ-05', 'passiveSniffer', 'scripts__browser__passiveSniffer.js', 'PASSIVE_SNIFFER_SCRIPT'],
  ['R3-EQ-06', 'desktopSpoof', 'scripts__browser__desktopSpoof.js', 'DESKTOP_SPOOF_SCRIPT'],
];

for (const [id, mod, beforeName, exportName] of SINGLE_CONST_CASES) {
  test(`${id} ${mod} 脚本逐字节等于迁移前 JS 真实执行结果`, () => {
    const r = runSandbox(
      ({ copy }) => copy(`src/scripts/browser/${mod}.ts`),
      `const mod = await import('./src/scripts/browser/${mod}.ts');
console.log(JSON.stringify({ s: mod.${exportName}, t: typeof mod.${exportName} }));`
    );
    const out = expectOk(r);
    assert.equal(out.t, 'string', `${exportName} 应为 string`);
    const expected = runBeforeScript(beforeName, exportName);
    assert.equal(out.s, expected, `${mod} 脚本与迁移前不一致`);
  });
}

// ---------------------------------------------------------------------------
// 7. hiddenSnifferScripts —— 导出集合 + 全部脚本字符串 + 组装函数
// ---------------------------------------------------------------------------
const HIDDEN_SCRIPT_EXPORTS = [
  'MEDIA_PLAYLIST_REGEX',
  'STEALTH_SCRIPT',
  'PURE_SNIFFER_SCRIPT',
  'CLOSE_POPUP_SCRIPT',
  'AUTO_PLAY_SCRIPT',
  'MANUAL_SNIFF_SCRIPT',
  'EPISODE_LIST_SCRIPT',
  'DIAGNOSE_SCRIPT',
  'buildHiddenSnifferBeforeLoadScript',
  'buildHiddenSnifferAfterLoadScript',
];

test('R3-EQ-07 hiddenSnifferScripts 导出集合与迁移前一致', () => {
  const r = runSandbox(
    ({ copy }) => copy('src/scripts/browser/hiddenSnifferScripts.ts'),
    `const mod = await import('./src/scripts/browser/hiddenSnifferScripts.ts');
console.log(JSON.stringify({ keys: Object.keys(mod).sort() }));`
  );
  const out = expectOk(r);
  assert.deepEqual(out.keys, [...HIDDEN_SCRIPT_EXPORTS].sort());

  const before = readBefore('scripts__browser__hiddenSnifferScripts.js');
  for (const name of HIDDEN_SCRIPT_EXPORTS) {
    assert.ok(before.includes(name), `迁移前应导出 ${name}`);
  }
});

test('R3-EQ-08 hiddenSnifferScripts 全部脚本字符串逐字节等于迁移前 JS 真实执行结果', () => {
  const stringExports = HIDDEN_SCRIPT_EXPORTS.filter(
    (n) => n !== 'MEDIA_PLAYLIST_REGEX' && !n.startsWith('build')
  );
  const r = runSandbox(
    ({ copy }) => copy('src/scripts/browser/hiddenSnifferScripts.ts'),
    `const mod = await import('./src/scripts/browser/hiddenSnifferScripts.ts');
console.log(JSON.stringify({ ${stringExports.map((n) => `${n}: mod.${n}`).join(', ')} }));`
  );
  const out = expectOk(r);

  const beforeSrc = readBefore('scripts__browser__hiddenSnifferScripts.js');
  const beforeRun = runSandbox(
    ({ dir }) => {
      const dst = path.join(dir, 'src/scripts/browser/legacy.js');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, beforeSrc);
    },
    `const mod = await import('./src/scripts/browser/legacy.js');
console.log(JSON.stringify({ ${stringExports.map((n) => `${n}: mod.${n}`).join(', ')} }));`
  );
  const expected = expectOk(beforeRun);

  for (const name of stringExports) {
    assert.equal(typeof out[name], 'string', `${name} 应为 string`);
    assert.equal(out[name], expected[name], `${name} 与迁移前不一致`);
  }
});

test('R3-EQ-09 hiddenSnifferScripts MEDIA_PLAYLIST_REGEX 行为等价', () => {
  const r = runSandbox(
    ({ copy }) => copy('src/scripts/browser/hiddenSnifferScripts.ts'),
    `const { MEDIA_PLAYLIST_REGEX } = await import('./src/scripts/browser/hiddenSnifferScripts.ts');
const samples = ['https://a.com/x.m3u8', 'https://a.com/x.mp4?t=1', 'https://a.com/x.ts', 'https://a.com/x.webm', 'https://a.com/x.mkv', 'https://a.com/x.mov', 'https://a.com/x.mpd', 'https://a.com/x.flv', 'https://a.com/x.jpg', 'https://a.com/x.m3u8?token=abc'];
console.log(JSON.stringify({ src: MEDIA_PLAYLIST_REGEX.source, flags: MEDIA_PLAYLIST_REGEX.flags, hits: samples.map(s => MEDIA_PLAYLIST_REGEX.test(s)) }));`
  );
  const out = expectOk(r);
  assert.equal(out.src, '\\.(m3u8|mp4|flv|mkv|mov|mpd|webm)(\\?.*)?$');
  assert.equal(out.flags, 'i');
  // 播放列表级命中；.ts 分片与 .jpg 不命中
  assert.deepEqual(out.hits, [true, true, false, true, true, true, true, true, false, true]);
});

test('R3-EQ-10 hiddenSnifferScripts 组装函数逐字节等于迁移前 JS 真实执行结果', () => {
  const r = runSandbox(
    ({ copy }) => copy('src/scripts/browser/hiddenSnifferScripts.ts'),
    `const mod = await import('./src/scripts/browser/hiddenSnifferScripts.ts');
console.log(JSON.stringify({ before: mod.buildHiddenSnifferBeforeLoadScript(), after: mod.buildHiddenSnifferAfterLoadScript() }));`
  );
  const out = expectOk(r);

  const beforeSrc = readBefore('scripts__browser__hiddenSnifferScripts.js');
  const beforeRun = runSandbox(
    ({ dir }) => {
      const dst = path.join(dir, 'src/scripts/browser/legacy.js');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, beforeSrc);
    },
    `const mod = await import('./src/scripts/browser/legacy.js');
console.log(JSON.stringify({ before: mod.buildHiddenSnifferBeforeLoadScript(), after: mod.buildHiddenSnifferAfterLoadScript() }));`
  );
  const expected = expectOk(beforeRun);

  assert.equal(out.before, expected.before, 'beforeLoad 组装结果不一致');
  assert.equal(out.after, expected.after, 'afterLoad 组装结果不一致');
  // 组装顺序：before = STEALTH + PURE_SNIFFER；after = CLOSE_POPUP + AUTO_PLAY
  assert.ok(out.before.startsWith('\n  (function() {'));
  assert.ok(out.before.includes('__stealthInstalled'));
  assert.ok(out.before.includes('__pure_sniffer_installed'));
  assert.ok(out.after.includes('__closePopupInstalled'));
  assert.ok(out.after.includes('__autoPlayStarted'));
});

// ---------------------------------------------------------------------------
// 11. 组装入口 index.ts 正确解析迁移后的模块（无扩展名相对导入）
// ---------------------------------------------------------------------------
test('R3-EQ-11 scripts/browser/index 组装入口正确解析迁移后模块', () => {
  const r = runSandbox(
    ({ copy }) => {
      for (const f of [
        'index',
        'adGuard',
        'adCleanup',
        'adDomWatcher',
        'clickHijackGuard',
        'passiveSniffer',
        'desktopSpoof',
        'manualSniff',
        'removeAdStyle',
      ]) {
        copy(`src/scripts/browser/${f}.ts`);
      }
      copy('src/constants/browser/index.ts');
      copy('src/types/browser.ts');
    },
    `const idx = await import('./src/scripts/browser/index.ts');
const mobile = idx.buildBeforeLoadScript();
const desktop = idx.buildBeforeLoadScript({ isDesktopMode: true });
console.log(JSON.stringify({
  keys: Object.keys(idx).sort(),
  mobileHasSpoof: mobile.includes('MacIntel'),
  desktopHasSpoof: desktop.includes('MacIntel'),
  mobileLen: mobile.length,
  desktopLen: desktop.length,
  watcher: typeof idx.AD_DOM_WATCHER_SCRIPT,
  manual: typeof idx.MANUAL_SNIFF_SCRIPT,
  removeStyle: typeof idx.REMOVE_AD_STYLE_SCRIPT,
}));`
  );
  const out = expectOk(r);
  assert.deepEqual(out.keys, [
    'AD_DOM_WATCHER_SCRIPT',
    'MANUAL_SNIFF_SCRIPT',
    'REMOVE_AD_STYLE_SCRIPT',
    'buildAdCleanupScript',
    'buildBeforeLoadScript',
  ]);
  // 移动模式不含桌面伪装；桌面模式含
  assert.equal(out.mobileHasSpoof, false);
  assert.equal(out.desktopHasSpoof, true);
  assert.ok(out.desktopLen > out.mobileLen);
  // 再导出脚本均为 string
  assert.equal(out.watcher, 'string');
  assert.equal(out.manual, 'string');
  assert.equal(out.removeStyle, 'string');
});

// ---------------------------------------------------------------------------
// 12. 再导出脚本与源模块逐字节一致（无二次加工）
// ---------------------------------------------------------------------------
test('R3-EQ-12 再导出脚本与源模块逐字节一致（无二次加工）', () => {
  const r = runSandbox(
    ({ copy }) => {
      for (const f of [
        'index',
        'adGuard',
        'adCleanup',
        'adDomWatcher',
        'clickHijackGuard',
        'passiveSniffer',
        'desktopSpoof',
        'manualSniff',
        'removeAdStyle',
      ]) {
        copy(`src/scripts/browser/${f}.ts`);
      }
      copy('src/constants/browser/index.ts');
      copy('src/types/browser.ts');
    },
    `const idx = await import('./src/scripts/browser/index.ts');
const watcher = await import('./src/scripts/browser/adDomWatcher.ts');
const manual = await import('./src/scripts/browser/manualSniff.ts');
const removeStyle = await import('./src/scripts/browser/removeAdStyle.ts');
console.log(JSON.stringify({
  w: idx.AD_DOM_WATCHER_SCRIPT === watcher.AD_DOM_WATCHER_SCRIPT,
  m: idx.MANUAL_SNIFF_SCRIPT === manual.MANUAL_SNIFF_SCRIPT,
  r: idx.REMOVE_AD_STYLE_SCRIPT === removeStyle.REMOVE_AD_STYLE_SCRIPT,
}));`
  );
  const out = expectOk(r);
  assert.equal(out.w, true);
  assert.equal(out.m, true);
  assert.equal(out.r, true);
});
// --- END OF FILE tests/security/p12r3MigrationEquivalence.test.mjs ---
