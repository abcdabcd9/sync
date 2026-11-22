// --- START OF FILE tests/security/ios01AsyncRaceAndRecovery.test.mjs ---
// ============================================================================
// P0.3 — L4 第二轮 BLOCK-02 / BLOCK-03 修复前失败测试
//
// BLOCK-02（异步状态竞争）：
//   L4 用真实控制器复现：
//     startAutoRefresh 尚未完成 → AppState 切 background →
//     stopAutoRefresh 先完成 → 旧的 start 最后完成 →
//     最终 AppState=background，但 ticker 可能仍在运行。
//   根因：`track()` 只把 promise 推入队列，**不串行化** start/stop；
//         `applyState` 直接 `track(auth.startAutoRefresh())` /
//         `track(auth.stopAutoRefresh())`，两者可乱序完成。
//   要求：最终真实状态必须符合**最新** AppState；卸载期间的乱序操作也必须收敛。
//
// BLOCK-03（重试耗尽后无法恢复）：
//   L4 复现：probe 连续失败到上限 → SecureStore 恢复 → App 仍 active →
//            ticker 永不重启。
//   根因：`startWithProbe` 在 `attempt >= maxRetries` 时只 `reportError` 后 `return`，
//         没有任何恢复路径；此后即使 Keychain 恢复，也不会再尝试启动。
//   要求：建立恢复路径（正常恢复可用），同时避免无限高频重试或隐藏故障。
//
// 说明：
//   - 纯 Node，无网络、无真机、无真实 Token。
//   - 直接执行真实实现 `src/services/authAutoRefresh.ts`。
//   - 修复前：BLOCK-02 / BLOCK-03 用例 FAIL（先红）。
//   - 关键：所有 deferred 必须在调用 flush() 之前 resolve，否则 flush 会挂起。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoRefreshController } from '../../src/services/authAutoRefresh.ts';

// ---------------------------------------------------------------------------
// 可控异步 fake auth：start/stop 返回可手动 resolve 的 promise，
// 用于精确制造「乱序完成」。
// ---------------------------------------------------------------------------
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControllableAuth(initialRunning = false) {
  const calls = { start: 0, stop: 0 };
  let running = initialRunning;
  const inflight = []; // { kind, deferred } —— 仅保留「尚未 settle」的调用
  const settle = (entry) => {
    const i = inflight.indexOf(entry);
    if (i !== -1) inflight.splice(i, 1);
  };
  return {
    calls,
    get running() {
      return running;
    },
    get inflight() {
      return inflight;
    },
    startAutoRefresh() {
      calls.start += 1;
      const d = createDeferred();
      const entry = { kind: 'start', deferred: d };
      inflight.push(entry);
      return d.promise.then(() => {
        running = true;
        settle(entry);
      });
    },
    stopAutoRefresh() {
      calls.stop += 1;
      const d = createDeferred();
      const entry = { kind: 'stop', deferred: d };
      inflight.push(entry);
      return d.promise.then(() => {
        running = false;
        settle(entry);
      });
    },
    /** 取出第 n 个在途调用（按发起顺序） */
    take(kind, index = 0) {
      const matches = inflight.filter((x) => x.kind === kind);
      const target = matches[index];
      if (!target) throw new Error(`没有第 ${index} 个 ${kind} 在途调用`);
      return target;
    },
    /** 当前在途调用数量 */
    inflightCount() {
      return inflight.length;
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

// 让微任务队列跑空（不依赖真实计时器）
const tick = () => new Promise((r) => setImmediate(r));

// ===========================================================================
// BLOCK-02 — 异步乱序：start 未完成 → background → 最终必须停止
// ===========================================================================
test('BLOCK-02-A start 未完成即切后台 → 最终真实状态必须停止（不得被旧 start 覆盖）', async () => {
  const auth = createControllableAuth();
  const appState = createFakeAppState('active');
  const errors = [];

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
  });

  ctrl.start(); // 冷启动 active → 发起 startAutoRefresh（在途，未完成）
  await tick();
  assert.equal(auth.calls.start, 1, '冷启动应发起一次 startAutoRefresh');

  // 切后台：控制器应（串行地）发起 stopAutoRefresh
  appState.emit('background');
  await tick();

  // 关键：串行化后，同一时刻最多一个在途调用。
  assert.equal(
    auth.inflightCount(),
    1,
    'BLOCK-02：start/stop 必须串行化，同一时刻最多一个在途 SDK 调用'
  );

  // 依次 resolve 所有在途调用，直到队列排空
  for (let i = 0; i < 10; i += 1) {
    const inflight = auth.inflight;
    if (inflight.length === 0) break;
    inflight[0].deferred.resolve();
    await tick();
  }
  await ctrl.flush();

  // 最新 AppState = background → 真实 ticker 必须停止
  assert.equal(
    auth.running,
    false,
    'BLOCK-02：最新 AppState 为 background，最终真实状态必须停止（旧 start 不得覆盖）'
  );
  assert.equal(ctrl.isRunning(), false, '控制器期望状态必须为停止');
  assert.equal(errors.length, 0, '正常乱序不应产生错误');
  ctrl.dispose();
});

test('BLOCK-02-B 快速 active→background→active → 最终必须运行', async () => {
  const auth = createControllableAuth();
  const appState = createFakeAppState('active');
  const errors = [];

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
  });

  ctrl.start(); // start#0 在途
  await tick();
  appState.emit('background'); // 期望 stop
  await tick();
  appState.emit('active'); // 期望 start
  await tick();

  // 串行化：同一时刻最多一个在途调用
  assert.equal(
    auth.inflightCount(),
    1,
    'BLOCK-02：快速切换时也必须串行化，最多一个在途调用'
  );

  // 依次 resolve 所有在途调用，直到队列排空
  for (let i = 0; i < 10; i += 1) {
    const inflight = auth.inflight;
    if (inflight.length === 0) break;
    inflight[0].deferred.resolve();
    await tick();
  }
  await ctrl.flush();

  assert.equal(
    auth.running,
    true,
    'BLOCK-02：最新 AppState 为 active，最终真实状态必须运行'
  );
  assert.equal(ctrl.isRunning(), true);
  assert.equal(errors.length, 0);
  ctrl.dispose();
});

