# 2027 暑假执行手册（Sync App）

> **用途**：2027 年暑假开工时，只看这一份文件。不用重读 `docs/specs/` 的 5,457 行，也不用重读桌面那份 HTML 路线图。
> **生成日期**：2026-11-02
> **适用版本**：`1a3aca4`（2026-11-01 停工点）
> **总工期**：39–57 天（按每天 8 小时满产估算），暑假约 70 天，留 13–31 天缓冲

---

## 0. 开工前必读（5 分钟）

### 0.1 先跑这三条命令，确认项目没坏

```bash
git log --oneline -3          # 应该看到 1a3aca4 在最上面
git status                    # 应该是 clean
npx tsc --noEmit              # 必须 0 error
```

如果 `tsc` 报错，先修好再开工。**不要在坏的基础上盖楼。**

### 0.2 三条铁律（违反任何一条，当天回滚）

```text
1. 不得修改 src/constants/colors.js 的任何色值
2. 不得修改 src/constants/theme.js 的 SIZES / TYPOGRAPHY
3. 不得修改 src/context/ThemeContext.js 的对外 API
```

来源：[`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:45) §0.2

### 0.3 装依赖只用这一条命令

```bash
npx expo install <package>
```

**禁止** `npm install` / `yarn add` / `pnpm add` / `bun add`。原因：只有 `expo install` 会解析到 SDK 58 兼容版本。

### 0.4 每个阶段结束必跑

```bash
npx expo lint                 # 目标 0 error（当前基线 136 项，只许降不许升）
npx tsc --noEmit              # 必须 0 error
git diff src/constants/       # 必须为空
```

---

## 1. 总览：六个阶段，按顺序做

| 阶段 | 内容 | 工时 | 风险 | 可砍 |
|---|---|---|---|---|
| **0** | TS 类型契约（`types/` 目录，纯新增） | 3 天 | 极低 | 否 |
| **A** | specs 阶段 1–5（地基 / 首页 / 空间 / 聊天 / 放映厅+浏览器） | 15–20 天 | 中 | 否 |
| **B** | tsconfig strict + 现有代码类型化 | 3–5 天 | 中 | 否 |
| **C** | TanStack Query + MMKV 替换 | 8–12 天 | **高** | 可砍到 5 个页面 |
| **D** | 42 个页面 `.js` → `.tsx` | 10–15 天 | 中 | 否 |
| **E** | FCM 替换 Expo Push | 3–5 天 | 中高 | **可砍** |
| **合计** | | **39–57 天** | | |

### 1.1 为什么是这个顺序（不要改）

```
阶段 0（types/ 纯新增，零风险热身）
    ↓
阶段 A（specs 改「文件在哪」：拆页面、建组件库）
    ↓  ← 到这里文件结构才稳定
阶段 B（tsconfig strict，给现有代码加类型）
    ↓
阶段 C（数据层重构：TanStack Query + MMKV）
    ↓
阶段 D（页面 .js → .tsx）
    ↓
阶段 E（FCM，需要真机）
```

**核心逻辑：先定文件位置，再定文件内容。**

- 阶段 A 会把 [`src/app/(tabs)/chat.js`](../src/app/%28tabs%29/chat.js:1) 拆成 `/chat/index` + `/chat/contacts` + `/chat/search` 三个文件
- 阶段 A 还会拆放映厅和浏览器
- **如果先做 TS 迁移，这些拆分会让迁移工作全部重做**

### 1.2 明确砍掉的东西（不要做）

| 砍掉项 | 原因 |
|---|---|
| RevenueCat 订阅 | 需要真实上架 + App Store 商品配置，2028 年再说 |
| 签名 APK | 需要 Android 签名密钥，且 17 岁无法注册 Google Play 账号 |
| Firebase Crashlytics | 用 Sentry 免费额度替代，更简单 |
| Firebase Analytics | 用户量不够，数据没有统计意义 |

---

## 2. 阶段 0：TS 类型契约（3 天）

### 2.1 目标

在项目根目录建 `types/` 目录，只写接口定义，**不接任何现有代码**。

### 2.2 要建的文件

| 文件 | 内容 |
|---|---|
| `types/user.ts` | 用户实体、`Sync ID`、伴侣配对状态枚举（`Unpaired` / `Pending` / `Paired`） |
| `types/health.ts` | 饮水记录（毫升 / 目标 / 时间戳）、三餐打卡（慢碳 / 蛋白质 / 完成标记） |
| `types/social.ts` | 朋友圈动态（发帖人 / 图片 URL 数组 / 点赞列表 / 评论树） |
| `types/media.ts` | 媒体嗅探结果、SharePlay 房间状态、控制信令（`Play` / `Pause` / `Seek` / `Ping`） |
| `types/index.ts` | 统一导出 |

### 2.3 参考来源

写类型时对照这些真实文件，不要凭空编：

- 用户 / 配对：[`src/hooks/useAuth.js`](../src/hooks/useAuth.js:1)、[`src/app/bind_partner.js`](../src/app/bind_partner.js:1)
- 健康数据：[`src/hooks/health/useHealthStorage.js`](../src/hooks/health/useHealthStorage.js:22)（`KEYS` 常量）、[`src/hooks/useHealthData.js`](../src/hooks/useHealthData.js:1)
- 社交：[`src/app/chat/moments.js`](../src/app/chat/moments.js:1)
- 媒体 / 同步：[`src/hooks/useCinema.js`](../src/hooks/useCinema.js:1)、[`src/hooks/useSyncRoom.js`](../src/hooks/useSyncRoom.js:1)
- 数据库字段：[`docs/DB_SCHEMA_REFERENCE.md`](DB_SCHEMA_REFERENCE.md:1)

### 2.4 验收

```bash
npx tsc --noEmit    # 必须 0 error（types/ 是纯新增，不影响现有代码）
```

- [ ] 5 个文件建好
- [ ] 每个接口都有注释说明对应哪张表 / 哪个 hook
- [ ] `tsc --noEmit` 通过

---

## 3. 阶段 A：specs 阶段 1–5（15–20 天）

### 3.1 读什么

**只读这两份，不要读总纲全文：**

| 阶段 | 读哪一节 |
|---|---|
| 阶段 1 地基 | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:64) §11 |
| 阶段 2 首页 | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:1) §12 |
| 阶段 3 空间+设置 | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:1) §13 |
| 阶段 4 聊天 | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md:19) §14 |
| 阶段 5 放映厅+浏览器 | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md:1) §15 |

**视觉 / 动效规范**（每个阶段都要对照）：[`SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:1) §3、§4

