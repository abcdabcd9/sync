# Contributing to Sync

[English](#english) · [中文](#中文)

Thanks for taking the time to contribute.

---

## English

### Before You Start

Read these two files first:

- [`AGENTS.md`](AGENTS.md) — hard rules about Expo versions, commands, and routing conventions
- [`README.md`](README.md) — what works, what doesn't, and how to run the project

> **This repository ships source code only.** There are no prebuilt APK/IPA files. You need your own Supabase project and a local native toolchain.

### Development Environment

| Requirement | Version |
| --- | --- |
| Node.js | 20 or newer |
| Supabase | A project you own (free tier is fine) |
| iOS builds | Xcode (macOS only) |
| Android builds | Android Studio + JDK 17 |

### Setup

```bash
git clone https://github.com/abcdabcd9/sync.git
cd sync
npm install
cp .env.example .env
```

Fill in `.env`:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_GROQ_API_KEY=your-groq-key   # optional
```

Then run the migrations in `supabase/migrations/` in numeric order (`01` → `13`) inside the Supabase SQL Editor. Create the `chat_media` Storage bucket manually — it is a bucket, not a table.

Start the dev server:

```bash
npx expo start
```

Native modules are used (`expo-notifications`, `expo-video`, etc.), so Expo Go won't run the full app. Use a development build:

```bash
npx expo run:ios
npx expo run:android
```

### Pre-Submit Checks

Run both before opening a pull request:

```bash
npx tsc --noEmit
npx expo lint
```

**`npx tsc --noEmit` must exit 0.** This is a hard gate — CI will reject the PR otherwise.

**`npx expo lint` currently reports ~138 issues.** These are all `react-hooks/*` style suggestions introduced by React 19 rules. They are a known baseline and do **not** block a PR. Don't try to fix them all in one go; if your change adds a *new* lint error, fix that one.

### Code Conventions

- **Routing** — every file under `src/app/` is a screen. `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- **Imports** — use `expo-router` for `Link`, `router`, and `useLocalSearchParams`.
- **Expo APIs** — do not write Expo APIs from memory. Check the versioned docs for the SDK in `package.json` first. See [`AGENTS.md`](AGENTS.md).
- **Dependencies** — install with `npx expo install <package>`, never `npm install <package>`. This resolves SDK-compatible versions.
- **Native folders** — `ios/` and `android/` are generated. Never edit them by hand; configure native behavior in `app.json` and config plugins.
- **Language** — the codebase is JavaScript. `src/types/` holds notes for a future TypeScript migration.

### Commit Messages

Use a conventional prefix:

| Prefix | Use for |
| --- | --- |
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `chore:` | Build, tooling, dependency updates |
| `security:` | Security hardening |

Example: `fix(chat): 修复撤回消息后列表不刷新`

### Pull Requests

1. Fork the repo and create a branch from `main`.
2. Keep the change focused — one concern per PR.
3. Describe **what** changed and **why**, not just how.
4. Link the related issue if there is one.
5. Confirm `npx tsc --noEmit` exits 0.

### What to Work On

The README has a section called **"还不能用的功能（诚实清单）"** listing known gaps — placeholder pages, settings that save but do nothing, chat features that are stubs. Any of those is a valid starting point.

### Security

Do **not** open a public issue for security problems. See [`SECURITY.md`](SECURITY.md).

### License

By contributing, you agree that your contributions are licensed under the MIT License (see [`LICENSE`](LICENSE)).

---

## 中文

感谢你愿意花时间贡献代码。

### 开始之前

先读这两个文件：

- [`AGENTS.md`](AGENTS.md) —— Expo 版本相关的硬性约定、命令清单、路由规范
- [`README.md`](README.md) —— 哪些功能能用、哪些不能用、怎么把项目跑起来

> **本仓库只提供源码**，不提供预编译的 APK/IPA。你需要自己的 Supabase 项目和本地原生工具链。

### 开发环境

| 依赖 | 版本 |
| --- | --- |
| Node.js | 20 或更高 |
| Supabase | 你自己的项目（免费额度够用） |
| iOS 构建 | Xcode（仅 macOS） |
| Android 构建 | Android Studio + JDK 17 |

### 初始化

```bash
git clone https://github.com/abcdabcd9/sync.git
cd sync
npm install
cp .env.example .env
```

填写 `.env`：

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_GROQ_API_KEY=your-groq-key   # 可选
```

然后在 Supabase SQL Editor 里按编号顺序（`01` → `13`）执行 `supabase/migrations/` 下的迁移脚本。`chat_media` 是 Storage 桶，不是表，需要手动创建。

启动开发服务器：

```bash
npx expo start
```

项目用了原生模块（`expo-notifications`、`expo-video` 等），Expo Go 跑不全，需要开发构建：

```bash
npx expo run:ios
npx expo run:android
```

### 提交前检查

开 PR 之前跑这两条：

```bash
npx tsc --noEmit
npx expo lint
```

**`npx tsc --noEmit` 必须 exit 0。** 这是硬门禁，CI 会拒绝不通过的 PR。

**`npx expo lint` 目前会报约 138 个问题。** 全部是 React 19 新规则带来的 `react-hooks/*` 风格建议，属于已知基线，**不阻塞 PR**。不要试图一次性全修；如果你的改动**新增**了 lint 错误，把新增的那个修掉即可。

### 代码约定

- **路由** —— `src/app/` 下每个文件都是一个页面，`_layout.tsx` 定义导航器。非路由代码（组件、Hook、工具函数）放在 `src/app/` 之外。
- **导入** —— `Link`、`router`、`useLocalSearchParams` 一律从 `expo-router` 导入。
- **Expo API** —— 不要凭记忆写。先查 `package.json` 里对应 SDK 版本的文档。见 [`AGENTS.md`](AGENTS.md)。
- **依赖** —— 用 `npx expo install <package>` 安装，不要用 `npm install <package>`。前者会解析 SDK 兼容版本。
- **原生目录** —— `ios/` 与 `android/` 是生成产物，绝不手改。原生行为在 `app.json` 和 config plugin 里配置。
- **语言** —— 代码是 JavaScript。`src/types/` 里留了 TypeScript 迁移的说明。

### 提交信息

使用约定式前缀：

| 前缀 | 用途 |
| --- | --- |
| `feat:` | 新功能 |
| `fix:` | 修复 Bug |
| `docs:` | 仅文档 |
| `refactor:` | 既不修 Bug 也不加功能的代码调整 |
| `chore:` | 构建、工具、依赖更新 |
| `security:` | 安全加固 |

示例：`fix(chat): 修复撤回消息后列表不刷新`

### Pull Request

1. Fork 仓库，从 `main` 拉分支。
2. 保持改动聚焦 —— 一个 PR 只做一件事。
3. 说明**改了什么**和**为什么改**，不要只写怎么改。
4. 有关联 Issue 就链上。
5. 确认 `npx tsc --noEmit` exit 0。

### 从哪里入手

README 里有一节叫 **「还不能用的功能（诚实清单）」**，列了已知缺口 —— 占位页、能存不生效的设置、只有壳子的聊天功能。随便挑一个都是合适的起点。

### 安全

安全问题**不要**开公开 Issue。见 [`SECURITY.md`](SECURITY.md)。

### 许可

提交贡献即表示你同意你的贡献以 MIT 协议授权（见 [`LICENSE`](LICENSE)）。
