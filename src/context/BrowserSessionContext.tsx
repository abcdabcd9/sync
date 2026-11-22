// --- START OF FILE src/context/BrowserSessionContext.tsx ---
import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSafeUrl } from '../constants/browser';
import { useAuth } from '../hooks/useAuth';

/**
 * 🌐 浏览器会话上下文（跨页 URL 交接 + 上次网址持久化）
 *
 * 解决的问题：
 *   1. 历史 / 书签页点击网址时，不再 router.replace 新建第二个浏览器实例，
 *      而是把目标 URL 写入 pendingUrl，然后 router.back() 回到已有浏览器实例。
 *   2. 浏览器每次打开时恢复上次最后访问的网址（而非固定首页）。
 *
 * 设计约束：
 *   - 纯数据层，不触碰任何 UI / 动画 / WebView / 安全注入脚本
 *   - 存储 Key 独立为 @browser_last_url，不影响 @browser_history / @browser_bookmarks
 *   - pendingUrl 用 ref 承载「一次性交接」，同时用 state 触发消费方 effect
 */

// 🔒 存储 Key（独立命名空间，禁止与历史 / 书签混用）
//    旧全局 key '@browser_last_url' 保留在磁盘上（不删除、不迁移），
//    但**不再被读取或写入**。
//    🛡️ T6-B/X-09a（复审返工 CR-04）：无 owner 时绝不回退到旧全局 key。
//    旧实现 buildLastUrlKey(null) 返回 '@browser_last_url'，导致未登录时
//    hydrate 读到上一个账号残留的网址（跨账号泄漏）。修复：无 owner 时
//    buildLastUrlKey 返回 null，读写一律跳过；旧 key 原样保留在磁盘上，
//    但既不可见也不可被认领（invisible / unclaimable）。
const buildLastUrlKey = (userId: string | null): string | null =>
  userId ? `@browser_last_url_v2_${userId}` : null;

/**
 * useAuth() 返回值的**最小结构视图**。
 * useAuth 目前是未类型化的 JS 模块，本模块只读取 `user.id` 与 `authEpoch`。
 * 这里仅做静态断言，不改变任何运行时行为（仍为 `auth?.user?.id` / `auth?.authEpoch`）。
 */
interface AuthLike {
  user?: { id?: string | null } | null;
  authEpoch?: number | null;
}

/** 浏览器会话上下文值（键顺序与迁移前一致） */
export interface BrowserSessionContextValue {
  pendingUrl: string | null;
  pendingSeq: number;
  setPendingUrl: (url: string) => void;
  consumePendingUrl: () => null;
  lastUrl: string | null;
  rememberUrl: (url: string) => void;
}

/** Provider 入参 */
export interface BrowserSessionProviderProps {
  children?: ReactNode;
  userId?: string | null;
  authEpoch?: number | null;
}

const BrowserSessionContext = createContext<BrowserSessionContextValue | null>(null);

