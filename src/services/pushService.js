// --- START OF FILE src/services/pushService.js ---
import { supabase } from './supabase';

/**
 * 发送推送弹窗的万能函数
 * @param {string} receiverId - 接收消息的人的 ID (targetId)
 * @param {string} title - 弹窗的加粗标题
 * @param {string} body - 弹窗的详细内容
 * @param {object} data - 附带的暗号数据（用来点击跳转页面）
 */
export async function sendPushNotification(receiverId, title, body, data = {}) {
  try {
    // 1. 去数据库查对方手机的 Push Token
    const { data: profile } = await supabase
      .from('profiles')
      .select('expo_push_token')
      .eq('id', receiverId)
      .single();

    const pushToken = profile?.expo_push_token;
    
    // 如果对方没登录过或者没给权限，就没有 Token，直接放弃发送
    if (!pushToken) {
      console.log('对方没有 Push Token，无法发送推送');
      return;
    }

    // 2. 组装发给 Expo 官方基站的数据包
    const message = {
      to: pushToken,
      sound: 'default', // 默认提示音
      title: title,
      body: body,
      data: data,
    };

    // 3. 点击发射！(直接调 Expo 接口，免去写后端的麻烦)
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    
    console.log('推送发送成功！');
  } catch (error) {
    console.error('发送推送失败:', error);
  }
}
// --- END OF FILE src/services/pushService.js ---