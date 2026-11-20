# Sync — 全项目文档体系重整报告（DOCUMENTATION RESTRUCTURE REPORT）

> 生成时间：2026-11-20
> 执行分支：`refactor/p0.4-stability`
> 停止点：`SYNC DOCUMENTATION RESTRUCTURED — PENDING FINAL REVIEW`
> 本轮仅做文档体系重整与进度同步，**未执行** Git commit / merge / push，**未启动** P1 架构重构。

---

## 1. 重整前后目录树

### 1.1 公开文档 `docs/`（重整后）

```text
docs/
├── README.md                      # 中文索引（四分类）
├── README.en.md                   # 英文索引
├── architecture/
│   ├── ARCHITECTURE_DIAGRAMS.md
│   ├── CODEBASE_MAP.md            # 中文入口
│   └── CODEBASE_MAP.en.md
├── development/
│   ├── DEV_LOG.md
│   ├── ROADMAP_2027_SUMMER.md     # 中文入口
│   ├── ROADMAP_2027_SUMMER.en.md
│   └── TFG_DATA.md
├── operations/
│   ├── DB_SCHEMA_REFERENCE.md     # 中文入口
│   ├── DB_SCHEMA_REFERENCE.zh.md
│   ├── DB_SCHEMA_REFERENCE.en.md
│   ├── RESET_DATABASE.md          # 中文入口
│   ├── RESET_DATABASE.zh.md
│   └── RESET_DATABASE.en.md
└── reference/
    ├── BASELINE.md
    └── REGRESSION.md
```

### 1.2 内部文档 `.internal/`（重整后，已被 git 排除）

```text
.internal/
├── README.md                      # 内部导航（已重写）
├── archive/
│   ├── backups/
│   └── build/
├── audits/
│   ├── DOC_SECURITY_REVIEW.md
│   └── SYNC_APP_ARCHITECTURE_ANALYSIS.md   # 由 docs/specs/ 迁入
├── refactor/
│   └── tasks/
│       ├── TASK-P0.1/             # BASELINE / REGRESSION / 预检 / 源码上下文
│       ├── TASK-P0.1-HF01/
│       ├── TASK-P0.2/
│       ├── TASK-P0.3/
│       ├── TASK-P0.4/             # 含 P0_FINAL_CLOSURE.md
│       └── TASK-DOC-01/
├── repository-reorganization/
└── roadmap/
```

### 1.3 重整前主要问题

- `docs/` 根目录散落 `DB_SCHEMA_REFERENCE.zh.md`、`RESET_DATABASE.zh.md`（未归入 `operations/`）。
- `docs/specs/SYNC_APP_ARCHITECTURE_ANALYSIS.md` 含绝对路径 `/Users/TCL/my-app`，属私有分析，却位于公开 `docs/`（靠 `.git/info/exclude` 临时排除）。
- `.internal/refactor/` 下 P0.1 文档散落、`P0_FINAL_CLOSURE.md` 未归入任务目录、存在空目录 `collaboration/`。
- `.internal/README.md` 严重过时（仍写「P0.3 未开始」）。
- 公开文档存在 42 处相对链接断链。

---

## 2. 旧路径 → 新路径映射表

