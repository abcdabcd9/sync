// --- START OF FILE tests/security/authStorage.test.mjs ---
/**
 * TASK-P0.2 Batch C — 认证存储加固测试
 *
 * C03 关键变更：**直接执行真实实现**。
 *   本测试 import `src/services/authStorage.ts` 的 `createSecureStoreAdapter`，
 *   注入内存 fake 的 secureStore / asyncStorage，因此断言的是生产代码本身，
 *   而不是一份复刻逻辑。任何对真实适配器的修改都会立即反映到测试结果。
 *
 * 覆盖范围：
 *   C1  正常写入后可从 SecureStore 读回，且不写 AsyncStorage
 *   C2  SecureStore 读失败 → 抛 UNAVAILABLE，且不回落 AsyncStorage
 *   C3  SecureStore 写失败 → 抛 UNAVAILABLE，且不写明文
 *   C4  SecureStore 删失败 → 抛 UNAVAILABLE（避免误以为已登出）
 *   C5  旧明文迁移：安全写入校验成功后清除明文
 *   C6  迁移失败（安全写入失败）→ 抛 MIGRATION_FAILED，明文保留
 *   C7  重启（新适配器实例）后仍能读到安全副本
 *   C8  并发写入不产生明文残留
 *   C9  无任何副本时返回 null（不抛错）
 *   C10 迁移后明文清除失败 → 不阻断会话，但状态位置 LEGACY_CLEANUP_FAILED（T6.1/FIX-04）
 *   C11 登出时明文残留清除失败 → 抛 LEGACY_CLEANUP_FAILED（C01 显式上报）
 *   C12 登出时安全副本删除失败优先抛 UNAVAILABLE（错误优先级）
 *   C13 key 归一化：非法字符被替换为下划线
 *   C14 真实实现契约：导出错误码齐全，且不含明文降级路径
 *
 * C02 / Gemini P1-1 补充（认证事件竞争、GoTrue 吞异常、登出失败、重试恢复）：
 *   C15 读失败时状态位被置为故障（GoTrue 吞异常后上层仍可感知）
 *   C16 故障态不被无关认证事件清除（模拟 onAuthStateChange 回调）
 *   C17 重试恢复：存储恢复后状态位清除，会话可正常读回
 *   C18 登出失败（安全副本删不掉）→ 状态位保持故障，不得视为已登出
 *   C19 登出成功 → 状态位清除
 *   C20 故障码保留首个根因，不被后续无关错误覆盖
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AUTH_STORAGE_ERROR,
  createAuthStorageStatus,
  createSecureStoreAdapter,
  toSecureKey,
} from '../../src/services/authStorage.ts';

// ---------------------------------------------------------------------------
// Fake storage 工厂（仅模拟原生模块，不模拟适配器逻辑）
// ---------------------------------------------------------------------------

/** 可注入故障的内存 SecureStore */
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

/** 可注入故障的内存 AsyncStorage */
function createFakeAsyncStorage({ failGet = false, failRemove = false, failSet = false } = {}) {
  const map = new Map();
  return {
    map,
    failGet,
    failRemove,
    failSet,
    async getItem(key) {
      if (this.failGet) throw new Error('async get failed');
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      if (this.failSet) throw new Error('async set failed');
      map.set(key, value);
    },
    async removeItem(key) {
      if (this.failRemove) throw new Error('async remove failed');
      map.delete(key);
    },
  };
}

/** 静默 logger，避免测试输出被 console.error 污染 */
const silentLogger = { error() {}, warn() {}, log() {} };

function makeAdapter(secureStore, asyncStorage, status) {
  return createSecureStoreAdapter({ secureStore, asyncStorage, logger: silentLogger, status });
}

const KEY = 'sb-testref-auth-token';
const SECURE_KEY = toSecureKey(KEY);
const TOKEN = JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r.s.t' });

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('C1 正常写入后可从 SecureStore 读回，且不写 AsyncStorage', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore);

  await adapter.setItem(KEY, TOKEN);

  assert.equal(secure.map.get(SECURE_KEY), TOKEN, '安全副本应存在');
  assert.equal(asyncStore.map.has(KEY), false, '不得写明文 AsyncStorage');

  const read = await adapter.getItem(KEY);
  assert.equal(read, TOKEN);
});

