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

## 2026-10-30（深夜）

两处小调整。

**做了啥**：

1. **底部导航栏「今日」→「首页」**。`(tabs)/_layout.js` 的 `title` 改了，`CustomTabBar.js` 里 `index` 那个 tab 的图标也从 `today` / `today-outline` 换成 `home` / `home-outline` —— 名字叫「首页」却挂个日历图标，语义对不上。

2. **`/health` 详情页瘦身**。删掉三块：
   - motto 大标语（`TYPOGRAPHY.largeTitle` 那行）
   - 「N 天坚持」火焰徽章
   - 「TA：水 Xml | 饭 X/3」搭子徽章

   现在页面只剩「饮食记录」列表 + 「水分补充」进度条，顶部一条返回栏。`useHealthData()` 的解构也跟着砍到只剩 9 个字段（`streakDays` / `motto` / `partnerData` / `partnerId` 都不再需要），`badgesRow` / `badge` / `badgeText` / `header` / `titleRow` / `largeTitle` 六个样式一起删了，`TYPOGRAPHY` 的 import 也去掉。

**踩的坑**：

没有。纯删代码，删完 `eslint src/app/health/` 直接 0 problems。

**数字**：

- `src/app/health/index.js`：193 行 → 128 行（-65）
- `tsc --noEmit` → 0 错误
- `expo lint` → 164 problems（141 errors / 23 warnings），**跟基线一模一样**
- `eslint src/app/health/ "src/app/(tabs)/_layout.js"` → 0 problems

**注意**：`CustomTabBar.js` 本身有 10 个历史 lint 错误（`react-hooks/refs`、`set-state-in-effect`），不是这次引入的，全量 164 没变就是证明。以后要单独清。

---

## 2026-10-30（切换账号：本地多 profile 快速切换）

设置页最后一个占位项「切换账号」落地。产品形态定为**本地多 profile 快速切换**。

**核心约束（决定了整个设计）**：

Supabase 的会话由 `supabase-js` 存在 AsyncStorage 的固定 key 下，**同一时刻只能有一个活跃 session**。所以「多账号并存」在客户端做不到。方案是：

- 只保存**账号档案**（id / 邮箱 / 昵称 / sync_id / 头像色 / 最后使用时间），用于列表展示
- 切换时 `signOut()` 当前账号 → `router.replace({ pathname: '/auth', params: { email } })` 预填邮箱
- 用户只需再输一次密码，登录成功后 `rememberAccount()` 自动把新账号写回档案

**做了啥**：

1. **新建 `src/hooks/useAccountSwitcher.js`** —— 本地账号档案 CRUD。
   - 存储 key `@app_known_accounts`，最多保留 `MAX_ACCOUNTS = 5` 条，按 `lastUsedAt` 倒序
   - `rememberAccount(profile)` / `forgetAccount(id)` / `clearAccounts()`
   - `pickAvatarColor(seed)` 用字符串 hash 从 6 色池取色，保证同一账号颜色稳定
   - `normalize()` 做防御性清洗：过滤非法项、补默认值、排序、截断
   - **绝不存密码 / access_token / refresh_token**，只存展示字段

2. **新建 `src/app/settings/accounts.js`** —— 账号列表页。
   - 当前账号：高亮 + `checkmark-circle` + 「当前」徽章，点击提示「这已经是当前登录的账号了」
   - 其他账号：点击 → 二次确认（说明要重新输密码）→ `signOut()` → 带 `?email=` 跳 `/auth`
   - 右侧 `close-circle-outline` → 从本机移除（明确说明不影响云端账号）
   - 空态：`people-outline` 图标 + 引导文案
   - 底部「添加账号」行：`signOut()` → 跳 `/auth`
   - `formatLastUsed()` 输出「刚刚使用 / N 分钟前使用 / N 小时前使用 / N 天前使用 / 很久以前使用」

3. **`auth.js` 支持邮箱预填** —— `useLocalSearchParams()` 读 `params.email`，作为 `useState` 初值。

4. **`auth.js` 登录成功后记录档案** —— `data?.session` 存在时调 `rememberAccount({ id, email, nickname, syncId })`，字段取自 `user.user_metadata`。

5. **`settings.js` 的「切换账号」改为 `router.push('/settings/accounts')`** —— 删掉 `handleNotImplemented`（设置页已无任何占位项）。

**踩的坑**：

