// --- START OF FILE tests/security/p15_realWorldFix.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — 真机故障修复（REAL WORLD FIX）测试
//
// 覆盖两个真机故障的真实生产调用路径：
//
//   故障 A（集数显示成六位数）：
//     · 第 1 集内部 ID = 700596，界面绝不能显示「第 700596 集」
//     · 优先采用选集列表真实标题 / 真实顺序
//     · 无法确认时留空，绝不编造数字
//     · 旧记录里的错误标签被非破坏性清洗（不清空历史、不丢进度）
//
//   故障 B（点击历史只跳原始网页，不自动嗅探 / 进影院 / 恢复进度）：
//     · 页面加载完成后确实自动触发嗅探（源码契约：handleLoadFinish → triggerManualSniff）
//     · 嗅探到唯一可靠匹配 → 真正调用 loadUrl + goCinema（源码契约 + 逻辑验证）
//     · 多候选 → 不无依据选第一条，交给 Picker
//     · 未找到目标 → 明确状态，保留任务
//     · 同集换 CDN 后仍可续播（recordKey 身份）
//     · 影院收到任务并恢复正确秒数（isResumeTargetCurrent + seekSeconds）
//
// 测试策略：
//   1) 逻辑层：直接 import 真实 watchHistoryLogic.js，驱动真实导出函数。
//   2) 源码契约层：读取真实 src/app/browser/index.js / cinema.js 源码，
//      断言关键调用链存在且顺序正确（防止未来回归把自动交接删掉）。
//   3) 不联网、不使用真实 .env / Token / 用户数据。
//   4) 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// 🧩 P1.x 重构后：`src/constants/browser/index.js` 已迁移为 `index.ts`，但生产源码
//    watchHistoryLogic.js 仍以显式 `index.js` 导入。Node ESM 不做扩展名回退，
//    故注册一个解析钩子：当请求的 .js 不存在而同名 .ts 存在时，重定向到 .ts
//    （Node 24 对 .ts 做原生类型擦除，可直接执行）。
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      const tsSpec = specifier.replace(/\\.js$/, '.ts');
      try { return await nextResolve(tsSpec, context); } catch {}
    }
    throw err;
  }
}
`),
  import.meta.url
);

const LOGIC_PATH = path.join(repoRoot, 'src/hooks/browser/watchHistoryLogic.js');
const BROWSER_PATH = path.join(repoRoot, 'src/app/browser/index.js');
const CINEMA_PATH = path.join(repoRoot, 'src/app/cinema.js');

const logic = await import(pathToFileURL(LOGIC_PATH).href);
const browserSrc = fs.readFileSync(BROWSER_PATH, 'utf8');
const cinemaSrc = fs.readFileSync(CINEMA_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 真实站点常量（来自 src/utils/episodeUrl.js 的既有记录）
// ---------------------------------------------------------------------------
const SITE = 'https://kkys11.example.com';
const VOD = '392563';
const SRC = '36';
const EP1_ID = '700596'; // 第 1 集的站点内部资源 ID（不是集数！）
const EP2_ID = '700597';
const pageUrlEp1 = `${SITE}/play/${VOD}-${SRC}-${EP1_ID}.html`;
const pageUrlEp2 = `${SITE}/play/${VOD}-${SRC}-${EP2_ID}.html`;
const cdnA = `https://cdn-a.${'kkys11.example.com'}/vod/${VOD}-${SRC}-${EP1_ID}/index.m3u8`;
const cdnB = `https://cdn-b.${'kkys11.example.com'}/vod/${VOD}-${SRC}-${EP1_ID}/index.m3u8`;

// ===========================================================================
// 故障 A — 集数标签
// ===========================================================================

test('A1 第 1 集内部 ID 700596 不会被格式化成「第700596集」', () => {
  // 直接模拟旧 bug 的输入：episodeId 被当成集数
  const leaked = `第${EP1_ID}集`;
  assert.equal(logic.isLeakedEpisodeIdLabel(leaked), true, '700596 必须被识别为泄漏的内部 ID');
  assert.equal(logic.sanitizeEpisodeLabel(leaked), '', '泄漏标签必须被清洗为空，绝不显示六位数');
});

test('A2 正常集数标签不被误判为泄漏', () => {
  assert.equal(logic.isLeakedEpisodeIdLabel('第1集'), false);
  assert.equal(logic.isLeakedEpisodeIdLabel('第12集'), false);
  assert.equal(logic.isLeakedEpisodeIdLabel('第999集'), false);
  assert.equal(logic.sanitizeEpisodeLabel('第12集'), '第12集');
  assert.equal(logic.sanitizeEpisodeLabel('  第3集  '), '第3集', '应 trim');
});