test('C2 SecureStore 读失败 → 抛 UNAVAILABLE，且不回落 AsyncStorage', async () => {
  const secure = createFakeSecureStore({ failGet: true });
  const asyncStore = createFakeAsyncStorage();
  // 即使 AsyncStorage 里有明文，也不得被读取返回
  asyncStore.map.set(KEY, TOKEN);
  const adapter = makeAdapter(secure, asyncStore);

  await assert.rejects(
    () => adapter.getItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );
});

test('C3 SecureStore 写失败 → 抛 UNAVAILABLE，且不写明文', async () => {
  const secure = createFakeSecureStore({ failSet: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore);

  await assert.rejects(
    () => adapter.setItem(KEY, TOKEN),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );
  assert.equal(asyncStore.map.has(KEY), false, '写失败时绝不能落明文');
});

test('C4 SecureStore 删失败 → 抛 UNAVAILABLE（避免误以为已登出）', async () => {
  const secure = createFakeSecureStore({ failDelete: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore);

  await assert.rejects(
    () => adapter.removeItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );
});

test('C5 旧明文迁移：安全写入校验成功后清除明文', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  asyncStore.map.set(KEY, TOKEN); // 旧版本遗留明文
  const adapter = makeAdapter(secure, asyncStore);

  const read = await adapter.getItem(KEY);
  assert.equal(read, TOKEN, '应返回旧会话，用户不被强制登出');
  assert.equal(secure.map.get(SECURE_KEY), TOKEN, '安全副本应已写入');
  assert.equal(asyncStore.map.has(KEY), false, '明文副本应已清除');
});

test('C6 迁移失败（安全写入失败）→ 抛 MIGRATION_FAILED，明文保留', async () => {
  const secure = createFakeSecureStore({ failSet: true });
  const asyncStore = createFakeAsyncStorage();
  asyncStore.map.set(KEY, TOKEN);
  const adapter = makeAdapter(secure, asyncStore);

  await assert.rejects(
    () => adapter.getItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.MIGRATION_FAILED,
  );
  assert.equal(asyncStore.map.get(KEY), TOKEN, '迁移失败时明文必须保留，避免丢登录态');
});

test('C7 重启（新适配器实例）后仍能读到安全副本', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();

  const first = makeAdapter(secure, asyncStore);
  await first.setItem(KEY, TOKEN);

  // 模拟 App 重启：新建适配器，共享同一底层存储
  const second = makeAdapter(secure, asyncStore);
  const read = await second.getItem(KEY);
  assert.equal(read, TOKEN);
});

test('C8 并发写入不产生明文残留', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore);

  await Promise.all([
    adapter.setItem(KEY, TOKEN),
    adapter.setItem(KEY, TOKEN),
    adapter.setItem(KEY, TOKEN),
  ]);

  assert.equal(asyncStore.map.has(KEY), false, '并发写入后 AsyncStorage 不得有明文');
  assert.equal(secure.map.get(SECURE_KEY), TOKEN);
});

test('C9 无任何副本时返回 null（不抛错）', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore);

  const read = await adapter.getItem(KEY);
  assert.equal(read, null);
});

test('C10 迁移后明文清除失败 → 不阻断会话，但状态位置 LEGACY_CLEANUP_FAILED（T6.1/FIX-04）', async () => {
  const status = createAuthStorageStatus();
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage({ failRemove: true });
  asyncStore.map.set(KEY, TOKEN);
  const adapter = makeAdapter(secure, asyncStore, status);

  // T6.1/FIX-04 语义变更：安全副本已写入并通过回读校验，会话是有效的。
  // 此时若因「明文删不掉」而抛错，GoTrue 会把整个 getItem 视为失败 → 用户被强制登出。
  // 因此正确行为是：**照常返回会话**，同时把清理失败记录到状态位供上层提示/重试。
  const read = await adapter.getItem(KEY);
  assert.equal(read, TOKEN, '清理失败不得阻断会话恢复（可用性优先）');

  // 安全副本已就绪
  assert.equal(secure.map.get(SECURE_KEY), TOKEN, '安全副本应已写入');
  // 明文确实残留 —— 这正是必须显式上报的原因
  assert.equal(asyncStore.map.get(KEY), TOKEN, '明文确实残留');

  // 关键：故障必须被显式暴露，不能静默留痕
  assert.equal(status.isFailed(), true, '清理失败必须置故障状态位');
  assert.equal(
    status.get().code,
    AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED,
    '故障码应为 LEGACY_CLEANUP_FAILED',
  );
});

