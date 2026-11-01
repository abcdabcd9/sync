// --- START OF FILE src/app/browser/bookmarks.js ---
import { useCallback } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useAppTheme } from '../../context/ThemeContext';
import { useBrowserHistory } from '../../hooks/browser/useBrowserHistory';
import EmptyState from '../../components/ui/EmptyState';
import { haptic } from '../../constants/haptics';
import { ellipsisMiddle, isSafeUrl, getDomain } from '../../constants/browser';

// 🏷️ 常见站点展示名（默认搜索引擎书签用，未命中则回退到域名）
const SITE_LABELS = {
  'bing.com': 'Bing 必应',
  'google.com': 'Google 谷歌',
  'baidu.com': '百度',
  'duckduckgo.com': 'DuckDuckGo',
  'sogou.com': '搜狗',
  'yahoo.com': 'Yahoo 雅虎',
};

// params: 无
// 影院书签独立页：点击回浏览器加载 / 删除书签
export default function BrowserBookmarks() {
  const { colors } = useAppTheme();
  const { bookmarksList, removeBookmark } = useBrowserHistory();

  const handleLoad = useCallback((url) => {
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该收藏链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    haptic.light();
    router.replace({ pathname: '/browser', params: { targetUrl: url } });
  }, []);

  const handleDelete = useCallback(
    async (url) => {
      haptic.heavy();
      await removeBookmark(url);
    },
    [removeBookmark]
  );

  const renderItem = ({ item }) => {
    const domain = getDomain(item);
    const label = SITE_LABELS[domain];
    return (
      <View style={[styles.row, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity style={styles.rowContent} onPress={() => handleLoad(item)} activeOpacity={0.7}>
          <Ionicons name="globe-outline" size={20} color={colors.textSecondary} style={styles.globe} />
          <View style={styles.textBox}>
            {label ? (
              <>
                <Text style={[styles.siteName, { color: colors.textPrimary }]} numberOfLines={1}>
                  {label}
                </Text>
                <Text style={[styles.urlSub, { color: colors.textSecondary }]} numberOfLines={1}>
                  {ellipsisMiddle(item, 30, 14)}
                </Text>
              </>
            ) : (
              <Text style={[styles.url, { color: colors.textPrimary }]} numberOfLines={1}>
                {ellipsisMiddle(item, 34, 16)}
              </Text>
            )}
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(item)}>
          <Ionicons name="trash-outline" size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.navBar}>
        <Text style={[styles.navTitle, { color: colors.textPrimary }]}>书签</Text>
      </View>

      {bookmarksList.length === 0 ? (
        <EmptyState icon="🏷️" title="暂无收藏" subtitle="在浏览器菜单中收藏喜欢的网址" />
      ) : (
        <FlashList
          data={bookmarksList}
          renderItem={renderItem}
          keyExtractor={(item) => item}
          estimatedItemSize={56}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  navBar: { height: 50, justifyContent: 'center', paddingHorizontal: 20 },
  navTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  listContent: { paddingHorizontal: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  globe: { marginRight: 12 },
  textBox: { flex: 1 },
  siteName: { fontSize: 15, fontWeight: '500' },
  urlSub: { fontSize: 12, marginTop: 2 },
  url: { flex: 1, fontSize: 15 },
  deleteBtn: { padding: 8, marginLeft: 8 },
});
// --- END OF FILE src/app/browser/bookmarks.js ---
