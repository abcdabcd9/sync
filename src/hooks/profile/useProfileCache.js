// --- START OF FILE src/hooks/profile/useProfileCache.js ---
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../services/supabase';

/**
 * 个人资料 Cache-First 持久化 Hook（profiles 表）。
 *
 * ⚠️ 最高指令：断网 / 超时 / 任何云端异常，都绝不允许把 profile 重置为 null。
 *    本地缓存（AsyncStorage）是唯一可信的兜底数据源，云端只是「尽力而为」的刷新。
 *
 * 行为契约：
 *   1. 第 0 帧：立即读 @user_profile_cache → 命中则立刻 setProfile + loading=false（秒开）
 *   2. 云端：带超时保护地查询 profiles → 成功则回写缓存；失败仅 console.warn 并保持缓存
 *   3. 缓存按 user.id 隔离，切换账号不会串号
 */

export const PROFILE_CACHE_KEY = '@user_profile_cache';

// 云端 profiles 查询超时（毫秒）：超时即视为离线，直接降级到本地缓存
const CLOUD_TIMEOUT_MS = 30000;

/** 统一整理 profile 字段：sync_id / nickname 缺失时回落到 username */
export function normalizeProfile(row) {
  if (!row) return null;
  return {
    ...row,
    sync_id: row.sync_id || row.username || null,
    nickname: row.nickname || row.username || null,
    // 💞 守护伴侣昵称：随个人资料一起持久化，断网时无需再查云端即可展示搭子名称
    bound_partner_nickname: row.bound_partner_nickname || null,
  };
}

/** 读取本地缓存的个人资料（只读磁盘，零网络） */
export async function readProfileCache(userId) {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // 缓存归属校验：只认当前登录用户自己的资料，避免换号后串数据
    if (userId && parsed.id && parsed.id !== userId) return null;
    return normalizeProfile(parsed);
  } catch (e) {
    console.warn('⚠️ 读取个人资料缓存失败:', e?.message ?? e);
    return null;
  }
}

/** 写入本地缓存的个人资料（失败不影响主流程） */
export async function writeProfileCache(profile) {
  if (!profile || !profile.id) return;
  try {
    await AsyncStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
  } catch (e) {
    console.warn('⚠️ 写入个人资料缓存失败:', e?.message ?? e);
  }
}

/** 清除本地缓存的个人资料（仅退出登录时调用） */
export async function clearProfileCache() {
  try {
    await AsyncStorage.removeItem(PROFILE_CACHE_KEY);
  } catch (e) {
    console.warn('⚠️ 清除个人资料缓存失败:', e?.message ?? e);
  }
}

/**
 * 带超时保护的云端 profiles 查询。
 * 超时不会抛错到调用方，而是返回 { data: null, error }，由调用方决定降级策略。
 */
export async function fetchProfileFromCloud(userId, columns = 'id, username, sync_id, nickname') {
  if (!userId) return { data: null, error: new Error('no-user') };

  let timer = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('profile-fetch-timeout')), CLOUD_TIMEOUT_MS);
    });

    const queryPromise = supabase
      .from('profiles')
      .select(columns)
      .eq('id', userId)
      .single();

    const { data, error } = await Promise.race([queryPromise, timeoutPromise]);
    if (error) return { data: null, error };
    return { data: normalizeProfile(data), error: null };
  } catch (e) {
    return { data: null, error: e };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {object|null} user 当前登录用户
 * @param {string} columns 需要从云端拉取的列
 */
export function useProfileCache(user, columns = 'id, username, sync_id, nickname') {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const userId = user?.id ?? null;

  // 防止组件卸载后 setState
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 用 ref 持有最新参数，保证 refresh 的引用稳定（避免 useFocusEffect 反复触发）
  const paramsRef = useRef({ userId, columns });
  useEffect(() => {
    paramsRef.current = { userId, columns };
  }, [userId, columns]);

  const refresh = useCallback(async () => {
    const { userId: uid, columns: cols } = paramsRef.current;

    if (!uid) {
      // 未登录：没有可用的个人资料，但也不应无限转圈
      if (mountedRef.current) {
        setProfile(null);
        setLoading(false);
      }
      return;
    }

    // 1️⃣ 第 0 帧：本地缓存优先，命中即秒开（loading 立刻置 false）
    const cached = await readProfileCache(uid);
    if (cached && mountedRef.current) {
      setProfile(cached);
      setLoading(false);
    }

    // 2️⃣ 云端刷新：任何异常都只降级，绝不清空 profile
    const { data, error } = await fetchProfileFromCloud(uid, cols);
    if (!mountedRef.current) return;

    if (data) {
      setProfile(data);
      writeProfileCache(data);
    } else {
      console.warn('离线状态，继续使用本地缓存的个人资料', error?.message ?? error);
    }

    // 无论云端成功与否，都必须结束 loading，避免个人主页卡死转圈
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, userId]);

  /** 本地乐观更新（如保存昵称/Sync ID 成功后），同时回写缓存 */
  const updateLocalProfile = useCallback((patch) => {
    setProfile(prev => {
      const next = normalizeProfile({ ...(prev || {}), ...patch });
      if (next?.id) writeProfileCache(next);
      return next;
    });
  }, []);

  return { profile, loading, refresh, updateLocalProfile };
}
// --- END OF FILE src/hooks/profile/useProfileCache.js ---
