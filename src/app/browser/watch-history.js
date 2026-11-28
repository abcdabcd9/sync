// --- START OF FILE src/app/browser/watch-history.js ---
import { useCallback } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useAppTheme } from '../../context/ThemeContext';
import { useBrowserSession } from '../../context/BrowserSessionContext';
import { useAuth } from '../../hooks/useAuth';
import { useWatchHistory } from '../../hooks/browser/useWatchHistory';
import {
  computeProgressRatio,
  decideResume,
  formatDuration,
  formatWatchTime,
  RESUME_ACTION,
  resolveResumeSeconds,
  shouldResume,
} from '../../hooks/browser/watchHistoryLogic';
import EmptyState from '../../components/ui/EmptyState';
import { haptic } from '../../constants/haptics';

/**
 * 🎬 视频观看历史独立页（V1）
 *
 * 功能：
 *   - 列表展示：标题 / 域名 / 最后观看时间（精确到秒）/ 播放位置 / 总时长 / 进度条
 *   - 点击续播：把「待续播任务」交给浏览器页（通过 BrowserSession 的 pendingUrl 通道）
 *   - 单条删除 / 一键清空
 *
 * 🔗 续播交接方式：
 *   本页不直接操作播放器（播放器在 CinemaProvider 中，且需要 WebView 上下文）。
 *   点击记录时把「原始播放页 URL」写入 pendingUrl 并回退到浏览器页；
 *   浏览器页消费 pendingUrl 时，会先检查是否存在待续播任务（见 browser/index.js）。
 *   ⚠️ 若记录没有可用播放页（仅有直链），则直接以直链作为 pendingUrl 交给浏览器，
 *      由浏览器导航层识别为直链视频并进入影院（与手动输入直链行为一致）。
 */
