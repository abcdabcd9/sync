import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// 触感反馈统一出口：所有页面只调这里，不直接 import expo-haptics
// Android 上 expo-haptics 为 no-op，属预期行为，不加判断分支

const isIOS = Platform.OS === 'ios';

export const haptic = {
  /** 轻触：切换 tab、选中、开关 */
  light: () => {
    if (isIOS) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  },
  /** 中触：按钮点击、卡片进入详情 */
  medium: () => {
    if (isIOS) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  },
  /** 重触：删除、危险操作确认前 */
  heavy: () => {
    if (isIOS) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  },
  /** 成功：打卡完成、发送成功、保存成功 */
  success: () => {
    if (isIOS) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  },
  /** 警告：配额不足、需二次确认 */
  warning: () => {
    if (isIOS) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  },
  /** 错误：操作失败 */
  error: () => {
    if (isIOS) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  },
  /** 选择变化：滚轮、分段控件切换 */
  selection: () => {
    if (isIOS) Haptics.selectionAsync();
  },
};
