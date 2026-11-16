# 05_GEMINI_REVIEW.md

## 1. 对 GPT 方案 (B-Lite) 的严格审查

GPT 提出的 B-Lite 方案（配置预检 -> 设为 null -> 根布局拦截）在架构思路上是非常直接且“防御性极强”的，但也包含一些需要严格论证的技术假设。

### 1.1 潜在的技术假设与风险判定
*   **假设：设 `supabase` 为 `null` 不会引发崩溃。**
    *   *判定*：**部分成立，存在遗漏风险**。根据源码上下文，28 个调用方都是在 Hook 或函数内部调用，模块顶层没有 `supabase.xxx()`。因此，静态 import 不会崩溃。**但是**，如果存在脱离 React 生命周期的后台任务（如原生推送回调、脱离组件树的全局定时器），它们可能会在 `RootLayout` 拦截生效前或独立于 UI 线程执行，从而抛出 `TypeError: Cannot read properties of null (reading 'from')`。
*   **假设：根布局拦截足以阻止所有业务调用。**
    *   *判定*：**对于 React 树完全成立**。在 `RootLayout` (`src/app/_layout.js`) 的最外层（或者在 Provider 挂载前）返回错误 UI，React 子树（包括所有的 `useAuth`, `useHealthData` 等 Hook）将**绝对不会挂载和执行**。这是一种极为有效的物理隔离。
*   **假设：Expo Router 允许在 Root 布局返回基础 View。**
    *   *判定*：**高危兼容性盲区，极易崩溃**。Expo Router 强制要求 Root Layout 必须渲染一个导航器（如 `<Slot />` 或 `<Stack />`）。如果在 `_layout.js` 顶层直接 `return <View><Text>Error</Text></View>;`，Expo Router 极大概率会抛出类似 `Error: Layout must render a Navigator` 或在深链接时崩溃。
*   **假设：修改范围控制在预期内。**
    *   *判定*：**成立**。只需修改 `supabase.js`（验证配置并导出 null）和 `_layout.js`（增加高阶拦截），不需要碰剩余的 28 个文件，也没有重构认证系统。

## 2. 对自身方案 (原子隔离沙盒方案) 的重新评估

在与 GPT 方案比对并结合具体业务逻辑（如 `RootNavigation` 路由守卫）后，我发现我之前的方案存在严重的**逻辑次生灾害与 UX 缺陷**。

*   **.invalid 域名是否真正零网络出站？**
    *   **否**。虽然 `.invalid` 不会解析到真实服务器，但底层 OS 仍然会发起 DNS 查询（NXDOMAIN）。虽然没有数据泄露，但并非绝对的“零请求”。
*   **异常配置下继续开启 `autoRefreshToken` 和 `persistSession` 的问题。**
    *   **存在脏数据 I/O 风险**。沙盒客户端会使用伪造的 `unconfigured-auth-token` 向 `SecureStore` 进行读写操作，虽然隔离了真实会话，但产生了无意义的垃圾文件/密钥条目，违背了“不产生副作用”的原则。
*   **业务 Provider 继续挂载引发的“静默灾难”。**
    *   **这是最致命的缺陷**。如果使用沙盒客户端，`AuthProvider` 会正常挂载。`getSession()` 拿到空数据，将 `user` 置为 `null`。随后，`RootNavigation` 中的路由守卫 `if (!user && !isPublicRoute) router.replace('/auth')` 会被触发。用户将看到**正常的登录界面**！当用户尝试登录时，请求会发往 `.invalid`，导致网络错误。这种“幽灵降级”会导致极其混乱的用户体验和极难排查的 Bug。
*   **401 导致会话清除的判断。**
    *   **完全正确**。Supabase (GoTrue) SDK 源码逻辑明确规定，在使用真实 `storageKey` 读取到有效 Refresh Token，但在后端校验返回 401 (Invalid/Revoked) 时，SDK 会为了安全自动调用 `removeItem` 清理本地存储。如果混用真实 URL 与假 Key，必然导致全体用户登出。

## 3. 两种方案对比

| 评估维度 | GPT 方案 (B-Lite 拦截) | Gemini 方案 (原子隔离沙盒) | 结论 |
| :--- | :--- | :--- | :--- |
| **安全性/数据完整性** | **极高**。彻底不实例化 SDK，没有任何存储或网络交互。 | **高**。通过假 Key 隔离，但仍有无意义的系统调用。 | GPT 胜 |
| **会话兼容性** | **完全兼容**。正常配置下逐字匹配；异常时直接切断，保护原数据。 | **完全兼容**。但异常时产生脏数据。 | GPT 胜 |
| **异常处理UX** | **极好**。明确的错误提示，用户/开发者第一时间知晓。 | **极差**。静默错误，引发错误的重定向与登录循环。 | GPT 胜 |
| **跨平台兼容性** | **未知**。依赖 Expo Router 对非导航器 Root UI 的容忍度。 | **高**。符合正常的 React Native 执行流。 | Gemini 胜 (待验证) |
| **修改范围** | 中（需改 2 个文件，涉及 UI 根节点）。 | **小**（仅改 1 个文件，零 UI 变动）。 | Gemini 胜 |

