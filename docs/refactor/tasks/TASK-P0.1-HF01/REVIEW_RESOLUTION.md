# TASK-P0.1-HF01 — T6 修复与回归验证报告（REVIEW_RESOLUTION）

- 任务：TASK-P0.1-HF01 / Supabase 启动防御修复 — T6 复审问题修复与回归验证
- 分支：`refactor/phase-0`
- 基线 HEAD：`eec78801ff8fd0483e260c413d86756d19e3a911`（未变更）
- 执行日期：2026-11-16
- 复审来源：`GPT_CODE_REVIEW`（结论 B：少量修正后复审）、`GEMINI_CODE_REVIEW`（APPROVE，要求补运行期验证）
- 结论：**R1 / R2 / R3 / R4 全部处理完毕；自动化回归 89/89 通过；tsc 0 错误；ESLint 与基线一致（144 problems，无新增）。运行期冷启动验证已由项目负责人人工完成，19/19 全部通过（见 §11）。HF01 已批准结束。**

---

## 1. 复审问题处理总览

| 编号 | 来源 | 问题 | 处理 | 状态 |
|------|------|------|------|------|
| R1 | GPT | hostname 首段为空时生成 `sb--auth-token` 脏 storageKey（如 `https://.example.com`） | `supabaseConfig.js` 增加 hostname 首段非空校验，命中即 `INVALID_URL` | ✅ 已修复 |
| R2 | GPT | 实施报告中的回滚策略会覆盖 T4 之前既有的未提交改动 | 本文件 §5 给出不丢失既有改动的回滚策略；`07_IMPLEMENTATION_REPORT.md` §7 同步更正 | ✅ 已修复 |
| R3 | GPT | Key 内嵌控制字符（CR/LF/NUL 等）未被拒绝，运行期在 HTTP Headers 构造处抛错 | 新增 `INVALID_KEY` 错误码 + `CONTROL_CHARS` 拒绝规则 | ✅ 已修复 |
| R4 | GPT | 测试证据不可重复留存；`EXPO_PUBLIC_*` 注释误导为"安全读取密钥" | 新增可重复最小回归脚本 `regression/run_all.mjs`；更正源码注释 | ✅ 已修复 |

---

## 2. R1 — hostname 首段为空

### 2.1 缺陷复现（修复前）

| 输入 URL | 修复前结果 | 修复前 storageKey |
|----------|-----------|-------------------|
| `https://.example.com` | `ok: true` | `sb--auth-token` ❌ |
| `https://..example.com` | `ok: true` | `sb--auth-token` ❌ |
| `https://.` | `ok: true` | `sb--auth-token` ❌ |

影响：`sb--auth-token` 是一个跨项目共享的脏 key，多个错误配置会互相覆盖/污染认证存储，且与 SDK 默认规则不一致。

### 2.2 修复内容

[`src/services/supabaseConfig.js`](../../../../src/services/supabaseConfig.js:78)：

```js
// hostname 必须存在，且首段（第一个 '.' 之前）非空。
// 否则会生成 "sb--auth-token" 这类脏 storageKey（如 https://.example.com）。
const hostnameFirstLabel = parsed.hostname
  ? parsed.hostname.split('.')[0]
  : '';
if (!parsed.hostname || !hostnameFirstLabel) {
  errors.push(CONFIG_ERROR.INVALID_URL);
}
```

### 2.3 修复后验证

| 输入 URL | 结果 | 错误码 | 是否返回 storageKey |
|----------|------|--------|---------------------|
| `https://.example.com` | `ok: false` | `INVALID_URL` | 否 |
| `https://..example.com` | `ok: false` | `INVALID_URL` | 否 |
| `https://.` | `ok: false` | `INVALID_URL` | 否 |
| `https://abc.example.com` | `ok: true` | — | `sb-abc-auth-token`（正常） |

---

## 3. R3 — Key 内嵌控制字符

### 3.1 缺陷复现（修复前）

**解析层**：含 LF / CR / TAB / NUL 的 key 均返回 `ok: true`。

**真实 SDK 层**（`@supabase/supabase-js` 2.118.0 + `@supabase/auth-js` 2.118.0）：

