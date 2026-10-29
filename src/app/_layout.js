// --- START OF FILE src/app/_layout.js ---
import React from 'react';
import { View, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { HealthProvider, useHealthData } from '../hooks/useHealthData';
import { CinemaProvider } from '../hooks/useCinema';
import { AuthProvider } from '../hooks/useAuth';
import { ThemeProvider, useAppTheme } from '../context/ThemeContext';
import FloatingPlayer from '../components/FloatingPlayer';
import { usePushNotifications } from '../hooks/usePushNotifications';

function RootNavigation() {
  const { isInitialized } = useHealthData();
  // 🎨 统一主题控制权：跟随系统 / 强制浅色 / 强制深色
  const { colors: palette } = useAppTheme();
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
    <ThemeProvider>
      <AuthProvider>
        <HealthProvider>
          <CinemaProvider>
            <RootNavigation />
          </CinemaProvider>
        </HealthProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
// --- END OF FILE src/app/_layout.js ---