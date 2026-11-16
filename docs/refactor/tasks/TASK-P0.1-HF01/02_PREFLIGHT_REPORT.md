# 02 — 只读预检报告：TASK-P0.1-HF01

> 任务：TASK-P0.1-HF01 Supabase 启动防御修复
> 阶段：T0 / T1 只读预检
> 初步风险等级：L3（实施阶段预判）；本次预检实际风险 L1
> 采集时间：2026-11-16T14:29Z
> 基线：`main` @ `eec7880`（工作区含 3 个未提交改动）
> 证据：全部来自真实源码与本地只读命令，详见 [`03_SOURCE_CONTEXT.txt`](03_SOURCE_CONTEXT.txt)

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| **根因** | [`src/services/supabase.js`](../../../src/services/supabase.js:47) 模块顶层 `new URL(supabaseUrl)` 在 env 缺失/空/非法时抛 `TypeError: Invalid URL` |
| **崩溃时机** | **模块加载期**（早于 `createClient`、早于任何 React 渲染） |
| **现有防御为何失效** | 新增的 `ENV_MISSING` 判断（第 16–22 行）只影响 `console.error` 与 `createClient` 入参（第 112–113 行），**未保护第 47 行** |
| **`isSupabaseConfigured`** | 已导出但**零消费者**（全仓库仅定义处 1 处引用） |
| **影响面** | 28 个文件 import `supabase`；`AuthProvider` 是根 Provider，`useAuth` 在 `RootLayout` 最外层 |
| **正常配置行为** | 当前正常配置下**不崩溃**，行为正确；修复必须保持这一点 |
| **推荐方案** | 方案 A（最小修改）：为 `AUTH_STORAGE_KEY` 计算加安全兜底，保持正常配置下 key 完全不变 |
| **更安全替代** | 方案 B：抽离 `resolveSupabaseConfig()` 纯函数 + 显式降级态，供 UI 展示「未配置」而非静默失败 |

---

## 1. 根因分析

### 1.1 崩溃点

[`src/services/supabase.js`](../../../src/services/supabase.js:47)：

```js
const AUTH_STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
```

- 该行位于**模块顶层**，在 import 时立即求值。
- `supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL`（第 8 行），env 缺失时为 `undefined`。
- `new URL(undefined)` → `TypeError: Invalid URL`（本地实测，见 §3）。

### 1.2 为什么现有改动没修好

待提交改动（第 11–28 行）新增：

```js
const ENV_MISSING = !supabaseUrl || !supabaseAnonKey;
if (ENV_MISSING) { console.error(...); }          // 只打日志
const FALLBACK_URL = 'https://placeholder.supabase.co';
const FALLBACK_KEY = 'placeholder-anon-key';
export const isSupabaseConfigured = !ENV_MISSING;
```

以及第 111–113 行：

```js
export const supabase = createClient(
  supabaseUrl || FALLBACK_URL,     // 这里用了兜底
  supabaseAnonKey || FALLBACK_KEY,
  ...
```

**问题**：第 47 行的 `new URL(supabaseUrl)` 在**第 111 行之前**执行，且**未使用** `FALLBACK_URL`。因此：

```
模块加载
  ├─ 第 8-9 行：读取 env（可能 undefined）
  ├─ 第 16-22 行：ENV_MISSING 判断（只打日志，不中断）
  ├─ 第 47 行：new URL(undefined) → 💥 TypeError  ← 崩溃在这里
  └─ 第 111 行：createClient(...)  ← 永远执行不到
```

改动把「显式 `throw new Error`」换成了「更晚、更隐蔽的 `TypeError`」，**崩溃依旧发生**，且注释「让 App 能正常启动」与事实不符。

### 1.3 崩溃传播路径

```
import 'src/services/supabase.js'
  → 模块顶层 new URL(undefined) 抛 TypeError
  → 任何 import 该模块的文件加载失败
  → src/hooks/useAuth.js（第 3 行 import）加载失败
  → src/app/_layout.js（第 8 行 import useAuth）加载失败
  → Expo Router 根布局无法挂载
  → App 启动白屏 / 闪退
```

由于 `AuthProvider` 是 [`src/app/_layout.js`](../../../src/app/_layout.js:67) 中**最外层** Provider，且 `useAuth` 被 `RootNavigation`、`usePushNotifications`、`useHealthData` 等广泛依赖，崩溃无法被任何 React Error Boundary 捕获（发生在渲染之前）。

---

## 2. 调用链与影响面

### 2.1 初始化链

