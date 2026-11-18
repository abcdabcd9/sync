// --- START OF FILE tests/security/realtimeAuthRevoke.test.mjs ---
/**
 * TASK-P0.2 / T6.2 — FIX-05 Realtime 授权撤销回归测试
 *
 * 背景（REVIEW_RESOLUTION 剩余风险 R1 / FIX-05）：
 *   迁移 27 把 partner_authorizations 加入 Realtime 白名单后，客户端订阅
 *   UPDATE 事件感知对方解绑。但旧实现依赖 `payload.old.status === 'accepted'`
 *   判断「曾经有效 → 现在失效」。
 *
 *   问题：Supabase Realtime 的 postgres_changes UPDATE 事件，只有在表设置了
 *   `REPLICA IDENTITY FULL` 时才会在 `payload.old` 里带上旧列值；否则
 *   `payload.old` 只包含主键（id）。本表（迁移 20）并未设置 FULL，因此
 *   `payload.old.status` 恒为 undefined，撤销事件被**静默丢弃** —— 双方都在
 *   前台时，被解绑方永远看不到搭子卡片消失。
 *
 * 修复原则（FIX-05）：
 *   1. **绝不依赖 `payload.old.status`**；
 *   2. 收到相关 UPDATE 事件后，**重新向服务端权威复验**（get_active_partner_id）；
 *   3. 以服务端返回的有效搭子为准决定是否撤销；
 *   4. 账号切换 / 主动解绑后，旧异步结果不得写回（代际令牌）。
 *
 * 本测试直接 import 生产代码导出的纯函数，断言的是真实实现，而非复刻逻辑。
 *
 * 覆盖：
 *   R1  payload.old 只有主键（无 status）时，事件仍被判定为「相关」→ 触发复验
 *   R2  事件涉及其它用户（双方都不是 pId）→ 不相关，不触发复验
 *   R3  payload.new 缺少双方字段（无法排除相关性）→ 保守判定为相关
 *   R4  服务端复验返回 null（已解绑）→ 应撤销
 *   R5  服务端复验返回不同 id（已换人）→ 应撤销
 *   R6  服务端复验返回同一 pId（仍有效）→ 不撤销
 *   R7  服务端复验出错（网络异常）→ 不撤销（保持现状，避免抖动误删）
 *   R8  源码静态断言：subscribeAuthorization 不再读取 payload.old.status
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRevokeVerifier,
  isAuthEventRelevant,
  shouldRevokeOnAuthChange,
} from '../../src/hooks/health/authRevokeLogic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const hookPath = path.join(repoRoot, 'src/hooks/health/useHealthCloud.js');

const P_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

// ---------------------------------------------------------------------------
// R1：payload.old 只有主键（无 status）时，事件仍被判定为相关
// ---------------------------------------------------------------------------
test('R1 payload.old 无 status 时仍判定为相关（不依赖 old.status）', () => {
  const payload = {
    // 真实 Realtime 在未设 REPLICA IDENTITY FULL 时的 old 只有主键
    old: { id: 'auth-1' },
    new: {
      id: 'auth-1',
      requester_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      addressee_id: P_ID,
      status: 'revoked',
    },
  };
  assert.equal(isAuthEventRelevant(payload, P_ID), true);
});

// ---------------------------------------------------------------------------
// R2：事件涉及其它用户 → 不相关
// ---------------------------------------------------------------------------
test('R2 事件双方都不是当前搭子 → 不相关', () => {
  const payload = {
    old: { id: 'auth-2' },
    new: {
      id: 'auth-2',
      requester_id: 'cccccccc-0000-0000-0000-000000000003',
      addressee_id: 'dddddddd-0000-0000-0000-000000000004',
      status: 'revoked',
    },
  };
  assert.equal(isAuthEventRelevant(payload, P_ID), false);
});

// ---------------------------------------------------------------------------
// R3：payload.new 缺少双方字段 → 保守判定为相关（交给服务端复验兜底）
// ---------------------------------------------------------------------------
test('R3 payload.new 缺少双方字段 → 保守判定为相关', () => {
  const payload = { old: { id: 'auth-3' }, new: { id: 'auth-3' } };
  assert.equal(isAuthEventRelevant(payload, P_ID), true);
});

// ---------------------------------------------------------------------------
// R4：服务端复验返回 null（已解绑）→ 应撤销
// ---------------------------------------------------------------------------
test('R4 复验返回 null → 应撤销', () => {
  assert.equal(shouldRevokeOnAuthChange({ data: null, error: null }, P_ID), true);
});

// ---------------------------------------------------------------------------
// R5：服务端复验返回不同 id（已换人）→ 应撤销
// ---------------------------------------------------------------------------
test('R5 复验返回不同 id → 应撤销', () => {
  assert.equal(
    shouldRevokeOnAuthChange({ data: 'eeeeeeee-0000-0000-0000-000000000005', error: null }, P_ID),
    true
  );
});

// ---------------------------------------------------------------------------
// R6：服务端复验返回同一 pId（仍有效）→ 不撤销
// ---------------------------------------------------------------------------
test('R6 复验返回同一 pId → 不撤销', () => {
  assert.equal(shouldRevokeOnAuthChange({ data: P_ID, error: null }, P_ID), false);
});

// ---------------------------------------------------------------------------
// R7：服务端复验出错（网络异常）→ 不撤销（保持现状）
// ---------------------------------------------------------------------------
test('R7 复验出错 → 不撤销（保持现状）', () => {
  assert.equal(
    shouldRevokeOnAuthChange({ data: null, error: { message: 'network' } }, P_ID),
    false
  );
});

// ---------------------------------------------------------------------------
// R8：源码静态断言 —— subscribeAuthorization 不再读取 payload.old.status
// ---------------------------------------------------------------------------
test('R8 源码不再依赖 payload.old.status', async () => {
  const src = await fs.readFile(hookPath, 'utf8');

  // 定位 subscribeAuthorization 函数体（从定义到下一个 useCallback 结束）
  const startIdx = src.indexOf('const subscribeAuthorization = useCallback');
  assert.ok(startIdx >= 0, '未找到 subscribeAuthorization 定义');

  // 截取到 subscribePartner 定义之前，作为该函数体的近似范围
  const endIdx = src.indexOf('const subscribePartner = useCallback', startIdx);
  assert.ok(endIdx > startIdx, '未找到 subscribePartner 定义作为边界');
  const body = src.slice(startIdx, endIdx);

  // 去掉注释后再做静态断言：注释里可以解释「不依赖 payload.old.status」，
  // 但可执行代码里绝不能真的读取它。
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/\/\/[^\n]*/g, ''); // 行注释

  // 关键断言：可执行代码里不得出现对 old.status 的读取
  assert.equal(
    /payload\.old\s*\.\s*status/.test(codeOnly),
    false,
    'subscribeAuthorization 仍读取 payload.old.status（FIX-05 未修复）'
  );
  assert.equal(
    /prev\.status/.test(codeOnly),
    false,
    'subscribeAuthorization 仍读取 prev.status（FIX-05 未修复）'
  );

  // 必须调用服务端权威复验 RPC
  assert.ok(
    codeOnly.includes("rpc('get_active_partner_id')"),
    'subscribeAuthorization 未调用 get_active_partner_id 复验权威状态'
  );

  // T6.2 收尾：必须使用复验协调器（生产与测试共用同一状态机）
  assert.ok(
    codeOnly.includes('createRevokeVerifier'),
    'subscribeAuthorization 未使用 createRevokeVerifier 协调器'
  );
});

