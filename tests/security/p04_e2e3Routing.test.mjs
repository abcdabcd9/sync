// --- START OF FILE tests/security/p04_e2e3Routing.test.mjs ---
// ============================================================================
// TASK-P0.4 / E2 + E3 — 路由占位闪现 + 白名单穷举回归测试
//
// 目的：P0.3 的 ios02WhiteScreen 覆盖了「未登录不再白屏死锁」的主路径，但未对
//       以下两点做穷举断言：
//         E2 占位闪现（computeAuthRedirect 全分支）：
//            · 已登录但健康数据未就绪（isInitialized=false）→ 返回 null
//              （不跳转、不闪现私人页 / 不展示他人数据）；
//            · 未登录（!user）→ 无论 isInitialized 真假，非公开页一律 '/auth'
//              （修复白屏死锁的核心：鉴权决策不受数据加载阻塞）；
//            · 会话确认中 / 安全存储故障 → null（不误跳）。
//         E3 白名单穷举：
//            · 浏览器 isSafeUrl 仅放行 https:// 与 about:，拒绝 http:// 等明文；
//            · buildBrowserHistoryKey / buildBrowserBookmarksKey 对无效 userId
//              返回 null（fail-closed，不产生无主 key）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - computeAuthRedirect 为纯函数，但所在文件 _layout.js 含 JSX（Node 无法直接
//     import）。本测试从**真实源码** _layout.js 中精确抽取该纯函数源码，
//     写入临时模块后运行，确保断言针对真实实现而非复制品。
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

/**
 * 从真实 _layout.js 中抽取 computeAuthRedirect 函数源码。
 * 以 `export function computeAuthRedirect(` 起，到其后第一个「行首 }」结束。
 */
