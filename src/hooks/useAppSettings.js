// --- START OF FILE src/hooks/useAppSettings.js ---
import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
export const DEFAULT_SETTINGS = {
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

export function useAppSettings() {
  // 内存状态：首帧直接用默认值渲染，避免闪烁
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  // 1️⃣ 启动时读取磁盘，与默认值合并（防止旧版本缺字段）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            setSettings({ ...DEFAULT_SETTINGS, ...parsed });
          }
        }
      } catch (e) {
        console.warn('⚠️ 读取应用设置失败，回退到默认值:', e?.message ?? e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2️⃣ 更新单个设置项：先改内存，再异步落盘
  const updateSetting = useCallback((key, value) => {
    if (!(key in DEFAULT_SETTINGS)) {
      console.warn(`⚠️ 未知设置项: ${key}，已忽略`);
      return;
    }
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch((e) => {
        console.warn('⚠️ 保存应用设置失败:', e?.message ?? e);
      });
      return next;
    });
  }, []);

  // 3️⃣ 恢复默认（供「清除缓存」等场景调用）
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS)).catch((e) => {
      console.warn('⚠️ 重置应用设置失败:', e?.message ?? e);
    });
  }, []);

  return useMemo(
    () => ({ settings, updateSetting, resetSettings, isLoading }),
    [settings, updateSetting, resetSettings, isLoading]
  );
}

export default useAppSettings;
// --- END OF FILE src/hooks/useAppSettings.js ---