| Key 内容 | `createClient` 构造 | 写入 HTTP Headers 时 |
|----------|---------------------|----------------------|
| 含 LF (`\n`) | 成功（不抛错） | ❌ `TypeError: Headers.append: "..." is an invalid header value` |
| 含 CR (`\r`) | 成功（不抛错） | ❌ `TypeError: Headers.append: "..." is an invalid header value` |
| 含 NUL (`\u0000`) | 成功（不抛错） | ❌ `TypeError: Headers.append: "..." is an invalid header value` |
| 含 TAB (`\t`) | 成功（不抛错） | ✅ 被接受（HTTP 规范允许 HTAB） |

结论：`createClient` 构造期不校验，错误被推迟到首次请求的 Headers 构造处，表现为运行期崩溃且堆栈难以定位。因此必须在解析阶段拒绝控制字符。

> 说明：TAB 虽被 Headers 接受，但它在配置值中无合法语义，且极易是复制粘贴污染，故一并拒绝（`\u0000-\u001f` 覆盖 TAB）。这是"拒绝明显非法输入"，不是"校验 JWT 格式"。

### 3.2 修复内容

[`src/services/supabaseConfig.js`](../../../../src/services/supabaseConfig.js:25) 新增错误码：

```js
export const CONFIG_ERROR = Object.freeze({
  MISSING_URL: 'MISSING_URL',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_URL: 'INVALID_URL',
  INVALID_PROTOCOL: 'INVALID_PROTOCOL',
  INVALID_KEY: 'INVALID_KEY',
});
```

[`src/services/supabaseConfig.js`](../../../../src/services/supabaseConfig.js:31) 新增常量：

```js
// 控制字符（C0 0x00-0x1F 与 DEL 0x7F）。
// 依据：真实 SDK 在把 key 写入 HTTP Headers 时，含 CR/LF/NUL 的值会触发
//   TypeError: Headers.append: "..." is an invalid header value.
// 为避免"配置看似合法、运行期才在请求头构造处抛错"，在解析阶段直接拒绝。
// 注意：仅拒绝控制字符，不校验 JWT 结构、不做凭据真实性验证（不在本任务范围）。
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
```

[`src/services/supabaseConfig.js`](../../../../src/services/supabaseConfig.js:55) 新增校验：

```js
// Key 内嵌控制字符（CR/LF/NUL 等）→ INVALID_KEY。
// 仅当 key 非空时检查，避免与 MISSING_KEY 重复。
if (key && CONTROL_CHARS.test(key)) {
  errors.push(CONFIG_ERROR.INVALID_KEY);
}
```

### 3.3 修复后验证

| Key 内容 | 结果 | 错误码 | 是否返回 key |
|----------|------|--------|--------------|
| 含 LF | `ok: false` | `INVALID_KEY` | 否 |
| 含 CR | `ok: false` | `INVALID_KEY` | 否 |
| 含 NUL | `ok: false` | `INVALID_KEY` | 否 |
| 含 TAB | `ok: false` | `INVALID_KEY` | 否 |
| 含 DEL (`\u007f`) | `ok: false` | `INVALID_KEY` | 否 |
| 正常 JWT 形态（`eyJ...`） | `ok: true` | — | 是 |
| 含 `.` `-` `_` 的 key | `ok: true` | — | 是 |
| 空 key | `ok: false` | 仅 `MISSING_KEY`（不重复报 `INVALID_KEY`） | 否 |

**明确未做（按任务边界）**：不校验 JWT 结构、不校验 base64 合法性、不做服务端凭据真实性验证。

---

## 4. R4 — 测试证据留存与注释更正

### 4.1 可重复最小回归脚本

新增 [`docs/refactor/tasks/TASK-P0.1-HF01/regression/run_all.mjs`](./regression/run_all.mjs)：

