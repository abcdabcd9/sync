// --- START OF FILE tests/security/p15_watchHistoryLogic.test.mjs ---
// ============================================================================
// 视频观看历史 V1 — 纯逻辑契约测试
//
// 覆盖 src/hooks/browser/watchHistoryLogic.js 的全部纯函数：
//   P15-WATCH-01 buildWatchHistoryKey / secondsToMillis / millisToSeconds
//   P15-WATCH-02 sanitizeMediaUrl：剥离敏感参数、保留 path 与非敏感参数
//   P15-WATCH-03 buildMediaKey / parseEpisodeTriple：分层身份 + 第 8/9 集区分
//   P15-WATCH-04 buildWatchRecord：标题回退链、无身份返回 null
//   P15-WATCH-05 normalizeWatchList：去重保留最新、倒序、截断上限
//   P15-WATCH-06 upsertWatchRecord：重复观看更新同一条、复用 id、补齐字段
//   P15-WATCH-07 shouldResume / resolveResumeSeconds / isNearEnd：续播判定
//   P15-WATCH-08 decideResume：严格决策顺序，绝不盲选第一个候选
//   P15-WATCH-09 isPendingResumeMatch：Case B 身份匹配
//   P15-WATCH-10 formatWatchTime / formatDuration / computeProgressRatio
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 直接 import 真实源码（纯函数、无原生依赖）。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// 🧩 P1.x 重构后：`src/constants/browser/index.js` 已迁移为 `index.ts`，
//    但生产源码 watchHistoryLogic.js 仍以显式 `index.js` 导入（Node ESM 不做
//    扩展名回退）。因此沙箱按「.ts 优先、.js 兜底」解析真实源文件；
//    源为 .ts 时用项目自带 TypeScript 编译器擦除类型后以 .js 落盘
//    （Node 24 只对 .ts 做原生类型擦除，对 .js 不做，故必须显式转译）。
const REWRITE_RULES = [];

function resolveSrc(rel) {
  const tsRel = rel.replace(/\.js$/, '.ts');
  return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
}

const ts = createRequire(import.meta.url)('typescript');
const stripTypes = (code, fileName) =>
  ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
    fileName,
  }).outputText;

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-watch-'));
  const files = [
    'src/hooks/browser/watchHistoryLogic.js',
    'src/constants/browser/index.js',
  ];
  files.forEach((rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let code = fs.readFileSync(src, 'utf8');
    // 源为 .ts 时先擦除类型，再以 .js 落盘（Node 24 不对 .js 做类型擦除）
    if (actual.endsWith('.ts')) code = stripTypes(code, path.basename(actual));
    REWRITE_RULES.filter((r) => r.rel === rel).forEach((r) => {
      if (!code.includes(r.from)) {
        throw new Error(`sandbox rewrite anchor missing in ${rel}: ${r.from}`);
      }
      code = code.split(r.from).join(r.to);
    });
    fs.writeFileSync(dst, code);
  });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

// 沙箱内 console.log 被重定向到 stderr，结果 JSON 以哨兵行写入 stderr，
// 避免任何意外 stdout 输出污染解析。
const RESULT_TAG = '__P15_RESULT__';

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  const raw = child.stderr || '';
  const idx = raw.indexOf(RESULT_TAG);
  if (idx < 0) {
    throw new Error(`sandbox produced no result marker:\nstdout=${child.stdout}\nstderr=${raw}`);
  }
  const jsonText = raw.slice(idx + RESULT_TAG.length).trim();
  return JSON.parse(jsonText);
}

const MOD = `await import('./src/hooks/browser/watchHistoryLogic.js')`;

