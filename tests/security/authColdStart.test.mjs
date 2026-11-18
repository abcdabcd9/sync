// --- START OF FILE tests/security/authColdStart.test.mjs ---
/**
 * TASK-P0.2 T6.2 — FIX-06 真实 SDK 异常冷启动回归测试
 *
 * 为什么需要这个文件（与 authSdkContract.test.mjs 的区别）：
 *   `authSdkContract.test.mjs` 的 S1/S2 是「SDK 健康初始化完成后再注入读故障」，
 *   它验证的是「运行期存储突然不可用」的契约。
 *
 *   但 FIX-06 明确要求验证**真实异常冷启动**：
 *   应用进程刚启动、`createClient()` 构造的那一刻，SecureStore 就已经不可用
 *   （例如设备刚重启、Keychain 尚未解锁、系统升级后 Keystore 迁移中）。
 *   这种场景**不能**用「健康初始化后再注入故障」替代，因为：
 *     · 构造期 `_emitInitialSession()` 是 fire-and-forget，其 rejection 走的是
 *       unhandledRejection 通道，而不是 `getSession()` 的返回通道；
 *     · 上层 `useAuth` 在冷启动时先读状态位、再决定是否重试，路径与运行期不同。
 *
 * 实现要点（为什么在模块顶层构造客户端）：
 *   真实冷启动的 rejection 发生在 `createClient()` 构造期，是 fire-and-forget 的
 *   unhandledRejection。若在 `test()` 回调内部构造，node:test 会把该 rejection
 *   归因到「当前正在运行的测试」并判为失败 —— 这不是被测代码的缺陷，而是
 *   测试框架的归因机制。因此本文件在**模块加载期**（任何 test 运行之前）就
 *   构造好所有冷启动客户端，让 rejection 在模块加载阶段结算，测试回调只对
 *   已结算的状态做断言。这样既保留了「故障在构造前注入」的真实冷启动语义，
 *   又避免 node:test 误归因。
 *
 * 覆盖：
 *   C1 冷启动即读失败 → 构造期产生 AUTH_STORAGE_UNAVAILABLE 的 unhandledRejection
 *   C2 冷启动即读失败 → 适配器状态位在构造后即为故障（上层唯一可靠信号）
 *   C3 冷启动即读失败 → getSession() reject（调用方路径）
 *   C4 故障恢复：清除故障后重试 getSession() 成功，状态位清除
 *   C5 异常冷启动下的登出：删除失败 → 状态位保持故障（不误判已登出）
 *   C6 异常冷启动下的登出：删除成功 → 状态位清除（登出真正生效）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '@supabase/supabase-js';

import {
  AUTH_STORAGE_ERROR,
  createAuthStorageStatus,
  createSecureStoreAdapter,
} from '../../src/services/authStorage.js';

// ---------------------------------------------------------------------------
// 原生模块 fake（仅替换硬件边界）
// ---------------------------------------------------------------------------

function createFakeSecureStore({ failGet = false, failSet = false, failDelete = false } = {}) {
  const map = new Map();
  return {
    map,
    failGet,
    failSet,
    failDelete,
    async getItemAsync(key) {
      if (this.failGet) throw new Error('secure get failed');
      return map.has(key) ? map.get(key) : null;
    },
    async setItemAsync(key, value) {
      if (this.failSet) throw new Error('secure set failed');
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      if (this.failDelete) throw new Error('secure delete failed');
      map.delete(key);
    },
  };
}

function createFakeAsyncStorage() {
  const map = new Map();
  return {
    map,
    async getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

const silentLogger = { error() {}, warn() {}, log() {} };

const STORAGE_KEY = 'sb-coldstart-auth-token';
const SESSION = {
  access_token: 'header.payload.signature',
  refresh_token: 'refresh-token-value',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'coldstart@example.test' },
};

// ---------------------------------------------------------------------------
// 全局 unhandledRejection 守卫（模块加载期即注册，早于任何 createClient）
// ---------------------------------------------------------------------------

const capturedRejections = [];
process.on('unhandledRejection', (reason) => {
  if (reason && typeof reason.code === 'string' && reason.code.startsWith('AUTH_STORAGE_')) {
    capturedRejections.push(reason);
    return;
  }
  throw reason;
});

async function flushAsync(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 构造真实 SDK + 真实适配器客户端。
 * 调用方必须在调用本函数**之前**就把 secureStore 置为故障态，以模拟真实冷启动。
 */