- 纯 Node ESM，**不引入任何测试框架**，无新增依赖。
- 单命令运行：`node docs/refactor/tasks/TASK-P0.1-HF01/regression/run_all.mjs`
- 退出码：全通过 `0`，任一失败 `1`（可直接接入 CI）。
- 自建临时沙箱（`fs.mkdtempSync`）并在 `finally` 中 `fs.rmSync` 清理，不污染仓库、不触碰真实 `.env`。
- 四个分区：
  - **A** 配置解析契约（含 R1 / R3 边界用例）
  - **B** 客户端隔离（真实 `supabase.js` + stub 模块，子进程隔离，统计 `createClient` 与存储调用次数）
  - **C** storageKey 逐字节回归（19 个 URL + path/query 不影响）
  - **D** RootLayout 静态结构（守卫位置、ConfigErrorView 纯净性、Provider 顺序）

### 4.2 注释更正

[`src/services/supabase.js`](../../../../src/services/supabase.js:9) 原注释「从环境变量中安全读取密钥，防御 GitHub 自动化抓取」具有误导性（暗示 `EXPO_PUBLIC_*` 是秘密存储）。已更正为：

```js
// 从环境变量读取 Supabase 公开客户端配置。
// 注意：EXPO_PUBLIC_* 会被 Expo 在打包时内联进客户端产物，属于"公开配置"，
// 并非秘密存储；真正的访问控制依赖数据库 RLS 与密钥轮换，切勿在此放置
// 服务端私密密钥（如 service_role key）。
// 另：必须直接读取静态属性 process.env.EXPO_PUBLIC_*，Expo 才能做静态替换；
// 不要改为动态取值（如 process.env[name]）。
```

---

## 5. R2 — 回滚策略更正（不丢失既有未提交改动）

### 5.1 原策略的问题

`07_IMPLEMENTATION_REPORT.md` §7 原写：

```bash
git checkout -- src/services/supabase.js src/app/_layout.js
```

**该命令会把这两个文件回退到 HEAD 版本，从而丢弃 T4 之前就已存在的未提交改动**（`src/services/supabase.js` 在 T4 之前已有用户本地修改）。这是不可接受的数据丢失风险。

### 5.2 更正后的回滚策略

**前置事实**：本任务全程未执行 `git add` / `git commit` / `git push` / `git stash`，所有改动均为工作区未暂存状态；HEAD 始终为 `eec7880`。

**推荐回滚方式（按风险从低到高，任选其一）：**

#### 方式 A（推荐）：仅回滚本任务新增/修改的部分，保留既有改动

1. 删除本任务新增文件（纯新增，删除无副作用）：
   ```bash
   rm -f src/services/supabaseConfig.js
   ```
2. 手工还原 `src/services/supabase.js` 与 `src/app/_layout.js` 中**本任务引入的片段**：
   - `supabase.js`：删除 `import { parseSupabaseConfig } from './supabaseConfig';`、`const config = ...`、`isSupabaseConfigured` / `supabaseConfigErrors` 导出、`AUTH_STORAGE_KEY` 改为原表达式、`supabase` 改回无条件 `createClient(...)`。
   - `_layout.js`：删除 `isSupabaseConfigured` / `supabaseConfigErrors` 导入、`ConfigErrorView` 函数、`RootLayout` 顶部守卫、`styles` 常量，并把 `import { View, Text, StyleSheet }` 改回 `import { View }`。
   - 参考 [`08_CODE_DIFF.txt`](./08_CODE_DIFF.txt) 中的 diff 逐块反向应用。
3. 验证：`git diff --stat` 应只剩 T4 之前的既有改动。

#### 方式 B：用备份文件整体还原（需确认备份存在）

若 T4 开始前已按流程创建备份 `/tmp/hf01_backup/`，则：

```bash
ls -l /tmp/hf01_backup/            # 先确认备份存在且时间戳早于 T4
cp /tmp/hf01_backup/supabase.js src/services/supabase.js
cp /tmp/hf01_backup/_layout.js src/app/_layout.js
rm -f src/services/supabaseConfig.js
```

> ⚠️ 注意：备份是 T4 开始前的快照，还原后即回到"未修复"状态，且**不会**丢失 T4 之前的既有改动。若备份不存在，禁止使用本方式。

#### 方式 C：仅回滚到 HEAD（**会丢失既有未提交改动，不推荐**）