test('C11 登出时明文残留清除失败 → 抛 LEGACY_CLEANUP_FAILED（C01 显式上报）', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage({ failRemove: true });
  asyncStore.map.set(KEY, TOKEN);
  secure.map.set(SECURE_KEY, TOKEN);
  const adapter = makeAdapter(secure, asyncStore);

  await assert.rejects(
    () => adapter.removeItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED,
  );
  assert.equal(secure.map.has(SECURE_KEY), false, '安全副本应已删除');
  assert.equal(asyncStore.map.get(KEY), TOKEN, '明文残留（需上层提示重试）');
});

test('C12 登出时安全副本删除失败优先抛 UNAVAILABLE（错误优先级）', async () => {
  const secure = createFakeSecureStore({ failDelete: true });
  const asyncStore = createFakeAsyncStorage({ failRemove: true });
  const adapter = makeAdapter(secure, asyncStore);

  await assert.rejects(
    () => adapter.removeItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );
});

test('C13 key 归一化：非法字符被替换为下划线', () => {
  assert.equal(toSecureKey('sb-ref-auth-token'), 'sb-ref-auth-token');
  assert.equal(toSecureKey('sb/ref:auth token'), 'sb_ref_auth_token');
  assert.equal(toSecureKey('a.b-c_d'), 'a.b-c_d');
});

