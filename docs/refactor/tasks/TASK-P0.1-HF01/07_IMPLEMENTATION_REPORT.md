# TASK-P0.1-HF01 / T4 正式实施报告

> 任务：Supabase 启动防御修复（B-Lite / Guarded Null + RootLayout 顶层拦截）
> 依据：`06_FINAL_PLAN.md`（项目负责人已批准）
> 分支：`refactor/phase-0`
> 基线 HEAD：`eec78801ff8fd0483e260c413d86756d19e3a911`
> 状态：**实施完成，等待独立代码评审**（未提交、未推送、未合并、未部署）

---

## 1. 实施结论摘要

| 项 | 结果 |
|---|---|
| 修改源文件数 | 3（`supabase.js` 改、`_layout.js` 改、`supabaseConfig.js` 新增） |
| 新增依赖 | 无 |
| 数据库变更 | 无 |
| 正常配置业务行为 | 保持不变（唯一客户端、auth 选项逐项一致） |
| 异常配置行为 | 不创建 Client、不读写认证存储、不发网络请求、不挂载业务 Provider |
| 静态检查 | `tsc --noEmit` 0 错误；`expo lint` 144 问题（119 error / 25 warning）与基线完全一致 |
| 配置解析契约测试 | 20/20 通过 |
| 客户端隔离测试 | 42/42 通过 |
| storageKey 回归测试 | 20/20 逐字节一致 |
| 启动回归（静态结构） | 12/12 通过 |
| 启动回归（真机运行时） | **未验证**（当前环境无设备/模拟器） |
| 提交 / 推送 / 合并 / 部署 | 均未执行 |

**总体判定：实施符合 `06_FINAL_PLAN.md` 全部约束，静态与可重复验证项全部通过；唯一未覆盖项为真机运行时启动回归，已在 §6 如实标注。**

---

## 2. 变更清单

### 2.1 新增 `src/services/supabaseConfig.js`
纯同步、零依赖、无副作用的配置解析函数 `parseSupabaseConfig(rawUrl, rawKey)`：
- 输入：原始 URL 与 Anon Key（可为 `undefined` / 空串 / 空白串）。
- 输出：
  - 失败：`{ ok: false, errors: string[] }`，错误码取自冻结常量 `CONFIG_ERROR`（`MISSING_URL` / `MISSING_KEY` / `INVALID_URL` / `INVALID_PROTOCOL`），去重后返回。
  - 成功：`{ ok: true, url, key, storageKey }`，其中 `storageKey = sb-${hostname 首段}-auth-token`。
- 校验规则：非空字符串（trim 后）、必须 `https://`、可被 `URL` 解析、hostname 非空、不含用户名/密码。
- 该函数不读取环境变量、不触碰存储、不发网络请求，可被 Node 直接单测。

### 2.2 修改 `src/services/supabase.js`
- 移除模块顶层 `throw new Error('Missing Supabase URL or Anon Key...')`（原白屏闪退根因之一）。
- 引入 `parseSupabaseConfig`，在创建 Client 前做纯同步校验，导出：
  - `isSupabaseConfigured`（布尔，仅表示本地校验通过）
  - `supabaseConfigErrors`（仅固定错误码，不含真实配置值）
- `AUTH_STORAGE_KEY` 改为 `config.ok ? config.storageKey : null`，正常配置下与旧表达式逐字节一致。
- `supabase` 改为条件构造：`config.ok ? createClient(...) : null`；异常分支绝不调用 `createClient`。
- `SecureStoreAdapter`（含 AsyncStorage 旧明文迁移、降级兜底）**完全保留未改**。

### 2.3 修改 `src/app/_layout.js`
- 新增 `ConfigErrorView`：纯展示组件，仅用 `View` / `Text`，不依赖任何 Provider / 导航 / 主题 / 认证上下文。
- `RootLayout` 顶部新增守卫：`if (!isSupabaseConfigured) return <ConfigErrorView />;`，位于 `<ThemeProvider>` 等所有业务 Provider 之前。
- 正常分支 Provider 树顺序保持不变：`ThemeProvider → AuthProvider → HealthProvider → CinemaProvider → BrowserSessionProvider → RootNavigation`。

---

## 3. 测试结果明细

### 3.1 静态检查

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc --noEmit` | 0 | 无类型错误 |
| `npx expo lint` | 1 | `✖ 144 problems (119 errors, 25 warnings)` |

- lint 退出码 1 为**基线既有状态**（修复前即为 144/119/25），本次未新增任何诊断。
- 逐一核对 lint 报错文件清单，均为既有文件（`chat_room.js`、`cinema.js`、`invite_friend.js`、`ChatContextMenu.js`、`ChatInputBar.js`、`EpisodeDrawer.js`、`FloatingPlayer.js`、`MealDetailSheet.js`、`WaterProgress.js`、`useMediaUpload.js`、`useCinema.js`、`useHealthData.js`、`mediaCache.js`）。
- 本次新增/修改的 3 个文件（`supabaseConfig.js`、`services/supabase.js`、`_layout.js`）**均无任何 lint 问题**。

### 3.2 配置解析契约测试（20/20 通过）
对**真实** `src/services/supabaseConfig.js` 运行 Node 测试，覆盖：缺失 URL、缺失 Key、空白串、`http://`、非法 URL、含用户名/密码、合法 HTTPS、大小写协议、带端口/路径/查询/片段等，全部符合预期。

