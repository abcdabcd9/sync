# P1.2 R3 迁移前基线夹具（before/）

本目录存放 **TASK-P1.2 R3（浏览器脚本层 JS → TS 迁移）** 的迁移前原始 JS 全文，
供 [`tests/security/p12r3MigrationEquivalence.test.mjs`](../../../security/p12r3MigrationEquivalence.test.mjs)
在沙箱中**真实执行**并逐字节比对迁移后 `.ts` 的行为。

## 为什么放在 `tests/fixtures/`

`.internal/` 已被 [`.gitignore`](../../../../.gitignore) 排除，全新 `git clone`
不会包含这些文件。将基线迁入版本可控的 `tests/fixtures/` 后，测试不再依赖
`.internal/`，可在任意克隆中复现（与 R2 的 `tests/fixtures/p12r2/` 做法一致）。

## 来源与真实性

这些文件是 R3 迁移**之前**仓库中真实存在的 `.js` 源码，逐字节复制自：

```
.internal/refactor/tasks/P1/TASK-P1.2/r3/before/
```

该目录在 R3 迁移时由 `cp src/scripts/browser/<name>.js <before>/` 直接复制
原始 `.js` 生成，未做任何改写。迁移后原 `.js` 已删除，因此本目录是这些
实现的**唯一留存副本**。

## 生成说明

- 生成时间：R3 阶段（P1.2 R3 Phase D）
- 生成方式：`cp .internal/refactor/tasks/P1/TASK-P1.2/r3/before/*.js tests/fixtures/p12r3/before/`
- 未从当前 `.ts` 输出反向生成（避免「用迁移后结果伪造等价」）
- 断言未做任何削弱

## SHA-256 校验

```
73bb9f400d803e64dea2b8797395b8e9fcfb1bde7a7e1cd13ba5a2cb73b39802  scripts__browser__adDomWatcher.js
6b68131735f6a7ae6cfe69802c0954924768cb42ed7e371c233db753ad6073d9  scripts__browser__clickHijackGuard.js
14ee9eb8085c2b3f0e633ee39561c4ffc77d5fb977092c4eb00600f38ed9169a  scripts__browser__desktopSpoof.js
278649c5c45f1457c1bd78f48dc3a71befaff9641b013ff151cfd9eabeddeb63  scripts__browser__hiddenSnifferScripts.js
b7e4678b9895f7db94e185ff8c3390f13f084a786630b9498fac8a03345b3d54  scripts__browser__manualSniff.js
1bd58379b1662c7394b088f91dcc334ef737ac8e4493a489c3775d74a023ec28  scripts__browser__passiveSniffer.js
0ef16263b82b148e0245d4f5defa766f8a4f8b6a317454b26534b01c6cd17e76  scripts__browser__removeAdStyle.js
```

## 文件命名约定

文件名中的 `__` 代表路径分隔符 `/`，例如：

- `scripts__browser__adDomWatcher.js` → `src/scripts/browser/adDomWatcher.js`
- `scripts__browser__hiddenSnifferScripts.js` → `src/scripts/browser/hiddenSnifferScripts.js`
