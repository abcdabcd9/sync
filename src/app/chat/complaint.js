// --- START OF FILE src/app/chat/complaint.js ---
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useAppTheme } from '../../context/ThemeContext';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../services/supabase';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: targetId, targetName, scope ('chat' | 'friend')
// 投诉（L3 独立页）
const REASONS = [
  { key: 'harass', label: '骚扰 / 辱骂' },
  { key: 'fraud', label: '欺诈 / 诈骗' },
  { key: 'porn', label: '色情 / 违法内容' },
  { key: 'spam', label: '垃圾广告 / 刷屏' },
  { key: 'other', label: '其他违规行为' },
];

export default function ComplaintScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { targetId, targetName, scope } = useLocalSearchParams();

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selected) {
      haptic.warning();
      Alert.alert('请选择原因', '请先选择一条投诉原因。');
      return;
    }
    if (!user || !targetId) return;
    haptic.medium();
    setSubmitting(true);
    try {
      const reasonLabel = REASONS.find((r) => r.key === selected)?.label || selected;
      const { error } = await supabase.from('complaints').insert({
        reporter_id: user.id,
        target_id: targetId,
        reason: detail.trim() ? `${reasonLabel}：${detail.trim()}` : reasonLabel,
        scope: scope || 'chat',
      });
      if (error) throw error;
      haptic.success();
      Alert.alert('已提交', '感谢你的反馈，我们会在 24 小时内核实处理。', [
        { text: '好的', onPress: () => router.back() },
      ]);
    } catch {
      haptic.error();
      Alert.alert('提交失败', '请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsPage title="投诉">
      <GroupTitle>{targetName ? `投诉「${targetName}」` : '投诉对象'}</GroupTitle>
      <Group>
        {REASONS.map((opt, index) => {
          const active = opt.key === selected;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[
                styles.row,
                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
              ]}
              onPress={() => {
                haptic.selection();
                setSelected(opt.key);
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.label}
            >
              <Text style={[styles.title, { color: palette.textPrimary }]}>{opt.label}</Text>
              {active && <Ionicons name="checkmark" size={20} color={palette.primary} />}
            </TouchableOpacity>
          );
        })}
      </Group>

      <GroupTitle>补充说明（选填）</GroupTitle>
      <Group>
        <View style={styles.detailWrap}>
          <TextInput
            style={[styles.detailInput, { color: palette.textPrimary }]}
            placeholder="描述具体情况，有助于我们更快处理"
            placeholderTextColor={palette.textSecondary}
            value={detail}
            onChangeText={setDetail}
            multiline
            maxLength={300}
            textAlignVertical="top"
          />
        </View>
      </Group>

      <View style={styles.submitWrap}>
        <TouchableOpacity
          style={[styles.submitBtn, { backgroundColor: '#FF3B30', opacity: submitting ? 0.6 : 1 }]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="提交投诉"
        >
          <Text style={styles.submitText}>{submitting ? '提交中...' : '提交投诉'}</Text>
        </TouchableOpacity>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 16, flex: 1 },
  detailWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  detailInput: { fontSize: 15, minHeight: 88, lineHeight: 21 },
  submitWrap: { paddingHorizontal: 16, paddingTop: 24 },
  submitBtn: { height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  submitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
// --- END OF FILE src/app/chat/complaint.js ---
