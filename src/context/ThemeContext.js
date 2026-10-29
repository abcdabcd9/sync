// --- START OF FILE src/context/ThemeContext.js ---
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getPalette } from '../constants/colors';
import { SIZES, TYPOGRAPHY } from '../constants/theme';

/**
 * 🎨 全局主题状态中心
 *
 * 职责：
 *   1. 持有用户选择的主题模式：'system' | 'light' | 'dark'
 *   2. 持久化到 AsyncStorage（key: @app_theme_mode），重启后保持
 *   3. 把「模式」解析成最终的 isDark 布尔值（system 时跟随原生 useColorScheme）
 *   4. 对外提供整合好的 colors 调色板（colors.js 的 SYSTEM_COLORS + theme.js 的 SIZES/TYPOGRAPHY）
 *
 * ⚠️ 最高指令：本文件只统一「主题控制权」，绝不修改任何色值。
 *    主色 #FF2D55 / #FF375F 与液态玻璃配色（card / cardBorder / dockBackground 等）
 *    全部原样来自 constants/colors.js，不做任何覆盖。
 */

const STORAGE_KEY = '@app_theme_mode';

export const THEME_MODES = ['system', 'light', 'dark'];

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  // 用户选择的模式（持久化）
  const [themeMode, setThemeModeState] = useState('system');
  // 是否已完成磁盘读取（避免首帧闪烁：未读完前先按 system 渲染）
  const [isThemeLoaded, setIsThemeLoaded] = useState(false);

  // 原生系统配色（仅在 themeMode === 'system' 时被采用）
  const systemScheme = useColorScheme();

  // 1️⃣ 启动时读取持久化的模式
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && saved && THEME_MODES.includes(saved)) {
          setThemeModeState(saved);
        }
      } catch (e) {
        console.warn('⚠️ 读取主题模式失败，回退到 system:', e?.message ?? e);
      } finally {
        if (!cancelled) setIsThemeLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 2️⃣ 切换模式：先更新内存状态（UI 立即响应），再异步落盘
  const setThemeMode = useCallback((mode) => {
    if (!THEME_MODES.includes(mode)) {
      console.warn(`⚠️ 非法主题模式: ${mode}，已忽略`);
      return;
    }
    setThemeModeState(mode);
    AsyncStorage.setItem(STORAGE_KEY, mode).catch((e) => {
      console.warn('⚠️ 保存主题模式失败:', e?.message ?? e);
    });
  }, []);

  // 3️⃣ 解析最终明暗：system 时跟随原生，否则强制
  const isDark = useMemo(() => {
    if (themeMode === 'dark') return true;
    if (themeMode === 'light') return false;
    return systemScheme === 'dark';
  }, [themeMode, systemScheme]);

  // 4️⃣ 整合调色板：colors.js 提供色值，theme.js 提供尺寸与排版
  const colors = useMemo(() => {
    const palette = getPalette(isDark);
    return {
      ...palette,
      // 语义别名，方便新代码使用
      isDark,
      // 设计系统常量（原样透传，不改值）
      radiusCard: SIZES.radiusCard,
      radiusList: SIZES.radiusList,
      padding: SIZES.padding,
      typography: TYPOGRAPHY,
    };
  }, [isDark]);

  const value = useMemo(() => ({
    themeMode,
    setThemeMode,
    isDark,
    colors,
    isThemeLoaded,
  }), [themeMode, setThemeMode, isDark, colors, isThemeLoaded]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 全局主题 Hook
 * @returns {{ themeMode: 'system'|'light'|'dark', setThemeMode: (m: string) => void, isDark: boolean, colors: object, isThemeLoaded: boolean }}
 */
export function useAppTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useAppTheme 必须在 <ThemeProvider> 内部使用');
  }
  return ctx;
}

// --- END OF FILE src/context/ThemeContext.js ---