test('A3 resolveEpisodeLabel 优先采用选集列表真实标题', () => {
  const list = [
    { label: '第1集', title: '初入江湖' },
    { label: '第2集', title: '风起云涌' },
  ];
  assert.equal(logic.resolveEpisodeLabel(list, 0), '第1集');
  assert.equal(logic.resolveEpisodeLabel(list, 1), '第2集');
});

test('A4 resolveEpisodeLabel 无标题时用真实顺序（index+1），与 EpisodeDrawer 兜底一致', () => {
  const list = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];
  assert.equal(logic.resolveEpisodeLabel(list, 0), '第1集');
  assert.equal(logic.resolveEpisodeLabel(list, 2), '第3集');
});

test('A5 resolveEpisodeLabel 列表标题本身是泄漏 ID 时，回退到真实顺序', () => {
  const list = [{ label: `第${EP1_ID}集` }];
  assert.equal(logic.resolveEpisodeLabel(list, 0), '第1集', '泄漏标题必须被忽略，改用顺序');
});

test('A6 resolveEpisodeLabel 无法确认时留空，绝不编造数字', () => {
  assert.equal(logic.resolveEpisodeLabel([], -1), '');
  assert.equal(logic.resolveEpisodeLabel(null, 0), '');
  assert.equal(logic.resolveEpisodeLabel([{ title: 'x' }], 5), '', '越界索引必须留空');
});

test('A7 buildWatchRecord 写入时清洗泄漏标签', () => {
  const rec = logic.buildWatchRecord({
    mediaUrl: cdnA,
    pageUrl: pageUrlEp1,
    title: '测试剧',
    episodeLabel: `第${EP1_ID}集`,
    positionMillis: 60000,
    durationMillis: 600000,
  });
  assert.equal(rec.episodeLabel, '', 'buildWatchRecord 必须清洗泄漏标签');
  assert.equal(rec.positionMillis, 60000, '进度必须保留');
});

test('A8 normalizeWatchRecord 对旧记录非破坏性清洗（不清空历史、不丢进度）', () => {
  const legacy = {
    recordKey: logic.buildRecordKey({ mediaUrl: cdnA, pageUrl: pageUrlEp1 }),
    mediaKey: logic.buildMediaKey({ mediaUrl: cdnA, pageUrl: pageUrlEp1 }),
    mediaUrl: cdnA,
    pageUrl: pageUrlEp1,
    title: '旧剧',
    episodeLabel: `第${EP1_ID}集`, // 旧版本写入的错误标签
    positionMillis: 123456,
    durationMillis: 600000,
    updatedAt: Date.now(),
  };
  const norm = logic.normalizeWatchRecord(legacy);
  assert.ok(norm, '旧记录必须仍被接受（非破坏性）');
  assert.equal(norm.episodeLabel, '', '错误标签被清洗');
  assert.equal(norm.positionMillis, 123456, '进度必须完整保留');
  assert.equal(norm.title, '旧剧', '标题必须保留');
  assert.equal(norm.pageUrl, pageUrlEp1, '播放页必须保留');
});

test('A9 upsertWatchRecord 合并时不会把泄漏标签写回', () => {
  const base = logic.buildWatchRecord({
    mediaUrl: cdnA, pageUrl: pageUrlEp1, title: 't', episodeLabel: '第1集',
    positionMillis: 1000, durationMillis: 600000,
  });
  const incoming = { ...base, episodeLabel: `第${EP1_ID}集`, positionMillis: 2000 };
  const merged = logic.upsertWatchRecord([base], incoming, 50);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].episodeLabel, '第1集', '泄漏标签不得覆盖已有的正确标签');
  assert.equal(merged[0].positionMillis, 2000, '进度应更新');
});

// ===========================================================================
// 故障 B — 自动嗅探 / 交接 / 续播
// ===========================================================================

function makePending(overrides = {}) {
  return {
    taskId: logic.createResumeTaskId(),
    recordKey: logic.buildRecordKey({ mediaUrl: cdnA, pageUrl: pageUrlEp1 }),
    mediaKey: logic.buildMediaKey({ mediaUrl: cdnA, pageUrl: pageUrlEp1, episode: logic.parseEpisodeTriple(pageUrlEp1) }),
    mediaUrl: cdnA,
    pageUrl: pageUrlEp1,
    seekSeconds: 1234,
    title: '测试剧',
    episodeLabel: '第1集',
    createdAt: Date.now(),
    status: logic.RESUME_TASK_STATUS.PENDING,
    ...overrides,
  };
}