export function BrowserSessionProvider({
  children,
  userId: userIdProp = null,
  authEpoch: authEpochProp = null,
}: BrowserSessionProviderProps) {
  // 🛡️ T6-B/X-09a：owner 来源优先级 —— 显式传入的 userId > 从 AuthProvider 读取。
  //    这样 _layout.js 的 Provider 树保持原样（不新增包装层），
  //    同时保证 lastUrl 按账号隔离。Provider 必须位于 AuthProvider 之内。
  const auth = useAuth() as AuthLike | null | undefined;
  const userId: string | null = userIdProp ?? auth?.user?.id ?? null;
  // 🛡️ T6-B 第二轮复审 14-03：会话代际。仅比较 userId 无法拦截 A→B→A：
  //    旧 A 回调与当前 A 的 userId 相同、V2 key 也相同，旧事件会被误判为
  //    「同一身份」而写进新 A 会话。回调创建时快照 authEpoch，执行时比对。
  //    来源优先级与 userId 一致：显式传入的 authEpoch > 从 AuthProvider 读取。
  const authEpoch: number = authEpochProp ?? auth?.authEpoch ?? 0;

  // 📌 待加载 URL（历史 / 书签页写入，浏览器页消费后清空）
  const [pendingUrl, setPendingUrlState] = useState<string | null>(null);
  // 🕘 上次访问网址（持久化到 AsyncStorage）
  const [lastUrl, setLastUrlState] = useState<string | null>(null);
  // 🔁 交接序号：同一 URL 连续点击也能触发消费方 effect
  const [pendingSeq, setPendingSeq] = useState(0);
  // 🧊 首次读取完成标记，避免恢复逻辑与读取竞态
  const hydratedRef = useRef(false);
  // 🛡️ T6-B/X-09a：记录当前 lastUrl 所属账号，供 rememberUrl 写对 key。
  const lastUrlOwnerRef = useRef<string | null>(userId);
  // 🛡️ 14-03：会话代际 ref 镜像，供迟到回调同步比对（覆盖 A→B→A）。
  const authEpochRef = useRef<number>(authEpoch);
  useEffect(() => {
    authEpochRef.current = authEpoch;
  }, [authEpoch]);
  // 🛡️ T6-B/X-09a：记录「内存态是为哪个账号加载的」。
  //    账号切换时在渲染期同步清空，避免 B 短暂看到 A 的网址（不写 ref、不触发级联渲染）。
  const [stateOwner, setStateOwner] = useState<string | null>(userId);
  // 🛡️ T6-B 第三轮复审 15-02：记录「内存态属于哪个会话代际」。
  //    同账号重新登录（userId 不变、authEpoch 推进）时 Provider 不卸载，
  //    旧会话写入的 pendingUrl 会残留在 state 中，被新会话消费（跨会话交接泄漏）。
  //    因此除 owner 外还需按 epoch 清空 pendingUrl。
  const [stateEpoch, setStateEpoch] = useState<number>(authEpoch);

  // 🛡️ X-09a：账号切换 → 渲染期状态调整（React 官方推荐模式）。
  //    在本次渲染提交前把 lastUrl / pendingUrl 归零，并同步 owner 标记，
  //    避免「旧账号网址泄漏给新账号」的中间帧。
  if (stateOwner !== userId) {
    setStateOwner(userId);
    setLastUrlState(null);
    setPendingUrlState(null);
  }

  // 🛡️ 15-02：同账号新会话（epoch 变化）→ 只清空 pendingUrl（一次性交接），
  //    **不清 lastUrl**——lastUrl 是同账号的持久化偏好，新会话仍应恢复它。
  if (stateEpoch !== authEpoch) {
    setStateEpoch(authEpoch);
    setPendingUrlState(null);
  }

  // 🕘 启动 / 账号切换时读取上次网址（容错：脏数据 / 非安全地址直接丢弃）
  //    🛡️ X-09a（CR-04）：按 userId 隔离读取，只读新账号自己的 key。
  //    无 owner（未登录）→ buildLastUrlKey 返回 null → 不读任何 key，
  //    绝不回退到旧全局 @browser_last_url（避免读到上一账号残留网址）。
  useEffect(() => {
    let alive = true;
    lastUrlOwnerRef.current = userId;
    const key = buildLastUrlKey(userId);
    const hydrate = async () => {
      if (!key) {
        // 无 owner：不读磁盘，内存态保持 null（渲染期已清空）。
        hydratedRef.current = true;
        return;
      }
      try {
        const cached = await AsyncStorage.getItem(key);
        // 🛡️ 读取期间账号已切换 → 丢弃
        if (alive && lastUrlOwnerRef.current === userId && cached && isSafeUrl(cached)) {
          setLastUrlState(cached);
        }
      } catch {}
      hydratedRef.current = true;
    };
    hydrate();
    return () => {
      alive = false;
    };
  }, [userId]);

  // 📌 写入待加载 URL（供历史 / 书签页调用）
  //    🛡️ CR-04：绑定「事件发起时的 owner」。迟到回调（A 的事件在切到 B 后才执行）
  //    不得把 A 的 URL 交接给 B 的浏览器实例。
  const setPendingUrl = useCallback(
    (url: string) => {
      if (!isSafeUrl(url)) return;
      // 事件源 owner + 会话代际必须仍是当前值，否则丢弃（防止跨账号 / ABA 交接）。
      if (lastUrlOwnerRef.current !== userId || authEpochRef.current !== authEpoch) return;
      setPendingUrlState(url);
      setPendingSeq((n) => n + 1);
    },
    [userId, authEpoch]
  );

  // 📌 消费待加载 URL（浏览器页读取后调用，避免重复触发）
  const consumePendingUrl = useCallback((): null => {
    setPendingUrlState(null);
    return null;
  }, []);

  // 🕘 记录上次访问网址（浏览器页导航状态变化时调用）
  //    🛡️ X-09a（CR-04）：写入「当前账号」的隔离 key，而非全局 key。
  //    旧实现在 setState updater 内读取可变的 lastUrlOwnerRef.current，
  //    迟到事件（A 的导航在 B 登录后才回调）会把 A 的 URL 写进 B 的 key。
  //    修复：在回调创建时闭包绑定 owner（依赖 userId），执行时与
  //    lastUrlOwnerRef.current 比对；不一致则整条丢弃（不写盘、不改内存态）。
  //    同时把 AsyncStorage 写入移出 setState updater（updater 必须纯）。
  const rememberUrl = useCallback(
    (url: string) => {
      if (!isSafeUrl(url)) return;
      const ownerAtCreate = userId;
      const epochAtCreate = authEpoch;
      const key = buildLastUrlKey(ownerAtCreate);
      if (!key) return; // 无 owner：不写任何存储
      // 🛡️ 迟到回调：owner 或会话代际已变化则整条丢弃（覆盖 A→B→A）
      if (lastUrlOwnerRef.current !== ownerAtCreate || authEpochRef.current !== epochAtCreate)
        return;
      if (lastUrl === url) return;
      setLastUrlState(url);
      AsyncStorage.setItem(key, url).catch(() => {});
    },
    [userId, authEpoch, lastUrl]
  );

  const value: BrowserSessionContextValue = {
    pendingUrl,
    pendingSeq,
    setPendingUrl,
    consumePendingUrl,
    lastUrl,
    rememberUrl,
  };

  return (
    <BrowserSessionContext.Provider value={value}>{children}</BrowserSessionContext.Provider>
  );
}

export function useBrowserSession(): BrowserSessionContextValue {
  const ctx = useContext(BrowserSessionContext);
  if (!ctx) {
    throw new Error('useBrowserSession 必须在 BrowserSessionProvider 内使用');
  }
  return ctx;
}

export default BrowserSessionContext;
// --- END OF FILE src/context/BrowserSessionContext.tsx ---