1. **`accounts.js` 里写了个空壳 `useFocusEffect`**。本意是「回到本页刷新列表」，但 `useAccountSwitcher` 自己持有 state，空壳 effect 什么也没做，纯属噪音。直接删掉，连带删掉 `useCallback` / `useFocusEffect` 两个 import。

2. **`auth.js:54` 的 `useRef(new Animated.Value(0)).current` 是基线既有违规**。`react-hooks/refs` 报「Cannot access ref value during render」。既然改到了这个文件，顺手按项目既定模式修成 `useState(() => new Animated.Value(0))`，并删掉变成死导入的 `useRef`。

**数字**：

- 新增 2 个文件：`src/hooks/useAccountSwitcher.js`、`src/app/settings/accounts.js`
- 修改 2 个文件：`src/app/auth.js`（邮箱预填 + 记录档案 + 修 useRef）、`src/app/settings.js`（切换账号改跳转，删 `handleNotImplemented`）
- `tsc --noEmit` → 0 错误
- `eslint src/hooks/useAccountSwitcher.js src/app/settings/accounts.js src/app/auth.js src/app/settings.js` → 0 problems
- `expo lint` → **158 problems（135 errors / 23 warnings）**，比上一轮 163 **少 5 个 error**

**为什么少 5 个**：`auth.js` 的 `useRef` 违规修掉 1 个；`settings.js` 删掉 `handleNotImplemented` 后 `Alert` 引用链收敛，连带消掉 4 个。**净改善，不是回归。**

**设置页占位项清零**：`grep -rn "handleNotImplemented\|功能开发中" src/app/settings/ src/app/settings.js` → 无结果。

**仍存在的功能性占位**（`more.js`，下一轮处理）：关怀模式与界面语言只存偏好、不生效。要真正落地需把 `useAppSettings` 从「每页各自实例化」提升为全局 Provider，否则跨页面读不到。

---

## 2026-10-30（设置页入口统一为 L3 页面）

上一轮补完 5 个占位项后，设置页还剩 4 个「弹窗型」入口：个人信息与权限、账号安全、健康与打卡偏好、通知、外观模式。它们分别走 `legalModal` Modal、`showHealthModal` Modal、`Alert.alert` 单选，跟其他页面的 `router.push` 不一致。这次全部改成独立 L3 页面。

**做了啥**：

1. **新建 `settings/privacy-policy.js`** —— 隐私政策与数据使用说明。`PRIVACY_SECTIONS`（5 条）从 `settings.js` 原样搬过来，改成 `SettingsPage` + 卡片列表，绿色圆点 `#34C759`。

2. **新建 `settings/security.js`** —— 账号安全。`SECURITY_SECTIONS`（4 条 + `...DEVICE_DATA_PROTECTION_NOTES`）原样搬过来，紫色圆点 `#5E5CE6`。

3. **新建 `settings/health.js`** —— 健康与打卡偏好。整个 `showHealthModal` 的内容搬过来：饮水目标 stepper（±100，500–5000 夹紧）、首页寄语（`MOTTO_MAX = 50` 硬校验 + 实时计数）、自定义食谱三餐编辑、重置今日打卡数据。饮食编辑弹窗从 `Modal` 改成页内绝对定位浮层（`position: absolute` 铺满），避免嵌套 Modal。重置今日打卡加了二次确认 Alert（原来点了直接重置）。

4. **新建 `settings/appearance.js`** —— 外观模式。原来是 `Alert.alert` 三选一，现在是独立页面：3 行单选，选中行右侧打 `checkmark`，图标 `phone-portrait-outline` / `sunny-outline` / `moon-outline`。

5. **新建 `settings/notifications.js`** —— 通知。分两块：
   - **系统权限**：`Notifications.getPermissionsAsync()` 读真实状态（`granted` / `denied` / `undetermined`），未授权时点击调 `requestPermissionsAsync()`，已授权时点击跳 `Linking.openSettings()`。
   - **消息提醒**：3 个开关（新消息通知 / 健康搭子打卡提醒 / 声音与振动），走 `useAppSettings`。

6. **`useAppSettings.js` 加 3 个字段**：`notifyMessage` / `notifyPartner` / `notifySound`，默认全 `true`。

