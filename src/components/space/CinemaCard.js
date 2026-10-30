// --- START OF FILE src/components/space/CinemaCard.js ---
import { router } from 'expo-router';
import SpaceCard from './SpaceCard';
import { useAppTheme } from '../../context/ThemeContext';

// 放映厅入口：一起看片，实时同步（阶段 5 拆分为 /cinema 大厅 + 房间）
export default function CinemaCard() {
  const { colors } = useAppTheme();
  return (
    <SpaceCard
      icon="film"
      title="放映厅"
      subtitle="一起看片，实时同步"
      accentColor={colors.primary}
      onPress={() => router.push('/cinema')}
    />
  );
}
// --- END OF FILE src/components/space/CinemaCard.js ---
