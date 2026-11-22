# P1.2 R6 — mediaCache.js 迁移前冻结基线

本目录保存 `src/services/mediaCache.js` 在 TypeScript 迁移**之前**的完整原文，
用于行为等价测试（`tests/security/p12r6MigrationEquivalence.test.mjs`）在隔离沙箱中
执行旧 JS 实现，并与迁移后的 `src/services/mediaCache.ts` 逐项比较可观测行为。

## 文件

| 文件 | 原始路径 | SHA-256 |
|------|----------|---------|
| `services__mediaCache.js` | `src/services/mediaCache.js` | `688875fc641bd6b6dfb4f946b296daa3b798f63394de70565267d6b0e62d48cd` |

## 约束

- 本目录为**只读冻结基线**，不得修改以制造测试通过。
- 测试启动时先校验 SHA-256，防止基线被篡改。
- 迁移后 `src/services/mediaCache.js` 将被删除（避免 JS/TS 双实现），
  本目录是唯一保留的旧实现副本。

## 迁移前公开导出（供对照）

- `setMediaCacheOwner(ownerId, forceBump = false)`
- `getMediaCacheIdentity()`
- `isLocalUri(uri)`
- `normalizeFileUri(path)`
- `persistMedia(uri, msgId, kind)`
- `resolveLocalMedia(msgId, kind)`
- `getMemoryLocalMedia(msgId, kind)`
- `downloadToSandbox(remoteUrl, msgId, kind)`
- `getMediaCacheSize()`
- `clearMediaCache()`
- `default`（聚合对象，含以上除 `isLocalUri` 外的全部成员 + `isLocalUri`）
