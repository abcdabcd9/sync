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
 *   1. 第 0 帧：立即读当前账号的 V2 缓存 → 命中则立刻 setProfile + loading=false（秒开）
 *   2. 云端：带超时保护地查询 profiles → 成功则回写缓存；失败仅 console.warn 并保持缓存
 *   3. 缓存按 user.id 隔离，切换账号不会串号
 *
 * 🆔 TASK-P0.3 / B1-D：owner-scoped 缓存 key + 写入代际校验
 *   - key 改为 @user_profile_cache_v2_${userId}
 *   - 旧全局 key（@user_profile_cache）原样保留、绝不删除、绝不自动迁移
 *   - 写入前校验：profile.id === 目标 ownerId，且该 owner 仍是当前身份
 *   - 旧账号迟到的云端响应不得覆盖新账号缓存
 */

/** 旧全局 key（仅保留常量，不再用于读写） */
export const PROFILE_CACHE_KEY = '@user_profile_cache';
/** V2 用户作用域 key 前缀 */
export const PROFILE_CACHE_KEY_PREFIX = '@user_profile_cache_v2_';

/** 构造某用户的 profile 缓存 key；无有效 userId 返回 null */
export function buildProfileCacheKey(userId) {
  return userId && typeof userId === 'string' ? `${PROFILE_CACHE_KEY_PREFIX}${userId}` : null;
}

// 云端 profiles 查询超时（毫秒）：超时即视为离线，直接降级到本地缓存
const CLOUD_TIMEOUT_MS = 30000;

// 🆔 当前身份 owner（由 useProfileCache 在身份变化时同步更新）
//    用于 writeProfileCache 的代际校验：只有「仍是当前 owner」的写入才落盘。
let currentOwnerId = null;
// 🧭 身份代际计数：每次 owner 变化 +1，用于拦截旧异步链路的迟到写入
let ownerGeneration = 0;

/**
 * 由 Hook 在身份变化时调用，同步更新 owner 与代际。
 *
 * 🆔 X-05：`forceBump` 用于「同一 ownerId 但会话已更换」（A→登出→A 重新登录、
 *   或 token 重新签发）。此时 ownerId 不变，但旧会话的迟到写入必须失效，
 *   否则旧 token 下的 profile 结果会污染新会话。传 true 时强制自增代际。
 * @param {string|null} ownerId
 * @param {boolean} [forceBump=false]
 */
export function setProfileCacheOwner(ownerId, forceBump = false) {
  const next = ownerId ?? null;
  if (next !== currentOwnerId || forceBump) {
    currentOwnerId = next;
    ownerGeneration += 1;
  }
  return ownerGeneration;
}

/** 读取当前 owner 代际（供测试/调试） */
export function getProfileCacheGeneration() {
  return ownerGeneration;
}

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

/**
 * 读取本地缓存的个人资料（只读磁盘，零网络）。
 * 无有效 userId 时直接返回 null —— 绝不读取无主/旧全局缓存。
 */
export async function readProfileCache(userId) {
  const key = buildProfileCacheKey(userId);
  if (!key) return null;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // 缓存归属校验：只认当前登录用户自己的资料，避免换号后串数据
    if (parsed.id && parsed.id !== userId) return null;
    return normalizeProfile(parsed);
  } catch (e) {
    console.warn('⚠️ 读取个人资料缓存失败:', e?.message ?? e);
    return null;
  }
}

/**
 * 写入本地缓存的个人资料（失败不影响主流程）。
 *
 * 🛡️ 代际校验（B1-D）：
 *   1. profile.id 必须存在（作为 owner 标识）
 *   2. 若已登记 currentOwnerId，则 profile.id 必须与之相等
 *   3. 若调用方传入 expectedGeneration，则必须与当前代际一致
 *      （拦截「A 的旧请求在切到 B 之后才返回」的迟到写入）
 */
export async function writeProfileCache(profile, expectedGeneration = null) {
  if (!profile || !profile.id) return false;
  // 🛡️ X-01（fail-closed）：owner 未登记（null）时一律拒绝写入。
  //    旧实现 `if (currentOwnerId && ...)` 在 owner 为 null（登出 / 冷启动早期）
  //    时会放行任意 profile 落盘，导致迟到写入污染磁盘。必须 fail-closed。
  if (!currentOwnerId || profile.id !== currentOwnerId) return false;
  if (expectedGeneration !== null && expectedGeneration !== ownerGeneration) return false;
  const key = buildProfileCacheKey(profile.id);
  if (!key) return false;
  try {
    await AsyncStorage.setItem(key, JSON.stringify(profile));
    return true;
  } catch (e) {
    console.warn('⚠️ 写入个人资料缓存失败:', e?.message ?? e);
    return false;
  }
}

