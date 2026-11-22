// --- START OF FILE src/hooks/useOwnerKey.js ---
import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from './useAuth';

/**
 * 🆔 身份作用域令牌（ownerKey）公共守卫 —— TASK-P1.0 / 工作包 B（C1 / C2）
 *
 * 背景：
 *   账号切换时，仅靠 `useEffect` 清空 state 无法阻止三类跨账号残留：
 *     ① 旧异步结果回填：切号前发出的请求在切号后 resolve，把 A 的数据写进 B 的 state；
 *     ② 旧订阅回调写入：切号前建立的 Realtime channel 回调仍持有旧闭包，事件到达时写入新账号 state；
 *     ③ 切号瞬间的敏感 UI 闪现：state 清空是异步的（下一次 render 才生效），期间旧数据仍在屏幕上。
 *
 * 方案：
 *   ownerKey = `${ownerId}::${authEpoch}`
 *     · ownerId   —— 当前账号 id（未登录为 null）
 *     · authEpoch —— 身份代际，每次真实身份转移自增（含同账号重新登录）
 *   两者任一变化都会产生新的 ownerKey，因此「同账号重新登录」也能正确失效旧结果。
 *
 * 用法：
 *   const { ownerKey, ownerKeyRef, isOwnerKeyCurrent } = useOwnerKey();
 *   // 在 effect 内捕获快照：
 *   const snapshot = ownerKey;
 *   // 异步结果 / 订阅回调写 state 前比对：
 *   if (!isOwnerKeyCurrent(snapshot)) return;
 *
 * ⚠️ 本 Hook 不定义新的身份代际系统，仅对 useAuth 已导出的 ownerId / authEpoch 做组合，
 *    避免与既有 B1 系列隔离机制产生冲突。
 */
export function useOwnerKey() {
  const { ownerId, authEpoch } = useAuth();
  const ownerKey = `${ownerId ?? 'anon'}::${authEpoch ?? 0}`;

  // 供异步回调 / Realtime 回调即时读取（不触发重渲染）
  const ownerKeyRef = useRef(ownerKey);
  useEffect(() => {
    ownerKeyRef.current = ownerKey;
  }, [ownerKey]);

  /**
   * 判断某次操作发起时捕获的 ownerKey 快照是否仍然有效。
   * @param {string} snapshot 发起时捕获的 ownerKey
   * @returns {boolean}
   */
  // useCallback 保证引用稳定：可安全放入依赖数组而不触发无限重渲染
  const isOwnerKeyCurrent = useCallback(
    (snapshot) => ownerKeyRef.current === snapshot,
    []
  );

  return { ownerKey, ownerKeyRef, isOwnerKeyCurrent };
}

export default useOwnerKey;
// --- END OF FILE src/hooks/useOwnerKey.js ---