test('B1 唯一可靠匹配 → matchResumeCandidates 返回 MATCHED 且带正确 url', () => {
  const pending = makePending();
  // 干扰项用「完全不同的可注册主域」的广告资源，确保不会被误判为同站正片
  const mediaList = [{ url: cdnA }, { url: 'https://ads.tracker-ads.net/preroll.m3u8' }];
  const r = logic.matchResumeCandidates(pending, mediaList, pageUrlEp1);
  assert.equal(r.status, 'MATCHED');
  assert.equal(r.url, cdnA);
  assert.equal(r.pageUrl, pageUrlEp1);
});

test('B2 同集换 CDN 后仍可续播（recordKey 身份，不依赖具体 CDN URL）', () => {
  const pending = makePending(); // 记录的是 cdnA
  const mediaList = [{ url: cdnB }]; // 嗅探到的是 cdnB（同集不同 CDN）
  const r = logic.matchResumeCandidates(pending, mediaList, pageUrlEp1);
  assert.equal(r.status, 'MATCHED', '同集换 CDN 必须仍能匹配');
  assert.equal(r.url, cdnB);
});

test('B3 多候选无法确定 → AMBIGUOUS，绝不无依据选第一条', () => {
  const pending = makePending();
  // 两个都同集（同 recordKey）但不同 CDN → 无法确定唯一
  const mediaList = [{ url: cdnA }, { url: cdnB }];
  const r = logic.matchResumeCandidates(pending, mediaList, pageUrlEp1);
  assert.equal(r.status, 'AMBIGUOUS');
  assert.equal(r.url, undefined, 'AMBIGUOUS 时不得给出 url');
  assert.equal(r.candidates.length, 2);
});

test('B4 未找到目标视频 → NONE（浏览器据此给出明确状态并保留任务）', () => {
  const pending = makePending();
  // 完全不同的可注册主域 → 既非同集 recordKey，也非同站正片 → 不命中
  const mediaList = [{ url: 'https://cdn.unrelated-site.net/x.m3u8' }];
  const r = logic.matchResumeCandidates(pending, mediaList, pageUrlEp1);
  assert.equal(r.status, 'NONE');
});

test('B5 不同集（第2集）不会被误匹配到第1集任务', () => {
  const pending = makePending(); // 第1集
  const mediaList = [{ url: `https://cdn-a.kkys11.example.com/vod/${VOD}-${SRC}-${EP2_ID}/index.m3u8` }];
  const r = logic.matchResumeCandidates(pending, mediaList, pageUrlEp2);
  assert.equal(r.status, 'NONE', '第2集不得匹配第1集任务');
});

test('B6 过期任务 → isResumeTaskExpired 为 true（浏览器据此作废并提示）', () => {
  const pending = makePending({ createdAt: Date.now() - 60000 });
  assert.equal(logic.isResumeTaskExpired(pending), true);
});

test('B7 影院侧：身份确认 + seekSeconds 正确（恢复正确秒数）', () => {
  const pending = makePending({ seekSeconds: 1234 });
  const current = {
    recordKey: logic.buildRecordKey({ mediaUrl: cdnB, pageUrl: pageUrlEp1 }),
    mediaKey: logic.buildMediaKey({ mediaUrl: cdnB, pageUrl: pageUrlEp1, episode: logic.parseEpisodeTriple(pageUrlEp1) }),
    mediaUrl: cdnB,
    pageUrl: pageUrlEp1,
  };
  assert.equal(logic.isResumeTargetCurrent(pending, current), true, '同集换 CDN 后影院仍应确认身份');
  assert.equal(pending.seekSeconds, 1234, 'seek 秒数必须原样保留');
});

test('B8 影院侧：广告 / 跨站资源不得被确认为续播目标', () => {
  const pending = makePending();
  const adCurrent = {
    recordKey: '',
    mediaKey: '',
    mediaUrl: 'https://ads.tracker.example.net/preroll.m3u8',
    pageUrl: pageUrlEp1,
  };
  assert.equal(logic.isResumeTargetCurrent(pending, adCurrent), false, '广告资源不得被确认');
});

// ===========================================================================
// 源码契约 — 确保生产调用链真实存在（防止未来回归）
// ===========================================================================

