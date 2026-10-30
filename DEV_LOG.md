# DEV_LOG

随手记。每次开工前翻一下上次写到哪了。

---

## 2026-10-30

**密钥审计**，4 项扫描全过：

- `git ls-files` 扫文件名 → 0 命中
- `git grep` 扫内容（service_role / sk- / PRIVATE KEY / AIza / eyJhbGciOi）→ 4 处命中，但全是注释和 `Deno.env.get()`，没真密钥
- `git log --all --diff-filter=A` 扫历史 → 干净，从来没提交过 .env
- `git status --ignored` → `.env`、`google-services.json`、`push.json`、`sync.json` 都是 `!!`，说明 ignore 生效了

可以开源。客户端只有 `EXPO_PUBLIC_SUPABASE_ANON_KEY`（公开的，靠 RLS 保护），service_role 只在 Edge Function 里，不下发。

**基线**：

- `tsc --noEmit` → 0 错误。不过 tsconfig 里 compilerOptions 是空的，JS 文件基本没被严格检查，这个 0 有点虚
- `expo lint` → 164 problems（141 errors / 23 warnings）。全是重构前就有的，不是我搞出来的
- `expo-doctor` → 20/20 通过

lint 那 141 个 error 里，`react-hooks/refs` 占了 107 个（76%）。这是 React 19 的新规则，禁止渲染期读写 ref，老代码到处 `useRef` 直接赋值，全中。剩下的是 immutability 11 个、exhaustive-deps 11 个、set-state-in-effect 7 个、purity 7 个、display-name 5 个、rules-of-hooks 2 个、import 相关 2 个。

分布在 17 个文件：`(tabs)/chat.js`、`account_info.js`、`auth.js`、`chat_room.js`、`cinema.js`、`invite_friend.js`、`settings.js`、`ChatContextMenu.js`、`ChatInputBar.js`、`CustomTabBar.js`、`FloatingPlayer.js`、`LiquidGlass.js`、`MealDetailSheet.js`、`WaterProgress.js`、`useCinema.js`、`useHealthData.js`、`usePushNotifications.js`。

其中 12 个文件在阶段 2-6 会被重写，错误自然就没了。所以每阶段验收只看「有没有新增 error」，不清零。阶段 7 统一收。

**提交**：`1d6f24c chore: pre-refactor baseline`，tag `stage-0-baseline`。要回滚就 `git reset --hard stage-0-baseline`。

**下一步**：阶段 1，14 步。装 flash-list，建 4 个常量文件 + types/README，建 7 个 UI 组件 + index.js，最后验收。全是新文件，不会碰现有代码。

---

## 2026-10-30（下午）

阶段 1 干完了。全是新文件，没碰一行现有代码。

**做了啥**：

- `@shopify/flash-list` 2.3.2
- 4 个常量：`motion.js`（时长/弹簧/缓动/缩放/错峰）、`haptics.js`（7 种触感，iOS 才真触发）、`features.js`（8 个开关，5 个已实现 + 3 个关系网络预留）、`limits.js`（9 个上限，6 个现有 + 3 个预留）
- `src/types/README.md`：TS 转型契约，只写规划不写实现
- 7 个 UI 组件：AppleCard / AppleButton / AppleListRow / AppleSectionHeader / ProgressRing / Skeleton / EmptyState，加一个 `index.js` 统一出口

**踩的坑**：

第一次 lint 冒出 12 个 error，全在 AppleCard、AppleButton、Skeleton 三个文件。现象是 `react-hooks/refs` 报「Cannot access refs during render」，指向 `useRef(new Animated.Value(1)).current`。原因就是 React 19 这条新规则——渲染期读 `.current` 一律算违规，跟基线里那 107 个 error 同源。解决：换成 `useState(() => new Animated.Value(1))`，惰性初始化只创建一次，而且它是个普通变量不是 ref，规则不触发。顺手把 ProgressRing 两个 exhaustive-deps warning 也补了依赖。

**数字**：

- 新增 13 个文件（4 常量 + 1 README + 8 UI）
- `tsc --noEmit` → 0 错误
- `expo lint` → 164 problems（141 errors / 23 warnings），**跟基线一模一样，零新增**
- `expo-doctor` → 20/20
- 新增文件单独 lint → 0 problems

**下次接着干**：

阶段 2，首页重写。这是第一个会删改现有代码的阶段，`(tabs)/index.js` 整个重写，新建 4 个 home 组件。验收标准还是「不新增 error」。

**待验证**：`ProgressRing.js` 是全项目第一个 import `react-native-reanimated` 的文件。SDK 58 的 babel-preset-expo 会自动配插件，理论上不用管，但组件还没被任何页面引用，真机效果得等阶段 2 挂上去才知道。

---

## 2026-10-30（傍晚）

阶段 2 干完了。首页从「DietScreen」变成「健康总览」，第一次动了现有代码。

**做了啥**：

拆成 6 个小步走，每步单独 lint，避免一次改一堆出问题难定位：

- 2-A 到 2-D：4 个 home 组件（PartnerStatusCard / WaterCard / MealGrid / StreakCard），纯新文件
- 2-E：重写 `(tabs)/index.js`
- 2-F：微调 WaterProgress / MealListItem / MealDetailSheet，加动效和触感

**踩的坑**：

规格书里首页用的字段名跟 `useHealthData` 实际返回的**全对不上**。规格写 `health.partner`、`health.meals`、`health.checked`、`health.setWater`、`health.streak.days`、`health.toggleMeal`，实际返回的是 `partnerId`、`mealsStatus`、`setWaterDirect`、`streakDays`，而且根本没有 `toggleMeal`（是 `openMeal` / `closeMeal` / `confirmCheck` / `undoCheck` 四个）。规格第 1124 行自己也警告了这点，但正文代码没改。

更坑的是 `MealGrid`：规格写 `Object.values(meals)` 然后 `meal.id`，但 `mealsStatus` 是 `{'早餐': bool}` 这种对象，`MealListItem` 的 `meal` prop 要的是**字符串**。照抄会渲染出一堆 `undefined`。改成 `Object.entries(mealsStatus)` 才对。

还有 `todayProgress` 数据层压根没有。没编字段，用 `mealsStatus` 完成率和饮水完成率各占一半算出来。

**数字**：

- 新增 4 个文件（home 组件），改 4 个（index.js + 3 个微调）
- `tsc --noEmit` → 0 错误
- `expo lint` → 164 problems（141 errors / 23 warnings），**跟基线一模一样**
- 3 个微调文件改动前后都是 23 problems，用 `git stash` 对比确认过，零新增

**下次接着干**：

阶段 3，空间页 + 设置页拆分 + 我的页。设置页要从单文件拆成 `src/app/settings/` 目录下 5 个 L3 页面，原有设置项一个不能丢 —— 这是目前风险最高的一步，拆之前得先把 `settings.js` 里的所有设置项逐条抄成清单。

**待验证**：`ProgressRing` 现在挂在首页 StreakCard 上了，真机跑一下就能确认 Reanimated 自动配置生效。这个还没跑。

---

## 模板（复制用）

```
## YYYY-MM-DD

**做了啥**：

**踩的坑**：（现象 → 原因 → 怎么解决的）

**数字**：+X/-Y 行，新增 N 个文件，tsc/lint/doctor 结果

**下次接着干**：
```
