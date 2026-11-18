# 开发基线（BASELINE）

- 基线名称：`p0.1-baseline`
- 建立日期：2026-11-16
- 分支：`refactor/phase-0`

> 本文件为公开精简版。完整的基线记录（含提交明细、检查项逐条结果、内部约束）保存在内部工程目录，不对外公开。

---

## 1. 基线技术栈

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

## 2. 基线检查门槛

| 检查项 | 命令 | 通过标准 |
|--------|------|----------|
| TypeScript | `npx tsc --noEmit` | 退出码 0，无输出 |
| ESLint | `npx expo lint` | problems ≤ 144，errors ≤ 119，warnings ≤ 25 |
| 回归脚本 | `node tests/regression/run_all.mjs` | 退出码 0，失败数 0 |
| Expo Doctor | `npx expo-doctor` | 不新增失败检查项 |

> 任何一项恶化即视为回归失败，必须修复后再继续。

---

## 3. 基线功能状态

| 功能 | 状态 |
|------|------|
| Supabase 正常配置启动 | ✅ 正常 |
| Supabase 配置缺失/非法时启动 | ✅ 显示配置错误页，不白屏、不闪退 |
| 已登录用户会话保持 | ✅ 冷启动不登出 |
| 健康打卡 / 聊天 / 放映厅 | ✅ 正常 |
| 认证存储 | SecureStore（iOS Keychain / Android Keystore），storageKey 逐字节不变 |

---

## 4. 基线约束（后续重构必须遵守）

1. **分支**：后续重构继续在 `refactor/phase-0` 执行；`main` 仅接受 fast-forward 合并。
2. **依赖**：不得在本阶段升级依赖（expo-doctor 的版本落后项为已知既有问题）。
3. **数据库**：不得修改 `supabase/` 下的迁移与函数。
4. **认证存储**：`storageKey` 必须保持 `sb-${hostname 首段}-auth-token` 逐字节一致，任何改动都需回归验证。
5. **回归门槛**：每次改动后必须满足
   - `npx tsc --noEmit` 退出码 0
   - `npx expo lint` 不超过 144 problems（119 errors / 25 warnings）
   - `node tests/regression/run_all.mjs` 退出码 0
6. **CI**：`.github/workflows/ci.yml` 仅在 push/PR 到 `main` 时触发，执行 typecheck（阻断）+ lint（非阻断），**无自动部署**。

---

## 5. 相关文档

- [`REGRESSION.md`](./REGRESSION.md) — 回归测试清单与执行记录
- [`../tests/regression/run_all.mjs`](../../tests/regression/run_all.mjs) — 可重复回归脚本
