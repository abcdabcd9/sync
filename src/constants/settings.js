// --- START OF FILE src/constants/settings.js ---

/**
 * ⚙️ 设置页选项常量
 *
 * 所有「多选一」的选项集中在此，页面只负责渲染与回写。
 * key 必须与 useAppSettings 的 DEFAULT_SETTINGS 字段取值保持一致。
 */

// 朋友圈可见范围（对应 settings.momentsVisibility）
export const MOMENTS_VISIBILITY = [
  { key: 'all', label: '所有人', desc: '任何 Sync 用户都能看到你的朋友圈' },
  { key: 'friends', label: '仅好友', desc: '只有互为好友的人可以看到' },
  { key: 'self', label: '仅自己', desc: '朋友圈只有你自己可见' },
];

// 聊天背景（对应 settings.chatBackground）
export const CHAT_BACKGROUNDS = [
  { key: 'default', label: '跟随主题', desc: '随外观模式自动切换深浅' },
  { key: 'light', label: '浅色', desc: '始终使用浅色聊天背景' },
  { key: 'dark', label: '深色', desc: '始终使用深色聊天背景' },
];

// 界面语言（对应 settings.language）
export const LANGUAGES = [
  { key: 'zh', label: '简体中文', desc: '默认语言' },
  { key: 'en', label: 'English', desc: 'English (US)' },
];

// 按 key 取 label，找不到时返回 fallback
export function labelOf(options, key, fallback = '') {
  return options.find((o) => o.key === key)?.label ?? fallback;
}
// --- END OF FILE src/constants/settings.js ---
