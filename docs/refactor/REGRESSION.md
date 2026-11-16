# 回归测试清单（REGRESSION）

- 适用基线：`p0.1-baseline`
- 建立日期：2026-11-16
- 用途：后续重构每次改动后必须执行的回归门槛

> 本文件为公开精简版。完整的回归记录（含断言逐条明细、人工验收归档、内部问题清单）保存在内部工程目录，不对外公开。

---

## 1. 一键执行

```bash
# 1) 类型检查（必须 0 退出码）
npx tsc --noEmit

# 2) Lint（不得超过基线 144 problems / 119 errors / 25 warnings）
npx expo lint

# 3) 回归脚本（必须 0 退出码）
node tests/regression/run_all.mjs

# 4) 依赖健康检查（已知既有失败，仅观察是否恶化）
npx expo-doctor
```

---

## 2. 门槛标准

| 检查项 | 命令 | 通过标准 | 基线值 |
|--------|------|----------|--------|
| TypeScript | `npx tsc --noEmit` | 退出码 0，无输出 | 0 错误 |
| ESLint | `npx expo lint` | problems ≤ 144，errors ≤ 119，warnings ≤ 25 | 144（119/25） |
| 回归脚本 | `node tests/regression/run_all.mjs` | 退出码 0，失败数 0 | 全部通过 |
| Expo Doctor | `npx expo-doctor` | 不新增失败检查项 | 19/20（依赖版本落后） |

> **任何一项恶化即视为回归失败，必须修复后再继续。**

---

## 3. 回归脚本结构

脚本：[`tests/regression/run_all.mjs`](../../tests/regression/run_all.mjs)

| 分区 | 覆盖内容 |
|------|----------|
| **A** 配置解析契约 | 缺失 URL/Key、空白、非法协议、无 scheme、非法 URL、内嵌凭据、合法配置、大小写、trim、hostname 边界、Key 控制字符 |
| **B** 客户端隔离 | 异常场景下不构造客户端、不读写存储；正常场景恰好构造一次且 Auth Options 完整 |
| **C** storageKey 回归 | 多种 URL 形态下 storageKey 与旧表达式逐字节一致 |
| **D** RootLayout 静态结构 | 守卫位置、错误视图无 Provider/hook/导航依赖、Provider 树顺序、异常分支无客户端构造 |

### 3.1 脚本特性

- 纯 Node ESM，**无测试框架、无新增依赖**
- 自建临时沙箱（`fs.mkdtempSync`），`finally` 中 `fs.rmSync` 清理
- 子进程隔离执行，统计客户端构造与存储调用次数
- 不读取真实 `.env`，不触碰真实凭据
- 退出码：全通过 `0`，任一失败 `1`

---

## 4. 关键回归点（改动时重点检查）

### 4.1 认证存储兼容性（最高优先级）

任何涉及 `src/services/supabase.js` 或 `supabaseConfig.js` 的改动，必须确认：

```
storageKey === `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
```

否则已登录用户会被登出。C 分区断言专门守护此点。

### 4.2 异常配置不得构造客户端

任何涉及启动流程的改动，必须确认异常配置下：

- 客户端构造次数 = 0
- 认证存储读写次数 = 0
- `supabase === null`
- RootLayout 在 Provider 之前拦截

B 分区 + D 分区断言守护此点。

### 4.3 配置校验边界

- hostname 首段为空 → `INVALID_URL`（不得生成 `sb--auth-token`）
- Key 含控制字符 → `INVALID_KEY`
- 仅允许 `https://`
- 失败时不返回 `url` / `key` / `storageKey`

A 分区断言守护此点。

---

## 5. 人工验收清单（运行期）

自动化脚本无法覆盖真实 RN 运行时，以下需人工验证：

| 场景 | 预期 |
|------|------|
| 正常配置冷启动 | 进入首页，无需重新登录 |
| 缺少 URL | 显示「应用配置异常 / MISSING_URL」，不白屏不闪退 |
| 缺少 Key | 显示「应用配置异常 / MISSING_KEY」 |
| 非法协议（`http://`） | 显示「INVALID_PROTOCOL」 |
| 恢复配置后冷启动 | 恢复正常，登录态未丢失 |

---

## 6. 已知既有问题（不阻断，但需记录）

| 问题 | 数量 | 位置 | 处理计划 |
|------|------|------|----------|
| ESLint errors | 119 | 13 个文件（React Compiler 规则、unused vars） | 后续独立任务清理，CI 已设非阻断 |
| ESLint warnings | 25 | 主要为 `mediaCache.js` 的 `catch (e)` | 同上 |
| 依赖版本落后 | 28 个包 | `package.json` | 后续独立任务用 `npx expo install --fix` 处理，**P0.1 禁止升级** |
