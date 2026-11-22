/**
 * 推送 / 通知契约（TASK-P1.1 R0 — Phase B5 校正）
 *
 * 依据（逐字段核对，非猜测）：
 *   - `src/services/pushService.js` 第 27–35 行 `PUSH_ERROR_CATEGORY`
 *   - `src/services/pushService.js` 第 110–151 行 `sendPushNotification` 全部分支
 *   - `src/hooks/usePushNotifications.js` 第 27–101 行（**返回 void**）
 *   - `supabase/functions/send-push/index.ts` 第 95–292 行（云函数响应）
 *
 * ⚠️ 关键校正（相对上一版）：
 *   1. 错误类别真实取值是**小写**：`auth` / `forbidden` / `target_missing` /
 *      `bad_request` / `server_config` / `upstream`，另加 `http_error` / `network`。
 *      上一版写成 `PUSH_AUTH` 等大写是错误的。
 *   2. `usePushNotifications()` **返回 void**，没有 `PushNotificationsState`
 *      对象（无 permissionStatus / expoPushToken / register）。上一版虚构了该对象。
 *   3. `PushSendResult` 的成功分支**没有** `status`；失败分支 `status` / `category`
 *      均可选（见 `result.ts`）。
 */

import type { PushSendResult } from './result';

// 注意：`PushSendResult` 由 `result.ts` 定义，`index.ts` 已通过
// `export * from './result'` 导出。此处**不再重复 re-export**，
// 避免 `index.ts` 出现 "Multiple exports of name 'PushSendResult'"。
export type { PushSendResult as PushResult };

/**
 * 推送错误分类（与 `pushService.js#PUSH_ERROR_CATEGORY` 一致）。
 *
 * 真实取值（小写）：
 *   - `auth`：401 JWT 缺失/过期/无效
 *   - `forbidden`：403 无社交关系 / 发送者资料缺失
 *   - `target_missing`：404 目标用户资料缺失
 *   - `bad_request`：400 / 405 参数非法
 *   - `server_config`：500 云函数环境变量缺失 / 内部错误
 *   - `upstream`：502 Expo Push 服务调用失败
 *   - `http_error`：其它未映射的 HTTP 状态
 *   - `network`：无 HTTP 状态（纯网络错误）
 */
export type PushErrorCategory =
  | 'auth'
  | 'forbidden'
  | 'target_missing'
  | 'bad_request'
  | 'server_config'
  | 'upstream'
  | 'http_error'
  | 'network';

/** 推送通知数据载荷（透传给接收端） */
export interface PushDataPayload {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * 推送发送函数签名（对应 `sendPushNotification`）。
 *
 * 参数：
 *   - receiverId：接收者用户 id
 *   - title / body：通知标题与正文
 *   - data：可选附加数据
 */
export type SendPushNotification = (
  receiverId: string,
  title: string,
  body: string,
  data?: PushDataPayload,
) => Promise<PushSendResult>;

/**
 * 通知权限状态（客户端展示用）。
 *
 * 注意：这是 Expo Notifications 的权限状态字符串，**不是** `usePushNotifications`
 * 的返回值 —— 该 hook 返回 void，不暴露权限状态。
 */
export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * `usePushNotifications()` 的返回。
 *
 * 真实来源：`src/hooks/usePushNotifications.js` 第 27–101 行 —— 该 hook
 * 只做副作用（注册 token、监听通知、点击跳转），**不返回任何值**（void）。
 *
 * 因此这里不声明 `PushNotificationsState` 对象，避免虚构不存在的契约。
 */
export type UsePushNotificationsResult = void;
