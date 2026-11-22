/**
 * 设置 / 主题契约（TASK-P1.1 R0 / Phase C4）
 *
 * ============================================================================
 * 契约来源（逐字段核对，非猜测）
 * ============================================================================
 *   - `src/hooks/useAppSettings.js`
 *       DEFAULT_SETTINGS（全部偏好字段与默认值）/ updateSetting / resetSettings
 *   - `src/context/ThemeContext.js`
 *       THEME_MODES / ThemeProvider value / useAppTheme
 *   - `src/constants/settings.js`
 *       MOMENTS_VISIBILITY / CHAT_BACKGROUNDS / LANGUAGES（UI 选项）
 *
 * ============================================================================
 * 重要说明
 * ============================================================================
 *   1. 本文件**只声明类型**，不修改任何色值、主题 UI 或既有设置行为。
 *   2. `momentsVisibility` 在设置中是 'all' | 'friends' | 'self'，
 *      注意与数据库 `moments.visibility`（'all' | 'friends' | 'private'）**不同**：
 *      前者是「我的朋友圈对谁可见」的偏好，后者是单条动态的可见性。
 *      两者是不同概念，不得合并。
 *   3. `colors` 调色板来自 `constants/colors.js` + `constants/theme.js`，
 *      本文件不重复定义色值，仅声明其结构为开放对象。
 */

// ---------------------------------------------------------------------------
// 应用设置（useAppSettings）
// ---------------------------------------------------------------------------

/**
 * 朋友圈可见范围（设置偏好）。
 *
 * 注意：与数据库 `moments.visibility` 不同（此处用 'self'，数据库用 'private'）。
 */
export type SettingsMomentsVisibility = 'all' | 'friends' | 'self';

/** 聊天背景（设置偏好） */
export type SettingsChatBackground = 'default' | 'light' | 'dark';

/** 界面语言（设置偏好） */
export type SettingsLanguage = 'zh' | 'en';

/**
 * 应用设置对象（`DEFAULT_SETTINGS` 的完整形态）。
 *
 * 字段与默认值严格对应 `useAppSettings.js#DEFAULT_SETTINGS`。
 */
export interface AppSettings {
  // —— 通知 ——
  notifyMessage: boolean;
  notifyPartner: boolean;
  notifySound: boolean;

  // —— 朋友权限 ——
  momentsVisibility: SettingsMomentsVisibility;
  allowFriendRequest: boolean;
  allowSearch: boolean;

  // —— 聊天设置 ——
  chatBackground: SettingsChatBackground;
  earpieceMode: boolean;
  messagePreview: boolean;

  // —— 自动下载 ——
  autoDownloadImage: boolean;
  autoDownloadVideo: boolean;
  autoDownloadFile: boolean;

  // —— 更多 ——
  careMode: boolean;
  language: SettingsLanguage;
}

/** 设置项键名（`keyof AppSettings`） */
export type SettingsKey = keyof AppSettings;

/**
 * 单个设置项的键值对（用于 `updateSetting(key, value)` 的类型安全调用）。
 *
 * 说明：`updateSetting` 运行时接受任意 key（未知 key 仅告警忽略），
 * 但类型层面建议使用此映射以获得正确的 value 类型。
 */
export type SettingsUpdateEntry = {
  [K in SettingsKey]: { key: K; value: AppSettings[K] };
}[SettingsKey];

/**
 * `useAppSettings()` 返回值。
 *
 * 源码：`return { settings, updateSetting, resetSettings, isLoading };`
 */
export interface UseAppSettingsResult {
  settings: AppSettings;
  updateSetting: <K extends SettingsKey>(key: K, value: AppSettings[K]) => void;
  resetSettings: () => void;
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// 主题（ThemeContext）
// ---------------------------------------------------------------------------

/**
 * 主题模式（`THEME_MODES`）。
 *
 * 源码：`export const THEME_MODES = ['system', 'light', 'dark'];`
 */
export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * 主题调色板（`colors`）。
 *
 * 结构：`constants/colors.js#getPalette(isDark)` 展开 + 语义别名 + 设计系统常量。
 * 本文件不重复定义具体色值，仅声明为开放对象（具体键由 colors.js 决定）。
 */
export interface ThemeColors {
  /** 是否深色（语义别名） */
  isDark: boolean;
  /** 卡片圆角（SIZES.radiusCard） */
  radiusCard: number;
  /** 列表圆角（SIZES.radiusList） */
  radiusList: number;
  /** 内边距（SIZES.padding） */
  padding: number;
  /**
   * 排版常量（`constants/theme.ts#TYPOGRAPHY`，原样透传）。
   *
   * 说明：此处使用 `unknown` 而非 `Record<string, unknown>`，
   * 因为 `Typography` 接口没有字符串索引签名，无法赋值给 `Record`。
   * 运行时对象结构完全不变，仅放宽静态可赋值性。
   */
  typography: unknown;
  /** 其余调色板键（来自 getPalette，开放） */
  [key: string]: unknown;
}

/**
 * `ThemeContext` 提供的值（`useAppTheme()` 返回）。
 *
 * 源码 value：`{ themeMode, setThemeMode, isDark, colors, isThemeLoaded }`
 */
export interface ThemeContextValue {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  isDark: boolean;
  colors: ThemeColors;
  isThemeLoaded: boolean;
}

// ---------------------------------------------------------------------------
// 设置选项常量（constants/settings.js）
// ---------------------------------------------------------------------------

/**
 * 设置页「多选一」选项项。
 *
 * 源码：`{ key, label, desc }`。
 */
export interface SettingsOption<K extends string = string> {
  key: K;
  label: string;
  desc: string;
}

/** 朋友圈可见范围选项（`MOMENTS_VISIBILITY`） */
export type MomentsVisibilityOption = SettingsOption<SettingsMomentsVisibility>;

/** 聊天背景选项（`CHAT_BACKGROUNDS`） */
export type ChatBackgroundOption = SettingsOption<SettingsChatBackground>;

/** 语言选项（`LANGUAGES`） */
export type LanguageOption = SettingsOption<SettingsLanguage>;
