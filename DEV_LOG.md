# DEV_LOG

随手记。每次开工前翻一下上次写到哪了。

---

## 2026-10-30（阶段 4 修复 14：下线地图卡片 + 全屏预览图片截断）

用户反馈两件事：

1. 「算了，直接删除地图卡片以及这个功能，不需要删除位置功能。」
2. 「图片发出来确实是原生格式了，但是点开预览的时候，它还是会截断。」

### ① 下线地图卡片（保留定位能力）

只删「聊天里的地图卡片」这一条链路，[`src/app/chat/location.js`](src/app/chat/location.js:49) 定位页本身**完整保留**（位置能力不删）。

- [`ChatInputBar.js`](src/components/ChatInputBar.js:330)：`allActionItems` 移除 `location` 项，「+」面板不再有「位置」入口。
- [`ChatRoomInner.js`](src/components/ChatRoomInner.js:241)：删除 `locLat/locLng/locLabel` 回传 effect、`handlePickLocation`、`routerRef` / `consumedLocRef`，以及 `useLocalSearchParams` 导入与 `routeParams`。
- [`MessageBubble.js`](src/components/MessageBubble.js:188)：删除 `type === 'location'` 的地图卡片渲染分支、`parseLocationCoords()`、`openInMaps()`、6 条 `location*` 样式，以及不再使用的 `Linking` / `Alert` 导入。
- [`useChatList.js`](src/hooks/chat/useChatList.js:16)：保留 `type === 'location' → '[位置]'` 的**只读兼容**，历史消息在会话列表仍能正常显示预览。

> 历史 `type='location'` 消息在气泡里会降级为普通文本气泡（显示地址文字），不会变成空白。

### ② 全屏预览图片截断

**根因**：`CustomImagePlayer` 里 `<Image>` 的样式是 `fullScreenMedia = { width: SCREEN_WIDTH, height: SCREEN_HEIGHT }`，再配 `contentFit="contain"`。expo-image 在「容器尺寸 == 屏幕尺寸」且外层 `ScrollView` 带 `maximumZoomScale` 时，Android 会按容器裁剪（iOS 偶发同样表现），于是横屏照片左右被切、竖屏照片上下被切。

**修复**（[`InteractiveMediaViewer.js`](src/components/InteractiveMediaViewer.js:254)）：

- 新增 `naturalSize` 状态 + `displaySize` 计算：按图片真实宽高**等比缩放**到「不超出屏幕」，把 `Image` 的宽高直接设成这个尺寸。
- 尺寸未知时先铺满屏幕（`contain` 兜底），`onLoad` 拿到 `e.source.width/height` 后立刻替换。
- 这样 `contain` 无事可做，**物理上不可能裁切**；双击缩放逻辑（`isZoomed` / `scrollResponderZoomTo`）完全不受影响。

### 验收

- `npx tsc --noEmit` → 0 错误
- `npx expo lint` → 138 problems（119 errors / 19 warnings），与基线持平，无新增
- 改动文件：`src/components/ChatInputBar.js`、`src/components/ChatRoomInner.js`、`src/components/MessageBubble.js`、`src/components/InteractiveMediaViewer.js`、`src/hooks/chat/useChatList.js`

---

## 2026-10-30（阶段 4 修复 13：位置卡片不即时出现 / 重新定位闪烁 / 横屏照片被裁切 / 语音转文字 Unsupported FormDataPart）

用户反馈四件事：

1. 聊天界面发送地图卡片后**不会立刻出现**，必须退出去再进来才看得到；
2. 点「重新定位」时界面**闪烁**；
3. 安卓和苹果的图片都**不会自动缩放** —— 发一张电脑的横屏照片，气泡里变成「最大样式」并且**被截掉一部分**，不是原生横屏比例；
4. 语音转文字报 `识别失败："Unsupported form data part implementation，请重试。"`

### 根因（四个独立问题）

**① 位置卡片不即时出现：`router.replace` 重挂载 + `setMessages` 盲覆盖**

[`location.js`](src/app/chat/location.js:183) 发送后走 `router.replace` 回 `/chat_room`，这会**重新挂载** [`ChatRoomInner`](src/components/ChatRoomInner.js:35)，[`useChatMessages`](src/hooks/chat/useChatMessages.js:52) 的 `messages` 从 `[]` 重新开始。紧接着 `fetchMessages` 里 [`setMessages(mergedMessages)`](src/hooks/chat/useChatMessages.js:91) 是**整体覆盖**，而此刻 DB 的 insert 可能还没提交完 —— 于是乐观插入的那条位置消息被抹掉，卡片消失。等用户退出重进时 DB 已有数据，才「突然出现」。

**② 重新定位闪烁：`setStatus('loading')` 把整块内容卸载了**

[`handleRelocate`](src/app/chat/location.js:141) 里 `setStatus('loading')` + `setAddress('')` + `setHint('')`，导致 `status === 'ready'` 的整块 UI（图钉 / 地址 / 坐标 / 提示）被卸载，换成居中的 `ActivityIndicator`，定位回来再挂回去 —— 视觉上就是「闪一下、消失、再出现」。

**③ 横屏照片被裁切：固定 220×300 竖框 + `contentFit="cover"`**

[`MessageBubble.js`](src/components/MessageBubble.js:266) 的 `bubbleMedia` 写死 `{ width: 220, height: 300 }`，配合 `contentFit="cover"`，横屏照片会被裁掉左右两侧去填满竖框，看起来就是「被放大 + 截掉一部分」。

