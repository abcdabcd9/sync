export const SYSTEM_COLORS = {
  light: {
    background: '#F2F2F7', 
    // 注入微透效果，替代原本死板的纯白
    card: 'rgba(255, 255, 255, 0.75)',
    // 增加 1px 高光描边色，营造悬浮玉石感
    cardBorder: 'rgba(255, 255, 255, 0.95)',
    textPrimary: '#000000',
    textSecondary: 'rgba(60, 60, 67, 0.6)',
    primary: '#FF2D55', 
    success: '#FF2D55', 
    separator: 'rgba(60, 60, 67, 0.1)',
    dockShadow: '#000000',
    dockBorder: 'rgba(255,255,255,0.7)',
    dockBackground: 'rgba(255,255,255,0.85)',
    iconBackground: '#8E8E93',
    chatBorder: 'rgba(0,0,0,0.05)',
    // 新增：打卡圈圈的语义色
    checkRing: 'rgba(60, 60, 67, 0.25)', // 未打卡的极细空心圈
    checkBg: 'rgba(255, 45, 85, 0.85)',  // 已打卡的微透粉色
  },
  dark: {
    background: '#000000',
    card: 'rgba(28, 28, 30, 0.65)',
    cardBorder: 'rgba(255, 255, 255, 0.12)', // 暗黑模式下的微妙高光
    textPrimary: '#FFFFFF',
    textSecondary: 'rgba(235, 235, 245, 0.6)',
    primary: '#FF375F', 
    success: '#FF375F', 
    separator: 'rgba(84, 84, 88, 0.3)',
    dockShadow: '#000000',
    dockBorder: 'rgba(255,255,255,0.15)',
    dockBackground: 'rgba(28,28,30,0.85)',
    iconBackground: '#8E8E93', 
    chatBorder: 'rgba(255,255,255,0.1)',
    checkRing: 'rgba(235, 235, 245, 0.25)',
    checkBg: 'rgba(255, 55, 95, 0.85)',
  }
};

export function getPalette(isDark) {
  return isDark ? SYSTEM_COLORS.dark : SYSTEM_COLORS.light;
}