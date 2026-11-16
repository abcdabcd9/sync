# P0.1 开发基线（BASELINE）

- 基线名称：`p0.1-baseline`
- 建立日期：2026-11-16
- 分支：`refactor/phase-0`
- 基线 commit：`61e08d520d8aa8f5a96fed4520bde97628ed8a18`
- 前置 commit：`37cdf9b33bb71423a03789c61e5215e707f07a67`（app.json / eas.json 既有配置修改）
- 起点 commit：`eec78801ff8fd0483e260c413d86756d19e3a911`（origin/main 同步点）

---

## 1. 基线包含的提交

| # | SHA | 消息 | 内容 |
|---|-----|------|------|
| 1 | `37cdf9b` | `chore: update app version and EAS environments` | `app.json`（version 3.0 → 3.0.1）、`eas.json`（三个 profile 增加 `environment` 字段） |
| 2 | `61e08d5` | `fix: guard Supabase initialization and preserve auth sessions` | `src/services/supabase.js`、`src/services/supabaseConfig.js`（新增）、`src/app/_layout.js`、`docs/refactor/tasks/TASK-P0.1-HF01/regression/run_all.mjs` |

> 说明：Commit 1 是 T4 之前就已存在的用户本地配置改动，按项目负责人指示单独成提交，与 HF01 修复解耦。

---

## 2. 基线技术栈

| 项目 | 版本 |
|------|------|
| Expo SDK | 58（`expo` 58.0.21） |
| React Native | 0.88.1 |
| React | 19.3.0 |
| expo-router | 58.0.28 |
| @supabase/supabase-js | 2.118.0 |
| @supabase/auth-js | 2.118.0 |
| Node（CI） | 20 |
| TypeScript | 见 `package.json` devDependencies |

---

## 3. 基线检查结果（真实退出码）

在基线 commit `61e08d5` 上执行：

| 检查项 | 命令 | 退出码 | 结果 | 判定 |
|--------|------|--------|------|------|
| TypeScript | `npx tsc --noEmit` | **0** | 无输出（零错误） | ✅ 通过 |
| ESLint | `npx expo lint` | **1** | 144 problems（119 errors, 25 warnings） | ⚠️ 既有基线问题，非阻断 |
| Expo Doctor | `npx expo-doctor` | **1** | 19/20 检查通过；1 项失败：依赖版本落后 | ⚠️ 既有问题，非阻断 |
| HF01 回归 | `node docs/refactor/tasks/TASK-P0.1-HF01/regression/run_all.mjs` | **0** | 89/89 通过 | ✅ 通过 |

### 3.1 ESLint 既有问题明细（144 problems）

- 119 errors + 25 warnings，**全部为历史代码风格问题**，分布在 13 个文件。
- 主要规则：React Compiler 相关（refs during render、setState in effect）、`no-unused-vars`（多为 `catch (e)` 未使用）。
- 集中文件示例：`src/services/mediaCache.js`（7 个 warning）。
- **本任务（HF01）未引入任何新问题**：T4 前基线即为 144 problems（119/25），T6 后仍为 144 problems（119/25）。
- CI 中该步骤已设为 `continue-on-error: true`（见 `.github/workflows/ci.yml:34-36`），非阻断。

### 3.2 Expo Doctor 既有问题明细

```
Running 20 checks on your project...
19/20 checks passed. 1 checks failed.

✖ Check that packages match versions required by installed Expo SDK

⚠️ Minor version mismatches
react-native-safe-area-context  ~5.11.1   5.10.1

🔧 Patch version mismatches（共 27 个包）
@expo/metro-runtime  ~58.0.17  58.0.15
expo                 ~58.0.25  58.0.21
expo-asset           ~58.0.21  58.0.19
expo-audio           ~58.0.12  58.0.10
expo-background-fetch ~58.0.13 58.0.11
expo-blur            ~58.0.6   58.0.5
expo-brightness      ~58.0.3   58.0.2
expo-constants       ~58.0.16  58.0.14
expo-crypto          ~58.0.8   58.0.7
expo-dev-client      ~58.0.20  58.0.17
expo-font            ~58.0.12  58.0.11
expo-haptics         ~58.0.8   58.0.7
expo-linear-gradient ~58.0.4   58.0.3
expo-linking         ~58.0.17  58.0.15
expo-location        ~58.0.22  58.0.20
expo-media-library   ~58.0.14  58.0.13
expo-notifications   ~58.1.9   58.1.7
expo-router          ~58.0.31  58.0.28
expo-splash-screen   ~58.0.14  58.0.12
expo-status-bar      ~58.0.5   58.0.4
expo-task-manager    ~58.0.14  58.0.12
expo-updates         ~58.0.22  58.0.19
expo-video           ~58.0.14  58.0.13
expo-video-thumbnails ~58.0.3  58.0.2
react-native-screens ~4.30.1   4.30.0

28 packages out of date.
```

**判定**：这是**基线既有状态**，与 HF01 无关。P0.1 任务明确禁止升级依赖，故**不在本阶段处理**。建议在后续独立任务中用 `npx expo install --fix` 统一升级并单独验证。

---

## 4. 基线功能状态

| 功能 | 状态 |
|------|------|
| Supabase 正常配置启动 | ✅ 正常（人工验收 8/8） |
| Supabase 配置缺失/非法时启动 | ✅ 显示配置错误页，不白屏、不闪退（人工验收 8/8） |
| 已登录用户会话保持 | ✅ 冷启动不登出（人工验收 3/3） |
| 健康打卡 / 聊天 / 放映厅 | ✅ 正常（人工验收覆盖） |
| 认证存储 | SecureStore（iOS Keychain / Android Keystore），storageKey 逐字节不变 |

---

## 5. 基线约束（后续重构必须遵守）

1. **分支**：后续重构继续在 `refactor/phase-0` 执行；`main` 仅接受 fast-forward 合并。
2. **依赖**：不得在本阶段升级依赖（expo-doctor 的 28 项落后为已知既有问题）。
3. **数据库**：不得修改 `supabase/` 下的迁移与函数。
4. **认证存储**：`storageKey` 必须保持 `sb-${hostname 首段}-auth-token` 逐字节一致，任何改动都需回归验证。
5. **回归门槛**：每次改动后必须满足
   - `npx tsc --noEmit` 退出码 0
   - `npx expo lint` 不超过 144 problems（119 errors / 25 warnings）
   - `node docs/refactor/tasks/TASK-P0.1-HF01/regression/run_all.mjs` 退出码 0
6. **CI**：`.github/workflows/ci.yml` 仅在 push/PR 到 `main` 时触发，执行 typecheck（阻断）+ lint（非阻断），**无自动部署**。

---

## 6. 相关文档

- [`REGRESSION.md`](./REGRESSION.md) — 回归测试清单与执行记录
- [`tasks/TASK-P0.1-HF01/REVIEW_RESOLUTION.md`](./tasks/TASK-P0.1-HF01/REVIEW_RESOLUTION.md) — HF01 复审问题处理与人工验收归档
- [`tasks/TASK-P0.1-HF01/08_CODE_DIFF.txt`](./tasks/TASK-P0.1-HF01/08_CODE_DIFF.txt) — 代码差异
- [`tasks/TASK-P0.1-HF01/regression/run_all.mjs`](./tasks/TASK-P0.1-HF01/regression/run_all.mjs) — 可重复回归脚本