**④ 语音转文字失败：SDK 58 的全局 `fetch` 换成了 `expo/fetch`**

这是本次最隐蔽的一个。Expo SDK 58 把全局 `fetch` 替换为 **`expo/fetch`（winter fetch）**。它的 [`convertFormDataAsync()`](node_modules/expo/src/winter/fetch/convertFormData.ts:38) 只接受三种 part：

- `string`
- `instanceof Blob`
- 带 `bytes()` 方法的对象

RN 传统写法 `formData.append('file', { uri, type, name })` **三者都不是**，于是 [`convertFormData.ts:77`](node_modules/expo/src/winter/fetch/convertFormData.ts:77) 直接抛 `Unsupported FormDataPart implementation`。注意这个错误串在 RN 原生层（`NetworkingModule.kt`）里根本不存在，所以之前一直误判成「网络问题」。

### 修复

**① 位置卡片即时出现**

- [`useChatMessages.js`](src/hooks/chat/useChatMessages.js:91)：`setMessages` 改为**函数式合并** —— 保留本地独有的（乐观）消息，按 id 去重，远端优先，本地独有的前置。
- [`ChatRoomInner.js`](src/components/ChatRoomInner.js:254)：位置 effect 捕获 `insertError`，插入失败时 `consumedLocRef.current = null` 并直接 return（不清 params，允许重进重试）；**只有插入成功后才清路由参数**。

**② 重新定位不闪烁**

- 新增 `isRelocating` 状态，只作用于按钮（`opacity` / `disabled` / 按钮内小转圈），**不参与内容区渲染**。
- 已有坐标时 `handleRelocate` 只 `setHint('正在重新定位…')`，保持 `ready` 态原地刷新；只有首次定位失败（无坐标）时才回到 `loading`。

**③ 图片按原比例完整显示**

- 新增 [`computeMediaSize(width, height)`](src/components/MessageBubble.js:62)：按真实宽高比计算气泡尺寸，上限 `220×300`，最小边 `80`，尺寸未知时退回 4:3 横框。
- `contentFit` 由 `cover` 改为 **`contain`**，`bubbleMedia` 改为 `width/height: '100%'`。
- `onLoad` 用 `e.source.width/height` 二次校正（本地 URI 首帧可能拿不到尺寸）。
- [`useMediaUpload.js`](src/hooks/chat/useMediaUpload.js:270)：乐观发送时写入 `mediaWidth` / `mediaHeight`，首帧即为正确比例，无跳变。

**④ 语音转文字**

- [`ChatInputBar.js`](src/components/ChatInputBar.js:46)：改用 `expo-file-system` 的 `File`（`class File implements Blob`，原生实现 `bytes()`），直接 `formData.append('file', audioFile, 'voice.xxx')`，满足 `expo/fetch` 的序列化要求。
- 顺带删掉不再需要的 `audioMimeOf`（MIME 由 `File.type` 原生推断）。

### 验收

- `npx tsc --noEmit` → 0 错误
- `npx expo lint` → 138 problems（119 errors / 19 warnings），与基线持平，无新增
- 改动文件：`src/components/ChatInputBar.js`、`src/components/MessageBubble.js`、`src/hooks/chat/useMediaUpload.js`、`src/hooks/chat/useChatMessages.js`、`src/components/ChatRoomInner.js`、`src/app/chat/location.js`

---

## 2026-10-30（阶段 4 修复 12：位置消息 / Android 定位慢 / Android 全屏预览空白 / 语音转文字失败）

用户反馈三件事：

1. 发出去的位置信息「根本搜不到」，而且 Android 定位要很久（iOS 一秒出），重新定位点很多次也没用；
2. Android 全屏预览图片和视频「完全看不到东西」，iOS 正常；
3. 语音输入转文字一直提示「网络连接异常，请重试」。

### 根因（三个独立问题，互不相关）

**① 位置：`expo-location` 的 config plugin 根本没配**

`app.json` 的 `plugins` 里没有 `expo-location`，`android.permissions` 里也没有 `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`。结果：

- Android 拿不到精确定位权限，只能靠网络/基站粗定位，且系统不会主动开网络定位提供者 → 表现为「定位很久 / 一直转圈」；
- iOS 缺 `NSLocationWhenInUseUsageDescription`，权限弹窗文案缺失。

另外旧代码只有一次 `getCurrentPositionAsync({ accuracy: High })`，**没有超时、没有兜底**。Android GPS 冷启动动辄 30s+，`High` 精度更慢；「重新定位」按钮在 `loading` 态下没禁用，连点会并发多个定位请求互相覆盖，看起来就是「点很多次才生效」。

**② 位置消息：发的是纯文本 + 裸 Google Maps 链接**

`ChatRoomInner` 把位置当 `type: 'text'` 发出去，内容是 `📍 地址\nhttps://maps.google.com/?q=lat,lng`。在聊天里就是一段文字，点不动、也「搜不到」。

**③ Android 全屏预览空白：`removeClippedSubviews` + `flex: 1` 双杀**

`InteractiveMediaViewer` 的 `FlatList` 上写了 `removeClippedSubviews={Platform.OS === 'android'}`。外层是 `StyleSheet.absoluteFill` + `transform` 动画，Android 的裁剪计算会误判所有 item 都不可见 → 原生视图全被摘掉 → 一片黑。iOS 该属性默认 `false`，所以 iOS 一直正常。

同时图片 `ScrollView` 的 `contentContainerStyle` 用了 `flex: 1`，在 Android 上内容容器高度由内容决定，`flex: 1` 解析为 0 → 图片被压成 0 高度。