function extractComputeAuthRedirect() {
  const src = fs.readFileSync(path.join(repoRoot, 'src/app/_layout.js'), 'utf8');
  const start = src.indexOf('export function computeAuthRedirect(');
  if (start < 0) throw new Error('未在 _layout.js 中找到 computeAuthRedirect');
  const endMarker = '\n}\n';
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error('未找到 computeAuthRedirect 函数结束位置');
  return src.slice(start, end + endMarker.length);
}

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-e2e3-'));

  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/constants/browser/index.ts');

  // 把从真实源码抽取的纯函数写入独立模块（无 JSX / 无外部依赖）。
  const fnSrc = extractComputeAuthRedirect();
  fs.mkdirSync(path.join(dir, 'src/app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app/_layout_pure.js'), `${fnSrc}\n`);

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
// P04-E2-01：computeAuthRedirect 全分支穷举（占位闪现 / 白屏死锁防线）
// ---------------------------------------------------------------------------
test('P04-E2-01 computeAuthRedirect 全分支决策正确', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { computeAuthRedirect } = await import('./src/app/_layout_pure.js');
const U = { id: 'u1' };
const cases = {
  // 会话确认中 → 不跳转（避免误拦截 / 闪现私人页）
  loading: computeAuthRedirect({ user: null, isAuthLoading: true, authError: null, isInitialized: false, isPublicRoute: false }),
  // 安全存储故障 → 不跳转（由错误页接管，绝不误判登出）
  authError: computeAuthRedirect({ user: null, isAuthLoading: false, authError: { code: 'X' }, isInitialized: false, isPublicRoute: false }),
  // 未登录 + 非公开页 + 数据未就绪 → 必须去 /auth（白屏死锁核心修复）
  loggedOutNotInit: computeAuthRedirect({ user: null, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: false }),
  // 未登录 + 非公开页 + 数据已就绪 → 仍去 /auth
  loggedOutInit: computeAuthRedirect({ user: null, isAuthLoading: false, authError: null, isInitialized: true, isPublicRoute: false }),
  // 未登录 + 公开页（auth）→ 不跳转（停留在登录页）
  loggedOutPublic: computeAuthRedirect({ user: null, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: true }),
  // 已登录 + 数据未就绪 → 不跳转（占位，避免闪现私人页 / 他人数据）
  loggedInNotInit: computeAuthRedirect({ user: U, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: false }),
  // 已登录 + 数据就绪 + 非公开页 → 不跳转（正常停留）
  loggedInReady: computeAuthRedirect({ user: U, isAuthLoading: false, authError: null, isInitialized: true, isPublicRoute: false }),
  // 已登录 + 数据就绪 + 公开页（auth）→ 送回主界面 '/'
  loggedInPublic: computeAuthRedirect({ user: U, isAuthLoading: false, authError: null, isInitialized: true, isPublicRoute: true }),
};
process.stdout.write(JSON.stringify(cases));
`);
    assert.equal(out.loading, null, '会话确认中必须不跳转');
    assert.equal(out.authError, null, '安全存储故障必须不跳转（由错误页接管）');
    assert.equal(out.loggedOutNotInit, '/auth', '未登录 + 数据未就绪必须去 /auth（白屏死锁核心修复）');
    assert.equal(out.loggedOutInit, '/auth', '未登录 + 数据已就绪仍必须去 /auth');
    assert.equal(out.loggedOutPublic, null, '未登录 + 公开页必须停留（不重复跳转）');
    assert.equal(out.loggedInNotInit, null, '已登录 + 数据未就绪必须占位不跳转（避免闪现私人页）');
    assert.equal(out.loggedInReady, null, '已登录 + 数据就绪 + 非公开页必须正常停留');
    assert.equal(out.loggedInPublic, '/', '已登录 + 公开页必须送回主界面');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-E3-01：浏览器 URL 白名单穷举（仅 https:// 与 about:）
// ---------------------------------------------------------------------------
test('P04-E3-01 isSafeUrl 仅放行 https:// 与 about:，拒绝明文与危险协议', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const B = await import('./src/constants/browser/index.ts');
const allow = [
  'https://example.com',
  'https://cdn.example.com/a.m3u8?x=1',
  'about:blank',
  'HTTPS://UPPER.COM',
];
const deny = [
  'http://example.com',
  'http://insecure.com/a.mp4',
  'javascript:alert(1)',
  'data:text/html,<script>',
  'file:///etc/passwd',
  'ftp://x.com',
  '',
  null,
  undefined,
  123,
];
process.stdout.write(JSON.stringify({
  allow: allow.map((u) => B.isSafeUrl(u)),
  deny: deny.map((u) => B.isSafeUrl(u)),
}));
`);
    assert.deepEqual(out.allow, [true, true, true, true], 'https:// 与 about: 必须全部放行（大小写不敏感）');
    assert.deepEqual(out.deny, [false, false, false, false, false, false, false, false, false, false], '明文 http / javascript / data / file / ftp / 空 / 非字符串必须全部拒绝');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-E3-02：浏览器历史/书签 key 对无效 userId fail-closed（不产生无主 key）
// ---------------------------------------------------------------------------
test('P04-E3-02 浏览器历史/书签 key 对无效 userId 返回 null', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const B = await import('./src/constants/browser/index.ts');
const invalid = [null, undefined, '', 123, {}, []];
const valid = 'user-xyz';
process.stdout.write(JSON.stringify({
  histInvalid: invalid.map((u) => B.buildBrowserHistoryKey(u)),
  markInvalid: invalid.map((u) => B.buildBrowserBookmarksKey(u)),
  histValid: B.buildBrowserHistoryKey(valid),
  markValid: B.buildBrowserBookmarksKey(valid),
  histPrefix: B.BROWSER_HISTORY_KEY_PREFIX,
  markPrefix: B.BROWSER_BOOKMARKS_KEY_PREFIX,
}));
`);
    for (const v of out.histInvalid) assert.equal(v, null, '无效 userId 的历史 key 必须为 null');
    for (const v of out.markInvalid) assert.equal(v, null, '无效 userId 的书签 key 必须为 null');
    assert.equal(out.histValid, `${out.histPrefix}user-xyz`, '有效 userId 的历史 key 必须精确匹配 V2 前缀');
    assert.equal(out.markValid, `${out.markPrefix}user-xyz`, '有效 userId 的书签 key 必须精确匹配 V2 前缀');
    assert.equal(out.histPrefix, '@sync_browser_history_v2_', '历史 key 前缀必须为 V2 命名空间');
    assert.equal(out.markPrefix, '@sync_browser_bookmarks_v2_', '书签 key 前缀必须为 V2 命名空间');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_e2e3Routing.test.mjs ---