```bash
# 仅在确认 src/services/supabase.js 与 src/app/_layout.js 的既有改动可以丢弃时使用
git checkout -- src/services/supabase.js src/app/_layout.js
rm -f src/services/supabaseConfig.js
```

**禁止事项**：不得使用 `git reset --hard`、`git clean -fd`、`git stash drop` 等会波及其他文件的破坏性命令。

### 5.3 回滚后验证清单

```bash
git status --porcelain          # 应无 supabaseConfig.js；supabase.js/_layout.js 仅剩既有改动
npx tsc --noEmit                # 0 错误
npx expo lint                   # 144 problems（基线）
```

---

## 6. 回归验证结果

### 6.1 回归脚本执行

```
$ node docs/refactor/tasks/TASK-P0.1-HF01/regression/run_all.mjs
...
===== 结果：通过 89 / 失败 0 / 合计 89 =====
```

**89/89 全部通过。** 覆盖关系：

| 分区 | 断言数 | 覆盖内容 | 与 T4 阶段的关系 |
|------|--------|----------|------------------|
| A 配置解析契约 | 40 | 缺失/空白/http/ftp/无 scheme/非法 URL/内嵌凭据/合法/大写/trim + R1 边界 + R3 边界 | 覆盖 T4 的配置解析断言，并新增 R1/R3 边界 |
| B 客户端隔离 | 22 | 异常 6 场景不构造客户端、不读写存储；正常场景恰好 1 次构造且 Auth Options 完整 | 覆盖 T4 的 42 条隔离断言（按场景合并计数） |
| C storageKey 回归 | 20 | 19 个 URL + path/query 与旧表达式逐字节一致 | 与 T4 的 20 条完全对应 |
| D RootLayout 静态结构 | 12 | 守卫位置、ConfigErrorView 纯净性、Provider 顺序、异常分支无 createClient | 与 T4 的 12 条完全对应 |

#### 6.1.1 数量统计更正说明

T4 阶段曾以「94 项断言」表述（20 + 42 + 20 + 12，由 4 个临时脚本分散执行）。T6 将其合并为单一可重复脚本 [`regression/run_all.mjs`](./regression/run_all.mjs)，并对 B 分区同类断言按场景合并计数，因此**当前脚本的断言总数为 89**。

- **89 是当前唯一有效的自动化断言数**，请以本数字为准。
- 89 与 94 的差异**仅来自断言粒度的合并**（例如 B 分区原「每个场景 7 条独立断言」合并为按场景计数），**覆盖的语义点完全一致**，且新增了 R1 / R3 边界用例。
- T4 的 94 项在当时已全部通过；合并后的 89 项在 T6 再次全部通过。
- 另有**项目负责人人工运行验收 19/19**（见 §11），与自动化断言互补，**不重复计入 89**。

### 6.2 关键断言明细（节选）

**B 分区 — 异常配置不构造客户端、不操作存储：**

```
✅ B1 isSupabaseConfigured=false
✅ B1 supabase=null
✅ B1 createClient 0 次
✅ B1 存储读写 0 次
✅ B2 仅缺 key → 不构造
✅ B3 http → 不构造
✅ B4 非法 URL → 不构造
✅ B5 R1 空首段 → 不构造
✅ B6 R3 控制字符 key → 不构造
```

**B 分区 — 正常配置行为不变：**

```
✅ B7 createClient 恰好 1 次
✅ B7 storageKey 逐字节一致
✅ B7 autoRefreshToken=true
✅ B7 persistSession=true
✅ B7 detectSessionInUrl=false
✅ B7 storage 为适配器
✅ B7 构造期存储读写 0 次
```

**C 分区 — storageKey 逐字节回归（19 个 URL 全部一致）：**

```
✅ C https://pjiyniqtrstcpnodsnqq.supabase.co → 与旧表达式一致
✅ C https://a.b.c.d.example.com → 与旧表达式一致
✅ C https://ref.supabase.co:443 → 与旧表达式一致
✅ C https://ref.supabase.co/some/path → 与旧表达式一致
✅ C https://xn--fiqs8s.example.com → 与旧表达式一致
✅ C https://localhost → 与旧表达式一致
✅ C https://127.0.0.1 → 与旧表达式一致
...（共 19 个 URL + 1 条 path/query 断言）
```

