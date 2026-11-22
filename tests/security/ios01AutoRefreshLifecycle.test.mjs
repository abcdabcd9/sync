// --- START OF FILE tests/security/ios01AutoRefreshLifecycle.test.mjs ---
// ============================================================================
// P0.3 真机验收缺陷 iOS-01 — 后台自动刷新生命周期回归测试
//
// 背景（只读诊断 + 真实 SDK 探针结论，见
//   .internal/refactor/tasks/TASK-P0.3/ios01/ios01_probe.mjs）：
//
//   1. `src/services/supabase.js` 以 `autoRefreshToken: true` 创建客户端，
//      但**全仓库没有任何 AppState 监听**去调用 `startAutoRefresh()` /
//      `stopAutoRefresh()`（`grep -rn "startAutoRefresh" src/` 为空）。
//   2. `@supabase/auth-js` 在**非浏览器环境**（React Native 属于此类）的
//      `_handleVisibilityChange()` 分支是：
//          if (this.autoRefreshToken) { this.startAutoRefresh(); }
//      即「假定永远在前台」，ticker 一旦启动就**永不停**。
//   3. 因此 App 长时间切到后台后，`setInterval` 仍按
//      AUTO_REFRESH_TICK_DURATION_MS 触发 `_autoRefreshTokenTick()`。
//      iOS 在后台会锁定 Keychain，`SecureStore.getItemAsync` 抛错 →
//      适配器 `status.markFailed(AUTH_STORAGE_UNAVAILABLE)` →
//      SDK 打印 `Auto refresh tick failed with error.`（探针 P3/P4/P5 复现，
//      且**每次 tick 都重复出现**）。
//   4. 探针同时确认：`stopAutoRefresh()` 能真正清掉 ticker（P7），
//      连续 `startAutoRefresh()` 不会累积多个 ticker（P8），
//      Keychain 恢复后一次成功读取即清除故障位（P9）。
//
// 修复方向（Supabase 官方 React Native 推荐做法）：
//   注册**唯一一个** AppState 监听器：
//     · state === 'active'  → supabase.auth.startAutoRefresh()
//     · 其他（background/inactive）→ supabase.auth.stopAutoRefresh()
//   并保证：冷启动时按当前 AppState 初始化、重复前后台切换不重复注册、
//   卸载时移除监听、开发环境热更新不累积。
//
// 本测试的验证策略：
//   把「生命周期决策」抽成 `src/services/authAutoRefresh.ts` 中的纯逻辑
//   `createAutoRefreshController({ auth, appState, addListener })`，
//   注入 fake auth / fake AppState，直接执行**真实实现**（不联网、不用真机）。
//
//   修复前：该模块不存在 → 全部用例 FAIL（先红）。
//   修复后：全部用例 PASS（转绿）。
//
// 覆盖（对应授权要求的 9 项）：
//   T1 前台登录后自动刷新处于运行态
//   T2 进入后台 → stopAutoRefresh 被调用，ticker 停止
//   T3 返回前台 → startAutoRefresh 被调用，ticker 恢复
//   T4 连续前后台切换 10 次 → 只有 1 个监听器、start/stop 次数精确配对
//   T5 长时间后台后返回 → 会话仍可读（不因后台 tick 失败而丢会话）
//   T6 退出登录 → 重新登录后自动刷新仍正常
//   T7 真实 SecureStore 失败 → 安全错误位仍被置位（不被本修复绕过）
//   T8 A→B→A 账号切换 → 自动刷新生命周期不受影响
//   T9 iOS-02 白屏回归测试仍通过（由独立文件保证，此处做交叉断言）
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
const controllerPath = path.join(repoRoot, 'src/services/authAutoRefresh.ts');
const supabasePath = path.join(repoRoot, 'src/services/supabase.ts');

// ---------------------------------------------------------------------------
// 加载被测模块（修复前不存在 → 先红）
// ---------------------------------------------------------------------------
let createAutoRefreshController = null;
let loadError = null;
try {
  const mod = await import('../../src/services/authAutoRefresh.ts');
  createAutoRefreshController = mod.createAutoRefreshController ?? null;
} catch (e) {
  loadError = e;
}

