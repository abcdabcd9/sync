// --- START OF FILE src/hooks/health/dateUtils.js ---

/**
 * 将 Date 对象格式化为 UTC 的 YYYY-MM-DD 字符串。
 * 注意：使用 getUTC* 系列方法，与设备本地时区无关。
 */
export const formatDateStr = (d) => {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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
