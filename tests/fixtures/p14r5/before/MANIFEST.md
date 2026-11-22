# P1.4 R5 — Realtime + Signed Media 迁移前冻结基线

冻结时间：2026-11-22（取自**当前工作区最新源码**，非历史 HEAD）
冻结方式：`cp` 原文件 → 逐字节一致，SHA-256 双向校验通过。

## 冻结文件

| 冻结文件 | 来源 | 字节数 | SHA-256 |
| --- | --- | --- | --- |
| `hooks__useSyncRoom.js` | `src/hooks/useSyncRoom.js` | 8215 | `9fac51789d4927e8f99ccbc3d89ab8f1cac1578d4872fc91b2fd888463b782f0` |
| `hooks__chat__useSignedMediaUrl.js` | `src/hooks/chat/useSignedMediaUrl.js` | 19072 | `ac5b88e298aa35a688288fce51c786037f300ed3ec69fdca595c69ac70ccd164` |

## 校验方式

```bash
shasum -a 256 tests/fixtures/p14r5/before/hooks__useSyncRoom.js
# 期望：9fac51789d4927e8f99ccbc3d89ab8f1cac1578d4872fc91b2fd888463b782f0

shasum -a 256 tests/fixtures/p14r5/before/hooks__chat__useSignedMediaUrl.js
# 期望：ac5b88e298aa35a688288fce51c786037f300ed3ec69fdca595c69ac70ccd164
```

等价测试启动时校验上述 SHA-256，基线被篡改即失败。

## 迁移目标

| 冻结基线 | 迁移后 |
| --- | --- |
| `hooks__useSyncRoom.js` | `src/hooks/useSyncRoom.ts` |
| `hooks__chat__useSignedMediaUrl.js` | `src/hooks/chat/useSignedMediaUrl.ts` |

两个目标均**无 JSX**，故使用 `.ts` 而非 `.tsx`。

---

# 一、`useSyncRoom` 接口契约（必须逐项保持）

## 公开签名

```ts
useSyncRoom(roomId: string): {
  partnerStatus: string;
  remoteCommand: SyncCommandPayload | null;
  emitCommand: (type: PlaybackCommandType, time?: number, url?: string | null) => void;
  danmakuList: DanmakuPayload[];
  emitDanmaku: (text: string, color?: string) => void;
  ownerKey: string;
}
```

## State（5）

| 名称 | 初始值 |
| --- | --- |
| `partnerStatus` | `'等待建立连接...'` |
| `remoteCommand` | `null` |
| `danmakuList` | `[]` |
| `deviceId` | `null` |
| `dataOwnerKey` | `useState(ownerKey)`（首帧 ownerKey） |

## Ref（2）

| 名称 | 初始值 |
| --- | --- |
| `channelRef` | `null` |
| `prevOwnerKeyRef` | `ownerKey` |

## Effect（3）

| # | 依赖 | 行为 |
| --- | --- | --- |
| E1 | `[ownerKey]` | ownerKey 真实变化 → 清空 remoteCommand / danmakuList / partnerStatus，并 `setDataOwnerKey(ownerKey)` |
| E2 | `[ownerKey, isOwnerKeyCurrent]` | 异步取 deviceId，`isOwnerKeyCurrent(snapshot)` 守卫后写入 |
| E3 | `[roomId, deviceId, ownerKey, isOwnerKeyCurrent]` | `!roomId \|\| !deviceId` 提前返回；建 channel；注册 3 个 on + subscribe；cleanup removeChannel |

## 订阅顺序（不可变）

1. `broadcast` / `sync_command` → 守卫 → `senderId !== deviceId` → `setRemoteCommand`
2. `broadcast` / `danmaku` → 守卫 → `senderId !== deviceId` → 追加并 `slice(-100)`
3. `presence` / `sync` → 守卫 → `presenceState()` 键数 > 1 ? `'对方已加入房间'` : `'等待对方加入...'`
4. `subscribe(cb)` → 守卫 → `SUBSCRIBED` → `track({status:'watching'})` + `setRemoteCommand(null)`

## 业务不变量（等价测试逐条覆盖）

- **INV-S1** 初始 `partnerStatus === '等待建立连接...'`，`remoteCommand === null`，`danmakuList === []`，`ownerKey === 首帧 ownerKey`。
- **INV-S2** `deviceId` 未就绪时不建 channel（`supabase.channel` 调用次数为 0）。
- **INV-S3** channel 创建参数严格为 `{ config: { broadcast: { ack: false }, presence: { key: deviceId } } }`。
- **INV-S4** 收到 `sync_command` 且 `senderId !== deviceId` → `remoteCommand` 更新为该 payload。
- **INV-S5** 收到 `sync_command` 且 `senderId === deviceId` → 不更新（自收自发过滤）。
- **INV-S6** 收到 `danmaku` 且 `senderId !== deviceId` → 追加到 `danmakuList`，长度上限 100（超出丢最旧）。
- **INV-S7** presence 在线数 > 1 → `'对方已加入房间'`；<= 1 → `'等待对方加入...'`。
- **INV-S8** `SUBSCRIBED` → 调用 `channel.track({ status: 'watching' })` 且清空 `remoteCommand`。
- **INV-S9** `emitCommand(type, time=0, url=null)` → `channel.send({ type:'broadcast', event:'sync_command', payload:{ senderId: deviceId, type, time, url } })`；`channelRef` 或 `deviceId` 缺失时不发送。
- **INV-S10** `emitDanmaku(text, color='#FFFFFF')` → 构造 `{ senderId, id: Date.now().toString(), text, color, timestamp: Date.now() }`（**两次独立 Date.now()**），发送并本地追加（上限 100）。
- **INV-S11** ownerKey 变化 → E1 清空三个 state + 更新 dataOwnerKey；E3 拆除旧 channel 并建新 channel。
- **INV-S12** 旧 channel 迟到事件（ownerKey 已变）→ 被 `isOwnerKeyCurrent` 丢弃，不写 state。
- **INV-S13** 卸载 → `supabase.removeChannel(channel)` 被调用，`channelRef.current === null`。
- **INV-S14** 返回对象每次渲染**新建**；`emitCommand` / `emitDanmaku` **每次渲染引用都变化**（非 useCallback）。
- **INV-S15** `getOrCreateDeviceId` 抛错 → `console.warn` + 返回临时 UUID，不抛异常。