test('BLOCK-02-C 卸载期间乱序：dispose 后旧 start 完成 → 最终必须停止且无残留', async () => {
  const auth = createControllableAuth();
  const appState = createFakeAppState('active');
  const errors = [];

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
  });

  ctrl.start(); // start#0 在途
  await tick();
  assert.equal(auth.calls.start, 1);

  // 卸载：dispose 应发起 stopAutoRefresh（串行链上，等 start settle 后执行）
  ctrl.dispose();
  await tick();
  assert.equal(appState.activeCount(), 0, 'dispose 必须移除监听器');

  // 依次 resolve 所有在途调用
  for (let i = 0; i < 10; i += 1) {
    const inflight = auth.inflight;
    if (inflight.length === 0) break;
    inflight[0].deferred.resolve();
    await tick();
  }
  await ctrl.flush();

  assert.equal(
    auth.running,
    false,
    'BLOCK-02：卸载后旧 start 完成不得让 ticker 残留运行'
  );
  assert.equal(ctrl.isRunning(), false);
  ctrl.dispose(); // 幂等
});

// ===========================================================================
// BLOCK-03 — 探测重试耗尽后，SecureStore 恢复 → 必须能重新启动
// ===========================================================================
test('BLOCK-03-A 探测耗尽后 SecureStore 恢复 → ticker 必须能重启（不得永久卡死）', async () => {
  const auth = createControllableAuth();
  const appState = createFakeAppState('active');
  const errors = [];

  // 探测：前 N 次不可用，之后恢复可用
  let probeCalls = 0;
  const FAIL_TIMES = 5;
  const probeStorage = async () => {
    probeCalls += 1;
    return probeCalls > FAIL_TIMES;
  };

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
    probeStorage,
    timing: { retryDelayMs: 1, maxRetries: 3, recoveryDelayMs: 5 },
  });

  ctrl.start(); // active → 探测开始；maxRetries=3 → 3 次失败后进入低频恢复探测
  // 等待探测重试耗尽（retryDelayMs=1，最多 3 次）
  for (let i = 0; i < 50; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 2));
    if (probeCalls >= 3) break;
  }

  assert.ok(probeCalls >= 3, `探测应至少尝试 3 次（实际 ${probeCalls}）`);
  assert.equal(auth.calls.start, 0, '探测耗尽期间不得启动 ticker');
  assert.equal(auth.running, false, '探测耗尽期间 ticker 必须停止');
  assert.ok(errors.length >= 1, '探测耗尽必须上报一次可观测错误（不静默）');

  // SecureStore 恢复：低频恢复探测应在有限时间内探测成功并启动 ticker。
  // 关键断言：恢复后必须能重新探测并启动 ticker，而不是永久卡死。
  // 注意：BLOCK-A 修复后，探测失败会入队一次 stop（安全操作）。该 stop 在
  // 串行链上必须先 settle，恢复后的 start 才能执行；因此等待期间需及时
  // resolve 在途 stop（这是串行链正常推进的必要条件，不放宽任何断言）。
  for (let i = 0; i < 200; i += 1) {
    const inflight = auth.inflight;
    if (inflight.length > 0) inflight[0].deferred.resolve();
    await tick();
    await new Promise((r) => setTimeout(r, 2));
    if (auth.calls.start > 0) break;
  }

  assert.equal(
    auth.calls.start,
    1,
    'BLOCK-03：SecureStore 恢复后，低频恢复探测必须能启动 ticker（不得永久卡死）'
  );

  // 恢复后 start 已发起（在途）；resolve 它后真实运行态才为 true。
  for (let i = 0; i < 10; i += 1) {
    const inflight = auth.inflight;
    if (inflight.length === 0) break;
    inflight[0].deferred.resolve();
    await tick();
  }
  await ctrl.flush();

  assert.equal(auth.running, true, 'BLOCK-03：恢复后 ticker 必须运行');
  ctrl.dispose();
});

