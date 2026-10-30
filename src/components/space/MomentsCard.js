// --- START OF FILE src/components/space/MomentsCard.js ---
import { router } from 'expo-router';
import SpaceCard from './SpaceCard';
import { useAppTheme } from '../../context/ThemeContext';

// 朋友圈入口：记录此刻，与好友分享（阶段 6 实现具体页面）
export default function MomentsCard() {
  const { colors } = useAppTheme();
  return (
    <SpaceCard
      icon="sparkles"
      title="朋友圈"
      subtitle="记录此刻，与好友分享"
      accentColor={colors.success}
      onPress={() => router.push('/moments')}
    />
  );
}
// --- END OF FILE src/components/space/MomentsCard.js ---
