# P1.2 R4 — 迁移前基线夹具（Supabase / Push Services）

本目录保存 **P1.2 R4 迁移前**的原始 JS 全文，作为行为等价测试
（`tests/security/p12r4MigrationEquivalence.test.mjs`）的**真实执行基线**。

## 来源

| 夹具文件 | 原始路径 | 迁移后路径 |
|---|---|---|
| `services__supabase.js` | `src/services/supabase.js` | `src/services/supabase.ts` |
| `services__pushService.js` | `src/services/pushService.js` | `src/services/pushService.ts` |

## SHA-256（迁移前）

```
ecf2acfb72fbdfea979662db0243bc83eed68efef0ee079d64876a859cf0b348  services__supabase.js
b6a016621dd30d6945c1cba8c0a884b276a0f84af2d797ff36b3cb5a3036fe86  services__pushService.js
```

## 使用约束

1. 本目录**版本可控**，不依赖被 `.gitignore` 排除的 `.internal/`。
2. 基线来自**真实执行迁移前 JS**，不是从迁移后 TS 反向生成。
3. 测试在独立沙箱中复制本夹具 + stub 原生依赖后执行，逐字段比对
   迁移前 JS 与迁移后 TS 的输出。
4. 不得删除、弱化或跳过既有安全测试；本夹具仅服务于 R4 等价验证。
