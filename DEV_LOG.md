# DEV_LOG —— Sync App 开发日志

> **用途**：记录每一次开发会话的「做了什么 / 为什么这么做 / 遇到什么坑 / 下一步」。
>
> **为什么存在**：
> 1. **TFG（大四毕设）数据源** —— 争取 Matrícula de Honor 需要「研究性叙事」，而研究需要数据。这份日志就是「AI 辅助开发」这一研究课题的原始实验记录。
> 2. **AI 上下文恢复** —— 每次开新聊天窗口，AI 读这份日志就能接上进度，不用重新解释项目。
> 3. **返工溯源** —— 三个月后想不起「为什么当时这么设计」时，答案在这里。
>
> **写作纪律**：只写事实，不写感想。每条记录必须可验证（有命令、有文件、有数字）。

---

## 记录模板（复制使用）

```markdown
## YYYY-MM-DD ｜ 会话标题

**目标**：（一句话）

**实际完成**：
- [ ] 事项 1（文件 / 命令）
- [ ] 事项 2

**关键决策**：
- 决策内容 → 理由 → 被否决的替代方案

**遇到的问题**：
- 现象 → 根因 → 解决方式 → 耗时

**数据**：
- 代码行数变化：+X / -Y
- 新增文件：N 个
- 验收结果：tsc ✅/❌ ｜ lint ✅/❌ ｜ doctor ✅/❌

**下一步**：
```

---

## 2026-10-30 ｜ 重构前基线（Pre-Refactor Baseline）

**目标**：在动任何代码之前，建立可回滚的基线，并完成密钥安全审计。

**实际完成**：
- [x] 密钥审计（4 项扫描全部通过）
- [x] 建立本文件 `DEV_LOG.md`
- [x] 记录重构前基线（tsc / lint / doctor）
- [x] 提交 `chore: pre-refactor baseline`
- [x] 打 tag `stage-0-baseline`

**关键决策**：

| 决策 | 理由 | 被否决的方案 |
|---|---|---|
| 重构前先打 tag 而非直接开干 | 七阶段重构涉及 40+ 文件改动，必须有「一键回到原点」的能力 | 只靠 commit hash 记忆（不可靠） |
| 密钥审计放在第一步 | 一旦开源，Git 历史中的密钥无法真正删除（只能改写历史，代价极高） | 开源前再审计（为时已晚） |
| `DEV_LOG.md` 从今天开始写 | TFG 需要「AI 辅助开发」的过程数据，事后补写等于编造 | 毕设前回忆补写（数据不可信） |

**密钥审计结果**（4 项扫描）：

| # | 扫描项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 敏感文件名 | `git ls-files \| grep -iE "\.env\|secret\|credential\|\.p12\|\.p8\|\.pem\|\.key\|keystore\|\.jks\|google-services\.json\|GoogleService-Info\.plist"` | ✅ 0 命中 |
| 2 | 硬编码密钥内容 | `git grep -nIE "service_role\|sk-[A-Za-z0-9]{20,}\|-----BEGIN .*PRIVATE KEY-----\|AIza[0-9A-Za-z_-]{30,}\|eyJhbGciOi..."` | ✅ 4 处命中，**全部为注释或 `Deno.env.get()` 读取**，无真实密钥 |
| 3 | Git 历史 | `git log --all --name-only --diff-filter=A \| grep -iE "^\.env\|\.p12$\|..."` | ✅ 历史干净，从未提交过密钥文件 |
| 4 | 工作区忽略状态 | `git status --porcelain --ignored \| grep -iE "\.env\|..."` | ✅ `.env` / `google-services.json` / `push.json` / `sync.json` 均标记 `!!`（已正确忽略） |

**审计结论**：**当前仓库可安全开源**。客户端仅使用 `EXPO_PUBLIC_SUPABASE_ANON_KEY`（公开 anon key，受 RLS 保护），`service_role` key 仅存在于 Supabase Edge Function 的 `Deno.env` 中，永不下发客户端。

**遇到的问题**：无。

**数据**：
- 新增文件：1 个（`DEV_LOG.md`）
- 代码行数变化：0（本次不改业务代码）
- 验收结果：见下方「基线快照」

**基线快照**（重构前，用于后续对比）：