// ---------------------------------------------------------------------------
// T6.2 收尾：复验竞争回归测试（verifying 期间新事件不得被丢弃）
//
// 缺陷：旧实现在 verifying=true 时直接 return 丢弃后续事件。但当前这次复验
// 的 RPC 可能早于「新事件所代表的状态变更」发出，其返回结果无法反映最新
// 状态 —— 撤销可能被漏掉。
//
// 正确语义：复验期间收到新事件 → 标记 pending；当前复验结束后若 pending，
// 立即再复验一次，直到没有新事件为止（合并连续事件，但绝不丢弃最后一次）。
//
// 这些测试直接驱动生产代码导出的 createRevokeVerifier 状态机。
// ---------------------------------------------------------------------------

// 可手动控制 resolve 时机的 deferred，用于精确构造「复验进行中」窗口
function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 让出事件循环，等待所有已排队的 microtask / 已 resolve 的 promise 结算
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// R9：复验进行中收到新事件 → 当前复验结束后必须再次复验（不丢弃）
// ---------------------------------------------------------------------------
test('R9 复验期间新事件 → 结束后再次复验（不丢弃最后一次）', async () => {
  const calls = [];
  const results = [];
  const deferreds = [];

  const verifier = createRevokeVerifier({
    verify: () => {
      const d = makeDeferred();
      deferreds.push(d);
      calls.push(deferreds.length);
      return d.promise;
    },
    onResult: (r) => results.push(r),
  });

  // 第一次触发 → 进入 verifying，verify 挂起
  verifier.trigger();
  await flush();
  assert.equal(calls.length, 1, '首次触发应发起一次复验');
  assert.equal(verifier.isVerifying(), true, '首次复验应处于进行中');

  // 复验进行中又收到新事件 → 不得丢弃，应标记 pending
  verifier.trigger();
  verifier.trigger();
  await flush();
  assert.equal(calls.length, 1, '复验进行中不应并发发起新复验（合并）');

  // 结束第一次复验 → 因 pending 应立即再复验一次
  deferreds[0].resolve({ data: null, error: null });
  await flush();
  assert.equal(calls.length, 2, '第一次复验结束后应因 pending 再复验一次');

  // 结束第二次复验 → 无新事件，不再复验
  deferreds[1].resolve({ data: null, error: null });
  await flush();
  assert.equal(calls.length, 2, '无新事件时不应无限复验');
  assert.equal(verifier.isVerifying(), false, '全部结束后应退出 verifying');

  // 两次复验结果都应被消费（撤销决策基于最新一次）
  assert.equal(results.length, 2, '两次复验结果都应回调 onResult');
});