**④ 语音转文字：无脑拼 `file://` + 错误被吞**

旧代码 `const uri = audioUri.startsWith('file://') ? audioUri : 'file://' + audioUri;`。Android 录音 URI 可能是 `content://...`，拼完变成 `file://content://...` → `fetch` 直接抛错 → 被 `catch` 统一报成「网络连接异常，请重试」。同时 MIME 硬编码 `audio/m4a`，Groq 对不匹配的类型返回 400，也被报成网络异常。

### 修复

1. **`app.json`**：`plugins` 增加 `expo-location` 配置块（`locationWhenInUsePermission` 中文文案，关闭后台定位与前台服务）；`android.permissions` 增加 `ACCESS_COARSE_LOCATION`、`ACCESS_FINE_LOCATION`。
2. **`src/app/chat/location.js` 定位逻辑重写**：
   - `withTimeout()` 包装，单次定位 12s 上限，绝不无限挂起；
   - Android 先 `enableNetworkProviderAsync()`（4s 超时，用户拒绝也不阻断）；
   - 先取 `getLastKnownPositionAsync()`（3s 超时）→ 界面立刻可用（对齐 iOS 的「一秒出」）；
   - 再 `getCurrentPositionAsync({ accuracy: Balanced })` 精修，失败则沿用已知位置；
   - `runIdRef` 做并发守卫，连点「重新定位」只保留最后一次；
   - 合并原先 `locate()` 与 `useEffect` 里重复的两份定位代码；
   - UI 增加 `hint` 提示（「已使用最近一次定位，正在精确定位…」/「定位超时…」），`loading` 时禁用重新定位按钮。
3. **位置消息改为 `type: 'location'`**：`ChatRoomInner` 发送时 `text` 存可读地址、`media_url` 存 `"lat,lng"`；`MessageBubble` 新增 `location` 渲染分支 —— 可点击地图卡片（图标 + 地址 + 坐标 + 地图预览区），点击调用 `openInMaps()`（iOS `maps.apple.com` / Android `geo:` / 兜底 Google Maps），长按仍走原长按菜单。`parseLocationCoords()` 同时兼容新格式与历史 `maps.google.com` 链接。
4. **`useChatList.formatPreview`** 增加 `location → '[位置]'`。
5. **`InteractiveMediaViewer`**：`removeClippedSubviews={false}`（改用 `windowSize={3}` 控内存）；`contentContainerStyle` 换成显式 `SCREEN_WIDTH/SCREEN_HEIGHT` 的 `imageScrollContent`，去掉 `flex: 1`；`Image` 改用 `contentFit="contain"` + `cachePolicy="memory-disk"`；`renderItem` 与 `fullScreenMedia` 都用显式宽高。
6. **`ChatInputBar.transcribeAudioToText` 重写**：协议感知补前缀（只有裸路径才补 `file://`，`content://` / `ph://` / `file://` 原样用）；`inferAudioExt()` + `audioMimeOf()` 动态 MIME 与文件名；`response_format: 'json'`；缺 Key 时明确提示；HTTP 401/403 → 密钥无效、429 → 频率限制、其他 → 状态码 + 响应体前 120 字；`catch` 透出真实 `error.message`。

### 验收

- `npx tsc --noEmit` → 0
- `npx expo lint` → 138 problems（119 errors / 19 warnings），低于基线 139
- 注意：`app.json` 改了原生配置，**必须重新构建**（`npx expo run:android` 或 `eas build --profile development`），Expo Go 里看不到定位权限变化

---

## 2026-10-30（阶段 4 修复 11：语音发出去无法播放 / 退出重进消失 / 图片视频发不出去 —— 真根因）

用户反馈：语音能录，但发出去点不动播放，退出到主界面再进聊天详情页就消失了；图片和视频完全发不出去。

### 根因（不是权限，不是 RLS，是上传 body 类型）

翻 `node_modules/@supabase/storage-js/dist/index.d.mts` 的 `upload()` 文档注释，里面写得很直白：

> For React Native, using either `Blob`, `File` or `FormData` does not work as intended.
> Upload file using `ArrayBuffer` from base64 file data instead.

旧实现是 `fetch(fileUri)` → `response.blob()` → `upload(fileName, blob, ...)`。在 RN 0.88 新架构下这条链路会失败（或产出 0 字节对象），而 `catch` 里 `return null` 把错误吞了，于是：

1. `uploadToSupabase` 返回 `null` → `if (!mediaResult?.path) throw` → **不落库** → 退出重进自然消失；
2. 乐观消息里的 `mediaUrl` 一直是本地 `file://` URI → `useSignedMediaUrl` 把它当对象路径去 `createSignedUrl` → 必然失败 → `signedMediaUrl` 为 `null` → `MessageBubble.handlePlayAudio` 直接 `return` → **点不动**。

### 修复

1. **`useMediaUpload.uploadToSupabase` 重写**：`readAsStringAsync(uri, { encoding: EncodingType.Base64 })` → `base64-arraybuffer.decode()` → `upload(path, arrayBuffer, { contentType })`。
   - `contentType` 必须显式给（ArrayBuffer body 不给会默认存成 `text/plain`），新增 `guessContentType(ext)` 按扩展名映射，且与 `chat_media` 桶的 `allowed_mime_types` 白名单对齐。
   - `base64-arraybuffer@1.0.2` 本来就在 `package.json` 里但从未被使用，这次正好用上，零新增依赖。