test('BLOCK-03-B 探测耗尽后不得无限高频重试（重试次数有上限）', async () => {
  const auth = createControllableAuth();
  const appState = createFakeAppState('active');
  const errors = [];

  let probeCalls = 0;
  const probeStorage = async () => {
    probeCalls += 1;
    return false; // 永远不可用
  };

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
    probeStorage,
    timing: { retryDelayMs: 1, maxRetries: 3, recoveryDelayMs: 1000 },
  });

  ctrl.start();
  // 给足时间让高频重试跑完（recoveryDelayMs=1000 远大于观察窗口，低频恢复探测不会触发）
  for (let i = 0; i < 60; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 2));
  }

  assert.ok(
    probeCalls <= 3,
    `BLOCK-03：高频探测次数必须有上限（maxRetries=3），实际 ${probeCalls} 次，不得无限高频重试`
  );
  assert.equal(auth.calls.start, 0, '探测始终不可用时不得启动 ticker');
  assert.equal(auth.running, false);
  assert.ok(errors.length >= 1, '必须上报可观测错误');
  ctrl.dispose();
});

// ===========================================================================
// BLOCK-A（L4 ROUND3）— probe 失败时不得留下仍在运行的旧 ticker
//
// 场景 1：SDK 初始化已启动 ticker（autoRefreshToken:true 在 RN 非浏览器环境
//         永不停）。控制器启动，probe 返回 false。旧实现只重试、从不 stop →
//         实际 ticker 仍在运行，stopAutoRefresh 调用次数为 0。
// 场景 2：active 且 ticker 运行 → 快速 background→active → 新一轮 probe 返回
//         false。之前排队的 stop 因 decisionSeq 已更新被跳过 → ticker 残留。
//
// 要求：probe 失败时不得留下仍在运行的旧 ticker；不得简单跳过所有过期 stop，
//       应保证最新安全状态最终生效。
// ===========================================================================
// 排空在途调用 + 微任务，直到串行链静止（有界，避免死循环）。
async function drainInflight(auth, rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    const inflight = auth.inflight;
    if (inflight.length > 0) inflight[0].deferred.resolve();
    await tick();
    await new Promise((r) => setTimeout(r, 2));
    if (auth.inflight.length === 0) {
      // 再多跑几轮微任务，确保链上后续决策也执行完
      await tick();
      await tick();
      if (auth.inflight.length === 0) return;
    }
  }
}

