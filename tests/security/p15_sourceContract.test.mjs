// --- START OF FILE tests/security/p15_sourceContract.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — Gatekeeper 修复：生产源码契约测试
//
// 目的（对应 Gatekeeper 硬性要求）：
//   「恢复错误代码后测试必须失败」。
//
//   本文件分两类断言：
//     A. 行为断言：直接 import 真实生产模块（watchHistoryLogic.js）并执行，
//        断言其行为符合修复契约。注入错误逻辑后行为改变 → 测试必然失败。
//     B. 结构断言：读取生产源码文本，断言关键调用点存在（用于无法直接执行
//        的 RN 组件，如 browser/index.js、cinema.js）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// 去掉注释，避免注释里的说明文字干扰断言（保留代码语义）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC = {
  browser: read('src/app/browser/index.js'),
  cinema: read('src/app/cinema.js'),
  session: read('src/context/BrowserSessionContext.js'),
  hook: read('src/hooks/browser/useWatchHistory.js'),
  logic: read('src/hooks/browser/watchHistoryLogic.js'),
};

// 直接 import 真实纯逻辑模块（无 RN 依赖，可安全执行）
const LOGIC = await import(
  path.join(repoRoot, 'src/hooks/browser/watchHistoryLogic.js')
);

// ===========================================================================
// P0-1：浏览器不得提前消费续播任务；消费只发生在影院 seek 成功后
// ===========================================================================
test('P0-1 契约：浏览器 Case A 不调用 consumePendingResume（任务留给影院）', () => {
  const code = stripComments(SRC.browser);
  // 定位 Case A 分支：loadUrl(decision.url ...) 之后到 return 之间
  const caseA = code.match(/loadUrl\(decision\.url[\s\S]{0,400}?return;/);
  assert.ok(caseA, '必须存在 Case A 直链分支');
  assert.ok(
    !/consumePendingResume\s*\(/.test(caseA[0]),
    'Case A 内不得调用 consumePendingResume（否则影院拿不到任务）'
  );
  // 但必须消费 pendingUrl（导航态），避免重复注入
  assert.ok(/consumePendingUrl\s*\(/.test(caseA[0]), 'Case A 必须消费 pendingUrl');
});

test('P0-1 契约：影院仅在 seek 成功后 consumePendingResume(taskId)', () => {
  const code = stripComments(SRC.cinema);
  // 必须存在「seekOk → APPLIED + consumePendingResume(task.taskId)」的路径
  assert.ok(
    /consumePendingResume\s*\(\s*task\.taskId\s*\)/.test(code),
    '影院必须以 taskId 精确消费任务'
  );
  // 必须存在 seek 成功判定（seekOk / APPLIED）
  assert.ok(/RESUME_TASK_STATUS\.APPLIED/.test(code), '影院必须标记 APPLIED');
  // 必须有 taskId 去重，避免重复 seek
  assert.ok(/appliedResumeTaskIdRef/.test(code), '影院必须有 taskId 去重 ref');
});

test('P0-1 契约：影院 seek 前必须校验当前媒体身份（isResumeTargetCurrent）', () => {
  const code = stripComments(SRC.cinema);
  assert.ok(
    /isResumeTargetCurrent\s*\(/.test(code),
    '影院 seek 前必须调用 isResumeTargetCurrent 校验身份'
  );
  // 必须有超时作废（不无限等待）
  assert.ok(/isResumeTaskExpired\s*\(/.test(code), '影院必须有任务超时判定');
});

test('P0-1 契约：BrowserSessionContext 提供唯一 taskId 与精确消费', () => {
  const code = stripComments(SRC.session);
  assert.ok(/createResumeTaskId\s*\(/.test(code), '必须用 createResumeTaskId 生成唯一任务号');
  // consumePendingResume 必须支持按 taskId 精确匹配
  assert.ok(
    /consumePendingResume[\s\S]{0,300}?taskId/.test(code),
    'consumePendingResume 必须按 taskId 精确匹配'
  );
  // 切号/代际变化必须清理 pendingResume
  assert.ok(/setPendingResumeState/.test(code), '必须有 pendingResume 状态 setter');
  assert.ok(/pendingResume/.test(code), '必须暴露 pendingResume 状态');
});

// ===========================================================================
// P0-2：脱敏 URL 不视为必然有效；优先回原播放页
// ===========================================================================
test('P0-2 契约（行为）：有播放页时优先回原播放页，而非盲连脱敏直链', () => {
  // 有 pageUrl + 脱敏 mediaUrl + 无候选 → 必须 NAVIGATE_TO_PAGE
  const record = {
    mediaKey: 'ep:site.com:392563:36:700596',
    mediaUrl: 'https://cdn.site.com/vod/392563-36-700596/index.m3u8',
    pageUrl: 'https://site.com/play/392563-36-700596.html',
    positionMillis: 600000,
    durationMillis: 3600000,
    completed: false,
  };
  const d = LOGIC.decideResume(record, []);
  assert.equal(d.action, 'NAVIGATE_TO_PAGE', '有播放页时必须优先回原播放页');
  assert.equal(d.reason, 'need_renavigate');
  assert.equal(d.url, record.pageUrl);
});

test('P0-2 契约（行为）：无播放页时脱敏直链标记 unverified', () => {
  const record = {
    mediaKey: 'm:https://cdn.site.com/a.m3u8',
    mediaUrl: 'https://cdn.site.com/a.m3u8',
    pageUrl: '',
    positionMillis: 600000,
    durationMillis: 3600000,
    completed: false,
  };
  const d = LOGIC.decideResume(record, []);
  assert.equal(d.unverified, true, '无播放页兜底直链必须标记 unverified');
  assert.equal(d.reason, 'unverified_saved_media_url');
});

test('P0-2 契约（行为）：敏感参数被剥离，不持久化签名/token', () => {
  const dirty = 'https://cdn.site.com/v.m3u8?token=SECRET&sign=ABC&expires=999&v=1';
  const clean = LOGIC.sanitizeMediaUrl(dirty);
  assert.ok(!/SECRET/.test(clean), 'token 必须被剥离');
  assert.ok(!/sign=ABC/.test(clean), 'sign 必须被剥离');
  assert.ok(!/expires=999/.test(clean), 'expires 必须被剥离');
  assert.ok(/v=1/.test(clean), '非敏感参数应保留');
});

// ===========================================================================
// P0-3：mediaKey 站点隔离 + 身份核验（防错集 / 广告 / 跨站同号）
// ===========================================================================
test('P0-3 契约（行为）：buildMediaKey 含站点域名隔离，跨站同号不碰撞', () => {
  // 必须走「剧集三元组」分支（①），该分支才依赖 site 前缀；
  // 若只传 pageUrl 会走 ③ p: 分支（天然含 host），无法验证站点隔离。
  const epA = LOGIC.parseEpisodeTriple('https://a.com/play/392563-36-700596.html');
  const epB = LOGIC.parseEpisodeTriple('https://b.com/play/392563-36-700596.html');
  const a = LOGIC.buildMediaKey({ pageUrl: 'https://a.com/play/392563-36-700596.html', episode: epA });
  const b = LOGIC.buildMediaKey({ pageUrl: 'https://b.com/play/392563-36-700596.html', episode: epB });
  assert.notEqual(a, b, '不同站点相同集号必须产生不同 mediaKey');
  assert.match(a, /a\.com/, 'mediaKey 必须含站点域名');
  assert.match(b, /b\.com/, 'mediaKey 必须含站点域名');
  assert.match(a, /^ep:/, '三元组分支必须以 ep: 开头');
});

test('P0-3 契约（行为）：isResumeTargetCurrent 不凭 pageUrl 判定，广告不通过闸门', () => {
  const pageUrl = 'https://site.com/play/392563-36-700596.html';
  const main = 'https://cdn.site.com/vod/392563-36-700596/index.m3u8';
  const ad = 'https://ads.tracker.com/preroll/ad.m3u8';
  const task = { mediaKey: LOGIC.buildMediaKey({ mediaUrl: main, pageUrl }), mediaUrl: main, pageUrl };
  // 同页广告：pageUrl 相同但媒体不同 → 不得通过
  const adCurrent = { mediaUrl: ad, pageUrl, mediaKey: LOGIC.buildMediaKey({ mediaUrl: ad, pageUrl }) };
  assert.equal(LOGIC.isResumeTargetCurrent(task, adCurrent), false, '同页广告不得通过 seek 闸门');
  // 主内容 → 通过
  const mainCurrent = { mediaUrl: main, pageUrl, mediaKey: LOGIC.buildMediaKey({ mediaUrl: main, pageUrl }) };
  assert.equal(LOGIC.isResumeTargetCurrent(task, mainCurrent), true, '主内容必须通过');
});

test('P0-3 契约（行为）：isPendingResumeMatch 拒绝同剧不同集', () => {
  const ep8 = 'https://site.com/play/392563-36-700596.html';
  const ep9 = 'https://site.com/play/392563-36-700597.html';
  const task = {
    mediaKey: LOGIC.buildMediaKey({ mediaUrl: 'https://cdn.site.com/700596.m3u8', pageUrl: ep8 }),
    mediaUrl: 'https://cdn.site.com/700596.m3u8',
    pageUrl: ep8,
  };
  const ep9Found = { mediaUrl: 'https://cdn.site.com/700597.m3u8', pageUrl: ep9 };
  assert.equal(LOGIC.isPendingResumeMatch(task, ep9Found), false, '同剧不同集不得匹配');
});

test('P0-3 契约：handleLaunchCinema 校验 pendingResume 身份，不匹配则作废', () => {
  const code = stripComments(SRC.browser);
  const fn = code.match(/handleLaunchCinema[\s\S]*?\n  }/);
  assert.ok(fn, '必须存在 handleLaunchCinema');
  assert.ok(/isPendingResumeMatch\s*\(/.test(fn[0]), 'handleLaunchCinema 必须校验身份');
  assert.ok(/ABORTED/.test(fn[0]), '身份不匹配必须 ABORTED 作废任务');
});

// ===========================================================================
// P0-4：统一权威状态 + 写入队列 + 版本号防复活
// ===========================================================================
test('P0-4 契约：useWatchHistory 使用模块级共享桶（跨实例一致）', () => {
  const code = stripComments(SRC.hook);
  assert.ok(/sharedStores/.test(code), '必须有模块级 sharedStores');
  assert.ok(/getStore\s*\(/.test(code), '必须有 getStore');
  assert.ok(/subscribe\s*\(/.test(code), '必须有 subscribe 广播');
  assert.ok(/notify\s*\(/.test(code), '必须有 notify 广播');
});

test('P0-4 契约：写入队列按版本号丢弃过期写入（删除/清空不被复活）', () => {
  const code = stripComments(SRC.hook);
  assert.ok(/enqueuePersist\s*\(/.test(code), '必须有串行写入队列 enqueuePersist');
  // 版本号不匹配则丢弃
  assert.ok(
    /store\.version\s*!==\s*version[\s\S]{0,60}?return/.test(code),
    '过期写入必须因版本不匹配被丢弃'
  );
  // 删除/清空必须推进版本号
  assert.ok(/store\.version\s*\+=\s*1/.test(code), '写操作必须推进版本号');
});

test('P0-4 契约：加载完成前不覆盖已有写入（store.version === 0 才落盘）', () => {
  const code = stripComments(SRC.hook);
  assert.ok(
    /store\.version\s*===\s*0/.test(code),
    '加载时必须判断 store.version === 0 才采用磁盘数据，避免覆盖在途写入'
  );
});

test('P0-4 契约：迟到回调按 authEpoch 拒绝（A→B→A 不跨代污染）', () => {
  const code = stripComments(SRC.hook);
  assert.ok(/authEpochRef/.test(code), '必须有 authEpochRef 代际镜像');
  assert.ok(
    /authEpochRef\.current\s*!==\s*epochAtCreate/.test(code),
    '写回调必须校验 authEpoch 未变化'
  );
});

// ===========================================================================
// 测试依赖完整性：确保新测试可独立复跑
// ===========================================================================
test('依赖完整性：测试引用的源码与常量文件均存在', () => {
  const required = [
    'src/hooks/browser/watchHistoryLogic.js',
    'src/hooks/browser/useWatchHistory.js',
    'src/constants/browser/index.js',
    'src/app/browser/index.js',
    'src/app/cinema.js',
    'src/context/BrowserSessionContext.js',
    'src/app/browser/watch-history.js',
  ];
  required.forEach((rel) => {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `缺少依赖文件：${rel}`);
  });
});
// --- END OF FILE tests/security/p15_sourceContract.test.mjs ---
