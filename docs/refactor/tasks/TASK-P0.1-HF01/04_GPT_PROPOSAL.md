# 04 — GPT 独立技术方案：TASK-P0.1-HF01

> 父任务：TASK-P0.1（建立开发基线）
> 阶段：T2（独立设计，未批准实施）
> 日期：2026-11-16
> 风险等级：L3
> 源码参照：main @ eec78801ff8fd0483e260c413d86756d19e3a911，含原有未提交 app.json、eas.json、src/services/supabase.js 改动及预检文档。
> 输入：01_TASK_BRIEF.md、02_PREFLIGHT_REPORT.md、03_SOURCE_CONTEXT.txt（HF01 版本）。
> 本文件不是 06_FINAL_PLAN.md，不构成修改、提交、推送、部署授权。

## 1. 目标与非目标

目标：在 Supabase URL 或客户端公开 Key 缺失或结构异常时，阻止 Supabase 客户端构造和业务初始化，提供不依赖后台的明确错误界面；配置正常时保持现有功能与会话存储命名空间不变。

非目标：不实现离线业务模式，不重构整个认证体系，不改变现有登录/退出流程，不处理 SecureStore 明文降级的历史技术债，不修复所有网络异常，不升级依赖，不修改 RLS 或数据库，不执行 P0.2。
本次检查针对本地配置的结构有效性，而非在线验证 Key 是否属于该项目、是否被撤销、服务是否可达。语法正确但错误的 URL/Key、凭证与项目不匹配、服务端 401、网络断开仍属独立运行时问题。不得把配置结构通过当作认证成功或任意服务端地址可信。

## 2. 独立源码审查

| 证据（原文件行号） | 判断 |
| --- | --- |
| supabase.js:8–28 | 读取静态 EXPO_PUBLIC 属性正确；ENV_MISSING 仅判断真假值，未覆盖空格及语法非法情况；配置标记未被使用。 |
| supabase.js:45–51 | 未经保护的 new URL 在模块初始化执行；已确认为直接根因。正常分支的 storageKey 算法和 toSecureKey 必须保持不变。 |
| supabase.js:63–109 | 现有适配器会迁移、写入、删除会话；异常分支必须完全不调用它，不仅是换一个 key。正常分支不改。 |
| supabase.js:111–124 | URL 与 Key 分别回退，可形成真实 URL + 假 Key 或假 URL + 真 Key。必须整体判定，不允许部分有效时创建真实/占位 client。 |
| useAuth.js:12–28 | Provider 挂载立即执行 getSession 与 onAuthStateChange；getSession 的 Promise 链未显式 catch。并非所有函数内错误都已有处理。 |
| _layout.js:16–44、62–76 | 根布局提供全局业务 Provider；RootNavigation 还有推送 hook 和路由守卫。错误 UI 应在这些 Provider 与导航逻辑之外。 |
| 03_SOURCE_CONTEXT §5、§8 | 调用方枚举表并不完全一致：pushService、InteractiveMediaViewer 出现在调用计数/报告中但不在原 import 清单中；搜索不足以证明无间接调用。必须补查。 |

纠正预检报告：
- “仅缺 Key 时不会泄露数据”和“业务请求只能在认证后发出”均缺乏充分证据。有效 URL 的 storageKey 仍可访问旧会话，不能仅凭占位 Key 假定无认证副作用。
- GoTrue 初始化不只由 React useEffect 决定。按 Supabase 官方说明，构造客户端可以自动初始化认证并读取会话（需以本地安装版本核验具体行为）。
- .invalid 是有利的防御性保留域名，但不等于没有请求尝试、没有网络副作用、没有本地会话访问。
- Node URL 实测仅验证 Node，不等于已验证 Hermes、URL polyfill、Expo Go 或原生构建，也不能证明任何异常都只表现为白屏。
- 更换 storageKey 的影响主要是原会话不可见、可能需要重新登录；不是已证实的物理数据丢失。仍必须严格兼容。

## 3. 备选设计及决策

| 方案 | 成本 | 安全与兼容性 | 决策 |
| --- | --- | --- | --- |
| A：URL try/catch 及 key 兜底 | 低 | 仍可能构造带错误参数的真实或占位客户端；无法阻止认证初始化和业务挂载 | 拒绝 |
| A+C：A 加 .invalid 地址 | 低 | 减少占位域名风险，不能保证零请求、零认证持久化；不解决仅缺 Key 时的真实 URL 情况 | 拒绝 |
| B：null client + 所有调用点守卫 | 高 | 可实现安全退化，但触及大量模块，回归风险大，超出本次需求 | 暂不采用 |
| B-Lite：配置解析 + 有条件构造 + 根布局拦截 | 低至中 | 在无旁路和路由兼容性得到验证的前提下，零客户端构造、零认证读写；正常分支最小改动 | 推荐（有条件） |