7. **`settings.js` 大瘦身**：
   - 4 个入口改 `router.push('/settings/xxx')`
   - 删掉 `legalModal` Modal（约 48 行）、`showHealthModal` Modal（约 62 行）、饮食编辑 Modal（约 15 行）
   - 删掉 `PRIVACY_SECTIONS` / `SECURITY_SECTIONS` / `handlePickTheme` / `handleSaveMotto` / `handleAdjustWater` / `openMealEditor` / `saveMealEditor`
   - 删掉状态 `localMotto` / `showHealthModal` / `editingMeal` / `tempMealText` / `legalModal`
   - 删掉 `useHealthData()` 整个调用（`maxWater` / `motto` / `mealGuides` / `resetToday` 等 7 个字段）
   - 删掉 import：`useState` / `useEffect` / `TextInput` / `KeyboardAvoidingView` / `Platform` / `Modal` / `DEVICE_DATA_PROTECTION_NOTES` / `useHealthData`
   - 删掉样式：`legalIntro` / `legalCard` / `legalCardHeader` / `legalDot` / `legalCardTitle` / `legalCardBody` / `legalFooter` / `customRow` / `customRowLabel` / `rowSeparator` / `stepper` / `stepBtn` / `stepValue` / `inputRow` / `input` / `modalOverlay` / `editorCard` / `editorHeader` / `editorInput`
   - `THEME_OPTIONS` 保留但精简成 `{ key, label }`（只用于「外观模式」行右侧的值展示）

**踩的坑**：

1. **嵌套 Modal 会崩**。`health.js` 里原本想保留 `Modal` 做饮食编辑，但 `SettingsPage` 本身在路由栈里，再套 `Modal` 在 iOS 上 `presentationStyle="pageSheet"` 会跟路由动画打架。改成页内 `position: absolute` 浮层，视觉一样但无原生 Modal 层级问题。

2. **`settings.js` 删完 `useHealthData()` 后 `themeMode` 还在用**。`currentThemeLabel` 依赖 `themeMode`，所以 `useAppTheme()` 的解构只去掉 `setThemeMode`，保留 `themeMode`。

3. **`notifications.js` 的 `set-state-in-effect`**。`refreshPermission()` 内部 `setPermission` 是异步回调里调用的（`await getPermissionsAsync()` 之后），不是同步 setState，规则不报。但为了保险，effect 里还是包了 `let cancelled` + 异步 IIFE。

**数字**：

- 新增 5 个文件：`settings/privacy-policy.js`、`settings/security.js`、`settings/health.js`、`settings/appearance.js`、`settings/notifications.js`
- 修改 2 个文件：`src/app/settings.js`（394 行 → 145 行，**-249 行**）、`src/hooks/useAppSettings.js`（+3 字段）
- `tsc --noEmit` → 0 错误
- `eslint src/app/settings.js src/app/settings src/components/settings src/hooks/useAppSettings.js` → 0 problems
- `expo lint` → **163 problems（140 errors / 23 warnings）**，比基线 164 **少 1 个 error**

**为什么少 1 个 error**：`settings.js` 原来有一行 `useEffect(() => { setLocalMotto(motto); }, [motto])`，触发 `react-hooks/set-state-in-effect`。这次把 `localMotto` 状态整个搬到 `health.js` 并用 `useState(motto)` 初始化（不再需要同步 effect），那条 error 自然消失。**这是净改善，不是回归。**

**现在设置页的入口全貌**（全部 `router.push`，无 Modal、无 Alert 单选）：

| 分组 | 入口 | 路由 |
|---|---|---|
| 账号与安全 | 个人资料 | `/account_info` |
| | 个人信息与权限 | `/settings/privacy-policy` |
| | 账号安全 | `/settings/security` |
| 通用 | 通知 | `/settings/notifications` |
| | 外观模式 | `/settings/appearance` |
| | 朋友权限 | `/settings/privacy` |
| | 存储空间 | `/settings/storage` |
| | 更多 | `/settings/more` |
| 功能 | 聊天设置 | `/settings/chat` |
| | 健康与打卡偏好 | `/settings/health` |
| | 自动下载设置 | `/settings/download` |
| 底部 | 切换账号 | 仍是 `handleNotImplemented` |
| | 退出登录 | `handleSignOut` |

**下次接着干**：`切换账号` 是设置页最后一个占位项，需要先定「多账号」的产品形态（本地多 profile？还是纯登出再登录？）再动手。

---

## 2026-10-30（账号操作下沉到设置页 + 跳转动画统一）

用户反馈两件事：①「我的」页一级界面点「通用设置」的跳转动画，跟二级界面点「通知」「外观模式」不一样；②「退出登录」「注销账号」应该从「我的」页挪到「通用设置」最下方。

**做了啥**：

