# 02 — Sync 开发基线预检报告（TASK-P0.1）

> 任务：TASK-P0.1 — 建立 Sync 开发基线
> 阶段：T1 源码预检（只读）
> 初步风险等级：L1
> 核验后风险等级：**L1（确认）**
> 采集时间：2026-11-16T14:22Z（Europe/Madrid 15:22）
> 采集方式：本地只读命令 + 源码阅读，未修改任何业务源码、未安装依赖、未改动数据库、未提交/推送/部署
> 结论依据：全部来自本仓库真实源码与本地命令输出（见 [`03_SOURCE_CONTEXT.txt`](03_SOURCE_CONTEXT.txt)）

---

## 0. 结论摘要（TL;DR）

| 项目 | 结论 |
| --- | --- |
| 分支 / HEAD | `main` @ `eec7880`（与 `origin/main` 同步） |
| 工作区 | **不干净**：3 个已修改未提交文件（`app.json`、`eas.json`、`src/services/supabase.js`） |
| 技术栈 | Expo SDK 58 + React Native 0.88.1 + React 19.3 + Expo Router 58 + Supabase |
| 语言 | **纯 JavaScript**（`src/` 下 128 个 `.js`，0 个 `.ts/.tsx`），TS 仅做推断级检查 |
| 包管理 | npm（`package-lock.json`），无 bun/yarn/pnpm 锁文件 |
| 类型检查 | `npx tsc --noEmit` → **0 error（通过）** |
| Lint | `npx expo lint` → **144 problems（119 error / 25 warning）**，分布于 13 个文件，CI 中为非阻断 |
| 测试体系 | **无**（无测试文件、无测试框架、无测试脚本） |
| CI/CD | 仅 GitHub Actions `ci.yml`：typecheck（阻断）+ lint（非阻断）；无 EAS 自动构建流水线 |
| 依赖健康 | `expo-doctor` 19/20 通过；1 项失败：28 个包版本落后于 SDK 58 期望值（patch/minor 级） |
| `docs/refactor/` | **不存在**，本次为首次创建 |
| 风险等级 | **L1 确认**（只读预检，无副作用） |

**核心判断**：工程可编译（tsc 通过）、可 lint（有已知基线噪声），但**无自动化测试、工作区存在未提交改动、依赖存在版本漂移**。后续任何修复/重构前，必须先固化当前状态为可回滚基线。

---

## 1. Git 状态

### 1.1 分支与提交

| 项 | 值 |
| --- | --- |
| 当前分支 | `main` |
| HEAD | `eec78801ff8fd0483e260c413d86756d19e3a911` |
| HEAD 提交信息 | `fix(cinema): 修复安卓重新进入影院时进度条清空并从 0 重播` |
| 上游 | `origin/main`（`origin/HEAD -> origin/main`），本地与远端一致 |
| 远端 | `https://github.com/abcdabcd9/sync.git` |
| 其他本地分支 | `backup-before-reset` |
| Stash | 空 |
| 标签 | `stage-0-baseline`、`stage-1-done`、`stage-2-done`、`stage-2b-done` |

最近 5 次提交：

```
eec7880 (HEAD -> main, origin/main) fix(cinema): 修复安卓重新进入影院时进度条清空并从 0 重播
b9f4548 修复启动页及增加影院使用体验
1e52285 fix(browser): 书签改用网页自带标题展示，修复启动页图标裁切与明暗颠倒
cba5b9f fix(cinema): 修复 iOS 原生播放器请求 m3u8 返回 HTTP 403（防盗链）
f1529a4 fix(cinema): 修复影院重播、返回浏览器失效与 iOS 选集抓取失败
```

### 1.2 未提交修改（工作区不干净）

`git status --porcelain`：

```
 M app.json
 M eas.json
 M src/services/supabase.js
```

`git diff --stat`：3 files changed, 38 insertions(+), 16 deletions(-)

| 文件 | 改动性质 | 摘要 |
| --- | --- | --- |
| [`app.json`](../../app.json:5) | 版本号 | `version` 由 `3.0` → `3.0.1` |
| [`eas.json`](../../eas.json:10) | 构建配置 | 三个 build profile 各新增 `"environment"` 字段（development/preview/production） |
| [`src/services/supabase.js`](../../src/services/supabase.js:11) | **业务源码** | 缺少 env 时不再模块顶层 `throw`，改为 `console.error` + 占位值创建 client，并新增导出 `isSupabaseConfigured` |

