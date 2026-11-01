# Sync

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](LICENSE)
[![Expo SDK](https://img.shields.io/badge/Expo%20SDK-58-000020.svg)](https://docs.expo.dev/versions/v58.0.0/)
[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey.svg)](#)
[![Author](https://img.shields.io/badge/author-abcdabcd9-blue.svg)](https://github.com/abcdabcd9)

一个自己写的手机 App，把健康打卡、聊天、放映厅、浏览器塞进了一个壳里。

用 Expo + React Native 写的，后端是 Supabase。

[English](README.en.md) · 中文（当前页）

由 [@abcdabcd9](https://github.com/abcdabcd9) 独立开发 · 联系：tangchengzhi641@gmail.com / tangchengzhi171@gmail.com

> **本项目只开源源码，不提供预编译安装包。**
>
> - 仓库里没有 APK / IPA，也没有上架任何应用商店。
> - 后端（Supabase 项目、数据库、存储桶、Edge Function）需要你自己搭建，本项目不提供公共服务器。
> - 推送通知需要你自己的 Firebase 项目与证书，仓库不包含任何凭据。
>
> 换句话说：这是一份可以自己跑起来的代码，不是一个下载即用的成品 App。

---

## 能干什么

**健康打卡**
喝水、吃饭打卡，连续天数统计。可以绑一个健康搭子，互相看对方的进度。

**聊天**
一对一私聊，文字、图片、视频、语音都能发。语音消息可以转成文字（用的 Groq Whisper）。消息撤回、收藏、置顶、隐藏、清空、聊天背景都是真的。

**空间**

空间页有 4 张卡片，其中 2 张是真能用的：

- 放映厅：视频播放，能开房间同步看电影，带弹幕
- 浏览器：内置 WebView，能拦广告、嗅探网页里的视频直接投到放映厅

另外 2 张（私密空间、朋友圈）目前是占位页，详见下面「还不能用的功能」。

**设置**
个人资料、账号安全、通知、外观模式（浅色/深色）、朋友权限、存储空间、聊天设置、健康与打卡偏好、自动下载、切换账号、退出登录等。其中一部分开关只存不生效，详见下面「还不能用的功能」。

> 上面这些是**真能用的**。下面单独列一份「还不能用的」，免得你踩坑。

---

## 怎么跑起来

需要 Node 20+，一个 Supabase 项目，还有 Android Studio 或 Xcode。

```bash
git clone https://github.com/abcdabcd9/sync.git
cd sync
npm install
cp .env.example .env
```

然后编辑 `.env`，填上你的 Supabase 配置：

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_GROQ_API_KEY=your-groq-key   # 可选，不填的话语音转文字用不了
```

跑起来：

```bash
npx expo run:android
npx expo run:ios
```

> 用了 expo-notifications、expo-video 这些原生模块，Expo Go 跑不全，得用开发构建。
>
> 仓库里**没有** `ios/` 和 `android/` 目录（走 Expo 的 CNG，即 Continuous Native Generation）。`npx expo run:android` / `run:ios` 会先自动生成原生工程再编译，首次会比较慢。**不要手动创建或修改这两个目录**，原生配置一律写在 `app.json` 和 config plugin 里。

数据库那边，把 `supabase/migrations/` 里的 SQL 按文件名顺序在 Supabase SQL Editor 里跑一遍就行。

推送走的是 **Firebase Cloud Messaging（FCM）**。Expo 的推送服务在底层就是转发到 FCM（Android）/ APNs（iOS），所以需要两步：

1. 把 Firebase 的两个配置文件放到项目根目录（已在 `.gitignore` 里，不会进仓库）：
   - `google-services.json`（Android）
   - `GoogleService-Info.plist`（iOS）
2. 部署推送网关 Edge Function：

```bash
npx supabase functions deploy send-push
```

> 没有这两个文件，App 能跑，但拿不到推送 Token，推送会静默跳过。EAS 云端构建时通过 EAS Secret 注入（见 `.gitignore` 里的注释）。
>
> 本地开发时把 `google-services.json` 与 `GoogleService-Info.plist` 放到项目根目录（已在 `.gitignore` 中忽略）。`app.json` 不再引用这两个文件，因此缺少它们也不会导致配置解析失败。

迁移脚本共 19 个，文件名以 `01_` ~ `19_` 编号，**按编号顺序执行**：

| 编号 | 文件 | 作用 |
| --- | --- | --- |
| 01 | `01_消息表加subtype字段_add_message_subtype.sql` | 消息表加 `subtype` 字段，把 `[SYNC_XXX]` 前缀拆成独立列 |
| 02 | `02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql` | 媒体改存相对对象路径 + 按 `user_id` 命名空间收紧 RLS |
| 03 | `03_聊天媒体桶私有化_private_chat_media_bucket.sql` | `chat_media` 桶从 public 改为 private |
| 04 | `04_SyncID修改频率限制触发器_sync_id_limit_trigger.sql` | Sync ID 365 天只能改一次，下沉到服务端触发器 |
| 05 | `05_双向解绑伴侣RPC_unbind_partner_rpc.sql` | 服务端原子完成双向解绑，避免单向残留 |
| 06 | `06_核心表启用RLS基线_enable_all_rls.sql` | 为核心业务表启用 RLS 并写基线策略 |
| 07 | `07_补齐5张核心表_create_core_tables.sql` | 补齐 5 张核心表 + 唯一约束 + 索引 + 注册触发器 + GRANT + Realtime |
| 08 | `08_删除7条全开RLS策略_core_rls_policies.sql` | 删除 7 条 `USING (true)` 危险策略，收紧好友请求越权 |
| 09 | `09_补齐缺失RPC函数_missing_rpcs.sql` | 补齐 `delete_my_account`、`get_server_time` |
| 10 | `10_修复注册时sync_id为空_fix_handle_new_user_sync_id.sql` | 修复注册时 `sync_id` 为 NULL，并回填历史空值 |
| 11 | `11_补齐7张表GRANT授权_grant_table_privileges.sql` | 补 7 张表的表级 GRANT，解决 `permission denied` |
| 12 | `12_开启Realtime实时刷新_enable_realtime_publication.sql` | 把 `messages` / `health_records` 加入 Realtime publication |
| 13 | `13_全部表加入Realtime_all_tables.sql` | 动态遍历 `public` schema，把全部业务表加入 Realtime publication |
| 14 | `14_修复unbind_partner提权风险_harden_unbind_partner.sql` | 修复 `unbind_partner` 的 `SECURITY DEFINER` 提权风险，固定 `search_path` 并收紧执行权限 |
| 15 | `15_收紧profiles敏感列读取_restrict_profiles_sensitive_columns.sql` | 收紧 `profiles` 敏感列（`expo_push_token` / `public_key`）读取，不再对全站登录用户开放 |
| 16 | `16_Realtime白名单_restrict_realtime_publication.sql` | 把 Realtime publication 从「全表动态加入」收敛为显式白名单 |
| 17 | `17_修复chat_media签名读取策略_fix_signed_url_select_policy.sql` | 修复 `createSignedUrl` 返回 `Object not found` 的存储读取策略问题 |
| 18 | `18_会话删除与清空RPC_delete_conversation_rpc.sql` | 新增 `delete_conversation` RPC，让「删除该聊天 / 清空聊天记录」真正落到云端 |
| 19 | `19_会话软删除_仅删我方视角_soft_delete_conversation.sql` | 把会话删除改为**单边软删除**：`messages.deleted_by UUID[]` + GIN 索引，只标记我方已删，对方不受影响 |

> 全部脚本都是幂等的（`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP POLICY IF EXISTS`），重复跑不会出问题。
>
> ⚠️ **迁移 18 与 19 是替代关系，不是叠加关系。** 18 实现的是物理双向 `DELETE`（我删了对方也没了），19 把它改成单边软删除。**新库直接跑 01 → 19 即可**；已有数据的库跑完 19 后，18 定义的旧函数体会被 19 覆盖，无需回滚。

注意：**`chat_media` 是 Storage 桶，不是表。** 建表脚本建不出来，需要在 Dashboard → Storage 里手动建一个名为 `chat_media` 的桶（建议设为 private，策略见 `03_聊天媒体桶私有化_private_chat_media_bucket.sql`）。

注意：**线上已有数据的库，跑 `08_删除7条全开RLS策略_core_rls_policies.sql` 前请先在测试库验证。** 它只删策略不动数据，但 RLS 拦截是静默的——删错策略不会报错，只会让前端拿到空数组。跑完请走一遍「发消息 / 收消息 / 打卡 / 加好友」流程确认。

---

## 技术栈

- Expo SDK 58 / React Native 0.88 / React 19
- Expo Router（文件式路由）
- Supabase（Auth、Postgres、Storage、Realtime、Edge Functions）
- AsyncStorage + expo-secure-store 做本地缓存
- expo-video / expo-audio 做播放
- expo-notifications + Firebase Cloud Messaging（FCM）做推送，经 Expo Push Service 转发

代码是 JavaScript，`src/types/` 里留了 TypeScript 迁移的目录和说明，还没开始转。

---

## 目录大概长这样

```text
src/
├── app/          # 路由，每个文件是一个页面
├── components/   # 组件，ui/ 下面是通用的
├── hooks/        # 按模块分的 Hook
├── services/     # Supabase、推送、媒体缓存
├── constants/    # 颜色、主题、动效、功能开关
├── context/      # 全局 Context（主题等）
├── scripts/      # WebView 注入的脚本（广告拦截、嗅探）
└── types/        # TS 迁移预留目录（当前只有 README）
supabase/
├── functions/    # Edge Function
└── migrations/   # 数据库迁移
```

分层大概是：路由 → 业务组件 → UI 原子 → Hook → Service。数据都是先读本地缓存再请求云端，云端挂了也不会白屏。

---

## 还不能用的功能（诚实清单）

这个项目还在早期阶段，UI 先做出来了，但有一部分功能只有壳子。下面按「坏的程度」分类，全部是实际验证过的。

### 1. 纯占位页（点进去只有一句「即将上线」）

| 页面 | 文件 |
| --- | --- |
| 私密空间 | `src/app/private/index.js` |
| 朋友圈 | `src/app/moments/index.js` |

空间页的 4 张卡片是写死的，不读功能开关，所以这两张卡永远显示，点进去就是占位页。

> 顺带一提：`src/constants/features.js` 里 `privateSpace` / `moments` 都标成了 `true`（注释写着「已实现」），与实际状态不符；而且 `isFeatureOn()` 这个判断函数**目前没有任何地方调用**，整套功能开关是空转的。

### 2. 设置项「能存不生效」

这些开关能点、能存进 AsyncStorage、重启 App 还在，但**没有任何代码去读它们**，所以点了什么都不会发生：

| 设置项 | 位置 |
| --- | --- |
| 听筒模式 | 设置 → 聊天 |
| 消息预览 | 设置 → 聊天 |
| 关怀模式 | 设置 → 更多 |
| 界面语言 | 设置 → 更多 |
| 自动下载图片 / 视频 / 文件 | 设置 → 下载 |
| 允许加我为好友 | 设置 → 隐私 |
| 允许通过 Sync ID 搜到我 | 设置 → 隐私 |
| 朋友圈可见范围 | 设置 → 隐私 |
| 新消息 / 搭子 / 声音通知 | 设置 → 通知 |

原因在 `src/hooks/useAppSettings.js` 的注释里写得很清楚：这个 hook 只负责「存」，不负责「用」，行为接入是后续阶段的事。另外 `useChatMessages.js` 里的自动下载是无条件执行的，根本不看设置。

### 3. 聊天里「点了没用」

| 功能 | 实际情况 |
| --- | --- |
| 视频通话 / 语音通话 | 只弹一个 Alert，让你去用微信打（`ChatRoomInner.js` 的 `handleStartCall`） |
| 黑名单 | 能加入，但发消息、收消息都不检查，拉黑后照样能聊 |
| 星标好友 | 只存了个标记，不影响排序也不影响任何展示 |
| 免打扰 | 只改了会话列表角标样式，推送照样会响 |
| 单个好友的权限设置 | 纯本地 state，不写数据库，退出就没了 |
| 位置消息 | 页面还在（`src/app/chat/location.js`），但聊天输入栏的入口已经删了 |

### 4. 放映厅没有大厅

房间号是本地 `Crypto.randomUUID()` 生成的，没有房间列表、没有大厅，只能靠「邀请好友一起看」把房间号发出去。

### 5. 多账号切换不是真的多开

「切换账号」实际是登出当前账号再跳到登录页，需要你重新输入目标账号的邮箱与密码。不是同时保持多个 session。

> 出于安全考虑（避免明文邮箱落盘），切换时**不再预填邮箱**，只在本机保留账号档案（掩码邮箱 + 昵称 + Sync ID）用于列表展示。详见 `src/hooks/useAccountSwitcher.js` 的注释。

### 6. 其他

- 目前只有简体中文，多语言没做
- 关系网络（多搭子、小圈子）是预留设计，代码里有开关常量但没实现，设计文档在 [`docs/specs/`](docs/specs/) 里
- 项目用 React 19，`npx expo lint` 会报 136 个问题（112 error / 24 warning），基本都是 `react-hooks/*` 新规则的风格建议，不影响运行
- 端到端加密没做（`src/constants/security.js` 里有诚实披露）
- 注销账号依赖的 `delete_my_account` RPC，已在 `09_补齐缺失RPC函数_missing_rpcs.sql` 中补齐，注销流程可用

---

## 参与贡献

提 Issue 或 PR 都欢迎。动手之前先看两件事：

- [`AGENTS.md`](AGENTS.md)：Expo 版本相关的硬性约定（不要凭记忆写 Expo API，先查对应版本的文档）、命令清单、路由规范
- [`docs/README.md`](docs/README.md)：文档索引，改数据库前先读 [`docs/DB_SCHEMA_REFERENCE.md`](docs/DB_SCHEMA_REFERENCE.md)

想找切入点的话，上面「还不能用的功能」那一节列的都是已知缺口，随便挑一个都行。提交前请跑一遍：

```bash
npx tsc --noEmit
npx expo lint
```

`npx expo lint` 目前有 136 个问题（112 error / 24 warning），是 React 19 下 `react-hooks/*` 新规则的风格建议，属于已知基线，不用去修。

---

## 项目亮点

这不是一个「跑通 demo」的项目，下面这些是实际做完的部分：

**数据库层**

- **19 个 Supabase 迁移脚本**，从建表到 RLS 加固，按编号顺序可完整重放
- **7 张核心表全部启用 RLS**：`profiles`、`messages`、`friends`、`friend_requests`、`health_records`、`moments`、`complaints`，没有一张表是裸奔的
- 策略不是「全开」了事：好友申请只有接收方能审批（防自发自批）、健康记录写入带 `WITH CHECK (auth.uid() = user_id)`（防伪造）、动态按 `visibility` 分级可见
- **`SECURITY DEFINER` 函数全部固定 `search_path`**，并收紧为仅 `authenticated` 可执行 —— 这是 PostgreSQL 提权漏洞的经典入口，[`14_修复unbind_partner提权风险_harden_unbind_partner.sql`](supabase/migrations/14_修复unbind_partner提权风险_harden_unbind_partner.sql) 就是专门修这个的
- 聊天媒体桶私有化：`chat_media` 关闭 public 读，改用 4 条细粒度策略 + 签名 URL

**服务端**

- **Edge Function 推送服务**（[`supabase/functions/send-push/index.ts`](supabase/functions/send-push/index.ts)）：校验调用者身份 → 查接收方 Expo Push Token → 批量推送 → 清理失效 token
- Edge Function 内的凭据全部走 `Deno.env.get()`，仓库里没有任何硬编码密钥
  > 注意：语音转文字用的 `EXPO_PUBLIC_GROQ_API_KEY` 是**客户端**变量，会被打进 App 包，属于公开可见的密钥。生产环境建议改由 Edge Function 代理转发，不要把 Groq Key 直接放在客户端。
- 走 Expo Push Service 而非直连 FCM，所以自建者不需要准备 Firebase 证书

**客户端**

- Expo Router 文件式路由，`src/app/` 下 42 个页面文件
- 自研 UI 组件库（`src/components/ui/`），无第三方 UI 框架依赖
- 内置浏览器带广告拦截、媒体嗅探、桌面 UA 伪装（`src/scripts/browser/`）
- 同步放映厅：双端播放进度对齐，带 seek 锁防抖动

**工程化**

- GitHub Actions CI：`tsc --noEmit` 阻断 + ESLint 非阻断（基线已记录在 workflow 注释里）
- 双语 README（[`README.md`](README.md) 为中文，[`README.en.md`](README.en.md) 为英文）、双语 `SECURITY.md`、双语 `CONTRIBUTING.md`
- 文档内所有相对链接均已人工核对，当前 0 断链

---

## 作者

**abcdabcd9** — 独立开发者

- GitHub：[@abcdabcd9](https://github.com/abcdabcd9)
- 联系：tangchengzhi641@gmail.com / tangchengzhi171@gmail.com

这个项目从数据库设计到前端交互都是我一个人写的，包括上面提到的 19 个迁移脚本、Edge Function 推送服务和全部 UI 组件。如果你觉得有用，给个 Star 就是最好的支持。

---

## License

GNU AGPLv3 License — see [`LICENSE`](LICENSE).

本项目以 GNU Affero General Public License v3.0 授权。任何通过网络向用户提供本软件（或其修改版本）服务的组织或个人，必须按 AGPLv3 第 13 条向这些用户提供完整的对应源代码。商业使用需遵守 AGPLv3 条款；如需豁免开源义务的闭源商业授权，请联系作者。