### 3.2 阶段 1 的关键产出（后续全靠它）

| 文件 | 作用 |
|---|---|
| `src/constants/motion.js` | 统一动效参数（`DURATION` / `SPRING` / `EASING` / `SCALE`） |
| `src/constants/haptics.js` | 已有，需扩展分级 |
| `src/components/ui/` | 已有 8 个组件，需按 spec 补齐 |

**唯一新增依赖：**

```bash
npx expo install @shopify/flash-list
```

### 3.3 每个阶段的固定流程

```text
1. 读该阶段 spec 章节
2. 按「改动清单」逐文件改
3. 每改完一个文件 → 保存 → 热重载目视检查
4. 该阶段全部改完 → 跑三条验收命令
5. 真机（iOS + Android）逐页走查：浅色 / 深色 / 动效 / 触感
6. 对照该阶段「验收清单」逐项打勾
7. 全绿 → 进入下一阶段
```

### 3.4 验收

- [ ] 阶段 1：`@shopify/flash-list` 已装，`expo-doctor` 无 error
- [ ] 阶段 2：首页搭子卡 / 饮水 / 2×2 餐食 / 打卡全部可用
- [ ] 阶段 3：空间页 4 卡 + 设置页拆 L3 + 我的页微调完成
- [ ] 阶段 4：聊天页纯 IM 化，联系人 / 搜索加友独立成页
- [ ] 阶段 5：放映厅拆分 + 搜索大厅 + 浏览器拆分完成
- [ ] 每阶段结束 `tsc --noEmit` 通过、`git diff src/constants/` 为空