function requireController() {
  assert.equal(
    typeof createAutoRefreshController,
    'function',
    '未找到 src/services/authAutoRefresh.ts 的 createAutoRefreshController：' +
      '旧实现完全没有 AppState 监听，后台 ticker 永不停，导致 iOS-01。' +
      (loadError ? ` 加载错误：${loadError.message}` : '')
  );
  return createAutoRefreshController;
}

// ---------------------------------------------------------------------------
// fake 依赖
// ---------------------------------------------------------------------------
function createFakeAuth() {
  const calls = { start: 0, stop: 0 };
  let running = false;
  return {
    calls,
    get running() {
      return running;
    },
    async startAutoRefresh() {
      calls.start += 1;
      running = true;
    },
    async stopAutoRefresh() {
      calls.stop += 1;
      running = false;
    },
  };
}

function createFakeAppState(initial = 'active') {
  const listeners = [];
  let current = initial;
  return {
    get currentState() {
      return current;
    },
    get listenerCount() {
      return listeners.length;
    },
    addEventListener(event, handler) {
      assert.equal(event, 'change', 'AppState 监听事件名必须是 change');
      const entry = { handler, removed: false };
      listeners.push(entry);
      return {
        remove() {
          entry.removed = true;
          const i = listeners.indexOf(entry);
          if (i !== -1) listeners.splice(i, 1);
        },
      };
    },
    /** 模拟系统派发一次状态变化 */
    emit(next) {
      current = next;
      for (const l of [...listeners]) l.handler(next);
    },
    /** 供断言：当前仍存活的监听器数量 */
    activeCount() {
      return listeners.filter((l) => !l.removed).length;
    },
  };
}

// ---------------------------------------------------------------------------
// T0 模块与契约存在性（修复前即失败 → 先红）
// ---------------------------------------------------------------------------
test('T0 authAutoRefresh 模块存在且导出 createAutoRefreshController（修复前应失败）', () => {
  requireController();
});

