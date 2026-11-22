// ============================================================================
// P1.2 R1 — 常量模块 TS 迁移行为等价测试
//
// 目的：独立验证 6 个从 .js 迁移到 .ts 的常量模块，其「运行时导出值」与迁移前
//       的原始 JS 实现逐字段完全一致（不是拿 TS 去对照手写期望，而是把迁移前
//       的原始值作为 before 基线，与当前 .ts 模块的 after 实际值做深度比较）。
//
// 覆盖：
//   - colors:   SYSTEM_COLORS.light/dark 全键值 + getPalette(true/false)
//   - theme:    SIZES + TYPOGRAPHY 全字段
//   - motion:   DURATION/SPRING/EASING/SCALE/STAGGER 长度+顺序+值
//   - settings: 3 组选项全结构 + labelOf 命中/未知/空数组/默认/自定义 fallback
//   - security: STORAGE_KEYS/TTL/POLICY/NOTES 全等
//   - browser:  URL 安全/广告域名/媒体扩展名/解析失败/无效 userId/跨账号 key/
//               媒体去重稳定排序/旧缓存 key 不变/时间格式边界
//
// 运行：node --test tests/security/p12r1_constantsEquivalence.test.mjs
// 说明：Node 24 原生剥离 .ts 类型，可直接 import .ts 模块。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const colorsMod = await import(path.join(repoRoot, 'src/constants/colors.ts'));
const themeMod = await import(path.join(repoRoot, 'src/constants/theme.ts'));
const motionMod = await import(path.join(repoRoot, 'src/constants/motion.ts'));
const settingsMod = await import(path.join(repoRoot, 'src/constants/settings.ts'));
const securityMod = await import(path.join(repoRoot, 'src/constants/security.ts'));
const browserMod = await import(path.join(repoRoot, 'src/constants/browser/index.ts'));

