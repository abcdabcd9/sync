# T3-C 本地事实核验报告（TASK-P0.1-HF01）

> 角色：DeepSeek（本地事实核验）
> 任务：对 GPT 方案（04_GPT_PROPOSAL.md，B-Lite）与 Gemini 审查（05_GEMINI_REVIEW.md，"Guarded Null & Safe Router Fallback"）中的 5 个关键论点做**基于真实源码与可复现实验**的核验。
> 性质：只读核验。未修改任何业务源码、未安装依赖、未操作数据库、未提交/推送。
> 基线：HEAD = `eec7880`；工作区仅 `app.json` / `eas.json` / `src/services/supabase.js` 三处既有改动 + 未跟踪的 `docs/refactor/`。
> 核验环境：Node v24.21.0；expo-router 58.0.28；@supabase/auth-js 2.118.0（与 `@supabase/supabase-js` 2.118.0 同版本）。

---

## 0. 结论速览

| # | 核验问题 | 结论 | 是否阻断 |
|---|---------|------|---------|
| Q1 | RootLayout 能否直接返回错误 View（不渲染 Navigator） | **可以**。根布局被当作普通 screen 组件渲染，无"必须渲染 Navigator"断言 | 否（Gemini Blocker 1 不成立） |
| Q2 | 是否存在绕过 RootLayout/Providers 的 Supabase 调用 | **不存在**。无后台任务、无模块顶层调用、无全局监听；28 个导入方全部挂在 Providers 之下 | 否（Gemini Blocker 2 不成立） |
| Q3 | 配置校验能否正确处理 5 类异常输入 | **可以**，但需显式 trim + 协议白名单 + hostname/凭据校验；`http:` 会被放行（需确认是否接受） | 否（有实现细节需锁定） |
| Q4 | Auth SDK 在 401 刷新时是否清除持久化会话 | **有条件清除**：access_token 仍有效→保留；access_token 已过期→`_removeSession()` 清除 | 否（但决定占位客户端风险等级） |
| Q5 | storageKey 正常态字节一致 + 异常态零副作用 | **可保证**。正常态 storageKey 逐字节一致；异常态若 `supabase=null` 则无 client/无存储 IO/无网络 | 否（推荐方案可满足） |

**总体判断**：GPT 的 B-Lite 方案在技术上成立；Gemini 提出的两个 Blocker 经源码核验**均不成立**，但其"Safe Router Fallback"作为防御性加固仍有价值（非必需）。推荐采用 **B-Lite + 根布局早返回错误 UI**，无需在错误分支内渲染 `<Slot>`/`<Stack>`。

---

## 1. Q1：RootLayout 能否直接返回错误 View？

### 结论
**可以。** 当前 expo-router 58.0.28 **没有**"根布局必须渲染 Navigator"的运行时断言。根布局组件被注册为内部 Stack 的一个 `Screen`，通过 `descriptors[...].render()` 直接渲染其返回值。返回一个普通 `<View>` 是合法的。

### 证据（真实源码）
`node_modules/expo-router/build/ExpoRoot.js`：
- L174-180：`Content` 把 `rootComponent` 注册为 `INTERNAL_SLOT_NAME` 的 `Screen`：
  ```js
  const children = [ jsx(Screen, { name: INTERNAL_SLOT_NAME, component: rootComponent }, "SLOT") ];
  ```
- L193-202：用 `StackRouter` 构建导航，并**直接渲染当前 route 的组件**：
  ```js
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children, id: INTERNAL_SLOT_NAME });
  return jsx(NavigationContent, { children: descriptors[state.routes[state.index].key].render() });
  ```

`node_modules/expo-router/build/useScreens.js`：
- L249-287：`getQualifiedRouteComponent` 把路由模块的 `default` 直接包成 `ScreenComponent` 渲染，**不检查返回值是否为 Navigator**。
- L329-339：仅当路由被 guard 拦截时渲染 `Redirect` 或 `AllRoutesProtectedWarning`，与"是否 Navigator"无关。

### 关于 Gemini 的 "Layout must render a Navigator"
- 全仓检索 `must render a Navigator` / `Layout children must` 等字样，**唯一相关**的是 `withLayoutContext.js:83`：
  ```js
  console.warn(`Layout children must be of type Screen, all other children are ignored. ...`);
  ```
  该警告针对的是**在 `<Stack>`/`<Tabs>` 内部**传入非 `Screen` 子元素的情况，**与根布局自身返回什么无关**。根布局返回 `<View>` 不会触发它（因为根布局本身不是 `withLayoutContext` 包装的 Navigator）。

