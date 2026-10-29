// --- START OF FILE src/hooks/health/dateUtils.js ---

// 🍎 修复核心：全局绝对时空偏移量
// 由服务器时间校准得出（serverTime - Date.now()），用于抵消设备时钟被篡改或时区漂移。
let globalTimeOffset = 0;

/**
 * 更新全局时空偏移量。
 * 调用方：loadAllData 中通过 supabase.rpc('get_server_time') 校准后写入。
 */
export const setGlobalTimeOffset = (offset) => {
  globalTimeOffset = offset;
};

/**
 * 将 Date 对象格式化为 UTC 的 YYYY-MM-DD 字符串。
 * 注意：使用 getUTC* 系列方法，与设备本地时区无关。
 */
export const formatDateStr = (d) => {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/**
 * 获取"今天"的日期字符串（YYYY-MM-DD）。
 * 🍎 不再相信设备时间！本地时间 + 服务器偏移量 = 绝对真理 UTC 时间
 */
export const getTodayDateStr = () => {
  const d = new Date(Date.now() + globalTimeOffset);
  return formatDateStr(d);
};

/**
 * 获取"昨天"的日期字符串（YYYY-MM-DD）。
 * 同样基于服务器校准后的绝对时间，用于撤销打卡时回退 lastCheckInDate。
 */
export const getYesterdayDateStr = () => {
  const yesterday = new Date(Date.now() + globalTimeOffset);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return formatDateStr(yesterday);
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