| 旧路径 | 新路径 | 方式 | 说明 |
| --- | --- | --- | --- |
| `docs/DB_SCHEMA_REFERENCE.zh.md` | `docs/operations/DB_SCHEMA_REFERENCE.zh.md` | `git mv` | 归入运维手册 |
| `docs/RESET_DATABASE.zh.md` | `docs/operations/RESET_DATABASE.zh.md` | `git mv` | 归入运维手册 |
| `docs/specs/SYNC_APP_ARCHITECTURE_ANALYSIS.md` | `.internal/audits/SYNC_APP_ARCHITECTURE_ANALYSIS.md` | `mv` | 私有分析移出公开区，并去除绝对路径 |
| `.internal/refactor/BASELINE.md` | `.internal/refactor/tasks/TASK-P0.1/BASELINE.md` | `mv` | 归档到任务目录 |
| `.internal/refactor/REGRESSION.md` | `.internal/refactor/tasks/TASK-P0.1/REGRESSION.md` | `mv` | 归档到任务目录 |
| `.internal/refactor/02_PREFLIGHT_REPORT.md` | `.internal/refactor/tasks/TASK-P0.1/02_PREFLIGHT_REPORT.md` | `mv` | 归档到任务目录 |
| `.internal/refactor/03_SOURCE_CONTEXT.txt` | `.internal/refactor/tasks/TASK-P0.1/03_SOURCE_CONTEXT.txt` | `mv` | 归档到任务目录 |
| `.internal/P0_FINAL_CLOSURE.md` | `.internal/refactor/tasks/TASK-P0.4/P0_FINAL_CLOSURE.md` | `mv` | 归入 P0.4 任务 |
| `.internal/backups/` | `.internal/archive/backups/` | `mv` | 归档 |
| `.internal/build/` | `.internal/archive/build/` | `mv` | 归档 |
| `.internal/collaboration/`（空） | — | `rmdir` | 删除空目录 |

> 说明：`.internal/` 全部文件均未被 git 跟踪，故使用普通 `mv`（无历史可保留）；两个 `docs/*.zh.md` 为已跟踪文件，使用 `git mv` 保留历史。

---

## 3. 变更计数

| 类别 | 数量 |
| --- | --- |
| 移动（`git mv`，保留历史） | 2 |
| 移动（`.internal` 内部，未跟踪） | 8 项（含 2 个目录） |
| 删除空目录 | 1 |
| 合并 | 0（无真正重复内容需合并） |
| 保留归档（历史证据） | 全部保留，未删除任何历史报告/评审/测试证据 |
| 公开文档修改（本轮 diff） | 14 个文件，+109 / −73 |

---

## 4. README 与关键文档更新清单

| 文档 | 更新内容 |
| --- | --- |
| `README.md`（中文） | 迁移数 29→30、新增迁移 29 表格行、`01→28` 改 `01→29`、Lint 144→142（119e/23w，2 处）、「29 个迁移脚本」→「30 个」（2 处）、新增「开发状态与分支」章节 |
| `README.en.md`（英文） | 同上 7 项事实修正 + 新增 "Development status & branches" 章节，与中文事实一致 |
| `docs/README.md` | 修正 `operations/` 链接指向 `.zh.md`；ROADMAP 行补 `[中文]` 链接 |
| `docs/README.en.md` | 修正 CODEBASE_MAP / ROADMAP 的「中文」链接（原误指 `.md`，补 `.en.md` 自身链接） |
| `.internal/README.md` | 完全重写：准确目录结构、任务目录表、关键留档表、当前阶段状态、分支策略、安全红线 |
| `AGENTS.md` | 安全资料存放路径由已不存在的 `.internal/security/`、`.internal/specs/` 改为实际的 `.internal/audits/`、`.internal/refactor/tasks/<TASK-ID>/`（未改动任何安全规则本身） |

---

## 5. 项目进度同步说明

统一后的状态口径（已写入 README 与 `.internal/README.md`）：

- **P0.3**：已完成并冻结。
- **P0.4**：工程阶段已封存。
- **FIX-A（好友备注）/ FIX-B（放映厅邀请卡片）/ FIX-C（推送诊断）**：均为 **PARTIALLY_FIXED / OWNER_ACCEPTED_RISK**（部分修复，残留问题经项目所有者确认接受风险），**未**写成全部 FIXED。
- **P0 自动化与 DB 测试**：保留原始真实结果与测试环境，未篡改。
- **Sync-Dev（`yfalidyhfqzdwclkveoh`）**：迁移 29 已应用，功能测试通过（依据执行记录）。
- **Sync 生产库（`pjiyniqtrstcpnodsnqq`）**：无执行证据，**未**声称已同步。
- **P1**：下一阶段，尚未正式启动。
- **P2 / P3 / P4**：规划中。

