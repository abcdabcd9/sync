// --- START OF FILE src/services/pushService.js ---
import { supabase } from './supabase';

/**
 * 发送推送弹窗。
 *
 * 🔒 安全说明：
 *   客户端不再直接调用 Expo Push API，也不再查询他人的 expo_push_token。
 *   所有敏感操作（JWT 校验、权限校验、Token 查询、调用 Expo）都在
 *   Supabase Edge Function `send-push` 内部完成。
 *
 * @param {string} receiverId - 接收消息的人的 ID (targetId)
 * @param {string} title - 弹窗的加粗标题
 * @param {string} body - 弹窗的详细内容
 * @param {object} data - 附带的暗号数据（用来点击跳转页面）
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
 */
export async function sendPushNotification(receiverId, title, body, data = {}) {
  if (!receiverId) {
    return { ok: false, reason: 'missing receiverId' };
  }

  try {
    const { data: result, error } = await supabase.functions.invoke('send-push', {
      body: {
        targetUserId: receiverId,
        title,
        body,
        data,
      },
    });

    if (error) {
      console.warn('⚠️ 推送云函数调用失败:', error.message);
      return { ok: false, reason: error.message };
    }

    if (result?.ok === false) {
      console.warn('⚠️ 推送未送达:', result.error ?? result.reason);
      return { ok: false, reason: result.error ?? result.reason };
    }

    return result ?? { ok: true };
  } catch (error) {
    console.warn('⚠️ 发送推送异常:', error?.message ?? error);
    return { ok: false, reason: error?.message ?? String(error) };
  }
}
// --- END OF FILE src/services/pushService.js ---