不采用复杂 Proxy 或模拟全套 Supabase API：容易隐藏未覆盖的调用、改变链式 API 与错误语义，并扩大测试范围。也不为了避免 null 而构造虚假 SDK 客户端。

## 4. 目标架构及契约

### 4.1 配置解析（同步、纯逻辑）
- 保留入口处静态 `process.env.EXPO_PUBLIC_SUPABASE_URL` / `process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY` 写法，交给解析函数的参数是已读取的值，不使用动态属性或解构读取 env。
- 验证 URL、Key 是非空字符串且不是纯空白；URL 解析必须受 try/catch 保护，协议限制 HTTP/HTTPS，hostname 必须非空。拒绝含 URL 用户名/密码的配置；对 query/hash、路径、首尾空白和明确模板占位值的规则，以现有合法配置与本地 SDK 支持情况为准，在最终方案明确政策。不能无依据限制为 *.supabase.co 或 JWT 格式，避免破坏自定义域、本地开发和新 publishable key 格式。
- 不打印原始 URL、Key、凭据或可能包含它们的原始异常。错误分类使用固定代码：MISSING_URL / INVALID_URL / MISSING_KEY / INVALID_KEY 等，可合并展示。
- 正常配置保留原传入值及原 storageKey 的逐字节结果 `sb-${parsed.hostname.split('.')[0]}-auth-token`，不自行改变路径、域或端口的命名规则。
- 结构有效不表示 Key 已验证或服务器可信；错误分类、边界及假值采用合成测试数据。疑似服务端 secret/service_role 配置另按安全规范阻断与报告，不读取或输出真实凭据。
- 失败结果不含可供网络连接的假 URL、假 Key、假 storageKey。可以返回状态和原因；不要把真实 Key 放入公开的 UI 状态。

### 4.2 客户端初始化
- 保留 `supabase` 具名导出；有效配置才调用一次现有 createClient，保持 SecureStoreAdapter、storageKey、autoRefreshToken / persistSession / detectSessionInUrl 原参数。
- 配置不合格时 `supabase` 为 null；`isSupabaseConfigured` 应准确反映是否具备使用条件（如同时考虑同步构造成功，文档明确含义），不得沿用两个变量仅 truthy 的判断。
- 移除现有 FALLBACK_URL / FALLBACK_KEY 以及误导注释。异常分支不得 invoke SDK 构造器、SecureStoreAdapter、Auth 初始化、Realtime 或网络请求。
- 对 createClient 同步构造抛错：先由本地版本核验初始化顺序；可对确定的同步配置构造异常提供脱敏错误状态，禁止无限重试或用默认 client 代替。不得声称 try/catch 可撤销已发生的 SDK 副作用或捕获异步错误；如果构造后部分初始化可能泄露或访问会话，应停止并重新评估。未知 SDK 或运行时故障不得被悄悄吞掉。
- 不调整正常上线实例生命周期、登录恢复、存储读写或网络请求行为。

### 4.3 根布局降级
- RootLayout 依据配置/客户端就绪结果选择正常 JSX 或独立配置错误界面。
- 异常分支必须在 AuthProvider、HealthProvider、CinemaProvider、BrowserSessionProvider、RootNavigation、FloatingPlayer、正常业务页面与推送 hook 的挂载之前终止。
- 使用基础 React Native View/Text（可配合系统颜色或已证明无业务副作用的 ThemeProvider），无需主题重构、网络、认证、导航或业务 Context。界面明确“应用配置异常，暂时无法连接服务。请联系维护者或检查构建环境后重新启动”，不提供收集凭证输入，不显示真实值。
- 不用 router.replace('/auth')、自动重试、白屏或伪造登录成功来处理无配置状态。
- 注意：JS 静态 import 仍会求值；根布局拦截只阻止 React 子树挂载，不阻止路由文件、模块顶层、后台任务、原生初始化。必须事前检查直接、间接、重导出、动态加载和任务入口，包括其他 EXPO_PUBLIC_SUPABASE_URL 使用点、直接 fetch、通知/深链接。若存在旁路，记录并提出最小边界调整，未批准不能直接改调用方。
- Expo Router 对首屏无 navigator 时的导航事件有约束。必须在本地锁定版本验证普通冷启动、外部深链接、通知点击、启动页消失以及恢复进程。若根布局静态错误分支不受支持，提交独立的受保护导航容器/专用错误入口方案；不得通过挂载正常 Stack 后再跳转使业务页面提前运行，不得擅自迁移整个路由目录。