---

## 4. 阶段 B：tsconfig strict + 现有代码类型化（3–5 天）

### 4.1 目标

把 [`tsconfig.json`](../tsconfig.json:1) 从空配置改成严格模式，然后修掉所有报错。

### 4.2 当前状态

```json
{
  "compilerOptions": {},
  "extends": "expo/tsconfig.base",
  "exclude": ["supabase/functions"]
}
```

### 4.3 要开的选项（按顺序，一次开一个）

```text
1. "strict": true                    ← 最痛，报错最多
2. "noUncheckedIndexedAccess": true  ← 数组访问要判空
3. "noImplicitOverride": true
4. "exactOptionalPropertyTypes": true ← 可选属性不能传 undefined
```

**不要一次全开。** 开一个 → 修完 → 跑 `tsc` → 再开下一个。

### 4.4 如果 `strict: true` 报错超过 200 个

**降级方案**：先只开这几项，`strict` 留到阶段 D 之后：

```json
{
  "compilerOptions": {
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitAny": false
  }
}
```

### 4.5 验收

- [ ] `tsconfig.json` 至少开了 `strictNullChecks`
- [ ] `npx tsc --noEmit` 通过
- [ ] `npx expo lint` 错误数 ≤ 136（当前基线）

---

## 5. 阶段 C：TanStack Query + MMKV 替换（8–12 天，高风险）

### 5.1 这是整条链上唯一可能做不完的环节

**原因**：你现在 42 个页面全是手写 `useEffect` + `useState` + `supabase.from(...)`。换成 TanStack Query 意味着：

- 每个页面的数据获取改成 `useQuery`
- 每个写操作改成 `useMutation`
- 缓存失效逻辑重新设计（`queryClient.invalidateQueries`）
- 乐观更新重写（现在的 `patchMessage` 那套）

**42 个页面 × 平均 2 个查询 = 84 个 query 要改。**

### 5.2 降级方案（重要）

**如果第 5 天还没改完 10 个页面，立刻降级为「只改 5 个核心页面」：**

| 页面 | 文件 |
|---|---|
| 首页 | [`src/app/(tabs)/index.js`](../src/app/%28tabs%29/index.js:1) |
| 聊天列表 | [`src/app/(tabs)/chat.js`](../src/app/%28tabs%29/chat.js:1) |
| 聊天室 | [`src/components/ChatRoomInner.js`](../src/components/ChatRoomInner.js:84) |
| 放映厅 | [`src/app/cinema.js`](../src/app/cinema.js:34) |
| 浏览器 | [`src/app/browser/index.js`](../src/app/browser/index.js:35) |

**TanStack Query 和手写 `useEffect` 可以共存**，不需要一次全换。剩下的页面 2028 年再改。

### 5.3 MMKV 替换

**先确认一件事**：MMKV 需要原生模块，**Expo Go 里跑不了**。

```bash
npx expo install react-native-mmkv
npx expo run:ios      # 必须用 development build，不能用 Expo Go
```

如果不想折腾 development build，**MMKV 可以整个跳过**——`AsyncStorage` 对你的用户量完全够用，换它没有用户可见收益。

### 5.4 验收

- [ ] TanStack Query 已装，`QueryClientProvider` 已挂到 [`src/app/_layout.js`](../src/app/_layout.js:63)
- [ ] 至少 5 个核心页面改用 `useQuery` / `useMutation`
- [ ] 缓存失效逻辑正确（发消息后列表自动刷新）
- [ ] `tsc --noEmit` 通过

---

## 6. 阶段 D：42 个页面 `.js` → `.tsx`（10–15 天）

### 6.1 迁移顺序（从叶子到根）

```text
1. src/constants/        （9 个文件，无依赖）
2. src/components/ui/    （8 个文件，只依赖 constants）
3. src/hooks/            （27 个文件，依赖 services + types）
4. src/services/         （3 个文件）
5. src/components/       （32 个文件，依赖 hooks）
6. src/app/              （42 个文件，最后）
```

**为什么这个顺序**：从叶子往根改，每改一层，上一层的类型就自动推导出来了，不用手写。

