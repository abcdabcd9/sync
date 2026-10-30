// --- START OF FILE src/app/settings/storage.js ---
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// 缓存分类：按 AsyncStorage key 前缀归类
const CATEGORIES = [
  { key: 'health', label: '健康与打卡数据', match: (k) => k.startsWith('@water') || k.startsWith('@meals') || k.startsWith('@maxWater') || k.startsWith('@motto') || k.startsWith('@mealGuides') || k.startsWith('@streak') || k.startsWith('@lastCheckIn') || k.startsWith('@lastActive') },
  { key: 'theme', label: '外观与主题', match: (k) => k === '@app_theme_mode' },
  { key: 'settings', label: '应用设置', match: (k) => k === '@app_settings' },
  { key: 'other', label: '其他缓存', match: () => true },
];

// 字节数 → 可读文本
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// 字符串按 UTF-8 估算字节数（中文 3 字节，ASCII 1 字节）
function byteLength(str) {
  if (!str) return 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个 emoji 占 4 字节，跳过下一个码元
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

// 存储空间：真实统计 AsyncStorage 占用
export default function StorageSettingsScreen() {
  const { colors } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);

  const measure = useCallback(async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      if (!keys || keys.length === 0) {
        setRows(CATEGORIES.map((c) => ({ ...c, bytes: 0, count: 0 })));
        setTotal(0);
        return;
      }
      const pairs = await AsyncStorage.multiGet(keys);
      const buckets = CATEGORIES.map((c) => ({ ...c, bytes: 0, count: 0 }));
      let sum = 0;

      pairs.forEach(([key, value]) => {
        const size = byteLength(key) + byteLength(value);
        sum += size;
        // 按顺序匹配第一个命中的分类（other 兜底）
        const bucket = buckets.find((b) => b.match(key));
        if (bucket) {
          bucket.bytes += size;
          bucket.count += 1;
        }
      });

      setRows(buckets);
      setTotal(sum);
    } catch (e) {
      console.warn('⚠️ 统计存储占用失败:', e?.message ?? e);
      setRows(CATEGORIES.map((c) => ({ ...c, bytes: 0, count: 0 })));
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载后异步统计一次；measure 内部不再同步 setState，避免 set-state-in-effect
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await measure();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [measure]);

  const handleClear = () => {
    haptic.warning();
    Alert.alert(
      '清除本地缓存',
      '将清除本机保存的健康打卡记录、主题与设置偏好。云端数据不受影响，但本机记录会丢失。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: async () => {
            try {
              setLoading(true);
              await AsyncStorage.clear();
              haptic.success();
              await measure();
              Alert.alert('已清除', '本地缓存已全部清除。');
            } catch {
              haptic.error();
              Alert.alert('清除失败', '请稍后重试。');
            }
          },
        },
      ]
    );
  };

  return (
    <SettingsPage
      title="存储空间"
      footer="仅统计本机 AsyncStorage 缓存，不含云端聊天媒体文件。"
    >
      <GroupTitle>占用概览</GroupTitle>
      <Group>
        <View style={[styles.totalRow, { backgroundColor: colors.card }]}>
          <Text style={[styles.totalLabel, { color: colors.textPrimary }]}>本地缓存总计</Text>
          {loading ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={[styles.totalValue, { color: colors.primary }]}>{formatBytes(total)}</Text>
          )}
        </View>
      </Group>

      <GroupTitle>分类明细</GroupTitle>
      <Group>
        {rows.map((row, index) => (
          <View
            key={row.key}
            style={[
              styles.row,
              { backgroundColor: colors.card },
              index < rows.length - 1 && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.separator,
              },
            ]}
          >
            <View style={styles.rowLeft}>
              <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>{row.label}</Text>
              <Text style={[styles.rowCount, { color: colors.textSecondary }]}>
                {row.count} 项
              </Text>
            </View>
            <Text style={[styles.rowValue, { color: colors.textSecondary }]}>
              {formatBytes(row.bytes)}
            </Text>
          </View>
        ))}
      </Group>

      <GroupTitle>清理</GroupTitle>
      <Group>
        <TouchableOpacity
          style={[styles.row, { backgroundColor: colors.card }]}
          onPress={handleClear}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel="清除本地缓存"
        >
          <Text style={[styles.rowLabel, { color: colors.primary }]}>清除本地缓存</Text>
        </TouchableOpacity>
      </Group>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 16,
  },
  totalLabel: { fontSize: 16 },
  totalValue: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowLeft: { flex: 1 },
  rowLabel: { fontSize: 16 },
  rowCount: { fontSize: 12, marginTop: 2 },
  rowValue: { fontSize: 15 },
});
// --- END OF FILE src/app/settings/storage.js ---
