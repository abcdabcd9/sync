// --- START OF FILE src/app/settings/privacy-policy.js ---
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import SettingsPage from '../../components/settings/SettingsPage';

// 🔒 安全审计 #29：隐私政策与数据使用说明（健康数据 + 聊天信息的合规使用）
const PRIVACY_SECTIONS = [
  {
    title: '我们收集哪些数据',
    body: '· 账号信息：邮箱、昵称、Sync ID\n· 健康数据：饮水目标、三餐打卡记录、连续打卡天数\n· 聊天数据：文字、语音、图片、视频消息及发送时间\n· 设备信息：推送令牌（仅用于消息通知）',
  },
  {
    title: '健康数据如何使用',
    body: '健康与打卡数据仅用于为你生成每日进度、连续打卡统计，并在你绑定「健康搭子」后与对方同步打卡状态。我们不会将健康数据用于广告投放，也不会出售给任何第三方。',
  },
  {
    title: '聊天信息如何使用',
    body: '聊天消息通过 TLS 加密传输，安全存储于 Supabase 云端数据库，仅你与对话双方在应用内可见。消息内容不会用于训练模型或人工审阅，除非依据法律法规要求配合调查。',
  },
  {
    title: '数据存储与保留',
    body: '数据存储于 Supabase 云端数据库。你随时可以在「账号安全」中注销账号，注销后所有聊天记录、图片、健康数据及好友关系将被永久删除且不可恢复。',
  },
  {
    title: '你的权利',
    body: '你有权访问、更正、导出及删除自己的全部数据。如需行使上述权利，可通过「个人资料」页面修改信息，或直接注销账号完成彻底删除。',
  },
];

export default function PrivacyPolicyScreen() {
  const { colors } = useAppTheme();

  return (
    <SettingsPage title="隐私政策与数据使用说明">
      <Text style={[styles.intro, { color: colors.textSecondary }]}>
        我们深知个人信息对你的重要性，并会尽全力保护你的个人信息安全。本说明将帮助你了解我们如何收集、使用、存储与保护你的信息。
      </Text>

      {PRIVACY_SECTIONS.map((section) => (
        <View
          key={section.title}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
        >
          <View style={styles.cardHeader}>
            <View style={[styles.dot, { backgroundColor: '#34C759' }]} />
            <Text style={[styles.cardTitle, { color: colors.textPrimary }]}>{section.title}</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.textSecondary }]}>{section.body}</Text>
        </View>
      ))}

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        最后更新：2026 年 10 月{'\n'}如对本说明有任何疑问，可通过「个人资料」页面联系我们。
      </Text>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 13, lineHeight: 20, marginBottom: 16, paddingHorizontal: 4 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 8 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardBody: { fontSize: 13, lineHeight: 21 },
  footer: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 8, marginBottom: 40, paddingHorizontal: 8 },
});
// --- END OF FILE src/app/settings/privacy-policy.js ---