```
src/app/_layout.js:64  RootLayout
  └─ ThemeProvider (66)
      └─ AuthProvider (67)              ← src/hooks/useAuth.js:7
          │   useEffect → supabase.auth.getSession()      (useAuth.js:14)
          │   useEffect → supabase.auth.onAuthStateChange (useAuth.js:21)
          └─ HealthProvider (68)        ← src/hooks/useHealthData.js:20
              │   useTimeSync → supabase.rpc('get_server_time')  (useTimeSync.js:41)
              │   useHealthCloud → supabase.from('health_records') (useHealthCloud.js:30)
              └─ CinemaProvider (69)
                  └─ BrowserSessionProvider (70)
                      └─ RootNavigation (71)
                          └─ usePushNotifications → supabase.from('profiles') (usePushNotifications.js:55)
```

### 2.2 `AUTH_STORAGE_KEY` 使用范围

| 位置 | 用途 |
| --- | --- |
| [`supabase.js:47`](../../../src/services/supabase.js:47) | 定义：`sb-${hostname首段}-auth-token` |
| [`supabase.js:118`](../../../src/services/supabase.js:118) | 作为 `createClient` 的 `auth.storageKey` |

> 该 key 是 Supabase SDK 会话持久化的命名空间。**若修复时改变了正常配置下的 key 值，全体已登录用户会被强制登出**（旧 key 读不到）。这是本任务最敏感的点。

### 2.3 `SecureStoreAdapter` 完整实现（第 63–109 行）

- `getItem`：先读 SecureStore → 未命中则从 AsyncStorage 迁移旧明文 → 失败降级 AsyncStorage
- `setItem`：写 SecureStore → 失败降级 AsyncStorage
- `removeItem`：删 SecureStore + 删 AsyncStorage 残留
- **关键**：适配器本身**不依赖 `supabaseUrl`**，只依赖传入的 `key`。因此崩溃与适配器无关，纯粹是第 47 行的 URL 解析。

### 2.4 Supabase 客户端调用方（28 个文件）

| 类别 | 文件 |
| --- | --- |
| 服务层 | `src/services/supabase.js`、`src/services/pushService.js` |
| 顶层 hook | `useAuth.js`、`useHealthData.js`、`useCinema.js`、`useSyncRoom.js`、`usePushNotifications.js` |
| 域 hook | `health/useTimeSync.js`、`health/useHealthCloud.js`、`profile/useProfileCache.js`、`chat/useSignedMediaUrl.js`、`chat/useChatMessages.js`、`chat/useChatList.js`、`chat/useMediaUpload.js`、`chat/useFriendActions.js`、`chat/useAudioRecorder.js` |
| 组件 | `CustomTabBar.js`、`ChatRoomInner.js`、`InteractiveMediaViewer.js` |
| 页面 | `chat_room.js`、`invite_friend.js`、`bind_partner.js`、`account_info.js`、`chat/search.js`、`chat/chat_settings.js`、`chat/moments.js`、`chat/chat_search.js`、`chat/complaint.js`、`chat/contacts.js`、`settings/security.js`、`(tabs)/chat.js` |

> 全部为**函数内调用**（无模块顶层 `supabase.xxx()` 调用），因此只要模块能成功加载，后续调用失败可被各 hook 的 `try/catch` 或 `.catch` 捕获。

### 2.5 `isSupabaseConfigured` 调用方

```
rg "isSupabaseConfigured" src
→ src/services/supabase.js:28:export const isSupabaseConfigured = !ENV_MISSING;
```

**结论：0 个消费者。** 该导出目前是死代码，无法用于 UI 降级提示。若采用方案 B，需要新增消费点。

---

## 3. 异常场景矩阵（本地实测）

`new URL()` 行为实测（Node v24.21.0）：

| 输入 | 结果 |
| --- | --- |
| `undefined` | ❌ `TypeError: Invalid URL` |
| `null` | ❌ `TypeError: Invalid URL` |
| `""`（空串） | ❌ `TypeError: Invalid URL` |
| `"   "`（空白） | ❌ `TypeError: Invalid URL` |
| `"abc.supabase.co"`（无 scheme） | ❌ `TypeError: Invalid URL` |
| `"https://abc.supabase.co"` | ✅ `hostname=abc.supabase.co` |
| `"https://abc.supabase.co/"` | ✅ `hostname=abc.supabase.co` |

### 3.1 场景对照表

