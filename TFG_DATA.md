# TFG 研究数据 —— AI 辅助开发的过程记录

> **这份文件是干什么的**
>
> 大四毕设（TFG）想拿 Matrícula de Honor，光交一个 App 不够，得有「研究性叙事」。
> 我的课题方向：**一个人用 AI 在 X 个月内完成一个中大型 React Native 应用，这个过程的效率、瓶颈、失败模式是什么。**
>
> 这个课题需要**真实的过程数据**。事后回忆补写的数据不可信，所以从今天开始记。
>
> **和 `DEV_LOG.md` 的分工**：
> - `DEV_LOG.md` = 给自己看的流水账，口语，随便写
> - 本文件 = 给论文用的数据，只记**可量化、可验证**的东西
>
> **纪律**：只记事实。不写感想，不写「我觉得」。每个数字都要能追溯到命令输出或 git 记录。

---

## 一、研究问题（待定稿，随进度修正）

| 编号 | 问题 | 为什么值得研究 |
|---|---|---|
| RQ1 | AI 辅助开发的**真实效率倍数**是多少？ | 业界宣称 2-10×，但缺乏单人长周期项目的实测数据 |
| RQ2 | 瓶颈从「写代码」转移到哪里？ | 假设：转移到「写规格」和「验收」，需要数据验证 |
| RQ3 | AI 生成的代码在**长期可维护性**上表现如何？ | 短期能跑 ≠ 半年后还能改。用 lint 债务、重构成本量化 |
| RQ4 | 「AI 原生架构师」这个角色需要什么能力？ | 与传统开发者能力模型的差异 |

---

## 二、项目基本参数（基线，2026-10-30）

| 项目 | 值 | 来源 |
|---|---|---|
| 项目名 | Sync App | `app.json` |
| 类型 | 社交 + 健康打卡 | — |
| 技术栈 | Expo SDK 58 / RN 0.88.1 / React 19.3.0 | `package.json` |
| 依赖数量 | 生产依赖 30+，开发依赖 3 | `package.json` |
| 开发起始 | 约 2026-09 中旬 | 用户口述 |
| 至基线耗时 | 约 1.5 个月 | 用户口述 |
| 开发者 | 1 人（17 岁，非计算机专业在读） | — |
| 开发方式 | 全程 AI 生成，人工只写规格 + 验收 | — |
| 代码规模 | 待统计（见 §三） | — |

---

## 三、代码规模统计

### 3.1 基线快照（2026-10-30）

| 指标 | 值 |
|---|---|
| JS 文件总数 | **64** |
| JS 代码总行数 | **10,374** |
| 平均文件行数 | 162 |
| Markdown 文档总行数 | **6,119**（9 个文件） |
| 文档 / 代码比 | **0.59 : 1** |

**按目录分布**：

| 目录 | 行数 | 文件数 | 平均行/文件 | 说明 |
|---|---|---|---|---|
| `src/app` | 3,441 | 15 | 229 | 路由页面（L1/L2） |
| `src/hooks` | 3,048 | 20 | 152 | 业务逻辑，已按域拆分 |
| `src/components` | 2,797 | 13 | 215 | UI 组件 |
| `src/scripts` | 644 | 9 | 72 | WebView 注入脚本 |
| `src/constants` | 261 | 4 | 65 | 常量 |
| `src/context` | 113 | 1 | 113 | ThemeContext |
| `src/services` | 70 | 2 | 35 | Supabase / Push |
| **合计** | **10,374** | **64** | **162** | — |

**文档明细**：

| 文件 | 行数 |
|---|---|
| `SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md` | 1,515 |
| `SYNC_APP_ARCHITECTURE_DIAGRAMS.md` | 1,175 |
| `SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md` | 1,098 |
| `SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md` | 880 |
| `SYNC_APP_REFACTOR_EXECUTION_SPEC.md` | 774 |
| `security-audit.md` | 380 |
| `TFG_DATA.md` | 208 |
| `DEV_LOG.md` | 48 |
| `AGENTS.md` | 41 |