| 检查项 | 命令 | 结果 | 说明 |
|---|---|---|---|
| 类型检查 | `npx tsc --noEmit` | ✅ **0 错误** | `tsconfig.json` 仅 `extends expo/tsconfig.base`，`compilerOptions` 为空，JS 文件默认不参与严格检查 |
| 代码规范 | `npx expo lint` | ❌ **164 problems（141 errors / 23 warnings）** | 重构前既有状态，非本次引入 |
| 依赖健康 | `npx expo-doctor` | ✅ **20/20 checks passed** | 依赖版本与 SDK 58 完全兼容 |

**Lint 错误分布**（141 errors，按规则）：

| 规则 | 数量 | 性质 |
|---|---|---|
| `react-hooks/refs` | 107 | React 19 新规则：禁止在渲染期读写 ref。旧代码大量使用 `useRef` + 直接赋值 |
| `react-hooks/immutability` | 11 | 修改 hook 返回值（如 `player.currentTime = x`） |
| `react-hooks/exhaustive-deps` | 11 | `useEffect` 依赖数组不完整（warning 级） |
| `react-hooks/set-state-in-effect` | 7 | effect 内直接 `setState` |
| `react-hooks/purity` | 7 | 渲染期执行副作用 |
| `react/display-name` | 5 | 匿名组件缺 `displayName` |
| `react-hooks/rules-of-hooks` | 2 | 条件调用 hook |
| `import/no-unresolved` / `import/namespace` | 2 | `expo-notifications` 的 `AndroidImportance` 命名空间解析失败 |

**Lint 错误分布**（按文件，17 个）：

```
src/app/(tabs)/chat.js          src/app/account_info.js
src/app/auth.js                 src/app/chat_room.js
src/app/cinema.js               src/app/invite_friend.js
src/app/settings.js             src/components/ChatContextMenu.js
src/components/ChatInputBar.js  src/components/CustomTabBar.js
src/components/FloatingPlayer.js src/components/LiquidGlass.js
src/components/MealDetailSheet.js src/components/WaterProgress.js
src/hooks/useCinema.js          src/hooks/useHealthData.js
src/hooks/usePushNotifications.js
```

**基线结论**：
- **141 个 lint error 是重构的「既有债务」，不是重构引入的**。后续每个阶段验收时，只要求「不新增 error」，不要求「清零」。
- 阶段 7（全局收口）才统一处理这些债务，届时大部分文件已被重写，错误自然消失。
- `react-hooks/refs` 占 107/141（76%），说明这是**系统性问题**（React 19 规则升级），不是零散 bug。
- `expo-doctor` 20/20 通过 → **依赖层完全健康，可以放心开始阶段 1**。

**下一步**：阶段 1 —— 地基（常量 / UI 组件 / 依赖），共 14 步。

---

## 阶段进度总览

| 阶段 | 内容 | 状态 | 完成日期 |
|---|---|---|---|
| 0 | 基线 + 密钥审计 | ✅ 完成 | 2026-10-30 |
| 1 | 地基（常量 / 7 个 UI 组件 / flash-list） | ⬜ 未开始 | — |
| 2 | 首页重写 | ⬜ 未开始 | — |
| 3 | 空间页 + 设置页拆分 + 我的页 | ⬜ 未开始 | — |
| 4 | 聊天页纯 IM 化 | ⬜ 未开始 | — |
| 5 | 放映厅拆分 + 搜索大厅 + 浏览器拆分 | ⬜ 未开始 | — |
| 6 | 私密空间 + 朋友圈 | ⬜ 未开始 | — |
| 7 | 全局收口（动效 / 触感 / 性能 / 深色模式） | ⬜ 未开始 | — |

---

## 文档索引

| 文档 | 用途 |
|---|---|
| [`SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](SYNC_APP_REFACTOR_EXECUTION_SPEC.md) | 总纲：需求决策、红线、路由模型、风险矩阵 |
| [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md) | 阶段 1-3 逐行代码细则 |
| [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md) | 阶段 4-7 逐行代码细则 |
| [`SYNC_APP_ARCHITECTURE_DIAGRAMS.md`](SYNC_APP_ARCHITECTURE_DIAGRAMS.md) | 18 张架构图（Mermaid） |
| [`SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md`](SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md) | 关系网络接口预留（多搭子 / 小圈子 / 开放网络） |
| `DEV_LOG.md` | 本文件：开发过程记录 |
