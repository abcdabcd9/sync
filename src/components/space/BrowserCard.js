// --- START OF FILE src/components/space/BrowserCard.js ---
import { router } from 'expo-router';
import SpaceCard from './SpaceCard';
import { useAppTheme } from '../../context/ThemeContext';

// 浏览器入口：嗅探媒体，一键投屏（阶段 5 拆分为 /browser + 历史 + 书签）
export default function BrowserCard() {
  const { colors } = useAppTheme();
  return (
    <SpaceCard
      icon="globe-outline"
      title="浏览器"
      subtitle="嗅探媒体，一键投屏"
      accentColor={colors.iconBackground}
      onPress={() => router.push('/browser')}
    />
  );
}
// --- END OF FILE src/components/space/BrowserCard.js ---
