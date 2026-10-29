// --- START OF FILE src/app/_layout.js ---
import React from 'react';
import { View, useColorScheme, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { HealthProvider, useHealthData } from '../hooks/useHealthData';
import { CinemaProvider } from '../hooks/useCinema';
import { AuthProvider } from '../hooks/useAuth';
import FloatingPlayer from '../components/FloatingPlayer';
import { getPalette } from '../constants/colors';
import { usePushNotifications } from '../hooks/usePushNotifications';

function RootNavigation() {
  const { isInitialized } = useHealthData();
  const palette = getPalette(useColorScheme() === 'dark');
  usePushNotifications();

  if (!isInitialized) return <View style={{ flex: 1, backgroundColor: palette.background }} />;

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <Stack screenOptions={{ headerShown: false, gestureEnabled: true, gestureDirection: 'horizontal', contentStyle: { backgroundColor: 'transparent' } }}>
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="auth" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="settings" options={{ animation: Platform.OS === 'ios' ? 'slide_from_right' : 'fade' }} />
        <Stack.Screen name="browser" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="cinema" options={{ animation: 'slide_from_bottom' }} />
      </Stack>
      <FloatingPlayer />
    </View>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <HealthProvider>
        <CinemaProvider>
          <RootNavigation />
        </CinemaProvider>
      </HealthProvider>
    </AuthProvider>
  );
}
// --- END OF FILE src/app/_layout.js ---