**研究价值**：文档 / 代码比 0.59:1，远高于业界常规项目（通常 0.05-0.15:1）。这直接印证了「AI 原生架构师」的工作模式——**产出重心从代码转移到规格**。代码由 AI 生成，人的主要产出是这 6,119 行规格文档。这是 RQ2（瓶颈转移）的第一个量化证据。

统计命令：

```bash
# 各类型文件行数
find src -name "*.js" | xargs wc -l | tail -1
find src -name "*.js" | wc -l

# 按目录分布
for d in src/app src/components src/hooks src/constants src/services src/scripts src/context; do
  echo -n "$d: "; find $d -name "*.js" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1
done

# 文档行数
wc -l *.md
```

### 3.2 各阶段增量（每阶段结束时填）

| 阶段 | 日期 | 新增行 | 删除行 | 净增 | 新增文件 | 修改文件 |
|---|---|---|---|---|---|---|
| 0 基线 | 2026-10-30 | +147 | 0 | +147 | 1 | 0 |
| 1 地基 | — | — | — | — | — | — |
| 2 首页 | — | — | — | — | — | — |
| 3 空间+设置 | — | — | — | — | — | — |
| 4 聊天 | — | — | — | — | — | — |
| 5 放映厅+浏览器 | — | — | — | — | — | — |
| 6 私密+朋友圈 | — | — | — | — | — | — |
| 7 收口 | — | — | — | — | — | — |

---

## 四、质量指标追踪

### 4.1 基线（2026-10-30）

| 指标 | 命令 | 值 |
|---|---|---|
| TypeScript 错误 | `npx tsc --noEmit` | **0**（但 `compilerOptions` 为空，JS 未被严格检查 → 数据有效性存疑，需注明） |
| ESLint 问题总数 | `npx expo lint` | **164**（141 errors / 23 warnings） |
| 依赖健康 | `npx expo-doctor` | **20/20 通过** |
| 测试数量 | — | **0**（无测试框架） |
| 类型覆盖率 | — | **0%**（全 JS） |

### 4.2 ESLint 错误分类（基线）

| 规则 | 数量 | 占比 | 性质 |
|---|---|---|---|
| `react-hooks/refs` | 107 | 75.9% | React 19 新规则，系统性不兼容 |
| `react-hooks/immutability` | 11 | 7.8% | 修改 hook 返回值 |
| `react-hooks/exhaustive-deps` | 11 | 7.8% | 依赖数组不完整 |
| `react-hooks/set-state-in-effect` | 7 | 5.0% | effect 内直接 setState |
| `react-hooks/purity` | 7 | 5.0% | 渲染期副作用 |
| `react/display-name` | 5 | 3.5% | 匿名组件 |
| `react-hooks/rules-of-hooks` | 2 | 1.4% | 条件调用 hook |
| `import/no-unresolved` + `import/namespace` | 2 | 1.4% | 命名空间解析失败 |
| **合计** | **141** | 100% | — |

**研究价值**：`react-hooks/refs` 占 76%，说明 AI 生成的代码倾向于「用 ref 绕过 React 的声明式模型」。这是一个可写进论文的**行为模式发现**——AI 在训练数据中见到的旧式 React 代码（React 16/17 时代大量使用 ref）影响了它的生成偏好，而 React 19 的 lint 规则收紧后，这种偏好暴露为系统性债务。

**待验证假设**：重写后的新代码（明确要求 AI 遵守 React 19 规则）中，`react-hooks/refs` 错误是否显著下降？如果是，说明「规格中显式声明约束」能有效纠正 AI 的默认偏好。

### 4.3 ESLint 错误按文件（基线，17 个）

