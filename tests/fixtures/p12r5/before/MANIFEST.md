# P1.2 R5 — 迁移前基线（冻结）

本目录保存 **P1.2 R5 迁移前** 的两个认证 Service 原始 JS 全文，作为行为等价测试的
唯一基线。等价测试（`tests/security/p12r5MigrationEquivalence.test.mjs`）只读取本目录，
**绝不**读取 `src/services/*.ts` 作为「旧实现」。

## 文件清单

| 文件 | 对应源码路径 | 行数 | SHA-256 |
| --- | --- | --- | --- |
| `services__authStorage.js` | `src/services/authStorage.js` | 399 | `afba7ce61ae634abe549e36ba66dd4ea1503cd3c3d44c73a62bc9b8fbfa9feca` |
| `services__authAutoRefresh.js` | `src/services/authAutoRefresh.js` | 310 | `963176dbf67bf63b35798d199f5180a96814f34653ce2750ec71942225039c05` |

## 冻结规则

1. 本目录内容**不得修改**。任何「为了让测试通过」而改动基线的行为都视为伪造验证。
2. 若确需修正基线，必须在 TASK.md 中记录原因、旧 SHA-256、新 SHA-256，并重新评审。
3. 迁移后 `src/services/authStorage.js` / `authAutoRefresh.js` 被删除（避免 JS/TS 双实现），
   因此本目录是这两个模块旧实现的**唯一**可执行副本。

## 校验命令

```bash
shasum -a 256 tests/fixtures/p12r5/before/*.js
```

期望输出与上表一致。