## 5. 预计修改边界

| 文件 | 改动 |
| --- | --- |
| src/services/supabase.js | 必要：配置校验、会话 key 安全计算、创建条件、状态导出与注释 |
| src/app/_layout.js | 必要：配置门禁与轻量错误界面，正常 JSX 不变 |
| src/services/supabaseConfig.js | 可选：独立纯解析函数，便于无依赖测试；名称须本地确认 |
| 独立测试文件或本地验证材料 | 可选：已批准位置的 Node 内置断言脚本、运行验证记录；无需安装新依赖 |
| src/hooks/useAuth.js | 原则上不改，仅验证未挂载和正常分支；如无法实现目标须重新审批 |
| app.json / eas.json | 保留原有未提交改动，不纳入 HF01 新修改 |
| 其他业务、数据库、依赖文件、主题、CI | 禁止修改 |

守住原有工程三条约束：colors.js 色值、theme.js SIZES/TYPOGRAPHY、ThemeContext.js 对外 API 不改；不重写现有 Git 工作，不清除用户会话和缓存。

## 6. T3-C 实施前核验（必须）
1. 确认当前 HEAD、三个初始改动、暂存区、文档状态，与预检差异单独记录，不覆盖旧工作。若状态改变，更新源码证据。
2. 完整枚举所有 supabase 导入、别名、重导出、访问、直接请求、任务注册与路由模块 import/evaluation；补齐报告中遗漏文件。逐处区分模块求值与组件/effect/回调执行。
3. 检查本地锁定 SDK / auth SDK / URL polyfill 实现的 URL 验证、构造初始化、storageKey 规则；核验 Expo Router 对异常根布局、外部事件和路由预加载的支持。
4. 检查启动页控制、通知响应、任务入口及 ThemeProvider 副作用（若复用）。明确隔离实验所需的构建/测试方式和平台能力。
5. 给出上述证据及剩余风险，回复 T3_VERIFICATION.md；若隔离不能成立、正常配置兼容性不明或无法建立验证条件，停止，待 GPT 整合和负责人裁决。
6. Gemini 首轮只接收原始三份材料，独立分析；第二轮接收本方案，出 05_GEMINI_REVIEW.md。DeepSeek 事实核验后，由 GPT 输出 06_FINAL_PLAN.md，负责人明确批准。

## 7. 拟实施顺序（待 T3-D 及人工批准）
- 第 1 批：保存并核对初始差异，建立不含真实凭据的验证样例；先建立可复现的失败测试或断言。
- 第 2 批：实现解析与条件构造，验证正常 SDK 参数和旧 key，验证异常配置的 SDK 构造调用次数为零。
- 第 3 批：在同一个变更批次完成 UI 根门禁；禁止在只改为 null 尚未加入门禁的中间状态启动或合并。
- 第 4 批：验证 Provider 未挂载、配置错误可见、无认证读写或请求、深链接/通知无旁路，再验证正常业务。
- 第 5 批：采集完整任务差异、测试报告，GPT 与 Gemini 分别审查后修复并回归。未解决阻塞项不得提交。
- 第 6 批：负责人验收 HF01；另行恢复 P0.1，重新确认原三文件加已批准修复的提交范围、检查结果与实际冻结 SHA；原先推动三个文件的授权不自动覆盖新增文件。

## 8. 测试与验收矩阵

| 场景 | 期望 |
| --- | --- |
| 正常项目 URL + 公开 Key（测试账号/隔离环境） | SDK 仅正常构造，原 storageKey 逐字节一致，启动与登录/恢复/退出功能正常 |
| 正常 URL 有无尾斜杠、受支持自定义域/本地开发 | 规则兼容、原 key 一致；只使用经确认的有效场景 |
| URL 缺失、null（纯函数）、空串、纯空白、无 scheme、不可解析 | 不构造 SDK，错误 UI 可见 |
| 非 HTTP/HTTPS、无 hostname、内嵌用户信息、明确错误模板 | 按最终确认规则拒绝，不构造 SDK |
| 仅缺 Key / 空 Key / 纯空白 Key（URL 正常） | 不构造 SDK，不向真实 URL 发请求 |
| 仅缺 URL（Key 存在） / 两项均缺 | 不构造 SDK，不向任何占位服务器发请求 |
| 预置合成旧会话 + 异常配置 | Auth 相关存储读取/写入/删除/迁移均为 0；网络请求和 Realtime 连接均为 0 |
| 恢复正确配置 | 原会话仍可读取；不会因为异常配置主动登出或删除原会话 |
| 错误态深链接、通知点击、后台恢复、路由预加载 | 错误界面不被绕过；无正常业务挂载，无导航器未挂载异常 |
| 同步构造异常 | 按经核验的错误策略处理，禁止 fallback；未知风险单独列明 |
| 配置有效但断网、服务超时或 Key 被撤销 | 不宣称已解决所有运行时错误；验证没有相较原行为新增回归，记录现有缺陷 |
| 静态检查 | tsc 退出码 0（不等于严格 TS/构建）；lint 不新增具体诊断，记录完整输出与真实退出码；锁文件无变化 |

