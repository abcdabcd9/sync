// --- START OF FILE src/app/chat_room.js ---
import React from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAppTheme } from '../context/ThemeContext';
import ChatRoomInner from '../components/ChatRoomInner';

export default function ChatRoomScreen() {
  const { colors: palette } = useAppTheme();
  const router = useRouter();
  const { targetId, targetName } = useLocalSearchParams();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top']}>
      <ChatRoomInner 
        targetId={targetId} 
        targetName={targetName} 
        isTabletMode={false} 
        onBack={() => router.back()} 
      />
    </SafeAreaView>
  );
}
// --- END OF FILE src/app/chat_room.js ---