### 6.2 每个文件的迁移步骤

```text
1. git mv src/xxx.js src/xxx.tsx
2. 加 Props 接口（组件）或参数类型（hook）
3. 跑 npx tsc --noEmit
4. 修报错（不要用 any 绕过，除非真的无法推导）
5. 真机验证该页面
6. git commit
```

### 6.3 禁止事项

```text
❌ 不要用 any 绕过报错（用 unknown + 类型守卫）
❌ 不要用 @ts-ignore（用 @ts-expect-error + 注释说明原因）
❌ 不要一次改 10 个文件再跑 tsc（一次改 1–2 个）
```

### 6.4 验收

- [ ] `src/` 下无 `.js` 文件（除 `eslint.config.js` 等配置文件）
- [ ] `npx tsc --noEmit` 通过
- [ ] `npx expo lint` 错误数 ≤ 136
- [ ] 真机双端走查全部页面

---

## 7. 阶段 E：FCM 替换 Expo Push（3–5 天，可砍）

### 7.1 先判断要不要做

**当前用的是 Expo Push**（[`src/hooks/usePushNotifications.js`](../src/hooks/usePushNotifications.js:133) 的 `getExpoPushTokenAsync`）。

Expo Push 的局限：**App 被系统杀死后，通知可能延迟或丢失。**

**如果你的用户只有几十个人，这个局限无所谓。** 直接跳过阶段 E。

### 7.2 如果要做

```bash
npx expo install @react-native-firebase/app @react-native-firebase/messaging
npx expo run:ios      # 必须 development build
```

需要改的地方：

| 文件 | 改动 |
|---|---|
| [`src/hooks/usePushNotifications.js`](../src/hooks/usePushNotifications.js:1) | `getExpoPushTokenAsync` → `messaging().getToken()` |
| [`supabase/functions/send-push/index.ts`](../supabase/functions/send-push/index.ts:95) | Expo Push API → FCM HTTP v1 API |
| `app.json` | 加 `google-services.json` / `GoogleService-Info.plist` 配置 |

### 7.3 验收

- [ ] 真机收到推送（前台 / 后台 / 杀死三种状态）
- [ ] Edge Function 日志无 error

---

## 8. 每天怎么开工（固定流程）

### 8.1 早上（10 分钟）

```bash
git status                    # 确认干净
git pull                      # 如果有远程
npx tsc --noEmit              # 确认基线是绿的
```

打开本文件，找到「今天做哪个阶段」，读对应 spec 章节。

### 8.2 白天（8 小时）

```text
1. 一次只改 1–2 个文件
2. 改完立刻跑 tsc --noEmit
3. 报错立刻修，不要攒
4. 每完成一个小功能 → git commit
```

### 8.3 晚上（10 分钟）

```bash
npx tsc --noEmit
npx expo lint
git add -A && git commit -m "阶段X: 今天做了什么"
```

**每天必须 commit。** 不要攒到周末——万一某天改崩了，回滚成本会很高。

### 8.4 commit message 格式

```text
阶段A-1: 新建 motion.js 统一动效参数
阶段B: 开启 strictNullChecks 并修复 23 处报错
阶段C: 首页改用 useQuery
阶段D: 迁移 src/constants/ 9 个文件到 TS
```

---

## 9. 卡住了怎么办（按顺序试）

### 9.1 技术问题

```text
1. 先看报错信息最后一行（不是第一行）
2. 搜 Expo 官方文档：https://docs.expo.dev/versions/v58.0.0/
3. 搜 GitHub Issues（带 SDK 版本号）
4. 问 AI 时，把「完整报错 + 相关文件内容 + 你试过什么」一起给
```

### 9.2 卡超过 2 小时

**立刻跳过，做下一项。** 不要在一个问题上耗一整天。

在 `docs/DEV_LOG.md` 里记一行：

```markdown
## 2027-07-XX
- 卡在 XXX，报错 YYY，试过 ZZZ，未解决。跳过，明天再看。
```

### 9.3 连续 3 天效率低于 4 小时

