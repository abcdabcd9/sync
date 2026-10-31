# docs —— 文档索引

这个目录放 Sync 项目的全部文档。代码在 [`../src/`](../src/)，数据库迁移在 [`../supabase/migrations/`](../supabase/migrations/)。

[English](README.en.md) · [中文](README.zh.md)

## 一、运维手册（照着做就行）

| 文档 | 用途 | 什么时候看 |
| --- | --- | --- |
| [`RESET_DATABASE.md`](RESET_DATABASE.md) · [中文](RESET_DATABASE.zh.md) · [EN](RESET_DATABASE.en.md) | 数据库彻底重置的 6 步手册：清 `auth.users` → 清 7 张业务表 → 清 Storage → 验证全空 → 确认结构未坏 → 清 App 本地缓存 | 想把测试数据全清掉、从零开始验收时 |
| [`DB_SCHEMA_REFERENCE.md`](DB_SCHEMA_REFERENCE.md) · [中文](DB_SCHEMA_REFERENCE.zh.md) · [EN](DB_SCHEMA_REFERENCE.en.md) | 线上 Supabase 的真实结构快照：7 张表的列定义、RLS 策略逐条清单、触发器、RPC、修复优先级 | 改表结构前、排查权限问题、写新迁移前 |

## 二、开发记录

| 文档 | 用途 |
| --- | --- |
| [`DEV_LOG.md`](DEV_LOG.md) | 开发日志：按时间记录每个阶段做了什么、踩了什么坑、怎么修的。排查「这个改动为什么是这样」时先翻这里 |
| [`TFG_DATA.md`](TFG_DATA.md) | 论文/答辩用的项目数据汇总（规模、技术栈、工作量统计） |

## 三、设计文档（`specs/`）

这些是重构前的设计稿，描述的是**目标架构**，不一定等于当前代码。读的时候注意区分「已实现」和「预留设计」。

| 文档 | 内容 |
| --- | --- |
| [`specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md`](specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md) | 架构图：模块分层、数据流、页面关系 |
| [`specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md) | 重构执行方案 第一部分 |
| [`specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md) | 重构执行方案 第二部分 |
| [`specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md) | 重构执行方案 第三部分 |
| [`specs/SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md`](specs/SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md) | 关系网络（多搭子 / 小圈子）的接口预留设计。**当前未实现**，代码里只有开关常量，见该文档 §4 |

## 四、关于 PDF

`docs/` 和 `docs/specs/` 下的 `.pdf` 是上面这些 Markdown 的渲染导出件，**不进 git**（见 [`../.gitignore`](../.gitignore) 里的 `docs/**/*.pdf`）。它们只在你本地存在，克隆仓库的人拿不到。

需要 PDF 时，用 Markdown 源文件重新导出即可，不要把它当成唯一副本。

## 五、新增文档的约定

1. 运维类手册放 `docs/` 根目录，文件名全大写 + 下划线（如 `RESET_DATABASE.md`）。
2. 设计/方案类放 `docs/specs/`。
3. 新增文档后回来更新本索引的表格。
4. 不要在文档里写真实的密钥、密码、项目 ref 之外的敏感信息。
5. 需要双语时，中文版命名为 `NAME.zh.md`，英文版命名为 `NAME.en.md`，并保留 `NAME.md` 作为入口（内容与 `.zh.md` 一致）。三个文件顶部都要有语言切换链接。
