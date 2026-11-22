// --- START OF FILE tests/fixtures/p13r3/pureLogicProbe.mjs ---
/**
 * P1.3 R3 — `historyDataLogic.ts` 纯函数**真实执行**探针
 *
 * 与旧版（内联等价实现）不同：本探针**真实导入并执行** TypeScript 纯函数模块
 * `src/hooks/browser/historyDataLogic.ts`，断言其真实输出，而非复制内部实现。
 *
 * 实现方式：
 *   1. 在临时目录构建最小沙箱，复制真实源码依赖：
 *        · src/hooks/browser/historyDataLogic.ts
 *        · src/constants/browser/index.ts
 *        · src/types/browser.ts
 *   2. 写入 resolve-hook.mjs（处理无扩展名 / 目录导入 → .ts / /index.ts）。
 *   3. 在子进程中 `import('./src/hooks/browser/historyDataLogic.ts')`，
 *      调用 5 个纯函数，把真实返回值序列化为 JSON 输出。
 *   4. 父进程解析 JSON 返回给测试。
 *
 * 约束：
 *   · 不依赖 `.internal`。
 *   · 不硬编码预期结果冒充函数执行 —— 返回值全部来自真实模块调用。
 *   · 不访问网络 / 数据库 / 真实 AsyncStorage。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// tests/fixtures/p13r3 → repoRoot
const repoRoot = path.resolve(here, '../../..');

const RESOLVER_SRC =
  `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}try{return await n(s+'/index.js',c);}catch{}try{return await n(s+'/index.ts',c);}catch{}}return n(s,c);}`;

// 子进程脚本：真实导入纯函数模块并调用，输出真实结果 JSON。
const CASE_SRC = `
const m = await import('./src/hooks/browser/historyDataLogic.ts');
const {
  normalizeBookmark,
  normalizeBookmarkList,
  cleanHistoryList,
  buildHistoryEntry,
  mergeHistoryEntry,
} = m;

const out = {
  normalizeString: normalizeBookmark('https://x.example.com'),
  normalizeInsecure: normalizeBookmark('http://x.example.com'),
  normalizeNonObject: normalizeBookmark(42),
  normalizeTrim: normalizeBookmark({ url: 'https://y.example.com', title: '  T  ' }),
  normalizeListDedup: normalizeBookmarkList([
    { url: 'https://a.example.com', title: 'A' },
    { url: 'https://b.example.com', title: 'B' },
    { url: 'https://a.example.com', title: 'A2' },
  ]),
  normalizeListNonArray: normalizeBookmarkList('not-array'),
  cleanHistory: cleanHistoryList(
    [
      { id: '1', url: 'https://ok.example.com' },
      { id: '2', url: 'http://bad.example.com' },
      { id: '3', url: 'https://ok2.example.com' },
      null,
    ],
    100
  ),
  mergeSkip: mergeHistoryEntry(
    [{ id: '1', url: 'https://same.example.com', title: 'S', timestamp: 1 }],
    { id: '2', url: 'https://same.example.com', title: 'S2', timestamp: 2 },
    100
  ),
  mergeNext: mergeHistoryEntry(
    [{ id: '1', url: 'https://old.example.com', title: 'O', timestamp: 1 }],
    { id: '2', url: 'https://new.example.com', title: 'N', timestamp: 2 },
    100
  ).next,
  // 真实执行 buildHistoryEntry：验证 timestampProvider 在标题解析之后被调用
  buildEntry: (() => {
    const calls = [];
    const entry = buildHistoryEntry(
      'https://build.example.com',
      '  Build Title  ',
      'id-123',
      () => { calls.push('ts'); return 4242; }
    );
    return { entry, providerCalls: calls.length };
  })(),
};

process.stdout.write(JSON.stringify(out));
`;

/**
 * 在隔离沙箱中真实执行 `historyDataLogic.ts`，返回真实函数输出。
 * @returns {object} 纯函数真实返回值（JSON 反序列化）
 */
export function runPureLogicProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13r3-probe-'));
  try {
    const copy = (rel) => {
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, rel), dst);
    };
    copy('src/hooks/browser/historyDataLogic.ts');
    copy('src/constants/browser/index.ts');
    copy('src/types/browser.ts');

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'), RESOLVER_SRC);
    fs.writeFileSync(path.join(dir, 'case.mjs'), CASE_SRC);
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
    );

    const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    if (child.status !== 0) {
      throw new Error(`pureLogicProbe sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
    }
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// --- END OF FILE tests/fixtures/p13r3/pureLogicProbe.mjs ---
