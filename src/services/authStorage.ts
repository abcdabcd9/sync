// --- START OF FILE src/services/authStorage.ts ---
/**
 * 认证会话安全存储适配器（TASK-P0.2 Batch C → TASK-P1.2 R5 TypeScript 迁移）
 *
 * 设计目标：
 *   1. 仅接管 Supabase Auth 会话（storageKey = `sb-<ref>-auth-token`）的持久化；
 *      其余业务缓存继续走 AsyncStorage，完全不受影响。
 *   2. 安全存储不可用时**显式失败**，绝不静默降级为明文存储。
 *   3. 旧明文迁移遵循「先安全写入并回读校验，再清除明文」的顺序。
 *   4. 明文清理失败必须**显式上报**（C01），不能只打日志。
 *
 * 可测试性（C03）：
 *   本模块不直接 import 任何原生模块，而是通过 `createSecureStoreAdapter`
 *   注入 `secureStore` / `asyncStorage` 两个依赖。生产代码在
 *   `src/services/supabase.ts` 中注入 expo-secure-store 与 AsyncStorage；
 *   测试则注入内存 fake，从而**直接执行真实实现**，而不是复刻一份逻辑。
 *
 * ⚠️ P1.2 R5 迁移约束：
 *   本文件是 `src/services/authStorage.js` 的**逐行等价** TypeScript 迁移。
 *   仅添加类型标注，**不改变任何运行时行为**：分支顺序、错误码、日志文本、
 *   墓碑 key 格式、重试次数、清理顺序全部保持原样。
 *   基线见 `tests/fixtures/p12r5/before/services__authStorage.js`。
 */

import type { AuthStorageErrorCode, AuthStorageFailure } from '../types/auth';

/**
 * 认证存储错误码（供上层区分「安全存储不可用」与普通网络/业务错误）
 */
export const AUTH_STORAGE_ERROR = Object.freeze({
  /** SecureStore 读写删除失败（Keychain / Keystore 不可用） */
  UNAVAILABLE: 'AUTH_STORAGE_UNAVAILABLE',
  /** 旧明文会话迁移失败（安全写入未成功，明文未被清除） */
  MIGRATION_FAILED: 'AUTH_STORAGE_MIGRATION_FAILED',
  /** 明文副本清理失败（安全副本已就绪，但明文可能残留） */
  LEGACY_CLEANUP_FAILED: 'AUTH_STORAGE_LEGACY_CLEANUP_FAILED',
} as const);

/** 故障状态位接口 */
export interface AuthStorageStatus {
  /** 记录故障（保留首个故障码，避免后续无关错误覆盖根因） */
  markFailed(code: AuthStorageErrorCode, cause?: unknown): AuthStorageFailure;
  /** 仅在确认存储链路可用时清除 */
  clear(): void;
  /** 读取当前故障（null 表示健康） */
  get(): AuthStorageFailure | null;
  /** 是否处于故障态 */
  isFailed(): boolean;
}

/**
 * 故障状态记录器（C02 / Gemini P1-1）
 *
 * 为什么需要它：
 *   `@supabase/auth-js` 的 `_recoverAndRefresh()` 内部对 `storage.getItem` 的异常
 *   做了 `try/catch` 兜底 —— 只 `console.error` 然后 `return`，**不会向上抛出**。
 *   结果是 `_initialize()` 返回 `{ error: null }`，`getSession()` resolve 出
 *   `{ data: { session: null }, error: null }`。
 *   也就是说：即使适配器正确抛出了 `AUTH_STORAGE_UNAVAILABLE`，
 *   上层 `useAuth` 的 `.catch()` 也**永远不会被触发**，用户会被静默判定为「已登出」。
 *
 * 解决方式：
 *   适配器在失败的第一现场（catch 块内）同步写入一个故障状态位，
 *   上层不依赖 SDK 是否抛出，而是主动查询该状态位。
 *   状态位只在「成功读到/写入/删除」时清除，**不会被无关的认证事件清除**。
 */
