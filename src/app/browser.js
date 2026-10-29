// --- START OF FILE src/app/browser.js ---
import React, { useRef, useState, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, TextInput, Keyboard, Platform, LayoutAnimation, UIManager, Modal, FlatList, Alert, Animated, BackHandler, PanResponder } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppTheme } from '../context/ThemeContext';
import { useCinema } from '../hooks/useCinema';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

// 🔒 安全审计 #25：仅允许加密协议 https:// 与内部 about: 协议，彻底拒绝明文 http://
const SAFE_URL_PATTERN = /^(https:\/\/|about:)/i;
const isSafeUrl = (url) => typeof url === 'string' && SAFE_URL_PATTERN.test(url);

// 🎞️ 媒体扩展名识别（用于列表徽章）
const MEDIA_EXT_REGEX = /\.(m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(?:\?|#|$)/i;

// 🛡️ 第一重：广告 / 弹窗 / 赌博域名黑名单（网络级拦截）
//     ⚠️ 仅匹配主机名（hostname），绝不匹配 path / query，避免误杀正规视频 CDN 直链
const AD_DOMAIN_REGEX = /(popads|popcash|adsterra|juicyads|exoclick|doubleclick|adservice|googlesyndication|propellerads|bet365|casino|gambling|redirector)/i;

// 判断 URL 是否命中广告域名黑名单（解析失败时按字符串兜底匹配）
const isAdUrl = (url) => {
  if (typeof url !== 'string' || !url) return false;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    host = url;
  }
  return AD_DOMAIN_REGEX.test(host);
};

const getMediaExt = (url) => {
  if (typeof url !== 'string') return 'media';
  const m = url.match(MEDIA_EXT_REGEX);
  return m ? m[1].toLowerCase() : 'media';
};

const getDomain = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
};

// 中间省略的 URL 预览
const ellipsisMiddle = (url, head = 26, tail = 18) => {
  if (typeof url !== 'string') return '';
  if (url.length <= head + tail + 3) return url;
  return `${url.slice(0, head)}…${url.slice(-tail)}`;
};

// 统一构造列表项
const buildMediaItem = (url) => ({
  id: url,
  url,
  ext: getMediaExt(url),
  domain: getDomain(url),
});

// 合并去重（新项在前，保持稳定顺序）
const HISTORY_KEY = '@browser_history';
const HISTORY_LIMIT = 100;

// 🕒 历史记录时间格式化：10-29 14:30
const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const formatHistoryTime = (ts) => {
  const d = new Date(typeof ts === 'number' ? ts : Date.now());
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 🏷️ 历史记录标题：优先页面标题，其次域名，最后 URL 预览
const buildHistoryTitle = (title, url) => {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t) return t;
  const domain = getDomain(url);
  if (domain) return domain;
  return ellipsisMiddle(url, 30, 12);
};

const mergeMediaList = (prev, incoming) => {
  if (!Array.isArray(incoming) || incoming.length === 0) return prev;
  const seen = new Set(prev.map((it) => it.url));
  const added = [];
  incoming.forEach((raw) => {
    if (typeof raw !== 'string' || !raw) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    added.push(buildMediaItem(raw));
  });
  if (added.length === 0) return prev;
  return [...added, ...prev];
};