**停下来休息一天。** 不是偷懒，是防止后面 10 天都废掉。

---

## 10. 进度追踪表（每天打勾）

| 阶段 | 计划天数 | 实际开始 | 实际结束 | 状态 |
|---|---|---|---|---|
| 0. TS 类型契约 | 3 | | | [ ] |
| A-1. 地基 | 3 | | | [ ] |
| A-2. 首页 | 4 | | | [ ] |
| A-3. 空间+设置 | 4 | | | [ ] |
| A-4. 聊天 | 4 | | | [ ] |
| A-5. 放映厅+浏览器 | 5 | | | [ ] |
| B. tsconfig strict | 4 | | | [ ] |
| C. TanStack Query + MMKV | 10 | | | [ ] |
| D. 页面 TS 迁移 | 12 | | | [ ] |
| E. FCM（可砍） | 4 | | | [ ] |

**合计计划：53 天。暑假 70 天，缓冲 17 天。**

---

## 11. 暑假结束时的验收标准

做完这些，才算「暑假目标达成」：

- [ ] `src/` 下无 `.js` 文件（配置文件除外）
- [ ] `npx tsc --noEmit` 通过，`strictNullChecks` 已开
- [ ] `npx expo lint` 错误数 ≤ 136
- [ ] specs 阶段 1–5 全部完成，真机双端走查通过
- [ ] 至少 5 个核心页面用 TanStack Query
- [ ] `types/` 目录 5 个文件完整
- [ ] 所有改动已 commit + push

**没做完的项，写进 `docs/DEV_LOG.md`，2028 年继续。**

---

## 12. 2028 年要做的（不在本文件范围）

- RevenueCat 订阅接入
- 签名 APK / 上架 App Store + Google Play（需满 18 岁）
- 剩余 37 个页面改 TanStack Query
- 补测试（聊天发送 / 登录 / 同步播放三条核心路径）
- 接入 Sentry 错误上报
- 包名 `com.sync.app` → `com.abcdabcd9.sync`

---

## 附录 A：关键文件索引

| 用途 | 文件 |
|---|---|
| 全局约束 / 视觉守则 / 动效规范 | [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:1) |
| 阶段 1–3 细则 | [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:1) |
| 阶段 4–7 细则 | [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md:1) |
| 数据库字段参考 | [`docs/DB_SCHEMA_REFERENCE.md`](DB_SCHEMA_REFERENCE.md:1) |
| 历史踩坑记录 | [`docs/DEV_LOG.md`](DEV_LOG.md:1) |
| 架构图 | [`docs/specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md`](specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md:1) |

## 附录 B：已知的坑（2026-11-01 之前踩过的）

来源：[`docs/DEV_LOG.md`](DEV_LOG.md:1)

| 坑 | 根因 | 已修复 |
|---|---|---|
| 语音发出去无法播放 / 退出重进消失 | 上传 body 类型不对（不是权限，不是 RLS） | 是 |
| Android 定位慢 | 定位策略问题 | 是 |
| Android 全屏预览空白 | 渲染层问题 | 是 |
| 语音转文字 `Unsupported FormDataPart` | FormData 构造方式 | 是 |
| 横屏照片被裁切 | 图片尺寸计算 | 是 |
| 位置卡片不即时出现 / 重新定位闪烁 | 状态更新时机 | 是 |

**这些坑不要再踩一遍。** 遇到类似症状，先翻 [`docs/DEV_LOG.md`](DEV_LOG.md:1)。

## 附录 C：当前技术债清单（2026-11-01 快照）

| 项 | 状态 | 计划处理时间 |
|---|---|---|
| lint 136 项（112 error / 24 warning） | 未修 | 阶段 D 顺带修 |
| 0 个测试文件 | 未做 | 2028 年 |
| 无错误上报 | 未做 | 2028 年（Sentry） |
| 包名 `com.sync.app` | 未改 | 2028 年上架前 |
| 6 类占位功能 | 未补 | specs 阶段 2–6 |
| `EXPO_PUBLIC_GROQ_API_KEY` 在客户端 | 未改 | 2028 年（改走 Edge Function） |
