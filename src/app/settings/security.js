// --- START OF FILE src/app/settings/security.js ---
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import { DEVICE_DATA_PROTECTION_NOTES } from '../../constants/security';
import SettingsPage from '../../components/settings/SettingsPage';

// 🔒 安全审计 #29：账号安全说明
const SECURITY_SECTIONS = [
  {
    title: '登录与会话安全',
    body: '账号使用邮箱 + 密码登录，密码要求至少 8 位且包含字母与数字。登录凭证由 Supabase Auth 托管，本地仅保存加密后的会话令牌。',
  },
  {
    title: '推送通知安全',
    body: '推送令牌仅存储在服务端，客户端无法读取他人令牌。所有推送请求必须携带有效登录凭证，并由服务端校验双方社交关系后才允许发送。',
  },
  {
    title: '数据清除',
    body: '如需清除本机缓存数据，可在「健康与打卡偏好」中重置今日打卡数据；如需彻底删除云端全部数据，请前往「我的 → 注销账号」，该操作需二次确认且不可逆。',
  },
  {
    title: '注销账号',
    body: '注销将永久删除账号、聊天记录、媒体文件、健康数据与好友关系。为防误触，注销流程包含两次确认弹窗，确认后立即执行且无法撤销。',
  },
  // 🔒 安全审计 #26：设备敏感数据保护说明（文案源：src/constants/security.js）
  ...DEVICE_DATA_PROTECTION_NOTES,
];

export default function SecurityScreen() {
  const { colors } = useAppTheme();

  return (
    <SettingsPage title="账号安全">
      <Text style={[styles.intro, { color: colors.textSecondary }]}>
        我们采用业界通行的安全措施保护你的账号与数据。以下说明帮助你了解账号安全机制与数据清除方式。
      </Text>

      {SECURITY_SECTIONS.map((section) => (
        <View
          key={section.title}
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}
        >
          <View style={styles.cardHeader}>
            <View style={[styles.dot, { backgroundColor: '#5E5CE6' }]} />
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
// --- END OF FILE src/app/settings/security.js ---