### 对方案的影响
- GPT 的"根布局早返回错误 UI"**可行**，无需 Gemini 建议的 `<Slot>` 兜底。
- Gemini 的 "Safe Router Fallback"（错误分支内仍渲染 `<Slot>` 再叠加覆盖层）**非必需**；若采用反而增加复杂度与"空导航器"副作用，不建议。
- 建议：错误分支直接 `return <ConfigErrorView />`（纯 `View`/`Text`），在 `RootLayout` 顶层、任何 Provider 之前判断。

---

## 2. Q2：是否存在绕过 RootLayout/Providers 的 Supabase 调用？

### 结论
**不存在。** 所有 Supabase 访问都发生在 React 组件/hook 内部，且这些组件全部挂载在 `RootLayout` 的 Provider 树之下。无后台任务、无模块顶层调用、无全局（模块级）监听。

### 证据
1. **入口**：`package.json` `"main": "expo-router/entry"`；无自定义 `index.js`/`AppRegistry`/`registerRootComponent`。入口不直接 import supabase。
2. **无后台任务**：检索 `TaskManager|registerTaskAsync|BackgroundFetch|expo-background|expo-task-manager` → **0 命中**。
3. **无模块顶层调用**：检索 `^supabase\.|^await supabase\.` → **0 命中**；`src/services/supabase.js` 顶层只有 `createClient` 赋值（L111），无 `.from/.auth/.channel` 调用。
4. **AppState 监听均在 hook/组件内**：
   - `src/hooks/useCinema.js:202`
   - `src/hooks/useHealthData.js:213`
   - `src/components/ChatInputBar.js:248`
   三者都是 hook/组件体，随 Provider 树挂载。
5. **28 个导入方全部在 Providers 之下**：
   - `usePushNotifications` 仅在 `src/app/_layout.js:26`（`RootNavigation` 内）调用；
   - `CustomTabBar` 仅在 `src/app/(tabs)/_layout.js:8` 挂载（`(tabs)` 在 RootLayout 之下）；
   - 其余均为 `src/hooks/**`、`src/components/**`、`src/app/**` 屏幕，全部位于 `RootLayout` 子树。
6. **Realtime 订阅**（`useSyncRoom`、`useChatMessages`、`useChatList`、`useHealthCloud`、`CustomTabBar`）均在 `useEffect` 内创建并在 cleanup 中 `removeChannel`，属组件生命周期。

### 对方案的影响
- 只要在 `RootLayout` 顶层、**任何 Provider 之前**短路返回错误 UI，即可保证异常态下**没有任何** Supabase 调用发生。
- Gemini Blocker 2（"存在绕过路径"）**不成立**。

---

## 3. Q3：配置校验对 5 类异常输入的处理

### 实验
纯 Node 脚本（`/tmp/t3c_verify/q3_validate.js`，未触碰业务源码），模拟推荐校验逻辑：`trim` → 空判 → `new URL` try/catch → 协议白名单（http/https）→ hostname 非空 → 拒绝内嵌凭据。

### 结果
| 输入 | ok | errors | storageKey |
|------|----|--------|-----------|
| `undefined/undefined` | false | MISSING_URL, MISSING_KEY | null |
| `null/null` | false | MISSING_URL, MISSING_KEY | null |
| `''/''` | false | MISSING_URL, MISSING_KEY | null |
| `'   '/'  '`（空白） | false | MISSING_URL, MISSING_KEY | null |
| 合法 URL / 空 Key | false | MISSING_KEY | sb-abc-auth-token |
| 合法 URL / 空白 Key | false | MISSING_KEY | sb-abc-auth-token |
| 无 scheme（`abc.supabase.co`） | false | INVALID_URL | null |
| `ftp://` | false | INVALID_PROTOCOL | sb-abc-auth-token |
| `http://` | **true** | — | sb-abc-auth-token |
| 合法 `https://` | true | — | sb-pjiyniqtrstcpnodsnqq-auth-token |
| 含凭据 `user:pass@` | false | INVALID_URL | sb-abc-auth-token |
| 前后空格 | true | — | sb-abc-auth-token |
| 带路径 `/rest/v1` | true | — | sb-abc-auth-token |

### 结论与注意点
- 5 类异常（缺失 URL、缺失 Key、空白串、无效 URL、无效协议）**均可被正确识别并拒绝**，前提是显式 `trim()` 且做协议白名单。
- **`http:` 会被放行**（因白名单含 http）。Supabase 生产 URL 恒为 `https:`；若安全要求更严，可只允许 `https:`。**需项目负责人确认**是否接受 `http:`（本地自建 Supabase 可能用 http）。
- 带路径/端口/前后空格的合法 URL 均能正确提取 hostname 首段，storageKey 不受影响。
- 校验必须是**纯同步、无副作用**函数，且失败时**不得**返回任何伪造 URL/Key/storageKey（与 GPT 4.1 一致）。

---

## 4. Q4：Auth SDK 在 401 刷新时是否清除持久化会话？