export function createAuthStorageStatus(): AuthStorageStatus {
  let failure: AuthStorageFailure | null = null;
  return {
    /** 记录故障（保留首个故障码，避免后续无关错误覆盖根因） */
    markFailed(code: AuthStorageErrorCode, cause?: unknown): AuthStorageFailure {
      if (!failure) {
        // 严格还原原 JS 运行时语义：`cause?.message ?? String(cause ?? code)`。
        // 注意：当 `cause` 是对象且 `cause.message` 为 `0` / `false` 时，
        // 该表达式会原样返回 `0` / `false`（非字符串）——这是历史契约，
        // 不得用 `String(...)` 强制转换来"修正"它。
        const causeMessage =
          typeof cause === 'object' && cause !== null
            ? (cause as { message?: unknown }).message
            : undefined;
        const msg: unknown = causeMessage ?? String(cause ?? code);
        failure = { code, message: msg };
      }
      return failure;
    },
    /** 仅在确认存储链路可用时清除 */
    clear(): void {
      failure = null;
    },
    /** 读取当前故障（null 表示健康） */
    get(): AuthStorageFailure | null {
      return failure;
    },
    /** 是否处于故障态 */
    isFailed(): boolean {
      return failure !== null;
    },
  };
}

/** 带错误码的认证存储异常 */
export interface AuthStorageError extends Error {
  code: AuthStorageErrorCode;
  cause?: unknown;
}

