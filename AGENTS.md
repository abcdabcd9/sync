This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## 工程文档管理规范（强制）

本仓库是**公开仓库**。以下规则对所有人和所有 AI 助手永久生效，不得绕过。

1. **任务过程文档默认内部保管。** 完整的 AI 协同过程文档（任务简报、预检报告、源码上下文、方案提案、评审意见、核验报告、实施记录）一律写入 `.internal/refactor/tasks/<TASK-ID>/`，**不得**提交到公开仓库。
2. **安全资料禁止公开。** 安全审查报告、漏洞分析、未修复风险说明、内部测试报告、逐条 RLS 策略清单与 `USING` / `WITH CHECK` 表达式，一律放 `.internal/audits/` 或 `.internal/refactor/tasks/<TASK-ID>/`，禁止进入公开仓库。
3. **`.internal/` 已被 Git 排除。** 见 [`.gitignore`](.gitignore)。新增内部目录时同步补充排除规则；**`.gitignore` 不会取消已跟踪文件**，若内部文档曾被提交，必须用 `git rm --cached` 移出索引（需项目所有者授权）。
4. **不得删除或覆盖既有工程文档。** 迁移内部文档时先复制、校验完整性（`shasum -a 256`），确认无误后再移除公开目录中的原件。
5. **公开文档必须脱敏。** 任何进入公开仓库的文档，提交前必须通过两项检查：无真实密钥 / token / 用户隐私；无未修复漏洞的详细利用路径。判断性措辞（如「真实可利用」「提权漏洞」）改为中性描述。
6. **对外部 AI 只提供最小必要上下文。** 通过网页或 API 调用外部模型时，只发送完成当前任务所必需的、已脱敏的片段，不上传完整仓库、完整安全报告或内部设计全文。
7. **内部文档本地存储 + 离线加密备份。** 内部资料只保存在本机 `.internal/` 与离线加密备份中，不上传到任何第三方云盘或代码托管平台。
8. **公开技术文档需单独生成并经所有者确认。** 需要公开的基线、回归、架构说明等，必须单独生成脱敏版本，经项目所有者确认后才能提交。