历史报告（P0.3 验收、P0.4 发布、L4 评审等）原始事实一律保留，未为统一措辞而篡改。

---

## 6. 断链修复结果

- 工具：`/tmp/checklinks.mjs`（扫描公开 Markdown 相对链接，剥离 `:line` 后缀并 URL 解码）。
- 修复前：42 处断链。
  - `docs/development/DEV_LOG.md`：35 处 `../src/` → `../../src/`。
  - `docs/operations/RESET_DATABASE.md` / `.en.md`：`../RESET_DATABASE.zh.md` → `RESET_DATABASE.zh.md`。
  - `docs/architecture/CODEBASE_MAP.md` / `.en.md`：`(tabs)` → `%28tabs%29`。
  - `DEV_LOG.md` 第 442 行 `(tabs)` 链接同步修复。
- 修复后：**382 条相对链接，0 断链**（26 个文件）。

---

## 7. 公开 / 内部隔离证明

- `git check-ignore -v .internal/README.md` → `.gitignore:9:.internal/`（已忽略）。
- `git ls-files .internal/ | wc -l` → **0**（无任何内部文件被跟踪）。
- 生产项目 ref `pjiyniqtrstcpnodsnqq` 已从全部公开文档移除（`grep -rn` 结果为空），替换为 `<your-project-ref>`。
- `docs/specs/` 私有分析已移入 `.internal/audits/`，绝对路径 `/Users/TCL/my-app` 已去除。
- 公开文档已跟踪 Markdown 共 **25** 个，均为脱敏后的公开技术文档。

---

## 8. Git Diff 摘要

```text
文档类改动（本轮）：
 AGENTS.md                                 |  2 +-
 README.en.md                              | 30 ++++++++++---
 README.md                                 | 30 ++++++++++---
 docs/README.en.md                         |  8 ++--
 docs/README.md                            |  6 +--
 docs/architecture/CODEBASE_MAP.en.md      |  2 +-
 docs/architecture/CODEBASE_MAP.md         |  2 +-
 docs/development/DEV_LOG.md               | 70 +++++++++++++++----------------
 docs/operations/DB_SCHEMA_REFERENCE.en.md |  4 +-
 docs/operations/DB_SCHEMA_REFERENCE.md    |  4 +-
 docs/operations/DB_SCHEMA_REFERENCE.zh.md | 18 ++++----
 docs/operations/RESET_DATABASE.en.md      |  2 +-
 docs/operations/RESET_DATABASE.md         |  2 +-
 docs/operations/RESET_DATABASE.zh.md      |  2 +-
 14 files changed, 109 insertions(+), 73 deletions(-)
```

- `git status` 中的 `src/`（5 个文件）与 `tests/`、`supabase/migrations/29_*`、`supabase/config.toml` 改动均为**上一轮 P0.4 既有工作**，非本轮文档任务产生，本轮未触碰任何生产代码。
- 两个 `RM` 条目为 `git mv` 重命名（`docs/*.zh.md → docs/operations/*.zh.md`）。

---

## 9. 待确认事项

1. **Sync 生产库同步**：本仓库无生产库执行证据，文档未声称已同步；如需记录，请提供执行报告后再补写。
2. **Sync-Dev 具体完成清单**：本轮依据既有执行记录写「迁移 29 已应用、功能测试通过」；如需逐条 SQL 清单，请提供执行报告。
3. **分支合并**：`main` 与 `refactor/phase-0` 均存在（本地 + 远程），但 P0 成果**尚未合并进 `main`**；合并动作待文档重整最终确认后按既定策略执行。
4. **ROADMAP_2027_SUMMER**：为 2026-11-02 生成的历史规划文档，保留原样，未改写其历史口径。

---

## 停止点

```text
SYNC DOCUMENTATION RESTRUCTURED — PENDING FINAL REVIEW
```

本轮未执行 Git commit / merge / push，未启动 P1 架构重构。待文档重整获得最终确认后，再按既定策略将 P0 成果整合进 `main`，并在 `refactor/phase-0` 上继续 P1 开发。
