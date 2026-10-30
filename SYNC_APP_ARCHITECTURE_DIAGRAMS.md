# Sync App 重构 —— 完整架构模型图册

> **配套文档**：
> - [`SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](SYNC_APP_REFACTOR_EXECUTION_SPEC.md)（第 1 部分：总纲）
> - [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md)（第 2 部分：阶段 1-3）
> - [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md)（第 3 部分：阶段 4-7）
>
> **本文件**：全部架构模型图，共 **18 张**，分 6 组。
> 所有图均为 Mermaid，可在 VS Code / GitHub / Typora 直接渲染。

---

## 图册目录

| 组 | 图号 | 名称 |
|---|---|---|
| **A 全局** | 图 1 | 全局总览架构图（一图看全） |
| | 图 2 | 三层路由模型图 |
| | 图 3 | 完整路由树（L1/L2/L3 全量） |
| **B 分层** | 图 4 | 五层分层架构图 |
| | 图 5 | Provider 树与数据流图 |
| | 图 6 | 目录结构图 |
| **C 阶段 1-3** | 图 7 | 阶段 1 地基组件依赖图 |
| | 图 8 | 阶段 2 首页组件树 |
| | 图 9 | 阶段 3 空间页 + 设置页拆分图 |
| **D 阶段 4-7** | 图 10 | 阶段 4 聊天 IM 化改造图 |
| | 图 11 | 阶段 5 放映厅 + 浏览器拆分图 |
| | 图 12 | 阶段 6 私密空间 + 朋友圈图 |
| | 图 13 | 阶段 7 收口流程图 |
| **E 数据** | 图 14 | 数据模型 ER 图（现有 + 新增） |
| | 图 15 | 数据访问分层图（双后端预留） |
| | 图 16 | 实时同步时序图 |
| **F 体系** | 图 17 | 动效 + 触感体系图 |
| | 图 18 | 七阶段执行甘特图 |

---

# A 组：全局架构

## 图 1：全局总览架构图（一图看全）

```mermaid
graph TB
    subgraph L1["🟦 L1 主 Tab 层（底栏显示）"]
        T1["🏠 首页<br/>(tabs)/index.js"]
        T2["🧩 空间<br/>(tabs)/space.js"]
        T3["💬 聊天<br/>(tabs)/chat.js"]
        T4["👤 我的<br/>(tabs)/profile.js"]
    end

    subgraph L2["🟨 L2 根级页面（底栏隐藏）"]
        P1["设置 settings/"]
        P2["账号 account_info"]
        P3["邀请 invite_friend"]
        P4["搭子 bind_partner"]
        P5["聊天室 chat_room"]
        P6["联系人 contact_profile"]
        P7["认证 auth"]
    end

    subgraph L3["🟩 L3 模块子页（底栏隐藏）"]
        M1["🎬 放映厅<br/>cinema/"]
        M2["🌐 浏览器<br/>browser/"]
        M3["🔒 私密空间<br/>private/"]
        M4["✨ 朋友圈<br/>moments/"]
        M5["💬 聊天子页<br/>chat/"]
        M6["⚙️ 设置子页<br/>settings/"]
    end

    subgraph UI["🎨 UI 组件层（阶段 1 新建）"]
        U1["AppleCard"]
        U2["AppleButton"]
        U3["AppleListRow"]
        U4["AppleSectionHeader"]
        U5["ProgressRing"]
        U6["Skeleton"]
        U7["EmptyState"]
    end

    subgraph BIZ["🧱 业务组件层"]
        B1["home/* 首页 4 卡"]
        B2["space/* 空间 5 卡"]
        B3["ChatRoomInner / MessageBubble / ChatInputBar"]
        B4["browser/* 弹窗"]
        B5["WaterProgress / MealListItem / MealDetailSheet"]
        B6["FloatingPlayer / CustomTabBar"]
    end

    subgraph HOOK["⚙️ 数据 Hook 层（只消费不改）"]
        H1["useHealthData"]
        H2["useCinema"]
        H3["useSyncRoom"]
        H4["useAuth"]
        H5["chat/* 4 个"]
        H6["browser/* 5 个"]
        H7["health/* 5 个"]
    end

    subgraph SVC["🔌 服务层"]
        S1["supabase.js"]
        S2["pushService.js"]
    end

    subgraph CONST["📐 常量层（红线）"]
        C1["colors.js 🔴不可改"]
        C2["theme.js 🔴不可改"]
        C3["motion.js 🆕"]
        C4["haptics.js 🆕"]
        C5["features.js 🆕"]
        C6["limits.js 🆕"]
    end

    subgraph CTX["🌗 上下文层"]
        X1["ThemeContext 🔴不可改"]
        X2["AuthProvider"]
        X3["HealthProvider"]
        X4["CinemaProvider"]
    end

    subgraph BE["☁️ 后端"]
        BE1[("Supabase<br/>Postgres + RLS")]
        BE2[("Supabase Storage<br/>private-album")]
        BE3["Edge Function<br/>send-push"]
        BE4["Realtime<br/>postgres_changes"]
    end

    L1 --> BIZ
    L2 --> BIZ
    L3 --> BIZ
    BIZ --> UI
    BIZ --> HOOK
    L1 --> HOOK
    L2 --> HOOK
    L3 --> HOOK
    HOOK --> SVC
    HOOK --> CTX
    UI --> CONST
    BIZ --> CONST
    SVC --> BE1
    SVC --> BE2
    SVC --> BE3
    HOOK --> BE4
    CTX --> C1
    CTX --> C2

    style L1 fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style L2 fill:#FFF8E1,stroke:#F9A825,stroke-width:2px
    style L3 fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
    style UI fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px
    style BIZ fill:#FCE4EC,stroke:#C2185B,stroke-width:2px
    style HOOK fill:#E0F7FA,stroke:#00838F,stroke-width:2px
    style SVC fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
    style CONST fill:#FFEBEE,stroke:#C62828,stroke-width:2px
    style CTX fill:#EDE7F6,stroke:#4527A0,stroke-width:2px
    style BE fill:#ECEFF1,stroke:#455A64,stroke-width:2px
```

---

## 图 2：三层路由模型图

```mermaid
graph LR
    subgraph ROOT["src/app/"]
        direction TB
        subgraph G1["(tabs)/ 分组"]
            A1["index.js"]
            A2["space.js"]
            A3["chat.js"]
            A4["profile.js"]
            A5["_layout.js<br/>Tabs 导航器"]
        end
        subgraph G2["根级文件"]
            B1["_layout.js<br/>Stack 根导航"]
            B2["settings/"]
            B3["account_info.js"]
            B4["bind_partner.js"]
            B5["chat_room.js"]
            B6["contact_profile.js"]
            B7["invite_friend.js"]
            B8["auth.js"]
        end
        subgraph G3["模块目录"]
            C1["cinema/"]
            C2["browser/"]
            C3["private/"]
            C4["moments/"]
            C5["chat/"]
        end
    end

    G1 -->|"底栏 ✅ 显示"| BAR["CustomTabBar<br/>4 个 Tab"]
    G2 -->|"底栏 ❌ 自动隐藏"| NOBAR1["无底栏"]
    G3 -->|"底栏 ❌ 自动隐藏"| NOBAR2["无底栏"]

    style G1 fill:#E3F2FD,stroke:#1976D2
    style G2 fill:#FFF8E1,stroke:#F9A825
    style G3 fill:#E8F5E9,stroke:#388E3C
    style BAR fill:#C8E6C9,stroke:#2E7D32
    style NOBAR1 fill:#FFCDD2,stroke:#C62828
    style NOBAR2 fill:#FFCDD2,stroke:#C62828
```

> **核心结论**：底栏显示/隐藏**零代码**，完全由 Expo Router 的 `(tabs)` 分组决定。任何放在 `(tabs)/` 外的路由天然无底栏。

---

## 图 3：完整路由树（L1/L2/L3 全量）

```mermaid
graph TD
    ROOT["/ 根路由<br/>_layout.js<br/>ThemeProvider→Auth→Health→Cinema→Stack"]

    ROOT --> TABS["(tabs) L1<br/>底栏 ✅"]
    ROOT --> L2A["settings/ L2"]
    ROOT --> L2B["account_info L2"]
    ROOT --> L2C["bind_partner L2"]
    ROOT --> L2D["invite_friend L2"]
    ROOT --> L2E["chat_room L2"]
    ROOT --> L2F["contact_profile L2"]
    ROOT --> L2G["auth L2"]
    ROOT --> L3A["cinema/ L3"]
    ROOT --> L3B["browser/ L3"]
    ROOT --> L3C["private/ L3"]
    ROOT --> L3D["moments/ L3"]
    ROOT --> L3E["chat/ L3"]

    TABS --> T1["🏠 首页 index"]
    TABS --> T2["🧩 空间 space"]
    TABS --> T3["💬 聊天 chat"]
    TABS --> T4["👤 我的 profile"]

    L2A --> S1["index 设置主页"]
    L2A --> S2["account 账号"]
    L2A --> S3["privacy 隐私"]
    L2A --> S4["security 安全"]
    L2A --> S5["appearance 外观"]
    L2A --> S6["about 关于"]

    L3A --> C1["index 大厅"]
    L3A --> C2["room/[roomId] 房间"]
    L3A --> C3["search 搜索大厅"]
    L3A --> C4["create 创建房间"]

    L3B --> B1["index 浏览器主页"]
    L3B --> B2["history 历史"]
    L3B --> B3["bookmarks 书签"]

    L3C --> P1["index 私密主页"]
    L3C --> P2["album 私密相册"]
    L3C --> P3["notes 私密笔记"]

    L3D --> M1["index 朋友圈流"]
    L3D --> M2["publish 发布"]
    L3D --> M3["[momentId] 详情"]

    L3E --> H1["contacts 联系人"]
    L3E --> H2["search 搜索加友"]

    style TABS fill:#E3F2FD,stroke:#1976D2,stroke-width:3px
    style L2A fill:#FFF8E1,stroke:#F9A825
    style L2B fill:#FFF8E1,stroke:#F9A825
    style L2C fill:#FFF8E1,stroke:#F9A825
    style L2D fill:#FFF8E1,stroke:#F9A825
    style L2E fill:#FFF8E1,stroke:#F9A825
    style L2F fill:#FFF8E1,stroke:#F9A825
    style L2G fill:#FFF8E1,stroke:#F9A825
    style L3A fill:#E8F5E9,stroke:#388E3C
    style L3B fill:#E8F5E9,stroke:#388E3C
    style L3C fill:#E8F5E9,stroke:#388E3C
    style L3D fill:#E8F5E9,stroke:#388E3C
    style L3E fill:#E8F5E9,stroke:#388E3C
```

---

# B 组：分层架构

## 图 4：五层分层架构图

```mermaid
graph TB
    subgraph LAYER1["第 1 层：路由层 src/app/**"]
        R1["页面组件<br/>只负责布局与组合"]
    end

    subgraph LAYER2["第 2 层：业务组件层 src/components/**"]
        R2["可复用 UI 组合<br/>接收 props，不直接取数据"]
    end

    subgraph LAYER3["第 3 层：UI 原子层 src/components/ui/**"]
        R3["AppleCard / AppleButton / AppleListRow<br/>ProgressRing / Skeleton / EmptyState"]
    end

    subgraph LAYER4["第 4 层：数据 Hook 层 src/hooks/**"]
        R4["封装状态 + 副作用 + Supabase 调用<br/>返回 { data, loading, error, actions }"]
    end

    subgraph LAYER5["第 5 层：服务层 src/services/**"]
        R5["supabase.js 客户端单点<br/>pushService.js 推送单点"]
    end

    subgraph LAYER6["横切层：常量 / 上下文"]
        R6["constants/ 颜色·尺寸·动效·触感·开关<br/>context/ 主题·认证·健康·放映厅"]
    end

    R1 --> R2
    R2 --> R3
    R1 --> R4
    R2 --> R4
    R4 --> R5
    R3 -.->|"读 colors/motion/haptics"| R6
    R4 -.->|"读 context"| R6
    R1 -.->|"读 context"| R6

    style LAYER1 fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style LAYER2 fill:#FCE4EC,stroke:#C2185B,stroke-width:2px
    style LAYER3 fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px
    style LAYER4 fill:#E0F7FA,stroke:#00838F,stroke-width:2px
    style LAYER5 fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
    style LAYER6 fill:#FFEBEE,stroke:#C62828,stroke-width:2px
```

**依赖方向铁律**：只能**自上而下**依赖，禁止反向。UI 层（第 1-3 层）**禁止**直接 `import { supabase }`。

---

## 图 5：Provider 树与数据流图

```mermaid
graph TB
    subgraph PROVIDERS["Provider 嵌套顺序（src/app/_layout.js）"]
        direction TB
        P0["ThemeProvider<br/>主题模式 + 调色板"]
        P1["AuthProvider<br/>user / signOut"]
        P2["HealthProvider<br/>饮水·餐食·打卡·搭子"]
        P3["CinemaProvider<br/>播放器·音频模式"]
        P4["RootNavigation<br/>Stack 导航器"]
        P5["FloatingPlayer<br/>悬浮播放器"]

        P0 --> P1 --> P2 --> P3 --> P4
        P4 -.->|"全局浮层"| P5
    end

    subgraph CONSUMERS["消费方"]
        C1["所有页面<br/>useAppTheme()"]
        C2["首页 / 我的<br/>useAuth()"]
        C3["首页<br/>useHealthData()"]
        C4["放映厅<br/>useCinema()"]
    end

    P0 -.-> C1
    P1 -.-> C2
    P2 -.-> C3
    P3 -.-> C4

    style P0 fill:#EDE7F6,stroke:#4527A0,stroke-width:2px
    style P1 fill:#E8EAF6,stroke:#283593,stroke-width:2px
    style P2 fill:#E0F2F1,stroke:#00695C,stroke-width:2px
    style P3 fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
    style P4 fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style P5 fill:#FCE4EC,stroke:#C2185B,stroke-width:2px
```

**数据流方向**：

```
用户操作 → 页面 → hook action → supabase → 返回 → hook state → 页面重渲染
                                    ↓
                            Realtime 推送 → hook 订阅 → state 更新 → 自动重渲染
```

---

## 图 6：目录结构图

```mermaid
graph LR
    subgraph SRC["src/"]
        direction TB
        A["app/<br/>🟦 路由层"]
        B["components/<br/>🟪 组件层"]
        C["hooks/<br/>🟩 数据层"]
        D["services/<br/>🟧 服务层"]
        E["constants/<br/>🟥 常量层"]
        F["context/<br/>🟨 上下文层"]
        G["types/<br/>🆕 TS 预留"]
        H["scripts/<br/>注入脚本"]
        I["navigation/<br/>导航辅助"]
        J["utils/<br/>工具函数"]
    end

    A --> A1["(tabs)/ 4 个 tab"]
    A --> A2["根级 7 个 L2"]
    A --> A3["5 个模块目录 L3"]

    B --> B1["ui/ 🆕 7 个原子组件"]
    B --> B2["home/ 🆕 4 个首页卡"]
    B --> B3["space/ 🆕 5 个空间卡"]
    B --> B4["browser/ 2 个弹窗"]
    B --> B5["聊天 4 个组件"]
    B --> B6["健康 3 个组件"]

    C --> C1["health/ 5 个"]
    C --> C2["chat/ 4 个"]
    C --> C3["browser/ 5 个"]
    C --> C4["根级 5 个"]

    E --> E1["colors.js 🔴"]
    E --> E2["theme.js 🔴"]
    E --> E3["motion.js 🆕"]
    E --> E4["haptics.js 🆕"]
    E --> E5["features.js 🆕"]
    E --> E6["limits.js 🆕"]

    style SRC fill:#FAFAFA,stroke:#616161
    style A fill:#E3F2FD,stroke:#1976D2
    style B fill:#F3E5F5,stroke:#7B1FA2
    style C fill:#E0F7FA,stroke:#00838F
    style D fill:#FFF3E0,stroke:#EF6C00
    style E fill:#FFEBEE,stroke:#C62828
    style F fill:#FFF8E1,stroke:#F9A825
    style G fill:#E8F5E9,stroke:#388E3C
```

---

# C 组：阶段 1-3 架构

## 图 7：阶段 1 地基组件依赖图

```mermaid
graph TB
    subgraph NEWCONST["🆕 新建常量（阶段 1）"]
        M["motion.js<br/>DURATION / SPRING / EASING / SCALE / STAGGER"]
        H["haptics.js<br/>light/medium/heavy/success/warning/error/selection"]
        F["features.js<br/>FEATURES 能力开关"]
        L["limits.js<br/>LIMITS 配额"]
    end

    subgraph EXIST["🔴 现有常量（不可改）"]
        C["colors.js"]
        T["theme.js"]
        TC["ThemeContext.js"]
    end

    subgraph NEWUI["🆕 新建 UI 组件（阶段 1）"]
        U1["AppleCard"]
        U2["AppleButton"]
        U3["AppleListRow"]
        U4["AppleSectionHeader"]
        U5["ProgressRing"]
        U6["Skeleton"]
        U7["EmptyState"]
        U8["index.js 统一出口"]
    end

    subgraph DEP["📦 依赖"]
        D1["@shopify/flash-list 🆕"]
        D2["react-native-reanimated ✅已有"]
        D3["react-native-svg ✅已有"]
        D4["expo-linear-gradient ✅已有"]
        D5["expo-haptics ✅已有"]
    end

    U1 --> M
    U1 --> H
    U1 --> TC
    U2 --> M
    U2 --> H
    U2 --> TC
    U3 --> H
    U3 --> TC
    U4 --> TC
    U5 --> D2
    U5 --> D3
    U5 --> TC
    U6 --> D4
    U6 --> M
    U6 --> TC
    U7 --> TC
    H --> D5
    U8 --> U1
    U8 --> U2
    U8 --> U3
    U8 --> U4
    U8 --> U5
    U8 --> U6
    U8 --> U7
    TC --> C
    TC --> T

    style NEWCONST fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
    style EXIST fill:#FFEBEE,stroke:#C62828,stroke-width:2px
    style NEWUI fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px
    style DEP fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
```

---

## 图 8：阶段 2 首页组件树

```mermaid
graph TD
    ROOT["🏠 首页 (tabs)/index.js<br/>ScrollView"]

    ROOT --> H1["Header<br/>问候 + 日期"]
    ROOT --> PSC["PartnerStatusCard<br/>🆕 搭子状态卡"]
    ROOT --> WC["WaterCard<br/>🆕 饮水卡"]
    ROOT --> MG["MealGrid<br/>🆕 2×2 餐食格"]
    ROOT --> SC["StreakCard<br/>🆕 连续打卡卡"]
    ROOT --> SP["bottomSpacer 100px"]

    PSC --> PSC1["未绑定：邀请引导<br/>→ /bind_partner"]
    PSC --> PSC2["已绑定：对方昵称+状态"]

    WC --> WP["WaterProgress<br/>✅ 复用现有"]
    WP --> WP1["微调：动画曲线"]
    WP --> WP2["微调：触感"]

    MG --> ML1["MealListItem 早餐"]
    MG --> ML2["MealListItem 午餐"]
    MG --> ML3["MealListItem 晚餐"]
    MG --> ML4["MealListItem 加餐"]

    SC --> PR["ProgressRing<br/>外环今日 / 内环周进度"]

    ROOT -.->|"点击餐食"| MDS["MealDetailSheet<br/>✅ 复用现有"]
    MDS --> MDS1["微调：SPRING.bouncy"]
    MDS --> MDS2["微调：success/warning 触感"]

    subgraph DATA["数据来源（不改）"]
        HD["useHealthData()<br/>waterAmount / maxWater / meals<br/>checked / streak / partner / partnerData"]
    end

    ROOT -.->|"消费"| DATA

    style ROOT fill:#E3F2FD,stroke:#1976D2,stroke-width:3px
    style PSC fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style WC fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style MG fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style SC fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style DATA fill:#E0F7FA,stroke:#00838F,stroke-width:2px
```

---

## 图 9：阶段 3 空间页 + 设置页拆分图

```mermaid
graph TB
    subgraph SPACE["🧩 空间页 (tabs)/space.js"]
        S0["标题 空间"]
        S1["PrivateSpaceCard 🔒<br/>→ /private"]
        S2["MomentsCard ✨<br/>→ /moments"]
        S3["CinemaCard 🎬<br/>→ /cinema"]
        S4["BrowserCard 🌐<br/>→ /browser"]
        S0 --> S1 --> S2 --> S3 --> S4
    end

    subgraph SETTINGS_OLD["⚙️ 原 settings.js（单文件 352 行）"]
        OLD["账号 3 项<br/>隐私 5 项<br/>安全 4 项<br/>外观 3 项 + 签名<br/>关于<br/>退出 / 注销"]
    end

    subgraph SETTINGS_NEW["⚙️ 新 settings/ 目录（L3）"]
        N0["index.js<br/>3 分组导航"]
        N1["account.js<br/>账号信息 / 邀请 / 搭子"]
        N2["privacy.js<br/>隐私 5 项 ✅全保留"]
        N3["security.js<br/>安全 4 项 ✅全保留"]
        N4["appearance.js<br/>主题 3 项 + 签名"]
        N5["about.js<br/>版本 / 政策 / 协议"]
        N0 --> N1
        N0 --> N2
        N0 --> N3
        N0 --> N4
        N0 --> N5
    end

    subgraph PROFILE["👤 我的页 (tabs)/profile.js"]
        PR0["保持结构"]
        PR1["微调：头像按压缩放"]
        PR2["微调：列表改 AppleListRow"]
        PR3["微调：退出 heavy / 注销 error"]
        PR0 --> PR1 --> PR2 --> PR3
    end

    OLD ==>|"拆分迁移<br/>一项不丢"| SETTINGS_NEW

    style SPACE fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
    style SETTINGS_OLD fill:#FFEBEE,stroke:#C62828,stroke-width:2px
    style SETTINGS_NEW fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style PROFILE fill:#FFF8E1,stroke:#F9A825,stroke-width:2px
```

---

# D 组：阶段 4-7 架构

## 图 10：阶段 4 聊天 IM 化改造图

```mermaid
graph TB
    subgraph BEFORE["改造前 (tabs)/chat.js 559 行"]
        B0["分段控件：消息 / 联系人"]
        B1["消息列表"]
        B2["联系人列表"]
        B3["搜索加友（页内 224-279 行）"]
        B0 --> B1
        B0 --> B2
        B0 --> B3
    end

    subgraph AFTER["改造后（纯 IM）"]
        A0["(tabs)/chat.js<br/>仅消息列表 FlashList"]
        A1["chat/contacts.js<br/>联系人独立页"]
        A2["chat/search.js<br/>搜索加友独立页"]
        A0 -->|"右上角 +"| A2
        A0 -->|"联系人入口"| A1
    end

    subgraph KEEP["🔴 逻辑一律不动（只微调动效/触感）"]
        K1["ChatRoomInner.js"]
        K2["MessageBubble.js"]
        K3["ChatInputBar.js"]
        K4["useChatMessages.js"]
        K5["useMediaUpload.js"]
        K6["useSignedMediaUrl.js"]
        K7["useAudioRecorder.js"]
    end

    B1 ==>|"迁移"| A0
    B2 ==>|"迁移"| A1
    B3 ==>|"迁移"| A2

    A0 --> K1
    A1 --> K1
    A2 --> K1

    style BEFORE fill:#FFEBEE,stroke:#C62828,stroke-width:2px
    style AFTER fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style KEEP fill:#FFCDD2,stroke:#B71C1C,stroke-width:2px
```

---

## 图 11：阶段 5 放映厅 + 浏览器拆分图

```mermaid
graph TB
    subgraph CINEMA_OLD["🎬 原 cinema.js 511 行"]
        CO["播放器 + 弹幕 + 进度条<br/>全部混在一个文件"]
    end

    subgraph CINEMA_NEW["🎬 新 cinema/ 目录"]
        CN0["index.js 大厅<br/>我的房间 + 最近公开"]
        CN1["room/[roomId].js 房间<br/>播放器逻辑原样迁移"]
        CN2["search.js 搜索大厅<br/>🆕 公开房间搜索"]
        CN3["create.js 创建房间<br/>公开/私人 + 密码"]
        CN0 --> CN1
        CN0 --> CN2
        CN0 --> CN3
        CN2 -->|"点击结果"| CN1
        CN3 -->|"创建后"| CN1
    end

    subgraph BROWSER_OLD["🌐 原 browser.js 424 行"]
        BO["WebView + 历史 + 书签 + 嗅探<br/>全部混在一个文件"]
    end

    subgraph BROWSER_NEW["🌐 新 browser/ 目录"]
        BN0["index.js 主页<br/>WebView 主体"]
        BN1["history.js 历史"]
        BN2["bookmarks.js 书签"]
        BN0 --> BN1
        BN0 --> BN2
    end

    subgraph HOOKS["✅ 5 个领域 Hook 原样复用"]
        BH1["useBrowserHistory"]
        BH2["useBrowserSniffer"]
        BH3["useAdBlocker"]
        BH4["useBrowserProgress"]
        BH5["useBrowserNavigation"]
    end

    subgraph SQL["🗄️ 新增 SQL"]
        Q1["cinema_rooms 表<br/>visibility: public/private<br/>+ RLS + 触发器"]
    end

    CO ==>|"拆分"| CINEMA_NEW
    BO ==>|"拆分"| BROWSER_NEW
    BROWSER_NEW --> HOOKS
    CN0 --> Q1
    CN2 --> Q1
    CN3 --> Q1
    BN0 -.->|"嗅探投屏"| CN1

    style CINEMA_OLD fill:#FFEBEE,stroke:#C62828,stroke-width:2px
    style BROWSER_OLD fill:#FFEBEE,stroke:#C62828,stroke-width:2px
    style CINEMA_NEW fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style BROWSER_NEW fill:#C8E6C9,stroke:#2E7D32,stroke-width:2px
    style HOOKS fill:#E0F7FA,stroke:#00838F,stroke-width:2px
    style SQL fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
```

---

## 图 12：阶段 6 私密空间 + 朋友圈图

```mermaid
graph TB
    subgraph PRIVATE["🔒 私密空间 private/"]
        P0["index.js 主页<br/>相册 / 笔记 双入口 + 统计"]
        P1["album.js 私密相册<br/>FlashList 3 列网格"]
        P2["notes.js 私密笔记<br/>FlashList 列表"]
        P0 --> P1
        P0 --> P2
    end

    subgraph MOMENTS["✨ 朋友圈 moments/"]
        M0["index.js 朋友圈流<br/>FlashList"]
        M1["publish.js 发布<br/>文字 + 9 图 + 可见性"]
        M2["[momentId].js 详情<br/>评论列表 + 输入"]
        M0 --> M1
        M0 --> M2
    end

    subgraph DB["🗄️ 新增 SQL（5 张表）"]
        D1[("private_album<br/>owner_id + storage_path")]
        D2[("private_notes<br/>owner_id + title + content")]
        D3[("moments<br/>author_id + content + images[]")]
        D4[("moment_likes<br/>moment_id + user_id")]
        D5[("moment_comments<br/>moment_id + author_id")]
        D3 --> D4
        D3 --> D5
    end

    subgraph STORAGE["📦 Supabase Storage"]
        ST1[("private-album bucket<br/>public: false<br/>RLS: foldername[1] = uid")]
    end

    subgraph LIMITS["📐 配额（limits.js）"]
        L1["privateAlbumMax 500"]
        L2["privateNotesMax 200"]
        L3["momentsDailyMax 10"]
        L4["momentImagesMax 9"]
    end

    P1 --> D1
    P1 --> ST1
    P2 --> D2
    M0 --> D3
    M1 --> D3
    M2 --> D4
    M2 --> D5
    P1 -.-> L1
    P2 -.-> L2
    M1 -.-> L3
    M1 -.-> L4

    style PRIVATE fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
    style MOMENTS fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px
    style DB fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
    style STORAGE fill:#E0F7FA,stroke:#00838F,stroke-width:2px
    style LIMITS fill:#FFF8E1,stroke:#F9A825,stroke-width:2px
```

---

## 图 13：阶段 7 收口流程图

```mermaid
graph TB
    START["阶段 7 开始"] --> R1["① 红线审查<br/>6 条 grep 命令"]
    R1 --> R1A{"色值硬编码<br/>= 0 ?"}
    R1A -->|"否"| FIX1["改为 colors.*<br/>重新审查"]
    FIX1 --> R1A
    R1A -->|"是"| R2["② UI 层调 supabase<br/>= 0 ?"]
    R2 -->|"否"| FIX2["迁移到 hook"]
    FIX2 --> R2
    R2 -->|"是"| R3["③ 直接调 expo-haptics<br/>= 0 ?"]
    R3 -->|"否"| FIX3["改走 constants/haptics.js"]
    FIX3 --> R3
    R3 -->|"是"| R4["④ 动画魔法数字<br/>≈ 0 ?"]
    R4 -->|"否"| FIX4["改走 DURATION.* / SPRING.*"]
    FIX4 --> R4
    R4 -->|"是"| R5["⑤ src/types 无 .ts 文件"]
    R5 --> R6["⑥ 动效统一审查"]
    R6 --> R7["⑦ 触感统一审查"]
    R7 --> R8["⑧ 真机性能验收<br/>60fps / 无掉帧 / 无泄漏"]
    R8 --> R8A{"全部达标 ?"}
    R8A -->|"否"| FIX5["定位掉帧点<br/>改 worklet / FlashList"]
    FIX5 --> R8
    R8A -->|"是"| R9["⑨ 深色模式全量走查"]
    R9 --> R10["⑩ 底栏显示规则走查<br/>L1 有 / L2 L3 无"]
    R10 --> R11["⑪ 三条命令全绿<br/>tsc / lint / doctor"]
    R11 --> DONE["✅ 重构完成"]

    style START fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style DONE fill:#C8E6C9,stroke:#2E7D32,stroke-width:3px
    style FIX1 fill:#FFCDD2,stroke:#C62828
    style FIX2 fill:#FFCDD2,stroke:#C62828
    style FIX3 fill:#FFCDD2,stroke:#C62828
    style FIX4 fill:#FFCDD2,stroke:#C62828
    style FIX5 fill:#FFCDD2,stroke:#C62828
```

---

# E 组：数据架构

## 图 14：数据模型 ER 图（现有 + 新增）

```mermaid
erDiagram
    AUTH_USERS ||--o{ HEALTH_RECORDS : "拥有"
    AUTH_USERS ||--o{ MESSAGES : "发送"
    AUTH_USERS ||--o{ FRIENDSHIPS : "建立"
    AUTH_USERS ||--o{ CINEMA_ROOMS : "主持"
    AUTH_USERS ||--o{ PRIVATE_ALBUM : "拥有"
    AUTH_USERS ||--o{ PRIVATE_NOTES : "拥有"
    AUTH_USERS ||--o{ MOMENTS : "发布"
    AUTH_USERS ||--o{ MOMENT_LIKES : "点赞"
    AUTH_USERS ||--o{ MOMENT_COMMENTS : "评论"

    AUTH_USERS {
        uuid id PK
        text email
        text sync_id UK
        text nickname
        text avatar_url
        text motto
        timestamptz created_at
    }

    HEALTH_RECORDS {
        uuid id PK
        uuid user_id FK
        date record_date
        int water_amount
        int max_water
        jsonb meals_checked
        int streak_days
        boolean checked_in
        timestamptz updated_at
    }

    MESSAGES {
        uuid id PK
        uuid sender_id FK
        uuid receiver_id FK
        text content
        text subtype
        text media_path
        boolean is_read
        timestamptz created_at
    }

    FRIENDSHIPS {
        uuid id PK
        uuid user_id FK
        uuid friend_id FK
        text status
        timestamptz created_at
    }

    CINEMA_ROOMS {
        uuid id PK
        uuid host_id FK
        text title
        text video_url
        text visibility
        text password
        int member_count
        boolean is_playing
        numeric current_time
        timestamptz created_at
        timestamptz updated_at
    }

    PRIVATE_ALBUM {
        uuid id PK
        uuid owner_id FK
        text storage_path
        text caption
        timestamptz created_at
    }

    PRIVATE_NOTES {
        uuid id PK
        uuid owner_id FK
        text title
        text content
        timestamptz created_at
        timestamptz updated_at
    }

    MOMENTS {
        uuid id PK
        uuid author_id FK
        text content
        text_array images
        text visibility
        int like_count
        int comment_count
        timestamptz created_at
    }

    MOMENT_LIKES {
        uuid moment_id PK_FK
        uuid user_id PK_FK
        timestamptz created_at
    }

    MOMENT_COMMENTS {
        uuid id PK
        uuid moment_id FK
        uuid author_id FK
        text content
        timestamptz created_at
    }
```

**图例**：
- 🟢 现有表：`AUTH_USERS` / `HEALTH_RECORDS` / `MESSAGES` / `FRIENDSHIPS`
- 🆕 新增表（阶段 5）：`CINEMA_ROOMS`
- 🆕 新增表（阶段 6）：`PRIVATE_ALBUM` / `PRIVATE_NOTES` / `MOMENTS` / `MOMENT_LIKES` / `MOMENT_COMMENTS`

---

## 图 15：数据访问分层图（双后端预留）

```mermaid
graph TB
    subgraph UI_LAYER["🟦 UI 层（禁止直接访问后端）"]
        U1["src/app/** 页面"]
        U2["src/components/** 组件"]
    end

    subgraph HOOK_LAYER["🟩 Hook 层（唯一数据入口）"]
        H1["useHealthData"]
        H2["useChatMessages"]
        H3["useCinema"]
        H4["useBrowserHistory"]
        H5["useAuth"]
        H6["🆕 usePrivateAlbum"]
        H7["🆕 useMoments"]
    end

    subgraph SVC_LAYER["🟧 服务层（实现可替换）"]
        S1["supabase.js<br/>客户端单点"]
        S2["pushService.js<br/>推送单点"]
        S3["🆕 partnerService.js<br/>命名中立"]
        S4["🆕 cinemaService.js<br/>命名中立"]
    end

    subgraph ADAPTER["🟨 未来适配层（本次不建）"]
        A1["SupabaseAdapter"]
        A2["FirebaseAdapter"]
    end

    subgraph BACKEND["☁️ 后端"]
        B1[("Supabase<br/>Postgres")]
        B2[("Firebase<br/>未来可选")]
    end

    U1 --> HOOK_LAYER
    U2 --> HOOK_LAYER
    HOOK_LAYER --> SVC_LAYER
    SVC_LAYER -.->|"未来"| ADAPTER
    ADAPTER -.-> B1
    ADAPTER -.-> B2
    S1 --> B1
    S2 --> B1

    style UI_LAYER fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style HOOK_LAYER fill:#E0F7FA,stroke:#00838F,stroke-width:2px
    style SVC_LAYER fill:#FFF3E0,stroke:#EF6C00,stroke-width:2px
    style ADAPTER fill:#FFF8E1,stroke:#F9A825,stroke-width:2px,stroke-dasharray: 5 5
    style BACKEND fill:#ECEFF1,stroke:#455A64,stroke-width:2px
```

**铁律**：`src/app/**` 与 `src/components/**` 中 **grep `supabase.` 必须为 0 行**。这是未来接 Firebase 的唯一保障。

---

## 图 16：实时同步时序图

```mermaid
sequenceDiagram
    autonumber
    participant U1 as 用户 A（房主）
    participant P1 as A 的放映厅页面
    participant H1 as useSyncRoom
    participant SB as Supabase Realtime
    participant H2 as useSyncRoom
    participant P2 as B 的放映厅页面
    participant U2 as 用户 B（观众）

    U1->>P1: 点击播放
    P1->>H1: emitCommand('play', currentTime)
    H1->>SB: broadcast { type:'play', time }
    SB-->>H2: 推送 broadcast 事件
    H2-->>P2: 更新播放状态
    P2-->>U2: 视频开始播放

    U2->>P2: 发送弹幕
    P2->>H2: emitDanmaku(text, color)
    H2->>SB: broadcast { type:'danmaku', text }
    SB-->>H1: 推送 broadcast 事件
    H1-->>P1: 弹幕上屏
    P1-->>U1: 看到 B 的弹幕

    Note over SB: 频道：room:{roomId}<br/>类型：broadcast（低延迟）<br/>presence（在线人数）

    U1->>P1: 拖动进度条
    P1->>H1: emitCommand('seek', newTime)
    H1->>SB: broadcast { type:'seek', time }
    SB-->>H2: 推送
    H2-->>P2: 同步跳转
    P2-->>U2: 进度对齐
```

---

# F 组：体系与计划

## 图 17：动效 + 触感体系图

```mermaid
graph TB
    subgraph MOTION["🎬 动效体系 constants/motion.js"]
        M1["DURATION<br/>instant 120 / fast 200<br/>normal 280 / slow 400<br/>skeleton 1200"]
        M2["SPRING<br/>default 20/220/0.9<br/>bouncy 16/180/1<br/>gentle 24/160/1<br/>snap 18/260/0.8"]
        M3["EASING<br/>standard / decelerate / accelerate"]
        M4["SCALE<br/>pressIn 0.97 / pressOut 1<br/>cardEnter 0.96"]
        M5["STAGGER<br/>list 40ms / grid 30ms"]
    end

    subgraph HAPTIC["📳 触感体系 constants/haptics.js"]
        H1["light<br/>tab 切换 / 卡片点击"]
        H2["medium<br/>按钮 / 长按菜单"]
        H3["heavy<br/>删除 / 危险操作"]
        H4["success<br/>打卡 / 发送 / 保存"]
        H5["warning<br/>配额不足 / 二次确认"]
        H6["error<br/>校验失败"]
        H7["selection<br/>分段控件 / 滚轮"]
    end

    subgraph USAGE["使用场景映射"]
        S1["AppleCard 按压<br/>→ SCALE.pressIn + haptic.light"]
        S2["AppleButton 点击<br/>→ SCALE.pressIn + haptic.medium"]
        S3["MealDetailSheet 弹出<br/>→ SPRING.bouncy"]
        S4["ProgressRing 进度<br/>→ withTiming 700ms cubic"]
        S5["Skeleton 微光<br/>→ DURATION.skeleton 循环"]
        S6["FloatingPlayer 吸附<br/>→ SPRING.snap + haptic.light"]
        S7["列表入场<br/>→ STAGGER.list 逐个"]
        S8["打卡完成<br/>→ haptic.success"]
        S9["删除确认<br/>→ haptic.heavy"]
    end

    subgraph RULE["🔴 铁律"]
        R1["动画中禁止 setState<br/>必须 useSharedValue"]
        R2["长列表必须 FlashList<br/>+ estimatedItemSize"]
        R3["所有 duration 来自 DURATION.*"]
        R4["所有 spring 参数来自 SPRING.*"]
        R5["所有触感来自 haptic.*"]
        R6["Android 触感为 no-op<br/>不加判断分支"]
    end

    M1 --> S3
    M1 --> S5
    M2 --> S3
    M2 --> S6
    M4 --> S1
    M4 --> S2
    M5 --> S7
    H1 --> S1
    H1 --> S6
    H2 --> S2
    H4 --> S8
    H3 --> S9

    style MOTION fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px
    style HAPTIC fill:#E0F7FA,stroke:#00838F,stroke-width:2px
    style USAGE fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
    style RULE fill:#FFEBEE,stroke:#C62828,stroke-width:2px
```

---

## 图 18：七阶段执行甘特图

```mermaid
gantt
    title Sync App 重构执行计划（21-29 天）
    dateFormat  YYYY-MM-DD
    axisFormat  %m/%d

    section 阶段1 地基
    常量 4 个 + UI 组件 7 个 + flash-list :s1, 2026-11-01, 3d

    section 阶段2 首页
    搭子卡 + 饮水卡 + 2×2 餐食 + 打卡卡 :s2, after s1, 4d

    section 阶段3 空间+设置
    空间 4 卡 + 设置拆 6 页 + 我的微调 :s3, after s1, 4d

    section 阶段4 聊天
    纯 IM 化 + 联系人/搜索独立页 :s4, after s1, 4d

    section 阶段5 放映厅+浏览器
    cinema 4 页 + browser 3 页 + SQL :s5, after s3, 5d

    section 阶段6 私密+朋友圈
    private 3 页 + moments 3 页 + SQL :s6, after s3, 6d

    section 阶段7 收口
    红线审查 + 性能验收 + 深色走查 :s7, after s2 s4 s5 s6, 3d
```

**关键路径**：阶段 1 → 阶段 3 → 阶段 6 → 阶段 7（3+4+6+3 = 16 天）
**并行机会**：阶段 2 / 3 / 4 可在阶段 1 完成后并行；阶段 5 / 6 可在阶段 3 完成后并行

---

# 附录：图册使用说明

## A.1 图与文档章节对照

| 图号 | 对应文档章节 |
|---|---|
| 图 1 全局总览 | 第 1 部分 §2.2 |
| 图 2 三层路由 | 第 1 部分 §2.1 |
| 图 3 完整路由树 | 第 1 部分 §5.1-5.3 |
| 图 4 五层分层 | 第 1 部分 §2.4 + §7.3 |
| 图 5 Provider 树 | 第 1 部分 §2.4 |
| 图 6 目录结构 | 第 1 部分 §7.1 + §9.1 |
| 图 7 阶段 1 依赖 | 第 2 部分 §11 |
| 图 8 阶段 2 首页 | 第 2 部分 §12 |
| 图 9 阶段 3 空间+设置 | 第 2 部分 §13 |
| 图 10 阶段 4 聊天 | 第 3 部分 §14 |
| 图 11 阶段 5 放映厅+浏览器 | 第 3 部分 §15 |
| 图 12 阶段 6 私密+朋友圈 | 第 3 部分 §16 |
| 图 13 阶段 7 收口 | 第 3 部分 §17 |
| 图 14 数据 ER | 第 3 部分 §15.2 + §16.2 + §16.7 |
| 图 15 数据访问分层 | 第 1 部分 §7.3 |
| 图 16 实时同步时序 | 第 3 部分 §15.4 |
| 图 17 动效+触感体系 | 第 1 部分 §4.1-4.2 + 第 2 部分 §11.2-11.3 |
| 图 18 甘特图 | 第 2 部分 §10.1 |

## A.2 渲染方式

| 环境 | 方式 |
|---|---|
| **VS Code** | 安装 `Markdown Preview Mermaid Support` 插件，`Cmd+Shift+V` 预览 |
| **GitHub / GitLab** | 直接推送，网页自动渲染 |
| **Typora** | 原生支持，直接打开 |
| **导出 PDF** | 用 `yzane.markdown-pdf` 插件（已检测到日志），或 `mermaid-cli` |
| **在线** | 复制代码块到 https://mermaid.live |

## A.3 图册统计

| 组 | 图数 | 覆盖内容 |
|---|---|---|
| A 全局 | 3 | 总览 / 路由模型 / 路由树 |
| B 分层 | 3 | 五层架构 / Provider / 目录 |
| C 阶段 1-3 | 3 | 地基依赖 / 首页树 / 空间+设置 |
| D 阶段 4-7 | 4 | 聊天 / 放映厅+浏览器 / 私密+朋友圈 / 收口流程 |
| E 数据 | 3 | ER 图 / 访问分层 / 实时时序 |
| F 体系 | 2 | 动效+触感 / 甘特图 |
| **合计** | **18** | 覆盖全部 7 阶段 + 数据 + 体系 |

---

> **图册结束。** 配合三份执行书使用：先看图建立全局认知，再按阶段读细则执行。