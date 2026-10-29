// --- START OF FILE space.js ---
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
// 🍎 核心修复：加上 ../../ 退回两级目录
import { useAppTheme } from '../../context/ThemeContext';
import { SIZES, TYPOGRAPHY } from '../../constants/theme'; 

export default function SpaceScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          
          <View style={styles.header}>
            <Text style={[styles.largeTitle, { color: palette.textPrimary }]}>互联空间</Text>
            <Text style={[styles.subtitle, { color: palette.textSecondary }]}>跨设备实时状态同步</Text>
          </View>

          <View style={styles.section}>
            <TouchableOpacity style={[styles.cinemaButton, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1 }]} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); router.push('/cinema'); }} activeOpacity={0.7}>
              <View style={styles.btnLeft}>
                <View style={[styles.iconBox, { backgroundColor: palette.primary }]}><Ionicons name="film" size={24} color="#FFFFFF" /></View>
                <View>
                  <Text style={[styles.btnTitle, { color: palette.textPrimary }]}>同步播放</Text>
                  <Text style={[styles.btnSub, { color: palette.textSecondary }]}>建立低延迟媒体通道</Text>
                </View>
              </View>
              <View style={[styles.statusDot, { backgroundColor: palette.success }]} />
              <Ionicons name="chevron-forward" size={20} color={palette.textSecondary} />
            </TouchableOpacity>

            <TouchableOpacity style={[styles.cinemaButton, { backgroundColor: palette.card, borderColor: palette.cardBorder, borderWidth: 1, marginTop: 16 }]} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); router.push('/browser'); }} activeOpacity={0.7}>
              <View style={styles.btnLeft}>
                <View style={[styles.iconBox, { backgroundColor: palette.textPrimary }]}><Ionicons name="globe-outline" size={24} color={palette.background} /></View>
                <View>
                  <Text style={[styles.btnTitle, { color: palette.textPrimary }]}>媒体浏览器</Text>
                  <Text style={[styles.btnSub, { color: palette.textSecondary }]}>网页视频流解析与提取</Text>
                </View>
              </View>
              <Ionicons name="search" size={20} color={palette.textSecondary} />
            </TouchableOpacity>
          </View>

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, safe: { flex: 1 }, scroll: { paddingBottom: 140 },
  header: { paddingHorizontal: SIZES.padding, paddingTop: 24, paddingBottom: 32 },
  largeTitle: TYPOGRAPHY.largeTitle, subtitle: { fontSize: 15, fontWeight: '500', marginTop: 6 },
  section: { paddingHorizontal: SIZES.padding },
  cinemaButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: SIZES.radiusCard },
  btnLeft: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  iconBox: { width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  btnTitle: { fontSize: 17, fontWeight: '600', marginBottom: 4 },
  btnSub: { fontSize: 13, fontWeight: '400' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 'auto', marginRight: 12 },
});
// --- END OF FILE space.js ---