// ---------------------------------------------------------------------------
// R10：连续多条事件在复验期间到达 → 只合并为「结束后再复验一次」
// ---------------------------------------------------------------------------
test('R10 复验期间多条事件合并为一次补复验', async () => {
  const calls = [];
  const deferreds = [];

  const verifier = createRevokeVerifier({
    verify: () => {
      const d = makeDeferred();
      deferreds.push(d);
      calls.push(deferreds.length);
      return d.promise;
    },
    onResult: () => {},
  });

  verifier.trigger();
  await flush();
  assert.equal(calls.length, 1);

  // 复验进行中连发 5 条事件
  for (let i = 0; i < 5; i += 1) verifier.trigger();
  await flush();
  assert.equal(calls.length, 1, '复验进行中不应并发发起');

  deferreds[0].resolve({ data: null, error: null });
  await flush();
  // 5 条事件合并为 1 次补复验
  assert.equal(calls.length, 2, '多条事件应合并为一次补复验');

  deferreds[1].resolve({ data: null, error: null });
  await flush();
  assert.equal(calls.length, 2, '补复验后无新事件则停止');
});

// ---------------------------------------------------------------------------
// R11：代际失效（isStale）→ 丢弃结果且不再复验
// ---------------------------------------------------------------------------
test('R11 代际失效时丢弃结果且不再复验', async () => {
  let stale = false;
  const calls = [];
  const results = [];
  const deferreds = [];

  const verifier = createRevokeVerifier({
    isStale: () => stale,
    verify: () => {
      const d = makeDeferred();
      deferreds.push(d);
      calls.push(deferreds.length);
      return d.promise;
    },
    onResult: (r) => results.push(r),
  });

  verifier.trigger();
  await flush();
  assert.equal(calls.length, 1);

  // 复验进行中收到新事件（标记 pending），随后代际失效
  verifier.trigger();
  stale = true;

  deferreds[0].resolve({ data: null, error: null });
  await flush();

  // 代际失效 → 结果被丢弃，且 pending 不再触发补复验
  assert.equal(results.length, 0, '代际失效后结果不得回调 onResult');
  assert.equal(calls.length, 1, '代际失效后不得再复验');
  assert.equal(verifier.isVerifying(), false, '代际失效后应退出 verifying');
});

