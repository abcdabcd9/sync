// --- START OF FILE src/components/FloatingPlayer.js ---
import React, { useEffect, useRef, useState } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  Platform, 
  Animated,
  Pressable,
  PanResponder,
  Dimensions,
  DeviceEventEmitter 
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useRouter, usePathname } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCinema } from '../hooks/useCinema';
import { useAppTheme } from '../context/ThemeContext';

const SCREEN_WIDTH = Dimensions.get('window').width;
const DOCK_OFFSET = (SCREEN_WIDTH / 2) - 20;

export default function FloatingPlayer() {
  const { isDark, colors: palette } = useAppTheme();
  const router = useRouter();
  const pathname = usePathname(); 
  const insets = useSafeAreaInsets();
  
  const { currentUrl, closePlayer, isPlaying, togglePlay, isMinimized, setIsMinimized } = useCinema();
  
  const slideAnim = useRef(new Animated.Value(200)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const dockAnim = useRef(new Animated.Value(0)).current; 
  
  const [dockSide, setDockSide] = useState('none'); 
  const dockSideRef = useRef('none');

  // 🍎 核心修复：新增强制隐藏状态
  const [forceHide, setForceHide] = useState(false);

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('hideFloatingPlayer', (hide) => {
      setForceHide(hide);
    });
    return () => sub.remove();
  }, []);

  // 🍎 如果在影院页面，或者被全局广播强制隐藏，则下潜消失
  const isHidden = (pathname === '/cinema' && !isMinimized) || forceHide;

  useEffect(() => {
    if (isHidden) {
      Animated.timing(slideAnim, { 
        toValue: 200, 
        duration: 250, 
        useNativeDriver: true 
      }).start();
    } else if (currentUrl) {
      Animated.spring(slideAnim, { 
        toValue: 0, 
        friction: 8,
        tension: 50,
        useNativeDriver: true 
      }).start();
    }
  }, [isHidden, currentUrl]);

  const snapToDock = (side) => {
    dockSideRef.current = side;
    setDockSide(side);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.parallel([
      Animated.spring(panX, { 
        toValue: side === 'left' ? -DOCK_OFFSET : DOCK_OFFSET, 
        friction: 6, 
        tension: 45, 
        useNativeDriver: true 
      }),
      Animated.timing(dockAnim, { 
        toValue: 1, 
        duration: 180, 
        useNativeDriver: true 
      })
    ]).start();
  };

  const snapToCenter = () => {
    dockSideRef.current = 'none';
    setDockSide('none');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.parallel([
      Animated.spring(panX, { 
        toValue: 0, 
        friction: 6, 
        tension: 45, 
        useNativeDriver: true 
      }),
      Animated.timing(dockAnim, { 
        toValue: 0, 
        duration: 180, 
        useNativeDriver: true 
      })
    ]).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        return Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
      },
      onPanResponderMove: (evt, gestureState) => {
        let offset = 0;
        if (dockSideRef.current === 'left') offset = -DOCK_OFFSET;
        if (dockSideRef.current === 'right') offset = DOCK_OFFSET;
        panX.setValue(gestureState.dx + offset);
      },
      onPanResponderRelease: (evt, gestureState) => {
        const currentX = panX._value;
        if (currentX < -60) snapToDock('left');
        else if (currentX > 60) snapToDock('right');
        else snapToCenter();
      }
    })
  ).current;

  const handleMaximize = () => {
    if (dockSideRef.current !== 'none') return; 
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsMinimized(false);
    panX.setValue(0);
    dockAnim.setValue(0);
    dockSideRef.current = 'none';
    setDockSide('none');
    router.push('/cinema'); 
  };

  if (!currentUrl) return null;

  const safeBottom = Math.max(insets.bottom, Platform.OS === 'ios' ? 34 : 24);
  const dynamicBottom = safeBottom + 64 + 16;

  const mainOpacity = Platform.OS === 'ios' 
    ? dockAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })
    : dockAnim.interpolate({ inputRange: [0, 0.5, 0.51, 1], outputRange: [1, 1, 0, 0] });
    
  const arrowOpacity = Platform.OS === 'ios' 
    ? dockAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] })
    : dockAnim.interpolate({ inputRange: [0, 0.49, 0.5, 1], outputRange: [0, 0, 1, 1] });

  const mainScale = dockAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.6] });
  const arrowScale = dockAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  const mainContent = (
    <>
      <View style={[styles.iconBox, { backgroundColor: palette.primary }]}>
        <Ionicons name="film" size={20} color="#FFFFFF" />
      </View>
      <View style={styles.textWrapper}>
        <Text style={[styles.title, { color: palette.textPrimary }]} numberOfLines={1}>
          同步影院
        </Text>
        <Text style={[styles.subtitle, { color: palette.textSecondary }]}>
          正在同步播放
        </Text>
      </View>
      <Pressable style={styles.btn} onPress={() => { if(dockSideRef.current === 'none') togglePlay(); }}>
        <Ionicons name={isPlaying ? "pause-circle" : "play-circle"} size={32} color={palette.primary} />
      </Pressable>
      <Pressable style={styles.btn} onPress={() => { if(dockSideRef.current === 'none') closePlayer(); }}>
        <Ionicons name="close-circle" size={32} color={palette.textSecondary} />
      </Pressable>
    </>
  );

  const arrowContent = (
    <View style={styles.arrowIconBox}>
      <Ionicons 
        name={dockSide === 'left' ? 'chevron-forward' : 'chevron-back'} 
        size={24} 
        color={palette.textPrimary} 
      />
    </View>
  );

  return (
    <Animated.View 
      {...panResponder.panHandlers}
      style={[
        styles.container, 
        { 
          bottom: dynamicBottom, 
          transform: [
            { translateY: slideAnim },
            { translateX: panX }
          ] 
        }
      ]} 
      pointerEvents="box-none" 
    >
      <Animated.View 
        style={[
          styles.absoluteLayer, 
          { opacity: mainOpacity, transform: [{ scale: Animated.multiply(scaleAnim, mainScale) }] }
        ]}
        pointerEvents="box-none"
      >
        <Pressable 
          disabled={dockSide !== 'none'}
          onPressIn={() => Animated.spring(scaleAnim, { toValue: 0.94, useNativeDriver: true }).start() }
          onPressOut={() => Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true }).start() }
          onPress={handleMaximize}
        >
          {Platform.OS === 'ios' ? (
            <BlurView 
              intensity={90} 
              tint={isDark ? 'dark' : 'light'} 
              style={[styles.floatingCard, { borderColor: palette.cardBorder, borderWidth: 1, overflow: 'hidden' }]}
            >
              {mainContent}
            </BlurView>
          ) : (
            <View style={[styles.floatingCard, { backgroundColor: isDark ? '#2C2C2E' : '#FFFFFF' }]}>
              {mainContent}
            </View>
          )}
        </Pressable>
      </Animated.View>

      <Animated.View 
        style={[
          styles.absoluteLayer, 
          { opacity: arrowOpacity, transform: [{ scale: arrowScale }] }
        ]}
        pointerEvents="box-none"
      >
        <Pressable 
          disabled={dockSide === 'none'}
          onPress={snapToCenter} 
          style={styles.arrowClickArea}
        >
          {Platform.OS === 'ios' ? (
            <BlurView 
              intensity={90} 
              tint={isDark ? 'dark' : 'light'} 
              style={[styles.arrowPill, { borderColor: palette.cardBorder, borderWidth: 1, overflow: 'hidden' }]}
            >
              {arrowContent}
            </BlurView>
          ) : (
            <View style={[styles.arrowPill, { backgroundColor: isDark ? '#3A3A3C' : '#E5E5EA' }]}>
              {arrowContent}
            </View>
          )}
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 16, right: 16, zIndex: 999, height: 64, justifyContent: 'center', alignItems: 'center' },
  absoluteLayer: { position: 'absolute', width: '100%', justifyContent: 'center', alignItems: 'center' },
  floatingCard: { width: '100%', flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 16, elevation: 10 },
  iconBox: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  textWrapper: { flex: 1, marginLeft: 12 },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 12, marginTop: 2 },
  btn: { padding: 4, marginLeft: 8 },
  arrowClickArea: { padding: 10 },
  arrowPill: { width: 44, height: 54, borderRadius: 22, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 10, elevation: 8 },
  arrowIconBox: { justifyContent: 'center', alignItems: 'center' }
});
// --- END OF FILE src/components/FloatingPlayer.js ---