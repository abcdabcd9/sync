# P1.4 R2 — 迁移前 JS 基线冻结清单

## 冻结文件

| 冻结副本 | 原始路径 | 行数 | SHA-256 |
|---|---|---|---|
| `context__ThemeContext.js` | `src/context/ThemeContext.js` | 113 | `9f18af253073ed242f8adc9586b1a51787a67919b5499e9036974c09fd3d3afd` |
| `hooks__useAppSettings.js` | `src/hooks/useAppSettings.js` | 108 | `6e4111c8667bd17056c459f8addcf2629c29b2abfdeb9f77338a5665e88f9c42` |
| `hooks__profile__useProfileCache.js` | `src/hooks/profile/useProfileCache.js` | 285 | `426cfa5cb3ac1f793348d420c867c8b05606851f9d088bf69b268b52d6a57f7d` |

合计 506 行。

## 校验方式

```bash
shasum -a 256 tests/fixtures/p14r2/before/*.js
```

基线取自当前工作区（P1.4 R1 完成后的真实状态），**不是** HEAD `96881618a70a7b16871a7223ec81074601d64692` 的旧版本。

## 迁移目标

| 基线 | 迁移目标 |
|---|---|
| `context__ThemeContext.js` | `src/context/ThemeContext.tsx`（含 Provider JSX，必须 `.tsx`） |
| `hooks__useAppSettings.js` | `src/hooks/useAppSettings.ts` |
| `hooks__profile__useProfileCache.js` | `src/hooks/profile/useProfileCache.ts` |

## 公开接口（迁移前实测）

### ThemeContext

```js
export const THEME_MODES = ['system', 'light', 'dark'];
export function ThemeProvider({ children })
export function useAppTheme()   // 无 Provider 时 throw new Error('useAppTheme 必须在 <ThemeProvider> 内部使用')
// 默认导出：无（仅具名导出）
```

- `createContext(null)` —— 默认值为 `null`，不是空对象。
- Provider value 结构：`{ themeMode, setThemeMode, isDark, colors, isThemeLoaded }`（字段顺序固定）。
- `colors` = `{ ...getPalette(isDark), isDark, radiusCard, radiusList, padding, typography }`。

### useAppSettings

```js
export const DEFAULT_SETTINGS = { /* 14 个字段 */ };
export function useAppSettings()
export default useAppSettings;
```

- 返回 `{ settings, updateSetting, resetSettings, isLoading }`（`useMemo` 包装，字段顺序固定）。
- 存储键：`@app_settings`（单 key，JSON 对象）。

### useProfileCache

```js
export const PROFILE_CACHE_KEY = '@user_profile_cache';
export const PROFILE_CACHE_KEY_PREFIX = '@user_profile_cache_v2_';
export function buildProfileCacheKey(userId)
export function setProfileCacheOwner(ownerId, forceBump = false)
export function getProfileCacheGeneration()
export function normalizeProfile(row)
export async function readProfileCache(userId)
export async function writeProfileCache(profile, expectedGeneration = null)
export async function clearProfileCache(userId)
export async function fetchProfileFromCloud(userId, columns = 'id, username, sync_id, nickname')
export function useProfileCache(user, columns = 'id, username, sync_id, nickname')
// 默认导出：无
```

- 模块级可变状态：`currentOwnerId`（初始 `null`）、`ownerGeneration`（初始 `0`）。
- `CLOUD_TIMEOUT_MS = 30000`。
- Hook 返回 `{ profile, loading, refresh, updateLocalProfile }`。

## State / Ref / Effect 清单

### ThemeContext（ThemeProvider）

| 类型 | 名称 | 初值 | 说明 |
|---|---|---|---|
| useState | `themeMode` | `'system'` | 用户选择的模式 |
| useState | `isThemeLoaded` | `false` | 磁盘读取完成标志 |
| useColorScheme | `systemScheme` | 原生 | 仅 `themeMode === 'system'` 时采用 |
| useEffect | 启动读取 | deps `[]` | `cancelled` 标志 + `AsyncStorage.getItem('@app_theme_mode')` |
| useCallback | `setThemeMode` | deps `[]` | 非法模式告警忽略；先 setState 再异步落盘 |
| useMemo | `isDark` | deps `[themeMode, systemScheme]` | dark→true / light→false / 否则 `systemScheme === 'dark'` |
| useMemo | `colors` | deps `[isDark]` | `getPalette(isDark)` 展开 + 4 个设计常量 |
| useMemo | `value` | deps `[themeMode, setThemeMode, isDark, colors, isThemeLoaded]` | Provider value |

