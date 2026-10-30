// --- START OF FILE src/app/settings/notifications.js ---
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import { useAppSettings } from '../../hooks/useAppSettings';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';
import SwitchRow from '../../components/settings/SwitchRow';

export default function NotificationSettingsScreen() {
  const { colors } = useAppTheme();
  const { settings, updateSetting } = useAppSettings();

  // 系统级通知权限（granted / denied / undetermined）
  const [permission, setPermission] = useState('undetermined');

  const refreshPermission = useCallback(async () => {
    try {
      const res = await Notifications.getPermissionsAsync();
      setPermission(res.status);
    } catch (e) {
      console.warn('⚠️ 读取通知权限失败:', e?.message ?? e);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshPermission();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPermission]);

  const handleRequestPermission = async () => {
    haptic.light();
    try {
      const res = await Notifications.requestPermissionsAsync();
      setPermission(res.status);
      if (res.status === 'granted') {
        haptic.success();
        Alert.alert('已开启', '系统通知权限已开启。');
      } else {
        haptic.warning();
        Alert.alert('未开启', '你可以在系统设置中手动开启通知权限。', [
          { text: '取消', style: 'cancel' },
          { text: '去设置', onPress: () => Linking.openSettings() },
        ]);
      }
    } catch (e) {
      console.warn('⚠️ 请求通知权限失败:', e?.message ?? e);
      Alert.alert('请求失败', '请稍后重试，或前往系统设置手动开启。');
    }
  };

  const permissionLabel =
    permission === 'granted' ? '已开启' : permission === 'denied' ? '已关闭' : '未设置';
  const permissionColor =
    permission === 'granted' ? colors.primary : permission === 'denied' ? '#FF3B30' : colors.textSecondary;

  return (
    <SettingsPage
      title="通知"
      footer="应用内开关仅保存偏好，系统级通知权限需在系统设置中授权。"
    >
      <GroupTitle>系统权限</GroupTitle>
      <Group>
        <TouchableOpacity
          style={styles.row}
          onPress={permission === 'granted' ? () => Linking.openSettings() : handleRequestPermission}
          activeOpacity={0.6}
        >
          <View style={[styles.iconBox, { backgroundColor: '#FF3B30' }]}>
            <Ionicons name="notifications" size={16} color="#FFF" />
          </View>
          <View style={styles.textWrap}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>允许通知</Text>
            <Text style={[styles.desc, { color: colors.textSecondary }]}>
              {permission === 'granted'
                ? '点击前往系统设置管理'
                : '点击申请系统通知权限'}
            </Text>
          </View>
          <Text style={[styles.value, { color: permissionColor }]}>{permissionLabel}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      </Group>

      <GroupTitle>消息提醒</GroupTitle>
      <Group>
        <SwitchRow
          title="新消息通知"
          desc="收到好友消息时提醒"
          value={settings.notifyMessage}
          onValueChange={(v) => updateSetting('notifyMessage', v)}
          isFirst
        />
        <SwitchRow
          title="健康搭子打卡提醒"
          desc="搭子完成打卡时提醒"
          value={settings.notifyPartner}
          onValueChange={(v) => updateSetting('notifyPartner', v)}
        />
        <SwitchRow
          title="声音与振动"
          desc="提醒时播放提示音并振动"
          value={settings.notifySound}
          onValueChange={(v) => updateSetting('notifySound', v)}
          isLast
        />
      </Group>

      {Platform.OS === 'android' && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Android 上通知渠道由系统管理，如需调整请前往系统设置。
        </Text>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  iconBox: { width: 28, height: 28, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  textWrap: { flex: 1 },
  title: { fontSize: 16, fontWeight: '400' },
  desc: { fontSize: 12, marginTop: 2 },
  value: { fontSize: 15 },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 16, paddingHorizontal: 16 },
});
// --- END OF FILE src/app/settings/notifications.js ---
