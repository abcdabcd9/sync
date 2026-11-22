// --- START OF FILE src/hooks/useAppSettings.ts ---
import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AppSettings, SettingsKey, UseAppSettingsResult } from '../types/settings';

/**
 * ⚙️ 应用设置持久化中心
 *
 * 职责：
 *   1. 持有全部「偏好类」设置（朋友权限 / 聊天 / 自动下载 / 更多）
 *   2. 持久化到 AsyncStorage（单 key `@app_settings`，存一个 JSON 对象）
 *   3. 内存优先：改开关立即反映到 UI，落盘异步进行，失败只告警不阻断
 *
 * ⚠️ 本 hook 只负责「存」，不负责「用」。
 *    开关改变 App 行为（如听筒模式、关怀模式）属于后续阶段的行为接入，
 *    届时各消费方直接读 settings.xxx 即可，无需改动本文件。
 *
 * 持久化范式与 ThemeContext 保持一致：
 *   启动读取 → 内存状态 → 异步落盘 → 失败 console.warn
 */

const STORAGE_KEY = '@app_settings';

// 全部默认值集中在此，新增设置项只需在这里加一行
export const DEFAULT_SETTINGS: AppSettings = {
  // —— 通知 ——
  notifyMessage: true,
  notifyPartner: true,
  notifySound: true,

  // —— 朋友权限 ——
  momentsVisibility: 'friends', // 'all' | 'friends' | 'self'
  allowFriendRequest: true,
  allowSearch: true,

  // —— 聊天设置 ——
  chatBackground: 'default', // 'default' | 'light' | 'dark'
  earpieceMode: false,
  messagePreview: true,

  // —— 自动下载 ——
  autoDownloadImage: true,
  autoDownloadVideo: false,
  autoDownloadFile: false,

  // —— 更多 ——
  careMode: false,
  language: 'zh', // 'zh' | 'en'
};

/**
 * 运行时键名校验（严格保持原 `key in DEFAULT_SETTINGS` 的宽松入参语义）。
 *
 * 说明：原 JS 实现接受任意入参（包括非字符串、对象、Symbol 等），
 * 直接使用 `in` 运算符的原始运行时语义（含对象键的 ToPropertyKey 强制转换，
 * 例如 `{ toString: () => 'notifySound' }` 会被判定为合法键）。
 * 这里仅用 `PropertyKey` 静态视图让 `in` 通过类型检查（纯类型断言，
 * 零运行时副作用），不额外增加 `typeof` 过滤，也不改变任何运行时行为。
 */
const isSettingsKey = (key: unknown): key is SettingsKey =>
  (key as PropertyKey) in DEFAULT_SETTINGS;

export function useAppSettings(): UseAppSettingsResult {
  // 内存状态：首帧直接用默认值渲染，避免闪烁
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  // 1️⃣ 启动时读取磁盘，与默认值合并（防止旧版本缺字段）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            setSettings({ ...DEFAULT_SETTINGS, ...(parsed as Partial<AppSettings>) });
          }
        }
      } catch (e) {
        console.warn('⚠️ 读取应用设置失败，回退到默认值:', (e as Error)?.message ?? e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2️⃣ 更新单个设置项：先改内存，再异步落盘
  const updateSetting = useCallback(<K extends SettingsKey>(key: K, value: AppSettings[K]) => {
    if (!isSettingsKey(key)) {
      // 保持原始模板插值语义：Symbol 等无法隐式转字符串的入参
      // 会在此处抛出 TypeError（与原 JS 实现完全一致），不得改为 String(key)。
      console.warn(`⚠️ 未知设置项: ${key}，已忽略`);
      return;
    }
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch((e: unknown) => {
        console.warn('⚠️ 保存应用设置失败:', (e as Error)?.message ?? e);
      });
      return next;
    });
  }, []);

  // 3️⃣ 恢复默认（供「清除缓存」等场景调用）
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS)).catch((e: unknown) => {
      console.warn('⚠️ 重置应用设置失败:', (e as Error)?.message ?? e);
    });
  }, []);

  return useMemo(
    () => ({ settings, updateSetting, resetSettings, isLoading }),
    [settings, updateSetting, resetSettings, isLoading]
  );
}

export default useAppSettings;
// --- END OF FILE src/hooks/useAppSettings.ts ---