export default function BrowserScreen() {
  const { isDark, colors: palette } = useAppTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const { loadUrl, emitCommand } = useCinema();
  
  const startUrl = params.targetUrl || 'https://nnyy.in/'; 
  
  const webViewRef = useRef(null);
  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [inputUrl, setInputUrl] = useState(startUrl); 
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [sniffedMediaList, setSniffedMediaList] = useState([]);
  const [isSniffing, setIsSniffing] = useState(false);

  const [isDesktopMode, setIsDesktopMode] = useState(false);
  const [savedUrls, setSavedUrls] = useState([]);

  // 🛡️ 广告拦截开关（默认开启）与累计拦截计数
  const [isAdBlockEnabled, setIsAdBlockEnabled] = useState(true);
  const [blockedAdCount, setBlockedAdCount] = useState(0);
  // WebView 回调中读取最新开关状态（避免闭包过期）
  const isAdBlockEnabledRef = useRef(true);
  // 计数节流：避免批量弹窗时 setState 风暴
  const adCountBatchRef = useRef(0);
  const adCountTimerRef = useRef(null);

  useEffect(() => {
    isAdBlockEnabledRef.current = isAdBlockEnabled;
  }, [isAdBlockEnabled]);

  // 累加拦截计数（批量合并，200ms 内多次拦截只触发一次渲染）
  const bumpBlockedAdCount = (n = 1) => {
    adCountBatchRef.current += n;
    if (adCountTimerRef.current) return;
    adCountTimerRef.current = setTimeout(() => {
      const delta = adCountBatchRef.current;
      adCountBatchRef.current = 0;
      adCountTimerRef.current = null;
      if (delta > 0) setBlockedAdCount((prev) => prev + delta);
    }, 200);
  };

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnim] = useState(() => new Animated.Value(0));
  const [progressAnim] = useState(() => new Animated.Value(0));
  const [progressOpacity] = useState(() => new Animated.Value(0));

  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerAnim] = useState(() => new Animated.Value(0));
  // 📐 嗅探弹窗展开态：false = 半屏(50%)，true = 全屏(92%)
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const pickerExpandedRef = useRef(false);

  // 🕘 历史浏览记录
  const [historyList, setHistoryList] = useState([]);
  const [menuTab, setMenuTab] = useState('bookmark'); // 'bookmark' | 'history'

  // 🎚️ 嗅探弹窗格式筛选
  const [filterFormat, setFilterFormat] = useState('ALL'); // 'ALL' | 'MP4' | 'M3U8' | 'MOV'

  const actualLoadedUrl = useRef(startUrl);

  // ⏱️ 定时器句柄（卸载时统一清理，避免 setState on unmounted component）
  const sniffTimerRef = useRef(null);
  const submitTimerRef = useRef(null);
  const launchTimerRef = useRef(null);

  // 🔙 Android 返回键回调读取的最新 canGoBack（避免 effect 频繁重订阅）
  const canGoBackRef = useRef(canGoBack);

  useEffect(() => {
    canGoBackRef.current = canGoBack;
  }, [canGoBack]);

  // 🧹 组件卸载：清理全部定时器 + 停止动画
  useEffect(() => () => {
    if (sniffTimerRef.current) { clearTimeout(sniffTimerRef.current); sniffTimerRef.current = null; }
    if (submitTimerRef.current) { clearTimeout(submitTimerRef.current); submitTimerRef.current = null; }
    if (launchTimerRef.current) { clearTimeout(launchTimerRef.current); launchTimerRef.current = null; }
    if (adCountTimerRef.current) { clearTimeout(adCountTimerRef.current); adCountTimerRef.current = null; }
    menuAnim.stopAnimation();
    pickerAnim.stopAnimation();
    progressAnim.stopAnimation();
    progressOpacity.stopAnimation();
  }, [menuAnim, pickerAnim, progressAnim, progressOpacity]);

  const openMenu = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMenuVisible(true);
    Animated.timing(menuAnim, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  };

  const closeMenu = () => {
    Animated.timing(menuAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMenuVisible(false);
    });
  };

  useEffect(() => {
    const loadBookmarks = async () => {
      try {
        const cached = await AsyncStorage.getItem('@browser_bookmarks');
        if (cached !== null) {
          setSavedUrls(JSON.parse(cached));
        } else {
          const defaultBookmarks = ['https://nnyy.in/'];
          setSavedUrls(defaultBookmarks);
          await AsyncStorage.setItem('@browser_bookmarks', JSON.stringify(defaultBookmarks));
        }
      } catch (_) {}
    };
    loadBookmarks();
  }, []);

  // 🕘 启动时读取历史记录（容错：脏数据直接丢弃）
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const cached = await AsyncStorage.getItem(HISTORY_KEY);
        if (!cached) return;
        const parsed = JSON.parse(cached);
        if (!Array.isArray(parsed)) return;
        const cleaned = parsed
          .filter((it) => it && typeof it.url === 'string' && isSafeUrl(it.url))
          .slice(0, HISTORY_LIMIT);
        setHistoryList(cleaned);
      } catch (_) {}
    };
    loadHistory();
  }, []);

  // 🕘 写入历史：去重（同 URL 只保留最新一条）+ 上限 100 条
  const recordHistory = (url, title) => {
    if (!isSafeUrl(url)) return;
    if (url.includes('cn.bing.com/search')) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: buildHistoryTitle(title, url),
      timestamp: Date.now(),
    };
    setHistoryList((prev) => {
      if (prev.length > 0 && prev[0].url === url) return prev; // 同一页面重复回调，跳过
      const next = [entry, ...prev.filter((it) => it.url !== url)].slice(0, HISTORY_LIMIT);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const handleDeleteHistory = (id) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHistoryList((prev) => {
      const next = prev.filter((it) => it.id !== id);
      AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const handleClearHistory = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('清空历史记录', '确定要删除全部浏览历史吗？此操作不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          setHistoryList([]);
          AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
        },
      },
    ]);
  };

  // 🕘 点击历史记录：仅让 WebView 加载网页 + 关闭菜单。
  //    ⚠️ 严禁调用 handleLaunchCinema / emitCommand / useCinema.loadUrl，
  //       否则会把网页 URL 塞进影院播放器并唤起 FloatingPlayer 浮层。
  const handleLoadHistory = (url) => {
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该历史链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // 1️⃣ 关闭历史菜单（先播收起动画，动画结束再卸载 Modal）
    closeMenu();
    // 2️⃣ 仅更新 WebView 的 source，不触碰影院播放器
    setInputUrl(url);
    setCurrentUrl(url);
    actualLoadedUrl.current = url;
  };

  const runBeforeLoad = `
    // 🥇 最前端：捕获阶段点击抢占器（优先级高于网页自身广告脚本）
    (function() {
      if (window.__click_hijack_guard_installed) return;
      window.__click_hijack_guard_installed = true;

      // 保护名单：视频播放器及其内部元素绝不销毁
      var isProtected = function(el) {
        if (!el || !el.tagName) return true;
        var tag = el.tagName.toUpperCase();
        if (tag === 'VIDEO' || tag === 'SOURCE' || tag === 'AUDIO') return true;
        if (el.querySelector && el.querySelector('video, audio')) return true;
        if (el.closest && el.closest('video, audio')) return true;
        return false;
      };

      window.addEventListener('click', function(e) {
        var target = e.target;
        if (!target || !target.tagName) return;

        // 1️⃣ 强行把 target="_blank" 改为当前页打开，防止点击弹新窗口
        var anchor = target.closest ? target.closest('a') : null;
        if (anchor && anchor.getAttribute && anchor.getAttribute('target') === '_blank') {
          anchor.setAttribute('target', '_self');
          anchor.removeAttribute('rel');
        }

        // 2️⃣ 智能粉碎覆盖在页面或播放器上方的透明广告拦截层
        if (isProtected(target)) return;
        var style;
        try { style = window.getComputedStyle(target); } catch (err) { return; }
        if (!style) return;

        if (style.position === 'absolute' || style.position === 'fixed') {
          var z = parseInt(style.zIndex, 10);
          // 超高层级的非视频浮层：直接粉碎，并杀死广告点击事件
          if (!isNaN(z) && z >= 500) {
            try { target.remove(); } catch (err) {}
            e.stopImmediatePropagation();
            e.preventDefault();
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: 1, reason: 'click-hijack' }));
            } catch (err) {}
          }
        }
      }, true); // true = 捕获阶段，优先级高于网页内部脚本！

      // 3️⃣ 彻底冻结 window.open 弹窗
      try {
        window.open = function() { return null; };
        Object.defineProperty(window, 'open', {
          value: function() { return null; },
          writable: false,
          configurable: false
        });
      } catch (err) {}
    })();

    window.alert = function() { return null; };
    window.confirm = function() { return null; };

    // 🛡️ 第二重：JS 前置注入 —— 防弹窗 / 防跳转劫持
    (function() {
      if (window.__ad_guard_installed) return;
      window.__ad_guard_installed = true;

      var AD_HOST_REGEX = ${AD_DOMAIN_REGEX.toString()};
      var isAdUrl = function(url) {
        if (!url || typeof url !== 'string') return false;
        var host = '';
        try { host = new URL(url, window.location.href).hostname; } catch (e) { host = url; }
        return AD_HOST_REGEX.test(host);
      };

      // 1️⃣ 冻结 window.open：静默返回 null，绝不打开新窗口
      try {
        window.open = function() { return null; };
        Object.defineProperty(window, 'open', {
          value: function() { return null; },
          writable: false,
          configurable: false
        });
      } catch (e) {}

      // 2️⃣ 强力屏蔽 target="_blank"：全部改写为 _self，避免点击触发广告新标签页
      var neutralizeBlankTargets = function() {
        try {
          var links = document.querySelectorAll('a[target="_blank"], a[target=_blank], area[target="_blank"]');
          for (var i = 0; i < links.length; i++) {
            links[i].setAttribute('target', '_self');
            links[i].removeAttribute('rel');
          }
        } catch (e) {}
      };

      // 3️⃣ 防护跳转劫持：拦截非用户主动点击引发的定时器重定向
      //    仅在「无用户手势」时拦截，用户真实点击后的正常跳转不受影响
      var hadUserGesture = false;
      var markGesture = function() { hadUserGesture = true; };
      ['pointerdown', 'touchstart', 'mousedown', 'click', 'keydown'].forEach(function(evt) {
        window.addEventListener(evt, markGesture, { capture: true, passive: true });
      });

      var guardNavigation = function(originalFn, name) {
        return function() {
          var target = arguments[0];
          // 用户主动点击触发的跳转：放行
          if (hadUserGesture) return originalFn.apply(this, arguments);
          // 无用户手势：命中广告域名或任意跨域跳转一律拦截
          if (typeof target === 'string' && (isAdUrl(target) || !/^https?:/i.test(target))) {
            try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', reason: name })); } catch (e) {}
            return undefined;
          }
          return originalFn.apply(this, arguments);
        };
      };

      try {
        var origAssign = window.location.assign.bind(window.location);
        var origReplace = window.location.replace.bind(window.location);
        window.location.assign = guardNavigation(origAssign, 'location.assign');
        window.location.replace = guardNavigation(origReplace, 'location.replace');
      } catch (e) {}

      // 4️⃣ 拦截广告域名的 iframe / script 注入（DOM 级兜底）
      var stripAdNodes = function() {
        try {
          var nodes = document.querySelectorAll('iframe[src], script[src], img[src]');
          for (var i = 0; i < nodes.length; i++) {
            var src = nodes[i].getAttribute('src') || '';
            if (src && isAdUrl(src)) {
              try { nodes[i].remove(); } catch (e) {}
            }
          }
        } catch (e) {}
      };

      var runGuards = function() {
        neutralizeBlankTargets();
        stripAdNodes();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runGuards, { once: true });
      } else {
        runGuards();
      }
      window.addEventListener('load', runGuards, { once: true });

      // 5️⃣ MutationObserver：持续清理动态插入的 _blank 链接与广告节点
      try {
        var observer = new MutationObserver(function() { runGuards(); });
        var startObserve = function() {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
          }
        };
        if (document.body) startObserve();
        else document.addEventListener('DOMContentLoaded', startObserve, { once: true });
      } catch (e) {}
    })();
    
    (function() {
      if (window.__safe_sniffer_installed) return;
      window.__safe_sniffer_installed = true;

      window.__sniffed_urls = window.__sniffed_urls || new Set();

      var videoRegex = /\\.(m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(\\?.*)?$/i;
      
      var getAbsoluteUrl = function(url) {
        try { return new URL(url, window.location.href).href; } catch(e) { return url; }
      };
      
      var recordSilent = function(url) {
        if (!url || typeof url !== 'string') return;
        if (url.startsWith('blob:') || url.startsWith('data:')) return;
        
        if (videoRegex.test(url)) {
          window.__sniffed_urls.add(getAbsoluteUrl(url));
        }
      };

      var origOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(method, url) {
        recordSilent(url);
        return origOpen.apply(this, arguments);
      };

      var origFetch = window.fetch;
      window.fetch = function() {
        var arg = arguments[0];
        var url = '';
        if (typeof arg === 'string') url = arg;
        else if (arg && arg.url) url = arg.url;
        recordSilent(url);
        return origFetch.apply(this, arguments);
      };

      var origSrcDesc = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'src');
      if (origSrcDesc && origSrcDesc.set) {
        Object.defineProperty(window.HTMLMediaElement.prototype, 'src', {
          get: origSrcDesc.get,
          set: function(val) {
            recordSilent(val);
            return origSrcDesc.set.call(this, val);
          }
        });
      }
    })();

    ${isDesktopMode ? `
      (function() {
        // 🖥️ 深度伪装成 macOS 桌面浏览器：让站点 UA 嗅探 + 平台嗅探双重命中桌面版
        var spoof = function(target, prop, value) {
          try {
            Object.defineProperty(target, prop, { get: function() { return value; }, configurable: true });
          } catch (e) {}
        };
        spoof(navigator, 'platform', 'MacIntel');
        spoof(navigator, 'maxTouchPoints', 0);
        spoof(navigator, 'vendor', 'Apple Computer, Inc.');
        spoof(window, 'innerWidth', 1280);
        spoof(window, 'outerWidth', 1280);
        spoof(window, 'devicePixelRatio', 1);

        // 🛡️ 视口重写：document.head 可能尚未创建，需 DOMContentLoaded / documentElement 兜底
        var DESKTOP_VIEWPORT = 'width=1280, initial-scale=1.0, maximum-scale=2.0, user-scalable=yes';
        var applyViewport = function() {
          try {
            var root = document.head || document.documentElement;
            if (!root) return false;
            var meta = document.querySelector('meta[name="viewport"]');
            if (meta) {
              meta.setAttribute('content', DESKTOP_VIEWPORT);
            } else {
              meta = document.createElement('meta');
              meta.setAttribute('name', 'viewport');
              meta.setAttribute('content', DESKTOP_VIEWPORT);
              root.appendChild(meta);
            }
            return true;
          } catch (e) { return false; }
        };

        if (!applyViewport()) {
          document.addEventListener('DOMContentLoaded', applyViewport, { once: true });
          window.addEventListener('load', applyViewport, { once: true });
        }
      })();
    ` : ''}
    true;
  `;

  // 👁️ 实时 DOM 监视器：MutationObserver 秒级销毁动态插入的广告元素
  //    ⚠️ 安全红线：命中保护名单（video / audio / 含 video 的容器）一律跳过
  const adDomWatcherScript = `
    (function() {
      if (window.__ad_dom_watcher_installed) return;
      window.__ad_dom_watcher_installed = true;

      // 广告元素选择器（仅针对明确的广告特征，避免误伤）
      var AD_SELECTOR = [
        '[id*="pop"]',
        '[class*="ad-"]',
        'iframe[src*="ad"]',
        '[style*="z-index: 999"]',
        '[style*="z-index:999"]'
      ].join(',');

      var isProtected = function(el) {
        if (!el || !el.tagName) return true;
        var tag = el.tagName.toUpperCase();
        if (tag === 'VIDEO' || tag === 'SOURCE' || tag === 'AUDIO') return true;
        if (el.querySelector && el.querySelector('video, audio')) return true;
        if (el.closest && el.closest('video, audio')) return true;
        return false;
      };

      var destroyed = 0;

      var purge = function(root) {
        if (!root || !root.querySelectorAll) return;
        var nodes;
        try { nodes = root.querySelectorAll(AD_SELECTOR); } catch (e) { return; }
        for (var i = nodes.length - 1; i >= 0; i--) {
          var el = nodes[i];
          if (!el || !el.parentNode) continue;
          if (isProtected(el)) continue;
          try {
            el.remove();
            destroyed++;
          } catch (e) {}
        }
      };

      var flushCount = function() {
        if (destroyed <= 0) return;
        var n = destroyed;
        destroyed = 0;
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: n, reason: 'dom-watcher' }));
        } catch (e) {}
      };

      // 首次全量清理
      purge(document);

      // 节流：批量变更合并处理，避免频繁 DOM 操作拖慢页面
      var pending = false;
      var schedulePurge = function() {
        if (pending) return;
        pending = true;
        setTimeout(function() {
          pending = false;
          purge(document);
          flushCount();
        }, 300);
      };

      try {
        var observer = new MutationObserver(function(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            if (!added || added.length === 0) continue;
            schedulePurge();
            return;
          }
        });
        var start = function() {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
            schedulePurge();
          }
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
      } catch (e) {}
    })();
    true;
  `;

  // 🧹 第三重：DOM 样式级浮层广告与假播放按钮自动清理
  //    ⚠️ 安全红线：绝不删除 <video> / <source> / 播放器容器本身，
  //       仅移除「透明 + 超高 z-index + 覆盖在 video 之上」的拦截浮层
  const adCleanupScript = `
    (function() {
      if (window.__ad_cleanup_installed) return;
      window.__ad_cleanup_installed = true;

      var AD_HOST_REGEX = ${AD_DOMAIN_REGEX.toString()};
      var isAdUrl = function(url) {
        if (!url || typeof url !== 'string') return false;
        var host = '';
        try { host = new URL(url, window.location.href).hostname; } catch (e) { host = url; }
        return AD_HOST_REGEX.test(host);
      };

      // 1️⃣ 注入广告隐藏 CSS（仅隐藏，不删除，避免破坏页面布局）
      var AD_CSS = [
        '[id*="pop-ad"]', '[id*="popup-ad"]', '[id*="ad-banner"]', '[id*="adsbygoogle"]',
        '[class*="ad-banner"]', '[class*="ad-container"]', '[class*="adsbygoogle"]',
        '[class*="popup-ad"]', '[class*="ad-overlay"]', '[class*="ad-overlay"]',
        'iframe[src*="ad"]', 'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
        'ins.adsbygoogle', '.ad-float', '.ad-sticky', '.ad-popup', '.ad-modal',
        '[id^="ad_"]', '[id^="ads_"]', '[class^="ad_"]'
      ].join(',') + '{display:none !important;visibility:hidden !important;pointer-events:none !important;}';

      var injectCss = function() {
        try {
          if (document.getElementById('__ad_block_style__')) return;
          var style = document.createElement('style');
          style.id = '__ad_block_style__';
          style.type = 'text/css';
          style.appendChild(document.createTextNode(AD_CSS));
          (document.head || document.documentElement).appendChild(style);
        } catch (e) {}
      };

      // 2️⃣ 智能清除覆盖在 <video> 上方的透明点击拦截层
      var isTransparent = function(color) {
        if (!color) return true;
        var c = String(color).replace(/\\s+/g, '').toLowerCase();
        return c === 'transparent' || c === 'rgba(0,0,0,0)' || c === 'rgba(255,255,255,0)';
      };

      var removeClickHijackOverlays = function() {
        try {
          var videos = document.querySelectorAll('video');
          if (!videos.length) return;
          var removed = 0;
          for (var v = 0; v < videos.length; v++) {
            var video = videos[v];
            var vRect = video.getBoundingClientRect();
            if (vRect.width < 40 || vRect.height < 40) continue;

            // 只检查 video 的兄弟节点与父级子节点，范围可控，避免全页扫描误杀
            var scope = video.parentElement || document.body;
            if (!scope) continue;
            var candidates = scope.children;
            for (var i = candidates.length - 1; i >= 0; i--) {
              var el = candidates[i];
              if (!el || el === video) continue;
              if (el.tagName === 'VIDEO' || el.tagName === 'SOURCE') continue;
              // 保护播放器容器：包含 video 的祖先/兄弟容器一律跳过
              if (el.contains && el.contains(video)) continue;

              var cs;
              try { cs = window.getComputedStyle(el); } catch (e) { continue; }
              if (!cs) continue;
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;

              var zIndex = parseInt(cs.zIndex, 10);
              if (isNaN(zIndex) || zIndex < 9999) continue;

              var pos = cs.position;
              if (pos !== 'absolute' && pos !== 'fixed') continue;

              // 背景必须完全透明（含渐变透明）
              var bg = cs.backgroundColor;
              var bgImage = cs.backgroundImage || 'none';
              var bgTransparent = isTransparent(bg) && (bgImage === 'none' || /rgba\\([^)]*,\\s*0\\s*\\)/.test(bgImage));
              if (!bgTransparent) continue;

              // 必须与 video 区域重叠（覆盖在播放器上方）
              var r = el.getBoundingClientRect();
              if (r.width < 40 || r.height < 40) continue;
              var overlapX = Math.min(r.right, vRect.right) - Math.max(r.left, vRect.left);
              var overlapY = Math.min(r.bottom, vRect.bottom) - Math.max(r.top, vRect.top);
              if (overlapX <= 0 || overlapY <= 0) continue;
              var overlapArea = overlapX * overlapY;
              var videoArea = vRect.width * vRect.height;
              if (videoArea <= 0 || overlapArea / videoArea < 0.5) continue;

              // 命中：透明 + 超高 z-index + 覆盖播放器 → 移除
              try {
                el.style.setProperty('pointer-events', 'none', 'important');
                el.remove();
                removed++;
              } catch (e) {}
            }
          }
          if (removed > 0) {
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: removed, reason: 'overlay' }));
            } catch (e) {}
          }
        } catch (e) {}
      };

      // 3️⃣ 移除广告域名的 iframe / script（保留 video 与 source）
      var stripAdFrames = function() {
        try {
          var nodes = document.querySelectorAll('iframe[src], script[src]');
          var removed = 0;
          for (var i = 0; i < nodes.length; i++) {
            var src = nodes[i].getAttribute('src') || '';
            if (src && isAdUrl(src)) {
              try { nodes[i].remove(); removed++; } catch (e) {}
            }
          }
          if (removed > 0) {
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'AD_BLOCKED', count: removed, reason: 'frame' }));
            } catch (e) {}
          }
        } catch (e) {}
      };

      var runCleanup = function() {
        injectCss();
        stripAdFrames();
        removeClickHijackOverlays();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runCleanup, { once: true });
      } else {
        runCleanup();
      }
      window.addEventListener('load', runCleanup, { once: true });

      // 4️⃣ 动态内容持续清理（节流 800ms，避免性能损耗）
      var scheduled = false;
      var scheduleCleanup = function() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function() {
          scheduled = false;
          runCleanup();
        }, 800);
      };
      try {
        var observer = new MutationObserver(scheduleCleanup);
        var startObserve = function() {
          if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        };
        if (document.body) startObserve();
        else document.addEventListener('DOMContentLoaded', startObserve, { once: true });
      } catch (e) {}
    })();
    true;
  `;

  const manualSniffScript = `
    (function() {
      var MEDIA_REGEX = /\\.(m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(\\?.*)?$/i;
      var seen = {};
      var results = [];

      var getAbsUrl = function(url) {
        try { return new URL(url, window.location.href).href; } catch(e) { return url; }
      };

      // 收集（不再"找到第一个就停"），去重后统一回传
      var collect = function(src) {
        if (!src || typeof src !== 'string') return;
        if (src.startsWith('blob:') || src.startsWith('data:')) return;
        if (!/^https?:/i.test(src)) return;
        if (!MEDIA_REGEX.test(src)) return;
        var abs = getAbsUrl(src);
        if (seen[abs]) return;
        seen[abs] = true;
        results.push(abs);
      };

      // 1️⃣ 被动嗅探池（XHR / fetch / media.src 劫持所得）
      if (window.__sniffed_urls && window.__sniffed_urls.size > 0) {
        window.__sniffed_urls.forEach(function(url) { collect(url); });
      }

      // 2️⃣ DOM 中的 <video> / <source>
      var nodes = document.querySelectorAll('video, source');
      for (var i = 0; i < nodes.length; i++) {
        collect(nodes[i].src);
        collect(nodes[i].getAttribute('src'));
        collect(nodes[i].getAttribute('data-src'));
        collect(nodes[i].getAttribute('data-original'));
        var children = nodes[i].querySelectorAll ? nodes[i].querySelectorAll('source') : [];
        for (var j = 0; j < children.length; j++) {
          collect(children[j].src);
          collect(children[j].getAttribute('src'));
        }
      }

      // 3️⃣ 兜底：扫描 HTML 源码中的媒体直链
      try {
        var htmlContent = document.documentElement.innerHTML;
        var htmlRegex = /(https?:\\/\\/[^"'\\s<>]+?\\.(?:m3u8|mp4|flv|mkv|mov|ts|mpd|m4s|webm)(?:\\?[^"'\\s<>]*)?)/gi;
        var match;
        while ((match = htmlRegex.exec(htmlContent)) !== null) {
          collect(match[1]);
        }
      } catch (e) {}

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'VIDEO_FOUND_LIST',
        urls: results,
        found: results.length > 0
      }));
    })();
    true;
  `;

  const onMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      // 🛡️ 网页内拦截上报（覆盖层 / 广告 iframe / 跳转劫持）
      if (data.type === 'AD_BLOCKED') {
        const n = typeof data.count === 'number' && data.count > 0 ? data.count : 1;
        bumpBlockedAdCount(n);
        return;
      }

      // 单条命中（被动嗅探，保留旧协议兼容）
      if (data.type === 'VIDEO_FOUND' && data.url) {
        setIsSniffing(false);
        setSniffedMediaList((prev) => {
          const next = mergeMediaList(prev, [data.url]);
          if (next !== prev) {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          return next;
        });
        return;
      }

      // 多片源批量命中（手动扫描）
      if (data.type === 'VIDEO_FOUND_LIST') {
        setIsSniffing(false);
        const urls = Array.isArray(data.urls) ? data.urls.filter(Boolean) : [];
        if (urls.length === 0) {
          setSniffedMediaList((prev) => {
            if (prev.length === 0) {
              Alert.alert('嗅探反馈', '未发现真实的视频地址。\n\n💡 提示：如果网页中出现了视频，请先点击一下网页里的“播放”按钮缓冲一秒钟，然后再点底部扫描图标！');
            }
            return prev;
          });
          return;
        }
        setSniffedMediaList((prev) => {
          const next = mergeMediaList(prev, urls);
          if (next !== prev) {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          return next;
        });
        return;
      }

      // 旧版手动扫描完成信号（兼容）
      if (data.type === 'MANUAL_SNIFF_DONE') {
        setIsSniffing(false);
        if (!data.found) {
          setSniffedMediaList((prev) => {
            if (prev.length === 0) {
              Alert.alert('嗅探反馈', '未发现真实的视频地址。\n\n💡 提示：如果网页中出现了视频，请先点击一下网页里的“播放”按钮缓冲一秒钟，然后再点底部扫描图标！');
            }
            return prev;
          });
        }
      }
    } catch (_) {}
  };

  // 🔙 统一返回入口：网页内还有历史 → 先回退网页；已到首页 → 退出浏览器
  const handleGoBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
      return;
    }
    router.back();
  };

  const handleClose = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.back(); };

  // 📱 安卓系统返回键 / 全面屏返回手势拦截：
  //    网页内可回退时消费事件（阻止退出浏览器），否则放行给系统退出。
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const onHardwareBackPress = () => {
      // 通过 ref 读取最新 canGoBack，避免 effect 因状态变化反复解绑/重绑导致连按漏手势
      if (canGoBackRef.current && webViewRef.current) {
        webViewRef.current.goBack();
        return true; // 拦截：不退出浏览器
      }
      return false; // 放行：系统手势退出浏览器，回到 App 主界面
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBackPress);
    return () => subscription.remove();
  }, []);

  // 🍎 iOS 原生 Stack 右滑手势与 WKWebView 内部前进/后退手势解耦：
  //    网页内可回退时禁用原生 Stack 手势，避免抢占网页内部右滑；
  //    已到首页时恢复原生手势，允许右滑退出浏览器。
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    navigation.setOptions({ gestureEnabled: !canGoBack });
  }, [canGoBack, navigation]);
  
  const handleSubmitUrl = () => {
    Keyboard.dismiss();
    let target = inputUrl.trim();
    if (!target) return;

    // 🔒 安全审计 #25：明文 http:// 一律升级为 https://（必须先于直链视频判断，防止绕过安全层）
    if (/^http:\/\//i.test(target)) {
      target = target.replace(/^http:\/\//i, 'https://');
    }

    const isDirectVideo = /\.(mp4|m3u8)(\?.*)?$/i.test(target);
    if (isDirectVideo) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      loadUrl(target); emitCommand('PLAY', 0, target);
      if (Platform.OS === 'ios') {
        if (submitTimerRef.current) clearTimeout(submitTimerRef.current);
        submitTimerRef.current = setTimeout(() => {
          submitTimerRef.current = null;
          router.replace('/cinema');
        }, 150);
      } else {
        router.replace('/cinema');
      }
      return;
    }

    // 非 http(s) 输入走 Bing 搜索
    if (!/^https:\/\//i.test(target)) {
      target = 'https://cn.bing.com/search?q=' + encodeURIComponent(target);
    }
    setCurrentUrl(target);
    actualLoadedUrl.current = target;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  };

  // ▶ 启动影院：支持传入指定片源 URL（默认取列表首项）
  const handleLaunchCinema = (url) => {
    const target = typeof url === 'string' && url ? url : sniffedMediaList[0]?.url;
    if (!target) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    Keyboard.dismiss();
    closePicker();
    loadUrl(target);
    if (Platform.OS === 'ios') {
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
      launchTimerRef.current = setTimeout(() => {
        launchTimerRef.current = null;
        router.replace('/cinema');
      }, 150);
    } else {
      router.replace('/cinema');
    }
  };

  // 📋 复制片源链接
  const handleCopyMediaUrl = async (url) => {
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (_) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // 🧹 清空嗅探列表
  const handleClearSniffedMedia = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSniffedMediaList([]);
    closePicker();
  };

  // 🎬 打开 / 关闭多资源选择弹窗（默认半屏）
  //    允许空列表打开：扫描中/无结果时也要能看到菜单与空态提示
  const openPicker = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pickerExpandedRef.current = false;
    setPickerExpanded(false);
    setPickerVisible(true);
    Animated.timing(pickerAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  };

  const closePicker = () => {
    Animated.timing(pickerAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setPickerVisible(false);
        pickerExpandedRef.current = false;
        setPickerExpanded(false);
      }
    });
  };

  // 📐 展开 / 收起嗅探弹窗（半屏 50% ⇄ 全屏 92%）
  const setPickerExpandedState = (expanded) => {
    if (pickerExpandedRef.current === expanded) return;
    pickerExpandedRef.current = expanded;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPickerExpanded(expanded);
  };

  const togglePickerExpanded = () => setPickerExpandedState(!pickerExpandedRef.current);

  // 🖐️ 顶部拖拽条手势：上滑展开 / 全屏下滑收起 / 半屏下滑关闭
  //    PanResponder 实例只创建一次；回调内通过 ref 读取最新状态，避免闭包过期
  const [pickerPanResponder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dy < -50) {
          setPickerExpandedState(true);
        } else if (g.dy > 50) {
          if (pickerExpandedRef.current) {
            setPickerExpandedState(false);
          } else {
            closePicker();
          }
        }
      },
    })
  );

  // 🗑️ 移除单条嗅探源（卡片横滑触发）
  const handleRemoveSniffedMedia = (id) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSniffedMediaList((prev) => prev.filter((m) => m.id !== id));
  };

  const handleManualSniff = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setIsSniffing(true);
    if (webViewRef.current) webViewRef.current.injectJavaScript(manualSniffScript);
    if (sniffTimerRef.current) clearTimeout(sniffTimerRef.current);
    sniffTimerRef.current = setTimeout(() => {
      sniffTimerRef.current = null;
      setIsSniffing(false);
    }, 2000);
  };

  // 🔍 嗅探按钮：有源直接开菜单；无源先深度扫描，再打开菜单展示结果
  const handleSniffPress = () => {
    if (sniffedMediaList.length > 0) {
      openPicker();
      return;
    }
    handleManualSniff();
    openPicker();
  };

  const toggleDesktopMode = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const nextMode = !isDesktopMode;
    closeMenu();

    const targetUrl = actualLoadedUrl.current;
    let deskUrl = targetUrl;

    // 仅改写主机名部分（避免误伤 path / query 中的 "://m." 片段）
    if (nextMode) {
      deskUrl = targetUrl.replace(/^(https?:\/\/)(m|wap)\./i, '$1www.');
    } else {
      deskUrl = targetUrl.replace(/^(https?:\/\/)www\./i, '$1m.');
    }

    if (deskUrl !== targetUrl) {
      setCurrentUrl(deskUrl);
      setInputUrl(deskUrl);
      actualLoadedUrl.current = deskUrl;
    }

    setIsDesktopMode(nextMode);

    // 无 key 强挂载后，需主动重载页面让新的 UA / 注入脚本生效（保留历史栈）
    if (webViewRef.current) {
      if (deskUrl !== targetUrl) {
        webViewRef.current.injectJavaScript('window.location.replace(' + JSON.stringify(deskUrl) + '); true;');
      } else {
        webViewRef.current.reload();
      }
    }
  };

  const handleSaveBookmark = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const targetUrl = actualLoadedUrl.current;
    // 🔒 仅允许保存 https:// 安全链接（拒绝 http:// 与非法协议）
    if (!isSafeUrl(targetUrl)) {
      Alert.alert('无法收藏', '仅支持收藏 HTTPS 安全链接。');
      closeMenu();
      return;
    }

    if (savedUrls.includes(targetUrl)) { Alert.alert('提示', '该网址已在收藏夹中'); closeMenu(); return; }
    const newUrls = [targetUrl, ...savedUrls];
    setSavedUrls(newUrls);
    await AsyncStorage.setItem('@browser_bookmarks', JSON.stringify(newUrls));
    
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('收藏成功', '已添加到影院书签列表');
    closeMenu();
  };

  const handleDeleteBookmark = async (urlToDelete) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const newUrls = savedUrls.filter(url => url !== urlToDelete);
    setSavedUrls(newUrls);
    await AsyncStorage.setItem('@browser_bookmarks', JSON.stringify(newUrls));
  };

  const handleLoadBookmark = (url) => {
    // 🔒 加载前二次校验，防止历史遗留的不安全书签被打开
    if (!isSafeUrl(url)) {
      Alert.alert('链接不安全', '该收藏链接不是 HTTPS 安全地址，已阻止加载。');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInputUrl(url); setCurrentUrl(url); actualLoadedUrl.current = url;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    closeMenu();
  };

  const overlayOpacity = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const menuTranslateY = menuAnim.interpolate({ inputRange: [0, 1], outputRange: [400, 0] });

  // 📊 顶部加载进度条：progress(0~1) 驱动宽度，加载完成后淡出
  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  // 🛡️ 网络级拦截入口：安全协议校验 + 广告域名黑名单
  const handleShouldStartLoad = (req) => {
    const url = req && req.url;
    // 1️⃣ 安全协议校验（https / about）
    if (!isSafeUrl(url)) return false;
    // 2️⃣ 广告域名黑名单（仅开关开启时生效）
    if (isAdBlockEnabledRef.current && isAdUrl(url)) {
      bumpBlockedAdCount(1);
      return false;
    }
    return true;
  };

  // 🛡️ 切换广告拦截开关：关闭时立即移除已注入的隐藏样式，恢复页面原貌
  const toggleAdBlock = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const next = !isAdBlockEnabled;
    setIsAdBlockEnabled(next);
    isAdBlockEnabledRef.current = next;
    if (!next && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        (function() {
          try {
            var s = document.getElementById('__ad_block_style__');
            if (s && s.parentNode) s.parentNode.removeChild(s);
          } catch (e) {}
        })();
        true;
      `);
    }
  };

  const handleLoadStart = () => {
    progressAnim.setValue(0);
    progressOpacity.setValue(1);
  };

  const handleLoadProgress = ({ nativeEvent }) => {
    const p = typeof nativeEvent.progress === 'number' ? nativeEvent.progress : 0;
    progressOpacity.setValue(1);
    Animated.timing(progressAnim, {
      toValue: p,
      duration: 180,
      useNativeDriver: false,
    }).start();
  };

  const handleLoadEnd = ({ nativeEvent }) => {
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: 120,
      useNativeDriver: false,
    }).start(() => {
      Animated.timing(progressOpacity, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }).start();
    });

    // 🧹 页面加载完成后注入 DOM 级广告清理（开关开启时才执行）
    if (isAdBlockEnabledRef.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(adCleanupScript);
    }

    // 🕘 页面加载完成即写入历史（isSafeUrl 校验 + 去重 + 100 条上限）
    const loadedUrl = nativeEvent?.url || actualLoadedUrl.current;
    if (loadedUrl) recordHistory(loadedUrl, nativeEvent?.title);
  };

  // 🎚️ 嗅探弹窗筛选：计数 + 过滤列表
  const formatCounts = sniffedMediaList.reduce(
    (acc, item) => {
      const ext = (item.ext || '').toUpperCase();
      acc.ALL += 1;
      if (ext === 'MP4') acc.MP4 += 1;
      else if (ext === 'M3U8') acc.M3U8 += 1;
      else if (ext === 'MOV') acc.MOV += 1;
      return acc;
    },
    { ALL: 0, MP4: 0, M3U8: 0, MOV: 0 }
  );

  const filteredMediaList = filterFormat === 'ALL'
    ? sniffedMediaList
    : sniffedMediaList.filter((item) => (item.ext || '').toUpperCase() === filterFormat);

  const FILTER_OPTIONS = ['ALL', 'MP4', 'M3U8', 'MOV'];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]} edges={['top', 'bottom']}>
      <View style={[styles.navBar, { borderBottomColor: palette.separator }]}>
        <View style={[styles.urlInputContainer, { backgroundColor: palette.card, borderColor: palette.cardBorder }]}>
          <Ionicons name="search" size={16} color={palette.textSecondary} style={{ marginRight: 8 }} />
          <TextInput 
            style={[styles.urlInput, { color: palette.textPrimary }]} 
            value={inputUrl} 
            onChangeText={setInputUrl} 
            onSubmitEditing={handleSubmitUrl} 
            returnKeyType="go" 
            selectTextOnFocus 
            autoCapitalize="none" 
            placeholder="搜索在线电影或输入直链" 
            placeholderTextColor={palette.textSecondary} 
          />
        </View>
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose}><Text style={[styles.closeText, { color: palette.primary }]}>取消</Text></TouchableOpacity>
      </View>
      
      <View style={styles.webContainer}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.progressBarTrack,
            { opacity: progressOpacity, backgroundColor: palette.separator },
          ]}
        >
          <Animated.View style={[styles.progressBarFill, { width: progressWidth }]} />
        </Animated.View>
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          style={styles.webview}
          
          originWhitelist={['https://*', 'about:*']}
          javaScriptEnabled={true}
          setSupportMultipleWindows={false}
          
          contentMode={isDesktopMode ? 'desktop' : 'mobile'}
          allowsBackForwardNavigationGestures={true}
          injectedJavaScriptBeforeContentLoaded={runBeforeLoad}
          injectedJavaScript={adDomWatcherScript}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={handleShouldStartLoad}

          // 🔄 原生下拉刷新 + iOS 弹性滑动
          pullToRefreshEnabled={true}
          bounces={true}
          onNavigationStateChange={(navState) => {
            setCanGoBack(navState.canGoBack);
            setCanGoForward(navState.canGoForward);
            actualLoadedUrl.current = navState.url;
            if (isSafeUrl(navState.url) && navState.url !== inputUrl && !navState.url.includes('cn.bing.com')) {
              setInputUrl(navState.url);
            }
            // 🕘 单页应用（SPA）路由切换不会触发 onLoadEnd，这里兜底记录
            if (navState.url && !navState.loading) {
              recordHistory(navState.url, navState.title);
            }
          }}
          onLoadStart={handleLoadStart}
          onLoadProgress={handleLoadProgress}
          onLoadEnd={handleLoadEnd}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false} 
          
          scalesPageToFit={isDesktopMode}
          setBuiltInZoomControls={isDesktopMode}
          userAgent={isDesktopMode ? DESKTOP_USER_AGENT : MOBILE_USER_AGENT} 
        />
        
      </View>

      <View style={[styles.bottomBar, { backgroundColor: palette.background, borderTopColor: palette.separator }]}>
        <TouchableOpacity style={styles.bottomBtn} onPress={handleGoBack}><Ionicons name="chevron-back" size={26} color={canGoBack ? palette.primary : palette.textSecondary} /></TouchableOpacity>
        <TouchableOpacity style={styles.bottomBtn} onPress={() => webViewRef.current?.goForward()} disabled={!canGoForward}><Ionicons name="chevron-forward" size={26} color={canGoForward ? palette.primary : palette.separator} /></TouchableOpacity>
        
        <TouchableOpacity style={styles.bottomBtn} onPress={handleSniffPress}>
          <Ionicons name={isSniffing ? "scan" : "scan-outline"} size={24} color={isSniffing ? palette.primary : palette.success} />
          {sniffedMediaList.length > 0 && (
            <View style={styles.sniffBadge}>
              <Text style={styles.sniffBadgeText}>{sniffedMediaList.length}</Text>
            </View>
          )}
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.bottomBtn} onPress={openMenu}>
          <Ionicons name="menu" size={28} color={palette.textPrimary} />
        </TouchableOpacity>
      </View>

      <Modal visible={menuVisible} transparent animationType="none" onRequestClose={closeMenu}>
        <View style={styles.modalWrapper}>
          <Animated.View style={[styles.modalOverlay, { opacity: overlayOpacity }]} />
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closeMenu} activeOpacity={1} />
          
          <Animated.View style={[styles.menuContainer, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', transform: [{ translateY: menuTranslateY }] }]}>
            <View style={styles.menuDragHandle} />
            <Text style={[styles.menuSectionTitle, { color: palette.textSecondary }]}>浏览器选项</Text>
            
            <View style={styles.menuActionRow}>
              <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={toggleDesktopMode} activeOpacity={0.7}>
                <Ionicons name={isDesktopMode ? "phone-portrait" : "desktop"} size={24} color={palette.primary} />
                <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>{isDesktopMode ? '切回手机' : '电脑版'}</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={handleSaveBookmark} activeOpacity={0.7}>
                <Ionicons name="bookmark" size={24} color={palette.success} />
                <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>收藏本页</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.menuActionBtn, { backgroundColor: palette.background }]} onPress={() => { closeMenu(); webViewRef.current?.reload(); }} activeOpacity={0.7}>
                <Ionicons name="refresh" size={24} color={palette.textSecondary} />
                <Text style={[styles.menuActionText, { color: palette.textPrimary }]}>刷新</Text>
              </TouchableOpacity>
            </View>

            {/* 🛡️ 广告拦截开关 + 拦截计数 */}
            <TouchableOpacity
              style={[styles.adBlockRow, { backgroundColor: palette.background }]}
              onPress={toggleAdBlock}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isAdBlockEnabled ? 'shield-checkmark' : 'shield-outline'}
                size={22}
                color={isAdBlockEnabled ? palette.success : palette.textSecondary}
              />
              <View style={styles.adBlockTextGroup}>
                <Text style={[styles.adBlockTitle, { color: palette.textPrimary }]}>广告拦截</Text>
                <Text style={[styles.adBlockSubtitle, { color: palette.textSecondary }]}>
                  已拦截 {blockedAdCount} 个广告
                </Text>
              </View>
              <View
                style={[
                  styles.adBlockSwitch,
                  { backgroundColor: isAdBlockEnabled ? palette.success : palette.separator },
                ]}
              >
                <View
                  style={[
                    styles.adBlockSwitchKnob,
                    { transform: [{ translateX: isAdBlockEnabled ? 18 : 0 }] },
                  ]}
                />
              </View>
            </TouchableOpacity>

            {/* �️ 书签 / 历史 双 Tab */}
            <View style={[styles.menuTabBar, { backgroundColor: palette.background }]}>
              <TouchableOpacity
                style={[styles.menuTabBtn, menuTab === 'bookmark' && { backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }]}
                onPress={() => setMenuTab('bookmark')}
                activeOpacity={0.8}
              >
                <Text style={[styles.menuTabText, { color: menuTab === 'bookmark' ? palette.primary : palette.textSecondary }]}>
                  影院书签 ({savedUrls.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.menuTabBtn, menuTab === 'history' && { backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }]}
                onPress={() => setMenuTab('history')}
                activeOpacity={0.8}
              >
                <Text style={[styles.menuTabText, { color: menuTab === 'history' ? palette.primary : palette.textSecondary }]}>
                  历史记录 ({historyList.length})
                </Text>
              </TouchableOpacity>
            </View>

            {menuTab === 'bookmark' ? (
              <FlatList
                data={savedUrls}
                keyExtractor={(item) => item}
                style={styles.bookmarkList}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <Text style={[styles.listEmptyText, { color: palette.textSecondary }]}>暂无收藏的网址</Text>
                }
                renderItem={({ item }) => (
                  <View style={[styles.bookmarkItem, { borderBottomColor: palette.separator }]}>
                    <TouchableOpacity style={styles.bookmarkContent} onPress={() => handleLoadBookmark(item)}>
                      <Ionicons name="globe-outline" size={20} color={palette.textSecondary} style={{ marginRight: 12 }} />
                      <Text style={[styles.bookmarkText, { color: palette.textPrimary }]} numberOfLines={1}>{item}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.bookmarkDeleteBtn} onPress={() => handleDeleteBookmark(item)}>
                      <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                    </TouchableOpacity>
                  </View>
                )}
              />
            ) : (
              <View style={styles.historySection}>
                <View style={styles.historyToolbar}>
                  <Text style={[styles.historyCountText, { color: palette.textSecondary }]}>
                    最近 {historyList.length} 条记录
                  </Text>
                  <TouchableOpacity
                    style={styles.historyClearBtn}
                    onPress={handleClearHistory}
                    disabled={historyList.length === 0}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="trash-bin-outline" size={15} color={historyList.length === 0 ? palette.separator : '#FF3B30'} />
                    <Text style={[styles.historyClearText, { color: historyList.length === 0 ? palette.separator : '#FF3B30' }]}>
                      清空历史
                    </Text>
                  </TouchableOpacity>
                </View>

                <FlatList
                  data={historyList}
                  keyExtractor={(item) => item.id}
                  style={styles.bookmarkList}
                  showsVerticalScrollIndicator={false}
                  ListEmptyComponent={
                    <Text style={[styles.listEmptyText, { color: palette.textSecondary }]}>暂无浏览历史</Text>
                  }
                  renderItem={({ item }) => (
                    <View style={[styles.bookmarkItem, { borderBottomColor: palette.separator }]}>
                      <TouchableOpacity style={styles.historyContent} onPress={() => handleLoadHistory(item.url)} activeOpacity={0.7}>
                        <View style={styles.historyTextGroup}>
                          <Text style={[styles.historyTitle, { color: palette.textPrimary }]} numberOfLines={1}>
                            {item.title}
                          </Text>
                          <Text style={[styles.historyUrl, { color: palette.textSecondary }]} numberOfLines={1}>
                            {ellipsisMiddle(item.url, 28, 14)}
                          </Text>
                        </View>
                        <Text style={[styles.historyTime, { color: palette.textSecondary }]}>
                          {formatHistoryTime(item.timestamp)}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.bookmarkDeleteBtn} onPress={() => handleDeleteHistory(item.id)}>
                        <Ionicons name="close-circle-outline" size={20} color={palette.textSecondary} />
                      </TouchableOpacity>
                    </View>
                  )}
                />
              </View>
            )}
          </Animated.View>
        </View>
      </Modal>

      {/* 🎬 多视频源选择 Bottom Sheet */}
      <Modal visible={pickerVisible} transparent animationType="none" onRequestClose={closePicker}>
        <View style={styles.modalWrapper}>
          <Animated.View style={[styles.modalOverlay, { opacity: pickerAnim }]} />
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={closePicker} activeOpacity={1} />

          <Animated.View
            style={[
              styles.pickerContainer,
              {
                backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
                height: pickerExpanded ? '92%' : '50%',
                transform: [{
                  translateY: pickerAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }),
                }],
              },
            ]}
          >
            {/* 🖐️ 拖拽条：上滑展开 / 全屏下滑收起 / 半屏下滑关闭 */}
            <View style={styles.pickerDragZone} {...pickerPanResponder.panHandlers}>
              <View style={styles.menuDragHandle} />
            </View>

            <View style={styles.pickerHeader}>
              <Text style={[styles.pickerTitle, { color: palette.textPrimary }]} numberOfLines={1}>
                选择要播放的视频源 ({sniffedMediaList.length})
              </Text>
              <View style={styles.pickerHeaderActions}>
                <TouchableOpacity
                  style={styles.pickerHeaderBtn}
                  onPress={togglePickerExpanded}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name={pickerExpanded ? 'chevron-down' : 'chevron-up'}
                    size={20}
                    color={palette.primary}
                  />
                </TouchableOpacity>
                <TouchableOpacity style={styles.pickerHeaderBtn} onPress={handleClearSniffedMedia} activeOpacity={0.7}>
                  <Text style={[styles.pickerHeaderBtnText, { color: '#FF3B30' }]}>清空</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pickerHeaderBtn} onPress={closePicker} activeOpacity={0.7}>
                  <Text style={[styles.pickerHeaderBtnText, { color: palette.primary }]}>关闭</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* 🎚️ 格式筛选切片栏 */}
            <View style={styles.filterChipRow}>
              {FILTER_OPTIONS.map((opt) => {
                const active = filterFormat === opt;
                const label = opt === 'ALL' ? '全部' : opt;
                return (
                  <TouchableOpacity
                    key={opt}
                    style={[
                      styles.filterChip,
                      { borderColor: active ? '#FF2D55' : palette.cardBorder },
                      active && { backgroundColor: '#FF2D55' },
                    ]}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setFilterFormat(opt);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.filterChipText, { color: active ? '#FFFFFF' : palette.textSecondary }]}>
                      {label} ({formatCounts[opt]})
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <FlatList
              data={filteredMediaList}
              keyExtractor={(item) => item.id}
              style={styles.pickerList}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <Text style={[styles.pickerEmpty, { color: palette.textSecondary }]}>
                  {sniffedMediaList.length === 0
                    ? '暂无嗅探到的视频源'
                    : `未找到 ${filterFormat} 格式的视频源`}
                </Text>
              }
              renderItem={({ item }) => (
                <MediaCard
                  item={item}
                  palette={palette}
                  onPlay={() => handleLaunchCinema(item.url)}
                  onCopy={() => handleCopyMediaUrl(item.url)}
                  onRemove={() => handleRemoveSniffedMedia(item.id)}
                />
              )}
            />
          </Animated.View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

// 🎴 视频源卡片
function MediaCard({ item, palette, onPlay, onCopy, onRemove }) {
  return (
    <View
      style={[
        styles.mediaCard,
        {
          backgroundColor: palette.background,
          borderColor: palette.cardBorder,
        },
      ]}
    >
      <View style={styles.mediaCardTop}>
        <View style={[styles.mediaBadge, { backgroundColor: palette.primary }]}>
          <Text style={styles.mediaBadgeText}>.{item.ext}</Text>
        </View>
        <Text style={[styles.mediaDomain, { color: palette.textSecondary }]} numberOfLines={1}>
          {item.domain || '未知域名'}
        </Text>
      </View>

      <Text style={[styles.mediaUrl, { color: palette.textPrimary }]} numberOfLines={1}>
        {ellipsisMiddle(item.url)}
      </Text>

      <View style={styles.mediaCardActions}>
        <TouchableOpacity
          style={[styles.mediaActionBtn, { backgroundColor: palette.primary }]}
          onPress={onPlay}
          activeOpacity={0.8}
        >
          <Ionicons name="play" size={15} color="#FFFFFF" />
          <Text style={styles.mediaActionPrimaryText}>播放</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.mediaActionBtn, styles.mediaActionGhost, { borderColor: palette.cardBorder }]}
          onPress={onCopy}
          activeOpacity={0.8}
        >
          <Ionicons name="copy-outline" size={15} color={palette.textPrimary} />
          <Text style={[styles.mediaActionGhostText, { color: palette.textPrimary }]}>复制</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.mediaRemoveBtn}
          onPress={onRemove}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={16} color="#FF3B30" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, 
  navBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth }, 
  urlInputContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', height: 40, borderRadius: 10, paddingHorizontal: 12, borderWidth: 1 }, 
  urlInput: { flex: 1, fontSize: 16, height: '100%' }, 
  closeBtn: { marginLeft: 12, paddingVertical: 8 }, 
  closeText: { fontSize: 16, fontWeight: '500' }, 
  webContainer: { flex: 1, position: 'relative' },
  webview: { flex: 1, backgroundColor: 'transparent' },
  progressBarTrack: { position: 'absolute', top: 0, left: 0, right: 0, height: 2, zIndex: 20, overflow: 'hidden' },
  progressBarFill: { height: 2, backgroundColor: '#FF2D55' },
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 50, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
  bottomBtn: { padding: 8 },
  // 🔢 嗅探按钮角标（静默提示数量，不挡屏）
  sniffBadge: { position: 'absolute', top: 2, right: 0, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, backgroundColor: '#FF2D55', alignItems: 'center', justifyContent: 'center' },
  sniffBadgeText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
  
  modalWrapper: { flex: 1, justifyContent: 'flex-end' },
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.1)' },
  menuContainer: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 12, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 20 },
  menuDragHandle: { width: 40, height: 5, backgroundColor: 'rgba(150,150,150,0.3)', borderRadius: 3, alignSelf: 'center', marginBottom: 16 },
  menuSectionTitle: { fontSize: 13, fontWeight: '600', marginBottom: 12, marginLeft: 4 },
  menuActionRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, 
  menuActionBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16, borderRadius: 16 },
  menuActionText: { fontSize: 12, fontWeight: '500', marginTop: 8 },

  // 🛡️ 广告拦截开关行
  adBlockRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14 },
  adBlockTextGroup: { flex: 1, marginLeft: 10 },
  adBlockTitle: { fontSize: 14, fontWeight: '600' },
  adBlockSubtitle: { fontSize: 11, marginTop: 3 },
  adBlockSwitch: { width: 42, height: 24, borderRadius: 12, padding: 3, justifyContent: 'center' },
  adBlockSwitchKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF' },

  bookmarkList: { marginTop: 8, maxHeight: 250 },
  bookmarkItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  bookmarkContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  bookmarkText: { fontSize: 15, flex: 1 },
  bookmarkDeleteBtn: { padding: 8, marginLeft: 8 },
  listEmptyText: { fontSize: 14, textAlign: 'center', paddingVertical: 28 },

  // 🗂️ 书签 / 历史 双 Tab
  menuTabBar: { flexDirection: 'row', marginTop: 16, marginBottom: 4, padding: 4, borderRadius: 12 },
  menuTabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 9 },
  menuTabText: { fontSize: 13, fontWeight: '600' },

  // 🕘 历史记录
  historySection: { marginTop: 4 },
  historyToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  historyCountText: { fontSize: 12 },
  historyClearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6 },
  historyClearText: { fontSize: 12, fontWeight: '600' },
  historyContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  historyTextGroup: { flex: 1, marginRight: 10 },
  historyTitle: { fontSize: 14, fontWeight: '500' },
  historyUrl: { fontSize: 11, marginTop: 3 },
  historyTime: { fontSize: 11, fontVariant: ['tabular-nums'] },

  // 🎬 多视频源选择弹窗
  pickerContainer: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingBottom: Platform.OS === 'ios' ? 40 : 24, paddingTop: 12, maxHeight: '78%', shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 20 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  pickerTitle: { flex: 1, fontSize: 16, fontWeight: '700', marginRight: 8 },
  pickerHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pickerHeaderBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  pickerHeaderBtnText: { fontSize: 14, fontWeight: '600' },
  pickerList: { flexGrow: 0 },
  pickerEmpty: { fontSize: 14, textAlign: 'center', paddingVertical: 32 },

  // 🎚️ 格式筛选切片
  filterChipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1 },
  filterChipText: { fontSize: 12, fontWeight: '600' },
  mediaCard: { borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 10 },
  mediaCardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  mediaBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginRight: 8 },
  mediaBadgeText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3 },
  mediaDomain: { flex: 1, fontSize: 12 },
  mediaUrl: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 10 },
  mediaCardActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mediaActionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, gap: 5 },
  mediaActionPrimaryText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
  mediaActionGhost: { backgroundColor: 'transparent', borderWidth: 1 },
  mediaActionGhostText: { fontSize: 13, fontWeight: '600' },
  mediaRemoveBtn: { marginLeft: 'auto', padding: 6 },

  // 🖐️ 嗅探弹窗拖拽区
  pickerDragZone: { paddingTop: 4, paddingBottom: 4 }
});
// --- END OF FILE src/app/browser.js ---