### 6.3 静态检查

| 检查项 | 命令 | 结果 | 基线 | 判定 |
|--------|------|------|------|------|
| TypeScript | `npx tsc --noEmit` | 退出码 0，无输出 | 0 错误 | ✅ 零错误 |
| ESLint | `npx expo lint` | 144 problems（119 errors, 25 warnings） | 144 problems（119/25） | ✅ 无新增 |

> ESLint 的 119 errors / 25 warnings 全部为既有问题（集中在 `mediaCache.js` 等未改动文件），本任务未引入任何新问题。

### 6.4 正常配置行为不变确认

| 项目 | 修复前 | 修复后 | 判定 |
|------|--------|--------|------|
| `storageKey` | `sb-${hostname.split('.')[0]}-auth-token` | 同一表达式（由 `parseSupabaseConfig` 计算） | ✅ 逐字节一致 |
| `storage` | `SecureStoreAdapter` | `SecureStoreAdapter` | ✅ 不变 |
| `autoRefreshToken` | `true` | `true` | ✅ 不变 |
| `persistSession` | `true` | `true` | ✅ 不变 |
| `detectSessionInUrl` | `false` | `false` | ✅ 不变 |
| `createClient` 调用次数 | 1 | 1 | ✅ 不变 |

### 6.5 异常配置行为确认

| 项目 | 修复前 | 修复后 | 判定 |
|------|--------|--------|------|
| 模块加载 | 顶层 `new URL(undefined)` 抛 TypeError → 白屏闪退 | 不抛错，`supabase = null` | ✅ 已修复 |
| `createClient` 调用 | 抛错前不执行 | 0 次 | ✅ 不构造 |
| 认证存储读写 | 不执行 | 0 次 | ✅ 不操作 |
| 网络请求 | 不执行 | 0 次 | ✅ 不发请求 |
| UI | 白屏 | `ConfigErrorView` 错误页 | ✅ 已修复 |

---

## 7. 运行期冷启动验证（未验证项）

### 7.1 环境探测结果

| 探测项 | 命令 | 结果 |
|--------|------|------|
| iOS 已启动模拟器 | `xcrun simctl list devices booted` | 无 booted 设备 |
| Android 已连接设备 | `adb devices` | 无设备 |
| Xcode | `xcodebuild -version` | Xcode 27.2 (27B52) 已安装 |
| 可用 iPhone 模拟器 | `xcrun simctl list devices available` | 5 个（未启动） |
| 原生工程目录 | `ls -d ios android` | 均不存在（CNG 生成） |
| 本地 `.env` | `ls .env` | 存在，含 `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` |

**结论**：本机具备 Xcode 与模拟器镜像，但**无已启动设备**，且 `ios/` 目录不存在（需先 `npx expo run:ios` 做一次原生构建，耗时较长且会生成 `ios/` 目录）。按任务约束"不扩大改动范围、不修改 app.json/eas.json"，本次**未执行真机/模拟器冷启动**，以下项目标记为**未验证**。

### 7.2 未验证项清单

| 编号 | 未验证项 | 风险等级 | 说明 |
|------|----------|----------|------|
| U1 | 异常配置下错误页实际渲染 | 中 | 静态结构已验证（D 分区），但未在真实 RN 运行时确认 `ConfigErrorView` 可见 |
| U2 | 异常配置下 SplashScreen 正常隐藏 | 中 | 未确认守卫提前 return 是否导致 splash 不消失 |
| U3 | 异常配置下不进入登录页/不触发路由跳转 | 中 | 静态确认守卫在 Provider 之前，但未确认 expo-router 根导航器行为 |
| U4 | 正常配置下已登录用户会话保持（不被登出） | 高 | storageKey 逐字节一致已静态验证，但未做真实冷启动登录态验证 |
| U5 | 正常配置下业务功能（健康/聊天/放映厅）不受影响 | 中 | 未做冒烟测试 |

### 7.3 项目负责人手动验证步骤

> **重要**：以下步骤涉及修改 `.env`。请**先备份**，验证后立即还原。**切勿**用真实用户 Token 做异常配置实验。

#### 准备