> ⚠️ **重要**：`src/services/supabase.js` 是**业务源码**且处于未提交状态。这属于「已存在但未纳入版本控制」的改动。P0.1 只读预检**不处理**它，但必须在 P0.2 之前由负责人决定：**提交、暂存（stash）还是丢弃**。否则后续基线不可复现。

---

## 2. 项目结构与技术栈

### 2.1 目录结构（顶层）

```
my-app/
├── src/                    # 全部业务源码（128 个 .js，约 21,999 行）
│   ├── app/                # 42 个路由页面（Expo Router 文件式路由）
│   ├── components/         # 34 个组件（含 ui/ 原子层）
│   ├── hooks/              # 27 个 hook（顶层跨域 + chat/health/browser/profile 子域）
│   ├── services/           # 3 个：supabase.js / pushService.js / mediaCache.js
│   ├── constants/          # 9 个常量文件
│   ├── context/            # ThemeContext.js
│   ├── scripts/            # 10 个 WebView 注入脚本
│   ├── types/              # 仅 README（TS 迁移预留）
│   └── utils/              # episodeUrl.js
├── supabase/
│   ├── functions/send-push # 唯一 Edge Function（Deno）
│   └── migrations/         # 19 个 SQL 迁移
├── docs/                   # 中英双语文档 + specs/ 设计文档
├── assets/                 # 图标、启动图
├── certs/                  # 证书说明（真实证书 gitignore）
├── .github/workflows/      # CI
├── app.json                # Expo 配置（CNG 唯一真相源）
├── eas.json                # EAS 构建 profile
├── eslint.config.js        # ESLint 9 flat config
├── tsconfig.json           # 继承 expo/tsconfig.base
└── package.json
```

> 无 `ios/`、`android/` 目录 → 采用 CNG（Continuous Native Generation），原生工程构建时生成，**禁止手改**。

### 2.2 技术栈与版本（来自 [`package.json`](../../package.json:22)）

| 层 | 选型 | 版本 |
| --- | --- | --- |
| 运行时 | Expo SDK | `58.0.21` |
| RN | react-native | `0.88.1` |
| React | react / react-dom | `19.3.0` |
| 路由 | expo-router | `58.0.28` |
| 后端 SDK | @supabase/supabase-js | `2.118.0` |
| 动画 | react-native-reanimated | `4.7.1` |
| 手势 | react-native-gesture-handler | `3.3.0` |
| 列表 | @shopify/flash-list | `2.3.2` |
| WebView | react-native-webview | `14.0.1` |
| 语言 | JavaScript（无 TS 源码） | — |
| 包管理 | npm | — |

devDependencies：`eslint@9.39.5`、`eslint-config-expo@58.0.4`、`typescript@6.0.3`

`overrides`：强制 `minimatch@11.0.3`、`glob@14.0.3`（供应链收敛）

### 2.3 本地环境

| 项 | 值 |
| --- | --- |
| Node | `v24.21.0` |
| npm | `11.19.0` |
| bun | 未安装（项目用 npm，符合预期） |
| node_modules | 已存在 |

> 注：CI 使用 Node 20，本地为 Node 24。存在**本地/CI 运行时版本不一致**，建议后续统一（见 §9 技术债）。

---

## 3. 配置文件核查

### 3.1 [`package.json`](../../package.json:16) scripts

```json
"start": "expo start",
"android": "expo run:android",
"ios": "expo run:ios",
"lint": "expo lint"
```

> **无 `test`、无 `typecheck` 脚本**。typecheck 只能手动 `npx tsc --noEmit`。

### 3.2 [`tsconfig.json`](../../tsconfig.json:1)

```json
{
  "compilerOptions": {},
  "extends": "expo/tsconfig.base",
  "exclude": ["supabase/functions"]
}
```

- 未开启 `strict`，`compilerOptions` 为空 → 仅继承 Expo 基础配置。
- 源码是 JS，`tsc --noEmit` 实际只做**推断级检查**（`allowJs` 由 base 决定），无法捕获类型错误。

### 3.3 [`app.json`](../../app.json:1)（Expo 配置）

