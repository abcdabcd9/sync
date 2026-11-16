# 06_FINAL_PLAN — TASK-P0.1-HF01
> Supabase 启动防御修复 | T3-D 最终技术方案 | 2026-11-16
> 风险 L3；父任务 P0.1 暂停。状态：待负责人批准，不代表已实施或已通过运行验收。
> 基线：HEAD eec78801ff8fd0483e260c413d86756d19e3a911；原有 app.json、eas.json、src/services/supabase.js 三处未提交修改，另有 docs/refactor/。
> 依据：任务简报、T1 源码上下文、GPT T2、Gemini T3-A/B、T3_VERIFICATION.md（以下简称核验报告）。

## 1. 决策与证据边界
采用 B-Lite / Guarded Null + RootLayout 提前拦截。不创建占位 SDK，不逐个重写现有调用点。
- 接受 Gemini 对配置原子隔离及会话保护的要求；拒绝占位域名、伪造 storageKey 及异常态持久化。
- 核验报告 §1 显示 expo-router 58.0.28 根布局普通 View 不存在所述强制断言；这只是静态可行性，冷启动、深链接、通知、SplashScreen 仍需实测。暂不增加 Slot/Stack 或永久启动屏。
- 核验报告 §2 未发现旁路调用；其正则与文件枚举不是穷尽证明。实施前快速复查顶层初始化、模块别名、间接调用和后台入口，发现实际绕过路径即停止报告，不盲目扩展守卫。
- 核验报告 §4：锁定 Auth SDK 2.118.0 的非可重试刷新失败清除会话有条件（访问令牌过期等），不是所有 401 或所有用户必然登出。不要用真实 token 验证。
- §5 对 SDK 构造阶段无 IO 的说法不作为保证；只阅读构造部分不足以排除其自动启动初始化。异常分支绝不调用 createClient，因而无需依赖该假设。
- §3 的实验原型在若干失败分支仍返回 storageKey；最终实现必须纠正，失败仅返回错误码，不返回可用连接参数或 storageKey。
- 未独立运行项目、未验证 SDK 在设备中的实际行为。格式通过不等于服务地址正确、Key 真实有效或后端可用。本任务不做联网凭据验证。

## 2. 修改范围（仅以下生产源码）
1. `src/services/supabase.js`：直接读取静态 EXPO_PUBLIC_* 属性以兼容 Expo 替换；调用纯解析函数；条件构造 client；删除占位 URL/key 及失实注释；保留既有认证 storage adapter 和正常态 auth options。
2. `src/services/supabaseConfig.js`：新增纯、同步、无依赖的配置解析函数，便于对实际实现做 Node 测试。
3. `src/app/_layout.js`：在业务 Provider（包括 ThemeProvider）之前返回内联配置错误 View；正常分支保留现有 Provider、路由、主题及 UI。
不修改 useAuth 或其他调用方，不迁移 TS、不增加依赖、不调数据库、RLS、CI、app.json/eas.json，不做顺带修复。原有未提交改动须全部保留（只对 supabase.js 现有缺陷作本任务修正）。测试脚本与脱敏报告可存任务目录或临时目录，不默认入库。

## 3. 配置解析契约
- 纯函数 `parseSupabaseConfig(rawUrl, rawKey)`：检查字符串类型，trim，拒绝缺失和纯空白；URL 必须显式 https://（建议批准默认 HTTPS only，不自动允许 HTTP；未来本地开发例外单独审批）；使用 try/catch new URL，要求有效 hostname、非空 hostname 首段，禁止 URL 内嵌 username/password。
- 协议与解析失败输出固定错误码（例如 MISSING_URL、MISSING_KEY、INVALID_URL、INVALID_PROTOCOL），不包含真实输入、URL、key、token。自定义合法 HTTPS 域名、端口与路径按既有 SDK 支持范围保留；不自动替换项目域名、不硬编码项目 ref、不重写路径，不把 HTTPS 或非空 Key 宣称为身份验证。明确检测没有显式 scheme 的输入，避免 URL 构造器宽松规范化误接收。
- 成功返回 `{ok:true, url, key, storageKey}`；url/key 为经过 trim 的值；storageKey 严格沿用 `sb-${parsed.hostname.split('.')[0]}-auth-token`，正常有效配置下不变。失败 `{ok:false, errors}`，不携带 url/key/storageKey，也不构造任何客户端。
- 核验当前 SDK 对 URL/Key 的同步构造前校验是否有遗漏；预期配置错误应在纯解析阶段拒绝。若发现无法通过静态校验覆盖的构造异常或构造阶段可能部分初始化，报告并停止，不用宽泛 catch 掩盖问题或承诺已无副作用。
- 保留 SecureStoreAdapter 全部行为及正常配置的 storageKey、autoRefreshToken、persistSession、detectSessionInUrl 等选项。禁止清理、迁移、重命名既有会话来实现本修复。
- `isSupabaseConfigured` 表示已通过本地配置校验，不代表网络连通或认证有效。`supabaseConfigErrors` 仅含固定错误码（可选供诊断），不输出配置值。
- 配置无效时导出 `supabase = null`，禁止 fallback client、DNS 探测、认证存储访问或后台刷新。正常配置只创建一个现有方式的客户端。保持 Expo 静态 env 访问形式。

