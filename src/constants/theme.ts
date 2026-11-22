// --- START OF FILE src/constants/theme.ts ---

/**
 * 📐 全局尺寸与排版规范
 *
 * 键名与取值必须与旧版 theme.js 完全一致，禁止在页面内写死尺寸/字号。
 */

/** 全局尺寸常量 */
export interface Sizes {
  radiusCard: number;
  radiusList: number;
  padding: number;
}

/** 单条排版样式 */
export interface TypographyStyle {
  fontSize: number;
  fontWeight: '400' | '500' | '600' | '700' | '800' | '900' | 'normal' | 'bold';
  letterSpacing: number;
}

/** 全局排版规范 */
export interface Typography {
  largeTitle: TypographyStyle;
}

export const SIZES: Sizes = {
  radiusCard: 24, // 放大卡片圆角，更柔和的现代 iOS 风格
  radiusList: 16, // 列表组的标准内缩圆角
  padding: 20, // 扩大左右安全边距，增加呼吸感
};

// 🍎 全局统一的文字排版规范 (Design System)
export const TYPOGRAPHY: Typography = {
  largeTitle: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
};

// --- END OF FILE src/constants/theme.ts ---