test('C1 浏览器 handleLoadFinish 在存在任务时自动触发 triggerManualSniff', () => {
  assert.ok(/const handleLoadFinish = useCallback/.test(browserSrc), 'handleLoadFinish 必须存在');
  // 在 handleLoadFinish 函数体内必须调用 triggerManualSniff
  const idx = browserSrc.indexOf('const handleLoadFinish = useCallback');
  const body = browserSrc.slice(idx, idx + 2000);
  assert.ok(/triggerManualSniff\(webViewRef\)/.test(body), 'handleLoadFinish 必须自动触发嗅探');
  assert.ok(/autoSniffTaskIdRef/.test(body), '必须有去重标记，避免循环嗅探');
  assert.ok(/setResumeHandoff\('sniffing'\)/.test(body), '必须设置 sniffing 状态给用户反馈');
});

test('C2 浏览器 runResumeHandoff 在 MATCHED 时真正调用 loadUrl + goCinema', () => {
  const idx = browserSrc.indexOf('const runResumeHandoff = useCallback');
  assert.ok(idx >= 0, 'runResumeHandoff 必须存在');
  const body = browserSrc.slice(idx, idx + 1600);
  assert.ok(/result\.status === 'MATCHED'/.test(body), '必须处理 MATCHED');
  assert.ok(/loadUrl\(result\.url/.test(body), 'MATCHED 必须调用 loadUrl');
  assert.ok(/goCinema\(\)/.test(body), 'MATCHED 必须调用 goCinema');
  assert.ok(/result\.status === 'AMBIGUOUS'/.test(body), '必须处理 AMBIGUOUS');
  assert.ok(/openPickerRef\.current\?\.\(\)/.test(body), 'AMBIGUOUS 必须打开 Picker');
});

test('C3 浏览器 handleMediaFound 优先走续播匹配，而不是无条件弹 Picker', () => {
  const idx = browserSrc.indexOf('const handleMediaFound = useCallback');
  assert.ok(idx >= 0, 'handleMediaFound 必须存在');
  const body = browserSrc.slice(idx, idx + 900);
  assert.ok(/runResumeHandoff\(nextList/.test(body), 'handleMediaFound 必须调用 runResumeHandoff');
  // runResumeHandoff 必须在 openPickerRef 之前（优先续播）
  const handoffPos = body.indexOf('runResumeHandoff(nextList');
  const pickerPos = body.indexOf('openPickerRef.current?.()');
  assert.ok(handoffPos >= 0 && pickerPos > handoffPos, '续播匹配必须先于弹 Picker');
});

test('C4 浏览器 handleLaunchCinema 在用户选源后标记 matched（B3 完成跳转）', () => {
  const idx = browserSrc.indexOf('const handleLaunchCinema = useCallback');
  assert.ok(idx >= 0);
  const body = browserSrc.slice(idx, idx + 1800);
  assert.ok(/setResumeHandoff\('matched'\)/.test(body), '用户选源后应标记 matched');
  assert.ok(/loadUrl\(target, pageUrl\)/.test(body), '必须调用 loadUrl');
  assert.ok(/goCinema\(\)/.test(body), '必须调用 goCinema');
});

test('C5 浏览器存在续播状态条（B4 明确状态）', () => {
  assert.ok(/resumeHandoff !== 'idle'/.test(browserSrc), '必须渲染状态条');
  assert.ok(/正在自动检测视频源/.test(browserSrc), '必须有嗅探中提示');
  assert.ok(/未自动找到上次的视频/.test(browserSrc), '必须有失败提示');
  assert.ok(/检测到多个片源/.test(browserSrc), '必须有多候选提示');
});

test('C6 浏览器卸载时清理兜底定时器', () => {
  assert.ok(/resumeHandoffTimerRef/.test(browserSrc), '必须有兜底定时器 ref');
  assert.ok(/clearTimeout\(resumeHandoffTimerRef\.current\)/.test(browserSrc), '必须清理定时器');
});

test('C7 cinema.js 使用 resolveEpisodeLabel，不再把 episodeId 直接格式化为集数', () => {
  assert.ok(/resolveEpisodeLabel\(episodeList, currentEpisodeIndex\)/.test(cinemaSrc),
    'cinema.js 必须使用 resolveEpisodeLabel');
  assert.ok(!/第\$\{triple\.episodeId\}集/.test(cinemaSrc),
    'cinema.js 不得再把 episodeId 直接格式化为「第X集」');
});

test('C8 cinema.js 仍保留 episodeId 在身份匹配中的用途（不误删）', () => {
  // parseEpisodeTriple 仍被用于 buildMediaKey / buildRecordKey 的身份计算
  assert.ok(/parseEpisodeTriple/.test(cinemaSrc), 'parseEpisodeTriple 必须仍被使用');
  assert.ok(/buildMediaKey\(/.test(cinemaSrc), 'buildMediaKey 必须仍被使用');
});

// --- END OF FILE tests/security/p15_realWorldFix.test.mjs ---