| 项 | 值 |
| --- | --- |
| name / slug | `Sync` / `my-app` |
| version | `3.0.1`（未提交改动） |
| scheme | `mycoupleapp` |
| runtimeVersion | `2.1`（支持 OTA） |
| EAS projectId | `7314ce1c-a3c0-4484-bb43-88dd98829353` |
| owner | `abcd_abcd9` |
| updates | enabled，`ON_LOAD`，`fallbackToCacheTimeout: 0` |
| iOS bundleId / Android package | `com.sync.app` |
| plugins | expo-router、expo-audio、expo-video、expo-secure-store、expo-font、expo-asset、expo-image、expo-status-bar、expo-location、expo-notifications、expo-splash-screen |

### 3.4 [`eas.json`](../../eas.json:1)

- `cli.version >= 24.8.0`，`appVersionSource: remote`
- 三个 profile：`development`（devClient）、`preview`（internal）、`production`（autoIncrement）
- 未提交改动为三个 profile 各加 `environment` 字段

### 3.5 锁文件

- 存在 `package-lock.json`（442 KB，2026-11-15 更新）
- 无 `bun.lock` / `yarn.lock` / `pnpm-lock.yaml` → 确认使用 **npm**

### 3.6 环境变量模板 [`.env.example`](../../.env.example:1)

- `EXPO_PUBLIC_SUPABASE_URL`、`EXPO_PUBLIC_SUPABASE_ANON_KEY`（必需）
- `EXPO_PUBLIC_GROQ_API_KEY`（可选，语音转文字）
- `.env` 已被 `.gitignore` 忽略；`.env.example` 不含真实值 ✅

---

## 4. CI/CD 与测试体系

### 4.1 CI（[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml:1)）

| 步骤 | 命令 | 阻断性 |
| --- | --- | --- |
| Checkout | `actions/checkout@v4` | — |
| Setup Node | Node 20，npm cache | — |
| Install | `npm ci` | 阻断 |
| Typecheck | `npx tsc --noEmit` | **阻断** |
| Lint | `npx expo lint` | **非阻断**（`continue-on-error: true`） |

触发条件：`push` / `pull_request` 到 `main`。

> CI 注释明确说明：lint 存在既有基线问题（React Compiler 规则），暂设非阻断，待基线清零后改阻断。

### 4.2 测试体系

- **无任何测试文件**（`*.test.js` / `*.spec.ts` / `jest.config` / `vitest.config` 均不存在）
- **无测试框架依赖**（package.json 无 jest/vitest/testing-library）
- **无 `test` 脚本**

> 结论：项目**零自动化测试覆盖**。这是后续安全修复与重构的最大风险点（见 §9）。

### 4.3 EAS / 发布

- 使用 EAS Build（`eas.json`），支持 OTA（`runtimeVersion: 2.1`）
- **无 EAS 自动构建流水线**（CI 只做检查，不触发 build/submit）
- 无签名 APK/IPA 入库（`.gitignore` 忽略 `*.apk`）

---

## 5. 工程规范与文档