test('BLOCK-A-1 SDK 初始化已启动 ticker + probe 失败 → 必须停止旧 ticker（stop 至少 1 次）', async () => {
  // 模拟 SDK 初始化阶段已启动 ticker：running=true，无在途调用。
  const auth = createControllableAuth(true);
  const appState = createFakeAppState('active');
  const errors = [];

  const probeStorage = async () => false; // SecureStore 不可用

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
    probeStorage,
    // recoveryDelayMs 设极大：本用例只验证「probe 失败必须停旧 ticker」，
    // 不让低频恢复探测干扰观察窗口。
    timing: { retryDelayMs: 1, maxRetries: 2, recoveryDelayMs: 100000 },
  });

  ctrl.start(); // active → probe 失败 → 必须停止 SDK 初始化遗留的 ticker
  // 给探测重试与串行链足够时间（不 dispose：模拟 App 仍在前台运行）。
  await drainInflight(auth);

  // 断言必须在 dispose 之前：dispose 自身会入队 stop，若先 dispose 会掩盖缺陷。
  // 用 try/finally 保证即使断言失败（先红）也会 dispose 清除 recovery 定时器，
  // 否则 100000ms 定时器会让 node 进程无法退出。
  try {
    assert.ok(
      auth.calls.stop >= 1,
      `BLOCK-A：probe 失败时必须调用 stopAutoRefresh 停止 SDK 初始化遗留的 ticker，实际 stop=${auth.calls.stop}`
    );
    assert.equal(
      auth.running,
      false,
      'BLOCK-A：probe 失败后不得留下仍在运行的旧 ticker'
    );
    assert.equal(auth.calls.start, 0, 'BLOCK-A：probe 失败期间不得启动新 ticker');
  } finally {
    // 清理：dispose 清除 recovery 定时器，再排空在途调用，避免进程因定时器悬挂。
    ctrl.dispose();
    await drainInflight(auth, 20);
  }
});

test('BLOCK-A-2 快速 background→active 使已排队 stop 过期 + 后续 probe 失败 → 过期 stop 不得被跳过，ticker 必须停止', async () => {
  // 精确复现 L4 场景 2：
  //   1) probe 首次成功 → start 入队并处于在途（未 resolve）；
  //   2) background → stop 排在在途 start 之后（尚未执行）；
  //   3) active → decisionSeq++，使已排队的 stop 变为「过期」；
  //   4) resolve start → ticker 运行；随后过期 stop 在旧实现中被 seq 检查跳过；
  //   5) 之后 probe 持续失败 → 旧实现再也不会 stop → ticker 残留运行。
  // 要求：过期 stop 不得被简单跳过，最新安全状态（probe 不可用 → 停止）必须最终生效。
  const auth = createControllableAuth(false); // SDK 初始未运行
  const appState = createFakeAppState('active');
  const errors = [];

  // 首次探测成功（触发 start），之后持续失败（模拟 Keychain 随后不可用）。
  let probeCalls = 0;
  const probeStorage = async () => {
    probeCalls += 1;
    return probeCalls === 1;
  };

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
    probeStorage,
    timing: { retryDelayMs: 1, maxRetries: 2, recoveryDelayMs: 100000 },
  });

  ctrl.start(); // active → 先入队 stop（FINAL-1）→ probe 成功 → start 入队（在途）
  await tick();
  await tick();
  // 🍎 FINAL-1：进入 active 且带 probe 时先入队 stop（probe 等待窗口内不得遗留
  //   运行中的 ticker）。因此串行链上第一个在途调用是 stop，需先排空它，
  //   才能观察到随后入队的 start。这不改变 BLOCK-A-2 的语义（过期 stop 不得被跳过）。
  if (auth.inflight.length > 0 && auth.inflight[0].kind === 'stop') {
    auth.inflight[0].deferred.resolve();
    await tick();
    await tick();
  }
  assert.equal(auth.calls.start, 1, '前置：首次探测成功应发起一次 start');
  assert.equal(auth.inflightCount(), 1, '前置：start 应处于在途（未 resolve）');
  assert.equal(auth.inflight[0].kind, 'start', '前置：在途调用应为 start');

  // background：stop 排在在途 start 之后（此时尚未执行）
  appState.emit('background');
  await tick();

  // active：decisionSeq++ → 已排队的 stop 变为过期
  appState.emit('active');
  await tick();

  // resolve 在途 start → ticker 运行；过期 stop 随后执行（旧实现会跳过）
  auth.inflight[0].deferred.resolve();
  await tick();
  await tick();
  await tick();

  // 给后续 probe 重试与串行链足够时间（不 dispose：模拟 App 仍在前台运行）。
  await drainInflight(auth);

  // 断言必须在 dispose 之前：dispose 自身会入队 stop，若先 dispose 会掩盖缺陷。
  // 用 try/finally 保证即使断言失败也会 dispose 清除 recovery 定时器。
  try {
    assert.ok(
      auth.calls.stop >= 1,
      `BLOCK-A：过期 stop 不得被简单跳过，probe 不可用时必须真正停止 ticker，实际 stop=${auth.calls.stop}`
    );
    assert.equal(
      auth.running,
      false,
      'BLOCK-A：probe 不可用时真实 ticker 必须停止（不得残留旧 ticker）'
    );
  } finally {
    // 清理：dispose 清除 recovery 定时器，再排空在途调用。
    ctrl.dispose();
    await drainInflight(auth, 20);
  }
});