| 场景 | `supabaseUrl` | `supabaseAnonKey` | 当前行为 | 期望行为 |
| --- | --- | --- | --- | --- |
| 正常 | 有效 URL | 有效 key | ✅ 正常 | 不变 |
| 完全缺失 | `undefined` | `undefined` | 💥 第 47 行崩溃 | 不崩溃 + 明确提示 |
| 仅缺 URL | `undefined` | 有效 | 💥 第 47 行崩溃 | 不崩溃 + 明确提示 |
| 仅缺 Key | 有效 URL | `undefined` | ⚠️ 不崩溃（第 47 行 OK），但 `createClient` 用 `FALLBACK_KEY` → 所有请求 401 | 不崩溃 + 明确提示 |
| URL 为空串 | `""` | 任意 | 💥 第 47 行崩溃 | 不崩溃 + 明确提示 |
| URL 空白 | `"   "` | 任意 | 💥 第 47 行崩溃 | 不崩溃 + 明确提示 |
| URL 无 scheme | `"abc.supabase.co"` | 任意 | 💥 第 47 行崩溃 | 不崩溃 + 明确提示 |
| URL 非法格式 | `"not a url"` | 任意 | 💥 第 47 行崩溃 | 不崩溃 + 明确提示 |

> 注意「仅缺 Key」场景：第 47 行不崩溃，但 `createClient` 用占位 key 会向**真实 URL** 发请求并收到 401。这不会泄露数据（无有效凭证），但会产生无意义的网络请求与错误日志。

---

## 4. 占位客户端风险分析

### 4.1 是否会产生网络请求

- `createClient(FALLBACK_URL, FALLBACK_KEY, ...)` 本身**不主动发请求**。
- 但 `AuthProvider` 的 `useEffect` 会立即调用 `supabase.auth.getSession()`（[`useAuth.js:14`](../../../src/hooks/useAuth.js:14)）——这是**本地会话读取**，不联网。
- `onAuthStateChange` 注册监听，不联网。
- 若存在已持久化会话，SDK 可能尝试 refresh token → 向 `placeholder.supabase.co` 发请求 → DNS 失败/超时，被 SDK 内部捕获。

### 4.2 是否会泄露认证信息

| 风险 | 评估 |
| --- | --- |
| 向占位服务发送 anon key | 占位 key 是假值，无泄露风险 |
| 向占位服务发送用户 token | **仅当**本地存在旧会话且 SDK 触发 refresh 时，可能把 refresh_token 发往 `placeholder.supabase.co`。该域名非本项目所有，理论上存在被第三方接管的风险 |
| 向占位服务发送业务数据 | 不会（业务请求需先通过 auth，无有效会话则不发） |

> **这是方案 A（占位 client）的固有缺陷**：占位域名 `placeholder.supabase.co` 并非本项目控制，若被他人注册，理论上可接收 refresh token。虽然概率极低，但违反「不得向占位服务发送认证信息」的约束。

### 4.3 会话读写

- `storageKey` 仍为 `sb-<hostname>-auth-token`。若 env 缺失，第 47 行崩溃前根本到不了这里；若仅缺 Key（URL 有效），storageKey 正常，会话读写正常，只是网络请求 401。
- **修复时若改变 storageKey 计算方式，必须保证正常配置下结果完全一致**。

---

## 5. 平台兼容性分析

| 平台 | 风险 | 说明 |
| --- | --- | --- |
| Expo Go | 中 | Expo Go 内置模块有限；`expo-secure-store` 可用。env 通过 `EXPO_PUBLIC_*` 注入，缺失时同样触发第 47 行崩溃 |
| Android 原生构建 | 中 | EAS 构建需配置 `environment`（本次 `eas.json` 改动即为此）；未配置时 env 缺失 → 崩溃 |
| iOS 原生构建 | 中 | 同上 |
| Web | 低 | `react-native-web` 下 `new URL` 行为一致（浏览器原生 URL） |

> `new URL` 在 Hermes（RN 默认引擎）与 JSC 下行为一致，均对非法输入抛 `TypeError`。修复方案不应依赖引擎差异。

---

## 6. 方案对比

### 方案 A — 最小修改：为 `AUTH_STORAGE_KEY` 加安全兜底（推荐）

**思路**：只改第 47 行，正常配置下结果**逐字节不变**。

```js
// 伪代码（非最终实现，仅供评审）
function resolveAuthStorageKey(url) {
  try {
    const host = new URL(url).hostname.split('.')[0];
    if (host) return `sb-${host}-auth-token`;
  } catch { /* 忽略，走兜底 */ }
  return 'sb-unconfigured-auth-token';   // 仅异常时使用，正常配置永不触发
}
const AUTH_STORAGE_KEY = resolveAuthStorageKey(supabaseUrl);
```

| 优点 | 缺点 |
| --- | --- |
| 改动最小（1 处） | 仍使用占位 client，§4.2 的 refresh token 理论风险仍在 |
| 正常配置 key 完全不变，不破坏会话 | 静默降级，用户无感知 |
| 不引入依赖、不扩大范围 | — |

### 方案 B — 更安全替代：抽离配置解析 + 显式降级态

