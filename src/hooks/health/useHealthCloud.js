// --- START OF FILE src/hooks/health/useHealthCloud.js ---
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../services/supabase';
import {
  createRevokeVerifier,
  isAuthEventRelevant,
  shouldRevokeOnAuthChange,
} from './authRevokeLogic';

/**
 * 云端数据 Hook（health_records 相关网络 IO 与双镜像离线持久化）。
 *
 * 职责：
 *   1. fetchMyRecord(date)     拉取自己今日数据
 *   2. fetchPartnerRecord(pId, date) 拉取伴侣今日数据（Cache-First 本地优先）
 *   3. subscribePartner(id, date, onData) partner_health_channel 实时订阅
 *   4. syncToCloud(water, meals) 1.5 秒防抖 upsert
 *   5. flushNow()              强制立即提交防抖队列中的数据
 */

const EMPTY_MEALS = { '早餐': false, '午餐': false, '晚餐': false };
const DEBOUNCE_MS = 1500;

// ============================================================================
// 🛡️ TASK-P0.3 / B4 — 健康数据同步可靠性（Pending 持久化 + 版本化提交）
//
// B4 诊断确认的真实缺陷（详见 TASK_P0.3.md §19.4）：
//   R-01/R-02  pendingMapRef 为纯内存 Map，进程结束即丢失，冷启动无法恢复。
//   R-03/R-07  本地已落盘的新值，冷启动后被云端旧快照 hydrate 覆盖。
//   R-05       inflightRef 单布尔在并发 flush 时会让第二个 flush 全部跳过。
//   补充二     V1 提交成功会删除已被 V2 覆盖的槽位（旧成功清理新版本）。
//
// 统一设计（不变量）：
//   I-1  Pending 必须持久化到 AsyncStorage，按 owner 命名空间隔离：
//          @sync_health_pending_v1_${ownerId}  →  JSON { [recordDate]: entry }
//        entry = { recordDate, water, meals, ownerId, rev, updatedAt }
//   I-2  rev 为单调递增版本号（同一 owner+date 每次入队 +1）。
//        提交成功只允许删除「rev 与本次提交 rev 相同」的条目；
//        rev 不同说明已被更新版本覆盖 → 保留新版本，绝不删除。
//   I-3  入队即持久化（先写盘再返回），把「防抖窗口内杀进程」的丢失窗口
//        压缩到「setState 之后、AsyncStorage.setItem 之前」这一无法消除的
//        极小窗口（AsyncStorage 无同步写 API，此为平台保证边界）。
//   I-4  hydrate 冲突判定：若该 owner+date 存在 pending 且 pending.updatedAt
//        不早于云端 updated_at，则拒绝用云端覆盖本地（本地更新优先）。
//   I-5  并发 flush 用「按 key 的 in-flight Set」替代单布尔，避免互相跳过。
//   I-6  所有持久化读写都必须校验 owner 归属，绝不跨账号共享。
// ============================================================================

/** Pending 持久化 key 前缀（版本化，便于未来演进） */
const PENDING_KEY_PREFIX = '@sync_health_pending_v1_';

/** 构造某 owner 的 pending 持久化 key；无 owner 返回 null（不读写磁盘） */
function buildPendingKey(ownerId) {
  if (!ownerId || typeof ownerId !== 'string') return null;
  return `${PENDING_KEY_PREFIX}${ownerId}`;
}

/**
 * 读取某 owner 的持久化 pending 表。
 * @returns {Promise<Record<string, object>>} 失败/无数据时返回空对象（fail-open 到空，不抛错）
 */
async function readPendingStore(ownerId) {
  const key = buildPendingKey(ownerId);
  if (!key) return {};
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // 归属校验：只接受 ownerId 与请求 owner 一致的条目（防串号）
    const out = {};
    for (const [date, entry] of Object.entries(parsed)) {
      if (entry && entry.ownerId === ownerId) out[date] = entry;
    }
    return out;
  } catch (_) {
    return {};
  }
}

/**
 * 写入某 owner 的持久化 pending 表。
 * 空表时直接删除 key（避免残留空对象）。
 */
async function writePendingStore(ownerId, store) {
  const key = buildPendingKey(ownerId);
  if (!key) return;
  try {
    const dates = Object.keys(store || {});
    if (dates.length === 0) {
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, JSON.stringify(store));
  } catch (e) {
    console.warn('⚠️ pending 持久化写入失败(内存态仍保留)', e?.message || e);
  }
}

