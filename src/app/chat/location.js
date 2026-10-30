// --- START OF FILE src/app/chat/location.js ---
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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

/** 单次定位超时（毫秒）。Android 冷启动 GPS 首次定位可能超过 30s，超时后走兜底。 */
const LOCATE_TIMEOUT_MS = 12000;

/** 把 Promise 包一层超时，避免 Android 上 getCurrentPositionAsync 永久挂起 */
function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** 反向地理编码 → 可读地址（失败返回空串，绝不阻断主流程） */
async function resolveAddress(coords) {
  try {
    const places = await withTimeout(Location.reverseGeocodeAsync(coords), 6000, 'reverseGeocode');
    const p = places?.[0];
    if (!p) return '';
    const parts = [p.name, p.street, p.district, p.city, p.region, p.country]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i);
    return parts.join(' ');
  } catch {
    return '';
  }
}

export default function ChatLocationScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { targetId, targetName } = useLocalSearchParams();

  const [status, setStatus] = useState('loading'); // loading | ready | denied | error
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  const [hint, setHint] = useState('');
  // 🔄 「重新定位」进行中标记：只用来禁用按钮 + 按钮内显示小转圈，
  //    绝不参与内容区渲染，因此不会造成整块 UI 卸载/重挂（闪烁）。
  const [isRelocating, setIsRelocating] = useState(false);

  // 防止并发定位（连点「重新定位」时只保留最后一次）
  const runIdRef = useRef(0);

  /**
   * 定位主流程（iOS / Android 统一）：
   *  1. 申请前台权限
   *  2. Android 额外尝试打开网络定位提供者（否则只能等 GPS 冷启动，非常慢）
   *  3. 先取「最后已知位置」立即出结果（秒出，体验等同 iOS）
   *  4. 再尝试高精度实时定位，成功则覆盖；超时/失败则保留已知位置
   *  5. 反向地理编码（失败仅显示坐标）
   */
  const locate = useCallback(async () => {
    const runId = ++runIdRef.current;
    const isStale = () => runId !== runIdRef.current;

    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (isStale()) return;
      if (perm !== 'granted') {
        setStatus('denied');
        return;
      }

      // 🤖 Android：主动提示开启「网络定位」。未开启时系统只能靠 GPS 冷启动，
      //    表现为「定位很久 / 一直转圈 / 重新定位也没反应」。
      if (Platform.OS === 'android') {
        try {
          await withTimeout(Location.enableNetworkProviderAsync(), 4000, 'enableNetworkProvider');
        } catch (_) {
          // 用户拒绝或系统不支持：继续走 GPS，不阻断
        }
        if (isStale()) return;
      }

      // ① 最后已知位置：几乎瞬时返回，先让界面可用
      let best = null;
      try {
        const last = await withTimeout(Location.getLastKnownPositionAsync(), 3000, 'lastKnown');
        if (last?.coords) best = { lat: last.coords.latitude, lng: last.coords.longitude };
      } catch (_) {}

      if (best && !isStale()) {
        setCoords(best);
        setStatus('ready');
        setHint('已使用最近一次定位，正在精确定位…');
      }

      // ② 实时定位：Balanced 在 Android 上比 High 快得多，且足够发位置
      try {
        const pos = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          LOCATE_TIMEOUT_MS,
          'getCurrentPosition',
        );
        if (isStale()) return;
        best = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(best);
        setStatus('ready');
        setHint('');
      } catch (_) {
        if (isStale()) return;
        // 实时定位失败：有已知位置就继续用，没有才报错
        if (!best) {
          setStatus('error');
          setHint('定位超时，请确认已开启系统定位服务后重试。');
          return;
        }
        setHint('精确定位超时，已使用最近一次位置。');
      }

      // ③ 反向地理编码
      const addr = await resolveAddress(best);
      if (isStale()) return;
      setAddress(addr);
    } catch (_) {
      if (isStale()) return;
      setStatus('error');
      setHint('');
    }
  }, []);

  // 重新定位：用户主动点击时**不**回到 loading 态。
  // 🚨 旧实现 setStatus('loading') + setAddress('') + setHint('') 会把整个
  //    `status === 'ready'` 区块（图钉 / 地址 / 坐标 / 提示）卸载掉，
  //    换成居中的 ActivityIndicator，等定位回来再挂回去 —— 用户看到的就是
  //    「整块内容闪一下、消失、再出现」。
  //    修复：已有坐标时保持 ready 态，只在 hint 里显示「正在重新定位…」，
  //    新坐标到达后原地更新，视觉上零跳动。
  const handleRelocate = useCallback(() => {
    haptic.selection();
    setIsRelocating(true);
    if (coords) {
      // 已有坐标：原地刷新，不卸载 UI
      setHint('正在重新定位…');
    } else {
      // 首次定位失败后重试：此时没有可保留的内容，回到 loading 是合理的
      setStatus('loading');
      setAddress('');
      setHint('');
    }
    locate().finally(() => setIsRelocating(false));
  }, [locate, coords]);

  // 首次进入自动定位（异步 IIFE，setState 全部在 await 之后）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await locate();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
      // 让进行中的定位结果作废
      runIdRef.current += 1;
    };
  }, [locate]);

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
              {!!hint && (
                <Text style={[styles.hint, { color: palette.textSecondary }]}>{hint}</Text>
              )}
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
                {hint || '定位失败，请检查网络或稍后重试。'}
              </Text>
            </View>
          )}
        </View>
      </Group>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, styles.btnGhost, { borderColor: palette.cardBorder, opacity: isRelocating ? 0.5 : 1 }]}
          onPress={handleRelocate}
          disabled={isRelocating}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="重新定位"
        >
          {isRelocating ? (
            <ActivityIndicator size="small" color={palette.textPrimary} />
          ) : (
            <Ionicons name="refresh" size={18} color={palette.textPrimary} />
          )}
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