// ---------------------------------------------------------------------------
// 迁移前原始值（before 基线，逐字取自旧 .js 源码）
// ---------------------------------------------------------------------------
const BEFORE = {
  colors: {
    light: {
      background: '#F2F2F7',
      card: 'rgba(255, 255, 255, 0.75)',
      cardBorder: 'rgba(255, 255, 255, 0.95)',
      textPrimary: '#000000',
      textSecondary: 'rgba(60, 60, 67, 0.6)',
      primary: '#FF2D55',
      success: '#FF2D55',
      separator: 'rgba(60, 60, 67, 0.1)',
      dockShadow: '#000000',
      dockBorder: 'rgba(255,255,255,0.7)',
      dockBackground: 'rgba(255,255,255,0.85)',
      iconBackground: '#8E8E93',
      chatBorder: 'rgba(0,0,0,0.05)',
      checkRing: 'rgba(60, 60, 67, 0.25)',
      checkBg: 'rgba(255, 45, 85, 0.85)',
    },
    dark: {
      background: '#000000',
      card: 'rgba(28, 28, 30, 0.65)',
      cardBorder: 'rgba(255, 255, 255, 0.12)',
      textPrimary: '#FFFFFF',
      textSecondary: 'rgba(235, 235, 245, 0.6)',
      primary: '#FF375F',
      success: '#FF375F',
      separator: 'rgba(84, 84, 88, 0.3)',
      dockShadow: '#000000',
      dockBorder: 'rgba(255,255,255,0.15)',
      dockBackground: 'rgba(28,28,30,0.85)',
      iconBackground: '#8E8E93',
      chatBorder: 'rgba(255,255,255,0.1)',
      checkRing: 'rgba(235, 235, 245, 0.25)',
      checkBg: 'rgba(255, 55, 95, 0.85)',
    },
  },
  theme: {
    SIZES: { radiusCard: 24, radiusList: 16, padding: 20 },
    TYPOGRAPHY: { largeTitle: { fontSize: 26, fontWeight: '700', letterSpacing: 0.5 } },
  },
  motion: {
    DURATION: { instant: 120, fast: 200, normal: 280, slow: 400, skeleton: 1200 },
    SPRING: {
      default: { damping: 20, stiffness: 220, mass: 0.9 },
      bouncy: { damping: 16, stiffness: 180, mass: 1 },
      gentle: { damping: 24, stiffness: 160, mass: 1 },
      snap: { damping: 18, stiffness: 260, mass: 0.8 },
    },
    EASING: {
      standard: [0.25, 0.1, 0.25, 1],
      decelerate: [0.0, 0.0, 0.2, 1],
      accelerate: [0.4, 0.0, 1, 1],
    },
    SCALE: { pressIn: 0.97, pressOut: 1, cardEnter: 0.96 },
    STAGGER: { list: 40, grid: 30 },
  },
  settings: {
    MOMENTS_VISIBILITY: [
      { key: 'all', label: '所有人', desc: '任何 Sync 用户都能看到你的朋友圈' },
      { key: 'friends', label: '仅好友', desc: '只有互为好友的人可以看到' },
      { key: 'self', label: '仅自己', desc: '朋友圈只有你自己可见' },
    ],
    CHAT_BACKGROUNDS: [
      { key: 'default', label: '跟随主题', desc: '随外观模式自动切换深浅' },
      { key: 'light', label: '浅色', desc: '始终使用浅色聊天背景' },
      { key: 'dark', label: '深色', desc: '始终使用深色聊天背景' },
    ],
    LANGUAGES: [
      { key: 'zh', label: '简体中文', desc: '默认语言' },
      { key: 'en', label: 'English', desc: 'English (US)' },
    ],
  },
  security: {
    STORAGE_KEYS: { AUTH_SESSION: 'sb-auth-token', THEME_MODE: 'themeMode', HEALTH_DATA: 'healthData' },
    MEDIA_SIGNED_URL_TTL_SECONDS: 60 * 60 * 24 * 7,
    DEVICE_SECURITY_POLICY: {
      privateMediaOnly: true,
      clearSessionOnSignOut: true,
      wipeLocalDataOnDelete: true,
      endToEndEncryption: false,
      minTlsVersion: 'TLS 1.2',
    },
    DEVICE_DATA_PROTECTION_NOTES: [
      { title: '数据存储位置', body: '你的账号资料、健康记录与聊天内容保存在云端服务器；登录会话与偏好设置保存在本机应用沙盒内，其他应用无法读取。' },
      { title: '传输加密', body: '客户端与服务器之间的所有通信均通过 HTTPS（TLS 1.2 及以上）加密传输，防止数据在公共网络中被窃听或篡改。' },
      { title: '私密媒体保护', body: '聊天中的图片、视频与语音存放在私有存储桶中，仅向你与对话方签发有效期 7 天的临时访问链接，链接过期后自动失效。' },
      { title: '本地数据清除', body: '退出登录会清除本机会话；注销账号会额外清除当前账号在本机的缓存数据（如聊天收藏与会话偏好），其他账号的聊天记录与全局偏好不受影响。' },
      { title: '设备安全建议', body: '建议为设备设置锁屏密码或生物识别，不要在越狱或 Root 的设备上登录本应用，公共设备使用后请及时退出登录。' },
    ],
  },
};

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------
test('P12R1-COLORS SYSTEM_COLORS 浅/深两套全键值等价', () => {
  assert.deepEqual(colorsMod.SYSTEM_COLORS.light, BEFORE.colors.light);
  assert.deepEqual(colorsMod.SYSTEM_COLORS.dark, BEFORE.colors.dark);
  // 键集合完全一致（无新增/缺失）
  assert.deepEqual(Object.keys(colorsMod.SYSTEM_COLORS.light).sort(), Object.keys(BEFORE.colors.light).sort());
  assert.deepEqual(Object.keys(colorsMod.SYSTEM_COLORS.dark).sort(), Object.keys(BEFORE.colors.dark).sort());
});

test('P12R1-COLORS getPalette(true/false) 返回对应调色板', () => {
  assert.equal(colorsMod.getPalette(true), colorsMod.SYSTEM_COLORS.dark);
  assert.equal(colorsMod.getPalette(false), colorsMod.SYSTEM_COLORS.light);
  assert.deepEqual(colorsMod.getPalette(true), BEFORE.colors.dark);
  assert.deepEqual(colorsMod.getPalette(false), BEFORE.colors.light);
});

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
test('P12R1-THEME SIZES + TYPOGRAPHY 全字段等价', () => {
  assert.deepEqual(themeMod.SIZES, BEFORE.theme.SIZES);
  assert.deepEqual(themeMod.TYPOGRAPHY, BEFORE.theme.TYPOGRAPHY);
});

