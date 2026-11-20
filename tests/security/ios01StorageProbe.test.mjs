// --- START OF FILE tests/security/ios01StorageProbe.test.mjs ---
// ============================================================================
// P0.3 BUG-02（iOS-01 残留）— SecureStore 可用性探测回归测试
//
// 背景：
//   iOS-01 主修复（AppState 驱动 start/stop）已解决「后台 ticker 永不停」。
//   但真机仍偶发 `SecureStore getValueWithKeyAsync failed` /
//   `User interaction is not allowed`：iOS 解锁后 Keychain 存在**短暂不可用窗口**，
//   若在 `AppState 'active'` 事件里立即 `startAutoRefresh()`，
//   首个自动刷新 tick 会读 SecureStore 并抛错。
//
// 修复：
//   `createAutoRefreshController` 新增可选 `probeStorage`。
//   进入 active 时先探测 SecureStore 是否可用：
//     · 可用 → 启动 ticker；
//     · 不可用 → 延迟重试，期间**不启动 ticker**（不产生失败 tick）；
//     · 探测期间又切后台 / 卸载 → 作废探测，绝不在后台启动 ticker。
//   未注入 probeStorage 时行为与旧版完全一致（直接 start），保证既有契约不破。
//
// 覆盖：
//   P1 未注入 probeStorage → 直接 start（旧行为不破）
//   P2 probe 立即成功 → start 一次
//   P3 probe 连续失败后成功 → 期间不 start，成功后 start 一次
//   P4 probe 一直失败 → 达到上限仍不 start（不产生失败 tick）
//   P5 probe 失败期间切后台 → 不 start；回前台重新探测
//   P6 probe 进行中 dispose → 不 start
//   P7 probe 抛错（同步/异步）→ 视为不可用，延迟重试
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoRefreshController } from '../../src/services/authAutoRefresh.js';

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
    addEventListener(event, handler) {
      assert.equal(event, 'change');
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
    emit(next) {
      current = next;
      for (const l of [...listeners]) l.handler(next);
    },
    activeCount() {
      return listeners.filter((l) => !l.removed).length;
    },
  };
}

const FAST = { retryDelayMs: 5, maxRetries: 50 };