test('C14 真实实现契约：导出错误码齐全，且不含明文降级路径', async () => {
  // 错误码齐全
  assert.equal(AUTH_STORAGE_ERROR.UNAVAILABLE, 'AUTH_STORAGE_UNAVAILABLE');
  assert.equal(AUTH_STORAGE_ERROR.MIGRATION_FAILED, 'AUTH_STORAGE_MIGRATION_FAILED');
  assert.equal(AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED, 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED');

  // 源码层面：真实实现不得包含明文降级写入
  // P1.2 R5：源码已迁移为 TypeScript，断言对象改为 .ts 实现。
  const srcPath = path.resolve(process.cwd(), 'src/services/authStorage.ts');
  const src = await fs.readFile(srcPath, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, ''); // 行注释

  assert.equal(
    /catch[\s\S]{0,200}asyncStorage\.setItem/.test(code),
    false,
    'SecureStore 失败时不得降级写 AsyncStorage 明文',
  );
  // T6.2/FIX-01：适配器唯一允许的 AsyncStorage 写入是「登出墓碑」，
  // 其值不含任何凭据（固定字符串 '1'），且写入目标是 tombstoneKey。
  // 断言：所有 asyncStorage.setItem 调用都必须写入墓碑 key，不得写入会话 key。
  const setItemCalls = code.match(/asyncStorage\.setItem\([^)]*\)/g) || [];
  for (const call of setItemCalls) {
    assert.equal(
      /tombstoneKey\(/.test(call),
      true,
      `asyncStorage.setItem 只允许写墓碑，实际调用：${call}`,
    );
  }
  assert.equal(src.includes('secure write verify mismatch'), true, '迁移必须先校验再清除');
});

// ---------------------------------------------------------------------------
// C02 / Gemini P1-1：认证事件竞争、GoTrue 吞异常、登出失败、重试恢复
// ---------------------------------------------------------------------------

test('C15 读失败时状态位被置为故障（GoTrue 吞异常后上层仍可感知）', async () => {
  const status = createAuthStorageStatus();
  const secure = createFakeSecureStore({ failGet: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore, status);

  assert.equal(status.isFailed(), false, '初始应为健康');

  await assert.rejects(
    () => adapter.getItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );

  // 关键：即使 SDK 吞掉了这个异常，状态位仍然记录了故障
  assert.equal(status.isFailed(), true, '读失败后状态位必须为故障');
  assert.equal(status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);
});

test('C16 故障态不被无关认证事件清除（模拟 onAuthStateChange 回调）', async () => {
  const status = createAuthStorageStatus();
  const secure = createFakeSecureStore({ failGet: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore, status);

  await assert.rejects(() => adapter.getItem(KEY));
  assert.equal(status.isFailed(), true);

  // 模拟 useAuth 的 onAuthStateChange 回调逻辑：
  // 只要状态位为故障，就不得清除故障态、不得把用户当作已登出。
  const onAuthStateChange = (nextSession) => {
    if (status.isFailed()) {
      return { applied: false, session: null, error: status.get() };
    }
    return { applied: true, session: nextSession, error: null };
  };

  // 无关事件：SIGNED_OUT / TOKEN_REFRESHED / INITIAL_SESSION 都不得清除故障
  for (const event of ['SIGNED_OUT', 'TOKEN_REFRESHED', 'INITIAL_SESSION']) {
    const r = onAuthStateChange(null);
    assert.equal(r.applied, false, `${event} 不得清除故障态`);
    assert.equal(r.error.code, AUTH_STORAGE_ERROR.UNAVAILABLE);
  }
  assert.equal(status.isFailed(), true, '故障态必须保持');
});

test('C17 重试恢复：存储恢复后状态位清除，会话可正常读回', async () => {
  const status = createAuthStorageStatus();
  const secure = createFakeSecureStore({ failGet: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore, status);

  // 第一次：故障
  await assert.rejects(() => adapter.getItem(KEY));
  assert.equal(status.isFailed(), true);

  // 模拟「重试」：设备恢复后 SecureStore 可用
  secure.failGet = false;
  secure.map.set(SECURE_KEY, TOKEN);

  const value = await adapter.getItem(KEY);
  assert.equal(value, TOKEN, '恢复后应能读回会话');
  assert.equal(status.isFailed(), false, '成功读取后状态位必须清除');
});

test('C18 登出失败（安全副本删不掉）→ 状态位保持故障，不得视为已登出', async () => {
  const status = createAuthStorageStatus();
  const secure = createFakeSecureStore({ failDelete: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore, status);

  await assert.rejects(
    () => adapter.removeItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );

  assert.equal(status.isFailed(), true, '登出失败必须留下故障态');
  assert.equal(status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);
});

test('C19 登出成功 → 状态位清除', async () => {
  const status = createAuthStorageStatus();
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore, status);

  // 先制造一次故障
  secure.failGet = true;
  await assert.rejects(() => adapter.getItem(KEY));
  assert.equal(status.isFailed(), true);

  // 登出成功（删除路径正常）
  secure.failGet = false;
  await adapter.removeItem(KEY);
  assert.equal(status.isFailed(), false, '登出成功后状态位必须清除');
});

test('C20 同一故障周期内保留首个根因，不被后续错误覆盖', async () => {
  const status = createAuthStorageStatus();
  // 读与写同时失败：模拟 Keychain 整体不可用
  const secure = createFakeSecureStore({ failGet: true, failSet: true });
  const asyncStore = createFakeAsyncStorage();
  const adapter = makeAdapter(secure, asyncStore, status);

  // 首个根因：读失败 → UNAVAILABLE
  await assert.rejects(() => adapter.getItem(KEY));
  assert.equal(status.get().code, AUTH_STORAGE_ERROR.UNAVAILABLE);

  // 同一故障周期内再发生一次写失败，不得覆盖首个根因
  await assert.rejects(
    () => adapter.setItem(KEY, TOKEN),
    (err) => err.code === AUTH_STORAGE_ERROR.UNAVAILABLE,
  );

  assert.equal(
    status.get().code,
    AUTH_STORAGE_ERROR.UNAVAILABLE,
    '状态位应保留首个根因，便于定位问题',
  );

  // 而一旦链路恢复（读成功），状态位应被清除，允许记录新的故障周期
  secure.failGet = false;
  secure.map.set(SECURE_KEY, TOKEN);
  await adapter.getItem(KEY);
  assert.equal(status.isFailed(), false, '恢复后应清除，开启新的故障周期');
});

// ---------------------------------------------------------------------------
// T6.2 / FIX-01：登出部分失败后，残留明文不得在重启后复活为安全副本
//
// 真实缺陷场景（跨进程重启，而非仅内存状态位）：
//   1. 用户登出 → removeItem：SecureStore 删除成功，AsyncStorage 删除失败
//      → 抛 LEGACY_CLEANUP_FAILED（登出已生效，明文残留）。
//   2. App 被杀死并重启 → 新进程、新适配器实例、状态位全新（内存态丢失）。
//   3. SDK 初始化调用 getItem：安全副本不存在 → 走「旧明文迁移」分支
//      → 把残留明文重新写入 SecureStore → **凭据复活**。
//
// 修复要求：登出时若安全副本已删除但明文清理失败，必须留下**持久化**的
// 「已登出」墓碑；重启后 getItem 见到墓碑必须拒绝迁移并清除明文。
// ---------------------------------------------------------------------------

test('C21 登出部分失败后重启：残留明文不得复活为安全副本（跨进程）', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  // 初始：安全副本 + 旧明文共存（迁移后清理失败的历史遗留）
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.map.set(KEY, TOKEN);

  // --- 进程 1：登出，SecureStore 删除成功，AsyncStorage 删除失败 ---
  const status1 = createAuthStorageStatus();
  const adapter1 = makeAdapter(secure, asyncStore, status1);
  asyncStore.failRemove = true;
  await assert.rejects(
    () => adapter1.removeItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED,
  );
  assert.equal(secure.map.has(SECURE_KEY), false, '安全副本应已删除（登出生效）');
  assert.equal(asyncStore.map.get(KEY), TOKEN, '明文残留');

  // --- 进程 2：App 重启，新适配器 + 全新状态位（内存态丢失） ---
  asyncStore.failRemove = false; // 新进程存储恢复正常
  const status2 = createAuthStorageStatus();
  const adapter2 = makeAdapter(secure, asyncStore, status2);

  const read = await adapter2.getItem(KEY);

  // 核心断言：不得把残留明文重新迁移回 SecureStore
  assert.equal(read, null, '登出后重启不得恢复会话（凭据不得复活）');
  assert.equal(secure.map.has(SECURE_KEY), false, '不得重新写入安全副本');
  assert.equal(asyncStore.map.has(KEY), false, '残留明文应被清除');
});

test('C22 墓碑存在时，即使明文残留也不得迁移（防御性）', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  // 仅残留明文，无安全副本；模拟墓碑已持久化
  asyncStore.map.set(KEY, TOKEN);
  const status = createAuthStorageStatus();
  const adapter = makeAdapter(secure, asyncStore, status);

  // 先制造一次「登出部分失败」以写入墓碑
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.failRemove = true;
  await assert.rejects(() => adapter.removeItem(KEY));
  asyncStore.failRemove = false;

  // 重启后读取
  const adapter2 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  const read = await adapter2.getItem(KEY);
  assert.equal(read, null, '墓碑存在时不得迁移明文');
  assert.equal(secure.map.has(SECURE_KEY), false);
});

test('C23 正常登出（两处均成功）后重启：不复活且无墓碑残留', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.map.set(KEY, TOKEN);

  const adapter = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  await adapter.removeItem(KEY);

  const adapter2 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  const read = await adapter2.getItem(KEY);
  assert.equal(read, null);
  assert.equal(secure.map.has(SECURE_KEY), false);
  assert.equal(asyncStore.map.has(KEY), false);
});

test('C24 登出后重新登录：新会话可正常写入并读回（墓碑不得阻断登录）', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.map.set(KEY, TOKEN);

  const adapter = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  asyncStore.failRemove = true;
  await assert.rejects(() => adapter.removeItem(KEY));
  asyncStore.failRemove = false;

  // 重启后用户重新登录：setItem 必须成功，且清除墓碑
  const adapter2 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  const NEW_TOKEN = JSON.stringify({ access_token: 'n.e.w', refresh_token: 'n.r.t' });
  await adapter2.setItem(KEY, NEW_TOKEN);

  const read = await adapter2.getItem(KEY);
  assert.equal(read, NEW_TOKEN, '重新登录后应能读回新会话');
  assert.equal(asyncStore.map.has(KEY), false, '不得残留明文');
});

