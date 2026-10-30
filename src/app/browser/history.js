// --- START OF FILE src/app/browser/history.js ---
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
import { ellipsisMiddle, formatHistoryTime, isSafeUrl } from '../../constants/browser';

// params: 无
// 浏览历史独立页：点击回浏览器加载 / 单条删除 / 一键清空
export default function BrowserHistory() {
  const { colors } = useAppTheme();
  const { historyList, deleteHistory, clearHistory } = useBrowserHistory();

  const handleLoad = useCallback((url) => {
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该历史链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    haptic.light();
    router.replace({ pathname: '/browser', params: { targetUrl: url } });
  }, []);

  const handleDelete = useCallback(
    (id) => {
      haptic.light();
      deleteHistory(id);
    },
    [deleteHistory]
  );

  const handleClear = useCallback(() => {
    haptic.medium();
    Alert.alert('清空历史记录', '确定要删除全部浏览历史吗？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => clearHistory() },
    ]);
  }, [clearHistory]);

  const renderItem = ({ item }) => (
    <View style={[styles.row, { borderBottomColor: colors.separator }]}>
      <TouchableOpacity style={styles.rowContent} onPress={() => handleLoad(item.url)} activeOpacity={0.7}>
        <View style={styles.textGroup}>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.url, { color: colors.textSecondary }]} numberOfLines={1}>
            {ellipsisMiddle(item.url, 28, 14)}
          </Text>
        </View>
        <Text style={[styles.time, { color: colors.textSecondary }]}>
          {formatHistoryTime(item.timestamp)}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(item.id)}>
        <Ionicons name="close-circle-outline" size={20} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.navBar}>
        <Text style={[styles.navTitle, { color: colors.textPrimary }]}>历史记录</Text>
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={handleClear}
          disabled={historyList.length === 0}
          activeOpacity={0.7}
        >
          <Ionicons
            name="trash-bin-outline"
            size={16}
            color={historyList.length === 0 ? colors.separator : colors.primary}
          />
          <Text
            style={[
              styles.clearText,
              { color: historyList.length === 0 ? colors.separator : colors.primary },
            ]}
          >
            清空
          </Text>
        </TouchableOpacity>
      </View>

      {historyList.length === 0 ? (
        <EmptyState icon="🕘" title="暂无浏览历史" subtitle="浏览网页后会自动记录在这里" />
      ) : (
        <FlashList
          data={historyList}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          estimatedItemSize={64}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  navBar: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  navTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  clearText: { fontSize: 14, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  textGroup: { flex: 1, marginRight: 10 },
  title: { fontSize: 15, fontWeight: '500' },
  url: { fontSize: 12, marginTop: 3 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
  deleteBtn: { padding: 8, marginLeft: 8 },
});
// --- END OF FILE src/app/browser/history.js ---
