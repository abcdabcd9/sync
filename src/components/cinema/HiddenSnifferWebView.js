// --- START OF FILE src/components/cinema/HiddenSnifferWebView.js ---
import React, { useRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  buildHiddenSnifferBeforeLoadScript,
  buildHiddenSnifferAfterLoadScript,
  DIAGNOSE_SCRIPT,
  MANUAL_SNIFF_SCRIPT,
  EPISODE_LIST_SCRIPT,
  MEDIA_PLAYLIST_REGEX,
} from '../../scripts/browser/hiddenSnifferScripts';

// 移动端 Safari UA：站点对移动 UA 更宽松，且与用户手机浏览器行为一致
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 隐藏嗅探 WebView（1x1 透明，不可交互）
 *
 * 职责：
 *   1. 打开剧集播放页，自动过 cdndefend 挑战
 *   2. 拦截 /play/ → /channel/ 跳转（站点反 WebView 行为）
 *   3. 自动关闭「安装 APP」弹窗
 *   4. 被动嗅探 m3u8 播放列表地址并回调
 *   5. 抓取整部剧的选集列表并回调（用于「下一集」导航）
 *
 * @param {object}   props
 * @param {string}   props.url              要打开的剧集播放页 URL
 * @param {function} props.onMediaFound     (m3u8Url: string) => void  首次嗅探到播放列表时回调
 * @param {function} [props.onEpisodeList]  (episodes: Array) => void  抓到选集列表时回调
 * @param {function} [props.onLog]          (msg: string) => void      调试日志（可选）
 * @param {function} [props.onReady]        () => void                 页面就绪回调（可选）
 */
