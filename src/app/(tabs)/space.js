// --- START OF FILE src/app/(tabs)/space.js ---
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '../../context/ThemeContext';
import { SIZES, TYPOGRAPHY } from '../../constants/theme';
import PrivateSpaceCard from '../../components/space/PrivateSpaceCard';
import MomentsCard from '../../components/space/MomentsCard';
import CinemaCard from '../../components/space/CinemaCard';
import BrowserCard from '../../components/space/BrowserCard';

// params: 无（tab 页）
// 空间页：4 个入口卡，具体页面在 L3（/private、/moments、/cinema、/browser）
export default function SpaceScreen() {
  const { colors: palette } = useAppTheme();

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <Text style={[styles.largeTitle, { color: palette.textPrimary }]}>空间</Text>
            <Text style={[styles.subtitle, { color: palette.textSecondary }]}>
              私密记录 · 好友分享 · 同步观影 · 媒体嗅探
            </Text>
          </View>

          <PrivateSpaceCard />
          <MomentsCard />
          <CinemaCard />
          <BrowserCard />

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  scroll: { paddingBottom: 140 },
  header: { paddingHorizontal: SIZES.padding, paddingTop: 24, paddingBottom: 20 },
  largeTitle: TYPOGRAPHY.largeTitle,
  subtitle: { fontSize: 15, fontWeight: '500', marginTop: 6 },
  bottomSpacer: { height: 100 },
});
// --- END OF FILE src/app/(tabs)/space.js ---
