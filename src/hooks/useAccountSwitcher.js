// --- START OF FILE src/hooks/useAccountSwitcher.js ---
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 🔀 本地多账号档案（Account Switcher）
 *
 * 设计前提（重要）：
 *   Supabase 的会话由 supabase-js 存在 AsyncStorage 的固定 key 下，
 *   同一时刻只能有一个活跃 session。因此这里**不保存多个 session**，
 *   只保存「账号档案」（id / 昵称 / sync_id / 邮箱指纹 / 头像色），用于：
 *     1. 在 /settings/accounts 页列出本机登录过的账号
 *     2. 切换时 signOut 当前账号 → 跳 /auth 并预填目标账号邮箱
 *
 * 安全约束：
 *   - 绝不存储密码、access_token、refresh_token
 *   - 只存展示所需的公开字段
 *   - 🔒 L-4：**不落盘明文邮箱**。邮箱属于个人身份信息（PII），
 *     一旦设备被 root / 越狱或 AsyncStorage 被备份导出，明文邮箱会直接泄露。
 *     现改为只存：
 *       · emailMasked —— 掩码展示串（如 `ab***@gmail.com`），仅供 UI 显示
 *       · emailHash   —— 邮箱的稳定指纹（djb2 哈希），用于去重与匹配
 *     切换账号时不再预填邮箱，用户需自行输入（安全优先）。
 *
 * 存储结构（@app_known_accounts）：
 *   [{ id, emailMasked, emailHash, nickname, syncId, avatarColor, lastUsedAt }]
 *   按 lastUsedAt 倒序，最多保留 MAX_ACCOUNTS 条。
 */

const STORAGE_KEY = '@app_known_accounts';
const MAX_ACCOUNTS = 5;

// 🔒 L-4：邮箱掩码。保留首 2 位与完整域名，中间以 *** 代替。
//    例：alice@gmail.com → al***@gmail.com
function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return '';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain) return '';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

// 🔒 L-4：邮箱稳定指纹（非加密哈希，仅用于本机去重/匹配，不可逆推原文）
//    选用 djb2：无依赖、同步、跨平台结果一致。
function hashEmail(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return '';
  let hash = 5381;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash = ((hash << 5) + hash + trimmed.charCodeAt(i)) % 2147483647;
  }
  return hash.toString(36);
}

// 头像底色池（与主色系协调，避免随机色破坏视觉一致性）
const AVATAR_COLORS = ['#FF2D55', '#0A84FF', '#34C759', '#FF9F0A', '#5E5CE6', '#32ADE6'];

function pickAvatarColor(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item.id === 'string' && item.id)
    .map((item) => {
      // 🔒 L-4：兼容旧版本档案（含明文 email）→ 读取时即时脱敏迁移
      //    旧数据 { email: 'alice@gmail.com' } 会被转换为
      //    { emailMasked: 'al***@gmail.com', emailHash: '<hash>' }，
      //    下一次 writeAll 落盘后明文 email 即从设备上消失。
      const legacyEmail = typeof item.email === 'string' ? item.email : '';
      const emailMasked =
        typeof item.emailMasked === 'string' && item.emailMasked
          ? item.emailMasked
          : maskEmail(legacyEmail);
      const emailHash =
        typeof item.emailHash === 'string' && item.emailHash
          ? item.emailHash
          : hashEmail(legacyEmail);
      return {
        id: item.id,
        emailMasked,
        emailHash,
        nickname: typeof item.nickname === 'string' ? item.nickname : '',
        syncId: typeof item.syncId === 'string' ? item.syncId : '',
        avatarColor: typeof item.avatarColor === 'string' ? item.avatarColor : pickAvatarColor(item.id),
        lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : 0,
      };
    })
    // 当账号数量超过 MAX_ACCOUNTS 时，根据 lastUsedAt 时间戳进行 LRU（最近最少使用）淘汰策略，优先移除最久未登录的账号存档。
    // 实现方式：先按 lastUsedAt 降序排序（最近使用的在前），再 slice 截断到 MAX_ACCOUNTS，
    // 被截断的尾部即「最久未登录」的账号，其本机档案会被丢弃（云端账号本身不受影响）。
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_ACCOUNTS);
}

async function readAll() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch (e) {
    console.warn('⚠️ 读取本地账号档案失败:', e?.message ?? e);
    return [];
  }
}

async function writeAll(list) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(list)));
  } catch (e) {
    console.warn('⚠️ 保存本地账号档案失败:', e?.message ?? e);
  }
}

export function useAccountSwitcher() {
  const [accounts, setAccounts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // 挂载后异步读取一次；不在 effect 内同步 setState
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await readAll();
      if (cancelled) return;
      setAccounts(list);
      setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * 记录 / 更新一个账号档案（登录成功后调用）
   *
   * 🔒 L-4：入参 email 仅用于「即时计算掩码与指纹」，**绝不原样落盘**。
   *    调用方（auth.js）从当前 session 动态取 email 传入即可。
   *
   * @param {{ id: string, email?: string, nickname?: string, syncId?: string }} profile
   */
  const rememberAccount = useCallback(async (profile) => {
    if (!profile?.id) return;
    const list = await readAll();
    const existing = list.find((item) => item.id === profile.id);
    // 本次传入的 email 优先；未传则沿用已有档案的脱敏结果
    const incomingEmail = typeof profile.email === 'string' ? profile.email : '';
    const merged = {
      id: profile.id,
      emailMasked: incomingEmail ? maskEmail(incomingEmail) : existing?.emailMasked ?? '',
      emailHash: incomingEmail ? hashEmail(incomingEmail) : existing?.emailHash ?? '',
      nickname: profile.nickname ?? existing?.nickname ?? '',
      syncId: profile.syncId ?? existing?.syncId ?? '',
      avatarColor: existing?.avatarColor ?? pickAvatarColor(profile.id),
      lastUsedAt: Date.now(),
    };
    const next = [merged, ...list.filter((item) => item.id !== profile.id)];
    const normalized = normalize(next);
    setAccounts(normalized);
    await writeAll(normalized);
  }, []);

  /**
   * 从本机档案中移除一个账号（不影响云端账号本身）
   * @param {string} id
   */
  const forgetAccount = useCallback(async (id) => {
    if (!id) return;
    const list = await readAll();
    const normalized = normalize(list.filter((item) => item.id !== id));
    setAccounts(normalized);
    await writeAll(normalized);
  }, []);

  /** 清空全部本机档案 */
  const clearAccounts = useCallback(async () => {
    setAccounts([]);
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('⚠️ 清空本地账号档案失败:', e?.message ?? e);
    }
  }, []);

  return { accounts, isLoading, rememberAccount, forgetAccount, clearAccounts };
}

export { AVATAR_COLORS, pickAvatarColor, MAX_ACCOUNTS, maskEmail, hashEmail };
// --- END OF FILE src/hooks/useAccountSwitcher.js ---