export function useHealthCloud(user, getDateStr, authEpoch = 0) {
  const [partnerData, setPartnerData] = useState({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  const [partnerId, setPartnerId] = useState(null);

  const timerRef = useRef(null);
  // 🛡️ T6-B 第二轮复审 14-01（BLOCKER）：pending 改为「按 ownerId + recordDate 隔离」的多槽容器。
  //
  //    旧实现只有单一 pendingRef 槽位，syncToCloud 无条件覆盖：
  //      · A 账号某日写入失败（upsert 返回 error）→ 载荷留在 pendingRef；
  //      · 切到 B 账号，B 产生自己的健康数据 → syncToCloud 覆盖同一槽位 → A 的失败载荷被抹掉；
  //      · 切回 A 后 flushNow 已无 A 的原始载荷 → A 的未同步数据永久丢失；
  //      · 同账号跨日期的新记录也会覆盖旧日期的失败载荷。
  //
  //    修复：用 Map 以 `${ownerId}::${recordDate}` 为键隔离每个待同步载荷。
  //      · 不同账号 / 不同日期互不覆盖，各自保留、各自重试。
  //      · 提交成功只删除「该键对应的那一项」，不影响其他待同步项。
  //      · 提交失败 / 跨账号一律保留，等待下次重试。
  //
  // 🛡️ TASK-P0.3 / B4（R-01 / R-02）：**升级为持久化队列**。
  //    内存 Map 仍是运行时唯一事实源（读写零延迟），但每次变更都会镜像到
  //    AsyncStorage（key = @sync_health_pending_v1_${ownerId}），冷启动时
  //    由 hydratePendingFromDisk() 恢复。载荷新增 rev（版本号）与 updatedAt
  //    （入队时刻），用于「旧提交成功不得清理新版本」与「hydrate 冲突判定」。
  const pendingMapRef = useRef(new Map());
  const pendingKeyOf = useCallback((ownerId, recordDate) => `${ownerId}::${recordDate}`, []);

  // 🛡️ T6/A06：授权代际令牌。
  //    每次「搭子关系发生变化」（绑定 / 解绑 / 权威空结果）都会自增。
  //    任何在途的 fetchPartnerRecord / 实时回调在写回 state 前必须比对代际，
  //    代际不一致说明授权已变更，其结果属于过期数据，必须丢弃。
  //    这解决了「解绑后旧请求晚到，把已撤销搭子的健康数据写回缓存」的竞争问题。
  //
  // 🔧 T7-H22 修复：代际同时以 ref + state 双轨维护。
  //    · ref（authGenerationRef）：供异步回调同步读取，零延迟、不触发重渲染。
  //    · state（authGeneration）：供 React 依赖数组使用，让「重绑同一搭子」
  //      这种 partnerId 值未变化、但授权代际已变的场景也能触发订阅重建。
  //    旧实现只有 ref，导致 B↔C 反复绑定同一人时 partnerId 值不变 →
  //    subscribePartner 的 useEffect 不重跑 → 旧订阅已被 cleanup 移除 →
  //    没有任何实时订阅存活，只能重启 App 才刷新。
  const authGenerationRef = useRef(0);
  const [authGeneration, setAuthGeneration] = useState(0);
  const bumpAuthGeneration = useCallback(() => {
    authGenerationRef.current += 1;
    const next = authGenerationRef.current;
    setAuthGeneration(next);
    return next;
  }, []);

  // 🔧 T7-H22：partnerId 的 ref 镜像。
  //    实时回调里用它做「当前是否仍是这个搭子」的实时判定，
  //    替代旧实现「订阅建立时快照 gen，回调时 gen 不一致就丢弃」的做法。
  //    旧做法在重绑同一人后会让订阅永久失效（gen 已变但订阅未重建）。
  const partnerIdRef = useRef(null);
  useEffect(() => {
    partnerIdRef.current = partnerId;
  }, [partnerId]);

  // 🛡️ TASK-P0.3 / B3-01：**会话代际（authEpoch）镜像**。
  //
  //    缺陷（B3 诊断确认）：本 Hook 的账号切换清理 effect 只依赖 user?.id。
  //    「A → 登出 → A 重新登录」或「同账号新会话」时 userId 完全相同，
  //    effect 不重跑 → authGeneration 不自增 → partnerId / partnerData 保留
  //    上一会话的残留值，且上一会话在途的 fetchPartnerRecord / 实时回调
  //    代际校验依然通过，可把旧会话的搭子数据写进新会话。
  //
  //    修复：把 authEpoch 纳入「身份转移」判定。epoch 变化（含同账号重登）
  //    与 userId 变化同等对待：自增授权代际、清空搭子状态、取消防抖定时器。
  //    注意：这里**不**清理磁盘缓存（那是 clearPartner 的职责），
  //    账号切换后的缓存归属由 useHealthData 的 profile 加载负责。
  const authEpochRef = useRef(authEpoch);
  useEffect(() => {
    authEpochRef.current = authEpoch;
  }, [authEpoch]);

  // 🛡️ T6-B/X-08（复审返工 CR-01）+ 第二轮复审 14-01：
  //    pending 载荷必须绑定「入队时的 owner + recordDate」，且「未确认成功前绝不丢弃」。
  //
  //    修复原则（同时满足「防串号」与「不静默丢数据」）：
  //      · 载荷携带 ownerId + recordDate 快照，commit 只写「载荷 owner」而非「当前 user」。
  //      · 载荷 owner 与当前 user 不一致 → 不写云端、不丢弃，原样保留在 pendingMapRef，
  //        待切回原账号后由 flushNow / 防抖重试（可恢复、可重试）。
  //      · upsert 返回 error 或抛异常 → 保留该槽位，等待下次重试。
  //      · 仅当 upsert 确认无 error 时，才删除「该键对应的那一项」（成功确认后才移除）。
  //
  // 🛡️ TASK-P0.3 / B4：并发去重由单布尔 inflightRef 升级为按 key 的
  //    inflightKeysRef（见文件下部 B4 基础设施区）。此处不再声明 inflightRef。

  // 🛡️ T6-B 第二轮复审 14-01（BLOCKER）补充：当前登录用户的 ref 镜像。
  //
  //    commit / tryFlushPending 若直接闭包捕获 user，则「账号切换瞬间仍在队列里的
  //    旧闭包」（例如账号切换 effect 在旧渲染帧注册、于新渲染帧才执行）会以**旧 user**
  //    作为「当前用户」判定，从而把旧账号的槽位当作「当前账号」提交。
  //    虽然载荷 ownerId 仍指向旧账号（不会串写到新账号），但这会让「切回原账号才重试」
  //    的语义被提前触发，且与「当前登录用户」这一事实源脱节。
  //    修复：commit / tryFlushPending 一律读取 userRef.current（执行时的实时值），
  //    保证「当前用户」永远以最新登录态为准，不受闭包陈旧影响。
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  // 🛡️ TASK-P0.3 / B3-L4-R1（缺陷 5）：**state 归属身份**。
  //
  //    partnerId / partnerData 属于「某个身份」（userId + authEpoch）。
  //    身份切换时 React 的第一次渲染发生在 cleanup effect 之前，此时
  //    state 仍是上一账号的残留值，首帧会把 A 的搭子 id 与健康数据暴露给 B。
  //    仅靠 useEffect 内 setState 清空，必然晚一帧。
  //
  //    修复：在**渲染期**比对「state 归属身份」与「当前身份」，不一致则
  //    对外一律呈现空值（partnerId=null、partnerData=空），首帧即不可见。
  //    这是纯派生值，不产生额外 setState，不改变 effect 时序。
  //
  //    ⚠️ 归属身份用 **state** 承载（而非 ref）：渲染期读取 state 是合法
  //      的，读取 ref 会被 react-hooks/refs 判为违规。合法写入路径通过
  //      claimStateOwner() → setStateOwnerKey() 推进归属身份并触发重渲染。
  //
  //    ⚠️ 归属身份必须随「合法写入」同步推进，否则会永久遮蔽：
  //      若只在首次渲染初始化，身份切换后归属永远停留在旧身份 →
  //      ownerIsCurrent 恒为 false → 新会话的合法数据（缓存 / 网络 / 实时）
  //      全部被遮蔽，表现为「重绑同一搭子后搭子数据永久为 0」（T7-H22 回归）。
  //      因此 bindPartner / clearPartner / 账号切换 effect / 所有合法
  //      setPartnerData 写入点都会调用 claimStateOwner() 推进归属身份。
  const [stateOwnerKey, setStateOwnerKey] = useState(`${user?.id ?? ''}::${authEpoch}`);
  // 归属身份的 ref 镜像：供异步回调同步比对（避免闭包读到陈旧 state）。
  const stateOwnerKeyRef = useRef(stateOwnerKey);
  useEffect(() => { stateOwnerKeyRef.current = stateOwnerKey; }, [stateOwnerKey]);
  const claimStateOwner = useCallback(() => {
    const nextKey = `${userRef.current?.id ?? ''}::${authEpochRef.current}`;
    if (stateOwnerKeyRef.current === nextKey) return;
    stateOwnerKeyRef.current = nextKey;
    setStateOwnerKey(nextKey);
  }, []);
  // ref 镜像：供依赖数组被源码契约锁定的 effect 调用（避免改动依赖形状）。
  const claimStateOwnerRef = useRef(null);
  useEffect(() => { claimStateOwnerRef.current = claimStateOwner; }, [claimStateOwner]);

  // ═══════════════════════════════════════════════════════════════════════
  // 🛡️ TASK-P0.3 / B4：Pending 持久化与版本化提交基础设施
  //
  //    ⚠️ 这些 hook 必须位于 B3 测试锁定的前 7 个槽位（0=partnerData
  //       1=partnerId 2=timerRef 3=pendingMapRef 4=pendingKeyOf
  //       5=authGenerationRef 6=authGeneration）**之后**，且位于 commit /
  //       tryFlushPending 之前（它们依赖 persistPending / inflightKeysRef）。
  //       这样既保证 B3 冻结测试读取的槽位索引不变，又避免 TDZ 引用错误。
  // ═══════════════════════════════════════════════════════════════════════

  // 🛡️ TASK-P0.3 / B4（R-05）：按 key 的 in-flight 集合，替代单布尔 inflightRef。
  //    单布尔会让「防抖 flush」与「AppState background flush」并发时，
  //    第二个 flush 的所有 commit 全部 return false 被跳过（虽不丢数据，
  //    但会延迟到下一次 flush，且语义上把「并发」误判为「重复」）。
  //    改为按 key 去重：同一 key 不重复提交，不同 key 可并行。
  const inflightKeysRef = useRef(new Set());

  // 🛡️ TASK-P0.3 / B4-L4-R1（L4-01 / I-9）：in-flight 完成后自动补传。
  //    问题：V1 在途时 V2 的防抖 flush 因同 key 去重被跳过；V1 成功后
  //    没有任何机制重新提交 V2 → V2 永久滞留 pending（需用户再操作/重启）。
  //    修复：commit 的 finally 释放 key 后，若该 key 仍有 pending 且其
  //    「操作序号」大于刚提交的版本，则调度一次 tryFlushPending（微任务，
  //    避免同步递归）。用 ref 持有 tryFlushPending，规避 TDZ 与依赖环。
  //
  //    ⚠️ B4-L4-R2（L4-R1-01）：判定依据由 updatedAt 改为 opSeq。
  //       Date.now() 只有毫秒精度，两次合法编辑可能落在同一毫秒 →
  //       `latest.updatedAt > submittedAt` 恒为 false → V2 永不补传。
  //       opSeq 是本进程内严格单调递增的整数，与系统时间无关。
  const retryFlushRef = useRef(null);

  // 🛡️ TASK-P0.3 / B4-L4-R2（L4-R1-01 / L4-R1-02）：**Pending 操作身份**。
  //
  //    统一问题域：Pending 的「新旧」判定绝不能依赖系统时间（Date.now 既非
  //    跨进程单调，也非毫秒内唯一）。因此引入两个与时间无关的标识：
  //
  //      · bootIdRef —— 本 Hook 实例（≈ 本进程）的唯一标识，随机生成。
  //        仅用于回答「两个 Pending 是否来自同一进程」，绝不比较其大小。
  //      · opSeqRef  —— 本进程内严格单调递增的操作序号（每次 enqueuePending +1）。
  //        同一 bootId 下，opSeq 大者必然后产生 → 可靠的进程内版本序。
  //
  //    载荷同时携带 opId = `${bootId}-${opSeq}`，用于「成功提交只确认对应实例」。
  //    ⚠️ 跨进程（bootId 不同）时**不比较任何序号大小**，改由初始化屏障
  //       （hydratedOwnersRef）给出确定性优先级，见 hydratePendingFromDisk。
  //
  //    ⚠️ bootId 采用「首次入队时惰性生成」而非渲染期生成：
  //       · 渲染期调用 Date.now()/Math.random() 违反 react-hooks/purity；
  //       · 用 useState 惰性初始化器虽合规，但会**新增一个 hook 槽位**，
  //         改变 useHealthCloud 的 hook 数量，进而影响 B3 冻结测试所依赖的
  //         渲染时序（实测会显著加剧 B3 同名 channel 的毫秒级竞争 flake）。
  //       因此这里只声明 ref，真正的 bootId 在 enqueuePending（非渲染期）
  //       首次调用时生成。hydratePendingFromDisk 中若 bootIdRef 仍为 null，
  //       说明本进程尚无新操作，sameBoot 判为 false → 走初始化屏障分支，
  //       语义依然正确（见下方仲裁逻辑）。
  const bootIdRef = useRef(null);
  const opSeqRef = useRef(0);

  // 🛡️ TASK-P0.3 / B4-L4-R1（L4-01 / I-9 精化）：**仅对「防抖已到期」的 key 补传**。
  //    区分两种「V1 在途时存在 V2」的情形：
  //      (a) V2 的防抖 flush 已到期并因同 key 去重被跳过 → V2 已「尝试过」但未提交，
  //          V1 完成后必须自动补传（L4-01 场景：V2 的 1500ms 定时器已触发过）。
  //      (b) V2 的防抖 flush 尚未到期（仍在防抖窗口内）→ V2 的定时器稍后会正常提交，
  //          无需在 V1 完成时抢跑（AC-B4-09/10 场景：V2 应保持 pending 直到自身防抖到期）。
  //    因此用 debounceElapsedKeysRef 记录「该 key 的防抖定时器已触发过」：
  //      · enqueuePending 写入新版本时清除该 key 标记（新版本重新进入防抖窗口）；
  //      · scheduleFlush 的定时器回调触发时，把当前所有 pending key 标记为已到期；
  //      · commit 的 finally 仅当 key 已到期且存在更新版本时才补传。
  //    这样既修复 L4-01（防抖已到期却被去重），又不改变「防抖窗口内 V2 保持 pending」
  //    的既有语义（AC-B4-09/10）。
  const debounceElapsedKeysRef = useRef(new Set());

  // 🛡️ TASK-P0.3 / B4-L4-R1（L4-02 / I-8）：**初始化屏障**。
  //    记录「已从磁盘 hydrate 完成」的 owner。hydrate 完成前用户产生的新操作
  //    属于「本进程新意图」，绝不能被磁盘旧 pending 覆盖（即使磁盘 rev 更大）。
  //
  //    ⚠️ B4-L4-R2（L4-R1-02）：该屏障现在是**唯一的跨进程仲裁依据**。
  //       旧实现用 updatedAt 比较内存/磁盘条目，但设备时钟可能被 NTP 回拨，
  //       磁盘旧条目的时间戳可能「晚于」本进程新操作 → 旧值反覆盖新值。
  //       新规则（见 hydratePendingFromDisk）：
  //         · owner 尚未 hydrate（屏障未建立）→ 内存条目必是本进程新操作
  //           → 无条件优先，磁盘旧条目丢弃（不比较任何时间/序号）；
  //         · owner 已 hydrate → 内存条目只可能来自磁盘恢复或本进程新操作，
  //           两者 bootId 相同则用 opSeq 比较；bootId 不同（理论上不会发生）
  //           则保守保留内存。
  const hydratedOwnersRef = useRef(new Set());

  // 🛡️ TASK-P0.3 / B4：pending 持久化写盘串行化。
  //    多个 syncToCloud / commit 可能并发触发写盘，用 Promise 链保证
  //    「后写覆盖前写」的顺序与内存 Map 的最终状态一致。
  const persistChainRef = useRef(Promise.resolve());

  /**
   * 把内存 pendingMapRef 中「属于 ownerId 的条目」镜像到 AsyncStorage。
   * 串行化执行，避免并发写盘乱序。
   */
  const persistPending = useCallback((ownerId) => {
    if (!ownerId) return Promise.resolve();
    const store = {};
    for (const payload of pendingMapRef.current.values()) {
      if (!payload || payload.ownerId !== ownerId) continue;
      store[payload.recordDate] = payload;
    }
    persistChainRef.current = persistChainRef.current
      .then(() => writePendingStore(ownerId, store))
      .catch(() => {});
    return persistChainRef.current;
  }, []);

  /**
   * 🛡️ TASK-P0.3 / B4（R-02）：冷启动 / 登录后从磁盘恢复 pending。
   * 只恢复「属于当前登录用户」的条目；磁盘上其他 owner 的数据原样保留。
   * 恢复后立即尝试 flush 一次（网络可用时补传）。
   */
  const hydratePendingFromDisk = useCallback(async (ownerId) => {
    if (!ownerId) return;
    // 🛡️ B4-L4-R2（L4-R1-02）：**在第一个 await 之前**快照「屏障是否已建立」。
    //    这是本函数唯一的跨进程仲裁依据：若此刻屏障尚未建立，说明本进程
    //    尚未完成该 owner 的初始化，内存中已存在的条目必然是本进程新操作
    //    （用户冷启动后立刻编辑），必须无条件优先于磁盘旧条目。
    const alreadyHydrated = hydratedOwnersRef.current.has(ownerId);
    const diskStore = await readPendingStore(ownerId);
    let restored = 0;
    let dropped = 0;
    for (const [date, entry] of Object.entries(diskStore)) {
      if (!entry || entry.ownerId !== ownerId) continue;
      const key = pendingKeyOf(ownerId, date);
      const existing = pendingMapRef.current.get(key);
      if (existing) {
        // 🛡️ TASK-P0.3 / B4-L4-R2（L4-R1-02）：**确定性优先级，不比较系统时间**。
        //
        //    旧实现用 `memAt >= diskAt`（updatedAt）判定，隐含假设 Date.now()
        //    跨进程单调。但设备时钟可能被 NTP 回拨：磁盘旧条目的时间戳可能
        //    比本进程新操作「更晚」→ 旧值反覆盖新值（L4-R1-EXTRA-02 复现）。
        //
        //    新规则（两级，均与时间无关）：
        //      1) 屏障未建立（!alreadyHydrated）→ 内存条目必是本进程新操作
        //         → 无条件保留内存，丢弃磁盘旧条目。
        //      2) 屏障已建立 → 内存条目只可能来自「磁盘恢复」或「本进程新操作」。
        //         同一 bootId 下用 opSeq 比较（严格单调，可靠）；
        //         bootId 不同（理论上不会发生）→ 保守保留内存，不比较大小。
        const sameBoot = existing.bootId && existing.bootId === bootIdRef.current;
        const memWins = !alreadyHydrated
          || !sameBoot
          || (existing.opSeq ?? 0) >= (entry.opSeq ?? 0);
        if (memWins) {
          dropped += 1;
          continue;
        }
      }
      // 磁盘条目胜出（或内存无该 key）→ 恢复磁盘条目。
      // 保留磁盘条目的原始 bootId/opSeq（跨进程身份），不伪造本进程序号。
      pendingMapRef.current.set(key, entry);
      restored += 1;
    }
    // 标记该 owner 的初始化屏障已完成（此后 hydrate 不再覆盖本进程新操作）。
    hydratedOwnersRef.current.add(ownerId);
    if (restored > 0) {
      console.log(`🔄 已从磁盘恢复 ${restored} 条未同步健康数据`);
    }
    if (dropped > 0) {
      // 磁盘旧值被本进程更新的操作取代 → 立即把内存态回写磁盘，保持一致性。
      await persistPending(ownerId);
    }
  }, [pendingKeyOf, persistPending]);

  /**
   * 🛡️ TASK-P0.3 / B4（R-07）：查询「某账号某日期是否存在未同步的本地 pending」。
   *    供 useHealthData 的云端 hydrate 闸门使用：若本地有未同步的新值，
   *    则云端旧快照不得覆盖本地（本地优先），避免「冷启动本地新值被旧云端覆盖」。
   *    同时检查内存 Map 与磁盘（冷启动时内存可能尚未 hydrate 完成）。
   */
  const hasPendingFor = useCallback(async (ownerId, recordDate) => {
    if (!ownerId || !recordDate) return false;
    const key = pendingKeyOf(ownerId, recordDate);
    if (pendingMapRef.current.has(key)) return true;
    const diskStore = await readPendingStore(ownerId);
    return Boolean(diskStore[recordDate] && diskStore[recordDate].ownerId === ownerId);
  }, [pendingKeyOf]);

  /**
   * 提交单个 pending 载荷。
   *
   * 🛡️ TASK-P0.3 / B4（补充二）：**版本化提交**。
   *    载荷携带 rev（单调递增版本号）。commit 只负责「把这一版写进云端」，
   *    不负责删除 pending —— 删除由 tryFlushPending 在「确认当前 pending
   *    仍是同一 rev」后才执行。这样「V1 慢 / V2 快」时：
   *      · V2 先成功 → 删除 rev=2 的 pending；
   *      · V1 后成功 → tryFlushPending 发现当前 pending 已不是 rev=1（或已不存在）
   *        → 不删除任何东西，V2 的最终结果不被 V1 的迟到成功覆盖。
   *
   * @returns {Promise<boolean>} true = 该 rev 已确认写入云端；false = 未成功（必须保留）
   */
  const commit = useCallback(async (payload) => {
    if (!payload) return false;
    // 以执行时的实时登录用户为准（避免陈旧闭包把旧账号当作当前账号）。
    const currentUser = userRef.current;
    // 无当前用户（已登出）→ 不写、不丢弃，保留待下次登录重试。
    if (!currentUser) return false;
    // 载荷 owner 与当前登录用户不一致 → 属于其他账号的未同步数据。
    // 绝不写入当前账号（防串号），也绝不丢弃（保留在 pendingMapRef 供切回后重试）。
    if (payload.ownerId && payload.ownerId !== currentUser.id) {
      return false;
    }
    // 🛡️ B4（R-05）：按 key 去重，同一 key 不重复提交，不同 key 可并行。
    const key = pendingKeyOf(payload.ownerId || currentUser.id, payload.recordDate);
    if (inflightKeysRef.current.has(key)) return false;
    inflightKeysRef.current.add(key);
    // 🛡️ B4-L4-R3（L4-R2-CROSS-BOOT）：快照本次提交的「操作身份」，用于 finally
    //    判定在途期间是否产生了更新的版本。
    //
    //    ⚠️ 为什么不再快照 opSeq 并比较大小：
    //       opSeq 只在**同一 bootId 内**严格单调。磁盘恢复的旧进程条目可能携带
    //       很大的 opSeq（如 80），而本进程新操作从 1 开始 → `1 > 80` 为 false，
    //       新操作永不自动补传（L4-R2-CROSS-BOOT 复现：upserts=[1000], pending=2000）。
    //       跨进程比较序号大小在语义上无意义。
    //
    //    新判定（三级，均不跨 boot 比较数值）：
    //      1) opId 身份：当前 pending 的 opId 与提交时不同 → 已被新操作替换；
    //      2) 对象实例：当前 pending 已不是提交时的那个对象 → 已被替换
    //         （覆盖缺少 opId 的旧载荷；同一操作重复恢复不会改变对象实例）；
    //      3) 旧载荷兼容：两者都缺 opId 且是同一对象 → 视为未变化。
    const submittedOpId = payload.opId ?? null;
    const submittedRef = payload;
    try {
      const { error } = await supabase.from('health_records').upsert(
        {
          user_id: payload.ownerId || currentUser.id,
          record_date: payload.recordDate,
          water_amount: payload.water,
          meals_status: payload.meals,
        },
        { onConflict: 'user_id, record_date' }
      );
      if (error) {
        console.warn('⚠️ health_records 云端写入失败(保留待重试)', error?.message || error);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('⚠️ health_records 云端写入异常(保留待重试)', e?.message || e);
      return false;
    } finally {
      inflightKeysRef.current.delete(key);
      // 🛡️ TASK-P0.3 / B4-L4-R1（L4-01 / I-9）：**in-flight 完成后自动补传**。
      //    释放 key 后，若该 key 仍有 pending 且它已**不是**本次提交的那一版，
      //    说明在途期间产生了更新的版本。但只有「该 key 的防抖定时器已触发过」
      //    （debounceElapsedKeysRef 命中）时才补传——若其防抖尚未到期，则交给其
      //    自身定时器，保持「防抖窗口内 pending 保持」的既有语义（AC-B4-09/10）。
      //    用微任务调度，避免在 finally 内同步递归；retryFlushRef 规避 TDZ。
      //
      //    ⚠️ B4-L4-R2（L4-R1-01）：判定依据由 updatedAt 改为操作身份（不再用时间）。
      //    ⚠️ B4-L4-R3（L4-R2-CROSS-BOOT）：判定依据由「opSeq 数值大小」改为
      //       「opId 身份 / 对象实例变化」——跨 bootId 的 opSeq 不可比较。
      const latest = pendingMapRef.current.get(key);
      const replaced = Boolean(latest) && (
        (submittedOpId !== null && (latest.opId ?? null) !== submittedOpId)
        || latest !== submittedRef
      );
      if (replaced && debounceElapsedKeysRef.current.has(key)) {
        debounceElapsedKeysRef.current.delete(key);
        const flush = retryFlushRef.current;
        if (flush) {
          Promise.resolve().then(() => { flush(); }).catch(() => {});
        }
      }
    }
  }, [pendingKeyOf]);

  /**
   * 尝试提交 pendingMapRef 中「属于当前登录用户」的全部载荷。
   *
   * 🛡️ TASK-P0.3 / B4（补充二）：**版本校验后删除**。
   *    提交前快照该载荷的「操作身份」；提交成功后重新读取 map.get(key)，
   *    仅当「当前 pending 仍是同一操作实例」时才删除。若提交期间用户又编辑
   *    产生了新载荷，则保留新载荷，绝不用旧提交的成功清理新版本。
   *    删除后立即 persistPending，保证磁盘与内存一致。
   *
   *    ⚠️ B4-L4-R2（L4-R1-01）：身份判定由 rev 改为 opId。
   *       rev 是进程内序号，冷启动后从 1 重新开始，与磁盘恢复的条目可能
   *       撞号；opId = `${bootId}-${opSeq}` 全局唯一，能精确回答
   *       「当前 pending 是否仍是我刚提交的那一个实例」。
   */
  const tryFlushPending = useCallback(async () => {
    const map = pendingMapRef.current;
    if (!map || map.size === 0) return;
    // 以执行时的实时登录用户为准（避免陈旧闭包把旧账号当作当前账号）。
    const currentUserId = userRef.current?.id ?? null;
    if (!currentUserId) return;
    // 快照键列表，避免迭代过程中 Map 被修改。
    const keys = Array.from(map.keys());
    let mutated = false;
    for (const key of keys) {
      const payload = map.get(key);
      if (!payload) continue;
      // 只提交属于当前登录用户的载荷；其他账号的保留待切回后重试。
      if (payload.ownerId !== currentUserId) continue;
      const submittedOpId = payload.opId ?? null;
      const ok = await commit(payload);
      if (!ok) continue;
      // 🛡️ 重新读取当前 pending，只有「仍是同一操作实例」才删除。
      const current = map.get(key);
      if (current && submittedOpId !== null && (current.opId ?? null) === submittedOpId) {
        map.delete(key);
        mutated = true;
      }
      // 若 current 已不存在（并发 flush 已删）或已是新操作（用户又编辑）→ 不动。
    }
    if (mutated) {
      await persistPending(currentUserId);
    }
  }, [commit, persistPending]);

  // 🛡️ TASK-P0.3 / B4-L4-R1（L4-01 / I-9）：把 tryFlushPending 挂到 ref，
  //    供 commit 的 finally 在 in-flight 释放后调度补传（规避 TDZ / 依赖环）。
  useEffect(() => { retryFlushRef.current = tryFlushPending; }, [tryFlushPending]);

  const flushNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await tryFlushPending();
  }, [tryFlushPending]);

  /**
   * 本地健康数据变更 → 入队 pending → 防抖提交。
   *
   * 🛡️ TASK-P0.3 / B4（R-01 / 补充一）：**入队即持久化**。
   *    旧实现只在内存 Map 里放载荷，进程被杀即丢失。现在：
   *      1. 生成单调递增 rev + updatedAt（入队时刻）；
   *      2. 写入内存 Map（运行时事实源）；
   *      3. **立即** persistPending 落盘（不等防抖），把「进程被杀」窗口
   *         从「整个防抖期」压缩到「一次 AsyncStorage 写入的异步间隙」；
   *      4. 再启动防抖定时器，到点后 tryFlushPending 提交云端。
   *    这样即使防抖窗口内进程被杀，冷启动 hydratePendingFromDisk 也能恢复。
   */
  /**
   * 🛡️ TASK-P0.3 / B4-L4-R1（L4-03 / I-10）：**仅入队 + 落盘**（不启动防抖定时器）。
   *
   *    供 useHealthData 在「外层 500ms 防抖排队时」立即调用，使 Pending 在用户
   *    点击后**立刻**持久化，而不是等 500ms 防抖结束进入 syncToCloud 才落盘。
   *    这样「点击后 500ms 内进程被杀」也能在冷启动时恢复（L4-03 复现缺口）。
   *
   *    🛡️ B4-L4-R2（L4-R1-01 / L4-R1-02）：**操作身份取代时间戳作为版本依据**。
   *      · opSeq：本进程严格单调递增（每次入队 +1），进程内新旧判定的唯一依据；
   *      · bootId：本 Hook 实例标识，仅用于区分「是否同一进程」，不比较大小；
   *      · opId：`${bootId}-${opSeq}`，全局唯一，用于「成功提交只确认对应实例」。
   *      · rev / updatedAt 仍保留写入（向后兼容旧磁盘数据与既有断言），
   *        但**不再参与任何新旧仲裁**。
   * @returns {{ownerId:string, recordDate:string}|null} 入队成功返回定位信息
   */
  const enqueuePending = useCallback((newWater, newMeals, recordDateOverride = null) => {
    const currentUser = userRef.current;
    if (!currentUser) return null;
    // 🛡️ BUG-01（D-11）修复：优先使用调用方传入的 recordDate（即本地数据实际所属日期
    //    todayStr），避免系统时间回拨时 getDateStr() 漂移到「回拨后的日期」，
    //    导致本地数据写在 D0、云端却写到 D1 的日期归属错位。
    const recordDate = recordDateOverride || getDateStr();
    const key = pendingKeyOf(currentUser.id, recordDate);
    const prev = pendingMapRef.current.get(key);
    const nextRev = (prev?.rev ?? 0) + 1;
    // 🛡️ B4-L4-R2：进程内严格单调序号（与系统时间无关）。
    opSeqRef.current += 1;
    const nextOpSeq = opSeqRef.current;
    // 🛡️ B4-L4-R2：bootId 在首次入队时惰性生成（非渲染期，规避 purity 与
    //    hook 槽位变化对 B3 冻结测试渲染时序的影响）。
    if (bootIdRef.current === null) {
      bootIdRef.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    const bootId = bootIdRef.current;
    const payload = {
      recordDate,
      water: newWater,
      meals: newMeals,
      ownerId: currentUser.id,
      rev: nextRev,
      updatedAt: Date.now(),
      bootId,
      opSeq: nextOpSeq,
      opId: `${bootId}-${nextOpSeq}`,
    };
    pendingMapRef.current.set(key, payload);
    // 🛡️ B4-L4-R1（L4-01 / I-9）：新版本重新进入防抖窗口 → 清除「防抖已到期」标记，
    //    避免上一版本的到期标记误触发本版本的自动补传。
    debounceElapsedKeysRef.current.delete(key);
    // 🛡️ 入队即落盘（不等防抖），最小化进程被杀丢数据窗口。
    persistPending(currentUser.id);
    return { ownerId: currentUser.id, recordDate };
  }, [getDateStr, pendingKeyOf, persistPending]);

  /**
   * 启动/重置云端防抖提交定时器（到点后 tryFlushPending）。
   */
  const scheduleFlush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // 🛡️ B4-L4-R1（L4-01 / I-9）：标记当前所有 pending key 的「防抖已到期」。
      //    若本次 flush 因 in-flight 去重被跳过，commit 的 finally 会据此补传。
      for (const k of pendingMapRef.current.keys()) {
        debounceElapsedKeysRef.current.add(k);
      }
      tryFlushPending();
    }, DEBOUNCE_MS);
  }, [tryFlushPending]);

  const syncToCloud = useCallback((newWater, newMeals, recordDateOverride = null) => {
    if (!user) return;
    // 载荷绑定入队时的 owner + recordDate，按 owner+date 隔离到独立槽位。
    // 不同账号 / 不同日期互不覆盖，各自保留、各自重试。
    // 🛡️ BUG-01（D-11）：透传 recordDateOverride，使云端记录日期与本地数据日期一致。
    enqueuePending(newWater, newMeals, recordDateOverride);
    scheduleFlush();
  }, [user, enqueuePending, scheduleFlush]);

  const fetchMyRecord = useCallback(async (date) => {
    if (!user) return null;
    try {
      const { data, error } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', user.id)
        .eq('record_date', date)
        .single();
      // PGRST116 代表没有数据（用户今天还没打卡），属于正常情况不抛错
      if (error && error.code !== 'PGRST116') throw error;
      return data || null;
    } catch (e) {
      console.warn('⚠️ 拉取本人 health_records 失败(离线状态)', e?.message || e);
      return null;
    }
  }, [user]);

  /** 
   * ⚡ 核心修复：拉取伴侣的今日记录 (Cache-First 离线秒开架构) 
   */
  const fetchPartnerRecord = useCallback(async (pId, date) => {
    if (!pId) return null;
    const cacheKey = `@partner_health_${pId}_${date}`;

    // 🛡️ T6/A06：进入时快照当前授权代际。
    //    任何 await 之后写回 state 前都必须比对；不一致说明授权已变更
    //    （解绑 / 换绑 / 权威空结果），本次结果必须整体丢弃，绝不写回缓存。
    const gen = authGenerationRef.current;
    // 🛡️ TASK-P0.3 / B3-02：同时快照会话代际（authEpoch）。
    //    仅比对 authGeneration 无法覆盖「同账号新会话」——若新会话尚未发生
    //    bind/clear（authGeneration 未变），旧会话的迟到请求仍会通过校验。
    const epoch = authEpochRef.current;
    const isStale = () => gen !== authGenerationRef.current || epoch !== authEpochRef.current;

    // 1. 离线缓存优先加载（第 0 帧秒开，断网绝不显示 0）
    try {
      const cachedStr = await AsyncStorage.getItem(cacheKey);
      if (cachedStr && !isStale()) {
        // 合法写入：归属身份推进到当前会话，否则新会话数据会被渲染期遮蔽。
        claimStateOwner();
        setPartnerData(JSON.parse(cachedStr));
      }
    } catch (_) {}

    // 2. 网络请求非阻塞与错误降级
    try {
      const { data, error } = await supabase
        .from('health_records')
        .select('*')
        .eq('user_id', pId)
        .eq('record_date', date)
        .single();

      if (error && error.code !== 'PGRST116') throw error;

      // 🛡️ 网络往返期间授权可能已被撤销 / 会话已切换 → 丢弃过期结果
      if (isStale()) return null;

      if (data) {
        const newData = {
          waterAmount: data.water_amount || 0,
          mealsStatus: data.meals_status || EMPTY_MEALS,
        };
        // 合法写入：归属身份推进到当前会话。
        claimStateOwner();
        // 更新内存并回写本地磁盘镜像
        setPartnerData(newData);
        AsyncStorage.setItem(cacheKey, JSON.stringify(newData)).catch(() => {});
        return data;
      }
    } catch (e) {
      // 🚨 断网降级保护：绝对禁止重置为 0，保持本地缓存数据！
      console.warn('离线状态，使用本地缓存的搭子健康数据', e?.message || e);
    }
    return null;
  }, [claimStateOwner]);

  const applyPartnerRecord = useCallback((record) => {
    if (!record) return;
    // 合法写入：归属身份推进到当前会话。
    claimStateOwner();
    setPartnerData({
      waterAmount: record.water_amount || 0,
      mealsStatus: record.meals_status || EMPTY_MEALS,
    });
  }, [claimStateOwner]);

  /**
   * 🧹 T6/A06：权威清空搭子状态。
   *
   * 与旧实现的区别：
   *   1. 先自增授权代际 → 所有在途 fetchPartnerRecord / 实时回调立即失效
   *   2. 清空 partnerId 与 partnerData（不再「null 不覆盖」而保留陈旧搭子）
   *   3. 删除该搭子的本地健康缓存镜像，避免下次冷启动把已撤销搭子的数据读回来
   *
   * @param {string|null} stalePartnerId 已知被撤销的搭子 id（用于清理缓存键）
   */
  const clearPartner = useCallback((stalePartnerId = null) => {
    bumpAuthGeneration();
    // 归属身份推进到当前身份：清空后的空值属于当前会话，必须可被呈现。
    claimStateOwner();
    setPartnerId(null);
    setPartnerData({ waterAmount: 0, mealsStatus: EMPTY_MEALS });

    if (stalePartnerId) {
      // 清理该搭子所有日期的本地缓存镜像（键格式：@partner_health_<id>_<date>）
      const prefix = `@partner_health_${stalePartnerId}_`;
      AsyncStorage.getAllKeys()
        .then((keys) => {
          const stale = keys.filter((k) => k.startsWith(prefix));
          if (stale.length > 0) return AsyncStorage.multiRemove(stale);
          return null;
        })
        .catch(() => {});
    }
  }, [bumpAuthGeneration, claimStateOwner]);

  /**
   * 🔗 T6/A06：确认/切换搭子关系时调用，使旧代际的在途请求全部失效。
   *    绑定新搭子或权威复验确认关系仍有效时使用。
   */
  const bindPartner = useCallback((nextPartnerId) => {
    bumpAuthGeneration();
    // 归属身份推进到当前身份：新绑定的搭子属于当前会话，必须可被呈现。
    claimStateOwner();
    setPartnerId(nextPartnerId ?? null);
  }, [bumpAuthGeneration, claimStateOwner]);

  /**
   * 🔔 T6.1/FIX-05：订阅「授权关系变更」，用于实时感知对方解绑。
   *
   * 为什么需要单独订阅：
   *   迁移 16 的 Realtime 白名单原本不含 partner_authorizations，
   *   对方解绑时本端收不到任何事件，只能等切前台复验或冷启动。
   *   迁移 27 已把该表加入白名单，且 RLS 限定订阅者只能收到
   *   「自己参与的行」，因此这里可以安全订阅。
   *
   * ⚠️ FIX-05 关键约束：**绝不依赖 `payload.old.status`**。
   *   Supabase Realtime 的 postgres_changes UPDATE 事件，只有在表设置了
   *   `REPLICA IDENTITY FULL` 时才会在 `payload.old` 里带上旧列值；否则
   *   `payload.old` 只包含主键（id）。本表（迁移 20）并未设置 FULL，
   *   因此旧实现里 `prev.status === 'accepted'` 恒为 false，撤销事件被
   *   静默丢弃 —— 这正是 FIX-05 要修复的缺陷。
   *
   *   正确做法：收到任何「与本端当前搭子相关」的 UPDATE 事件后，
   *   **重新向服务端权威复验**（get_active_partner_id RPC），以服务端
   *   返回的有效搭子为准：
   *     · 服务端仍返回同一 pId → 授权仍有效，忽略该事件；
   *     · 服务端返回 null 或不同的 id → 授权已撤销/变更，调用 onRevoked()。
   *   这样既不依赖 payload.old，也不依赖 payload.new 的字段完整性，
   *   一切以服务端权威状态为准。
   *
   * 账号切换隔离：
   *   · 订阅建立时快照授权代际 gen；回调触发时若代际已变（本端主动解绑/
   *     换绑/账号切换），直接丢弃，避免旧账号的异步结果写回。
   *   · 复验 RPC 是异步的，await 之后再次比对代际，防止复验期间发生切换。
   *
   * @param {string|null} pId 当前搭子 id（用于过滤，避免无关授权事件触发清空）
   * @param {Function} onRevoked 撤销回调
   */
  const subscribeAuthorization = useCallback((pId, onRevoked) => {
    if (!pId) return () => {};

    const channelName = `partner_auth_${pId}_${Date.now()}`;
    const gen = authGenerationRef.current;
    // 🛡️ TASK-P0.3 / B3-03：会话代际快照。同账号新会话（epoch 变化）时，
    //    旧订阅的复验结果必须整体作废，绝不能触发 onRevoked 清空新会话状态。
    const epoch = authEpochRef.current;
    const isStale = () => gen !== authGenerationRef.current || epoch !== authEpochRef.current;

    // 🔒 T6.2 收尾：复验协调器（verifying / pending 状态机）。
    //   复验期间若又收到新事件，不能直接丢弃 —— 因为当前这次复验的 RPC 可能
    //   早于「新事件所代表的状态变更」发出，其返回结果无法反映最新状态。
    //   协调器会标记 pending，待当前复验结束后**再复验一次**，确保最终以
    //   最新服务端状态为准（否则可能漏掉撤销）。
    //   状态机抽到 authRevokeLogic.createRevokeVerifier，生产与测试共用同一实现。
    const verifier = createRevokeVerifier({
      // 代际已变更（本端已主动解绑/换绑/账号切换/同账号新会话）→ 丢弃结果且不再复验
      isStale,
      // 🔒 以服务端权威状态为准，不信任 payload.old / payload.new
      verify: () => supabase.rpc('get_active_partner_id'),
      onResult: (rpcResult) => {
        // 网络异常 → 保持现状，绝不清空（避免抖动误删搭子）
        if (rpcResult?.error) {
          console.warn('⚠️ 授权复验失败，保持现状:', rpcResult.error?.message ?? rpcResult.error);
          return;
        }
        // 纯函数决策：服务端仍确认当前搭子有效 → 忽略；否则触发撤销
        if (shouldRevokeOnAuthChange(rpcResult, pId)) {
          console.log('🔔 授权复验确认搭子已失效，触发撤销:', rpcResult?.data ?? null);
          onRevoked?.();
        }
      },
    });

    const verifyAndMaybeRevoke = () => {
      // 协调器内部已捕获 verify 异常语义（onResult 不抛），此处仅触发
      verifier.trigger().catch((e) => {
        console.warn('⚠️ 授权复验异常，保持现状:', e?.message ?? e);
      });
    };

    try {
      supabase
        .getChannels()
        .filter((ch) => ch.topic === `realtime:${channelName}`)
        .forEach((ch) => supabase.removeChannel(ch));

      const channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'partner_authorizations' },
          (payload) => {
            // 授权代际 / 会话代际已变更（本端已主动解绑/换绑/切号/同账号新会话）
            // → 无需重复处理
            if (isStale()) return;

            // 只处理与本端当前搭子相关的关系（纯函数，绝不读 payload.old.status）。
            // 无法排除相关性时交给服务端复验兜底（宁可多查一次）。
            if (!isAuthEventRelevant(payload, pId)) return;

            // 不依赖 payload.old.status：直接向服务端复验权威状态
            verifyAndMaybeRevoke();
          }
        )
        .subscribe();

      return () => supabase.removeChannel(channel);
    } catch (e) {
      console.warn('搭子授权订阅离线失败，静默降级', e?.message || e);
      return () => {};
    }
  }, []);

  /** ⚡ 核心修复：订阅伴侣变更（支持离线防崩与缓存回写） */
  const subscribePartner = useCallback((pId, date) => {
    if (!pId) return () => {};

    const channelName = `partner_health_${pId}_${Date.now()}`;
    const cacheKey = `@partner_health_${pId}_${date}`;
    // 🛡️ TASK-P0.3 / B3-04：会话代际快照。同账号新会话（epoch 变化）时，
    //    旧订阅的迟到事件必须丢弃，绝不能把上一会话的搭子健康数据写进新会话。
    const epoch = authEpochRef.current;
    // 🛡️ TASK-P0.3 / B3-L4-R1（缺陷 4）：**授权代际快照**。
    //
    //    T7-H22 曾移除代际判断，因为「重绑同一搭子」时 partnerId 值不变、
    //    旧订阅已被 cleanup 移除、而 effect 不重建 → 订阅永久失效。
    //    但完全移除代际判断会留下另一个缺口：重绑同一搭子（partnerId 与
    //    authEpoch 都不变，只有 authGeneration 自增）时，旧 channel 上残留的
    //    回调仍能通过 partnerId + epoch 双重校验，把旧授权周期的数据写回。
    //
    //    正确做法：**恢复代际闸门，同时保证订阅会重建**。
    //      · 本函数快照 gen，回调内比对 gen —— 授权代际一变，旧回调立即失效；
    //      · useHealthData 的订阅 effect 依赖已包含 authGeneration（T7-H22 已加），
    //        因此 bindPartner 自增代际后 effect 必然重建订阅，不会出现
    //        「无订阅存活」的回归。
    //    两者缺一不可：只加闸门不重建 → 永久失效；只重建不加闸门 → 旧回调可写回。
    const gen = authGenerationRef.current;

    try {
      supabase
        .getChannels()
        .filter((ch) => ch.topic === `realtime:${channelName}`)
        .forEach((ch) => supabase.removeChannel(ch));

      const channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'health_records', filter: `user_id=eq.${pId}` },
          (payload) => {
            // 当前搭子已变更（解绑 / 换人）→ 忽略过期实时事件
            if (partnerIdRef.current !== pId) return;
            // 🛡️ TASK-P0.3 / B3-04：会话代际已变更（同账号新会话）→ 丢弃旧订阅事件
            if (epoch !== authEpochRef.current) return;
            // 🛡️ TASK-P0.3 / B3-L4-R1：授权代际已变更（重绑同一搭子 / 解绑）
            //    → 旧授权周期的回调必须立即失效，即使 partnerId 与 epoch 都相同。
            if (gen !== authGenerationRef.current) return;
            if (payload.new && payload.new.record_date === date) {
              const newData = {
                waterAmount: payload.new.water_amount || 0,
                mealsStatus: payload.new.meals_status || EMPTY_MEALS,
              };
              // 合法写入：归属身份推进到当前会话（经 ref，保持依赖数组形状）。
              claimStateOwnerRef.current?.();
              // 实时更新内存并同步存入本地磁盘
              setPartnerData(newData);
              AsyncStorage.setItem(cacheKey, JSON.stringify(newData)).catch(() => {});
            }
          }
        )
        .subscribe();

      return () => supabase.removeChannel(channel);
    } catch (e) {
      console.warn('搭子健康订阅离线失败，静默降级', e?.message || e);
      return () => {};
    }
  }, []);

  // 🔑 T6.1/FIX-05：账号切换时必须重置授权代际与搭子状态。
  //
  // 问题：authGenerationRef 只在「绑定/解绑/权威空结果」时自增，
  //   账号切换（user.id 变化）不会触发。若 A 账号有搭子、切到 B 账号，
  //   partnerId / partnerData 仍是 A 的残留值，B 会短暂看到 A 的搭子卡片
  //   与健康数据，且旧代际的在途请求仍可能写回。
  //
  // 🛡️ TASK-P0.3 / B3-01：判定条件从「仅 userId 变化」扩展为
  //   「userId 变化 **或** authEpoch 变化」。原因：
  //     · A → 登出 → A 重新登录：userId 相同，但这是全新会话，
  //       上一会话的搭子状态与在途请求必须全部作废；
  //     · 同账号新 authEpoch（token 轮换 / 重新登录）同理。
  //   旧实现只比较 userId，导致上述场景下 partnerId / partnerData 残留，
  //   且旧会话在途请求的代际校验依然通过。
  //
  // 处理：身份转移时自增代际（作废所有在途请求）+ 清空 partnerId /
  //   partnerData。注意这里**不**清理磁盘缓存（那是 clearPartner 的职责，
  //   需要具体 stalePartnerId），账号切换由 useHealthData 的 profile 加载负责。
  const lastUserIdRef = useRef(user?.id ?? null);
  const lastEpochRef = useRef(authEpoch);
  useEffect(() => {
    const nextUserId = user?.id ?? null;
    const nextEpoch = authEpoch;
    const userChanged = lastUserIdRef.current !== nextUserId;
    const epochChanged = lastEpochRef.current !== nextEpoch;
    if (!userChanged && !epochChanged) return;
    lastUserIdRef.current = nextUserId;
    lastEpochRef.current = nextEpoch;

    // 🛡️ T6-B/X-08（复审返工 CR-01）+ 第二轮复审 14-01：账号切换时取消旧账号的防抖定时器，
    //    但**绝不丢弃** pendingMapRef 中的未同步载荷。
    //
    //    修复：只取消定时器，pendingMapRef 原样保留（按 owner+date 隔离的多槽）。
    //    tryFlushPending 只提交「属于当前登录用户」的槽位；其他账号的槽位保留，
    //    待用户切回原账号后，flushNow / 下一次 syncToCloud 会重试提交。
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 尝试提交当前账号的槽位（其他账号的槽位保留待切回后重试）。
    tryFlushPending();

    // 作废所有在途请求与实时回调
    bumpAuthGeneration();
    // 归属身份推进到新身份：清空后的空值属于新会话，必须可被呈现。
    // 经 ref 调用，保持本 effect 依赖数组形状不变（源码契约锁定）。
    claimStateOwnerRef.current?.();
    setPartnerId(null);
    setPartnerData({ waterAmount: 0, mealsStatus: EMPTY_MEALS });
  }, [user?.id, authEpoch, bumpAuthGeneration, tryFlushPending]);

  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 卸载时尽力提交；失败则保留在内存 pendingMapRef（进程结束即丢失，
    // 但这是卸载语义，非账号切换静默丢弃）。不在此处强制清空。
    tryFlushPending();
  }, [tryFlushPending]);

  // 🛡️ TASK-P0.3 / B4（R-02 / 补充一）：**登录 / 冷启动 / 身份切换后恢复 pending**。
  //
  //    时机：user.id 或 authEpoch 变化（含冷启动首次挂载、A→B、A→登出→A 重登）。
  //    动作：从磁盘读取「属于当前用户」的 pending，合并进内存 Map（rev 大者胜），
  //          随后尝试 flush 一次把恢复的载荷补传云端。
  //    隔离：只恢复当前 owner 的条目；其他账号的磁盘数据原样保留，互不污染。
  //    这是「防抖窗口内进程被杀」后数据能恢复的关键路径。
  useEffect(() => {
    const ownerId = user?.id ?? null;
    if (!ownerId) return;
    let cancelled = false;
    (async () => {
      await hydratePendingFromDisk(ownerId);
      if (cancelled) return;
      // 恢复后立即尝试补传（网络可用时）。
      await tryFlushPending();
    })();
    return () => { cancelled = true; };
  }, [user?.id, authEpoch, hydratePendingFromDisk, tryFlushPending]);

  // 🛡️ TASK-P0.3 / B3-L4-R1（缺陷 5）：**渲染期身份遮蔽**（对外呈现层）。
  //
  //    归属身份 stateOwnerKey 在文件上部定义；这里只做纯派生：
  //    归属身份 === 当前身份 → 正常呈现；否则一律呈现空值。
  //    派生逻辑放在 useMemo 内，避免条件表达式导致依赖每次渲染变化。
  const currentOwnerKey = `${user?.id ?? ''}::${authEpoch}`;

  return useMemo(() => {
    const ownerIsCurrent = stateOwnerKey === currentOwnerKey;
    return {
      partnerData: ownerIsCurrent ? partnerData : { waterAmount: 0, mealsStatus: EMPTY_MEALS },
      partnerId: ownerIsCurrent ? partnerId : null,
      // 🔧 T7-H22：对外暴露授权代际 state，供 useHealthData 的订阅 effect 纳入依赖，
      //    使「重绑同一搭子」（partnerId 值不变、代际已变）也能重建实时订阅。
      authGeneration,
      setPartnerId,
      bindPartner,
      clearPartner,
      fetchMyRecord,
      fetchPartnerRecord,
      applyPartnerRecord,
      subscribePartner,
      subscribeAuthorization,
      syncToCloud,
      // 🛡️ TASK-P0.3 / B4-L4-R1（L4-03 / I-10）：供 useHealthData 在外层 500ms
      //    防抖排队时立即入队落盘（enqueuePending），到点再 scheduleFlush。
      enqueuePending,
      scheduleFlush,
      flushNow,
      // 🛡️ TASK-P0.3 / B4（R-07）：供 useHealthData 云端 hydrate 闸门查询本地未同步 pending。
      hasPendingFor,
    };
  }, [
    partnerData, partnerId, stateOwnerKey, currentOwnerKey, authGeneration, bindPartner, clearPartner,
    fetchMyRecord, fetchPartnerRecord, applyPartnerRecord, subscribePartner, subscribeAuthorization,
    syncToCloud, enqueuePending, scheduleFlush, flushNow, hasPendingFor,
  ]);
}
// --- END OF FILE src/hooks/health/useHealthCloud.js ---