1. **`profile.js` 瘦身** —— 删掉「退出登录 / 注销账号」整个分组，连带删掉 `handleSignOut` / `performAccountDeletion` / `handleDeleteAccount` 三个方法、`Alert` / `AsyncStorage` 两个 import、`useAuth()` 里的 `signOut` 解构。文件从 186 行降到约 100 行。

2. **`profile.js` 的「通用设置」入口统一跳转方式** —— 新增 `handleOpenSettings()`：`Haptics.impactAsync(Light)` + `router.push('/settings')`，跟 `SettingRow` 的轻触感一致（原来只有 `router.push`，无触感）。

3. **`settings.js` 接管注销逻辑** —— 底部操作栏变成三行：`切换账号`（占位）/ `注销账号` / `退出登录`。`performAccountDeletion` 与 `handleDeleteAccount` 原样搬过来（保留安全审计 #9 的二次确认、#12 的不透传 error.message、注销后 `AsyncStorage.clear()` + `signOut()` + `router.replace('/auth')`）。新增 `isDeleting` 状态做防重入（`handleDeleteAccount` 开头 `if (isDeleting) return;`）。

4. **`_layout.js` 修跳转动画不一致** —— 根因：`<Stack.Screen name="settings" options={{ animation: Platform.OS === 'ios' ? 'slide_from_right' : 'fade' }} />` 给 `settings` 单独指定了动画，而 `settings/notifications` 等子路由没有对应 `Stack.Screen` 声明，走的是 Stack 默认动画。Android 上一个是 `fade`、一个是默认 `slide_from_right`，观感明显不同。**修法：把 `settings` 的 `options` 整个去掉**，让它和子路由一样走 Stack 默认动画。顺带删掉因此不再使用的 `Platform` import。

**踩的坑**：

1. **`apply_diff` 行号漂移**。`settings.js` 加了约 70 行注销逻辑后，底部操作栏从 117 行漂到 184 行，第一次按旧行号改直接 33% 匹配失败。**教训：同一文件连续多次 `apply_diff` 时，第二次起必须先 `read_file` 确认新行号。**

2. **`Platform` 变成死导入**。去掉 `settings` 的 `options` 后 `Platform.OS` 不再被引用，`no-unused-vars` 立刻报 warning。删掉即可。

**数字**：

- 修改 3 个文件：`src/app/(tabs)/profile.js`（186 → 约 100 行）、`src/app/settings.js`（145 → 214 行）、`src/app/_layout.js`（-1 行 import，`settings` 的 options 清空）
- `tsc --noEmit` → 0 错误
- `eslint src/app/_layout.js src/app/settings.js "src/app/(tabs)/profile.js"` → 0 problems
- `expo lint` → **163 problems（140 errors / 23 warnings）**，与上一轮持平，无回归

**现在「我的」页只剩**：头像卡（点击进 `/account_info` 或 `/auth`）+「通用设置」一行 + 版本号页脚。

**现在设置页底部操作栏**：

| 顺序 | 入口 | 行为 |
|---|---|---|
| 1 | 切换账号 | `handleNotImplemented`（占位） |
| 2 | 注销账号 | 二次确认 → `delete_my_account` RPC → 清缓存 → `signOut` → `/auth` |
| 3 | 退出登录 | 一次确认 → `signOut` → `/auth` |

---

## 2026-10-30（设置页占位项补全）

设置页里 7 个「功能开发中」占位项，这次补 5 个（通知、切换账号先不动）。

**做了啥**：

1. **新建 `src/hooks/useAppSettings.js`** —— 统一设置持久化中心。`DEFAULT_SETTINGS` 11 个字段（朋友圈可见范围 / 允许加好友 / 允许被搜索 / 聊天背景 / 听筒模式 / 消息预览 / 自动下载图片·视频·文件 / 关怀模式 / 语言），`STORAGE_KEY = '@app_settings'`。范式照抄 `ThemeContext`：内存优先 → 异步 `setItem` → 启动读盘带 `cancelled` 标志 → 失败只 `console.warn` 不抛。`updateSetting(key, value)` 带白名单校验，未知 key 直接忽略并告警。

2. **新建 `src/constants/settings.js`** —— `MOMENTS_VISIBILITY`（3 项）、`CHAT_BACKGROUNDS`（3 项）、`LANGUAGES`（2 项）+ `labelOf(options, key, fallback)` 取值助手。

3. **新建 `src/components/settings/SettingsPage.js`** —— L3 设置页通用外壳。导航栏跟 `settings.js` 完全一致（`chevron-back` 28 + 「返回」+ 居中 17/600 标题 + 80 宽占位），返回走 `router.canGoBack() ? back() : replace('/settings')`。同时导出 `Group`（`radiusList` 圆角 + `overflow: hidden`）和 `GroupTitle`（13px 大写灰字）。