```bash
cp .env .env.bak.hf01          # 备份真实配置
```

#### 场景 1：正常配置冷启动（验证 U4 / U5）

```bash
# 1. 保持 .env 为真实有效配置
# 2. 首次构建并启动（会生成 ios/ 目录，属正常 CNG 行为）
npx expo run:ios
# 3. 在 App 内完成一次登录
# 4. 完全杀掉 App（模拟器：Cmd+Shift+H 后上滑关闭）
# 5. 重新冷启动 App
```

**预期**：
- App 正常进入首页，**无需重新登录**（会话保持）。
- 健康打卡、聊天列表、放映厅入口均可正常打开。
- 无白屏、无闪退。

#### 场景 2：缺失配置冷启动（验证 U1 / U2 / U3）

```bash
# 1. 临时清空 URL（保留 key，避免同时触发两个错误码）
#    编辑 .env，把 EXPO_PUBLIC_SUPABASE_URL= 后面清空
# 2. 重启 dev server（必须重启，EXPO_PUBLIC_* 是打包期内联）
npx expo start --clear
# 3. 在模拟器中冷启动 App
```

**预期**：
- 显示「应用配置异常」错误页，含「错误码：MISSING_URL」。
- SplashScreen 正常消失（不卡在启动图）。
- **不**进入登录页，**不**出现白屏或闪退。
- 控制台无 `TypeError: Invalid URL` 之类的未捕获异常。

#### 场景 3：非法协议冷启动（验证 INVALID_PROTOCOL）

```bash
# 编辑 .env：EXPO_PUBLIC_SUPABASE_URL=http://example.supabase.co
npx expo start --clear
```

**预期**：错误页显示「错误码：INVALID_PROTOCOL」。

#### 场景 4：hostname 首段为空（验证 R1 运行期表现）

```bash
# 编辑 .env：EXPO_PUBLIC_SUPABASE_URL=https://.example.com
npx expo start --clear
```

**预期**：错误页显示「错误码：INVALID_URL」，且**不**出现 `sb--auth-token` 相关存储写入。

#### 场景 5：Key 含控制字符（验证 R3 运行期表现）

```bash
# 编辑 .env：在 ANON_KEY 末尾追加一个换行（注意：.env 解析可能吞掉行尾换行，
# 更可靠的做法是追加 \t 或使用引号包裹含 \n 的值）
npx expo start --clear
```

**预期**：错误页显示「错误码：INVALID_KEY」，且**不**出现 `Headers.append` 的 TypeError。

#### 还原

```bash
mv .env.bak.hf01 .env           # 还原真实配置
npx expo start --clear          # 重启确认恢复正常
```

---

## 8. 合规性复核

| 约束 | 要求 | 实际 | 判定 |
|------|------|------|------|
| 分支 | 保持 `refactor/phase-0` | `refactor/phase-0` | ✅ |
| HEAD | 不产生新提交 | `eec78801ff8fd0483e260c413d86756d19e3a911`（未变） | ✅ |
| 暂存区 | 不 `git add` | `git diff --cached` 为空 | ✅ |
| Stash | 不使用 | `git stash list` 为空 | ✅ |
| 提交/推送/合并 | 禁止 | 未执行 | ✅ |
| 源码改动范围 | 仅批准文件 | `src/services/supabase.js`、`src/services/supabaseConfig.js`（新增）、`src/app/_layout.js` | ✅ |
| 依赖 | 不新增/不修改 | `package.json` 未改动 | ✅ |
| 数据库 | 不修改 | `supabase/` 未改动 | ✅ |
| `app.json` / `eas.json` | 不修改既有改动 | 保持 T4 之前的既有改动，本任务未触碰 | ✅ |
| 真实 `.env` | 不删除/不覆盖 | 未触碰（仅读取键名用于确认存在性） | ✅ |
| 真实用户 Token | 不用于异常实验 | 未使用 | ✅ |

### 8.1 当前工作区状态

```
$ git status --porcelain
 M app.json
 M eas.json
 M src/app/_layout.js
 M src/services/supabase.js
?? docs/refactor/
?? src/services/supabaseConfig.js
```