/** 构造带错误码的认证存储异常 */
export function authStorageError(code: AuthStorageErrorCode, cause?: unknown): AuthStorageError {
  const err = new Error(code) as AuthStorageError;
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/**
 * SecureStore 的 key 只允许 [A-Za-z0-9._-]。
 * Supabase 默认 storageKey 天然合规，这里做一次归一化兜底，
 * 防御未来 storageKey 变更引入非法字符导致 SecureStore 抛 "Invalid key"。
 */
export function toSecureKey(key: string): string {
  return String(key).replace(/[^\w.-]/g, '_');
}

/** SecureStore 依赖（expo-secure-store 的子集） */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** AsyncStorage 依赖（@react-native-async-storage/async-storage 的子集） */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** 日志器（默认 console；测试可注入静默 logger） */
export interface AuthStorageLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 适配器依赖注入参数 */
export interface CreateSecureStoreAdapterDeps {
  secureStore: SecureStoreLike;
  asyncStorage: AsyncStorageLike;
  logger?: AuthStorageLogger;
  status?: AuthStorageStatus;
}

/**
 * SecureStore 适配器：满足 `@supabase/supabase-js` 的 `SupportedStorage` 契约。
 * 三个方法均为 async（返回 Promise），与真实实现一致。
 */
export interface SecureStoreAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * 严格还原原 JS 日志分支语义：`e?.message ?? e`。
 *
 * 原实现直接把该表达式的结果作为 `logger.warn/error` 的第二个实参，
 * **不做任何字符串化**。因此：
 *   - `e` 为对象且 `e.message` 存在 → 原样返回该值（可能是 `0` / `false` / 任意类型）；
 *   - 否则 → 原样返回 `e` 本身（可能是 `null` / `undefined` / 字符串 / 对象）。
 * 返回类型为 `unknown`，以诚实反映历史契约；调用方仅透传给 logger。
 */
function readErrMessage(e: unknown): unknown {
  const causeMessage =
    typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined;
  return causeMessage ?? e;
}

/**
 * 创建 SecureStore 适配器。
 *
 * @param deps.secureStore  需实现 getItemAsync / setItemAsync / deleteItemAsync
 * @param deps.asyncStorage 需实现 getItem / setItem / removeItem
 * @param deps.logger       可选，默认 console；测试可注入静默 logger
 * @param deps.status       可选，createAuthStorageStatus() 实例；
 *                          用于绕过 GoTrue 的异常吞没（C02）
 */
export function createSecureStoreAdapter({
  secureStore,
  asyncStorage,
  logger = console,
  status = createAuthStorageStatus(),
}: CreateSecureStoreAdapterDeps): SecureStoreAdapter {
  if (!secureStore) throw new Error('createSecureStoreAdapter: secureStore is required');
  if (!asyncStorage) throw new Error('createSecureStoreAdapter: asyncStorage is required');

  /**
   * 尽力清除 AsyncStorage 明文副本。
   *
   * 🔒 T6.2/FIX-1：抽成独立函数，供「迁移后清理」「安全副本已存在时的补清理」
   *    「登出清理」三处复用，保证**任何一次成功读取都会尝试清掉明文残留**。
   *
   * @returns 失败时返回错误对象，成功返回 null
   */
  const purgeLegacy = async (key: string): Promise<unknown | null> => {
    try {
      await asyncStorage.removeItem(key);
      return null;
    } catch (e) {
      return e ?? new Error('legacy remove failed');
    }
  };

  /**
   * 登出墓碑 key（T6.2/FIX-01）。
   *
   * 为什么需要持久化墓碑：
   *   登出时若 SecureStore 删除成功、但 AsyncStorage 明文删除失败，
   *   进程内状态位（LEGACY_CLEANUP_FAILED）在 App 重启后即丢失。
   *   重启后 SDK 调 getItem：安全副本已不存在 → 走「旧明文迁移」分支
   *   → 把残留明文重新写入 SecureStore → **凭据复活**。
   *
   *   因此登出「安全副本已删除」这一事实必须**持久化**：写一个不含任何
   *   凭据的标记（仅 key 名，值为固定字符串）。重启后 getItem 见到墓碑
   *   即拒绝迁移并清除明文；用户重新登录（setItem）时删除墓碑。
   *
   * 安全性：墓碑本身不含 token，仅表示「此 key 已被登出」，明文写入无风险。
   */
  const tombstoneKey = (key: string): string => `${key}.__signed_out__`;
  const TOMBSTONE_VALUE = '1';

  /** 写入登出墓碑；失败返回错误对象（不抛，由调用方决定如何处理） */
  const writeTombstone = async (key: string): Promise<unknown | null> => {
    try {
      if (typeof asyncStorage.setItem !== 'function') {
        return new Error('asyncStorage.setItem unavailable');
      }
      await asyncStorage.setItem(tombstoneKey(key), TOMBSTONE_VALUE);
      return null;
    } catch (e) {
      return e ?? new Error('tombstone write failed');
    }
  };

  /** 读取登出墓碑；返回 true 表示存在（读取失败按「不存在」处理，不阻断正常迁移） */
  const hasTombstone = async (key: string): Promise<boolean> => {
    try {
      const v = await asyncStorage.getItem(tombstoneKey(key));
      return v !== null && v !== undefined;
    } catch (e) {
      logger.warn('⚠️ 读取登出墓碑失败（按不存在处理）:', readErrMessage(e));
      return false;
    }
  };

  /** 清除登出墓碑（重新登录时调用）；失败仅告警 */
  const clearTombstone = async (key: string): Promise<void> => {
    try {
      await asyncStorage.removeItem(tombstoneKey(key));
    } catch (e) {
      logger.warn('⚠️ 清除登出墓碑失败（忽略）:', readErrMessage(e));
    }
  };

  return {
    /**
     * 读取会话。
     * - 安全副本存在 → 返回，并**补清理**可能残留的旧明文；
     * - 安全副本不存在但存在旧明文 → 迁移（写入 + 回读校验 + 清除明文）；
     * - 都没有 → 返回 null。
     */
    getItem: async (key: string): Promise<string | null> => {
      const secureKey = toSecureKey(key);

      let secureValue: string | null;
      try {
        secureValue = await secureStore.getItemAsync(secureKey);
      } catch (e) {
        // ❌ 不降级到 AsyncStorage：安全存储不可用即显式失败
        logger.error('🔒 SecureStore 读取失败（不降级明文）:', readErrMessage(e));
        // C02：在失败第一现场记录状态位，因为 GoTrue 会吞掉本异常
        status.markFailed(AUTH_STORAGE_ERROR.UNAVAILABLE, e);
        throw authStorageError(AUTH_STORAGE_ERROR.UNAVAILABLE, e);
      }

      // 读取成功即证明存储链路可用 → 清除历史故障态
      status.clear();

      if (secureValue !== null && secureValue !== undefined) {
        // 🔒 T6.2/FIX-1：安全副本存在时**也必须**完成明文清理。
        //
        // 旧实现此处直接 `return secureValue`，导致：
        //   · 上一次迁移时明文删除失败（LEGACY_CLEANUP_FAILED）后，
        //     之后每次冷启动都走这条「安全副本存在」分支，
        //     明文 token **永远不会再被清理**，永久残留。
        //   · 用户点「重试」也只是清掉状态位，残留依旧存在。
        //
        // 现在：每次成功读到安全副本都顺手补清理一次明文。
        //   · 清理成功 → 状态位保持健康（上面已 clear）；
        //   · 清理失败 → 记录 LEGACY_CLEANUP_FAILED，但**不阻断会话**
        //     （安全副本有效，用户必须能正常进入应用）。
        //   这样「重试」会真正执行删除动作，而不是只清状态位。
        const purgeErr = await purgeLegacy(key);
        if (purgeErr) {
          logger.error('🔒 补清理旧明文失败（安全副本有效，不阻断会话）:', readErrMessage(purgeErr));
          status.markFailed(AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED, purgeErr);
        }
        return secureValue;
      }

      // 🔒 T6.2/FIX-01：迁移前先检查登出墓碑。
      //   若上一次登出「安全副本已删除、明文清理失败」，重启后此处会看到墓碑。
      //   此时**绝不能**把残留明文重新迁移回 SecureStore（否则凭据复活），
      //   而应清除明文并返回 null（用户保持已登出）。
      if (await hasTombstone(key)) {
        const purgeErr = await purgeLegacy(key);
        if (purgeErr) {
          logger.error('🔒 登出墓碑存在，清除残留明文失败:', readErrMessage(purgeErr));
          status.markFailed(AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED, purgeErr);
        }
        return null;
      }

      // 🔁 一次性迁移：仅当安全存储确认无值时，才读取旧明文
      let legacy: string | null;
      try {
        legacy = await asyncStorage.getItem(key);
      } catch (e) {
        // 读旧明文失败不影响主流程：视为无旧会话
        logger.warn('⚠️ 读取旧明文会话失败（忽略）:', readErrMessage(e));
        return null;
      }
      // 🔒 T6.2 收尾缺陷1：空串是「登出失败安全兜底」写入的无效占位
      //   （见 removeItem：墓碑写失败且明文删不掉时覆写为 ''）。
      //   绝不能把空串当作有效会话迁移回 SecureStore，否则会写入无效凭据。
      //   视为无会话，并顺手清除该占位。
      if (legacy === null || legacy === undefined || legacy === '') {
        if (legacy === '') {
          const purgeErr = await purgeLegacy(key);
          if (purgeErr) {
            logger.warn('⚠️ 清除空串明文占位失败（忽略）:', readErrMessage(purgeErr));
          }
        }
        return null;
      }

      // 先安全写入，再回读校验，最后才清除明文
      try {
        await secureStore.setItemAsync(secureKey, legacy);
        const verify = await secureStore.getItemAsync(secureKey);
        if (verify !== legacy) {
          throw new Error('secure write verify mismatch');
        }
      } catch (e) {
        // 安全写入/校验失败：保留明文（避免用户被强制登出），但显式报错
        logger.error('🔒 旧会话迁移到 SecureStore 失败:', readErrMessage(e));
        status.markFailed(AUTH_STORAGE_ERROR.MIGRATION_FAILED, e);
        throw authStorageError(AUTH_STORAGE_ERROR.MIGRATION_FAILED, e);
      }

      // 迁移成功 → 该 key 已不再是「已登出」状态，清除墓碑（防御性）
      await clearTombstone(key);

      // 安全副本已确认存在 → 清除明文副本。
      // C01：清除失败必须显式上报，不能静默留痕（明文 token 残留是安全问题）。
      //
      // 🔒 T6.1/FIX-04：清理失败**不得阻断会话恢复**。
      //    此时安全副本已写入并通过回读校验，用户会话是有效的；
      //    若因「明文删不掉」而抛错，GoTrue 会把整个 getItem 视为失败，
      //    用户被强制登出 —— 用「可用性」去换「清理彻底性」是错误取舍。
      //    正确做法：记录故障状态位（供上层提示/重试清理）+ 打日志，
      //    但**照常返回已就绪的安全副本**，让用户正常进入应用。
      //    明文残留会在下一次 removeItem（登出）或下次迁移尝试时被再次清理。
      //    T6.2/FIX-1 保证：下一次 getItem 命中「安全副本存在」分支时会再次尝试清理，
      //    因此「重试」能真正清除残留，而不是只清状态位。
      const purgeErr = await purgeLegacy(key);
      if (purgeErr) {
        logger.error(
          '🔒 清除旧明文会话失败（安全副本已就绪，明文可能残留，不阻断会话）:',
          readErrMessage(purgeErr)
        );
        status.markFailed(AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED, purgeErr);
        // 注意：这里**不 throw**，继续返回 legacy。
      }
      return legacy;
    },

    /** 写入会话。失败即抛错，绝不写明文。 */
    setItem: async (key: string, value: string): Promise<void> => {
      const secureKey = toSecureKey(key);
      try {
        await secureStore.setItemAsync(secureKey, value);
      } catch (e) {
        // ❌ 不降级到 AsyncStorage：宁可登录失败，也不写明文 token
        logger.error('🔒 SecureStore 写入失败（不降级明文）:', readErrMessage(e));
        status.markFailed(AUTH_STORAGE_ERROR.UNAVAILABLE, e);
        throw authStorageError(AUTH_STORAGE_ERROR.UNAVAILABLE, e);
      }
      // 🔒 T6.2/FIX-01：成功写入新会话 = 用户已重新登录，
      //   必须清除登出墓碑，否则下次 getItem 会误判为「已登出」而拒绝会话。
      await clearTombstone(key);
      // 写入成功 → 存储链路可用
      status.clear();
    },

    /**
     * 删除会话（登出）。
     * 两处副本都尽力清除；任一失败都要显式上报，避免「以为登出了」。
     */
    removeItem: async (key: string): Promise<void> => {
      const secureKey = toSecureKey(key);
      let secureFailed: unknown = null;
      try {
        await secureStore.deleteItemAsync(secureKey);
      } catch (e) {
        logger.error('🔒 SecureStore 删除失败:', readErrMessage(e));
        secureFailed = e;
      }

      // 始终尽力清除 AsyncStorage 残留（含迁移前的旧明文）
      // 🔒 T6.2/FIX-1：复用 purgeLegacy，保证登出后明文一定被尝试删除；
      //    若删除失败，上层会收到 LEGACY_CLEANUP_FAILED 并可重试，
      //    重试路径（getItem 的补清理 / 再次 removeItem）会真正执行删除。
      const legacyFailed = await purgeLegacy(key);
      if (legacyFailed) {
        logger.error('🔒 清除 AsyncStorage 残留失败:', readErrMessage(legacyFailed));
      }

      // 安全副本删除失败 → 抛错，避免上层误以为已登出
      if (secureFailed) {
        status.markFailed(AUTH_STORAGE_ERROR.UNAVAILABLE, secureFailed);
        throw authStorageError(AUTH_STORAGE_ERROR.UNAVAILABLE, secureFailed);
      }

      // 🔒 T6.2/FIX-01：安全副本已删除 = 登出已生效。
      //   必须**持久化**这一事实（墓碑），否则若明文清理失败，
      //   重启后 getItem 会把残留明文重新迁移回 SecureStore（凭据复活）。
      let tombErr = await writeTombstone(key);
      if (tombErr) {
        logger.error(
          '🔒 写入登出墓碑失败（登出已生效，但重启后可能复活残留明文）:',
          readErrMessage(tombErr)
        );
      }

      // 🔒 T6.2 收尾缺陷1：失败安全兜底。
      //
      //   危险组合：墓碑写入失败 **且** 明文删除失败。
      //   此时既无持久化「已登出」标记，明文又原样残留 —— 重启后 getItem
      //   会把残留明文重新迁移回 SecureStore，凭据复活（安全缺陷）。
      //
      //   失败安全策略（按优先级，绝不因兜底失败而误报登出成功）：
      //     1. 墓碑写失败 → **重试一次**墓碑写入（瞬时故障常可恢复）；
      //     2. 墓碑仍写不进 → **重试一次**明文删除；
      //     3. 两者都失败 → 记录故障态并抛错，让上层明确「登出未彻底完成」，
      //        由上层（useAuth）提示用户 / 触发强制清理，绝不静默放过。
      //
      //   注：本适配器**始终只向 AsyncStorage 写墓碑 key**（值不含凭据），
      //   绝不写会话 key（C14 契约）。因此兜底只做「重试」，不做「覆写明文」。
      let effectiveLegacyFailed: unknown = legacyFailed;
      if (tombErr && legacyFailed) {
        // 步骤 1：重试墓碑写入
        tombErr = await writeTombstone(key);
        if (!tombErr) {
          // 墓碑已持久化 → 重启后 getItem 会拒绝迁移，复活风险已消除。
          // 明文残留虽仍在，但已不再是安全缺陷（墓碑兜底），无需抛错。
          effectiveLegacyFailed = null;
          logger.warn('🔒 墓碑写失败后重试成功（已消除复活风险）');
        } else {
          // 步骤 2：墓碑仍写不进 → 重试明文删除
          const retryErr = await purgeLegacy(key);
          if (!retryErr) {
            effectiveLegacyFailed = null;
            logger.warn('🔒 墓碑写失败，但重试明文删除成功（已消除复活风险）');
          } else {
            // 步骤 3：两者都失败 → 保留故障态，交由下方抛错
            effectiveLegacyFailed = retryErr;
            logger.error(
              '🔒 墓碑写失败且明文删不掉（登出未彻底完成，需上层强制清理）:',
              readErrMessage(retryErr)
            );
          }
        }
      }

      // 明文残留清理失败（且兜底未能消除）→ 显式上报（C01）
      if (effectiveLegacyFailed) {
        status.markFailed(AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED, effectiveLegacyFailed);
        throw authStorageError(AUTH_STORAGE_ERROR.LEGACY_CLEANUP_FAILED, effectiveLegacyFailed);
      }
      // 两处都删除成功（或兜底已消除复活风险）→ 存储链路可用
      status.clear();
    },
  };
}
// --- END OF FILE src/services/authStorage.ts ---