function makeClient({ secureStore, asyncStorage, status }) {
  const adapter = createSecureStoreAdapter({
    secureStore,
    asyncStorage,
    logger: silentLogger,
    status,
  });
  const client = createClient('https://coldstart.supabase.co', 'test-anon-key', {
    auth: {
      storage: adapter,
      storageKey: STORAGE_KEY,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  const initSettled = Promise.resolve(client.auth.initializePromise).catch(() => {});
  return { client, adapter, initSettled };
}

// ---------------------------------------------------------------------------
// 模块加载期：构造所有冷启动客户端（故障在 createClient 之前注入）
//
// 这是本文件与 authSdkContract.test.mjs 的核心差异：故障注入点前移到构造之前，
// 且构造发生在任何 test() 运行之前，从而让构造期 unhandledRejection 在模块
// 加载阶段结算，不被 node:test 误归因到某个测试。
// ---------------------------------------------------------------------------

// C1/C2/C3 共用：冷启动读失败
const coldReadFail = (() => {
  const secureStore = createFakeSecureStore({ failGet: true });
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const built = makeClient({ secureStore, asyncStorage, status });
  return { secureStore, asyncStorage, status, ...built };
})();

// C4：冷启动读失败，随后恢复
const coldRecover = (() => {
  const secureStore = createFakeSecureStore({ failGet: true });
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const built = makeClient({ secureStore, asyncStorage, status });
  return { secureStore, asyncStorage, status, ...built };
})();

// C5：冷启动读失败 + 删除失败
const coldDeleteFail = (() => {
  const secureStore = createFakeSecureStore({ failGet: true, failDelete: true });
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const built = makeClient({ secureStore, asyncStorage, status });
  return { secureStore, asyncStorage, status, ...built };
})();

// C6：冷启动读失败，但删除可用
const coldDeleteOk = (() => {
  const secureStore = createFakeSecureStore({ failGet: true });
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const built = makeClient({ secureStore, asyncStorage, status });
  return { secureStore, asyncStorage, status, ...built };
})();

// ---------------------------------------------------------------------------
// 模块加载期排空：让所有构造期 fire-and-forget rejection 在**任何 test 运行之前**
// 结算完毕。
//
// 为什么必须在这里排空：
//   SDK 的 `_emitInitialSession()` 是 fire-and-forget，其 rejection 在构造后
//   的微任务/宏任务中结算。若结算发生在某个 test 运行期间，node:test 会把该
//   unhandledRejection 归因到「当前测试」并判其失败；若发生在所有 test 之后，
//   node:test 会报 "asynchronous activity after the test ended" 并判整个文件失败。
//   只有在**模块加载期**（test 尚未开始）排空，才能既保留真实冷启动语义，
//   又不被测试框架误归因。顶层 await 在 ESM 中先于所有 test 执行。
// ---------------------------------------------------------------------------
await flushAsync(32);

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('C1 真实异常冷启动：构造期读失败产生 AUTH_STORAGE_UNAVAILABLE 的 unhandledRejection', async () => {
  await coldReadFail.initSettled;
  await flushAsync();

  assert.ok(
    capturedRejections.length >= 1,
    '冷启动读失败必须产生至少一次 AUTH_STORAGE_* unhandledRejection'
  );
  assert.equal(
    capturedRejections[0].code,
    AUTH_STORAGE_ERROR.UNAVAILABLE,
    '构造期 rejection 的错误码必须是 AUTH_STORAGE_UNAVAILABLE'
  );
});

test('C2 真实异常冷启动：构造完成后适配器状态位即为故障', async () => {
  await coldReadFail.initSettled;
  await flushAsync();

  // 上层 useAuth 在冷启动时依赖状态位判断「存储不可用」，而非依赖 SDK 是否抛出
  assert.equal(coldReadFail.status.isFailed(), true, '冷启动读失败后状态位必须为故障');
  assert.equal(coldReadFail.status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);
});

test('C3 真实异常冷启动：getSession() reject 出 AUTH_STORAGE_UNAVAILABLE', async () => {
  await coldReadFail.initSettled;
  await flushAsync();

  await assert.rejects(
    () => coldReadFail.client.auth.getSession(),
    (err) => {
      assert.equal(err.code, AUTH_STORAGE_ERROR.UNAVAILABLE);
      return true;
    },
    '冷启动读失败时 getSession() 必须 reject 出 AUTH_STORAGE_UNAVAILABLE'
  );
});

test('C4 真实异常冷启动 → 故障恢复：清除故障后重试 getSession() 成功且状态位清除', async () => {
  await coldRecover.initSettled;
  await flushAsync();

  // 冷启动阶段确认处于故障态
  assert.equal(coldRecover.status.isFailed(), true, '恢复前应处于故障态');

  // 模拟用户解锁设备 / 系统恢复 Keychain：故障解除
  coldRecover.secureStore.failGet = false;

  // 先写入一份有效会话（等价于用户重新登录成功）
  await coldRecover.adapter.setItem(STORAGE_KEY, JSON.stringify(SESSION));

  // 重试读取：必须成功，且状态位被清除
  const { data, error } = await coldRecover.client.auth.getSession();
  assert.equal(error, null, '故障恢复后 getSession() 不应报错');
  assert.ok(data.session, '故障恢复后应能读回会话');
  assert.equal(data.session.access_token, SESSION.access_token);
  assert.equal(coldRecover.status.isFailed(), false, '故障恢复后状态位必须清除');
});

test('C5 真实异常冷启动下的登出：删除失败 → 状态位保持故障（不误判已登出）', async () => {
  await coldDeleteFail.initSettled;
  await flushAsync();

  // 登出：SDK 可能抛出也可能吞掉，两种情况下状态位都必须保持故障
  await coldDeleteFail.client.auth.signOut().catch(() => {});
  await flushAsync();

  assert.equal(coldDeleteFail.status.isFailed(), true, '异常冷启动下登出删除失败必须保持故障态');
  assert.equal(coldDeleteFail.status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);
});

test('C6 真实异常冷启动 → 存储恢复后登出：状态位清除（登出真正生效）', async () => {
  await coldDeleteOk.initSettled;
  await flushAsync();

  // 冷启动阶段确认处于故障态
  assert.equal(coldDeleteOk.status.isFailed(), true, '登出前应处于故障态');

  // 模拟存储整体恢复（读通道也恢复）：此时登出才能完整走通
  // 注意：若读通道仍故障，SDK 在 signOut 内部会再次读会话并重新置故障态，
  // 这是正确行为（存储确实仍不可用），故本用例验证「恢复后登出」的干净路径。
  coldDeleteOk.secureStore.failGet = false;

  // 登出：删除成功即代表登出真正生效，状态位应被清除
  await coldDeleteOk.client.auth.signOut().catch(() => {});
  await flushAsync();

  assert.equal(coldDeleteOk.status.isFailed(), false, '存储恢复后登出成功，状态位必须清除');
});

test('C7 收尾：等待所有构造期异步 rejection 结算，避免泄漏到测试文件之外', async () => {
  // SDK 的 _emitInitialSession 是 fire-and-forget，其 rejection 可能在
  // 前面用例结束后才结算。这里显式等待足够轮次，让所有 AUTH_STORAGE_*
  // rejection 都被模块级守卫捕获，而不是在测试文件结束后才冒出来
  // （否则 node:test 会报 "asynchronous activity after the test ended"）。
  await flushAsync(24);
  // 所有冷启动客户端都已构造过，至少应捕获到多次读失败 rejection
  assert.ok(capturedRejections.length >= 1, '应已捕获构造期 rejection');
  assert.ok(
    capturedRejections.every((r) => r.code === AUTH_STORAGE_ERROR.UNAVAILABLE),
    '捕获的 rejection 必须全部是 AUTH_STORAGE_UNAVAILABLE'
  );
});

// --- END OF FILE tests/security/authColdStart.test.mjs ---