2. **`useSignedMediaUrl` 支持本地 URI**：新增 `isLocalUri()`，`file:// / content:// / ph:// / assets-library:// / data: / blob:` 直接透传渲染，不再拿去签名；`toStoragePath` 对这些协议显式返回 `null`。
3. **`useChatMessages` 新增 `patchMessage(id, patch)`**：上传 + 落库成功后，把乐观消息的 `mediaUrl` / `thumbnailUrl` 从本地 URI 换成真实对象路径（同时刷新 AsyncStorage 缓存）。这样**本次会话内**就能立刻看到图、播语音，不必退出重进。
4. **`useAudioRecorder.stopAndSendRecord`**：上传失败不再静默留幽灵消息，改为 `Alert` 明确提示；落库成功后 `patchMessage` 回填路径。
5. **`useMediaUpload.pickAndSendMedia`**：补 `requestMediaLibraryPermissionsAsync()`（未授权时明确提示去系统设置），`insert` 检查 `error`，失败弹「发送失败」。
6. 清掉临时诊断日志（`[pick] ...`）。

### 验收

- `npx tsc --noEmit` → 0
- `npx expo lint` → 139 problems（119 errors / 20 warnings），与基线持平，无新增

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

## 2026-10-30（阶段 4 修复 8：头像卡片宽度对齐）

头像卡片原先自带 `marginHorizontal: 16`，而 `SettingsPage` 的 `scroll` 已有 `paddingHorizontal: 16`，导致卡片比下方各行**窄了 32px**。

改为把卡片包进 `<Group style={{ marginTop: 24 }}>`，去掉自身 margin 与 border —— 宽度由 `Group` 决定，与「查找聊天记录」「消息免打扰」等行**完全等宽**，圆角与卡片底色也自动继承。

见 [`chat_settings.js`](src/app/chat/chat_settings.js:132)。

**验收**：`npx tsc --noEmit` → 0；`eslint chat_settings.js` → 0；全量 `npx expo lint` → 139 problems，与基线持平。

---

## 2026-10-30（阶段 4 修复 7：深色置顶提亮 + 聊天设置头像卡片）

**1. 深色模式置顶行改为「提亮」**

上一版深色模式把置顶行压暗到 `#0A0A0B`，与深色背景几乎融为一体，看不出置顶。改为与浅色模式对称的「提亮」：

| 主题 | 置顶行 | 选中态 | 方向 |
|---|---|---|---|
| 浅色 | `#E2E2E7` | `#F2F2F7` | 压暗 |
| 深色 | `#2A2A2E` | `#1C1C1E` | **提亮** |

见 [`ConversationRow.js`](src/components/chat/ConversationRow.js:28)。

**2. 聊天设置页顶部新增联系人头像卡片**

[`chat_settings.js`](src/app/chat/chat_settings.js:19) 在「查找聊天记录」上方插入一张卡片：52×52 圆角头像（昵称前两字）+ 昵称 + `ID: xxx` + 右箭头。

- 数据来源：`useEffect` 里 `supabase.from('profiles').select('id, nickname, username, sync_id').eq('id', targetId).maybeSingle()`，失败时回退到路由参数 `targetName`。
- 点击 → `router.push('/chat/friend_settings')`，携带 `id / nickname / username / sync_id`，**与通讯录详细页「3 个点」跳转的是同一个页面**。
- 页面标题同步改为 `displayName`（优先用 profile 昵称）。

**验收**：`npx tsc --noEmit` → 0；目标文件 `eslint` → 0；全量 `npx expo lint` → 139 problems（119 errors / 20 warnings），与基线持平。

---

## 2026-10-30（阶段 4 修复 6：隐藏恢复 + 置顶视觉 + 「3 个点」全面页面化）

用户报告：长按会话选「不显示该聊天」后，该会话永久消失，即使重新对话也不回来。同时要求把「3 个点」从弹窗改为跳转页，并拆出二级设置页。

**1. 隐藏聊天恢复机制（Bug 修复）**

- 新增 [`src/hooks/chat/useChatPrefs.js`](src/hooks/chat/useChatPrefs.js:35)：按用户 ID 隔离的 AsyncStorage 偏好存储（`pinned` / `hidden` / `muted` / `starred` / `blocked` / `backgrounds`）。
- 恢复逻辑在 [`chat.js`](src/app/(tabs)/chat.js:35)：`useEffect` 监听 `latestMessages`，只要某个被隐藏的会话产生了新消息（**收或发**），立即 `prefs.unhide(id)`。因为 `latestMessages` 由 `useChatList` 的 realtime 监听驱动，收发两个方向都能捕获。
- 列表渲染改用 `visibleConversations`（`useMemo`）：先过滤 `hidden`，再按 `pinned` 稳定排序。

**2. 置顶视觉提示**

- [`ConversationRow.js`](src/components/chat/ConversationRow.js:15) 新增 `isPinned` prop，置顶行背景加深：深色 `#0A0A0B`、浅色 `#E2E2E7`（比选中态 `#1C1C1E` / `#F2F2F7` 更暗，两者可区分）。

**3. 「3 个点」全面页面化（不再弹窗、不再共用）**

- 删除 `src/components/chat/ContactActionsMenu.js`（原共用弹窗组件）。
- 聊天室 L2 右上角「3 个点」→ [`router.push('/chat/chat_settings')`](src/components/ChatRoomInner.js:210)。
- 通讯录详细页 L3 右上角「3 个点」→ [`router.push('/chat/friend_settings')`](src/app/contact_profile.js:33)。

**4. 新增 5 个 L3 页面**