### useAppSettings

| 类型 | 名称 | 初值 | 说明 |
|---|---|---|---|
| useState | `settings` | `DEFAULT_SETTINGS` | 首帧即默认值 |
| useState | `isLoading` | `true` | |
| useEffect | 启动读取 | deps `[]` | `cancelled` + `getItem('@app_settings')` + `JSON.parse` + 合并默认值 |
| useCallback | `updateSetting` | deps `[]` | `key in DEFAULT_SETTINGS` 校验；setState updater 内落盘 |
| useCallback | `resetSettings` | deps `[]` | setState 默认值 + 落盘 |
| useMemo | 返回值 | deps `[settings, updateSetting, resetSettings, isLoading]` | |

### useProfileCache（Hook 部分）

| 类型 | 名称 | 初值 | 说明 |
|---|---|---|---|
| useState | `profile` | `null` | |
| useState | `loading` | `true` | |
| useRef | `mountedRef` | `true` | 卸载后禁止 setState |
| useEffect | 挂载标志 | deps `[]` | cleanup 置 `false` |
| useRef | `generationRef` | `0` | 本实例代际快照 |
| useState | `prevOwner` | `userId` | 渲染期 owner 变化检测 |
| useRef | `paramsRef` | `{ userId, columns }` | 保证 refresh 引用稳定 |
| useEffect | 同步 paramsRef | deps `[userId, columns]` | |
| useCallback | `refresh` | deps `[]` | 缓存优先 + 云端刷新 + 三重代际校验 |
| useEffect | 触发 refresh | deps `[refresh, userId]` | |
| useCallback | `updateLocalProfile` | deps `[]` | setState updater 内 normalize + 落盘 |

## 身份隔离契约（必须逐条保持）

### ThemeContext / useAppSettings
1. 二者**均不感知** userId / authEpoch，存储键为全局单 key，不做账号隔离。迁移不得新增账号维度。
2. `createContext(null)` 默认值不得改为 `{}`。
3. `useAppTheme` 无 Provider 时必须 `throw`，不得静默返回。
4. Provider value 字段顺序与引用稳定性（`useMemo` 依赖）不得改变。
5. `setThemeMode` 非法值必须 `console.warn` 并 return，不得抛错。
6. `updateSetting` 未知 key 必须 `console.warn` 并 return，不得抛错。
7. 落盘失败只 `console.warn`，不得向上抛。
8. `updateSetting` 的 `AsyncStorage.setItem` 必须仍在 setState updater 内部（保证写入内容为最新 next）。

### useProfileCache
9. `writeProfileCache` 必须 **fail-closed**：`currentOwnerId` 为 `null` 时一律拒绝写入。
10. `writeProfileCache` 必须校验 `profile.id === currentOwnerId`。
11. `writeProfileCache` 的 `expectedGeneration` 非 `null` 时必须与 `ownerGeneration` 相等。
12. `readProfileCache` 必须校验 `parsed.id === userId`，不一致返回 `null`。
13. `readProfileCache` 无有效 userId 时返回 `null`，绝不读旧全局 key。
14. `setProfileCacheOwner` 仅在 owner 变化或 `forceBump` 时自增代际。
15. `refresh` 必须同时比对 `generationRef.current` 与 `getProfileCacheGeneration()`（模块级权威）。
16. `refresh` 在 `setProfile` 前必须再次校验代际。
17. 云端失败必须只 `console.warn`，绝不清空 `profile`。
18. 渲染期只允许 `setState`，不得写 ref、不得调用 `setProfileCacheOwner`。
19. `fetchProfileFromCloud` 超时必须返回 `{ data: null, error }`，不得抛到调用方。
20. 旧全局 key `@user_profile_cache` 只保留常量，绝不读写、绝不删除。