// 等待若干毫秒（让探测重试定时器推进）
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// P1 未注入 probeStorage → 直接 start（旧行为不破）
// ---------------------------------------------------------------------------
test('P1 未注入 probeStorage → 直接 startAutoRefresh（旧行为不破）', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  const ctrl = createAutoRefreshController({ auth, appState });
  ctrl.start();
  await ctrl.flush();
  assert.equal(auth.calls.start, 1, '未注入 probe 时必须直接启动');
  assert.equal(auth.running, true);
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// P2 probe 立即成功 → start 一次
// ---------------------------------------------------------------------------
test('P2 probe 立即成功 → startAutoRefresh 被调用一次', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  let probeCalls = 0;
  const ctrl = createAutoRefreshController({
    auth,
    appState,
    probeStorage: async () => {
      probeCalls += 1;
      return true;
    },
    timing: FAST,
  });
  ctrl.start();
  await ctrl.flush();
  assert.equal(probeCalls, 1, '应探测一次');
  assert.equal(auth.calls.start, 1, '探测成功后启动一次');
  assert.equal(auth.running, true);
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// P3 probe 连续失败后成功 → 期间不 start，成功后 start 一次
// ---------------------------------------------------------------------------
test('P3 probe 连续失败后成功 → 期间不启动 ticker，成功后启动一次', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  let probeCalls = 0;
  const ctrl = createAutoRefreshController({
    auth,
    appState,
    probeStorage: async () => {
      probeCalls += 1;
      return probeCalls >= 3; // 前两次失败，第三次成功
    },
    timing: FAST,
  });
  ctrl.start();
  // 探测失败期间：ticker 不得启动
  await wait(2);
  assert.equal(auth.calls.start, 0, '探测未通过前不得启动 ticker');
  // 等待重试推进到成功
  await wait(60);
  await ctrl.flush();
  assert.ok(probeCalls >= 3, `应至少探测 3 次，实际 ${probeCalls}`);
  assert.equal(auth.calls.start, 1, '探测成功后只启动一次');
  assert.equal(auth.running, true);
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// P4 probe 一直失败 → 达到上限仍不 start
// ---------------------------------------------------------------------------
test('P4 probe 一直失败 → 达到重试上限仍不启动 ticker', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  let probeCalls = 0;
  const errors = [];
  const ctrl = createAutoRefreshController({
    auth,
    appState,
    probeStorage: async () => {
      probeCalls += 1;
      return false;
    },
    timing: { retryDelayMs: 2, maxRetries: 4 },
    onError: (e) => errors.push(e),
  });
  ctrl.start();
  await wait(80);
  await ctrl.flush();
  assert.equal(auth.calls.start, 0, '探测始终失败时绝不启动 ticker（不产生失败 tick）');
  assert.equal(auth.running, false);
  assert.ok(probeCalls >= 4, `应达到重试上限，实际探测 ${probeCalls} 次`);
  assert.ok(errors.length >= 1, '达到上限应上报一次可观测错误（不静默）');
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// P5 probe 失败期间切后台 → 不 start；回前台重新探测
// ---------------------------------------------------------------------------
test('P5 probe 失败期间切后台 → 不启动；回前台重新探测并启动', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  let available = false;
  let probeCalls = 0;
  const ctrl = createAutoRefreshController({
    auth,
    appState,
    probeStorage: async () => {
      probeCalls += 1;
      return available;
    },
    timing: { retryDelayMs: 1000, maxRetries: 50 }, // 故意拉长，确保切后台前不会成功
  });
  ctrl.start();
  await wait(5);
  assert.equal(auth.calls.start, 0, '探测未通过前不得启动');

  // 切后台：作废进行中的探测
  appState.emit('background');
  await ctrl.flush();
  assert.equal(auth.calls.start, 0, '后台期间绝不启动 ticker');
  assert.equal(auth.running, false);

  // 回前台：Keychain 已可用 → 重新探测并启动
  available = true;
  appState.emit('active');
  await wait(5);
  await ctrl.flush();
  assert.equal(auth.calls.start, 1, '回前台探测成功后启动一次');
  assert.equal(auth.running, true);
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// P6 probe 进行中 dispose → 不 start
// ---------------------------------------------------------------------------
test('P6 probe 进行中 dispose → 不启动 ticker', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  let resolveProbe;
  const ctrl = createAutoRefreshController({
    auth,
    appState,
    probeStorage: () => new Promise((r) => { resolveProbe = r; }),
    timing: FAST,
  });
  ctrl.start();
  await wait(2);
  ctrl.dispose();
  // 探测在 dispose 后才 resolve
  resolveProbe(true);
  await wait(20);
  await ctrl.flush();
  assert.equal(auth.calls.start, 0, 'dispose 后即使探测成功也不得启动 ticker');
  ctrl.dispose(); // 幂等
});

// ---------------------------------------------------------------------------
// P7 probe 抛错（同步/异步）→ 视为不可用，延迟重试
// ---------------------------------------------------------------------------
test('P7 probe 抛错 → 视为不可用并延迟重试，成功后启动', async () => {
  const auth = createFakeAuth();
  const appState = createFakeAppState('active');
  let probeCalls = 0;
  const ctrl = createAutoRefreshController({
    auth,
    appState,
    probeStorage: () => {
      probeCalls += 1;
      if (probeCalls === 1) throw new Error('sync boom');
      if (probeCalls === 2) return Promise.reject(new Error('async boom'));
      return Promise.resolve(true);
    },
    timing: FAST,
  });
  ctrl.start();
  await wait(60);
  await ctrl.flush();
  assert.ok(probeCalls >= 3, `应重试到成功，实际 ${probeCalls}`);
  assert.equal(auth.calls.start, 1, '最终探测成功后启动一次');
  assert.equal(auth.running, true);
  ctrl.dispose();
});
// --- END OF FILE tests/security/ios01StorageProbe.test.mjs ---