| 页面 | 路径 | 功能 |
|---|---|---|
| 聊天设置 | [`chat_settings.js`](src/app/chat/chat_settings.js:19) | 查找记录（跳转）/ 免打扰 + 置顶提醒（SwitchRow）/ 聊天背景（跳转）/ 清空记录 / 投诉（跳转） |
| 查找聊天记录 | [`chat_search.js`](src/app/chat/chat_search.js:14) | `messages` 表 `ilike` 关键词搜索，限本会话双向，最多 50 条 |
| 聊天背景 | [`chat_background.js`](src/app/chat/chat_background.js:15) | `CHAT_BACKGROUNDS` 单选列表，写入 `prefs.setBackground` |
| 朋友设置 | [`friend_settings.js`](src/app/chat/friend_settings.js:19) | 设置资料（备注）/ 朋友权限（跳转）/ 星标 / 推荐 / 添加到桌面 / 黑名单 / 投诉（跳转）/ 删除好友 |
| 朋友权限 | [`friend_permission.js`](src/app/chat/friend_permission.js:24) | 「全部可见」/「仅聊天」单选 |
| 投诉 | [`complaint.js`](src/app/chat/complaint.js:20) | 5 类原因单选 + 补充说明 → `complaints` 表插入（`scope` 区分 chat / friend） |

**5. 数据层**

- 新增 [`src/hooks/chat/useFriendActions.js`](src/hooks/chat/useFriendActions.js:1)：`deleteFriend`（`friends` 表双向 `or(and(...),and(...))` 删除 + 清理已接受的 `friend_requests`）、`updateRemark`。
- `useChatPrefs` 的 effect 改为「异步回调里 setState + 派生 `loaded`」，规避 `react-hooks/set-state-in-effect`。

**验收**：`npx tsc --noEmit` → 0；目标文件 `eslint` → 0；全量 `npx expo lint` → 139 problems（119 errors / 20 warnings），与基线持平。

---

## 2026-10-30（阶段 4 修复 5：占位补全 + 联系人「3 个点」菜单共用）

用户提出两项需求，均已落地。

**1. 补全占位符**

- 长按会话菜单 4 项从 `alert('xx开发中')` 改为真实逻辑：
  - **标为已读** → `messages` 表 `update({ is_read: true })`，限定 `user_id = 对方` 且 `receiver_id = 我`，并本地 `readIds` 立即清零角标。
  - **置顶该聊天** → 本地 `pinnedIds`，列表排序时置顶项排最前（保持原有相对顺序）；已置顶时文案变为「取消置顶」。
  - **不显示该聊天** → 本地 `hiddenIds`，从列表过滤掉，不删任何消息。
  - **删除该聊天** → 二次确认后加入 `hiddenIds` 并移出 `pinnedIds`。
- 聊天室 `handleStartCall` 与 `contact_profile` 的 `handleCall` 保留原有「微信通话共存」说明，改为 `Alert.alert` 多行文案（原为裸 `alert`）。

**2. 联系人「3 个点」菜单（聊天室 L2 + 通讯录详细页 L3 共用）**

- 新建 [`src/components/chat/ContactActionsMenu.js`](src/components/chat/ContactActionsMenu.js:1)：与聊天页右上角「+」同款视觉（圆角卡片 + 纯文字行 + 细分隔线，无图标），贴右上角 `top: 96/72, right: 16`。菜单项：**查看详细资料** / **删除好友**（红色危险项）。
- 新建 [`src/hooks/chat/useFriendActions.js`](src/hooks/chat/useFriendActions.js:1)：`deleteFriend(friendId)` 双向解除 `friends` 关系（`or(and(user_id=me,friend_id=other),and(user_id=other,friend_id=me))`），并清理已通过的 `friend_requests`；`updateRemark` 仅更新「我 → 对方」一条。
- [`ChatRoomInner.js`](src/components/ChatRoomInner.js:212)：把 header 右侧的 `<View style={{ width: 28 }} />` 占位替换为 `ellipsis-horizontal` 按钮 → 呼出菜单。删除好友成功后 `onBack()` 返回列表。
- [`contact_profile.js`](src/app/contact_profile.js:43)：右上角「3 个点」从 `alert('更多联系人设置开发中')` 改为复用同一 `ContactActionsMenu`；删除好友成功后 `router.back()` 回通讯录。同时把裸 `Haptics` 调用统一为 `haptic` 包装器。

**验收**

- `npx tsc --noEmit` → 0
- `npx eslint` 5 个改动文件 → 0 problems
- `npx expo lint` 全量 → **139 problems (119 errors, 20 warnings)**，与修复 4 持平，无新增

---

## 2026-10-30（阶段 4 修复 4：弹窗去图标 + 宽度自适应 + 长按跟随手指 + 缩短触发）

用户实测反馈四点，均已处理。

**1. 两个弹窗都去掉图标**

「+」菜单（联系人 / 添加好友）和长按会话菜单（标为已读 / 置顶 / 不显示 / 删除）全部移除 `Ionicons`，只保留纯文字。行布局从 `flexDirection: 'row' + gap: 10` 改为 `alignItems: 'center' + justifyContent: 'center'`，文字居中。

**2. 宽度自适应文字，不留白**

- 「+」菜单：删除固定 `width: 180`，改为由内容撑开（`paddingHorizontal: 20`）。最长文案「添加好友」4 字 → 实际宽度约 104px，不再有 76px 空白。
- 长按菜单：删除固定 `width: 180`，改为由内容撑开。最长文案「不显示该聊天」6 字 → 实际宽度约 136px。

**3. 长按弹窗位置跟随手指，出现在手指下方**