## 4. 接受及反对的技术决策

1.  **接受** GPT 的“**不构造 SDK (返回 null)**”以及“**根布局物理拦截**”思想。这是阻止 28 个模块及众多 Provider 产生副作用的最彻底、最安全的方式。
2.  **反对** GPT 在未验证 Expo Router 约束情况下的简单 UI 拦截。直接渲染基础 `<View>` 极可能引发新的路由崩溃。
3.  **反对** 自身先前的“沙盒客户端”方案，因为它会导致严重的 UI 逻辑异常（意外跳转登录页）。
4.  **接受** GPT 的“独立配置解析纯函数”提议，使得校验逻辑可被独立、安全地测试（Node.js `assert` 即可验证）。

## 5. 最终推荐方案：融合型安全拦截架构 (Guarded Null & Safe Router Fallback)

我提议融合双方优点，执行以下实施路径：

**1. 独立解析与严格校验 (`src/services/supabase.js`)**
*   提取纯解析逻辑（不直接读 env 宏，接收参数）。
*   校验规则：非空、非空白、合法 URL (`new URL` try/catch，限 `http:`/`https:`)、Host 提取有效。
*   如果无效：`export const supabase = null;`，不执行任何 SDK `createClient` 或 `SecureStoreAdapter`。
*   保持正常情况的 `AUTH_STORAGE_KEY` 逐字不变。

**2. 安全的 Expo Router 降级 (`src/app/_layout.js`)**
为了避免 Expo Router 报错，降级 UI **必须包含一个合法的占位导航器**，或者直接利用 Expo 默认的启动屏 (SplashScreen) 阻止挂载。

*修改策略*：
```javascript
// _layout.js 伪代码
import { isSupabaseConfigured } from '../services/supabase';
// ... 其他 import ...

export default function RootLayout() {
  if (!isSupabaseConfigured) {
    // 【关键融合点】：不渲染业务 Provider，但提供 Router 需要的基础结构
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
         <Text>系统配置异常：缺少环境变量。请检查配置后重启。</Text>
      </View>
    );
    // 注意：DeepSeek 必须在本地验证这种返回方式在当前版本的 Expo Router 中是否允许，
    // 若报错 "Must render Navigator"，则需要包裹在 <Stack><Stack.Screen name="error" /></Stack> 中。
  }

  // 正常分支，完全不动
  return (
    <ThemeProvider>
       {/* 所有的 AuthProvider 等子树 */}
    </ThemeProvider>
  );
}
```

## 6. 需要 DeepSeek 本地核验的具体事项 (T3-C 执行重点)

本方案的生死线在于以下几个假设，**必须由 DeepSeek 在本地沙盒中编写验证脚本并执行确认**：

1.  **Expo Router Root Fallback 兼容性**：在 `_layout.js` 导出的组件中，如果因为配置错误直接 `return <View>...</View>`，Expo Router (应用当前锁定的版本) 会正常渲染，还是直接抛出路由致命错误？如果抛错，需提供最小合规导航器包裹方案。
2.  **旁路任务检查 (Bypass Check)**：全局搜索是否在 `_layout.js` 挂载**之前**，或在某些独立的原生任务/后台注册中直接调用了 `supabase.xxxx()`？重点核查 `src/services/pushService.js` 等非 React 组件文件。如果存在，`null` 客户端会导致崩溃。
3.  **解析规则的边界测试**：在 Node 环境下调用抽离的 `parseSupabaseConfig` 纯函数，验证输入 `" "` (全空格)、`"ftp://a.b"`、`"abc"` 以及 `supabaseUrl=正常, key=undefined` 等边界条件，确认均返回配置无效。

## 7. 实施前阻塞条件 (Blockers)

*   **Blocker 1**: DeepSeek 必须输出明确的 Expo Router 根视图拦截测试结果。未经测试，不得修改 `_layout.js`。
*   **Blocker 2**: DeepSeek 必须全局确认无“脱离 React 生命周期的早期 `supabase` 方法调用”。
*   **Blocker 3**: 原则上不允许在 HF01 夹带 P0.1 其他未完成的重构特性。

## 8. 最终验收标准 (Acceptance Criteria 更新)

1.  **零副作用原则**：空/假环境变量启动时，`supabase.js` 中 `createClient` 调用的次数必须严格为 **0**。
2.  **断崖式拦截**：配置异常时，`AuthProvider` 及其包含的所有业务 Hook 均不得被实例化，控制台无 `getSession` 报错。
3.  **UI 明确性**：屏幕中心出现明确的中文配置异常提示，不发生白屏、闪退或进入无限 Loading/登录循环。
4.  **基线零偏移**：正常填入环境变量后，`AUTH_STORAGE_KEY` 字符严格等于修复前，旧用户直接保持登录态（必须经过本地模拟器验证，而非仅仅纸面推导）。
5.  **平台兼容**：修复必须在 Web (Node 验证即可)、iOS / Android (Expo Go 或原生构建沙盒测试) 环境下表现一致。