## 4. RootLayout 拦截
配置无效时在所有 Provider 及业务 hook 挂载前直接返回纯 `View/Text`，不依赖导航/主题/认证/健康/浏览器等上下文，不调用 router、不显示登录页面、不永久停留 SplashScreen、不提供伪重试。
建议文案：应用配置异常，暂时无法连接服务。请检查应用配置后重新启动。
仅固定错误码可选显示；禁止显示项目秘密或用户信息。
正常路径保持现有 JSX 树与路由守卫不变；不修改主题常量及 ThemeContext API。
如果实际运行出现导航器/深链接/SplashScreen 阻断，停止并报告最小修订方案，不擅自放行或挂载业务路由。

## 5. 执行顺序及阶段门槛
A. 再核查 HEAD、工作区、stage、当前源码及 SDK；不得覆盖用户改动。保存本次变更前的脱敏 diff 或临时副本（不得泄露真实 env）。如基线变化先报告。
B. 实现纯解析函数并对实际文件运行测试（不是复制一份伪实现）。使用现有 Node/工具链，不新增包。
C. 实现 supabase 条件初始化与 RootLayout 拦截；确认正常分支完全一致，失败分支无 SDK 调用。
D. 本地静态检查、隔离启动/回归、导出任务 diff 与结果，停止待 T5。不能因缺设备伪造结果；可先提交审查材料，但关键运行验收未完成前不冻结基线。
E. GPT/Gemini 并行审查实际 diff，DeepSeek 核验并修正必要问题，项目负责人完成 T7。HF01 结束后恢复原 P0.1 流程；重新核对最终提交范围与推送授权，不自动 commit/push/tag。

## 6. 最小测试与验收（必须记录通过/失败/未验证）
| 测试 | 判据 |
|---|---|
| 配置解析（真实函数，Node） | 双缺、仅缺 URL/Key、空串、空白、非法 URL、无显式 scheme、FTP、HTTP、无主机、内嵌凭据均拒绝；有效 HTTPS、尾斜杠、合法自定义域名、前后空白、已有支持的路径/端口通过。失败无 url/key/storageKey。非空假 Key 仅格式通过，记录限制。 |
| storageKey 回归 | 对多个合法 URL 对比旧表达式，逐字节一致，包含当前域名形态及已有支持的端口/路径；不记录真实会话。 |
| 客户端隔离 | 使用 mock/spy 或等效可重复验证实际模块：无效配置 createClient 0 次、认证 SecureStore/AsyncStorage 读写 0 次、业务网络请求 0 次；有效配置一次构造且 auth options 保持。 |
| 正常启动 | 运行当前开发环境，确认已登录会话、登录/登出、健康、聊天、放映厅基本路径（测试账号）、推送适用项无回归。 |
| 异常启动 | 在隔离环境用虚构配置分别冷启动，出现明确提示、无 Invalid URL/null 错误、无误入登录页/无限 loading，不挂载业务 Provider。 |
| 会话恢复 | 使用测试账号或虚构会话，保持同一测试安装的数据，正常→异常→恢复配置（重启且确保新 bundle 生效），认证存储未被异常态修改；有效会话可以恢复，服务端失效/过期按正常逻辑处理。 |
| Router/原生 | 在可用环境真实验证 Expo Go 或 dev build 的 iOS、Android 启动/深链接/启动屏，通知点击与返回键按平台适用性验证；未具备设备或构建环境就注明，不把 Node 当作 Web/RN 实测，不宣称双端通过。 |
| 静态检查 | `npx tsc --noEmit` 退出 0（非完整 JS 类型安全）；`npx expo lint` 记录原始退出码与明细，历史基线 144/119/25，不新增诊断（比较规则/文件，不仅总数）；不得禁用规则。 |
| 范围与安全 | 无新依赖、数据库改动、日志密钥、额外 UI/主题变更；异常态不发送认证或业务请求（不要求 Metro/系统/框架自身零流量）。 |

测试不修改真实 `.env` 或生产数据库，不使用真实个人会话，不输出凭据；用隔离配置、测试安装与虚构数据验证。不能实测的用未验证标记，并列出最小复现操作；真实异常启动及会话保护未证实时，不得宣称 HF01 完成，也不得冻结父任务基线。如生产构建兼容性暂时不可测，明确风险并单独审批，不能把未测作通过。

## 7. 交付（精简）
任务目录 `docs/refactor/tasks/TASK-P0.1-HF01/`：
- 06_FINAL_PLAN.md（本文件）
- 07_IMPLEMENTATION_REPORT.md（实际改动、偏差、测试命令/退出码/证据、未验证与风险；合并测试报告即可）
- 08_CODE_DIFF.txt（实际 Git diff，含新增文件完整内容；区分原有 3 个文件改动与 HF01 新增差异；附最终相对 HEAD diff）
只读审查需附关键修改后的源码（可合并至 diff 文件补充区）及必要测试脚本。报告脱敏，不提交公开仓库，除非负责人另行授权。

## 8. 回滚和审批
以实施前副本/差异为恢复基线，逐项撤销 HF01 自身改动，完整保留原有 app.json、eas.json、supabase.js 未提交修改与文档；禁止 reset --hard、clean、覆盖已有文件及清理用户存储。遇到基线漂移、无法安全拦截、storageKey 改变、意外旁路、未经授权的范围扩大或关键验收失败，停止并报告。负责人明确批准后才执行 T4。任何提交、推送、标签、数据库操作均不在本次授权内。
