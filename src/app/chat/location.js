// --- START OF FILE src/app/chat/location.js ---
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';

import { useAppTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import SettingsPage, { Group, GroupTitle } from '../../components/settings/SettingsPage';

// params: targetId, targetName
// 发送位置（L3 独立页）：定位 → 确认 → 回传坐标给聊天室发送
//
// 回传方式：router.replace 回 /chat_room 并带上 locLat / locLng / locLabel 参数，
// ChatRoomInner 检测到参数后自动发送一条位置消息并清理参数（避免重复发送）。
export default function ChatLocationScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { targetId, targetName } = useLocalSearchParams();

  const [status, setStatus] = useState('loading'); // loading | ready | denied | error
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');

  // 定位主流程：所有 setState 都发生在 await 之后，避免 effect 内同步 setState
  const locate = useCallback(async () => {
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setStatus('denied');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCoords(next);
      setStatus('ready');

      // 反向地理编码（失败不阻断，仅显示坐标）
      try {
        const places = await Location.reverseGeocodeAsync(next);
        const p = places?.[0];
        if (p) {
          const parts = [p.name, p.street, p.district, p.city, p.region, p.country]
            .filter(Boolean)
            .filter((v, i, arr) => arr.indexOf(v) === i);
          setAddress(parts.join(' '));
        }
      } catch {
        setAddress('');
      }
    } catch {
      setStatus('error');
    }
  }, []);

  // 重新定位：用户主动点击时先回到 loading 态
  const handleRelocate = useCallback(() => {
    haptic.selection();
    setStatus('loading');
    setAddress('');
    locate();
  }, [locate]);

  // 首次进入自动定位（异步 IIFE，setState 全部在 await 之后）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status: perm } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (perm !== 'granted') {
          setStatus('denied');
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(next);
        setStatus('ready');
        try {
          const places = await Location.reverseGeocodeAsync(next);
          if (cancelled) return;
          const p = places?.[0];
          if (p) {
            const parts = [p.name, p.street, p.district, p.city, p.region, p.country]
              .filter(Boolean)
              .filter((v, i, arr) => arr.indexOf(v) === i);
            setAddress(parts.join(' '));
          }
        } catch {
          if (!cancelled) setAddress('');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSend = () => {
    if (!coords) return;
    haptic.medium();
    const label = address || `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
    router.replace({
      pathname: '/chat_room',
      params: {
        targetId,
        targetName: targetName || '',
        locLat: String(coords.lat),
        locLng: String(coords.lng),
        locLabel: label,
      },
    });
  };

  const handleBack = () => {
    haptic.light();
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/chat_room', params: { targetId, targetName: targetName || '' } });
  };

  return (
    <SettingsPage title="发送位置">
      <GroupTitle>当前位置</GroupTitle>
      <Group>
        <View style={styles.card}>
          {status === 'loading' && (
            <View style={styles.center}>
              <ActivityIndicator color={palette.primary} />
              <Text style={[styles.hint, { color: palette.textSecondary }]}>正在获取位置...</Text>
            </View>
          )}

          {status === 'ready' && coords && (
            <>
              <View style={[styles.pinBox, { backgroundColor: palette.iconBackground }]}>
                <Ionicons name="location" size={26} color={palette.primary} />
              </View>
              <Text style={[styles.address, { color: palette.textPrimary }]} numberOfLines={3}>
                {address || '已获取坐标'}
              </Text>
              <Text style={[styles.coord, { color: palette.textSecondary }]}>
                {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
              </Text>
            </>
          )}

          {status === 'denied' && (
            <View style={styles.center}>
              <Ionicons name="location-outline" size={36} color={palette.separator} />
              <Text style={[styles.hint, { color: palette.textSecondary }]}>
                未获得定位权限，请在系统设置中允许 Sync 访问位置。
              </Text>
            </View>
          )}

          {status === 'error' && (
            <View style={styles.center}>
              <Ionicons name="alert-circle-outline" size={36} color={palette.separator} />
              <Text style={[styles.hint, { color: palette.textSecondary }]}>
                定位失败，请检查网络或稍后重试。
              </Text>
            </View>
          )}
        </View>
      </Group>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, styles.btnGhost, { borderColor: palette.cardBorder }]}
          onPress={handleRelocate}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="重新定位"
        >
          <Ionicons name="refresh" size={18} color={palette.textPrimary} />
          <Text style={[styles.btnText, { color: palette.textPrimary }]}>重新定位</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: palette.primary, opacity: status === 'ready' ? 1 : 0.4 },
          ]}
          onPress={handleSend}
          disabled={status !== 'ready'}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="发送位置"
        >
          <Ionicons name="send" size={18} color="#FFFFFF" />
          <Text style={[styles.btnText, { color: '#FFFFFF' }]}>发送</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity onPress={handleBack} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="取消">
          <Text style={[styles.cancelText, { color: palette.textSecondary }]}>取消</Text>
        </TouchableOpacity>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 20, alignItems: 'center' },
  center: { alignItems: 'center', paddingVertical: 12 },
  pinBox: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  address: { fontSize: 16, fontWeight: '600', textAlign: 'center', lineHeight: 22 },
  coord: { fontSize: 12, marginTop: 8, letterSpacing: 0.4 },
  hint: { fontSize: 13, marginTop: 12, textAlign: 'center', lineHeight: 19, paddingHorizontal: 8 },
  actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 24 },
  btn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  btnGhost: { borderWidth: StyleSheet.hairlineWidth },
  btnText: { fontSize: 16, fontWeight: '600' },
  footer: { alignItems: 'center', paddingTop: 20 },
  cancelText: { fontSize: 15 },
});
// --- END OF FILE src/app/chat/location.js ---
