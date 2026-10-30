// --- START OF FILE src/hooks/health/dateUtils.js ---

/**
 * 将 Date 对象格式化为本地时区的 YYYY-MM-DD 字符串。
 * 注意：使用本地时间方法，避免东八区等时区在凌晨出现日期判定错位。
 */
export const formatDateStr = (d) => {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 计算两个 YYYY-MM-DD 日期字符串之间相差的天数（绝对值）。
 */
export const calculateDiffDays = (date1, date2) => {
  const d1 = new Date(`${date1}T00:00:00Z`);
  const d2 = new Date(`${date2}T00:00:00Z`);
  return Math.round(Math.abs(d1 - d2) / 86400000);
};

// --- END OF FILE src/hooks/health/dateUtils.js ---
