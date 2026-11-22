// --- START OF FILE tests/security/authSdkContract.test.mjs ---
/**
 * TASK-P0.2 Batch C — 真实 Supabase Auth SDK 契约测试（C03）
 *
 * 为什么需要这个文件：
 *   `authStorage.test.mjs` 验证的是**适配器自身**的行为（注入 fake 原生模块）。
 *   但 Gemini P1-1 指出的风险不在适配器，而在 **SDK 与适配器的交互契约**：
 *   存储读失败时，SDK 到底把异常抛给调用方，还是吞掉后 resolve 出
 *   `{ data: { session: null }, error: null }`？两种行为对上层是完全不同的处理路径。
 *
 *   如果只测适配器，这个契约永远不会被验证 —— 适配器抛错、SDK 吞掉、
 *   上层误判登出，测试全绿但线上出事故。
 *
 * 本文件的做法：
 *   使用**真实已安装的** `@supabase/supabase-js`（2.118.0）的 `createClient`，
 *   注入**真实**的 `createSecureStoreAdapter`，只把最底层的原生模块
 *   （expo-secure-store / AsyncStorage）替换为可注入故障的内存实现。
 *   这样 SDK 内部逻辑、适配器逻辑都是生产代码，只有硬件边界是 fake。
 *
 * 实测结论（2.118.0，见 S1/S2）：
 *   Gemini P1-1 的前提「GoTrue 吞掉 getItem 异常、getSession() 正常 resolve」
 *   在本版本**不成立**：`getSession()` 会 **reject** 出适配器的
 *   `AUTH_STORAGE_UNAVAILABLE`。原因是 `_recoverAndRefresh()` 的 catch 只覆盖
 *   其内部逻辑，而 `initializePromise` 在构造时被 fire-and-forget 创建，
 *   其 rejection 既会传给 `getSession()`，也会产生一次 unhandledRejection。
 *
 *   因此本文件断言的是**真实行为**，而不是审查报告里的假设：
 *   - `getSession()` reject（上层 `.catch` 会触发）
 *   - 适配器状态位同时被置为故障（`onAuthStateChange` 路径与构造期
 *     unhandledRejection 场景下，状态位是唯一可靠信号）
 *
 * 覆盖：
 *   S1 真实 SDK 初始化时 SecureStore 读失败 → getSession() **reject**（实测契约）
 *   S2 同一场景下，适配器状态位被置为故障（与 S1 互补的可靠信号）
 *   S3 真实 SDK 正常路径：写入后 getSession() 能读回会话
 *   S4 真实 SDK 登出：removeItem 被调用，状态位清除
 *   S5 真实 SDK 登出时 SecureStore 删除失败 → 状态位保持故障
 *   S6 真实 SDK 不向 AsyncStorage 写明文（storageKey 只落 SecureStore）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '@supabase/supabase-js';

import {
  AUTH_STORAGE_ERROR,
  createAuthStorageStatus,
  createSecureStoreAdapter,
} from '../../src/services/authStorage.ts';

// ---------------------------------------------------------------------------
// 原生模块 fake（仅替换硬件边界，不替换适配器/SDK 逻辑）
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

const STORAGE_KEY = 'sb-contracttest-auth-token';
// 一个结构合法但签名无效的会话：SDK 只做结构校验，不会联网验证
const SESSION = {
  access_token: 'header.payload.signature',
  refresh_token: 'refresh-token-value',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'contract@example.test' },
};

// ---------------------------------------------------------------------------
// 全局 unhandledRejection 守卫
//
// `createClient` 在**构造时**就 fire-and-forget 地启动 `_emitInitialSession()`
// → `_useSession()` → `__loadSession()` → `storage.getItem()`。当存储读失败时，
// 这条链路的 rejection 在 `createClient()` 返回之前就已经被排入微任务队列，
// 且**无人 await**，因此必然产生一次 `unhandledRejection`。
//
// 这是 SDK 的真实行为，不是测试缺陷。必须在**模块加载时**（早于任何
// `createClient` 调用）就注册守卫，否则 Node 测试运行器会把它归因到
// 当前测试并判为失败。守卫只收集带 `AUTH_STORAGE_*` 码的 rejection，
// 其它 rejection 原样放行，避免掩盖真实问题。
// ---------------------------------------------------------------------------

const capturedRejections = [];
process.on('unhandledRejection', (reason) => {
  if (reason && typeof reason.code === 'string' && reason.code.startsWith('AUTH_STORAGE_')) {
    capturedRejections.push(reason);
    return;
  }
  // 非认证存储相关的 rejection 不应被静默吞掉
  throw reason;
});

/** 清空已收集的 rejection（每个用例开始前调用） */
function resetCapturedRejections() {
  capturedRejections.length = 0;
}

