// --- START OF FILE src/components/space/PrivateSpaceCard.js ---
import { router } from 'expo-router';
import SpaceCard from './SpaceCard';
import { useAppTheme } from '../../context/ThemeContext';

// 私密空间入口：只属于当前用户的相册与笔记（阶段 6 实现具体页面）
export default function PrivateSpaceCard() {
  const { colors } = useAppTheme();
  return (
    <SpaceCard
      icon="lock-closed"
      title="私密空间"
      subtitle="只属于你的相册与笔记"
      accentColor={colors.primary}
      onPress={() => router.push('/private')}
    />
  );
}
// --- END OF FILE src/components/space/PrivateSpaceCard.js ---