export default function HiddenSnifferWebView({
  url,
  mode = 'switch', // 'list' 只抓选集列表；'switch' 抓列表 + 嗅探 m3u8
  onMediaFound,
  onEpisodeList,
  onLog,
  onReady,
}) {
  const webViewRef = useRef(null);
  const foundRef = useRef(false);
  const episodeListRef = useRef(false);
  const jumpBlockedRef = useRef(false);
  const loadEndCountRef = useRef(0);
  const timersRef = useRef([]);
  // 🐞 iOS 选集抓取：记录空列表次数，用于「多次重试仍为空才放弃」
  const emptyListCountRef = useRef(0);
  // 🐞 iOS 选集抓取：记录已为哪一次 onLoadEnd 调度过抓取，避免重复调度
  const scheduledForLoadEndRef = useRef(0);

  const log = useCallback(
    (msg) => {
      if (onLog) onLog(msg);
    },
    [onLog]
  );

  const schedule = useCallback((fn, delay) => {
    const t = setTimeout(fn, delay);
    timersRef.current.push(t);
    return t;
  }, []);

  const handleMessage = useCallback(
    (event) => {
      let data;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch (_e) {
        return;
      }
      if (!data || !data.type) return;

      if (data.type === 'VIDEO_FOUND') {
        if (foundRef.current) return;
        if (!MEDIA_PLAYLIST_REGEX.test(data.url)) return;
        foundRef.current = true;
        log(`✅ 嗅探到播放列表: ${data.url}`);
        if (onMediaFound) onMediaFound(data.url);
      } else if (data.type === 'VIDEO_FOUND_LIST') {
        if (foundRef.current) return;
        const urls = Array.isArray(data.urls) ? data.urls : [];
        const hit = urls.find((u) => MEDIA_PLAYLIST_REGEX.test(u));
        if (hit) {
          foundRef.current = true;
          log(`✅ 兜底嗅探到播放列表: ${hit}`);
          if (onMediaFound) onMediaFound(hit);
        }
      } else if (data.type === 'EPISODE_LIST') {
        if (episodeListRef.current) return;
        const episodes = Array.isArray(data.episodes) ? data.episodes : [];
        if (episodes.length === 0) {
          // 🐞 修复「iOS 选集一直显示正在获取选集…」：
          //    iOS 的 WKWebView 首次 onLoadEnd 常落在重定向中间页 / about:blank，
          //    此时 location.pathname 不是 /play/xxx.html，脚本返回 not_play_page 空列表。
          //    此前空列表会立即回调 onEpisodeList([]) 并关闭隐藏 WebView，
          //    导致选集永远抓不到。这里改为「空列表不立即放弃」：
          //    记录空结果次数，继续等待后续重试（1.5s/5s/8s/12s）命中真实播放页。
          emptyListCountRef.current += 1;
          log(`📺 选集列表为空（第 ${emptyListCountRef.current} 次，可能页面未就绪）`);
          // 仅在多次重试仍为空、且已到最终兜底时机时才回调空列表，
          // 让上层关闭隐藏 WebView，避免常驻。
          if (mode === 'list' && emptyListCountRef.current >= 4 && onEpisodeList) {
            onEpisodeList([]);
          }
          return;
        }
        episodeListRef.current = true;
        log(`📺 抓到选集列表 ${episodes.length} 集`);
        if (onEpisodeList) onEpisodeList(episodes);
      } else if (data.type === 'POPUP_CLOSED') {
        log(`🚪 已关闭弹窗 ${data.count} 个`);
      } else if (data.type === 'DIAGNOSE') {
        log(`📋 video=${data.videoCount} iframe=${data.iframeCount} pool=${data.sniffedPool}`);
      } else if (data.type === 'DIAGNOSE_ERR') {
        log(`📋 诊断异常: ${data.msg}`);
      }
    },
    [log, mode, onMediaFound, onEpisodeList]
  );

  const handleLoadEnd = useCallback(
    (e) => {
      loadEndCountRef.current += 1;
      const currentUrl = e?.nativeEvent?.url || '';
      log(`onLoadEnd #${loadEndCountRef.current} ${String(currentUrl).slice(0, 70)}`);

      if (onReady) onReady();

      // 🐞 修复「iOS 选集一直显示正在获取选集…」：
      //    iOS 的 WKWebView 首次 onLoadEnd 常落在重定向中间页 / about:blank
      //    （站点有 cdndefend 挑战 + /play/ → /channel/ 跳转），
      //    此时 location.pathname 不是 /play/xxx.html，抓取脚本返回空列表。
      //    此前只在「第 1 次 onLoadEnd」调度抓取，一旦首次落在中间页就永远抓不到。
      //    改为：每次 onLoadEnd 都调度一轮抓取（用 scheduledForLoadEndRef 防重复），
      //    并增加 8s / 12s 重试，确保最终落在真实播放页时能抓到选集。
      if (scheduledForLoadEndRef.current === loadEndCountRef.current) return;
      scheduledForLoadEndRef.current = loadEndCountRef.current;

      // 📺 选集列表：页面 DOM 就绪后尽早抓（1.5s / 5s / 8s / 12s 多次，防容器延迟渲染）
      [1500, 5000, 8000, 12000].forEach((delay) => {
        schedule(() => {
          if (episodeListRef.current) return;
          webViewRef.current?.injectJavaScript(EPISODE_LIST_SCRIPT);
        }, delay);
      });

      // 兜底：8s 后诊断；15s 后手动嗅探（仅切集模式，列表模式无需嗅探 m3u8）
      schedule(() => {
        if (foundRef.current) return;
        webViewRef.current?.injectJavaScript(DIAGNOSE_SCRIPT);
      }, 8000);
      if (mode === 'switch') {
        schedule(() => {
          if (foundRef.current) return;
          log('⏱ 兜底手动嗅探');
          webViewRef.current?.injectJavaScript(MANUAL_SNIFF_SCRIPT);
        }, 15000);
      }
    },
    [log, mode, onReady, schedule]
  );

  const handleShouldStartLoad = useCallback(
    (req) => {
      const target = String(req.url || '');
      if (!/^https?:/i.test(target)) return false;

      // 🔬 拦截 /play/ → /channel/ 跳转（站点反 WebView 行为）
      if (/\/channel\//.test(target) && /\/play\//.test(String(url || ''))) {
        if (!jumpBlockedRef.current) {
          jumpBlockedRef.current = true;
          log('🛑 已拦截 /play/ → /channel/ 跳转');
        }
        return false;
      }
      return true;
    },
    [url, log]
  );

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        injectedJavaScriptBeforeContentLoaded={buildHiddenSnifferBeforeLoadScript()}
        injectedJavaScript={buildHiddenSnifferAfterLoadScript()}
        onMessage={handleMessage}
        onLoadEnd={handleLoadEnd}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        onError={(e) => log(`WebView onError: ${e?.nativeEvent?.description || ''}`)}
        setSupportMultipleWindows={false}
        userAgent={MOBILE_UA}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        muted
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    top: -100,
    left: -100,
    width: 1,
    height: 1,
    opacity: 0,
  },
  webview: { width: 1, height: 1 },
});
// --- END OF FILE src/components/cinema/HiddenSnifferWebView.js ---