### 结论
**有条件清除**，并非"一律清除"。判定依据是**刷新失败时 access_token 是否仍然有效**：
- access_token **仍有效**（proactive 刷新失败）→ **保留**会话，不登出。
- access_token **已过期**（reactive，refresh_token 被拒）→ 调用 `_removeSession()` → **清除**持久化会话并广播 `SIGNED_OUT`。

### 证据（`@supabase/auth-js` 2.118.0，`dist/main/GoTrueClient.js`）
- `_callRefreshToken` catch 分支 L4295-4330：
  ```js
  if (!isAuthRetryableFetchError(error)) {
    const storedNow = await getItemAsync(this.storage, this.storageKey);
    const accessTokenStillValid = !!(storedNow?.expires_at && storedNow.expires_at * 1000 > Date.now());
    if (accessTokenStillValid) {
      // proactive refresh failed, access token still valid — preserving session
    } else {
      await this._removeSession();   // ← 真正清除
    }
  }
  ```
- `_removeSession` L4421-4439：`removeItemAsync(storage, storageKey)` + 移除 `-user` + `removeAllPKCEVerifiers` + 广播 `SIGNED_OUT`。
- `_recoverAndRefresh` L4119-4124：启动时若存储会话结构非法，也会 `_removeSession()`。
- `__loadSession` L2523-2530：`getSession()` 读到非法会话同样 `_removeSession()`。

### 对占位客户端风险的意义
- 若异常态仍创建"占位 client"并挂载 `AuthProvider`，则 `getSession()`/`onAuthStateChange()` 会触发 `_initialize → _recoverAndRefresh`：
  - 读取 `storageKey`（**存储 IO**）；
  - 若存在旧会话且 access_token 已过期 → 向占位域名发 `/token` 刷新（**网络**）→ 失败 → **`_removeSession()` 清除真实用户会话**。
- 即：**占位客户端会污染/清除真实登录态**，这正是必须"异常态不创建 client"的硬理由（与 GPT 4.2、Gemini 一致）。

---

## 5. Q5：storageKey 字节一致 + 异常态零副作用

### 5.1 正常态 storageKey 逐字节一致
实验（`/tmp/t3c_verify/q5_storagekey.js`）对比"当前实现"与"推荐实现（先 trim 再 new URL）"：

| URL | 当前 | 推荐 | 一致 |
|-----|------|------|------|
| `https://pjiyniqtrstcpnodsnqq.supabase.co` | sb-pjiyniqtrstcpnodsnqq-auth-token | 同 | ✅ |
| `https://abc.supabase.co` | sb-abc-auth-token | 同 | ✅ |
| `https://my-project-ref.supabase.co` | sb-my-project-ref-auth-token | 同 | ✅ |
| `https://abc.supabase.co/rest/v1` | sb-abc-auth-token | 同 | ✅ |
| `https://abc.supabase.co:5432` | sb-abc-auth-token | 同 | ✅ |

**结论**：只要正常态 URL 合法，`trim` 不改变 hostname，storageKey 与现状**完全一致**，不会导致已登录用户被登出。

### 5.2 异常态零副作用（需 `supabase = null`）
- `createClient` **构造阶段**本身不做网络/存储 IO（`GoTrueClient` 构造函数 L240-284 仅赋值 `this.storage` 等）。
- 但 `AuthProvider` 挂载即调用 `getSession()`/`onAuthStateChange()`，触发 `_initialize → _recoverAndRefresh` → **存储读 + 可能网络刷新**（见 Q4）。
- 因此"异常态零副作用"的**充要条件**是：异常分支**根本不创建 client**（`supabase = null`），且 `RootLayout` 在 Provider 之前短路，使 `AuthProvider` 不挂载。
- 满足上述两点时：无 client 实例、无 SecureStore/AsyncStorage 读写、无网络请求。**可保证。**

---

## 6. 剩余风险与阻断项

### 阻断项（Blockers）
- **无。** 5 项核验均未发现阻断推荐方案成立的硬性障碍。

### 剩余风险（需在实现/验收阶段处理）
| 编号 | 风险 | 等级 | 处置 |
|------|------|------|------|
| R1 | `http:` 是否放行未定 | 低 | 实现前由负责人确认；默认建议仅 `https:`，或显式允许 http 并注释用途 |
| R2 | 28 个导入方在异常态拿到 `supabase = null`，若某处未判空会在**运行期**抛 `Cannot read properties of null` | 中 | 因 RootLayout 早返回，正常路径不会挂载这些组件；但需回归确认无"Provider 外"调用（Q2 已证无）。仍建议在 `supabase.js` 导出 `isSupabaseConfigured` 并在关键入口判空 |
| R3 | `isSupabaseConfigured` 当前 **0 消费者**（死代码） | 低 | 实现时保留并确保语义准确（`=== true` 仅当校验通过） |
| R4 | 错误 UI 文案/多语言 | 低 | 用基础 `View/Text`，文案"应用配置异常，暂时无法连接服务" |
| R5 | 无法在真机/Expo Go 实测（本任务只读，未启动 App） | 中 | 标记为**未验证**，留待实现后回归（见第 8 节） |

