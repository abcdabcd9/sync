// --- START OF FILE src/app/browser/bookmarks.js ---
import { useCallback } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useAppTheme } from '../../context/ThemeContext';
import { useBrowserSession } from '../../context/BrowserSessionContext';
import { useBrowserHistory } from '../../hooks/browser/useBrowserHistory';
import EmptyState from '../../components/ui/EmptyState';
import { haptic } from '../../constants/haptics';
import { ellipsisMiddle, isSafeUrl } from '../../constants/browser';

// params: 无
// 影院书签独立页：点击回浏览器加载 / 删除书签
//
// 📝 展示规则（与历史记录页保持一致，不做任何自定义命名）：
//    · 主行：网页自带标题（title）
//    · 副行：缩小版网址
//    · 无标题时：主行留空，只显示缩小版网址，整体垂直居中、左对齐
export default function BrowserBookmarks() {
  const { colors } = useAppTheme();
  const { bookmarksList, removeBookmark } = useBrowserHistory();
  const { setPendingUrl } = useBrowserSession();

  // 🔗 点击书签：把 URL 交给已有浏览器实例，然后回退（不再新建第二个浏览器）
  const handleLoad = useCallback((url) => {
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该收藏链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    haptic.light();
    setPendingUrl(url);
    router.back();
  }, [setPendingUrl]);

  const handleDelete = useCallback(
    async (url) => {
      haptic.heavy();
      await removeBookmark(url);
    },
    [removeBookmark]
  );

  const renderItem = ({ item }) => {
    const { url, title } = item;
    const hasTitle = typeof title === 'string' && title.length > 0;
    return (
      <View style={[styles.row, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity style={styles.rowContent} onPress={() => handleLoad(url)} activeOpacity={0.7}>
          <Ionicons name="globe-outline" size={20} color={colors.textSecondary} style={styles.globe} />
          <View style={styles.textBox}>
            {/* 主行：网页自带标题；无标题时不渲染，网址自然垂直居中 */}
            {hasTitle && (
              <Text style={[styles.siteName, { color: colors.textPrimary }]} numberOfLines={1}>
                {title}
              </Text>
            )}
            {/* 副行：缩小版网址 */}
            <Text
              style={[
                styles.urlSub,
                { color: hasTitle ? colors.textSecondary : colors.textPrimary },
                !hasTitle && styles.urlSubSolo,
              ]}
              numberOfLines={1}
            >
              {ellipsisMiddle(url, 30, 14)}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(url)}>
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
          keyExtractor={(item) => item.url}
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
  // 文本容器：垂直居中 + 左对齐（无标题时网址单行居中）
  textBox: { flex: 1, justifyContent: 'center', alignItems: 'flex-start' },
  siteName: { fontSize: 15, fontWeight: '500', textAlign: 'left' },
  urlSub: { fontSize: 12, marginTop: 2, textAlign: 'left' },
  // 无标题时网址独占一行：去掉上边距，字号略放大以保持视觉重量
  urlSubSolo: { marginTop: 0, fontSize: 15 },
  deleteBtn: { padding: 8, marginLeft: 8 },
});
// --- END OF FILE src/app/browser/bookmarks.js ---
