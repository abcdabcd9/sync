// --- START OF FILE src/hooks/useAccountSwitcher.js ---
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 🔀 本地多账号档案（Account Switcher）
 *
 * 设计前提（重要）：
 *   Supabase 的会话由 supabase-js 存在 AsyncStorage 的固定 key 下，
 *   同一时刻只能有一个活跃 session。因此这里**不保存多个 session**，
 *   只保存「账号档案」（id / 昵称 / sync_id / 邮箱 / 头像色），用于：
 *     1. 在 /settings/accounts 页列出本机登录过的账号
 *     2. 切换时 signOut 当前账号 → 跳 /auth 并预填目标账号邮箱
 *
 * 安全约束：
 *   - 绝不存储密码、access_token、refresh_token
 *   - 只存展示所需的公开字段
 *   - 邮箱属于个人信息，仅存本机 AsyncStorage，不上传云端
 *
 * 存储结构（@app_known_accounts）：
 *   [{ id, email, nickname, syncId, avatarColor, lastUsedAt }]
 *   按 lastUsedAt 倒序，最多保留 MAX_ACCOUNTS 条。
 */

const STORAGE_KEY = '@app_known_accounts';
const MAX_ACCOUNTS = 5;

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
    .map((item) => ({
      id: item.id,
      email: typeof item.email === 'string' ? item.email : '',
      nickname: typeof item.nickname === 'string' ? item.nickname : '',
      syncId: typeof item.syncId === 'string' ? item.syncId : '',
      avatarColor: typeof item.avatarColor === 'string' ? item.avatarColor : pickAvatarColor(item.id),
      lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : 0,
    }))
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
   * @param {{ id: string, email?: string, nickname?: string, syncId?: string }} profile
   */
  const rememberAccount = useCallback(async (profile) => {
    if (!profile?.id) return;
    const list = await readAll();
    const existing = list.find((item) => item.id === profile.id);
    const merged = {
      id: profile.id,
      email: profile.email ?? existing?.email ?? '',
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

export { AVATAR_COLORS, pickAvatarColor, MAX_ACCOUNTS };
// --- END OF FILE src/hooks/useAccountSwitcher.js ---
