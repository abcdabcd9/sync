// --- START OF FILE tests/security/ios02WhiteScreen.test.mjs ---
// ============================================================================
// P0.3 真机验收缺陷 iOS-02 — 退出登录 / 无会话冷启动白屏回归测试
//
// 背景（只读诊断结论）：
//   旧实现 `src/app/_layout.js` 中，路由守卫与白屏分支共用同一个前置条件
//   `isInitialized`（来自 useHealthData → useHealthStorage.isLoaded）：
//     · 路由守卫：`if (isAuthLoading || !isInitialized) return;` → 未登录时
//       `isInitialized` 恒为 false，守卫永远提前 return，永不跳 /auth；
//     · 白屏分支：`if (!isInitialized) return <View .../>;` → 渲染纯背景色空 View。
//   而退出登录后 userId=null，useHealthStorage.load() 命中 `!k` 分支，
//   永久 `setIsLoaded(false)` → `isInitialized` 永远无法回到 true。
//   结果：白屏 View 永久驻留，跳转逻辑永久被跳过 —— 确定性死锁。
//
// 本测试的验证策略（与仓库既有 `tests/regression/run_all.mjs` 的 section D 一致）：
//   `_layout.js` 是 React 组件，依赖 react-native / expo-router，无法在纯 Node 中
//   直接 import。因此把「路由决策」抽成 `_layout.js` 内一个**纯函数**
//   `computeAuthRedirect({ user, isAuthLoading, authError, isInitialized, isPublicRoute })`，
//   本测试从源码中**静态提取**该函数体并求值，直接断言其决策结果。
//
//   修复前：`_layout.js` 中不存在该纯函数 → 提取失败 → 全部用例 FAIL（先红）。
//   修复后：纯函数存在且语义正确 → 全部用例 PASS（转绿）。
//
// 覆盖场景（对应授权要求 1~8）：
//   S1 正常退出登录（user=null, loading=false, error=null, isInitialized=false）→ 跳 /auth
//   S2 无会话冷启动（同上，模拟重启后墓碑生效）→ 跳 /auth
//   S3 正常登录（user 存在, isInitialized=true, 当前在 /auth）→ 跳 /
//   S4 登录中页面保护（isAuthLoading=true）→ 不跳转（null）
//   S5 健康数据加载期间（user 存在, isInitialized=false）→ 不跳转（null），不闪现私人页
//   S6 登录存储失败（authError 存在）→ 不跳转（null），由错误页接管
//   S7 退出后重新登录（user 存在, isInitialized=true, 在 /auth）→ 跳 /
//   S8 A→B→A 账号隔离（user 存在, isInitialized=false 的过渡帧）→ 不跳转（null）
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token / 真实用户数据。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const layoutPath = path.join(repoRoot, 'src/app/_layout.js');

/**
 * 从 `_layout.js` 源码中静态提取纯函数 `computeAuthRedirect` 并求值。
 *
 * 提取策略：
 *   1. 定位 `function computeAuthRedirect(` 的起始位置；
 *   2. 用花括号配平扫描到函数体结束；
 *   3. 用 `new Function` 把函数体包装成可调用函数返回。
 *
 * 若源码中不存在该函数（修复前），返回 null，调用方据此判定 FAIL。
 */