export default function WatchHistoryScreen() {
  const { colors } = useAppTheme();
  const { user, authEpoch } = useAuth();
  const { watchList, deleteWatchRecord, clearWatchHistory } = useWatchHistory(
    user?.id ?? null,
    authEpoch
  );
  const { setPendingUrl, setPendingResume } = useBrowserSession();

  // ▶ 点击记录：由 decideResume 决定「直接播放并 seek」还是「回原始页重新嗅探」
  //    ⚠️ 绝不盲目选择第一个候选资源；无可用地址时明确提示。
  //    🛡️ P0-2：decideResume 已改为「优先回原始播放页」——脱敏后的直链不再被视为
  //       必然可用（签名参数已被剥离，直接播放大概率 403）。因此：
  //         - 有 pageUrl → NAVIGATE_TO_PAGE（回原页重新嗅探，最可靠）
  //         - 仅直链（无 pageUrl）→ PLAY_AND_SEEK 但标记 unverified，由影院页
  //           在播放失败时回退（不无限等待，超时自动作废）
  const handleResume = useCallback(
    (item) => {
      if (!item) return;
      // 本页没有实时候选列表，因此 candidates 传空：
      //   - 有 pageUrl → NAVIGATE_TO_PAGE（Case B，回原页重新嗅探）
      //   - 仅有 mediaUrl → PLAY_AND_SEEK / PLAY_FROM_START（Case A，unverified）
      const decision = decideResume(item, []);
      if (decision.action === RESUME_ACTION.UNAVAILABLE) {
        Alert.alert('无法续播', '该记录缺少可用的播放地址，请重新搜索该视频。');
        return;
      }
      haptic.light();
      const seekSeconds = resolveResumeSeconds(item);
      // 🎬 先写入待续播任务（含 recordKey / mediaKey / seekSeconds），再写入待加载 URL。
      //    浏览器页消费 pendingUrl 时会读取 pendingResume 决定是否 seek。
      //    🛡️ 最终收口（媒体身份语义统一）：
      //       recordKey = 观看记录身份（ep: 站点:剧:源:集，与 CDN 无关）
      //       mediaKey  = 记录写入时实际加载的媒体身份（m: 脱敏直链）
      //       影院页用「当前播放媒体」的 recordKey 与之比对：
      //         · recordKey 一致 → 同一集，换 CDN 也能续播
      //         · 仅 pageUrl 相同 → 拒绝（防同页广告 / 同页不同集）
      setPendingResume({
        recordKey: item.recordKey || item.mediaKey,
        mediaKey: item.mediaKey,
        // 🎯 P0-6：任务携带「那一集」的播放页，供浏览器页 / 影院页精确比对
        pageUrl: item.episodePageUrl || item.pageUrl,
        mediaUrl: item.mediaUrl,
        seekSeconds,
        title: item.title,
        episodeLabel: item.episodeLabel,
      });
      // 🔗 打开目标页：优先「那一集」的播放页（Case B），无播放页时退化为直链（Case A）
      //    🎯 P0-6：decision.url 已由 decideResume 通过 resolveTargetEpisodePage 解析，
      //       保证直达目标集数播放页，而不是站点首页 / 剧集详情页。
      const target = decision.url || item.episodePageUrl || item.pageUrl || item.mediaUrl;
      if (target) setPendingUrl(target);
      router.back();
    },
    [setPendingUrl, setPendingResume]
  );

  const handleDelete = useCallback(
    (id) => {
      haptic.light();
      deleteWatchRecord(id);
    },
    [deleteWatchRecord]
  );

  const handleClear = useCallback(() => {
    haptic.medium();
    Alert.alert('清空观看历史', '确定要删除全部视频观看历史吗？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => clearWatchHistory() },
    ]);
  }, [clearWatchHistory]);

  const renderItem = ({ item }) => {
    const ratio = computeProgressRatio(item.positionMillis, item.durationMillis);
    const resumable = shouldResume(item);
    const hasDuration = item.durationMillis > 0;
    return (
      <View style={[styles.row, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity
          style={styles.rowContent}
          onPress={() => handleResume(item)}
          activeOpacity={0.7}
        >
          <View style={styles.textGroup}>
            <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
              {item.title || item.domain || '未知视频'}
            </Text>
            <View style={styles.metaRow}>
              {item.domain ? (
                <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
                  {item.domain}
                </Text>
              ) : null}
              {item.episodeLabel ? (
                <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
                  · {item.episodeLabel}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.time, { color: colors.textSecondary }]} numberOfLines={1}>
              {formatWatchTime(item.lastWatchedAt)}
            </Text>

            {/* 📊 进度条：仅在有时长时展示 */}
            {hasDuration ? (
              <View style={styles.progressWrap}>
                <View style={[styles.progressTrack, { backgroundColor: colors.separator }]}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.round(ratio * 100)}%`,
                        backgroundColor: item.completed ? colors.textSecondary : colors.primary,
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                  {formatDuration(item.positionMillis)} / {formatDuration(item.durationMillis)}
                </Text>
              </View>
            ) : (
              <Text style={[styles.progressText, { color: colors.textSecondary }]}>
                {formatDuration(item.positionMillis)}
              </Text>
            )}
          </View>

          <View style={styles.rightGroup}>
            <Ionicons
              name={resumable ? 'play-circle' : 'refresh-circle'}
              size={26}
              color={resumable ? colors.primary : colors.textSecondary}
            />
            <Text style={[styles.actionHint, { color: colors.textSecondary }]}>
              {resumable ? '续播' : item.completed ? '已看完' : '重播'}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteBtn} onPress={() => handleDelete(item.id)}>
          <Ionicons name="close-circle-outline" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: colors.background }]}
      edges={['top', 'bottom']}
    >
      <View style={styles.navBar}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={[styles.navTitle, { color: colors.textPrimary }]}>视频观看历史</Text>
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={handleClear}
          disabled={watchList.length === 0}
          activeOpacity={0.7}
        >
          <Ionicons
            name="trash-bin-outline"
            size={16}
            color={watchList.length === 0 ? colors.separator : colors.primary}
          />
          <Text
            style={[
              styles.clearText,
              { color: watchList.length === 0 ? colors.separator : colors.primary },
            ]}
          >
            清空
          </Text>
        </TouchableOpacity>
      </View>

      {watchList.length === 0 ? (
        <EmptyState
          icon="🎬"
          title="暂无观看记录"
          subtitle="在浏览器中播放视频后，会自动记录进度并支持续播"
        />
      ) : (
        <FlashList
          data={watchList}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          estimatedItemSize={96}
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
    paddingHorizontal: 12,
  },
  backBtn: { padding: 4, marginRight: 4 },
  navTitle: { flex: 1, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  clearText: { fontSize: 14, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  textGroup: { flex: 1, marginRight: 10 },
  title: { fontSize: 15, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  meta: { fontSize: 12 },
  time: { fontSize: 12, marginTop: 3, fontVariant: ['tabular-nums'] },
  progressWrap: { marginTop: 8 },
  progressTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  progressText: { fontSize: 11, marginTop: 4, fontVariant: ['tabular-nums'] },
  rightGroup: { alignItems: 'center', justifyContent: 'center', width: 56 },
  actionHint: { fontSize: 10, marginTop: 2 },
  deleteBtn: { padding: 8, marginLeft: 4 },
});
// --- END OF FILE src/app/browser/watch-history.js ---