### 明确"未验证"项
- 真机/模拟器上"异常态根布局返回 View 的实际渲染效果"——**未实测**（只读任务，未运行 App）。源码层面已证合法，但视觉/交互需实现后回归。
- Expo Go 与 development build 的差异——**未实测**。

---

## 7. 推荐最终实现（B-Lite + 根布局早返回）

### 7.1 `src/services/supabase.js`
1. 新增**纯同步** `parseSupabaseConfig(url, key)`：
   - `trim` → 空判（MISSING_URL / MISSING_KEY）；
   - `new URL` try/catch（INVALID_URL）；
   - 协议白名单（INVALID_PROTOCOL，默认 https，http 待定）；
   - hostname 非空、拒绝内嵌凭据（INVALID_URL）；
   - 成功时返回 `{ ok:true, url, key, storageKey }`，`storageKey = sb-${hostname.split('.')[0]}-auth-token`（与现状逐字节一致）；
   - 失败时返回 `{ ok:false, errors }`，**不含**任何伪造 URL/Key/storageKey。
2. 顶层：
   ```js
   const cfg = parseSupabaseConfig(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
   export const isSupabaseConfigured = cfg.ok;
   export const supabaseConfigErrors = cfg.ok ? [] : cfg.errors;
   export const supabase = cfg.ok ? createClient(cfg.url, cfg.key, { auth: { storage: SecureStoreAdapter, storageKey: cfg.storageKey, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } }) : null;
   ```
3. 删除 `FALLBACK_URL` / `FALLBACK_KEY` 及误导性注释；`SecureStoreAdapter` 保留（仅正常态使用）。

### 7.2 `src/app/_layout.js`
- `RootLayout` 顶层、**任何 Provider 之前**：
  ```js
  if (!isSupabaseConfigured) return <ConfigErrorView errors={supabaseConfigErrors} />;
  ```
- `ConfigErrorView` 用基础 `View/Text`，不依赖任何 Provider/导航。
- 正常分支保持现有 Provider 树不变。

### 7.3 不改动
- 不改 `AUTH_STORAGE_KEY` 规则、不改 SecureStoreAdapter 行为、不改任何业务 hook/屏幕。

---

## 8. 预期改动文件

| 文件 | 改动 |
|------|------|
| `src/services/supabase.js` | 新增配置解析；条件化 `createClient`；`supabase` 可为 `null`；删除 FALLBACK；`isSupabaseConfigured` 语义化 |
| `src/app/_layout.js` | 顶层早返回 `ConfigErrorView`（Provider 之前） |
| （可选）`src/components/ConfigErrorView.js` | 新增纯展示组件（或内联于 `_layout.js`） |

> 不涉及：`useAuth.js`、`useHealthData.js`、`useCinema.js`、`BrowserSessionContext.js`、`FloatingPlayer.js`、`usePushNotifications.js` 等（因异常态不挂载）。

---

## 9. 必要回归测试（实现后执行）

### 9.1 正常态（配置齐全且合法）
- [ ] App 正常启动，登录态**保持**（storageKey 未变，不触发重新登录）。
- [ ] `supabase` 非 null；`isSupabaseConfigured === true`。
- [ ] 聊天/健康/放映厅/推送等既有功能无回归。

### 9.2 异常态（缺失/空白/无效 URL/无效协议/仅缺 Key）
- [ ] App **不崩溃**，显示 `ConfigErrorView`。
- [ ] 控制台无 `TypeError: Invalid URL`。
- [ ] **无** SecureStore/AsyncStorage 读写（可加临时日志验证）。
- [ ] **无** 任何网络请求（占位域名不出现）。
- [ ] 已登录用户的持久化会话**未被清除**（重启后恢复配置仍保持登录）。

### 9.3 边界
- [ ] URL 前后空格、带路径、带端口 → 正常启动且 storageKey 正确。
- [ ] `http:` 行为符合最终决策（放行或拒绝）。

### 9.4 静态检查
- [ ] `npx tsc --noEmit` 0 error。
- [ ] `npx expo lint` 不新增 error（基线 144 problems / 119 errors / 25 warnings）。

---

## 10. 声明
- 本报告所有结论均基于**真实源码行号**与**可复现实验**；未修改业务源码、未安装依赖、未操作数据库、未提交/推送。
- 未包含任何密钥、令牌或用户隐私数据。
- 标记为"未验证"的项（真机渲染、Expo Go 差异）需在实现后回归确认。
- 完成后停止，等待项目负责人最终批准。