**思路**：

1. 新增纯函数 `resolveSupabaseConfig()`，返回 `{ url, anonKey, configured, authStorageKey }`，内部 `try/catch` 解析 URL。
2. `configured === false` 时，**不创建指向占位域名的 client**，而是创建一个「惰性拒绝」的 client（或让 `supabase` 为 `null`，并在所有调用点前置 `isSupabaseConfigured` 守卫）。
3. 在 UI 层（如 `_layout.js` 或 `auth.js`）消费 `isSupabaseConfigured`，展示「未配置 Supabase」提示页，而非静默白屏。

| 优点 | 缺点 |
| --- | --- |
| 彻底消除占位域名泄露风险 | 改动面较大（需处理 28 个调用点的 null 守卫） |
| 用户可见明确错误 | 可能触及「不得扩大为全项目认证系统重构」约束边界 |
| `isSupabaseConfigured` 真正被使用 | 需要新增 UI 降级组件 |

### 方案 C — 折中：A + 占位域名改为不可路由保留域名

在方案 A 基础上，把 `FALLBACK_URL` 从 `https://placeholder.supabase.co` 改为 RFC 2606 保留的不可解析域名（如 `https://invalid.invalid`），确保即使触发 refresh 也**不可能**被第三方接管。

| 优点 | 缺点 |
| --- | --- |
| 消除 §4.2 的域名接管风险 | 仍是静默降级 |
| 改动仍很小 | — |

### 方案推荐

- **若追求最小风险**：方案 A + C 组合（改第 47 行兜底 + 占位域名换 `.invalid`）。
- **若追求彻底安全**：方案 B，但需项目负责人确认是否超出「不得扩大范围」约束。

> 本预检**不实施**任何方案，仅提供对比供 GPT / Gemini 独立设计与审查。

---

## 7. 修复必须满足的验收条件（供实施阶段参考）

| # | 条件 |
| --- | --- |
| AC-1 | 正常配置下，`AUTH_STORAGE_KEY` 与当前值**逐字节一致**（`sb-<hostname首段>-auth-token`） |
| AC-2 | env 缺失/空串/空白/无 scheme/非法 URL 时，**模块加载不抛异常** |
| AC-3 | 仅缺 Key 时，不崩溃且不向真实 URL 发送带占位 key 的请求（或明确记录） |
| AC-4 | 不向任何非本项目控制的域名发送 refresh token |
| AC-5 | `npx tsc --noEmit` → 0 error |
| AC-6 | `npx expo lint` → 不新增问题（基线 144 项） |
| AC-7 | 不引入新依赖、不修改数据库、不改变正常登录流程 |

---

## 8. 风险等级核验

| 维度 | 评估 |
| --- | --- |
| 本次预检实际风险 | **L1**（纯只读，无副作用） |
| 后续实施阶段风险 | **L3**（影响 28 文件的数据层根节点；storageKey 改错会导致全体用户登出） |
| 可逆性 | 代码可回滚；但若破坏 storageKey 造成会话丢失，用户体验损伤不可逆 |

**结论：本次只读预检风险 L1；任务整体风险等级 L3 确认。**

---

## 9. 待确认事项（供 GPT / Gemini 审查）

| # | 待确认 |
| --- | --- |
| Q1 | 采用方案 A、B 还是 A+C 组合？ |
| Q2 | 是否允许新增 UI 降级提示（方案 B 需要）？是否超出「不得扩大范围」约束？ |
| Q3 | 占位域名是否改为 `.invalid` 保留域名？ |
| Q4 | 「仅缺 Key」场景是否需要显式拦截（当前会向真实 URL 发 401 请求）？ |
| Q5 | 修复后是否需要补充最小回归验证（手动启动 + env 缺失模拟）？ |

---

## 附录：证据来源

- 源码：[`src/services/supabase.js`](../../../src/services/supabase.js:1)、[`src/hooks/useAuth.js`](../../../src/hooks/useAuth.js:1)、[`src/app/_layout.js`](../../../src/app/_layout.js:1)、[`src/hooks/usePushNotifications.js`](../../../src/hooks/usePushNotifications.js:1)、[`src/services/pushService.js`](../../../src/services/pushService.js:1)、[`src/hooks/chat/useSignedMediaUrl.js`](../../../src/hooks/chat/useSignedMediaUrl.js:115)、[`src/hooks/health/useTimeSync.js`](../../../src/hooks/health/useTimeSync.js:41)
- 命令：`rg`（调用方枚举）、`node -e`（URL 行为实测）、`git diff`（当前改动）
- 完整原始输出见 [`03_SOURCE_CONTEXT.txt`](03_SOURCE_CONTEXT.txt)
