# P1.4 R3 — Auth 身份权威模块迁移前冻结基线

本目录保存 `src/hooks/useAuth.js` 在 P1.4 R3 迁移**之前**的逐字节副本，
用于新旧行为等价测试（`tests/security/p14r3AuthMigrationEquivalence.test.mjs`）。

## 冻结文件

| 文件 | 原始路径 | 行数 | SHA-256 |
| --- | --- | --- | --- |
| `hooks__useAuth.js` | `src/hooks/useAuth.js` | 477 | `e21f018bb51a92eaf6443cd62d5fc2ce2349031c034e25ef1c9b08b5f292dcfe` |

## 校验方式

```bash
shasum -a 256 tests/fixtures/p14r3/before/hooks__useAuth.js
# 期望：e21f018bb51a92eaf6443cd62d5fc2ce2349031c034e25ef1c9b08b5f292dcfe
```

等价测试启动时（`P14R3-0`）会重新计算并断言该 SHA-256，防止基线被篡改。

## 迁移目标

| 迁移前 | 迁移后 |
| --- | --- |
| `src/hooks/useAuth.js`（477 行，含 1 处 Provider JSX） | `src/hooks/useAuth.tsx` |

## 公开接口（必须逐项保持）

模块导出：

- `AuthProvider({ children })` — 唯一 Provider 组件（`src/app/_layout.js` 唯一消费者）
- `useAuth()` — `useContext(AuthContext)`，**无 Provider 时返回 `undefined`**
  （`AuthContext = createContext()` 无默认值，迁移后必须保持无默认值）

`useAuth()` 返回的 value 字段（13 项，顺序与 `useMemo` 对象字面量一致）：

`user` / `session` / `isAuthLoading` / `authError` / `retrySession` /
`ownerId` / `authEpoch` / `isIdentityTransitioning` / `signOutError` /
`signIn` / `signUp` / `signOut`

## State / Ref / Effect 清单（迁移必须逐项保持）

### State（7）

| 名称 | 初值 |
| --- | --- |
| `user` | `null` |
| `session` | `null` |
| `isAuthLoading` | `true` |
| `authError` | `null` |
| `authEpoch` | `0` |
| `isIdentityTransitioning` | `false` |
| `signOutError` | `null` |

### Ref（6）

| 名称 | 初值 | 用途 |
| --- | --- | --- |
| `storageFailureRef` | `null` | 最新故障态镜像 |
| `authEpochRef` | `0` | 身份代际同步读 |
| `authEventSeqRef` | `0` | 认证事件失效序号 |
| `ownerIdRef` | `null` | 当前 owner 镜像 |
| `sessionRef` | `null` | 当前 session 镜像（token 轮换检测） |
| `signOutInFlightRef` | `false` | 登出同步重入锁 |

### useCallback（5）

| 名称 | 依赖数组 |
| --- | --- |
| `bumpAuthEventSeq` | `[]` |
| `bumpAuthEpoch` | `[]` |
| `syncStorageFailure` | `[]` |
| `applySession` | `[bumpAuthEpoch]` |
| `retrySession` | `[applySession, syncStorageFailure]` |

### useEffect（2）

| # | 依赖数组 | 职责 |
| --- | --- | --- |
| 1 | `[applySession, syncStorageFailure, bumpAuthEventSeq]` | 初始化 `getSession()` + `onAuthStateChange` 订阅 + cleanup（`cancelled = true`、`subscription.unsubscribe()`） |
| 2 | `[]` | 自动刷新控制器（`createAutoRefreshController` → `start()` / `dispose()`） |

### useMemo（1）

`value`，依赖数组：
`[user, session, isAuthLoading, authError, retrySession, bumpAuthEpoch, bumpAuthEventSeq, authEpoch, isIdentityTransitioning, signOutError]`

## 身份隔离契约（等价测试逐条覆盖）

1. 冷启动 `getSession()` 返回 A → `user=A`、`ownerId=A`、`authEpoch=0`（首次登记不推进）
2. `SIGNED_IN` 不同 owner（A→B）→ `authEpoch` +1，下游 owner 登记为 B（非 forceBump）
3. `SIGNED_IN` 同 owner 但 token 变化（A→登出→A）→ `authEpoch` +1，下游 forceBump
4. `TOKEN_REFRESHED` → **不**推进 `authEpoch`，**不**触碰下游代际
5. `SIGNED_OUT`（非 signOut 在途）→ `authEpoch` +1，下游登记 null
6. `signOut()` 成功 → `authEpoch` +1、`authEventSeq` +1、下游登记 null、`user/session` 清空
7. `signOut()` 重入 → 第二次立即返回 `AUTH_SIGN_OUT_IN_PROGRESS`，不重复执行
8. `signOut()` SDK 返回 error → 不推进 epoch、不清空 user、写 `authError` + `signOutError`
9. `signOut()` 存储 `UNAVAILABLE` → 视为登出未完成，不推进 epoch、不清空 user
10. `signOut()` 存储 `LEGACY_CLEANUP_FAILED` → 仅 `console.warn`，登出照常完成
11. `signOut()` 抛异常 → 捕获、写 `authError` + `signOutError`、不推进 epoch
12. `signOut` 在途时到达的 `SIGNED_OUT` 事件被忽略（CR-08）
13. 存储故障态下任何认证事件都不清除故障页（C02）
14. 初始化 `getSession()` 迟到结果被更晚认证事件取代 → 整体丢弃（含 catch/finally）
15. `retrySession()` 迟到结果被更晚认证事件取代 → 整体丢弃
16. `retrySession()` 存储故障 → 保留 `authError`，不当作已登出
17. `applySession` 内不得出现 `await`（不阻塞 GoTrue 事件队列）
18. 正常登出不得删除本地持久化数据（无 `AsyncStorage.removeItem/multiRemove/clear`）
19. 自动刷新 Effect 在 `supabase` 为 null 时返回 `undefined`，否则 `start()` + cleanup `dispose()`
20. Provider 渲染结构为 `<AuthContext.Provider value={value}>{children}</AuthContext.Provider>`