// ---------------------------------------------------------------------------
// T6.2 收尾缺陷1：墓碑写入失败 **且** 明文删除失败（双重失败）的失败安全
//
// 危险组合：登出时 SecureStore 删除成功，但
//   · 墓碑写入失败（asyncStorage.setItem 抛错），且
//   · 明文删除失败（asyncStorage.removeItem 抛错）。
// 此时既无持久化「已登出」标记，明文又原样残留 → 重启后 getItem 会把
// 残留明文重新迁移回 SecureStore → **凭据复活**（安全缺陷）。
//
// 修复要求（失败安全）：墓碑写失败时，必须通过「重试墓碑 / 重试删除」兜底；
// 若兜底仍无法消除复活风险，必须显式抛错（绝不误报登出成功）。
// 适配器始终只向 AsyncStorage 写墓碑 key（C14 契约），不写会话 key。
// ---------------------------------------------------------------------------

test('C25 墓碑写失败 + 明文删失败 → 重试墓碑成功兜底，重启不复活', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.map.set(KEY, TOKEN);

  // 进程 1：登出。首次墓碑 setItem 失败 + 首次明文 removeItem 失败；
  // 兜底「重试墓碑」时存储已恢复 → 墓碑写入成功。
  const adapter1 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  let setCalls = 0;
  const origSet = asyncStore.setItem.bind(asyncStore);
  asyncStore.setItem = async (k, v) => {
    setCalls += 1;
    // 第 1 次（writeTombstone 首次）失败；第 2 次（兜底重试）成功
    if (setCalls === 1) throw new Error('async set failed (first)');
    return origSet(k, v);
  };
  let removeCalls = 0;
  const origRemove = asyncStore.removeItem.bind(asyncStore);
  asyncStore.removeItem = async (k) => {
    removeCalls += 1;
    if (removeCalls === 1) throw new Error('async remove failed (first)');
    return origRemove(k);
  };

  // 登出：墓碑首次写失败 + 明文首次删失败，但兜底重试墓碑成功 → 不抛错
  await adapter1.removeItem(KEY);
  assert.equal(secure.map.has(SECURE_KEY), false, '安全副本应已删除');
  assert.equal(asyncStore.map.has(`${KEY}.__signed_out__`), true, '兜底重试应写入墓碑');

  // 进程 2：重启，存储恢复正常
  asyncStore.setItem = origSet;
  asyncStore.removeItem = origRemove;
  const adapter2 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  const read = await adapter2.getItem(KEY);
  assert.equal(read, null, '重启后不得恢复会话');
  assert.equal(secure.map.has(SECURE_KEY), false, '不得重新写入安全副本');
  assert.equal(asyncStore.map.has(KEY), false, '残留明文应被清除');
});