// ---------------------------------------------------------------------------
// R12：verify 抛异常 → 不崩溃，verifying 复位，pending 仍可补复验
// ---------------------------------------------------------------------------
test('R12 verify 抛异常时状态机不崩溃且可继续', async () => {
  let shouldThrow = true;
  const calls = [];
  const results = [];

  const verifier = createRevokeVerifier({
    verify: async () => {
      calls.push(calls.length + 1);
      if (shouldThrow) throw new Error('network boom');
      return { data: null, error: null };
    },
    onResult: (r) => results.push(r),
  });

  // 第一次 verify 抛异常 → trigger 返回的 promise 应 reject（由调用方 catch）
  await assert.rejects(() => verifier.trigger(), /network boom/);
  assert.equal(verifier.isVerifying(), false, '异常后 verifying 必须复位');

  // 恢复后再次触发应正常工作
  shouldThrow = false;
  await verifier.trigger();
  assert.equal(results.length, 1, '恢复后应正常回调 onResult');
  assert.equal(verifier.isVerifying(), false);
});

// ---------------------------------------------------------------------------
// R13：finally 内的补充复验失败 → 不得产生 unhandledRejection
//
// 缺陷：finally 里 `run()` 是 fire-and-forget，若补充复验的 verify() 抛错，
// 该 Promise 无人接管 → Node 触发 unhandledRejection（生产环境可能终止进程）。
// 修复：`run().catch(() => {})`。
//
// 构造：第一次复验进行中收到新事件（标记 pending）→ 第一次成功结束 →
// 触发补充复验，且该次 verify() 抛错。整个过程中不得出现 unhandledRejection。
// ---------------------------------------------------------------------------
test('R13 补充复验失败不产生 unhandledRejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const calls = [];
    const deferreds = [];
    let throwOnSecond = true;

    const verifier = createRevokeVerifier({
      verify: () => {
        calls.push(calls.length + 1);
        // 第二次（补充复验）直接抛错，模拟网络异常
        if (calls.length === 2 && throwOnSecond) {
          return Promise.reject(new Error('supplementary boom'));
        }
        const d = makeDeferred();
        deferreds.push(d);
        return d.promise;
      },
      onResult: () => {},
    });

    // 首次触发 → 进入 verifying
    verifier.trigger();
    await flush();
    assert.equal(calls.length, 1, '首次触发应发起一次复验');

    // 复验进行中收到新事件 → 标记 pending
    verifier.trigger();
    await flush();

    // 结束第一次复验 → 因 pending 触发补充复验（该次 verify 抛错）
    deferreds[0].resolve({ data: null, error: null });
    // 多轮让出事件循环，确保补充复验的 rejection 有机会被上报
    await flush(16);

    assert.equal(calls.length, 2, '应触发一次补充复验');
    assert.equal(
      unhandled.length,
      0,
      `补充复验失败产生了 unhandledRejection: ${unhandled.map(String).join('; ')}`
    );
    assert.equal(verifier.isVerifying(), false, '补充复验失败后 verifying 必须复位');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// R14：补充复验失败后状态机仍可用（下一次事件可正常复验）
// ---------------------------------------------------------------------------
test('R14 补充复验失败后状态机仍可继续工作', async () => {
  const results = [];
  const deferreds = [];
  let callCount = 0;

  // 第 1 次：挂起（首次复验）
  // 第 2 次：抛错（补充复验失败）
  // 第 3 次及以后：正常返回
  const verifier = createRevokeVerifier({
    verify: () => {
      callCount += 1;
      if (callCount === 1) {
        const d = makeDeferred();
        deferreds.push(d);
        return d.promise;
      }
      if (callCount === 2) {
        return Promise.reject(new Error('supplementary boom'));
      }
      return Promise.resolve({ data: null, error: null });
    },
    onResult: (r) => results.push(r),
  });

  // 首次触发 → 挂起
  verifier.trigger();
  await flush();
  assert.equal(callCount, 1);

  // 复验进行中收到新事件 → 标记 pending
  verifier.trigger();
  await flush();

  // 结束首次复验 → 触发补充复验（第 2 次，抛错，被 catch 吞掉）
  deferreds[0].resolve({ data: null, error: null });
  await flush(16);
  assert.equal(callCount, 2, '应触发一次补充复验');
  assert.equal(verifier.isVerifying(), false, '补充复验失败后应复位');
  assert.equal(results.length, 1, '仅首次复验结果被消费');

  // 状态机仍可继续：再次触发应正常完成（第 3 次）
  await verifier.trigger();
  assert.equal(callCount, 3, '失败后应仍可发起新复验');
  assert.equal(results.length, 2, '失败后状态机应仍可正常回调 onResult');
  assert.equal(verifier.isVerifying(), false);
});
// --- END OF FILE tests/security/realtimeAuthRevoke.test.mjs ---