### 3.3 客户端隔离测试（42/42 通过）
在隔离沙箱中用 stub 替换 `react-native-url-polyfill`、`@react-native-async-storage/async-storage`、`expo-secure-store`、`@supabase/supabase-js`，对**真实** `src/services/supabase.js` 逐场景（每个场景独立子进程、独立环境变量）断言：

| 场景 | 配置 | 关键断言 | 结果 |
|---|---|---|---|
| A | 完全缺失 | `isSupabaseConfigured=false`、`supabase=null`、`createClient` 0 次、AsyncStorage/SecureStore 读写 0 次、错误码含 `MISSING_URL`+`MISSING_KEY` | ✅ |
| B | 仅缺 Key | 同上，错误码仅 `MISSING_KEY` | ✅ |
| C | `http://` | 拒绝，错误码含 `INVALID_PROTOCOL`，`createClient` 0 次 | ✅ |
| D | 非法 URL | 拒绝，错误码含 `INVALID_URL`，`createClient` 0 次 | ✅ |
| E | 合法 HTTPS | `isSupabaseConfigured=true`、`supabase` 非空、`createClient` 恰好 1 次、`url/key` 正确、`storageKey` 逐字节一致、`autoRefreshToken=true`/`persistSession=true`/`detectSessionInUrl=false`、storage 为适配器对象、构造期存储读写 0 次 | ✅ |
| F | 空白字符串 | 拒绝，`createClient` 0 次 | ✅ |

> 说明：网络请求 0 次由"`createClient` 0 次 + 构造期无存储/网络副作用"间接保证——异常分支根本不构造 SDK，故不存在任何 SDK 发起的网络请求。

### 3.4 storageKey 回归测试（20/20 逐字节一致）
对 19 个 URL（含真实项目 ref、大小写、连字符/下划线、端口、路径、查询、片段、IDN、localhost、IP 等）+ 1 项"path/query 不影响 storageKey"断言，逐一比对 `parseSupabaseConfig().storageKey` 与旧表达式 `sb-${new URL(url).hostname.split('.')[0]}-auth-token`，**全部逐字节一致**，确认不会导致已登录用户被登出。

### 3.5 启动回归（静态结构，12/12 通过）
对真实 `src/app/_layout.js` 做可重复静态断言：
- 正确导入 `isSupabaseConfigured` / `supabaseConfigErrors`；
- 守卫 `if (!isSupabaseConfigured) return <ConfigErrorView />;` 位于 `<ThemeProvider>` 之前；
- `ConfigErrorView` 不引用 `useAuth`/`useHealthData`/`useAppTheme`/`useRouter`/`useSegments`/`Stack`/`Link`/`router`，仅用 `View`/`Text`；
- 正常分支 Provider 树顺序不变；
- 异常分支不含 `createClient`/`supabase.` 调用。

---

## 4. 与 `06_FINAL_PLAN.md` 约束的逐条对照

| 约束 | 落实情况 |
|---|---|
| 仅修改 3 个批准文件 | ✅ 仅 `supabase.js`、`_layout.js`、`supabaseConfig.js` |
| 仅允许 HTTPS | ✅ `parseSupabaseConfig` 拒绝非 `https://` |
| 保持正常配置业务行为 | ✅ 唯一客户端、auth 选项逐项一致（隔离测试 E 验证） |
| 保持认证存储机制不变 | ✅ `SecureStoreAdapter` 原样保留；`storageKey` 逐字节一致 |
| 异常配置不创建 Client / 不挂 Provider | ✅ 隔离测试 A–D/F + 静态结构测试 |
| 保留既有用户改动 | ✅ `app.json`/`eas.json` 未触碰（见 §5） |
| 无新依赖 / 无 DB 变更 | ✅ 未改 `package.json`、未动 `supabase/` |
| 运行静态检查与回归测试 | ✅ 见 §3 |
| 如实记录通过/失败/未验证 | ✅ 见 §3、§6 |
| 仅交付 2 份评审材料 | ✅ `07_IMPLEMENTATION_REPORT.md`、`08_CODE_DIFF.txt` |
| 不提交/推送/部署 | ✅ 见 §5 |

---

## 5. 合规复核（Git 状态）

