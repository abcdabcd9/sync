// 功能开关：所有「是否显示某功能」的判断必须走这里
// 未来 TS 化：export const FEATURES = {...} as const;
//
// 已实现的功能 = true
// 预留但未实现的功能 = false（代码里可以写，但 UI 不显示）
//
// 关系网络相关开关见 SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md §4

export const FEATURES = {
  // ---- 已实现 ----
  privateSpace: true,   // 私密空间（相册 + 笔记）
  moments: true,        // 朋友圈
  cinemaHD: true,       // 放映厅高清模式
  adFree: true,         // 去广告（浏览器）
  searchHall: true,     // 放映厅搜索大厅

  // ---- 预留：关系网络（v1.1 / v1.2 / v2.0）----
  multiPartner: false,  // 多搭子（slot 0/1/2）
  circles: false,       // 小圈子
  openNetwork: false,   // 开放关系网络
};

/** 判断功能是否开启。未定义的 key 一律视为关闭。 */
export const isFeatureOn = (key) => FEATURES[key] === true;