// ---------------------------------------------------------------------------
// motion
// ---------------------------------------------------------------------------
test('P12R1-MOTION DURATION/SPRING/SCALE/STAGGER 等价', () => {
  assert.deepEqual(motionMod.DURATION, BEFORE.motion.DURATION);
  assert.deepEqual(motionMod.SPRING, BEFORE.motion.SPRING);
  assert.deepEqual(motionMod.SCALE, BEFORE.motion.SCALE);
  assert.deepEqual(motionMod.STAGGER, BEFORE.motion.STAGGER);
});

test('P12R1-MOTION EASING 长度/顺序/值等价', () => {
  assert.deepEqual(motionMod.EASING, BEFORE.motion.EASING);
  assert.equal(motionMod.EASING.standard.length, 4);
  assert.equal(motionMod.EASING.decelerate.length, 4);
  assert.equal(motionMod.EASING.accelerate.length, 4);
  assert.deepEqual(Object.keys(motionMod.EASING), ['standard', 'decelerate', 'accelerate']);
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
test('P12R1-SETTINGS 三组选项全结构等价', () => {
  assert.deepEqual(settingsMod.MOMENTS_VISIBILITY, BEFORE.settings.MOMENTS_VISIBILITY);
  assert.deepEqual(settingsMod.CHAT_BACKGROUNDS, BEFORE.settings.CHAT_BACKGROUNDS);
  assert.deepEqual(settingsMod.LANGUAGES, BEFORE.settings.LANGUAGES);
});

test('P12R1-SETTINGS labelOf 命中/未知/空数组/默认与自定义 fallback', () => {
  // 命中
  assert.equal(settingsMod.labelOf(settingsMod.MOMENTS_VISIBILITY, 'friends'), '仅好友');
  assert.equal(settingsMod.labelOf(settingsMod.LANGUAGES, 'en'), 'English');
  // 未知 key → 默认 fallback ''
  assert.equal(settingsMod.labelOf(settingsMod.MOMENTS_VISIBILITY, 'nope'), '');
  // 未知 key → 自定义 fallback
  assert.equal(settingsMod.labelOf(settingsMod.CHAT_BACKGROUNDS, 'nope', '未知'), '未知');
  // 空数组 → fallback
  assert.equal(settingsMod.labelOf([], 'all'), '');
  assert.equal(settingsMod.labelOf([], 'all', 'X'), 'X');
  // 缺字段容错：find 命中但 label 为空串时返回空串（?? 不触发）
  assert.equal(settingsMod.labelOf([{ key: 'k', label: '', desc: '' }], 'k', 'FB'), '');
});

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------
test('P12R1-SECURITY STORAGE_KEYS/TTL/POLICY/NOTES 全等', () => {
  assert.deepEqual(securityMod.STORAGE_KEYS, BEFORE.security.STORAGE_KEYS);
  assert.equal(securityMod.MEDIA_SIGNED_URL_TTL_SECONDS, BEFORE.security.MEDIA_SIGNED_URL_TTL_SECONDS);
  assert.equal(securityMod.MEDIA_SIGNED_URL_TTL_SECONDS, 604800);
  assert.deepEqual(securityMod.DEVICE_SECURITY_POLICY, BEFORE.security.DEVICE_SECURITY_POLICY);
  assert.deepEqual(securityMod.DEVICE_DATA_PROTECTION_NOTES, BEFORE.security.DEVICE_DATA_PROTECTION_NOTES);
  assert.equal(securityMod.DEVICE_DATA_PROTECTION_NOTES.length, 5);
});

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------
test('P12R1-BROWSER isSafeUrl 仅放行 https/about', () => {
  const { isSafeUrl } = browserMod;
  assert.equal(isSafeUrl('https://example.com/a'), true);
  assert.equal(isSafeUrl('HTTPS://EXAMPLE.COM/a'), true);
  assert.equal(isSafeUrl('about:blank'), true);
  assert.equal(isSafeUrl('http://example.com/a'), false);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('data:text/html,<script>'), false);
  assert.equal(isSafeUrl('file:///etc/passwd'), false);
  assert.equal(isSafeUrl(''), false);
  assert.equal(isSafeUrl(null), false);
  assert.equal(isSafeUrl(123), false);
  assert.equal(isSafeUrl(undefined), false);
});

test('P12R1-BROWSER isAdUrl 命中主机名、不误杀 path/query、解析失败兜底', () => {
  const { isAdUrl } = browserMod;
  assert.equal(isAdUrl('https://popads.net/x.js'), true);
  assert.equal(isAdUrl('https://ad.doubleclick.net/pixel'), true);
  assert.equal(isAdUrl('https://www.casino-online.com/'), true);
  assert.equal(isAdUrl('https://www.kkys11.com/play/1-2-3.html'), false);
  // path/query 含关键词但主机名干净 → 不误杀
  assert.equal(isAdUrl('https://cdn.example.com/casino/movie.mp4'), false);
  assert.equal(isAdUrl('https://cdn.example.com/v.mp4?ref=popads'), false);
  // 解析失败按字符串兜底
  assert.equal(isAdUrl('not-a-url'), false);
  assert.equal(isAdUrl('popads.net'), true);
  assert.equal(isAdUrl(''), false);
  assert.equal(isAdUrl(null), false);
});

test('P12R1-BROWSER getMediaExt 扩展名识别与 query/hash 边界', () => {
  const { getMediaExt } = browserMod;
  assert.equal(getMediaExt('https://x/a.m3u8'), 'm3u8');
  assert.equal(getMediaExt('https://x/a.MP4'), 'mp4');
  assert.equal(getMediaExt('https://x/a.mp4?token=1'), 'mp4');
  assert.equal(getMediaExt('https://x/a.webm#t=1'), 'webm');
  assert.equal(getMediaExt('https://x/a.txt'), 'media');
  assert.equal(getMediaExt('https://x/a'), 'media');
  assert.equal(getMediaExt(null), 'media');
  assert.equal(getMediaExt(123), 'media');
});

test('P12R1-BROWSER getDomain 去 www、解析失败空串', () => {
  const { getDomain } = browserMod;
  assert.equal(getDomain('https://www.example.com/a'), 'example.com');
  assert.equal(getDomain('https://sub.example.com/a'), 'sub.example.com');
  assert.equal(getDomain('not-a-url'), '');
  assert.equal(getDomain(null), '');
});

test('P12R1-BROWSER ellipsisMiddle 中间省略', () => {
  const { ellipsisMiddle } = browserMod;
  const short = 'https://a.com/x';
  assert.equal(ellipsisMiddle(short), short);
  const long = 'https://example.com/' + 'a'.repeat(100);
  const out = ellipsisMiddle(long);
  assert.ok(out.includes('…'));
  assert.ok(out.startsWith('https://example.com/'));
  assert.equal(ellipsisMiddle(null), '');
  // 自定义 head/tail
  const custom = ellipsisMiddle(long, 10, 5);
  assert.ok(custom.startsWith(long.slice(0, 10)));
  assert.ok(custom.endsWith(long.slice(-5)));
});

test('P12R1-BROWSER buildMediaItem 结构等价', () => {
  const { buildMediaItem } = browserMod;
  assert.deepEqual(buildMediaItem('https://www.example.com/a.m3u8'), {
    id: 'https://www.example.com/a.m3u8',
    url: 'https://www.example.com/a.m3u8',
    ext: 'm3u8',
    domain: 'example.com',
  });
});

test('P12R1-BROWSER 账号作用域 key：有效 userId 拼接、无效返回 null', () => {
  const { buildBrowserHistoryKey, buildBrowserBookmarksKey, BROWSER_HISTORY_KEY_PREFIX, BROWSER_BOOKMARKS_KEY_PREFIX } = browserMod;
  assert.equal(buildBrowserHistoryKey('u1'), `${BROWSER_HISTORY_KEY_PREFIX}u1`);
  assert.equal(buildBrowserBookmarksKey('u1'), `${BROWSER_BOOKMARKS_KEY_PREFIX}u1`);
  assert.equal(buildBrowserHistoryKey(''), null);
  assert.equal(buildBrowserHistoryKey(null), null);
  assert.equal(buildBrowserHistoryKey(undefined), null);
  assert.equal(buildBrowserHistoryKey(123), null);
  assert.equal(buildBrowserBookmarksKey(''), null);
  assert.equal(buildBrowserBookmarksKey(null), null);
});

test('P12R1-BROWSER 旧全局 key 常量保持不变', () => {
  assert.equal(browserMod.HISTORY_KEY, '@browser_history');
  assert.equal(browserMod.HISTORY_LIMIT, 100);
  assert.equal(browserMod.BROWSER_HISTORY_KEY_PREFIX, '@sync_browser_history_v2_');
  assert.equal(browserMod.BROWSER_BOOKMARKS_KEY_PREFIX, '@sync_browser_bookmarks_v2_');
});

test('P12R1-BROWSER formatHistoryTime 格式与非法输入', () => {
  const { formatHistoryTime } = browserMod;
  // 固定时间戳：2021-10-29 14:30（本地时区）
  const d = new Date(2021, 9, 29, 14, 30, 0);
  assert.equal(formatHistoryTime(d.getTime()), '10-29 14:30');
  // 非法时间戳 → 空串
  assert.equal(formatHistoryTime(NaN), '');
  // 非数字 → 使用 Date.now()（返回非空、格式匹配）
  const out = formatHistoryTime('not-a-number');
  assert.match(out, /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('P12R1-BROWSER buildHistoryTitle 优先级：标题 > 域名 > URL 预览', () => {
  const { buildHistoryTitle } = browserMod;
  assert.equal(buildHistoryTitle('  标题  ', 'https://example.com/a'), '标题');
  assert.equal(buildHistoryTitle('', 'https://www.example.com/a'), 'example.com');
  assert.equal(buildHistoryTitle(null, 'https://example.com/a'), 'example.com');
  // 无标题、无有效域名 → URL 预览
  const out = buildHistoryTitle('', 'not-a-url-but-long-enough-to-truncate-xxxxxxxxxxxxxxxxxxxxxxxx');
  assert.ok(out.length > 0);
});

test('P12R1-BROWSER mergeMediaList 去重、新项在前、稳定顺序、对象结构', () => {
  const { mergeMediaList, buildMediaItem } = browserMod;
  const prev = [buildMediaItem('https://x/a.mp4'), buildMediaItem('https://x/b.mp4')];
  // 空/非数组 incoming → 原样返回
  assert.equal(mergeMediaList(prev, []), prev);
  assert.equal(mergeMediaList(prev, null), prev);
  assert.equal(mergeMediaList(prev, 'x'), prev);
  // 新项在前，去重
  const merged = mergeMediaList(prev, ['https://x/c.mp4', 'https://x/a.mp4', 'https://x/d.mp4']);
  assert.deepEqual(merged.map((m) => m.url), ['https://x/c.mp4', 'https://x/d.mp4', 'https://x/a.mp4', 'https://x/b.mp4']);
  // 全部重复 → 原样返回（引用相等）
  assert.equal(mergeMediaList(prev, ['https://x/a.mp4']), prev);
  // 非字符串/空串被忽略
  const merged2 = mergeMediaList(prev, [null, '', 123, 'https://x/e.mp4']);
  assert.deepEqual(merged2.map((m) => m.url), ['https://x/e.mp4', 'https://x/a.mp4', 'https://x/b.mp4']);
  // 对象结构
  assert.deepEqual(merged2[0], { id: 'https://x/e.mp4', url: 'https://x/e.mp4', ext: 'mp4', domain: 'x' });
});

test('P12R1-BROWSER User-Agent 常量等价', () => {
  assert.equal(browserMod.MOBILE_USER_AGENT, 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
  assert.equal(browserMod.DESKTOP_USER_AGENT, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
});
