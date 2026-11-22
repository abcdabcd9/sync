// --- START OF FILE src/services/authAutoRefresh.ts ---
// ============================================================================
// P0.3 iOS-01 — Supabase Auth 自动刷新生命周期管理
//
// 缺陷根因（只读诊断 + 真实 SDK 探针，见
//   .internal/refactor/tasks/TASK-P0.3/ios01/ios01_probe.mjs）：
//
//   `@supabase/auth-js` 的 `_handleVisibilityChange()` 在**非浏览器环境**
//   （React Native 属于此类）走的是：
//       if (this.autoRefreshToken) { this.startAutoRefresh(); }
//   即「假定永远在前台」。于是 `autoRefreshToken: true` 的客户端一旦初始化，
//   `setInterval` ticker 就**永不停**。
//
//   App 长时间切到后台后，iOS 会锁定 Keychain，`SecureStore.getItemAsync`
//   抛错 → 适配器 `status.markFailed(AUTH_STORAGE_UNAVAILABLE)` →
//   SDK 打印 `Auto refresh tick failed with error.`，且**每次 tick 都重复**。
//
// 修复方式（Supabase 官方 React Native 推荐做法，不关闭自动刷新）：
//   注册**唯一一个** AppState 监听器：
//     · state === 'active'                 → auth.startAutoRefresh()
//     · state === 'background' / 'inactive' → auth.stopAutoRefresh()
//
// 不变量：
//   1. 同一时刻最多一个 AppState 监听器（重复 start() 幂等）。
//   2. 同一状态下不重复调用 start/stop（幂等，避免后台多次事件重复 stop）。
//   3. dispose() 必须移除监听器（卸载 / 开发热更新不累积）。
//   4. 冷启动按 appState.currentState 初始化。
//   5. 不吞异常：start/stop 的失败通过 onError 上报，不静默丢弃。
//   6. 不修改凭证存储方式，不绕过 AUTH_STORAGE_UNAVAILABLE 检测。
//
// ⚠️ P1.2 R5 迁移约束：
//   本文件是 `src/services/authAutoRefresh.js` 的**逐行等价** TypeScript 迁移。
//   仅添加类型标注，**不改变任何运行时行为**：状态机转移顺序、决策序号、
//   探测代际、重试次数、定时器间隔、串行链语义全部保持原样。
//   基线见 `tests/fixtures/p12r5/before/services__authAutoRefresh.js`。
// ============================================================================

/** Supabase auth 客户端中本控制器实际调用的方法子集 */
export interface AutoRefreshAuthLike {
  startAutoRefresh(): Promise<void> | void;
  stopAutoRefresh(): Promise<void> | void;
}

/** AppState 订阅句柄 */
export interface AppStateSubscription {
  remove(): void;
}

/** React Native AppState 中本控制器实际使用的字段子集 */
export interface AppStateLike {
  readonly currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): AppStateSubscription;
}

/** 探测重试参数（测试可注入） */
export interface AutoRefreshTiming {
  retryDelayMs?: number;
  maxRetries?: number;
  recoveryDelayMs?: number;
}

/** 控制器构造参数 */
export interface CreateAutoRefreshControllerOptions {
  auth: AutoRefreshAuthLike;
  appState: AppStateLike;
  onError?: (err: unknown) => void;
  /**
   * 🍎 BUG-02（iOS-01 残留）可选：SecureStore 可用性探测。
   * 返回 Promise<boolean>：true=可用，false=暂不可用。
   * 提供时，'active' 分支会**先探测再启动 ticker**：
   * iOS 解锁后 Keychain 存在短暂不可用窗口，
   * 若此时立即 startAutoRefresh()，首个 tick 读
   * SecureStore 会抛 `User interaction is not allowed`。
   * 探测失败则延迟重试，期间不启动 ticker（不产生失败 tick）。
   * 不提供时行为与旧版完全一致（直接 start），保证既有契约不破。
   */
  probeStorage?: () => Promise<boolean> | boolean;
  timing?: AutoRefreshTiming;
}

/** 控制器公开接口 */
export interface AutoRefreshController {
  /** 注册唯一监听器，并按当前 AppState 初始化（幂等） */
  start(): void;
  /** 等待所有在途 start/stop 完成（测试与调用方可用） */
  flush(): Promise<void>;
  /** 移除监听器并停止自动刷新（卸载 / 热更新） */
  dispose(): void;
  /** 供断言：当前是否处于运行态 */
  isRunning(): boolean;
}

