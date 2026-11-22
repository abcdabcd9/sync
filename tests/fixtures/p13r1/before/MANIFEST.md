# P1.3 R1 — 广告拦截决策解耦 冻结基线

本目录保存 P1.3 R1 解耦**前**的真实源码快照，供等价测试逐项比对。
基线只读，不得修改以制造通过（测试启动时校验 SHA-256）。

## 文件

| 文件 | 来源 | SHA-256 |
|------|------|---------|
| `hooks__browser__useAdBlocker.js` | `src/hooks/browser/useAdBlocker.js`（解耦前） | `755e5e4227f55ce8584bb78c170804bbe21d60971a4d3c0ebd564c5c191f06a6` |

## 说明

- 该文件是解耦前 `useAdBlocker` Hook 的完整源码（108 行）。
- 解耦后 `src/hooks/browser/useAdBlocker.js` 将把「WebView 请求是否允许加载」这一
  纯决策委托给 `src/hooks/browser/adBlockDecision.ts`，其余（React 生命周期、
  200ms 计数节流、DOM 清理注入、开关切换、卸载清理）保持不变。
- 等价测试 `tests/security/p13r1DecouplingEquivalence.test.mjs` 会在隔离沙箱中
  分别加载本基线与解耦后源码，对同一组输入比较完整可观测结果。