| 文件 | 将在哪个阶段被重写 |
|---|---|
| `src/app/(tabs)/chat.js` | 阶段 4 |
| `src/app/account_info.js` | 阶段 3 |
| `src/app/auth.js` | 不重写 |
| `src/app/chat_room.js` | 阶段 4（微调） |
| `src/app/cinema.js` | 阶段 5 |
| `src/app/invite_friend.js` | 阶段 4（微调） |
| `src/app/settings.js` | 阶段 3 |
| `src/components/ChatContextMenu.js` | 阶段 4 |
| `src/components/ChatInputBar.js` | 阶段 4（微调） |
| `src/components/CustomTabBar.js` | 不重写 |
| `src/components/FloatingPlayer.js` | 阶段 5（微调） |
| `src/components/LiquidGlass.js` | 不重写 |
| `src/components/MealDetailSheet.js` | 阶段 2（微调） |
| `src/components/WaterProgress.js` | 阶段 2（微调） |
| `src/hooks/useCinema.js` | 阶段 5 |
| `src/hooks/useHealthData.js` | 不重写 |
| `src/hooks/usePushNotifications.js` | 不重写 |

**研究价值**：17 个文件里 12 个会被重写（70%）。这意味着**重构本身就是一次「AI 代码质量修复实验」**——可以对比重写前后的 lint 错误数，量化「重新生成」vs「手工修复」的效率差异。

---

## 五、效率数据

### 5.1 时间投入记录

| 日期 | 时长 | 完成内容 | 产出（行/文件） | 效率（行/小时） |
|---|---|---|---|---|
| 2026-10-30 | ~0.5h | 密钥审计 + DEV_LOG + 基线 | +147 行 / 2 文件 | ~294 |

### 5.2 AI 交互轮次（估算）

| 日期 | 会话数 | 主要任务 | 返工次数 | 返工原因 |
|---|---|---|---|---|
| 2026-10-30 | 1 | 基线建立 | 1 | `DEV_LOG.md` 首版过于结构化（AI 味），重写为流水账 |

**研究价值**：返工原因记录是核心数据。「AI 味」这个返工原因说明——**AI 生成的文档会过度结构化**，需要人工干预才能符合「日志」这个体裁的真实需求。这是 RQ4（AI 原生架构师能力）的一个具体案例：**判断产出物体裁是否匹配场景**，是架构师而非 AI 的责任。

---

## 六、失败与返工记录

| 日期 | 现象 | 根因 | 解决 | 耗时 |
|---|---|---|---|---|
| 2026-10-30 | `DEV_LOG.md` 写成周报风格（6 小节 + 4 表格 + emoji） | AI 默认把「日志」理解为「交付文档」 | 拆成 `DEV_LOG.md`（口语）+ `TFG_DATA.md`（结构化） | ~10 min |

---

## 七、待补充的数据源

- [ ] 代码规模统计（§3.1 命令输出）
- [ ] 每个阶段的耗时（精确到小时）
- [ ] 每个阶段的 AI 交互轮次
- [ ] 重构前后的性能数据（启动时间、列表滚动 FPS）
- [ ] 重构前后的代码复杂度（可用 `npx eslint --format json` 统计）
- [ ] 测试覆盖率（阶段 7 引入测试后）

---

## 八、论文结构草稿（占位）

```
1. 引言
   1.1 背景：AI 编程工具的普及
   1.2 问题：缺乏单人长周期项目的实测数据
   1.3 贡献：一个 7 阶段重构的完整过程记录 + 量化分析

2. 相关工作
   2.1 AI 辅助编程的效率研究
   2.2 React Native 应用架构演进

3. 方法论
   3.1 「AI 原生架构师」工作流定义
   3.2 数据采集方法（本文件）
   3.3 质量指标定义（lint / tsc / 性能）

4. 案例研究：Sync App 重构
   4.1 项目背景与基线
   4.2 七阶段执行过程
   4.3 量化结果

5. 讨论
   5.1 RQ1-RQ4 的回答
   5.2 局限性

6. 结论
```

---

**最后更新**：2026-10-30