function extractComputeAuthRedirect(src) {
  const marker = 'function computeAuthRedirect(';
  const start = src.indexOf(marker);
  if (start === -1) return null;

  // 关键：参数是解构对象 `{ user, ... }`，不能用「第一个 '{'」当函数体起点。
  // 先找到参数列表的闭合 ')'，再找其后的第一个 '{' 作为函数体起点。
  const parenStart = src.indexOf('(', start);
  if (parenStart === -1) return null;
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd === -1) return null;

  // 函数体起点：参数列表闭合 ')' 之后的第一个 '{'
  const braceStart = src.indexOf('{', parenEnd);
  if (braceStart === -1) return null;

  // 花括号配平扫描（忽略字符串/注释的极端情况在此源码中不存在，足够稳健）
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  const fnSource = src.slice(start, end + 1);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${fnSource}; return computeAuthRedirect;`);
  return factory();
}

const src = fs.readFileSync(layoutPath, 'utf8');
const computeAuthRedirect = extractComputeAuthRedirect(src);

// ---------------------------------------------------------------------------
// 前置：纯函数必须存在（修复前此处即失败 → 先红）
// ---------------------------------------------------------------------------
test('S0 computeAuthRedirect 纯函数存在于 _layout.js（修复前应失败）', () => {
  assert.equal(
    typeof computeAuthRedirect,
    'function',
    '未在 _layout.js 中找到 computeAuthRedirect 纯函数：旧实现把路由决策内联在 effect 中，' +
      '与 isInitialized 死锁，无法在纯 Node 中验证。修复应抽出该纯函数。'
  );
});

// 若函数不存在，后续用例统一给出明确失败信息（避免 TypeError 噪音）
function requireFn() {
  assert.equal(typeof computeAuthRedirect, 'function', 'computeAuthRedirect 缺失，无法验证路由决策');
  return computeAuthRedirect;
}

// ---------------------------------------------------------------------------
// S1 正常退出登录 → 必须跳 /auth（即使 isInitialized=false）
// ---------------------------------------------------------------------------
test('S1 退出登录后（user=null, isInitialized=false）→ 跳 /auth', () => {
  const fn = requireFn();
  const r = fn({ user: null, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: false });
  assert.equal(r, '/auth', '退出后必须跳登录页，绝不能因 isInitialized=false 而卡在白屏');
});

// ---------------------------------------------------------------------------
// S2 无会话冷启动（重启后墓碑生效）→ 必须跳 /auth
// ---------------------------------------------------------------------------
test('S2 无会话冷启动（user=null, isInitialized=false）→ 跳 /auth', () => {
  const fn = requireFn();
  const r = fn({ user: null, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: false });
  assert.equal(r, '/auth', '冷启动无会话必须能进入登录页，不能白屏');
});

// ---------------------------------------------------------------------------
// S3 正常登录 → 已登录停留在 /auth → 跳 /
// ---------------------------------------------------------------------------
test('S3 正常登录（user 存在, isInitialized=true, 在 /auth）→ 跳 /', () => {
  const fn = requireFn();
  const r = fn({ user: { id: 'u1' }, isAuthLoading: false, authError: null, isInitialized: true, isPublicRoute: true });
  assert.equal(r, '/', '已登录仍停留在登录页应送回主界面');
});

// ---------------------------------------------------------------------------
// S4 登录中页面保护 → 不跳转
// ---------------------------------------------------------------------------
test('S4 登录状态确认中（isAuthLoading=true）→ 不跳转', () => {
  const fn = requireFn();
  const r = fn({ user: null, isAuthLoading: true, authError: null, isInitialized: false, isPublicRoute: false });
  assert.equal(r, null, '会话确认中不得跳转，避免误拦截/闪现');
});

// ---------------------------------------------------------------------------
// S5 健康数据加载期间（已登录但未就绪）→ 不跳转，不闪现私人页
// ---------------------------------------------------------------------------
test('S5 已登录但健康数据未就绪（user 存在, isInitialized=false）→ 不跳转', () => {
  const fn = requireFn();
  const r = fn({ user: { id: 'u1' }, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: false });
  assert.equal(r, null, '已登录但健康数据未就绪时不得跳转（避免闪现私人页/错误数据）');
});

// ---------------------------------------------------------------------------
// S6 登录存储失败 → 不跳转，由错误页接管
// ---------------------------------------------------------------------------
test('S6 安全存储失败（authError 存在）→ 不跳转', () => {
  const fn = requireFn();
  const r = fn({
    user: null,
    isAuthLoading: false,
    authError: { code: 'AUTH_STORAGE_UNAVAILABLE' },
    isInitialized: false,
    isPublicRoute: false,
  });
  assert.equal(r, null, 'authError 存在时必须由错误页接管，不得误跳登录页');
});

// ---------------------------------------------------------------------------
// S7 退出后重新登录 → 已登录在 /auth → 跳 /
// ---------------------------------------------------------------------------
test('S7 退出后重新登录（user 存在, isInitialized=true, 在 /auth）→ 跳 /', () => {
  const fn = requireFn();
  const r = fn({ user: { id: 'u1' }, isAuthLoading: false, authError: null, isInitialized: true, isPublicRoute: true });
  assert.equal(r, '/', '重新登录后应进入主界面');
});

// ---------------------------------------------------------------------------
// S8 A→B→A 账号隔离：身份切换过渡帧（user 存在但 isInitialized=false）→ 不跳转
// ---------------------------------------------------------------------------
test('S8 A→B→A 过渡帧（user 存在, isInitialized=false）→ 不跳转', () => {
  const fn = requireFn();
  const r = fn({ user: { id: 'uA' }, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: false });
  assert.equal(r, null, '账号切换过渡帧不得跳转，避免把旧账号数据当作新账号展示');
});

// ---------------------------------------------------------------------------
// S9 已登录且已就绪、停留在私密页 → 不跳转（保持现状）
// ---------------------------------------------------------------------------
test('S9 已登录已就绪、在私密页（user 存在, isInitialized=true, 非公开）→ 不跳转', () => {
  const fn = requireFn();
  const r = fn({ user: { id: 'u1' }, isAuthLoading: false, authError: null, isInitialized: true, isPublicRoute: false });
  assert.equal(r, null, '已登录且已就绪、在私密页时不应跳转');
});

// ---------------------------------------------------------------------------
// S10 未登录且已在 /auth → 不重复跳转（幂等）
// ---------------------------------------------------------------------------
test('S10 未登录且已在 /auth（isPublicRoute=true）→ 不重复跳转', () => {
  const fn = requireFn();
  const r = fn({ user: null, isAuthLoading: false, authError: null, isInitialized: false, isPublicRoute: true });
  assert.equal(r, null, '已在登录页时不应重复 replace，避免抖动');
});
// --- END OF FILE tests/security/ios02WhiteScreen.test.mjs ---