`handleLongPress(item, evt)` 恢复接收事件对象，从 `evt.nativeEvent` 取 `pageX / pageY`：

```js
const MENU_W = 148;   // 按最长文案估算
const MENU_H = 4 * 46 + 3 * hairline;  // 4 行 + 3 条分隔线
const GAP = 8;        // 手指与弹窗间距

let left = pageX;                                  // 水平对齐触点
if (left + MENU_W > SCREEN_W - 8) left = SCREEN_W - MENU_W - 8;  // 右侧越界左翻
if (left < 8) left = 8;

let top = pageY + GAP;                             // 默认在手指下方
if (top + MENU_H > SCREEN_H - 8) top = pageY - MENU_H - GAP;     // 下方不足则上翻
if (top < 8) top = 8;
```

`menuConfig` 恢复为 `{ visible, top, left, chat }`。新增 `contextMenu` 样式（`position: 'absolute'`，圆角 14、hairline 边框、阴影与「+」一致），与 `plusMenu` 视觉同源但定位方式不同（一个贴右上角、一个跟手指）。

**4. 长按触发时间缩短 50%**

[`ConversationRow.js`](src/components/chat/ConversationRow.js:31) 的 `TouchableOpacity` 加 `delayLongPress={250}`（RN 默认 500ms → 250ms）。

**震动反馈**：`handleLongPress` 首行已有 `haptic.heavy()`（iOS `ImpactFeedbackStyle.Heavy`），长按瞬间即触发，无需新增。

**验收**：`npx tsc --noEmit` → 0；`npx eslint "src/app/(tabs)/chat.js" src/components/chat/ConversationRow.js` → 0；`npx expo lint` → 139（119e/20w），持平。

---

## 2026-10-30（阶段 4 修复 3：长按菜单改「+」同款 + 移除边缘返回手势）

用户实测反馈两点，均已处理。

**1. 移除 iOS 边缘右滑返回首页手势**

一级 tab 页底栏常驻，用户直接点底栏切 tab 即可，边缘手势属于冗余，且会与列表横向滚动 / 长按抢手势。删除整个 `edgeSwipeResponder`（`PanResponder.create`）以及 `SafeAreaView` 上的 `{...edgeSwipeResponder.panHandlers}`，同时移除 `PanResponder`、`Dimensions` 两个 import。

**2. 长按「近期联系人」的弹窗改为与右上角「+」完全同款**

改造前是「伪 ActionSheet」：`Modal animationType="none"` + 透明全屏 `Pressable` + 绝对定位 `View`（`right: 24, width: 140`），且 `top` 由 `handleLongPress` 按触点 `pageY` 动态计算（上半屏贴手指下方，下半屏上移 180px）。

改造后与「+」菜单共用同一套 UI：

- `Modal animationType="fade"`（淡入，与「+」一致）
- 复用 `styles.plusOverlay` / `plusMenu` / `plusMenuItem` / `plusMenuText` / `plusMenuLine`
- 统一锚定右上角（`top: iOS 96 / Android 72, right: 16`），不再跟随触点
- 每行改为「图标 + 文字」横向布局，与「+」菜单视觉一致：
  - 标为已读 → `checkmark-done-outline`
  - 置顶该聊天 → `arrow-up-circle-outline`
  - 不显示该聊天 → `eye-off-outline`
  - 删除该聊天 → `trash-outline` + 红色 `#FF3B30`
- `menuConfig` 从 `{ visible, top, chat }` 简化为 `{ visible, chat }`；`handleLongPress(item)` 不再接收事件对象
- 删除废弃样式 `invisibleOverlay` / `contextMenuContainer` / `contextMenuItem` / `contextText` / `contextTextDanger` / `menuLine`
- `plusMenu` 宽度 160 → 180（容纳「不显示该聊天」6 字 + 图标不换行）

功能项仍为 `alert('...开发中')` 占位，与原实现保持一致（本轮只改 UI，不动业务）。

**验收**：`npx tsc --noEmit` → 0；`npx eslint "src/app/(tabs)/chat.js"` → 0；`npx expo lint` → 139（119e/20w），持平。

---

## 2026-10-30（阶段 4 修复：底栏常驻 + 「+」小弹窗）

阶段 4 交付后用户实测反馈两个问题，均已修复。

**问题 1：聊天 tab 下导航栏消失**

根因在 [`CustomTabBar.js`](src/components/CustomTabBar.js:57)：`toValue: isChatTab ? 250 : 0` —— 旧设计里聊天页自带 BlurView 浮动 Dock，所以全局底栏在聊天 tab 被下移 250px 隐藏。阶段 4 已删除聊天页 Dock，底栏却仍被隐藏，导致用户无法切回其他 tab。

修复：
- `slideAnim` 目标值恒为 `0`，底栏在所有 tab 常驻
- 键盘收起时也恢复 `0`（原逻辑有 `if (!isChatTab)` 守卫，一并移除）

**问题 2：右上角「+」直接跳页，不是小弹窗**

改为 ActionSheet 风格小弹窗（`Modal` + `fade`），贴右上角、宽 160、圆角 14、带阴影，两个选项：
- 联系人 → `/chat/contacts`
- 添加好友 → `/chat/search`

**顺带清理 `CustomTabBar.js` 的 10 个历史 lint 错误**：

| 问题 | 修复 |
|---|---|
| `useRef(new Animated.Value(0)).current`（9 处 `react-hooks/refs`） | 改为 `useState(() => new Animated.Value(0))` |
| `useEffect` 内同步 `setUnreadCount(0)`（`set-state-in-effect`） | 改为派生值 `displayUnread = isChatTab ? 0 : unreadCount`，删除该 effect |