```
分支：refactor/phase-0
HEAD：eec78801ff8fd0483e260c413d86756d19e3a911（与基线一致，未产生任何提交）

git status --porcelain：
 M app.json                 ← 任务开始前已存在的用户未提交改动（未触碰）
 M eas.json                 ← 任务开始前已存在的用户未提交改动（未触碰）
 M src/app/_layout.js       ← 本次修改
 M src/services/supabase.js ← 本次修改
?? docs/refactor/           ← 任务文档目录（未跟踪）
?? src/services/supabaseConfig.js ← 本次新增
```

- 本次实施**仅**改动 `src/app/_layout.js`、`src/services/supabase.js`，并新增 `src/services/supabaseConfig.js`。
- `app.json`、`eas.json` 的改动为任务开始前既有用户改动，本次**未做任何修改**，予以完整保留。
- 未执行 `git add` / `commit` / `push` / `merge` / 部署。
- 未修改 `package.json`（无新依赖），未改动 `supabase/`（无 DB 变更）。
- 验证脚本与临时产物均位于 `/tmp`，未进入仓库。

---

## 6. 未验证项与残余风险

| 项 | 状态 | 说明 |
|---|---|---|
| 真机/模拟器"异常配置启动不白屏闪退" | **未验证** | 当前环境无 iOS/Android 设备或模拟器，无法做运行时启动验证；已用静态结构测试 + 隔离测试覆盖其逻辑前提 |
| 真机/模拟器"正常配置启动无回归" | **未验证** | 同上；逻辑上正常分支与修复前一致（Provider 树顺序、auth 选项均未变） |
| 真实网络连通性 | 未验证 | 不在本任务范围（`isSupabaseConfigured` 仅表示本地校验通过） |
| `http://` 本地开发地址 | 设计取舍 | 按批准方案仅允许 HTTPS；若未来需本地 `http://` 联调，需另行评审放开 |

**残余风险**：`supabase` 在异常配置下为 `null`，任何在 Provider 之外直接调用 `supabase.xxx` 的代码路径将抛错。经 T3-C 核验，全部 28 个 `supabase` 引用均位于业务 Provider 子树内，异常分支不挂载 Provider，故不会触达；此结论已在 T3-C 文档记录。

---

## 7. 回滚方式

> ⚠️ **T6 更正（R2）**：原版本此处写 `git checkout -- src/services/supabase.js src/app/_layout.js`，
> 该命令会把文件回退到 HEAD，**从而丢弃 T4 之前就已存在的未提交改动**（`src/services/supabase.js`
> 在 T4 之前已有用户本地修改）。该策略已废弃，请使用下方更正后的策略。

**前置事实**：本任务全程未执行 `git add` / `git commit` / `git push` / `git stash`，所有改动均为
工作区未暂存状态；HEAD 始终为 `eec7880`。

### 推荐方式 A：仅回滚本任务引入的片段（保留既有改动）

1. 删除本任务新增文件（纯新增，删除无副作用）：
   ```bash
   rm -f src/services/supabaseConfig.js
   ```
2. 手工反向应用 `src/services/supabase.js` 与 `src/app/_layout.js` 中本任务引入的片段
   （参考 `08_CODE_DIFF.txt` 的 diff 逐块反向应用）：
   - `supabase.js`：删除 `parseSupabaseConfig` 导入、`const config = ...`、
     `isSupabaseConfigured` / `supabaseConfigErrors` 导出；`AUTH_STORAGE_KEY` 改回原表达式；
     `supabase` 改回无条件 `createClient(...)`。
   - `_layout.js`：删除 `isSupabaseConfigured` / `supabaseConfigErrors` 导入、`ConfigErrorView`、
     `RootLayout` 顶部守卫、`styles`；`import { View, Text, StyleSheet }` 改回 `import { View }`。
3. 验证：`git diff --stat` 应只剩 T4 之前的既有改动。

### 方式 B：用 T4 前的备份整体还原（需先确认备份存在）

```bash
ls -l /tmp/hf01_backup/            # 确认备份存在且时间戳早于 T4
cp /tmp/hf01_backup/supabase.js src/services/supabase.js
cp /tmp/hf01_backup/_layout.js src/app/_layout.js
rm -f src/services/supabaseConfig.js
```

> 备份不存在时禁止使用本方式。

### 方式 C：仅回滚到 HEAD（**会丢失既有未提交改动，不推荐**）

```bash
# 仅在确认这两个文件的既有改动可以丢弃时使用
git checkout -- src/services/supabase.js src/app/_layout.js
rm -f src/services/supabaseConfig.js
```

**禁止事项**：不得使用 `git reset --hard`、`git clean -fd`、`git stash drop` 等会波及其他文件的破坏性命令。

（`app.json`/`eas.json` 的用户改动在任何方式下均不受影响。）

> 完整说明见 [`REVIEW_RESOLUTION.md`](./REVIEW_RESOLUTION.md) §5。

---

## 8. 声明

本次实施严格遵循 `06_FINAL_PLAN.md`，未超出批准范围，未引入新依赖，未改动数据库，未提交/推送/合并/部署。所有测试结果均基于真实源文件与可重复脚本，未验证项已如实标注。**等待独立代码评审。**