// ---------------------------------------------------------------------------
// P15-WATCH-01：key 构造与秒/毫秒换算
// ---------------------------------------------------------------------------
test('P15-WATCH-01 buildWatchHistoryKey 仅对字符串 userId 生成 key；秒毫秒换算安全', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const r = {
  keyOk: M.buildWatchHistoryKey('user-123'),
  keyNull: M.buildWatchHistoryKey(null),
  keyEmpty: M.buildWatchHistoryKey(''),
  keyNum: M.buildWatchHistoryKey(123),
  prefix: M.WATCH_HISTORY_KEY_PREFIX,
  s2m: M.secondsToMillis(12.7),
  s2mNeg: M.secondsToMillis(-5),
  s2mNaN: M.secondsToMillis('abc'),
  m2s: M.millisToSeconds(12700),
  m2sZero: M.millisToSeconds(0),
  m2sNeg: M.millisToSeconds(-100),
};
console.log('__P15_RESULT__'+JSON.stringify(r));
`);
    assert.equal(out.keyOk, '@sync_watch_history_v1_user-123');
    assert.equal(out.keyNull, null);
    assert.equal(out.keyEmpty, null);
    assert.equal(out.keyNum, null);
    assert.equal(out.prefix, '@sync_watch_history_v1_');
    assert.equal(out.s2m, 12700);
    assert.equal(out.s2mNeg, 0);
    assert.equal(out.s2mNaN, 0);
    assert.equal(out.m2s, 12.7);
    assert.equal(out.m2sZero, 0);
    assert.equal(out.m2sNeg, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-02：URL 脱敏
// ---------------------------------------------------------------------------
test('P15-WATCH-02 sanitizeMediaUrl 剥离敏感参数、保留 path 与非敏感参数', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const r = {
  token: M.sanitizeMediaUrl('https://cdn.x.com/v/a.m3u8?token=SECRET&id=42'),
  sign: M.sanitizeMediaUrl('https://cdn.x.com/v/a.m3u8?sign=abc&expires=999&ep=8'),
  amz: M.sanitizeMediaUrl('https://s3.x.com/v.mp4?X-Amz-Signature=zzz&X-Amz-Credential=yyy'),
  noQuery: M.sanitizeMediaUrl('https://cdn.x.com/v/a.m3u8'),
  hash: M.sanitizeMediaUrl('https://cdn.x.com/v/a.m3u8#t=10'),
  about: M.sanitizeMediaUrl('about:blank'),
  empty: M.sanitizeMediaUrl(''),
  nonString: M.sanitizeMediaUrl(null),
  pageEq: M.sanitizePageUrl('https://site.com/play/1-2-3.html?token=x&from=home'),
};
console.log('__P15_RESULT__'+JSON.stringify(r));
`);
    assert.equal(out.token, 'https://cdn.x.com/v/a.m3u8?id=42');
    assert.equal(out.sign, 'https://cdn.x.com/v/a.m3u8?ep=8');
    assert.equal(out.amz, 'https://s3.x.com/v.mp4');
    assert.equal(out.noQuery, 'https://cdn.x.com/v/a.m3u8');
    assert.equal(out.hash, 'https://cdn.x.com/v/a.m3u8#t=10');
    assert.equal(out.about, 'about:blank');
    assert.equal(out.empty, '');
    assert.equal(out.nonString, '');
    assert.equal(out.pageEq, 'https://site.com/play/1-2-3.html?from=home');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-03：媒体身份分层 + 第 8/9 集区分