最低证据要求：
- 使用 Node 内置 assert 等验证纯配置逻辑；记录参数/模拟调用次数。仅 Node 测试不能证明 RN 或原生构建的行为。
- 模拟/隔离环境验证配置失败时 SDK 构造、认证存储操作、fetch/WebSocket 和业务初始化没有发生；记录观测范围。不能仅依赖“没有日志”或 DNS 失败推断零调用。
- 使用合成会话、专用测试账号或隔离设备；不得删除真实用户会话、修改生产配置或提交真实 .env。
- 缺 env 测试在隔离构建/进程中进行，避免热更新或旧 bundle 内联值干扰。Expo 支持 EXPO_NO_DOTENV；核查 shell 环境、构建环境和缓存，不能用修改生产 .env 作为默认方式。
- Expo Go：至少正常/缺 URL/缺 Key/非法 URL 冷启动及错误 UI。Android / iOS 原生构建：同样检查，附运行日志/截图（脱敏）；至少覆盖当前可用发布目标，未测平台明确标为未验证，不能宣称双端完全通过。若无法执行关键启动与无副作用验证，状态为阻塞或待验收，而非通过。
- 正常业务回归：登录、已有会话启动、退出、账号切换；聊天、健康、影院、推送的最小 smoke test（无需建立全套测试框架）。iOS/Android 的具体权限与推送测试在环境支持时进行。
- 保持现有主题 API、SQL、依赖与原始三个用户改动不变（除 supabase.js 经批准的增量修复）。
- 记录真实 Git Diff，包括新增文件；区分原始 WIP 和任务差异，不能将 git diff HEAD 全部视作 HF01 新改动。

## 9. 风险与回滚
- 最高风险：正常 storageKey 改变、错误分支误挂载业务、模块顶层调用/后台入口绕过门禁、路由初始化要求被违反。
- 不采用 reset --hard、git clean 或全文件 checkout 覆盖已有未提交代码。实施前保存用户原始差异/文件快照于受控本地位置，经核验不含密钥；必要时使用单独的增量补丁反向撤回本任务变更。
- 回滚后核对三个原始 WIP、暂存区及文档，恢复到实施前实际状态，不仅是 HEAD。回滚代码不能逆转已发生的账号/存储副作用，因而必须前置隔离。
- 禁止在尚未完成验收时 push、tag、EAS 构建发布/OTA 部署或数据库变更；必要的隔离构建验证须按权限另行批准。

## 10. 五个待确认事项的 GPT 建议
1. A/B/A+C：B-Lite 优先，有条件推荐。
2. 明确错误 UI：需要，限定异常分支新增轻量提示，正常 UI 不动；由负责人批准。
3. 占位域名：删除占位客户端及域名，不需要 .invalid 作为运行时 fallback。
4. 仅缺 Key：必须同样阻止 SDK 构造，不允许真实 URL + 假 Key。
5. 最小回归：必须执行；不强制引入 Jest/Vitest。

## 11. 参考与限制
本方案以用户提供的 HF01 三份文件为依据，未在本地真实 Expo 项目编译或运行，未亲自执行 DeepSeek 报告中的测试；查看了以下官方接口文档（并非锁定版本源码验证）：
- Supabase JS 初始化：https://supabase.com/docs/reference/javascript/initializing
- Supabase Auth 自动初始化：https://supabase.com/docs/reference/javascript/auth-initialize
- Expo Router 导航器挂载约束：https://docs.expo.dev/router/advanced/authentication-rewrites/
- Expo 环境变量静态内联与加载：https://docs.expo.dev/guides/environment-variables/

尚未获得完整调用方代码、实际锁定依赖实现、设备运行结果。任何“零副作用”“无需修改全部调用点”的判断须经 T3-C 与 T4/T6 测试证实。当前结论：建议进入 Gemini 独立审查，不建议直接实施。
