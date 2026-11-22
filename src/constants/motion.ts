// --- START OF FILE src/constants/motion.ts ---
// 统一动效参数：所有动画必须从这里取，禁止页面内写魔法数字

/** 时长（毫秒） */
export interface Duration {
  instant: number;
  fast: number;
  normal: number;
  slow: number;
  skeleton: number;
}

/** 弹簧参数 */
export interface SpringConfig {
  damping: number;
  stiffness: number;
  mass: number;
}

/** 弹簧预设集合 */
export interface SpringPresets {
  default: SpringConfig;
  bouncy: SpringConfig;
  gentle: SpringConfig;
  snap: SpringConfig;
}

/** 缓动曲线：固定 4 元组（cubic-bezier 控制点） */
export type EasingCurve = readonly [number, number, number, number];

/** 缓动预设集合 */
export interface EasingPresets {
  standard: EasingCurve;
  decelerate: EasingCurve;
  accelerate: EasingCurve;
}

/** 缩放预设 */
export interface ScalePresets {
  pressIn: number;
  pressOut: number;
  cardEnter: number;
}

/** 交错间隔（毫秒） */
export interface StaggerPresets {
  list: number;
  grid: number;
}

export const DURATION: Duration = {
  instant: 120, // 按压反馈
  fast: 200, // 小元素出现
  normal: 280, // 卡片入场
  slow: 400, // 页面转场
  skeleton: 1200, // 骨架屏微光循环
};

export const SPRING: SpringPresets = {
  // 苹果默认弹簧：轻快、无过冲
  default: { damping: 20, stiffness: 220, mass: 0.9 },
  // 弹性更强：用于 Sheet / 弹窗
  bouncy: { damping: 16, stiffness: 180, mass: 1 },
  // 沉稳：用于大卡片 / 页面级
  gentle: { damping: 24, stiffness: 160, mass: 1 },
  // 吸附：FloatingPlayer 贴边
  snap: { damping: 18, stiffness: 260, mass: 0.8 },
};

export const EASING: EasingPresets = {
  // 苹果标准缓动（近似 cubic-bezier(0.25, 0.1, 0.25, 1)）
  standard: [0.25, 0.1, 0.25, 1],
  // 减速（入场）
  decelerate: [0.0, 0.0, 0.2, 1],
  // 加速（退场）
  accelerate: [0.4, 0.0, 1, 1],
};

export const SCALE: ScalePresets = {
  pressIn: 0.97, // 按压缩放
  pressOut: 1,
  cardEnter: 0.96, // 卡片入场起始缩放
};

export const STAGGER: StaggerPresets = {
  list: 40, // 列表项逐个入场间隔（ms）
  grid: 30, // 网格项间隔
};

// --- END OF FILE src/constants/motion.ts ---
