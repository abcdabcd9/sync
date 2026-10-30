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

## 2026-10-30（夜）

阶段 2 返工。首页第一版做出来自己不满意 —— 四张卡竖着堆，信息太散，一屏看不完。

**做了啥**：

需求改了两轮，最后定下来：

- 首页只留**一张**「健康打卡」总览卡，里面四行摘要（饮水 / 饮食 / 连续打卡 / 健康搭子），每行带进度条
- 卡片右上角一个 64px 双环，显示今日总完成度百分比
- 点这张卡 → 进 `/health`，**界面回退为阶段 2 之前的原版今日页**（motto 大标题 + 坚持天数/搭子徽章 + 饮食记录列表 + 水分补充），只在顶部加了一条返回栏

**踩的坑**：

第一轮我理解成「四张卡各自 2×2，点各自进二级页」，建了 `health/water.js`、`meals.js`、`streak.js`、`partner.js` 四个页面。用户纠正说不是这个意思 —— 是**四卡合并成一张**，点击进原今日页。四个页面全删了，改成单个 `health/index.js`。

教训：需求里「2×2」和「合并为一个概览」是两种完全不同的信息架构，动手前该先确认，不该自己脑补。

**iOS 卡顿（真机反馈）—— 三轮排查，最后定位到原生模块缺失**：

改完在 iPhone 上跑，触控延迟极长，几乎点不动。

**第一轮（猜错了）**：以为是 `ProgressRing` 塞进 `AppleCard` 里，SVG 树每帧重建。
→ 首页总览卡换成纯 `View` 百分比圆徽章。**没用，依旧卡。**

**第二轮（又猜错了）**：以为是 `Animated.timing` 跑 JS 线程，于是把 `AppleCard` / `AppleButton` / `MealListItem` 全迁到 Reanimated（`useSharedValue` + `useAnimatedStyle` + `withTiming` + `runOnUI`）。
→ **更卡了。** 而且 `scale.value = withTiming(...)` 还触发 `react-hooks/immutability`，得包 `runOnUI(() => { 'worklet'; ... })()` 才过 lint。

**第三轮（用数据定位，才是真根因）**：不再猜，逐项验证：

| 检查项 | 结果 |
|---|---|
| `git diff --stat 1d6f24c HEAD` | 25 文件 / 1171 行 —— Reanimated 确实是阶段 2 才引入的 |
| `package.json` 里 reanimated / worklets / svg | 都装了（4.7.1 / 0.13.0 / 15.16.0） |
| `babel.config.js` | **不存在** —— 但 Expo SDK 58 官方文档明确写「装了就自动配置，无需额外配置」，所以不是 Babel 问题 |
| `app.json` plugins | 无 reanimated 插件（也不需要） |
| `newArchEnabled` | 未设置 |
| `ios/` 目录 | **不存在** → 跑在 Expo Go 里 |
| `android/` 目录 | **存在，时间戳 Oct 29 22:40（阶段 2 之前）** |
| `grep -rl reanimated android/` | 只命中 `proguard-rules.pro`，**没有任何 autolinking 条目** |

**结论：Reanimated 4 在这个项目里根本没有可用的原生运行时。** `android/` 原生工程是在阶段 2 之前 prebuild 的，里面没有 Reanimated 的 native module；`ios/` 压根不存在（Expo Go 里跑，Expo Go 内置的 Reanimated 版本和 4.7.1 对不上）。于是所有 `useAnimatedStyle` / `withTiming` / `runOnUI` 全部走降级路径 —— 每次渲染重新序列化 worklet 到 JS 线程执行。这就是卡顿根源，而且**迁到 Reanimated 反而让它更卡**。

**修复：彻底移除 Reanimated，全部退回 RN 内置 `Animated`。**

内置 `Animated` 有 `useNativeDriver: true`，动画跑在原生线程，不需要任何额外原生模块，Expo Go 里完全可用。4 个文件全部改回：

- `src/components/ui/AppleCard.js` —— `useState(() => new Animated.Value(1))` + `Animated.timing(scale, { toValue, duration: DURATION.instant, useNativeDriver: true }).start()`，`transform: [{ scale }]` 直接写进 style
- `src/components/ui/AppleButton.js` —— 同上
- `src/components/MealListItem.js` —— 同上
- `src/components/ui/ProgressRing.js` —— SVG 的 `strokeDashoffset` 不支持 native driver，改用 `Animated.createAnimatedComponent(Circle)` + `interpolate` + `useNativeDriver: false`；只有 2 个标量在变，开销可忽略

`Skeleton.js` 本来就用内置 `Animated`，无需改动。

**教训（重要）**：

1. **卡顿不要靠猜，要靠查。** 前两轮都是「我觉得是这里」，改完更糟。第三轮列检查表逐项验证，5 分钟就定位到了。
2. **`package.json` 里有依赖 ≠ 原生模块可用。** 有 `android/` / `ios/` 原生工程的项目，新增带原生代码的库必须重新 prebuild 或做 development build；否则 JS 侧 import 成功、运行时静默降级。Expo Go 只带它自己内置的那批模块。
3. **内置 `Animated` + `useNativeDriver: true` 是零依赖的安全选择。** 在 Expo Go 里做按压/淡入这类简单动画，没必要上 Reanimated。

**数字**：

- 新增 `src/app/health/index.js`（原今日页完整搬过来 + 顶部返回栏）
- 重写 `(tabs)/index.js`（单卡总览）
- 4 个组件统一用内置 `Animated`（AppleCard / AppleButton / MealListItem / ProgressRing）
- 删掉 4 个走错方向的页面
- `grep -rn "react-native-reanimated" src/` → **0 处**
- `tsc --noEmit` → 0 错误
- `expo lint` → 164 problems（141 errors / 23 warnings），**跟基线一模一样**
- 改动文件 eslint → 0 problems

**下次接着干**：

阶段 3，空间页 + 设置页拆分 + 我的页。设置页要从单文件拆成 `src/app/settings/` 目录下 5 个 L3 页面，原有设置项一个不能丢 —— 这是目前风险最高的一步，拆之前得先把 `settings.js` 里的所有设置项逐条抄成清单。

**待验证**：真机重启 Expo dev server（建议 `npx expo start -c` 清缓存）确认卡顿消失。Reanimated 已从 `src/` 完全移除，理论上不会再走降级路径。

---

## 模板（复制用）

```
## YYYY-MM-DD

**做了啥**：

**踩的坑**：（现象 → 原因 → 怎么解决的）

**数字**：+X/-Y 行，新增 N 个文件，tsc/lint/doctor 结果

**下次接着干**：
```