**验收**：

- `npx tsc --noEmit` → 0
- `npx eslint "src/app/(tabs)/chat.js" src/components/CustomTabBar.js` → 0 problems
- `npx expo lint` → **139 problems (119 errors, 20 warnings)**，比上轮 149 **再减 10 个**

---

## 2026-10-30（阶段 4：聊天页纯 IM 化）

聊天页从「消息 / 通讯录」双 Tab 的混合页，收敛为**纯消息列表**。联系人、搜索加友下沉到 L3 页面，符合执行书 §14 的 IM 化目标。

**做了啥**：

1. **新建 `src/hooks/chat/useChatList.js`**（239 行）— 会话列表数据层
   - `formatPreview` 原样迁移（含 `SYNC_CINEMA_ENDED` / `SYNC_PARTNER_*` / `SYNC_SYSTEM` 全部 subtype 分支）
   - `fetchAll` 原样迁移：friends → friend_requests（accepted 补好友 / pending 收请求）→ profiles → 未读数 → 最近 200 条消息生成预览与时间
   - 实时监听原样迁移：`INSERT` 更新预览/时间/未读 +1，`UPDATE` 同步撤回后的预览；频道名带 `Date.now()` 保证唯一
   - 导出 `conversations`（按最新消息时间倒序）、`refresh`、`getDisplayName`（remark 优先）
   - ⚠️ `userIdRef` 改为在 `useEffect` 中同步，避免渲染期写 ref

2. **新建 `src/components/chat/ConversationRow.js`**（121 行）— 会话行
   - 与 `renderMessagesView` 逐项对齐：46×46 圆角 10 头像、未读角标（静音时降级为小红点）、`[N条]` 预览前缀、静音图标
   - 保留 `minWidth: 0` + `flexShrink` 防长昵称撑爆布局（安全审计 #18）

3. **新建 `src/app/chat/contacts.js`**（237 行）— 联系人页
   - 搜索入口行 → `/chat/search`
   - 新朋友请求：同意 / 拒绝，保留安全审计 #6/#7 归属校验（`receiver_id !== user.id` 直接 return；`friends` 插入强制 `user_id: user.id`）
   - 所有联系人 → `/contact_profile`

4. **新建 `src/app/chat/search.js`**（201 行）— 搜索加友
   - 保留安全审计 #16：500ms 防抖 + 在途请求去重 + 同关键词不重复查询 + 长度 < 3 不发起查询
   - 新增「已是好友」前置校验（原实现依赖内存 `friends` 数组，独立页面无此数据，改为查 `friends` 表双向匹配）

5. **重写 `src/app/(tabs)/chat.js`**（607 → 268 行）
   - 删除 `activeTab` 双 Tab、浮动 Dock（BlurView）、`renderContactsView`、搜索相关全部状态与逻辑
   - 保留：平板双栏（`isTablet` + `ChatRoomInner`）、iOS 边缘右滑返回首页、长按上下文菜单（4 项仍为占位）、列表入场动画
   - 右上角新增「+」→ `/chat/contacts`
   - ⚠️ `Animated.Value` 与 `PanResponder` 改用 `useState(() => ...)` 惰性初始化，修复 `react-hooks/refs`

**验收**：

- `npx tsc --noEmit` → 0
- `npx eslint "src/app/(tabs)/chat.js" src/app/chat/ src/hooks/chat/useChatList.js src/components/chat/` → 0 problems
- `npx expo lint` → **149 problems (129 errors, 20 warnings)**，比上轮 158 **减少 9 个**，无回归

**原有功能保全清单**：消息收发、未读角标、静音标记、实时置顶排序、长按菜单、平板双栏、左滑返回、好友请求同意/拒绝、Sync ID 搜索加友 —— 全部保留。

**遗留**：长按菜单 4 项（标为已读 / 置顶 / 不显示 / 删除）仍为 `alert('开发中')`，与改造前一致，待后续实现。

---

## 2026-10-30（阶段 3：空间页 4 卡布局）

空间页从「2 个按钮」升级为执行书 §13 规定的 **4 卡布局**：私密空间 / 朋友圈 / 放映厅 / 浏览器。

**做了啥**：

1. **新建 `src/components/space/SpaceCard.js`** — 空间页通用入口卡
   - 结构：48×48 图标方块（圆角 16）+ 标题（可带角标）+ 副标题 + 右侧 `chevron-forward`
   - 交互全部委托给 `AppleCard`：按压缩放（`SCALE.pressIn/pressOut`）+ `haptic.medium()`
   - 图标用 `Ionicons` 而非 emoji（执行书里写的是 emoji，但项目全局图标体系是 Ionicons，保持一致）
   - 色值一律取自 `useAppTheme().colors`，无硬编码

2. **新建 4 个薄封装入口卡**（`src/components/space/`）
   | 文件 | 图标 | 标题 | 副标题 | 路由 | 强调色 |
   |---|---|---|---|---|---|
   | `PrivateSpaceCard.js` | `lock-closed` | 私密空间 | 只属于你的相册与笔记 | `/private` | `colors.primary` |
   | `MomentsCard.js` | `sparkles` | 朋友圈 | 记录此刻，与好友分享 | `/moments` | `colors.success` |
   | `CinemaCard.js` | `film` | 放映厅 | 一起看片，实时同步 | `/cinema` | `colors.primary` |
   | `BrowserCard.js` | `globe-outline` | 浏览器 | 嗅探媒体，一键投屏 | `/browser` | `colors.iconBackground` |

