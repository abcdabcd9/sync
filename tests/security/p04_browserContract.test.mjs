// --- START OF FILE tests/security/p04_browserContract.test.mjs ---
// ============================================================================
// TASK-P0.4 / 内置浏览器模块 — 最小契约测试
//
// 目的：P0.3 的 229 个测试集中在 auth / health / isolation / media cache，
//       内置浏览器模块零自动化覆盖。本测试锁定浏览器模块的纯函数契约，
//       防止后续重构（P1）无意改变 URL 安全白名单 / 广告域名拦截 /
//       媒体识别 / 历史标题与时间格式化 / 媒体列表合并去重语义：
//         P04-BROWSER-01 isSafeUrl / isAdUrl：安全协议白名单 + 广告域名黑名单；
//         P04-BROWSER-02 getMediaExt / getDomain / ellipsisMiddle / buildMediaItem：
//                       媒体扩展名、域名归一化、URL 中间省略、列表项构造；
//         P04-BROWSER-03 formatHistoryTime / buildHistoryTitle / mergeMediaList：
//                       历史时间格式化、标题回退链、媒体列表合并去重。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 直接 import 真实源码 src/constants/browser/index.js（纯函数、无原生依赖）。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-browser-'));
  const src = path.join(repoRoot, 'src/constants/browser/index.js');
  const dst = path.join(dir, 'src/constants/browser/index.js');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

// ---------------------------------------------------------------------------
// P04-BROWSER-01：isSafeUrl / isAdUrl 契约
// ---------------------------------------------------------------------------
test('P04-BROWSER-01 isSafeUrl 仅放行 https/about，isAdUrl 命中广告域名', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { isSafeUrl, isAdUrl } = await import('./src/constants/browser/index.js');
const safe = {
  https: isSafeUrl('https://example.com/a'),
  httpsUpper: isSafeUrl('HTTPS://EXAMPLE.COM/a'),
  about: isSafeUrl('about:blank'),
  http: isSafeUrl('http://example.com/a'),
  javascript: isSafeUrl('javascript:alert(1)'),
  data: isSafeUrl('data:text/html,<script>'),
  file: isSafeUrl('file:///etc/passwd'),
  empty: isSafeUrl(''),
  nullVal: isSafeUrl(null),
  nonString: isSafeUrl(123),
};
const ad = {
  popads: isAdUrl('https://popads.net/x.js'),
  doubleclick: isAdUrl('https://ad.doubleclick.net/pixel'),
  casino: isAdUrl('https://www.casino-online.com/'),
  legit: isAdUrl('https://www.kkys11.com/play/1-2-3.html'),
  pathOnly: isAdUrl('https://cdn.example.com/casino/movie.mp4'),
  queryOnly: isAdUrl('https://cdn.example.com/v.mp4?ref=popads'),
  invalid: isAdUrl('not-a-url'),
  empty: isAdUrl(''),
  nullVal: isAdUrl(null),
};
process.stdout.write(JSON.stringify({ safe, ad }));
`);
    assert.equal(out.safe.https, true, 'https:// 放行');
    assert.equal(out.safe.httpsUpper, true, '协议大小写不敏感');
    assert.equal(out.safe.about, true, 'about: 放行');
    assert.equal(out.safe.http, false, '明文 http:// 必须拒绝');
    assert.equal(out.safe.javascript, false, 'javascript: 必须拒绝');
    assert.equal(out.safe.data, false, 'data: 必须拒绝');
    assert.equal(out.safe.file, false, 'file: 必须拒绝');
    assert.equal(out.safe.empty, false, '空串拒绝');
    assert.equal(out.safe.nullVal, false, 'null 拒绝');
    assert.equal(out.safe.nonString, false, '非字符串拒绝');
    assert.equal(out.ad.popads, true, 'popads 域名命中');
    assert.equal(out.ad.doubleclick, true, 'doubleclick 域名命中');
    assert.equal(out.ad.casino, true, 'casino 域名命中');
    assert.equal(out.ad.legit, false, '正规站点不误杀');
    assert.equal(out.ad.pathOnly, false, '仅匹配 hostname，path 含 casino 不误杀');
    assert.equal(out.ad.queryOnly, false, '仅匹配 hostname，query 含 popads 不误杀');
    assert.equal(out.ad.invalid, false, '非法 URL 兜底不命中');
    assert.equal(out.ad.empty, false, '空串不命中');
    assert.equal(out.ad.nullVal, false, 'null 不命中');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-BROWSER-02：getMediaExt / getDomain / ellipsisMiddle / buildMediaItem
// ---------------------------------------------------------------------------
test('P04-BROWSER-02 媒体扩展名 / 域名归一化 / URL 省略 / 列表项构造', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { getMediaExt, getDomain, ellipsisMiddle, buildMediaItem } = await import('./src/constants/browser/index.js');
const ext = {
  m3u8: getMediaExt('https://cdn.x.com/a/index.m3u8'),
  mp4Query: getMediaExt('https://cdn.x.com/a.mp4?token=1'),
  mkvHash: getMediaExt('https://cdn.x.com/a.MKV#t=10'),
  unknown: getMediaExt('https://cdn.x.com/a.jpg'),
  nonString: getMediaExt(null),
};
const domain = {
  www: getDomain('https://www.example.com/a'),
  plain: getDomain('https://cdn.example.com/a'),
  invalid: getDomain('not-a-url'),
};
const ell = {
  short: ellipsisMiddle('https://a.com/x'),
  long: ellipsisMiddle('https://cdn.example.com/very/long/path/to/some/video/file/index.m3u8'),
  nonString: ellipsisMiddle(null),
};
const item = buildMediaItem('https://cdn.example.com/v/index.m3u8');
process.stdout.write(JSON.stringify({ ext, domain, ell, item }));
`);
    assert.equal(out.ext.m3u8, 'm3u8');
    assert.equal(out.ext.mp4Query, 'mp4', '带 query 仍识别扩展名');
    assert.equal(out.ext.mkvHash, 'mkv', '大写扩展名归一化为小写');
    assert.equal(out.ext.unknown, 'media', '非媒体扩展名回退 media');
    assert.equal(out.ext.nonString, 'media', '非字符串回退 media');
    assert.equal(out.domain.www, 'example.com', '必须剥离 www. 前缀');
    assert.equal(out.domain.plain, 'cdn.example.com');
    assert.equal(out.domain.invalid, '', '非法 URL 返回空串');
    assert.equal(out.ell.short, 'https://a.com/x', '短 URL 原样返回');
    assert.ok(out.ell.long.includes('…'), '长 URL 必须中间省略');
    // 默认 head=26 / tail=18：头部保留前 26 字符，尾部保留后 18 字符
    const [headPart, tailPart] = out.ell.long.split('…');
    assert.equal(headPart.length, 26, '头部必须保留 26 字符');
    assert.equal(tailPart.length, 18, '尾部必须保留 18 字符');
    assert.ok(out.ell.long.startsWith('https://cdn.example.com/'), '头部必须为原 URL 前缀');
    assert.ok(out.ell.long.endsWith('index.m3u8'), '尾部必须包含完整文件名');
    assert.equal(out.ell.nonString, '', '非字符串返回空串');
    assert.deepEqual(out.item, {
      id: 'https://cdn.example.com/v/index.m3u8',
      url: 'https://cdn.example.com/v/index.m3u8',
      ext: 'm3u8',
      domain: 'cdn.example.com',
    }, 'buildMediaItem 必须构造 id/url/ext/domain 四字段');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-BROWSER-03：formatHistoryTime / buildHistoryTitle / mergeMediaList