/** 等待若干轮宏任务，让 SDK 构造期的异步初始化有机会跑完 */
async function flushAsync(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 构造一个使用真实 SDK + 真实适配器的客户端。
 *
 * 返回的 `initSettled` 是 SDK 内部 `initializePromise` 的 settled 版本
 * （永不 reject），用于在断言前确保构造期初始化已经跑完。
 */
function makeClient({ secureStore, asyncStorage, status }) {
  const adapter = createSecureStoreAdapter({
    secureStore,
    asyncStorage,
    logger: silentLogger,
    status,
  });
  const client = createClient('https://contracttest.supabase.co', 'test-anon-key', {
    auth: {
      storage: adapter,
      storageKey: STORAGE_KEY,
      autoRefreshToken: false, // 避免测试中发起真实网络刷新
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  // 构造期 initializePromise 可能 reject；这里吞掉，避免二次 unhandledRejection
  const initSettled = Promise.resolve(client.auth.initializePromise).catch(() => {});
  return { client, adapter, initSettled };
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('S1 真实 SDK：SecureStore 读失败时 getSession() reject（实测 2.118.0 契约）', async () => {
  resetCapturedRejections();
  // 构造期先让存储可读，避免 SDK 构造时 fire-and-forget 的 _emitInitialSession
  // 产生 unhandledRejection（node:test 会把它归因为测试失败）。
  const secureStore = createFakeSecureStore();
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const { client, initSettled } = makeClient({ secureStore, asyncStorage, status });

  // 等构造期初始化完成（此时存储健康，无异常）
  await initSettled;
  await flushAsync();

  // 构造完成后再注入读故障：此时只有 getSession() 会触发读
  secureStore.failGet = true;

  // 实测行为：SDK 会把适配器的异常抛给调用方（而非吞掉后 resolve null）
  await assert.rejects(
    () => client.auth.getSession(),
    (err) => {
      assert.equal(err.code, AUTH_STORAGE_ERROR.UNAVAILABLE);
      return true;
    },
    'getSession() 必须 reject 出 AUTH_STORAGE_UNAVAILABLE'
  );
});

test('S2 真实 SDK：同一场景下适配器状态位为故障（与 S1 互补的可靠信号）', async () => {
  resetCapturedRejections();
  const secureStore = createFakeSecureStore();
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const { client, initSettled } = makeClient({ secureStore, asyncStorage, status });

  await initSettled;
  await flushAsync();

  // 构造完成后再注入读故障
  secureStore.failGet = true;

  // 无论 getSession() 是 reject 还是 resolve，状态位都必须记录故障。
  // 这是 `onAuthStateChange` 路径与构造期 unhandledRejection 场景下
  // 上层唯一能依赖的信号。
  await client.auth.getSession().catch(() => {});
  await flushAsync();

  assert.equal(status.isFailed(), true, '状态位必须记录故障');
  assert.equal(status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);
});

test('S3 真实 SDK 正常路径：写入后 getSession() 能读回会话', async () => {
  resetCapturedRejections();
  const secureStore = createFakeSecureStore();
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const { client, adapter, initSettled } = makeClient({ secureStore, asyncStorage, status });

  await initSettled;

  // 直接通过适配器写入（等价于 SDK 内部 _saveSession 的落盘动作）
  await adapter.setItem(STORAGE_KEY, JSON.stringify(SESSION));

  const { data, error } = await client.auth.getSession();
  assert.equal(error, null);
  assert.ok(data.session, '应能读回会话');
  assert.equal(data.session.access_token, SESSION.access_token);
  assert.equal(status.isFailed(), false, '正常路径不应留下故障态');
});

test('S4 真实 SDK 登出：removeItem 被调用，状态位清除', async () => {
  resetCapturedRejections();
  const secureStore = createFakeSecureStore();
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const { client, adapter, initSettled } = makeClient({ secureStore, asyncStorage, status });

  await initSettled;
  await adapter.setItem(STORAGE_KEY, JSON.stringify(SESSION));
  assert.equal(secureStore.map.size, 1);

  await client.auth.signOut();

  assert.equal(secureStore.map.size, 0, '登出后安全副本应被删除');
  assert.equal(status.isFailed(), false, '登出成功不应留下故障态');
});

test('S5 真实 SDK 登出时 SecureStore 删除失败 → 状态位保持故障', async () => {
  resetCapturedRejections();
  const secureStore = createFakeSecureStore();
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const { client, adapter, initSettled } = makeClient({ secureStore, asyncStorage, status });

  await initSettled;
  await adapter.setItem(STORAGE_KEY, JSON.stringify(SESSION));

  // 登出前让删除失败
  secureStore.failDelete = true;

  // SDK 可能把删除失败抛给调用方，也可能吞掉；两种情况下状态位都必须记录故障
  await client.auth.signOut().catch(() => {});
  await flushAsync();

  assert.equal(status.isFailed(), true, '登出失败必须留下故障态');
  assert.equal(status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);
});

test('S6 真实 SDK 不向 AsyncStorage 写明文（storageKey 只落 SecureStore）', async () => {
  resetCapturedRejections();
  const secureStore = createFakeSecureStore();
  const asyncStorage = createFakeAsyncStorage();
  const status = createAuthStorageStatus();
  const { client, adapter, initSettled } = makeClient({ secureStore, asyncStorage, status });

  await initSettled;
  await adapter.setItem(STORAGE_KEY, JSON.stringify(SESSION));
  await client.auth.getSession();

  assert.equal(asyncStorage.map.size, 0, 'AsyncStorage 不得出现任何会话明文');
  assert.equal(secureStore.map.size, 1, '会话只应存在于 SecureStore');
});

// --- END OF FILE tests/security/authSdkContract.test.mjs ---
