// --- START OF FILE src/app/(tabs)/_layout.js ---
import React from 'react';
import { Tabs } from 'expo-router';
import CustomTabBar from '../../components/CustomTabBar';

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <CustomTabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '首页' }} />
      <Tabs.Screen name="space" options={{ title: '空间' }} />
      <Tabs.Screen name="chat" options={{ title: '聊天' }} />
      <Tabs.Screen name="profile" options={{ title: '我的' }} />
    </Tabs>
  );
}
// --- END OF FILE src/app/(tabs)/_layout.js ---