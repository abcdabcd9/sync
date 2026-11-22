// --- START OF FILE src/hooks/browser/useBrowserProgress.js ---
import { useState, useRef, useEffect, useCallback } from 'react';
import { Animated } from 'react-native';

/**
 * 📊 顶部加载进度条 Hook（阶段 5 抽离）
 *
 * 职责：
 *  1. 维护 progressAnim（0~1 宽度驱动）与 progressOpacity（淡出透明度）
 *  2. onLoadStart：进度归零、透明度复位
 *  3. onLoadProgress：按 nativeEvent.progress 平滑推进
 *  4. onLoadEnd：补满至 100% 后淡出，并触发外部 onFinish 回调
 *
 * ⚠️ 动画参数与原 browser.js 内联实现 100% 一致：
 *    - onLoadProgress: duration 180, useNativeDriver false
 *    - onLoadEnd 补满: duration 120, useNativeDriver false
 *    - onLoadEnd 淡出: duration 260, useNativeDriver true
 *    - progressWidth 插值: ['0%', '100%']
 */
export function useBrowserProgress({ onFinish } = {}) {
  const [progressAnim] = useState(() => new Animated.Value(0));
  const [progressOpacity] = useState(() => new Animated.Value(0));

  // 回调引用镜像：避免 onFinish 变化导致 handler 重建
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  // 🧹 卸载时停止动画，避免内存泄漏
  useEffect(
    () => () => {
      progressAnim.stopAnimation();
      progressOpacity.stopAnimation();
    },
    [progressAnim, progressOpacity]
  );

  const handleLoadStart = useCallback(() => {
    progressAnim.setValue(0);
    progressOpacity.setValue(1);
  }, [progressAnim, progressOpacity]);

  const handleLoadProgress = useCallback(
    ({ nativeEvent }) => {
      const p = typeof nativeEvent.progress === 'number' ? nativeEvent.progress : 0;
      progressOpacity.setValue(1);
      Animated.timing(progressAnim, {
        toValue: p,
        duration: 180,
        useNativeDriver: false,
      }).start();
    },
    [progressAnim, progressOpacity]
  );

  const handleLoadEnd = useCallback(
    (event) => {
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

      // 加载完成后的业务回调（广告清理注入 + 历史写入）
      if (onFinishRef.current) onFinishRef.current(event);
    },
    [progressAnim, progressOpacity]
  );

  // 📊 进度条宽度插值（0~1 → 0%~100%）
  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return {
    progressAnim,
    progressOpacity,
    progressWidth,
    handleLoadStart,
    handleLoadProgress,
    handleLoadEnd,
  };
}

export default useBrowserProgress;
// --- END OF FILE src/hooks/browser/useBrowserProgress.js ---