| 文档 | 作用 | 状态 |
| --- | --- | --- |
| [`AGENTS.md`](../../AGENTS.md:1) | Expo 版本硬性约定、命令清单、路由规范 | 存在 |
| [`README.md`](../../README.md:176) | 功能现状 + 「诚实清单」（未完成功能） | 存在 |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md:1) | 贡献流程、环境要求 | 存在 |
| [`SECURITY.md`](../../SECURITY.md:1) | 漏洞上报流程 | 存在 |
| [`docs/README.md`](../../docs/README.md:1) | 文档索引 | 存在 |
| [`docs/DEV_LOG.md`](../../docs/DEV_LOG.md:1) | 开发日志（按时间记录踩坑） | 存在 |
| [`docs/ROADMAP_2027_SUMMER.md`](../../docs/ROADMAP_2027_SUMMER.md:1) | 六阶段重构执行手册（39–57 天） | 存在 |
| [`docs/specs/CODEBASE_MAP.md`](../../docs/specs/CODEBASE_MAP.md:1) | 当前代码架构说明（现状，非目标态） | 存在 |
| [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC*.md`](../../docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:1) | 重构执行方案（3 部分） | 存在 |
| [`docs/specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md`](../../docs/specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md:1) | 架构图 | 存在 |
| [`docs/specs/SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md`](../../docs/specs/SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md:1) | 关系网络接口预留（未实现） | 存在 |

### 5.1 路线图关键约束（来自 ROADMAP §0）

- **三条铁律**（违反即当天回滚）：
  1. 不得修改 `src/constants/colors.js` 任何色值
  2. 不得修改 `src/constants/theme.js` 的 `SIZES` / `TYPOGRAPHY`
  3. 不得修改 `src/context/ThemeContext.js` 对外 API
- 装依赖只用 `npx expo install <package>`，禁止 `npm install` / `yarn add` / `bun add`
- 每阶段结束必跑：`npx expo lint`（只许降不许升）、`npx tsc --noEmit`（0 error）、`git diff src/constants/`（必须为空）
- 六阶段顺序：0（TS 契约）→ A（拆页面）→ B（strict）→ C（TanStack Query + MMKV）→ D（.js→.tsx）→ E（FCM）

> ⚠️ 路线图基线写的是 `1a3aca4`（2026-11-01 停工点），**当前 HEAD 已推进到 `eec7880`**，路线图基线已过期，需在 P0.2 前更新。

---

## 6. `docs/refactor/` 现状

- **目录不存在**（`ls docs/refactor` → `NO docs/refactor`）
- 无既有基线文件，无采集脚本
- 本次 P0.1 为**首次创建**该目录，产出 `02_PREFLIGHT_REPORT.md` 与 `03_SOURCE_CONTEXT.txt`

---

## 7. 本地工程检查命令与验收标准

### 7.1 检查命令（只读，均已在本次预检执行）

```bash
# 1. 类型检查（阻断级）
npx tsc --noEmit

# 2. Lint（当前非阻断，记录基线）
npx expo lint

# 3. 依赖健康诊断
npx expo-doctor

# 4. Git 状态
git status --porcelain
git rev-parse HEAD
```

### 7.2 本次实测结果（基线快照）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx tsc --noEmit` | **0 error** | 0 |
| `npx expo lint` | **144 problems（119 error / 25 warning）** | 0（非阻断） |
| `npx expo-doctor` | **19/20 通过**，1 失败（28 包版本落后） | 非 0 |

### 7.3 Lint 基线分布（13 个文件）

```
src/app/chat_room.js
src/app/cinema.js
src/app/invite_friend.js
src/components/ChatContextMenu.js
src/components/ChatInputBar.js
src/components/FloatingPlayer.js
src/components/MealDetailSheet.js
src/components/WaterProgress.js
src/components/cinema/EpisodeDrawer.js
src/hooks/chat/useMediaUpload.js
src/hooks/useCinema.js
src/hooks/useHealthData.js
src/services/mediaCache.js
```

主要规则：`react-hooks/set-state-in-effect`、`react-hooks/immutability`、`react-hooks/exhaustive-deps`、`no-unused-vars`。

> 注：README 与 CI 注释记录的基线为「136 项 / 112 error / 24 warning」，本次实测为「144 项 / 119 error / 25 warning」，**基线已上升 8 项**。需在 P0.2 前确认是否接受新基线或回退。

### 7.4 验收标准（P0.1 基线冻结判据）

| 编号 | 验收项 | 判据 |
| --- | --- | --- |
| AC-1 | 类型检查 | `npx tsc --noEmit` 退出码 0，0 error |
| AC-2 | Lint 基线 | `npx expo lint` 记录精确数字（当前 144/119/25），后续只许降不许升 |
| AC-3 | 依赖诊断 | `npx expo-doctor` 结果记录在案（当前 19/20） |
| AC-4 | Git 可复现 | HEAD 固定为 `eec7880`，工作区改动有明确处置决定 |
| AC-5 | 回滚可用 | 存在可回滚的 tag 或分支（见 §8） |
| AC-6 | 文档落盘 | `02_PREFLIGHT_REPORT.md` + `03_SOURCE_CONTEXT.txt` 已生成 |

---

## 8. 版本冻结与回滚方案

### 8.1 版本冻结建议

1. **冻结点**：以当前 `main` @ `eec7880` 为代码基线。
2. **处置未提交改动**（需负责人决策，P0.1 不执行）：
   - 方案 A（推荐）：将 `app.json` / `eas.json` / `supabase.js` 三处改动**单独提交**为 `chore: 基线冻结前收尾`，再打 tag。
   - 方案 B：`git stash` 暂存，基线保持 `eec7880` 纯净。
   - 方案 C：丢弃改动（**不推荐**，`supabase.js` 的启动防御是有价值的修复）。
3. **打基线 tag**：`git tag -a p0.1-baseline -m "TASK-P0.1 基线冻结"`（**需负责人批准后执行，P0.1 不自动打 tag**）。
4. **依赖冻结**：`package-lock.json` 已锁定，禁止在 P0.2 前升级依赖。

### 8.2 回滚方案

| 场景 | 回滚动作 |
| --- | --- |
| 代码回滚 | `git reset --hard eec7880`（或回到 `p0.1-baseline` tag） |
| 未提交改动回滚 | `git checkout -- app.json eas.json src/services/supabase.js` |
| 依赖回滚 | `git checkout -- package-lock.json && npm ci` |
| 已有安全网 | 本地分支 `backup-before-reset` + 4 个 stage tag 可作为历史锚点 |
| 数据库回滚 | 迁移按编号可重放（19 个 SQL），但**P0.1 不触碰数据库**；重置手册见 [`docs/RESET_DATABASE.md`](../../docs/RESET_DATABASE.md:1) |

> 回滚可行性评估：**高**。HEAD 与远端一致、有备份分支与 stage tag、锁文件完整。

---

## 9. 已知技术债与未完成事项

### 9.1 工程/质量债

| # | 技术债 | 证据 | 影响 |
| --- | --- | --- | --- |
| TD-1 | **零自动化测试** | 无测试文件/框架/脚本 | 重构与安全修复无回归保护，最高风险 |
| TD-2 | **Lint 基线 144 项且已上升** | 实测 119 error / 25 warning；README 记录 136 | 基线漂移，需重新冻结 |
| TD-3 | **纯 JS，无类型约束** | `src/` 128 个 `.js`，0 个 `.ts`；tsconfig 未开 strict | 重构易引入隐性错误 |
| TD-4 | **依赖版本漂移** | expo-doctor：28 包落后 SDK 58 期望（patch/minor） | 潜在兼容性问题 |
| TD-5 | **本地/CI Node 版本不一致** | 本地 Node 24，CI Node 20 | 环境差异导致「本地过 CI 挂」 |
| TD-6 | **工作区未提交改动** | 3 文件 modified | 基线不可复现 |
| TD-7 | **无 typecheck/test npm 脚本** | package.json scripts 仅 4 条 | 检查命令靠记忆，易漏跑 |
| TD-8 | **路线图基线过期** | ROADMAP 写 `1a3aca4`，实际 `eec7880` | 执行手册与现状脱节 |

### 9.2 功能债（来自 README「诚实清单」）

| # | 未完成项 | 位置 |
| --- | --- | --- |
| FD-1 | 私密空间、朋友圈为纯占位页 | `src/app/private/index.js`、`src/app/moments/index.js` |
| FD-2 | 功能开关 `isFeatureOn()` 空转，无调用方 | `src/constants/features.js` |
| FD-3 | 9 项设置「能存不生效」 | `useAppSettings.js` 只存不用 |
| FD-4 | 视频/语音通话仅弹 Alert | `ChatRoomInner.js` `handleStartCall` |
| FD-5 | 黑名单/星标/免打扰不生效 | 聊天子系统 |
| FD-6 | 放映厅无大厅，房间号本地生成 | `useCinema.js` |
| FD-7 | 多账号切换实为登出再登录 | `useAccountSwitcher.js` |
| FD-8 | 无多语言（仅简体中文） | — |
| FD-9 | 关系网络（多搭子/小圈子）仅预留 | `docs/specs/SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md` |
| FD-10 | 无端到端加密（E2EE） | `src/constants/security.js` 已诚实披露 |

### 9.3 安全相关（供 P0.2 参考，本次不处理）

- `src/services/supabase.js` 未提交改动引入 `isSupabaseConfigured` 导出与占位 client —— 需评估占位 client 是否会在未配置时产生静默失败风险。
- 19 个迁移已含 RLS 加固、`SECURITY DEFINER` 固定 `search_path`、私有桶签名 URL 等（见 README 项目亮点），安全基线较好。
- `.gitignore` 已覆盖 `.env`、证书、`google-services.json`、`push.json`、`sync.json` 等敏感文件 ✅

---

## 10. 风险等级核验

| 维度 | 评估 | 说明 |
| --- | --- | --- |
| 数据变更 | 无 | 只读，未触碰数据库 |
| 代码变更 | 无 | 未修改业务源码（仅新增 docs 文件） |
| 依赖变更 | 无 | 未安装/升级 |
| 发布影响 | 无 | 未提交/推送/部署 |
| 可逆性 | 完全可逆 | 仅新增 2 个文档文件 |
| 信息泄露 | 无 | 报告未包含任何密钥/令牌/私人数据 |

**核验结论：风险等级 L1 确认。** 本任务为纯只读预检 + 文档产出，无副作用，完全可逆。

---

## 11. 简要实施方案（P0.1 已完成部分 + 后续衔接）

### 11.1 P0.1 已执行（只读）

1. 采集 Git 状态（分支/HEAD/工作区/stash/tag/remote）
2. 采集项目结构、技术栈、依赖版本
3. 核查 `package.json` / `package-lock.json` / `app.json` / `eas.json` / `tsconfig.json` / `eslint.config.js`
4. 核查 CI（`ci.yml`）与测试体系（确认无）
5. 核查工程规范文档（AGENTS/README/CONTRIBUTING/SECURITY/ROADMAP/CODEBASE_MAP）
6. 确认 `docs/refactor/` 不存在
7. 实测 `tsc` / `expo lint` / `expo-doctor` 并记录基线
8. 提出冻结与回滚方案
9. 记录技术债
10. 核验风险等级

### 11.2 衔接 P0.2 的前置条件（需负责人决策）

1. **处置 3 个未提交改动**（提交 / stash / 丢弃）
2. **确认 lint 新基线**（144 项是否接受）
3. **决定是否打 `p0.1-baseline` tag**
4. **更新 ROADMAP 基线**（`1a3aca4` → `eec7880`）
5. **决定是否引入最小测试框架**（建议 P0.2 起补 smoke test）

---

## 12. 待确认事项

| # | 待确认 | 建议 |
| --- | --- | --- |
| Q1 | `src/services/supabase.js` 等 3 处未提交改动如何处置？ | 单独提交后打 tag（方案 A） |
| Q2 | lint 基线从 136 上升到 144，是否接受为新基线？ | 接受并记录，后续只降不升 |
| Q3 | 是否在 P0.1 结束时打 `p0.1-baseline` tag？ | 建议打，便于回滚 |
| Q4 | 是否在 P0.2 引入测试框架（jest-expo / vitest）？ | 建议引入最小 smoke test |
| Q5 | 本地 Node 24 与 CI Node 20 是否统一？ | 统一到 Node 20（与 CI 一致） |
| Q6 | 依赖版本漂移（28 包）是否在 P0.2 前 `expo install --fix`？ | 建议单独任务处理，不在 P0.1/P0.2 混入 |

---

## 附录：证据来源

- Git：`git rev-parse` / `git status` / `git log` / `git diff` / `git branch` / `git tag`
- 配置：[`package.json`](../../package.json:1)、[`tsconfig.json`](../../tsconfig.json:1)、[`app.json`](../../app.json:1)、[`eas.json`](../../eas.json:1)、[`eslint.config.js`](../../eslint.config.js:1)、[`.gitignore`](../../.gitignore:1)、[`.env.example`](../../.env.example:1)
- CI：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml:1)
- 文档：[`README.md`](../../README.md:176)、[`docs/README.md`](../../docs/README.md:1)、[`docs/ROADMAP_2027_SUMMER.md`](../../docs/ROADMAP_2027_SUMMER.md:1)、[`docs/specs/CODEBASE_MAP.md`](../../docs/specs/CODEBASE_MAP.md:1)、[`docs/DEV_LOG.md`](../../docs/DEV_LOG.md:1)、[`src/types/README.md`](../../src/types/README.md:1)、[`src/constants/security.js`](../../src/constants/security.js:1)
- 命令实测：`npx tsc --noEmit`、`npx expo lint`、`npx expo-doctor`
- 完整原始输出见 [`03_SOURCE_CONTEXT.txt`](03_SOURCE_CONTEXT.txt)