// ===========================================================================
// FINAL-1（P0.3 FINAL L4 收尾）— probe 等待窗口内不得遗留运行中的 ticker
//
// L4 用真实控制器复现：
//   · SDK ticker 初始 running=true（autoRefreshToken:true 在 RN 非浏览器环境永不停）。
//   · controller.start()，probeStorage 返回**尚未完成的 Promise**。
//   · probe 未完成期间，stopAutoRefresh 从未被调用 → ticker 持续运行。
//   · 直到 probe 返回 false，才停止。
//
// 根因：`startWithProbe` 只在 probe 的 `.then()` 回调里 enqueueOp('stop')。
//       probe Promise 处于 pending 期间，没有任何 stop 入队，SDK 初始化遗留的
//       ticker 一直运行（每次 tick 都可能读 SecureStore 抛错）。
//
// 要求：在认证存储可用性尚未确认（probe pending）时，不允许遗留的自动刷新
//       ticker 持续运行 —— 进入 active 且带 probe 时，必须**先停 ticker**，
//       待 probe 确认可用后才 start。必须保留串行化 / 恢复 / dispose 逻辑。
// ===========================================================================
test('FINAL-1 probe pending 期间必须已停止 SDK 初始化遗留的 ticker（不得等待 probe 结果）', async () => {
  // SDK 初始化阶段已启动 ticker：running=true，无在途调用。
  const auth = createControllableAuth(true);
  const appState = createFakeAppState('active');
  const errors = [];

  // probe 返回一个**永不 resolve** 的 Promise：模拟 Keychain 探测挂起窗口。
  const probeStorage = () => new Promise(() => {});

  const ctrl = createAutoRefreshController({
    auth,
    appState,
    onError: (e) => errors.push(e),
    probeStorage,
    timing: { retryDelayMs: 1, maxRetries: 2, recoveryDelayMs: 100000 },
  });

  ctrl.start(); // active → probe pending（永不 resolve）

  // 给串行链足够时间执行「进入 active 时应立即入队的 stop」。
  // 注意：probe 永不 resolve，因此这里**不能**用 drainInflight（它会尝试 resolve
  // 在途调用，但 probe 不是 auth 在途调用）。只需排空微任务 + 让 stop 完成。
  for (let i = 0; i < 20; i += 1) {
    // 排空 auth 在途调用（stop 本身），但不触碰 probe。
    if (auth.inflight.length > 0) auth.inflight[0].deferred.resolve();
    await tick();
    await new Promise((r) => setTimeout(r, 2));
  }

  try {
    assert.ok(
      auth.calls.stop >= 1,
      `FINAL-1：probe pending 期间必须已调用 stopAutoRefresh 停止 SDK 初始化遗留的 ticker，实际 stop=${auth.calls.stop}`
    );
    assert.equal(
      auth.running,
      false,
      'FINAL-1：probe 未确认可用前，不得遗留仍在运行的 ticker'
    );
    assert.equal(
      auth.calls.start,
      0,
      'FINAL-1：probe 未确认可用前，不得启动新 ticker'
    );
  } finally {
    ctrl.dispose();
    // 清理：probe 永不 resolve，dispose 后无需排空 probe；仅排空 auth 在途调用。
    for (let i = 0; i < 20; i += 1) {
      if (auth.inflight.length > 0) auth.inflight[0].deferred.resolve();
      await tick();
    }
  }
});

// --- END OF FILE tests/security/ios01AsyncRaceAndRecovery.test.mjs ---