---

# 二、`useSignedMediaUrl` 接口契约（必须逐项保持）

## 公开导出（9 + default）

| 导出 | 签名 |
| --- | --- |
| `SIGNED_URL_TTL` | `number`（604800） |
| `setSignedUrlOwner` | `(ownerId: string \| null, forceBump?: boolean) => number` |
| `getSignedUrlIdentity` | `() => { ownerId: string \| null; epoch: number }` |
| `toStoragePath` | `(value: unknown) => string \| null` |
| `buildPublicStorageUrl` | `(value: unknown) => string \| null` |
| `getSignedUrl` | `(path: string, ttlSeconds?: number) => Promise<string \| null>` |
| `clearSignedUrlCache` | `() => void` |
| `getMemoryCachedSignedUrl` | `(path: string \| null \| undefined) => string \| null` |
| `useSignedMediaUrl` | `(value: string \| null \| undefined, ttlSeconds?: number) => { url: string \| null; loading: boolean }` |
| `default` | `useSignedMediaUrl` |

## 模块级状态（单例语义）

`currentOwnerId`、`currentEpoch`、`identitySubscribers`、`cache`（Map，上限 500）、`inflight`（Map）。

## 业务不变量（等价测试逐条覆盖）

- **INV-M1** 无缓存 + 有 owner → `getSignedUrl` 调用 `createSignedUrl(objectPath, ttl)`，返回 `signedUrl`，并写入缓存。
- **INV-M2** 缓存命中（未过期）→ 直接返回缓存 URL，**不**调用 `createSignedUrl`。
- **INV-M3** 缓存键严格为 `` `${ownerId ?? 'anon'}::${objectPath}` ``。
- **INV-M4** TTL：`expiresAt = Date.now() + Math.max(0, ttl*1000 - REFRESH_AHEAD_MS)`；`expiresAt <= Date.now()` 视为过期并删除。
- **INV-M5** 并发同 key → 只发一次请求，后续调用返回**同一 Promise**（inflight 去重）。
- **INV-M6** `setSignedUrlOwner` 变化或 `forceBump` → `currentEpoch += 1`、`cache.clear()`、`inflight.clear()`、通知全部订阅者；返回新 epoch。
- **INV-M7** 请求失败 → `console.warn` → 代际仍有效则返回旧缓存（可能 null），**不抛**。
- **INV-M8** A→B→A：B 阶段不命中 A 的缓存（键含 ownerId）；回到 A 后旧缓存已被 `setSignedUrlOwner` 清空。
- **INV-M9** 同账号新代际（`forceBump`）→ 旧缓存清空，旧 Promise 结果被代际闸门丢弃。
- **INV-M10** 迟到旧 Promise（发起后身份已变）→ `isIdentityStillValid` 为 false → 返回 null，**不写缓存**。
- **INV-M11** 无 owner（`startOwnerId` 为 null）→ `getSignedUrl` 直接返回 null（fail-closed），不发请求、不读 anon 缓存。
- **INV-M12** 卸载 → Effect cleanup 置 `cancelled = true`；订阅者从 `identitySubscribers` 移除。
- **INV-M13** `useSignedMediaUrl` 的 `state` 与 `{ownerId, epoch}` 绑定；身份变化后旧 state 失效，回落到当前 owner 缓存。
- **INV-M14** `isAbsolute || isLocal` → 直接返回 `{ url: value.trim(), loading: false }`，不发起签名。
- **INV-M15** 离线降级：**绝不** `setState(null)` 清空已有图片。
- **INV-M16** `toStoragePath` 短路顺序：非 string → null；空 → null；本地 URI → null；非 http → 原样；`/chat_media/` 捕获 → decode；否则 null。
- **INV-M17** `buildPublicStorageUrl`：完整 URL / 本地 URI → null；无 `EXPO_PUBLIC_SUPABASE_URL` → null；否则拼 `/storage/v1/object/public/chat_media/<encoded>`。
- **INV-M18** `getMemoryCachedSignedUrl`：非 string → null；完整 URL → 原样；`ph:`/`assets-library:`/`blob:` → null；相对路径 → 按当前 owner 查缓存。
- **INV-M19** `inflight` 清理只删除属于本 Promise 的条目（`inflight.get(key) === task`）。