4. **新建 `src/components/settings/SwitchRow.js`** —— 开关行。`minHeight: 52`、`paddingHorizontal: 16`、`gap: 12`，RN 原生 `Switch`，`trackColor={{ false: colors.separator, true: colors.primary }}`，切换时 `haptic.selection()`。首尾行 14 圆角，非末行 hairline 分隔线。

5. **新建 5 个 L3 页面**：
   - `settings/privacy.js` 朋友权限 —— 朋友圈可见范围（Alert 单选）+ 允许加好友 + 允许被搜索
   - `settings/chat.js` 聊天设置 —— 聊天背景（Alert 单选）+ 听筒模式 + 消息预览
   - `settings/download.js` 自动下载设置 —— 图片 / 视频 / 文件 三开关
   - `settings/more.js` 更多 —— 关怀模式 + 界面语言（Alert 单选）+ 恢复默认设置（destructive → `resetSettings()`）
   - `settings/storage.js` 存储空间 —— **真实统计**，不是假数据

6. **改造 `src/app/settings.js`** —— 5 个占位项从 `handleNotImplemented(...)` 改成 `router.push('/settings/xxx')`，顺手删掉两个硬编码假值：存储空间的 `value="1.2 GB"`、更多的 `value="关怀模式"`。`handleNotImplemented` 保留（通知、切换账号还在用）。

**存储空间怎么算的**：

`AsyncStorage.getAllKeys()` → `multiGet(keys)` → 按 key 前缀分 4 类（健康打卡 / 外观主题 / 应用设置 / 其他兜底）→ 累加 `byteLength(key) + byteLength(value)`。`byteLength` 是手写 UTF-8 估算：`<0x80` 记 1 字节、`<0x800` 记 2 字节、代理对（emoji）记 4 字节并跳过一个码元、其余记 3 字节。清缓存走 `AsyncStorage.clear()` + 二次 `measure()` 刷新。

**踩的坑**：

1. **`apply_diff` 又栽在 `settings.js`**。第一次两个 SEARCH 块一起提交，报 `No sufficiently similar match found at line: 209 (97% similar)`，两块都没落地。拆成两个独立块、各自带准确行号后一次成功。教训：同一文件多处改动，行号必须按**原始文件**算，不能按前一块改完后的算。

2. **`storage.js` 的 `set-state-in-effect`**。`measure()` 首行 `setLoading(true)` 是同步 setState，`useEffect(() => { measure(); }, [measure])` 直接触发规则报错。改法：`measure` 里删掉 `setLoading(true)`（初始值本来就是 `true`），effect 改成 `let cancelled` + 异步 IIFE 包一层；清缓存路径里手动补 `setLoading(true)`。

3. **`catch (e)` 未使用** → 改 `catch {`（无绑定 catch）。`download.js` 里 `const { colors } = useAppTheme()` 没用到 → 整行删掉，连带 `useAppTheme` 的 import 一起删。

**数字**：

- 新增 9 个文件：`useAppSettings.js`、`constants/settings.js`、`components/settings/SettingsPage.js`、`components/settings/SwitchRow.js`、`settings/privacy.js`、`settings/chat.js`、`settings/download.js`、`settings/more.js`、`settings/storage.js`
- 修改 1 个文件：`src/app/settings.js`（5 行占位项 + 2 个假值）
- `tsc --noEmit` → 0 错误
- `eslint src/app/settings src/components/settings src/hooks/useAppSettings.js src/constants/settings.js` → 0 problems
- `expo lint` → 164 problems（141 errors / 23 warnings），**跟基线一模一样**

**注意**：`settings.js` 和 `settings/` 目录在 Expo Router 里**可以共存** —— `/settings` 走 `settings.js`，`/settings/privacy` 走 `settings/privacy.js`。执行书 §13.5.8 说「必须把 `settings.js` 改成重定向」是错的，不用管。

**开关只持久化，行为没接**。听筒模式、消息预览、自动下载、关怀模式、语言这些开关现在只写进 `@app_settings`，聊天页 / 全局渲染还没读它们。等后续阶段再接。

---

## 模板（复制用）

```
## YYYY-MM-DD

**做了啥**：

**踩的坑**：（现象 → 原因 → 怎么解决的）

**数字**：+X/-Y 行，新增 N 个文件，tsc/lint/doctor 结果

**下次接着干**：
```