- `app.json` / `eas.json`：T4 之前的既有改动，本任务未触碰。
- `src/app/_layout.js` / `src/services/supabase.js`：本任务修改（叠加在既有改动之上）。
- `src/services/supabaseConfig.js`：本任务新增。
- `docs/refactor/`：本任务文档产出。

---

## 9. 交付物清单

| 文件 | 说明 |
|------|------|
| [`REVIEW_RESOLUTION.md`](./REVIEW_RESOLUTION.md) | 本文件：复审问题处理、回归结果、未验证项、回滚策略 |
| [`08_CODE_DIFF.txt`](./08_CODE_DIFF.txt) | 更新后的完整 Git diff + 新增文件源码 |
| [`regression/run_all.mjs`](./regression/run_all.mjs) | 可重复最小回归脚本（R4 要求，无框架） |

> 说明：`regression/run_all.mjs` 是 R4「保留可重复最小回归测试脚本」的直接产物，作为证据留存随文档一并提交；任务要求的两个主交付物为 `REVIEW_RESOLUTION.md` 与 `08_CODE_DIFF.txt`。

---

## 10. 结论

- **R1**：hostname 首段为空已拦截，不再生成 `sb--auth-token`。✅
- **R2**：回滚策略已更正，提供三种方式，默认推荐"仅回滚本任务片段"以保留既有未提交改动。✅
- **R3**：Key 内嵌控制字符已拒绝，新增 `INVALID_KEY`；未越界做 JWT 格式校验。✅
- **R4**：回归脚本可重复、无框架、单命令运行；误导性注释已更正。✅
- **自动化回归**：89/89 通过；tsc 0 错误；ESLint 与基线一致无新增。✅
- **运行期冷启动**：已由项目负责人人工完成，**19/19 全部通过**（见 §11）。✅

**HF01 已批准结束，进入 P0.1 基线冻结。**

---

## 11. 人工运行验收归档（项目负责人）

### 11.1 验收结论

**项目负责人已完成人工运行验收，19/19 全部通过。批准结束 HF01。**

### 11.2 验收明细

| 场景 | 通过/总数 | 覆盖的未验证项 |
|------|-----------|----------------|
| 正常配置启动 | **8/8** | U4（会话保持）、U5（业务功能不受影响） |
| 缺少 URL | **3/3** | U1（错误页渲染）、U2（SplashScreen 正常隐藏）、U3（不进入登录页） |
| 缺少 Key | **3/3** | U1、U2、U3 |
| 非法协议 | **2/2** | U1、U3（`INVALID_PROTOCOL` 错误码展示） |
| 恢复配置与会话保持 | **3/3** | U4（还原 `.env` 后恢复正常、登录态未丢失） |
| **合计** | **19/19** | U1–U5 全部覆盖 |

### 11.3 未验证项状态更新

§7.2 中列出的 5 项未验证项（U1–U5）**已全部由人工验收覆盖并通过**：

| 编号 | 未验证项 | 原状态 | 现状态 |
|------|----------|--------|--------|
| U1 | 异常配置下错误页实际渲染 | ⚠️ 未验证 | ✅ 已验证通过（缺少 URL / 缺少 Key / 非法协议 共 8 项断言） |
| U2 | 异常配置下 SplashScreen 正常隐藏 | ⚠️ 未验证 | ✅ 已验证通过 |
| U3 | 异常配置下不进入登录页/不触发路由跳转 | ⚠️ 未验证 | ✅ 已验证通过 |
| U4 | 正常配置下已登录用户会话保持（不被登出） | ⚠️ 未验证 | ✅ 已验证通过（正常启动 8/8 + 恢复配置 3/3） |
| U5 | 正常配置下业务功能不受影响 | ⚠️ 未验证 | ✅ 已验证通过 |

> §7.3 的手动验证步骤保留，作为后续回归的可复用清单。

### 11.4 证据留存

- 自动化回归脚本：[`regression/run_all.mjs`](./regression/run_all.mjs)（可重复执行，89 项断言）
- 人工验收：由项目负责人执行，结果如上表（19/19）
- 代码差异：[`08_CODE_DIFF.txt`](./08_CODE_DIFF.txt)