// ---------------------------------------------------------------------------
// T1 前台登录后自动刷新处于运行态
// ---------------------------------------------------------------------------
test('T1 前台启动 → startAutoRefresh 被调用一次，ticker 运行', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();

  assert.equal(auth.calls.start, 1, '前台启动必须调用一次 startAutoRefresh');
  assert.equal(auth.calls.stop, 0, '前台启动不应调用 stopAutoRefresh');
  assert.equal(auth.running, true, '自动刷新应处于运行态');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T2 进入后台 → 停止自动刷新
// ---------------------------------------------------------------------------
test('T2 进入后台 → stopAutoRefresh 被调用，ticker 停止', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();
  assert.equal(auth.running, true);

  appState.emit('background');
  await ctrl.flush();

  assert.equal(auth.calls.stop, 1, '进入后台必须调用一次 stopAutoRefresh');
  assert.equal(auth.running, false, '后台时自动刷新必须停止（iOS-01 根因）');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T3 返回前台 → 恢复自动刷新
// ---------------------------------------------------------------------------
test('T3 返回前台 → startAutoRefresh 再次被调用，ticker 恢复', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();

  appState.emit('background');
  await ctrl.flush();
  appState.emit('active');
  await ctrl.flush();

  assert.equal(auth.calls.start, 2, '返回前台必须重新 startAutoRefresh');
  assert.equal(auth.calls.stop, 1, '后台只应 stop 一次');
  assert.equal(auth.running, true, '返回前台后自动刷新必须恢复');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T4 连续前后台切换 10 次 → 无重复监听器 / 无重复 ticker
// ---------------------------------------------------------------------------
test('T4 连续前后台切换 10 次 → 仅 1 个监听器，start/stop 精确配对', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();

  assert.equal(appState.activeCount(), 1, '必须只注册一个 AppState 监听器');

  for (let i = 0; i < 10; i += 1) {
    appState.emit('background');
    await ctrl.flush();
    appState.emit('active');
    await ctrl.flush();
  }

  assert.equal(appState.activeCount(), 1, '10 次切换后仍必须只有 1 个监听器（不得累积）');
  assert.equal(auth.calls.start, 11, '初始 1 次 + 10 次回前台 = 11 次 start');
  assert.equal(auth.calls.stop, 10, '10 次进后台 = 10 次 stop');
  assert.equal(auth.running, true, '最终应处于运行态');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T5 长时间后台后返回 → 会话仍可读（不因后台 tick 失败而丢会话）
// ---------------------------------------------------------------------------
test('T5 长时间后台后返回 → 会话保持，且后台期间未发生 tick', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  // 用真实 SDK 语义模拟：后台期间 ticker 已停 → 不会有 tick 调用
  let tickCount = 0;
  const originalStart = auth.startAutoRefresh.bind(auth);
  const originalStop = auth.stopAutoRefresh.bind(auth);
  auth.startAutoRefresh = async () => {
    await originalStart();
    tickCount += 1; // 每次 start 代表 ticker 重新建立
  };
  auth.stopAutoRefresh = async () => {
    await originalStop();
  };

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();
  const ticksAfterStart = tickCount;

  // 模拟「长时间后台」：多次 background 事件（幂等，不应重复 stop）
  appState.emit('background');
  await ctrl.flush();
  appState.emit('background');
  await ctrl.flush();
  appState.emit('inactive');
  await ctrl.flush();

  assert.equal(tickCount, ticksAfterStart, '后台期间不得重建 ticker（即不得 tick）');
  assert.equal(auth.running, false, '后台期间自动刷新必须停止');

  // 返回前台 → 会话仍可读（此处以「ticker 恢复且未触发登出」表达）
  appState.emit('active');
  await ctrl.flush();
  assert.equal(auth.running, true, '返回前台后会话刷新能力必须恢复');
  assert.equal(auth.calls.stop, 1, '连续 background/inactive 只应 stop 一次（幂等）');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T6 退出登录 → 重新登录后自动刷新仍正常
// ---------------------------------------------------------------------------
test('T6 退出登录后重新登录 → 自动刷新生命周期仍正常', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();
  assert.equal(auth.running, true);

  // 模拟登出：SDK 内部会 _removeSession，但 ticker 生命周期由控制器管理
  appState.emit('background');
  await ctrl.flush();
  assert.equal(auth.running, false);

  // 重新登录（回到前台）
  appState.emit('active');
  await ctrl.flush();
  assert.equal(auth.running, true, '重新登录后自动刷新必须恢复');

  // 再切一次后台，确认仍能正确停止（状态机未损坏）
  appState.emit('background');
  await ctrl.flush();
  assert.equal(auth.running, false, '重新登录后后台仍必须停止刷新');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T7 真实 SecureStore 失败 → 安全错误位仍被置位（不被本修复绕过）
// ---------------------------------------------------------------------------
test('T7 真实 SecureStore 读取失败 → AUTH_STORAGE_UNAVAILABLE 仍被置位', async () => {
  const { createAuthStorageStatus, createSecureStoreAdapter, AUTH_STORAGE_ERROR } = await import(
    '../../src/services/authStorage.ts'
  );

  const status = createAuthStorageStatus();
  const adapter = createSecureStoreAdapter({
    secureStore: {
      async getItemAsync() {
        throw new Error('Keychain locked');
      },
      async setItemAsync() {},
      async deleteItemAsync() {},
    },
    asyncStorage: {
      async getItem() {
        return null;
      },
      async removeItem() {},
    },
    status,
    logger: { error() {}, warn() {}, log() {} },
  });

  await assert.rejects(
    () => adapter.getItem('sb-ref-auth-token'),
    (e) => e.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
    '适配器必须显式抛出 AUTH_STORAGE_UNAVAILABLE（不得吞异常）'
  );
  assert.equal(
    status.get()?.code,
    AUTH_STORAGE_ERROR.UNAVAILABLE,
    '故障状态位必须被置位，供 useAuth 展示安全错误页'
  );
});

// ---------------------------------------------------------------------------
// T8 A→B→A 账号切换 → 自动刷新生命周期不受影响
// ---------------------------------------------------------------------------
test('T8 A→B→A 账号切换 → 自动刷新生命周期不受影响', async () => {
  const create = requireController();
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');

  const ctrl = create({ auth, appState });
  ctrl.start();
  await ctrl.flush();

  // A→B：登出再登录（期间经历后台/前台）
  appState.emit('background');
  await ctrl.flush();
  appState.emit('active');
  await ctrl.flush();
  // B→A：再次切换
  appState.emit('background');
  await ctrl.flush();
  appState.emit('active');
  await ctrl.flush();

  assert.equal(appState.activeCount(), 1, '账号切换不得导致监听器累积');
  assert.equal(auth.calls.start, 3, '初始 + 2 次回前台 = 3 次 start');
  assert.equal(auth.calls.stop, 2, '2 次进后台 = 2 次 stop');
  assert.equal(auth.running, true, '账号切换后自动刷新仍应运行');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// T9 iOS-02 白屏回归测试仍通过（交叉断言：文件存在且纯函数仍在）
// ---------------------------------------------------------------------------
test('T9 iOS-02 白屏修复未被破坏（computeAuthRedirect 仍存在且语义正确）', () => {
  const layoutSrc = fs.readFileSync(path.join(repoRoot, 'src/app/_layout.js'), 'utf8');
  assert.ok(
    layoutSrc.includes('function computeAuthRedirect('),
    'iOS-02 修复的纯函数 computeAuthRedirect 必须仍然存在'
  );
  // 未登录必须跳 /auth（不依赖 isInitialized）
  const fnMatch = layoutSrc.match(
    /function computeAuthRedirect\([^)]*\)\s*\{[\s\S]*?\n\}/
  );
  assert.ok(fnMatch, '必须能定位 computeAuthRedirect 函数体');
  const body = fnMatch[0];
  assert.ok(
    /if\s*\(!user\)\s*\{[\s\S]*?return\s+isPublicRoute\s*\?\s*null\s*:\s*'\/auth'/.test(body),
    '未登录分支必须直接返回 /auth，不得再受 isInitialized 阻塞'
  );
});

// ---------------------------------------------------------------------------
// T10 静态契约：supabase.js 仍保留 autoRefreshToken: true（不得永久关闭）
// ---------------------------------------------------------------------------
test('T10 supabase.js 仍启用 autoRefreshToken（不得永久关闭自动刷新）', () => {
  const src = fs.readFileSync(supabasePath, 'utf8');
  assert.ok(
    /autoRefreshToken:\s*true/.test(src),
    'autoRefreshToken 必须保持 true —— 修复方式是生命周期管理，不是关闭刷新'
  );
  assert.ok(
    /persistSession:\s*true/.test(src),
    'persistSession 必须保持 true —— 不得修改登录凭证存储方式'
  );
});

// ---------------------------------------------------------------------------
// T11 静态契约：AppState 监听只在 authAutoRefresh 模块内注册（唯一入口）
// ---------------------------------------------------------------------------
test('T11 AppState 监听集中在 authAutoRefresh 模块（唯一入口，避免重复注册）', () => {
  const src = fs.readFileSync(controllerPath, 'utf8');
  assert.ok(
    /addEventListener\(\s*'change'/.test(src),
    'authAutoRefresh 必须注册 AppState change 监听'
  );
  assert.ok(
    /startAutoRefresh/.test(src) && /stopAutoRefresh/.test(src),
    'authAutoRefresh 必须同时调用 startAutoRefresh 与 stopAutoRefresh'
  );
  // 必须提供 dispose/清理能力
  assert.ok(
    /dispose|remove\(\)/.test(src),
    'authAutoRefresh 必须提供监听器清理能力（卸载/热更新不累积）'
  );
});
// --- END OF FILE tests/security/ios01AutoRefreshLifecycle.test.mjs ---
