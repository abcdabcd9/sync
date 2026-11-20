// --- START OF FILE tests/security/p04_cinemaContract.test.mjs ---
// ============================================================================
// TASK-P0.4 / 放映厅模块 — 最小契约测试
//
// 目的：P0.3 的 229 个测试集中在 auth / health / isolation / media cache，
//       放映厅（cinema）模块零自动化覆盖。本测试锁定放映厅两个「纯函数契约」，
//       防止后续重构（P1）无意改变剧集 URL 解析 / 下一集推断 / 同剧判定语义：
//         P04-CINEMA-01 parseEpisodeUrl / buildEpisodeUrl：播放页 URL 解析与构造；
//         P04-CINEMA-02 buildNextEpisodeUrl / isSameSeries / getCdnHost：
//                       下一集推断、同剧判定、CDN 线路特征。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 直接 import 真实源码 src/utils/episodeUrl.js（纯函数、无原生依赖）。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-cinema-'));
  const copy = (rel) => {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };
  copy('src/utils/episodeUrl.js');
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
// P04-CINEMA-01：parseEpisodeUrl / buildEpisodeUrl 契约
// ---------------------------------------------------------------------------
test('P04-CINEMA-01 parseEpisodeUrl 解析播放页 URL 且 buildEpisodeUrl 可逆', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { parseEpisodeUrl, buildEpisodeUrl } = await import('./src/utils/episodeUrl.js');
const full = parseEpisodeUrl('https://www.kkys11.com/play/392563-36-700596.html');
const pathOnly = parseEpisodeUrl('/play/392563-36-700596.html');
const withQuery = parseEpisodeUrl('https://www.kkys11.com/play/392563-36-700596.html?from=share');
const notPlay = parseEpisodeUrl('https://www.kkys11.com/vod/392563.html');
const empty = parseEpisodeUrl('');
const nullVal = parseEpisodeUrl(null);
const nonString = parseEpisodeUrl(12345);
const rebuilt = buildEpisodeUrl({ vodId: '392563', sourceId: '36', episodeId: 700596, origin: 'https://www.kkys11.com' });
const rebuiltDefaultOrigin = buildEpisodeUrl({ vodId: '1', sourceId: '2', episodeId: 3 });
process.stdout.write(JSON.stringify({ full, pathOnly, withQuery, notPlay, empty, nullVal, nonString, rebuilt, rebuiltDefaultOrigin }));
`);
    assert.deepEqual(out.full, {
      vodId: '392563',
      sourceId: '36',
      episodeId: 700596,
      origin: 'https://www.kkys11.com',
      raw: 'https://www.kkys11.com/play/392563-36-700596.html',
    }, '完整 URL 必须解析出 vodId/sourceId/episodeId/origin/raw');
    assert.equal(out.full.episodeId, 700596, 'episodeId 必须为数字类型');
    assert.equal(out.pathOnly.vodId, '392563', '纯 pathname 也必须可解析');
    assert.equal(out.pathOnly.origin, '', '纯 pathname 无 origin');
    assert.equal(out.withQuery.episodeId, 700596, '带 query 的 URL 仍可解析');
    assert.equal(out.notPlay, null, '非播放页 URL 返回 null');
    assert.equal(out.empty, null, '空串返回 null');
    assert.equal(out.nullVal, null, 'null 返回 null');
    assert.equal(out.nonString, null, '非字符串返回 null');
    assert.equal(out.rebuilt, 'https://www.kkys11.com/play/392563-36-700596.html', 'buildEpisodeUrl 必须与原始 URL 一致（可逆）');
    assert.equal(out.rebuiltDefaultOrigin, 'https://www.kkys11.com/play/1-2-3.html', 'buildEpisodeUrl 缺省 origin 为 kkys11');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-CINEMA-02：buildNextEpisodeUrl / isSameSeries / getCdnHost 契约
// ---------------------------------------------------------------------------
test('P04-CINEMA-02 下一集推断 / 同剧判定 / CDN 线路特征', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { buildNextEpisodeUrl, isSameSeries, getCdnHost } = await import('./src/utils/episodeUrl.js');
const cur = 'https://www.kkys11.com/play/392563-36-700596.html';
const next1 = buildNextEpisodeUrl(cur);
const next2 = buildNextEpisodeUrl(cur, 2);
const nextFromPath = buildNextEpisodeUrl('/play/392563-36-700596.html');
const nextInvalid = buildNextEpisodeUrl('https://www.kkys11.com/vod/392563.html');
const nextNull = buildNextEpisodeUrl(null);
const sameSeriesDiffEp = isSameSeries(cur, 'https://www.kkys11.com/play/392563-36-700597.html');
const diffSource = isSameSeries(cur, 'https://www.kkys11.com/play/392563-35-700596.html');
const diffVod = isSameSeries(cur, 'https://www.kkys11.com/play/999999-36-700596.html');
const invalidSeries = isSameSeries(cur, 'not-a-url');
const cdn = getCdnHost('https://vv.jisuzyv.com/play/aADQRA9e/index.m3u8');
const cdnInvalid = getCdnHost('not-a-url');
const cdnEmpty = getCdnHost('');
process.stdout.write(JSON.stringify({ next1, next2, nextFromPath, nextInvalid, nextNull, sameSeriesDiffEp, diffSource, diffVod, invalidSeries, cdn, cdnInvalid, cdnEmpty }));
`);
    assert.equal(out.next1, 'https://www.kkys11.com/play/392563-36-700597.html', '默认步长 +1 推断下一集');
    assert.equal(out.next2, 'https://www.kkys11.com/play/392563-36-700598.html', '自定义步长 +2 推断下一集');
    assert.equal(out.nextFromPath, 'https://www.kkys11.com/play/392563-36-700597.html', '纯 pathname 推断时回退默认 origin');
    assert.equal(out.nextInvalid, null, '非播放页 URL 无法推断下一集');
    assert.equal(out.nextNull, null, 'null 无法推断下一集');
    assert.equal(out.sameSeriesDiffEp, true, '同 vodId+sourceId 不同集 → 同剧');
    assert.equal(out.diffSource, false, '不同 sourceId → 非同剧');
    assert.equal(out.diffVod, false, '不同 vodId → 非同剧');
    assert.equal(out.invalidSeries, false, '无法解析 → 非同剧');
    assert.equal(out.cdn, 'vv.jisuzyv.com', 'getCdnHost 必须返回 m3u8 直链 host');
    assert.equal(out.cdnInvalid, '', '非法 URL 返回空串');
    assert.equal(out.cdnEmpty, '', '空串返回空串');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_cinemaContract.test.mjs ---