/**
 * 清除本地缓存的个人资料。
 * 无 userId 时不做任何事（绝不删除旧全局 key）。
 */
export async function clearProfileCache(userId) {
  const key = buildProfileCacheKey(userId);
  if (!key) return;
  try {
    await AsyncStorage.removeItem(key);
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

  // 🆔 身份代际：userId 变化时清空内存态，避免上一账号资料在新账号下短暂可见。
  //    采用 React 官方推荐的「渲染期调整 state」模式（而非 effect 内 setState），
  //    既能在读取新账号数据前完成重置，又避免级联渲染告警。
  //    ⚠️ 渲染期只允许 setState，不允许写 ref（react-hooks/refs）。
  //       owner 代际登记由 refresh() 在异步路径中完成（见 refresh 开头）。
  const generationRef = useRef(0);
  const [prevOwner, setPrevOwner] = useState(userId);
  if (prevOwner !== userId) {
    setPrevOwner(userId);
    setProfile(null);
    setLoading(!!userId);
  }

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

    // 🆔 X-01（复审返工 CR-02）：owner 的**唯一权威**是 AuthProvider。
    //    本 Hook 不再调用 setProfileCacheOwner（旧实现会在 refresh 时把 owner
    //    重新登记成 uid，导致「旧 Hook 在登出后重跑」绕过写入闸门）。
    //    这里只**读取** AuthProvider 已登记的当前代际作为本次刷新的起点；
    //    若 owner 尚未登记（currentOwnerId 为 null）则代际为 0，写入闸门
    //    writeProfileCache 会因 profile.id !== currentOwnerId 而 fail-closed。
    generationRef.current = getProfileCacheGeneration();
    // 📸 捕获本次刷新发起时的身份代际
    const startGeneration = generationRef.current;

    // 🛡️ T6-B 第二轮复审 14-05（MAJOR）：代际校验必须同时比对
    //    「本 Hook 实例的本地 ref」与「模块级全局代际」。
    //
    //    旧实现只比对 generationRef.current（本实例快照）。当 A 的旧请求在途、
    //    全局 owner 经历 A→B→A，但本 Hook 实例尚未发起新的 refresh 时，
    //    generationRef.current 仍是旧值 → 旧请求返回后误判为「代际未变」→
    //    执行 setProfile(data)，把旧会话资料显示到新会话 UI。
    //    （writeProfileCache 的写入闸门虽会拒绝落盘，但 React UI 已被污染。）
    //
    //    修复：每次校验都重新读取 getProfileCacheGeneration()（模块级权威），
    //    任一不一致即丢弃。同时保留 paramsRef 的 userId 校验。
    const isGenerationCurrent = () =>
      generationRef.current === startGeneration &&
      getProfileCacheGeneration() === startGeneration;

    // 1️⃣ 第 0 帧：本地缓存优先，命中即秒开（loading 立刻置 false）
    const cached = await readProfileCache(uid);
    if (!isGenerationCurrent()) return;
    if (cached && mountedRef.current) {
      setProfile(cached);
      setLoading(false);
    }

    // 2️⃣ 云端刷新：任何异常都只降级，绝不清空 profile
    const { data, error } = await fetchProfileFromCloud(uid, cols);
    if (!mountedRef.current) return;
    // 🛡️ 代际校验：身份已变化则丢弃本次结果，绝不回写新账号缓存
    if (!isGenerationCurrent()) return;
    if (paramsRef.current.userId !== uid) return;

    if (data) {
      // 🛡️ 14-05：setProfile 前再校验一次，确保旧会话结果绝不进入 React state。
      if (!isGenerationCurrent()) return;
      setProfile(data);
      writeProfileCache(data, startGeneration);
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
      if (next?.id) writeProfileCache(next, generationRef.current);
      return next;
    });
  }, []);

  return { profile, loading, refresh, updateLocalProfile };
}
// --- END OF FILE src/hooks/profile/useProfileCache.js ---
