# src/types —— TS 转型契约预留目录

> ⚠️ 本目录**当前只放 README**，不写任何 `.ts` 文件。
> 未来全面 JS→TS 迁移时，类型定义集中在此目录。

## 未来文件规划

| 文件 | 内容 |
|---|---|
| `user.ts` | `User` / `SyncId` / `PartnerStatus` / `AuthState` |
| `health.ts` | `WaterRecord` / `MealCheck` / `StreakState` / `HealthRecordRow` |
| `social.ts` | `Moment` / `Comment` / `Like` / `FriendRequest` |
| `media.ts` | `SniffedMedia` / `RoomState` / `SyncSignal` / `Danmaku` |
| `cinema.ts` | `CinemaRoom` / `RoomVisibility` / `PlaybackCommand` |
| `browser.ts` | `BrowserTab` / `HistoryEntry` / `Bookmark` |

## 迁移顺序建议

1. `constants/` → 加 `as const`
2. `types/` → 写类型定义
3. `services/` → 绑定 Supabase 生成类型
4. `hooks/` → 加返回类型
5. `components/` → 加 Props 类型
6. `app/` → 改 `.tsx`，加路由参数类型
7. `tsconfig.json` → 开 `strict: true`