test('C26 墓碑写失败 + 明文删失败 → 重试墓碑仍失败但重试删除成功兜底，重启不复活', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.map.set(KEY, TOKEN);

  // 进程 1：登出。墓碑 setItem 始终失败；明文 removeItem 首次失败、重试成功。
  const adapter1 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  asyncStore.setItem = async () => {
    throw new Error('async set failed (always)');
  };
  let removeCalls = 0;
  const origRemove = asyncStore.removeItem.bind(asyncStore);
  asyncStore.removeItem = async (k) => {
    removeCalls += 1;
    if (removeCalls === 1) throw new Error('async remove failed (first)');
    return origRemove(k);
  };

  await adapter1.removeItem(KEY);
  assert.equal(secure.map.has(SECURE_KEY), false, '安全副本应已删除');
  assert.equal(asyncStore.map.has(KEY), false, '兜底重试应删除明文');
  assert.equal(asyncStore.map.has(`${KEY}.__signed_out__`), false, '墓碑确实未写入');

  // 进程 2：重启，存储恢复正常
  asyncStore.setItem = async (k, v) => asyncStore.map.set(k, v);
  asyncStore.removeItem = origRemove;
  const adapter2 = makeAdapter(secure, asyncStore, createAuthStorageStatus());
  const read = await adapter2.getItem(KEY);
  assert.equal(read, null, '重启后不得恢复会话');
  assert.equal(secure.map.has(SECURE_KEY), false, '不得重新写入安全副本');
});

test('C27 墓碑写失败 + 明文删失败 + 兜底重试均失败 → 显式抛错（不误报登出成功）', async () => {
  const secure = createFakeSecureStore();
  const asyncStore = createFakeAsyncStorage();
  secure.map.set(SECURE_KEY, TOKEN);
  asyncStore.map.set(KEY, TOKEN);

  const status = createAuthStorageStatus();
  const adapter = makeAdapter(secure, asyncStore, status);
  // 墓碑写入、明文删除全部失败（含兜底重试）
  asyncStore.removeItem = async () => {
    throw new Error('async remove failed');
  };
  asyncStore.setItem = async () => {
    throw new Error('async set failed');
  };

  await assert.rejects(
    () => adapter.removeItem(KEY),
    (err) => err.code === AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED,
    '兜底全部失败时必须显式上报，不得误报登出成功',
  );
  assert.equal(status.isFailed(), true, '兜底失败必须留下故障态');
  assert.equal(secure.map.has(SECURE_KEY), false, '安全副本已删除（登出已生效）');
});
// --- END OF FILE tests/security/authStorage.test.mjs ---