// ---------------------------------------------------------------------------
test('P04-BROWSER-03 历史时间格式化 / 标题回退链 / 媒体列表合并去重', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { formatHistoryTime, buildHistoryTitle, mergeMediaList } = await import('./src/constants/browser/index.js');
// 固定本地时间戳（用 Date 构造，避免时区差异：断言用同一 Date 计算期望值）
const ts = new Date(2026, 10, 29, 14, 30, 5).getTime();
const time = {
  fixed: formatHistoryTime(ts),
  invalid: formatHistoryTime(NaN),
};
const title = {
  withTitle: buildHistoryTitle('  我的标题  ', 'https://www.example.com/a'),
  emptyTitle: buildHistoryTitle('', 'https://www.example.com/a'),
  noTitleNoDomain: buildHistoryTitle('   ', 'not-a-url-but-long-enough-to-be-ellipsized-xxxxxxxxxxxxxxxxxxxx'),
};
const prev = [
  { id: 'https://a.com/1.m3u8', url: 'https://a.com/1.m3u8', ext: 'm3u8', domain: 'a.com' },
];
const merged = mergeMediaList(prev, ['https://b.com/2.mp4', 'https://a.com/1.m3u8', '', null, 'https://c.com/3.mkv']);
const mergedEmpty = mergeMediaList(prev, []);
const mergedNotArray = mergeMediaList(prev, null);
const mergedAllDup = mergeMediaList(prev, ['https://a.com/1.m3u8']);
process.stdout.write(JSON.stringify({ time, title, merged, mergedEmpty, mergedNotArray, mergedAllDup }));
`);
    assert.equal(out.time.fixed, '11-29 14:30', '格式必须为 MM-DD HH:mm');
    assert.equal(out.time.invalid, '', '非法时间戳返回空串');
    assert.equal(out.title.withTitle, '我的标题', '标题必须 trim');
    assert.equal(out.title.emptyTitle, 'example.com', '空标题回退域名（剥离 www.）');
    assert.ok(out.title.noTitleNoDomain.length > 0, '无标题无域名回退 URL 省略');
    assert.equal(out.merged.length, 3, '新增 2 条 + 原有 1 条 = 3 条');
    assert.equal(out.merged[0].url, 'https://b.com/2.mp4', '新项在前');
    assert.equal(out.merged[1].url, 'https://c.com/3.mkv', '新项保持 incoming 顺序');
    assert.equal(out.merged[2].url, 'https://a.com/1.m3u8', '原有项在后');
    assert.equal(out.mergedEmpty.length, 1, '空 incoming 返回原数组');
    assert.equal(out.mergedNotArray.length, 1, '非数组 incoming 返回原数组');
    assert.equal(out.mergedAllDup.length, 1, '全部重复时返回原数组');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_browserContract.test.mjs ---
