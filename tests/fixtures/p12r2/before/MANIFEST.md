# P1.2 R2 迁移前基线夹具（before/）

本目录存放 **TASK-P1.2 R2（第三批 JS → TS 迁移）** 的迁移前原始 JS 全文，
供 [`tests/security/p12r2MigrationEquivalence.test.mjs`](../../../security/p12r2MigrationEquivalence.test.mjs)
在沙箱中**真实执行**并逐字节比对迁移后 `.ts` 的行为。

## 为什么放在 `tests/fixtures/` 而不是 `.internal/`

`.internal/` 已被 [`.gitignore`](../../../../.gitignore) 排除，全新 `git clone`
不会包含这些文件，导致等价测试在干净环境中无法运行。将基线迁入版本可控的
`tests/fixtures/` 后，测试不再依赖 `.internal/`，可在任意克隆中复现。

## 来源与真实性

这些文件是 R2 迁移**之前**仓库中真实存在的 `.js` 源码，逐字节复制自：

```
.internal/refactor/tasks/P1/TASK-P1.2/r2/before/
```

该目录在 R2 迁移时由 `cp src/... <before>/` 直接复制原始 `.js` 生成，
未做任何改写。迁移后原 `.js` 已删除，因此本目录是这些实现的**唯一留存副本**。

## 生成说明

- 生成时间：R3 阶段（P1.2 R3 Phase C）
- 生成方式：`cp .internal/refactor/tasks/P1/TASK-P1.2/r2/before/*.js tests/fixtures/p12r2/before/`
- 未从当前 `.ts` 输出反向生成（避免「用迁移后结果伪造等价」）
- 断言未做任何削弱

## SHA-256 校验

```
9a6af7443abc6a617ddeae9e5b55c087c4251931bf0f44c1f6a3523e909a7bbb  constants__haptics.js
680c07cfc7386a2ed075ebf5efb75fd997a442759d5c930c3641591b5180487b  hooks__health__authRevokeLogic.js
8593aed861687ae907c0c59abf906d05605347276ff20cd4ea80f48f0e7ccc03  hooks__health__constants.js
dbc85926d7440e635ca22810dd48bb386829a89af0b8a9c22a102cf6381b7e1d  hooks__health__dateUtils.js
823fc6eab6aa44359175622d331213bf996dbd35191f1202221269898fb8c6a1  scripts__browser__adCleanup.js
d2167e2d2d24d138826034f56cdd998a2a2798ba7dc391df9e88fae8322c2ca4  scripts__browser__adGuard.js
942a42e8a56046b6cb644f35c2f52c69724875cba81c45b47028f0a270822309  scripts__browser__index.js
```

## 文件命名约定

文件名中的 `__` 代表路径分隔符 `/`，例如：

- `constants__haptics.js` → `src/constants/haptics.js`
- `hooks__health__dateUtils.js` → `src/hooks/health/dateUtils.js`
- `scripts__browser__index.js` → `src/scripts/browser/index.js`