/**
 * 创建自动刷新生命周期控制器。
 *
 * 运行时签名严格还原原 JS：`createAutoRefreshController({ ... } = {})`。
 * 因此参数类型使用 `Partial<CreateAutoRefreshControllerOptions>` 并带 `= {}` 默认值 ——
 * 不传参 / 传 `undefined` 时不会在解构阶段抛错，而是走下方原有的参数校验路径，
 * 抛出与旧版完全一致的 `TypeError`。对外调用方仍应传入合法 options。
 */
export function createAutoRefreshController({
  auth,
  appState,
  onError,
  probeStorage,
  timing,
}: Partial<CreateAutoRefreshControllerOptions> = {}): AutoRefreshController {
  if (!auth || typeof auth.startAutoRefresh !== 'function' || typeof auth.stopAutoRefresh !== 'function') {
    throw new TypeError('createAutoRefreshController: auth 必须提供 startAutoRefresh / stopAutoRefresh');
  }
  if (!appState || typeof appState.addEventListener !== 'function') {
    throw new TypeError('createAutoRefreshController: appState 必须提供 addEventListener');
  }

  const reportError: (err: unknown) => void =
    typeof onError === 'function'
      ? onError
      : (err) => {
          // 不吞异常：至少留下可观测的错误日志
          console.error('[authAutoRefresh] 生命周期调用失败:', err);
        };

  // 待完成的异步任务队列（供测试 flush 与内部串行化）
  // 类型说明：原 JS 的 `pending` 存放的是 `Promise.resolve(promise).catch(...)`
  // 的结果，其成功值类型为 `unknown`（catch 回调返回 void 不会收窄成功分支）。
  // 这里如实使用 `Promise<unknown>[]`，避免为凑 `Promise<void>` 而额外追加
  // `.then(() => undefined)` 改变微任务时序。
  const pending: Promise<unknown>[] = [];
  let subscription: AppStateSubscription | null = null;
  let disposed = false;
  let started = false;
  // 当前 ticker 期望状态：null = 未知（尚未决策），true = 运行，false = 停止
  let desiredRunning: boolean | null = null;

  // 🍎 BUG-02（iOS-01 残留）：SecureStore 可用性探测重试参数。
  //    iOS 解锁后 Keychain 存在短暂不可用窗口；探测失败时按此参数延迟重试，
  //    期间**不启动 ticker**，避免产生失败的自动刷新 tick。
  const retryDelayMs = Number.isFinite(timing?.retryDelayMs) ? (timing?.retryDelayMs as number) : 250;
  const maxRetries = Number.isFinite(timing?.maxRetries) ? (timing?.maxRetries as number) : 20;
  // 🍎 BLOCK-03：重试耗尽后的「低频恢复探测」间隔。
  //   默认 30s，远大于 retryDelayMs，避免无限高频重试；同时保证 SecureStore
  //   恢复后能在有限时间内重新启动 ticker（不会永久卡死）。
  const recoveryDelayMs = Number.isFinite(timing?.recoveryDelayMs)
    ? (timing?.recoveryDelayMs as number)
    : 30000;
  // 探测代际：每次进入 active 递增；用于丢弃「已过期」的探测重试（例如探测期间又切后台）。
  let probeGeneration = 0;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  const track = (promise: Promise<unknown>): Promise<unknown> => {
    // 严格还原原 JS：`Promise.resolve(promise).catch(...)`，不追加额外 `.then`。
    // 返回类型为 `Promise<unknown>`（与 `pending` 元素类型一致），
    // 保持与原实现完全相同的微任务时序。
    const wrapped: Promise<unknown> = Promise.resolve(promise).catch((err): void => {
      reportError(err);
    });
    pending.push(wrapped);
    wrapped.finally(() => {
      const i = pending.indexOf(wrapped);
      if (i !== -1) pending.splice(i, 1);
    });
    return wrapped;
  };

  const clearProbeTimer = (): void => {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  };

  // 🍎 BLOCK-02：start/stop 串行化。
  //   旧实现并发调用 auth.startAutoRefresh()/stopAutoRefresh()，两者可乱序完成
  //   （旧 start 晚于新 stop 完成 → ticker 残留运行）。
  //   修复：所有 SDK 生命周期调用进入同一条串行链，**同一时刻只有一个在途调用**，
  //   下一个调用必须等上一个 settle 后才发起。这样完成顺序 == 发起顺序，
  //   最终真实状态必然等于最后一次决策（最新 AppState）。
  //   · 每次决策递增 decisionSeq；链上执行时若该决策已被更新决策取代，则跳过，
  //     避免执行过期的 start/stop（例如快速 active→background→active）。
  let opChain: Promise<unknown> = Promise.resolve();
  let decisionSeq = 0;

  const enqueueOp = (kind: 'start' | 'stop'): Promise<unknown> => {
    const seq = decisionSeq;
    const fn = kind === 'start' ? auth.startAutoRefresh : auth.stopAutoRefresh;
    const run: Promise<unknown> = opChain.then(() => {
      // 卸载后绝不再启动 ticker；但卸载时入队的 stop 必须执行（否则旧 start
      // 完成后 ticker 会残留运行）。因此仅对 start 施加 disposed 短路。
      if (disposed && kind === 'start') return undefined;
      // 🍎 BLOCK-A：stop 是「安全操作」，永不过期。
      //   过期 start 会错误地启动 ticker（不安全），必须跳过；
      //   但过期 stop 只会让 ticker 停止（安全），绝不能因决策序号变化而丢弃，
      //   否则快速 background→active 会让已排队的 stop 被跳过，导致 probe 不可用
      //   时旧 ticker 残留运行。因此仅对 start 施加 seq 过期短路。
      if (kind === 'start' && seq !== decisionSeq) return undefined;
      // 严格还原原 JS：直接返回 SDK 调用结果，不额外包一层 `Promise.resolve().then`。
      return fn.call(auth);
    });
    // 链推进：吞掉错误避免断链（错误已通过 track 上报）。
    opChain = run.catch(() => {});
    return track(run);
  };

  // 真正启动 ticker（探测通过后调用）。
  const startTicker = (): void => {
    if (disposed) return;
    enqueueOp('start');
  };

  // 带探测的启动：先确认 SecureStore 可用，再启动 ticker。
  //   · 未注入 probeStorage → 直接启动（旧行为，保证既有契约不破）。
  //   · 注入 probeStorage → 探测成功才启动；失败则延迟重试，期间不启动 ticker。
  //   · 🍎 BLOCK-03：重试耗尽后进入「低频恢复探测」——不再高频重试，
  //     但保留一条可恢复路径：按 recoveryDelayMs 低频重探，一旦 SecureStore
  //     恢复可用即启动 ticker，避免永久卡死（同时避免无限高频重试）。
  const startWithProbe = (generation: number): void => {
    if (disposed) return;
    if (typeof probeStorage !== 'function') {
      startTicker();
      return;
    }
    // 🍎 FINAL-1（P0.3 FINAL L4 收尾）：probe 等待窗口内不得遗留运行中的 ticker。
    //   根因：旧实现只在 probe 的 `.then()` 里 enqueueOp('stop')。probe Promise
    //   处于 pending 期间没有任何 stop 入队，而 SDK 初始化（autoRefreshToken:true）
    //   在 RN 非浏览器环境已启动 ticker 且永不停 → 探测挂起时 ticker 持续运行，
    //   每次 tick 都可能读 SecureStore 抛错。
    //   修复：进入 active 且带 probe 时，**先停 ticker**（stop 是安全幂等操作），
    //   待 probe 确认可用后才 start。这样「存储可用性未确认」期间绝不遗留运行中的
    //   ticker。stop 走串行链（保留串行化），且 stop 永不过期（BLOCK-A），
    //   因此即便后续快速切后台/active 也不会被丢弃。
    enqueueOp('stop');
    let attempt = 0;
    const tryOnce = (): void => {
      if (disposed || generation !== probeGeneration) return; // 已切后台/卸载 → 放弃
      let probeResult: Promise<boolean> | boolean;
      try {
        probeResult = probeStorage();
      } catch (err) {
        // 探测本身同步抛错 → 视为不可用，走重试
        probeResult = Promise.reject(err);
      }
      track(
        Promise.resolve(probeResult).then(
          (available) => {
            if (disposed || generation !== probeGeneration) return;
            if (available) {
              startTicker();
              return;
            }
            // 🍎 BLOCK-A：探测失败 → 必须确保旧 ticker 已停止。
            //   SDK 初始化阶段（autoRefreshToken:true）可能已启动 ticker，
            //   若此处只重试而不 stop，旧 ticker 会残留运行。
            //   stop 是安全操作（幂等），即便 ticker 本未运行也无害。
            enqueueOp('stop');
            // 不可用 → 延迟重试（不启动 ticker）
            attempt += 1;
            if (attempt >= maxRetries) {
              // 超过最大重试仍不可用：不启动 ticker，交由上层 authStorageStatus 呈现故障态。
              // 不吞异常：记录一次可观测日志（不重复刷屏）。
              reportError(
                new Error(
                  `[authAutoRefresh] SecureStore 探测连续 ${attempt} 次不可用，暂不启动自动刷新`
                )
              );
              // 🍎 BLOCK-03：进入低频恢复探测（不是放弃）。
              //   用 recoveryDelayMs 间隔继续探测；一旦可用即启动 ticker。
              //   这既保证「恢复后能重启」，又避免高频重试（间隔远大于 retryDelayMs）。
              probeTimer = setTimeout(tryOnce, recoveryDelayMs);
              return;
            }
            probeTimer = setTimeout(tryOnce, retryDelayMs);
          },
          (err) => {
            if (disposed || generation !== probeGeneration) return;
            // 🍎 BLOCK-A：探测抛错同样视为不可用 → 必须确保旧 ticker 已停止。
            enqueueOp('stop');
            // 探测抛错 → 同样视为不可用，延迟重试
            attempt += 1;
            if (attempt >= maxRetries) {
              reportError(err);
              // 🍎 BLOCK-03：同样进入低频恢复探测。
              probeTimer = setTimeout(tryOnce, recoveryDelayMs);
              return;
            }
            probeTimer = setTimeout(tryOnce, retryDelayMs);
          }
        )
      );
    };
    tryOnce();
  };

  const applyState = (state: string): void => {
    if (disposed) return;
    const shouldRun = state === 'active';
    if (desiredRunning === shouldRun) {
      // 幂等：同一状态重复事件不重复调用 SDK
      return;
    }
    desiredRunning = shouldRun;
    // 🍎 BLOCK-02：每次决策递增序号；串行链上执行时据此丢弃过期操作。
    decisionSeq += 1;
    if (shouldRun) {
      // 进入 active：递增探测代际，取消上一轮未完成的探测重试，再带探测启动。
      probeGeneration += 1;
      clearProbeTimer();
      startWithProbe(probeGeneration);
    } else {
      // 离开 active：作废进行中的探测（防止探测通过后在后台启动 ticker）。
      probeGeneration += 1;
      clearProbeTimer();
      enqueueOp('stop');
    }
  };

  const handleChange = (nextState: string): void => {
    applyState(nextState);
  };

  return {
    /** 注册唯一监听器，并按当前 AppState 初始化（幂等） */
    start(): void {
      if (disposed || started) return;
      started = true;
      subscription = appState.addEventListener('change', handleChange);
      // 冷启动：按当前状态初始化
      applyState(appState.currentState);
    },

    /** 等待所有在途 start/stop 完成（测试与调用方可用） */
    async flush(): Promise<void> {
      // 允许 flush 期间产生的新任务也被等待
      while (pending.length > 0) {
        await Promise.all(pending.slice());
      }
    },

    /** 移除监听器并停止自动刷新（卸载 / 热更新） */
    dispose(): void {
      if (disposed) return;
      // 🍎 BUG-02：作废进行中的探测重试并清理定时器，避免卸载后仍启动 ticker。
      probeGeneration += 1;
      clearProbeTimer();
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
      subscription = null;
      // 卸载时确保 ticker 停止，避免残留 interval。
      // 🍎 BLOCK-02：卸载也走串行链，并递增决策序号，使任何在途的旧 start
      //   在链上执行时被判定为过期而跳过，保证卸载后 ticker 不会因旧 start
      //   完成而残留运行。
      //   注意：必须在置 disposed=true **之前**入队 stop —— 否则 enqueueOp 的
      //   `if (disposed) return` 会跳过这次 stop，导致旧 start 完成后 ticker 残留。
      if (desiredRunning !== false) {
        desiredRunning = false;
        decisionSeq += 1;
        enqueueOp('stop');
      }
      disposed = true;
    },

    /** 供断言：当前是否处于运行态 */
    isRunning(): boolean {
      return desiredRunning === true;
    },
  };
}

export default { createAutoRefreshController };
// --- END OF FILE src/services/authAutoRefresh.ts ---