// ---------------------------------------------------------------------------
test('P15-WATCH-03 buildMediaKey 分层身份；第 8 集与第 9 集 mediaKey 不同', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const ep8 = M.parseEpisodeTriple('https://site.com/play/392563-36-700596.html');
const ep9 = M.parseEpisodeTriple('https://site.com/play/392563-36-700597.html');
const r = {
  ep8,
  ep9,
  // ① 剧集三元组优先：显式传入 episode 时使用 ep: 前缀
  tripleKey8: M.buildMediaKey({ pageUrl: 'https://site.com/play/392563-36-700596.html', episode: ep8 }),
  tripleKey9: M.buildMediaKey({ pageUrl: 'https://site.com/play/392563-36-700597.html', episode: ep9 }),
  // ② 无 episode 时回退到脱敏媒体 URL
  mediaKey: M.buildMediaKey({ mediaUrl: 'https://cdn.x.com/v/a.m3u8?token=1' }),
  mediaKeySigned: M.buildMediaKey({ mediaUrl: 'https://cdn.x.com/v/a.m3u8?token=2' }),
  // ③ 无媒体 URL 时回退到脱敏播放页 URL（第 8/9 集仍可区分）
  pageKey8: M.buildMediaKey({ pageUrl: 'https://site.com/play/392563-36-700596.html' }),
  pageKey9: M.buildMediaKey({ pageUrl: 'https://site.com/play/392563-36-700597.html' }),
  pageKey: M.buildMediaKey({ pageUrl: 'https://site.com/watch?id=9' }),
  empty: M.buildMediaKey({}),
  badTriple: M.parseEpisodeTriple('https://site.com/watch?id=9'),
  pathOnly: M.parseEpisodeTriple('/play/1-2-3.html'),
};
console.log('__P15_RESULT__'+JSON.stringify(r));
`);
    assert.deepEqual(out.ep8, { vodId: '392563', sourceId: '36', episodeId: 700596 });
    assert.deepEqual(out.ep9, { vodId: '392563', sourceId: '36', episodeId: 700597 });
    // 🛡️ P0-3：mediaKey 带站点前缀，避免跨站同集号碰撞
    assert.equal(out.tripleKey8, 'ep:site.com:392563:36:700596');
    assert.equal(out.tripleKey9, 'ep:site.com:392563:36:700597');
    assert.notEqual(out.tripleKey8, out.tripleKey9);
    // 同一媒体 URL 不同签名 → 脱敏后身份一致（不产生重复记录）
    assert.equal(out.mediaKey, 'm:https://cdn.x.com/v/a.m3u8');
    assert.equal(out.mediaKey, out.mediaKeySigned);
    // 无媒体 URL 时按播放页 URL 区分集数
    assert.equal(out.pageKey8, 'p:https://site.com/play/392563-36-700596.html');
    assert.equal(out.pageKey9, 'p:https://site.com/play/392563-36-700597.html');
    assert.notEqual(out.pageKey8, out.pageKey9);
    assert.equal(out.pageKey, 'p:https://site.com/watch?id=9');
    assert.equal(out.empty, '');
    assert.equal(out.badTriple, null);
    assert.deepEqual(out.pathOnly, { vodId: '1', sourceId: '2', episodeId: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-04：记录构造与标题回退链
// ---------------------------------------------------------------------------
test('P15-WATCH-04 buildWatchRecord 标题回退链；无身份返回 null', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
// ⚠️ 媒体必须与播放页同站（cdn.site.com 与 site.com 同属可注册主域），
//    否则会被「跨站媒体不继承剧集身份」的安全规则降级为 m: 身份。
//    本用例关注标题回退链，故使用同站 CDN 以保留 ep: 身份。
const base = {
  mediaUrl: 'https://cdn.site.com/v/a.m3u8?token=SECRET',
  pageUrl: 'https://site.com/play/392563-36-700596.html',
  positionMillis: 125000,
  durationMillis: 3600000,
  lastWatchedAt: 1700000000000,
};
const explicit = M.buildWatchRecord({ ...base, title: '  我的电影  ' });
const epLabel = M.buildWatchRecord({ ...base, title: '', episodeLabel: '第8集' });
const domainOnly = M.buildWatchRecord({ ...base, title: '', episodeLabel: '' });
const none = M.buildWatchRecord({});
const noIdentity = M.buildWatchRecord({ title: 'x' });
console.log('__P15_RESULT__'+JSON.stringify({ explicit, epLabel, domainOnly, none, noIdentity }));
`);
    assert.equal(out.explicit.title, '我的电影');
    // 🛡️ P0-3：mediaKey 带站点前缀
    assert.equal(out.explicit.mediaKey, 'ep:site.com:392563:36:700596');
    assert.equal(out.explicit.domain, 'site.com');
    assert.equal(out.explicit.positionMillis, 125000);
    assert.equal(out.explicit.durationMillis, 3600000);
    assert.equal(out.explicit.completed, false);
    assert.equal(out.explicit.lastWatchedAt, 1700000000000);
    // 媒体 URL 已脱敏（无 token）
    assert.equal(out.explicit.mediaUrl, 'https://cdn.site.com/v/a.m3u8');
    assert.equal(out.epLabel.title, '第8集');
    assert.equal(out.domainOnly.title, 'site.com');
    assert.equal(out.none, null);
    assert.equal(out.noIdentity, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-05：列表归一化（去重 / 倒序 / 截断）
// ---------------------------------------------------------------------------
test('P15-WATCH-05 normalizeWatchList 去重保留最新、按时间倒序、截断上限', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const list = [
  { mediaKey: 'm:a', lastWatchedAt: 100, positionMillis: 1000 },
  { mediaKey: 'm:b', lastWatchedAt: 300, positionMillis: 2000 },
  { mediaKey: 'm:a', lastWatchedAt: 500, positionMillis: 9000 },
  { mediaKey: '', lastWatchedAt: 999 },
  null,
  'garbage',
];
const norm = M.normalizeWatchList(list, 100);
const limited = M.normalizeWatchList(list, 1);
const notArray = M.normalizeWatchList('nope');
console.log('__P15_RESULT__'+JSON.stringify({
  keys: norm.map((x) => x.mediaKey),
  aPos: norm.find((x) => x.mediaKey === 'm:a').positionMillis,
  limitedLen: limited.length,
  limitedKey: limited[0] && limited[0].mediaKey,
  notArrayLen: notArray.length,
}));
`);
    // m:a 保留最新（500 / 9000），m:b 次之；空 key 与脏数据被过滤
    assert.deepEqual(out.keys, ['m:a', 'm:b']);
    assert.equal(out.aPos, 9000);
    assert.equal(out.limitedLen, 1);
    assert.equal(out.limitedKey, 'm:a');
    assert.equal(out.notArrayLen, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-06：upsert 更新同一条
// ---------------------------------------------------------------------------
test('P15-WATCH-06 upsertWatchRecord 重复观看更新同一条、复用 id、补齐字段', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const prev = [
  { id: 'keep-me', mediaKey: 'm:a', title: '旧标题', pageUrl: 'https://site.com/p', episodeLabel: '第8集', positionMillis: 1000, lastWatchedAt: 100 },
  { id: 'other', mediaKey: 'm:b', title: 'B', positionMillis: 500, lastWatchedAt: 200 },
];
const rec = { id: 'new-id', mediaKey: 'm:a', title: '', pageUrl: '', episodeLabel: '', positionMillis: 5000, lastWatchedAt: 900 };
const merged = M.upsertWatchRecord(prev, rec, 100);
const a = merged.find((x) => x.mediaKey === 'm:a');
console.log('__P15_RESULT__'+JSON.stringify({
  len: merged.length,
  firstKey: merged[0].mediaKey,
  aId: a.id,
  aTitle: a.title,
  aPage: a.pageUrl,
  aEp: a.episodeLabel,
  aPos: a.positionMillis,
  emptyRec: M.upsertWatchRecord(prev, null),
}));
`);
    assert.equal(out.len, 2);
    assert.equal(out.firstKey, 'm:a'); // 最新时间排最前
    assert.equal(out.aId, 'keep-me'); // 复用旧 id
    assert.equal(out.aTitle, '旧标题'); // 新记录空标题 → 用旧补齐
    assert.equal(out.aPage, 'https://site.com/p');
    assert.equal(out.aEp, '第8集');
    assert.equal(out.aPos, 5000); // 进度被新数据覆盖
    assert.equal(out.emptyRec.length, 2); // 空记录原样返回
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-07：续播判定
// ---------------------------------------------------------------------------
test('P15-WATCH-07 shouldResume / resolveResumeSeconds / isNearEnd 边界', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const r = {
  normal: M.shouldResume({ positionMillis: 60000, durationMillis: 3600000, completed: false }),
  completed: M.shouldResume({ positionMillis: 60000, durationMillis: 3600000, completed: true }),
  tooShort: M.shouldResume({ positionMillis: 3000, durationMillis: 3600000 }),
  nearEnd: M.shouldResume({ positionMillis: 3590000, durationMillis: 3600000 }),
  noDur: M.shouldResume({ positionMillis: 60000, durationMillis: 0 }),
  nullRec: M.shouldResume(null),
  secNormal: M.resolveResumeSeconds({ positionMillis: 60000, durationMillis: 3600000 }),
  secCompleted: M.resolveResumeSeconds({ positionMillis: 60000, durationMillis: 3600000, completed: true }),
  nearEndTrue: M.isNearEnd(3590, 3600),
  nearEndFalse: M.isNearEnd(100, 3600),
  nearEndNoDur: M.isNearEnd(10, 0),
};
console.log('__P15_RESULT__'+JSON.stringify(r));
`);
    assert.equal(out.normal, true);
    assert.equal(out.completed, false);
    assert.equal(out.tooShort, false);
    assert.equal(out.nearEnd, false);
    assert.equal(out.noDur, true); // 时长未知但进度足够 → 仍可续播
    assert.equal(out.nullRec, false);
    assert.equal(out.secNormal, 60);
    assert.equal(out.secCompleted, 0);
    assert.equal(out.nearEndTrue, true);
    assert.equal(out.nearEndFalse, false);
    assert.equal(out.nearEndNoDur, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-08：续播决策状态机（核心：绝不盲选第一个候选）
// ---------------------------------------------------------------------------
test('P15-WATCH-08 decideResume 严格决策顺序，身份不匹配不播放', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const rec = {
  mediaKey: 'ep:1:2:8',
  mediaUrl: 'https://cdn.x.com/v/8.m3u8',
  pageUrl: 'https://site.com/play/1-2-8.html',
  positionMillis: 120000,
  durationMillis: 3600000,
  completed: false,
};
const A = M.RESUME_ACTION;
const r = {
  // ① 无效记录
  invalid: M.decideResume(null, []).action,
  noKey: M.decideResume({ pageUrl: 'https://site.com/x' }, []).action,
  // ② 候选身份匹配（mediaKey）
  matchedByKey: M.decideResume(rec, [{ url: 'https://cdn.x.com/new.m3u8', mediaKey: 'ep:1:2:8' }]),
  // ② 候选身份匹配（脱敏 URL）
  matchedByUrl: M.decideResume(rec, [{ url: 'https://cdn.x.com/v/8.m3u8?token=zzz' }]),
  // ② 候选不匹配 → 🛡️ P0-2：优先回原始播放页（不盲信脱敏直链），绝不播候选
  noMatch: M.decideResume(rec, [{ url: 'https://cdn.x.com/v/9.m3u8', mediaKey: 'ep:1:2:9' }]),
  // ③ 无候选但有直链 + 有播放页 → 仍优先回播放页（P0-2）
  savedMediaWithPage: M.decideResume({ ...rec, mediaUrl: 'https://cdn.x.com/v/8.m3u8' }, []),
  // ③b 无候选、无播放页、仅有直链 → 未验证直连（unverified=true）
  savedMediaOnly: M.decideResume({ mediaKey: 'ep:1:2:8', mediaUrl: 'https://cdn.x.com/v/8.m3u8', positionMillis: 120000, durationMillis: 3600000 }, []),
  // ④ 无直链但有播放页
  pageOnly: M.decideResume({ mediaKey: 'ep:1:2:8', pageUrl: 'https://site.com/play/1-2-8.html', positionMillis: 120000, durationMillis: 3600000 }, []),
  // ⑤ 全无
  nothing: M.decideResume({ mediaKey: 'ep:1:2:8' }, []).action,
  // 从头播（进度过短）：🛡️ P0-2 有播放页 → 仍优先回播放页（不因进度短就直连）
  fromStart: M.decideResume({ ...rec, positionMillis: 1000 }, []).action,
  // 从头播 + 无播放页 + 仅直链 → PLAY_FROM_START（未验证直连）
  fromStartMediaOnly: M.decideResume({ mediaKey: 'ep:1:2:8', mediaUrl: 'https://cdn.x.com/v/8.m3u8', positionMillis: 1000, durationMillis: 3600000 }, []).action,
};
console.log('__P15_RESULT__'+JSON.stringify({ A, r }));
`);
    const A = out.A;
    assert.equal(out.r.invalid, A.UNAVAILABLE);
    assert.equal(out.r.noKey, A.UNAVAILABLE);
    assert.equal(out.r.matchedByKey.action, A.PLAY_AND_SEEK);
    assert.equal(out.r.matchedByKey.url, 'https://cdn.x.com/new.m3u8');
    assert.equal(out.r.matchedByKey.seekSeconds, 120);
    assert.equal(out.r.matchedByUrl.action, A.PLAY_AND_SEEK);
    // 🛡️ P0-2 关键：候选不匹配时，绝不返回候选 URL；有播放页则优先回播放页
    assert.equal(out.r.noMatch.action, A.NAVIGATE_TO_PAGE);
    assert.equal(out.r.noMatch.url, 'https://site.com/play/1-2-8.html');
    assert.equal(out.r.noMatch.reason, 'need_renavigate');
    // 有播放页时，即使有直链也优先回播放页（脱敏直链不保证可用）
    assert.equal(out.r.savedMediaWithPage.action, A.NAVIGATE_TO_PAGE);
    // 无播放页、仅有直链 → 未验证直连，必须标记 unverified
    assert.equal(out.r.savedMediaOnly.action, A.PLAY_AND_SEEK);
    assert.equal(out.r.savedMediaOnly.unverified, true);
    assert.equal(out.r.savedMediaOnly.reason, 'unverified_saved_media_url');
    assert.equal(out.r.pageOnly.action, A.NAVIGATE_TO_PAGE);
    assert.equal(out.r.pageOnly.url, 'https://site.com/play/1-2-8.html');
    assert.equal(out.r.nothing, A.UNAVAILABLE);
    // 有播放页 → 回播放页（即使进度过短）
    assert.equal(out.r.fromStart, A.NAVIGATE_TO_PAGE);
    // 无播放页 + 仅直链 + 进度过短 → 从头播
    assert.equal(out.r.fromStartMediaOnly, A.PLAY_FROM_START);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-09：Case B 待续播身份匹配
// ---------------------------------------------------------------------------
test('P15-WATCH-09 isPendingResumeMatch 仅在同身份时命中', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
const pending = {
  mediaKey: 'ep:1:2:8',
  pageUrl: 'https://site.com/play/1-2-8.html',
  mediaUrl: 'https://cdn.x.com/v/8.m3u8',
  seekSeconds: 120,
};
const r = {
  byKey: M.isPendingResumeMatch(pending, { mediaKey: 'ep:1:2:8' }),
  // 同页 + 同站媒体 → 命中（换 CDN 子域仍属同站）
  byPage: M.isPendingResumeMatch(pending, { pageUrl: 'https://site.com/play/1-2-8.html?token=x', mediaUrl: 'https://cdn.site.com/v/8.m3u8' }),
  // 🛡️ 仅凭 pageUrl（无媒体证明）→ 不得命中（同页广告防护）
  byPageOnly: M.isPendingResumeMatch(pending, { pageUrl: 'https://site.com/play/1-2-8.html?token=x' }),
  // 🛡️ 同页 + 跨站媒体（广告）→ 不得命中
  byPageCrossSite: M.isPendingResumeMatch(pending, { pageUrl: 'https://site.com/play/1-2-8.html', mediaUrl: 'https://ads.tracker.com/ad.m3u8' }),
  byMedia: M.isPendingResumeMatch(pending, { mediaUrl: 'https://cdn.x.com/v/8.m3u8?sign=y' }),
  wrongEp: M.isPendingResumeMatch(pending, { mediaKey: 'ep:1:2:9', pageUrl: 'https://site.com/play/1-2-9.html', mediaUrl: 'https://cdn.x.com/v/9.m3u8' }),
  noPending: M.isPendingResumeMatch(null, { mediaKey: 'ep:1:2:8' }),
  noFound: M.isPendingResumeMatch(pending, null),
  emptyPending: M.isPendingResumeMatch({}, { mediaKey: 'ep:1:2:8' }),
};
console.log('__P15_RESULT__'+JSON.stringify(r));
`);
    assert.equal(out.byKey, true);
    assert.equal(out.byPage, true);
    assert.equal(out.byPageOnly, false, '仅凭 pageUrl 不得命中（同页广告防护）');
    assert.equal(out.byPageCrossSite, false, '同页跨站媒体不得命中');
    assert.equal(out.byMedia, true);
    assert.equal(out.wrongEp, false);
    assert.equal(out.noPending, false);
    assert.equal(out.noFound, false);
    assert.equal(out.emptyPending, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P15-WATCH-10：展示格式化
// ---------------------------------------------------------------------------
test('P15-WATCH-10 formatWatchTime / formatDuration / computeProgressRatio', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const M = ${MOD};
// 用固定 UTC 时间戳，按本地时区格式化（测试机时区无关：只校验格式与可解析性）
const ts = 1700000000000;
const formatted = M.formatWatchTime(ts);
const r = {
  formatted,
  matchesFormat: /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(formatted),
  zero: M.formatWatchTime(0),
  neg: M.formatWatchTime(-1),
  nan: M.formatWatchTime('abc'),
  dur0: M.formatDuration(0),
  durSec: M.formatDuration(65000),
  durHour: M.formatDuration(3725000),
  ratio: M.computeProgressRatio(1800000, 3600000),
  ratioZeroDur: M.computeProgressRatio(1000, 0),
  ratioOver: M.computeProgressRatio(4000000, 3600000),
};
console.log('__P15_RESULT__'+JSON.stringify(r));
`);
    assert.equal(out.matchesFormat, true);
    assert.equal(out.zero, '');
    assert.equal(out.neg, '');
    assert.equal(out.nan, '');
    assert.equal(out.dur0, '00:00:00');
    assert.equal(out.durSec, '00:01:05');
    assert.equal(out.durHour, '01:02:05');
    assert.equal(out.ratio, 0.5);
    assert.equal(out.ratioZeroDur, 0);
    assert.equal(out.ratioOver, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p15_watchHistoryLogic.test.mjs ---
