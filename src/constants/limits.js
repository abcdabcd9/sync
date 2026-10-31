// 配额常量：本次固定值，未来按会员等级动态取值
// 未来 TS 化：export const LIMITS = {...} as const;
//
// 关系网络相关配额见 docs/specs/SYNC_APP_RELATION_NETWORK_INTERFACE_RESERVATION.md §4

export const LIMITS = {
  // ---- 私密空间 ----
  privateAlbumMax: 500,      // 私密相册最多张数
  privateNotesMax: 200,      // 私密笔记最多条数

  // ---- 朋友圈 ----
  momentsDailyMax: 10,       // 每日发布朋友圈上限
  momentImagesMax: 9,        // 单条朋友圈最多图

  // ---- 放映厅 ----
  cinemaRoomTitleMax: 30,    // 放映厅房间标题字数
  danmakuMaxLength: 50,      // 弹幕字数

  // ---- 关系网络（预留）----
  partnerMax: 1,             // 当前阶段：1 个搭子（v1.1 改为 3）
  circleMemberMax: 1,        // 当前阶段：不开放圈子（v1.2 改为 20）
  circleNameMax: 20,         // 圈子名称字数
};
