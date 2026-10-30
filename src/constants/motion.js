// 统一动效参数：所有动画必须从这里取，禁止页面内写魔法数字
// 未来 TS 化：export const SPRING = {...} as const;

export const DURATION = {
  instant: 120,   // 按压反馈
  fast: 200,      // 小元素出现
  normal: 280,    // 卡片入场
  slow: 400,      // 页面转场
  skeleton: 1200, // 骨架屏微光循环
};

export const SPRING = {
  // 苹果默认弹簧：轻快、无过冲
  default: { damping: 20, stiffness: 220, mass: 0.9 },
  // 弹性更强：用于 Sheet / 弹窗
  bouncy: { damping: 16, stiffness: 180, mass: 1 },
  // 沉稳：用于大卡片 / 页面级
  gentle: { damping: 24, stiffness: 160, mass: 1 },
  // 吸附：FloatingPlayer 贴边
  snap: { damping: 18, stiffness: 260, mass: 0.8 },
};

export const EASING = {
  // 苹果标准缓动（近似 cubic-bezier(0.25, 0.1, 0.25, 1)）
  standard: [0.25, 0.1, 0.25, 1],
  // 减速（入场）
  decelerate: [0.0, 0.0, 0.2, 1],
  // 加速（退场）
  accelerate: [0.4, 0.0, 1, 1],
};

export const SCALE = {
  pressIn: 0.97,   // 按压缩放
  pressOut: 1,
  cardEnter: 0.96, // 卡片入场起始缩放
};

export const STAGGER = {
  list: 40,   // 列表项逐个入场间隔（ms）
  grid: 30,   // 网格项间隔
};