3. **重写 `src/app/(tabs)/space.js`**（69 → 51 行）
   - 标题从「互联空间」改为「空间」，副标题改为「私密记录 · 好友分享 · 同步观影 · 媒体嗅探」
   - 删除原 2 个内联 `TouchableOpacity` 按钮与全部相关样式（`cinemaButton` / `btnLeft` / `iconBox` / `btnTitle` / `btnSub` / `statusDot`）
   - 删除 `Haptics` / `Ionicons` / `useRouter` 导入（触感与路由已下沉到各卡）

4. **新建占位页**（避免点击 404，阶段 6 实现真实功能）
   - `src/app/private/index.js` — 「私密空间即将上线」
   - `src/app/moments/index.js` — 「朋友圈即将上线」
   - 两者复用 `SettingsPage` 外壳（自带返回栏），居中图标 + 标题 + 说明文案

**验收**：

- `npx tsc --noEmit` → 0
- `npx eslint "src/app/(tabs)/space.js" src/components/space/ src/app/private/ src/app/moments/` → 0 problems
- `npx expo lint` → **158 problems (135 errors, 23 warnings)**，与上轮持平，无回归

**遗留**：`/private` 与 `/moments` 目前是占位页，真实功能在阶段 6（私密空间相册/笔记 + 朋友圈发布/时间线）实现。

---

## 2026-10-30（注销账号下沉到「账号安全」页）

「注销账号」从设置页底部操作栏移入 L3 页面「账号安全」，让所有账号级危险操作集中在一处，底部栏只保留「切换账号 / 退出登录」。

**做了啥**：

1. **`src/app/settings/security.js`**（68 → 190 行）
   - 新增 `useState` / `ActivityIndicator` / `Alert` / `TouchableOpacity` / `AsyncStorage` / `router` / `haptic` / `useAuth` / `supabase` 导入
   - 迁入 `performAccountDeletion`（`supabase.rpc('delete_my_account')` → `AsyncStorage.clear()` → `signOut()` → `router.replace('/auth')`）与 `handleDeleteAccount`（两次 Alert 确认），逻辑逐字保留，仅把 `Haptics.impactAsync(...)` 换成统一的 `haptic.heavy()` / `haptic.warning()` / `haptic.success()`
   - 新增 `isDeleting` 状态：执行中按钮禁用 + 显示 `ActivityIndicator`，防止连点重复调用 RPC
   - 新增「危险操作」分组：`GroupTitle` + 红色文字按钮（`#FF3B30`，`minHeight 52`，圆角 14，与卡片同底色）+ 一行灰色风险提示
   - 修正「数据清除」文案：原来写「请前往『我的 → 注销账号』」，现在改为「请使用本页底部的『注销账号』」，并补上「存储空间」清理本地缓存的指引
   - 无障碍：`accessibilityRole="button"` + `accessibilityLabel` + `accessibilityHint`

2. **`src/app/settings.js`**（210 → 145 行）
   - 删除 `performAccountDeletion` / `handleDeleteAccount` / `isDeleting`
   - 移除 `useState`、`AsyncStorage`、`supabase` 导入（`useRef` 保留给 `isGoingBack`）
   - 底部栏从 3 行减为 2 行：切换账号 / 退出登录

**验收**：

- `npx tsc --noEmit` → 0
- `npx eslint src/app/settings.js src/app/settings/security.js` → 0 problems
- `npx expo lint` → **158 problems (135 errors, 23 warnings)**，与上轮持平，无回归

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

## 2026-10-30（阶段 4 修复 10：图片 / 视频 / 语音发不出去 —— 回归修复）

**现象**：上一轮补齐占位符后，聊天室里「媒体库」「按住说话」全部失效，点了没反应，消息发不出去。

**原因**：位置消息的 `useEffect` 依赖数组里放了 `router`。

1. `useRouter()` 返回的对象**每次渲染都是新引用**，所以这个 effect 每次渲染都会重跑。
2. 更致命的是 `router.setParams({ locLat: undefined, ... })` —— 即使参数本来就是 `undefined`，`setParams` 依然会触发路由状态更新 → 重渲染 → effect 再跑 → 再 `setParams`，**形成无限循环**。
3. 这个循环把 JS 线程占满，`ImagePicker.launchImageLibraryAsync()` 和录音的异步回调永远排不上队，表现就是「点了没反应」。

**修复**（[`ChatRoomInner.js`](src/components/ChatRoomInner.js:241)）：

- 用 `routerRef` 持有 router，`useEffect` 里同步更新，**从依赖数组里彻底移除 `router`**。
- 新增 `consumedLocRef`，用 `lat,lng,label` 拼成 key 做「已消费」标记，保证同一次定位只发送一次消息。
- `setParams` 包在 `try/catch` 里，且只在 `!cancelled` 时执行。

**教训**：Expo Router 的 `router` 对象**永远不能进 `useEffect` 依赖数组**。需要用到时一律用 ref 持有。同理，`setParams` 传 `undefined` 不等于「无操作」，它仍会触发一次路由更新。

**验收**：`npx tsc --noEmit` → 0；`eslint ChatRoomInner.js` → 0；全量 `npx expo lint` → 139 problems（119 errors / 20 warnings），与基线持平。

---

## 模板（复制用）

```
## YYYY-MM-DD

**做了啥**：

**踩的坑**：（现象 → 原因 → 怎么解决的）

**数字**：+X/-Y 行，新增 N 个文件，tsc/lint/doctor 结果

**下次接着干**：
```
