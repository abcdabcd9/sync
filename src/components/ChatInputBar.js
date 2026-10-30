// --- START OF FILE src/components/ChatInputBar.js ---
import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { 
  View, Text, TextInput, TouchableOpacity, Animated, Keyboard, Platform, 
  StyleSheet, PanResponder, Dimensions, ScrollView, AppState, Pressable, ActivityIndicator
} from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioRecorderState } from 'expo-audio';
import { useAppTheme } from '../context/ThemeContext';

const AI_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'; 
const AI_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY;

const transcribeAudioToText = async (audioUri) => {
  try {
    if (!audioUri) return '未获取到录音文件，请重试。';
    
    let safeUri = audioUri;
    if (!safeUri.startsWith('file://')) {
      safeUri = 'file://' + safeUri;
    }

    const formData = new FormData();
    formData.append('file', {
      uri: safeUri,
      type: 'audio/m4a',
      name: 'voice.m4a'
    });
    formData.append('model', 'whisper-large-v3'); 
    formData.append('language', 'zh'); 

    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AI_API_KEY}` },
      body: formData,
    });

    if (!response.ok) return '云端识别失败，请检查 API Key 或网络。';
    const data = await response.json();
    return (data && data.text) ? data.text : '未能识别出文字，请手动输入...';
  } catch (error) {
    return '网络连接异常，请重试。';
  }
};

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SCREEN_WIDTH = Dimensions.get('window').width;
const PANEL_HEIGHT = 280; 
const isIOS = Platform.OS === 'ios';
const SEMI_CIRCLE_HEIGHT = isIOS ? 150 : 90; 
const PILLS_BOTTOM_OFFSET = isIOS ? 150 : 120; 
const BUBBLE_BOTTOM_OFFSET = isIOS ? 260 : 210; 
const TRIGGER_DY_THRESHOLD = isIOS ? -140 : -126; 

const VoiceWaveform = ({ recordState, palette, isDark, audioRecorder }) => {
  const recorderState = useAudioRecorderState(audioRecorder, 100);
  const micVolume = recorderState?.metering ?? -160;
  const isHardwareRecording = recorderState?.isRecording ?? false;
  const bars = Array.from({ length: 15 });
  
  return (
    <View style={styles.waveformContainer}>
      {bars.map((_, index) => {
        const anim = useRef(new Animated.Value(0.15)).current;
        const distanceToCenter = Math.abs(index - 7);
        const maxHeight = 1 - (distanceToCenter * 0.12); 

        useEffect(() => {
          if (isHardwareRecording && recordState === 'normal') {
            const isSpeaking = micVolume > -45; 
            if (isSpeaking) {
              const val = Math.random() * 0.6 + 0.3;
              Animated.timing(anim, { toValue: val * maxHeight, duration: 100, useNativeDriver: true }).start();
            } else {
              Animated.timing(anim, { toValue: 0.15, duration: 100, useNativeDriver: true }).start();
            }
          } else {
            Animated.spring(anim, { toValue: 0.15, friction: 7, tension: 60, useNativeDriver: true }).start();
          }
        }, [isHardwareRecording, recordState, micVolume]); 

        const mutedColor = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.25)';
        const barColor = recordState === 'normal' ? (palette.primary || '#0A84FF') : mutedColor;

        return <Animated.View key={index} style={[styles.waveBar, { backgroundColor: barColor, transform: [{ scaleY: anim }] }]} />;
      })}
    </View>
  );
};

const SYSTEM_EMOJIS = ['😀','😂','🥰','😎','😭','😡','🥺','🥳','🤔','🙌','👏','👍','🤝','❤️','🔥','✨','🎉','🎂','🎁','☕️','🍔','🍟','🍕','🚀','🌟','月','☀️','☁️','🌧','❄️','🐶','🐱','🐼','🐷','🙉','🌹','🍎','🍉','🚗','✈️','🏀','⚽️','🎮','🎧','📱','💡','💸','💣','💊','💯'];

const ChatInputBar = forwardRef(({ palette, isChatLoaded, onSendText, onStartRecord, onStopRecord, onCancelRecord, onPickMedia, onNudge, onStartCall, onPickLocation, audioRecorder, onPanelVisibilityChange }, ref) => {
  const insets = useSafeAreaInsets();
  const { isDark } = useAppTheme();
  const restingPadding = insets.bottom > 0 ? insets.bottom + 8 : 16; 
  const activePadding = 12;
  
  const overlayBg = isDark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.3)';
  const unifiedGlassBg = isDark ? 'rgba(30, 30, 30, 0.85)' : 'rgba(255, 255, 255, 0.9)';
  const unifiedGlassBorder = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.08)'; 
  const glassBaseText = isDark ? '#FFFFFF' : '#000000'; 
  const cancelRed = '#FF3B30'; 
  
  const [inputText, setInputText] = useState('');
  const [inputMode, setInputMode] = useState('text');
  
  const [isRecording, setIsRecording] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false); 
  const [recordState, setRecordState] = useState('normal'); 
  const recordStateRef = useRef('normal'); 
  const [transcribedText, setTranscribedText] = useState('');
  const [isTranscribing, setIsTranscribing] = useState(false);

  const cancelPillRef = useRef(null);
  const toTextPillRef = useRef(null);
  const uiZonesRef = useRef({ cancel: null, toText: null });
  const [activePanel, setActivePanel] = useState('none');
  const activePanelRef = useRef('none');
  
  const bottomPaddingAnim = useRef(new Animated.Value(restingPadding)).current;
  const editKeyboardOffsetAnim = useRef(new Animated.Value(0)).current;
  const cancelScaleAnim = useRef(new Animated.Value(1)).current;
  const textScaleAnim = useRef(new Animated.Value(1)).current;

  const callbacksRef = useRef({ onStartRecord, onStopRecord, onCancelRecord });
  useEffect(() => { callbacksRef.current = { onStartRecord, onStopRecord, onCancelRecord }; });

  const measureActionZones = () => {
    setTimeout(() => {
      cancelPillRef.current?.measure((x, y, w, h, px, py) => { if (py > 0) uiZonesRef.current.cancel = { left: px, right: px + w, bottom: py + h }; });
      toTextPillRef.current?.measure((x, y, w, h, px, py) => { if (py > 0) uiZonesRef.current.toText = { left: px, right: px + w, bottom: py + h }; });
    }, 100);
  };

  useImperativeHandle(ref, () => ({ closePanels: () => { if (activePanelRef.current !== 'none') closeAll(); } }));

  const updateRecordState = (newState) => {
    if (recordStateRef.current !== newState) {
      recordStateRef.current = newState;
      setRecordState(newState);
      if (newState === 'cancelling') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        Animated.spring(cancelScaleAnim, { toValue: 1.15, friction: 6, tension: 50, useNativeDriver: true }).start();
        Animated.spring(textScaleAnim, { toValue: 0.9, friction: 6, tension: 50, useNativeDriver: true }).start();
      } else if (newState === 'toText') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        Animated.spring(textScaleAnim, { toValue: 1.15, friction: 6, tension: 50, useNativeDriver: true }).start();
        Animated.spring(cancelScaleAnim, { toValue: 0.9, friction: 6, tension: 50, useNativeDriver: true }).start();
      } else if (newState === 'normal') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        Animated.spring(cancelScaleAnim, { toValue: 1, friction: 6, tension: 50, useNativeDriver: true }).start();
        Animated.spring(textScaleAnim, { toValue: 1, friction: 6, tension: 50, useNativeDriver: true }).start();
      }
    }
  };

  useEffect(() => { activePanelRef.current = activePanel; }, [activePanel]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState.match(/inactive|background/) && overlayVisible) {
        setOverlayVisible(false); setIsRecording(false); updateRecordState('normal'); callbacksRef.current.onCancelRecord(); 
      }
    });
    return () => subscription.remove();
  }, [overlayVisible]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const keyboardShowListener = Keyboard.addListener(showEvent, (e) => {
      const kbHeight = e.endCoordinates.height;
      const baseBottomOffset = insets.bottom + BUBBLE_BOTTOM_OFFSET - 80;
      let overlap = kbHeight - baseBottomOffset + 20; 
      let shift = overlap > 0 ? -overlap : 0; 
      if (Platform.OS === 'ios' && shift < 0) shift = shift - 35;

      Animated.spring(editKeyboardOffsetAnim, { toValue: shift, friction: 8, tension: 60, useNativeDriver: true }).start();

      if (recordStateRef.current !== 'editingText') {
        activePanelRef.current = 'none'; setActivePanel('none'); 
        if(onPanelVisibilityChange) onPanelVisibilityChange(false);
        Animated.spring(bottomPaddingAnim, { toValue: activePadding + kbHeight, damping: 26, stiffness: 260, mass: 1, overshootClamping: true, useNativeDriver: false }).start();
      }
    });

    const keyboardHideListener = Keyboard.addListener(hideEvent, () => {
      Animated.spring(editKeyboardOffsetAnim, { toValue: 0, friction: 8, tension: 60, useNativeDriver: true }).start();
      if (activePanelRef.current === 'none' && recordStateRef.current !== 'editingText') {
        Animated.spring(bottomPaddingAnim, { toValue: restingPadding, damping: 26, stiffness: 260, mass: 1, overshootClamping: true, useNativeDriver: false }).start();
      }
    });
    return () => { keyboardShowListener.remove(); keyboardHideListener.remove(); };
  }, [bottomPaddingAnim, restingPadding, insets.bottom, editKeyboardOffsetAnim, onPanelVisibilityChange]);

  const closeAll = () => {
    activePanelRef.current = 'none'; setActivePanel('none'); Keyboard.dismiss();
    if(onPanelVisibilityChange) onPanelVisibilityChange(false);
    Animated.spring(bottomPaddingAnim, { toValue: restingPadding, damping: 26, stiffness: 260, mass: 1, overshootClamping: true, useNativeDriver: false }).start();
  };

  const togglePanel = (panelType) => {
    if (activePanel === panelType) { closeAll(); } else {
      activePanelRef.current = panelType; setActivePanel(panelType); Keyboard.dismiss();
      if(onPanelVisibilityChange) onPanelVisibilityChange(true);
      Animated.spring(bottomPaddingAnim, { toValue: PANEL_HEIGHT, damping: 26, stiffness: 260, mass: 1, overshootClamping: true, useNativeDriver: false }).start();
    }
  };

  const handleSend = () => { if (!inputText.trim()) return; onSendText(inputText.trim()); setInputText(''); };
  const handleSendEditedText = () => { if (transcribedText.trim()) onSendText(transcribedText.trim()); setOverlayVisible(false); updateRecordState('normal'); };
  const handleCancelEditedText = () => { setOverlayVisible(false); updateRecordState('normal'); };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        if (activePanelRef.current !== 'none') {
          activePanelRef.current = 'none'; setActivePanel('none'); if(onPanelVisibilityChange) onPanelVisibilityChange(false);
          Keyboard.dismiss(); Animated.spring(bottomPaddingAnim, { toValue: restingPadding, damping: 26, stiffness: 260, mass: 1, overshootClamping: true, useNativeDriver: false }).start();
        }
        setOverlayVisible(true); setIsRecording(true); updateRecordState('normal'); callbacksRef.current.onStartRecord(); 
      },
      onPanResponderMove: (evt, gestureState) => {
        const { moveX, moveY, dy } = gestureState;
        const zones = uiZonesRef.current;
        if (zones.cancel && zones.toText && moveY > 0) {
          const hitThreshold = Math.max(zones.cancel.bottom, zones.toText.bottom);
          if (moveY <= hitThreshold) {
            if (moveX < zones.cancel.right + 30) updateRecordState('cancelling');
            else if (moveX > zones.toText.left - 30) updateRecordState('toText');
            else updateRecordState('normal');
          } else { updateRecordState('normal'); }
        } else {
          if (dy < TRIGGER_DY_THRESHOLD) {
            if (moveX < SCREEN_WIDTH * 0.45) updateRecordState('cancelling');
            else if (moveX > SCREEN_WIDTH * 0.55) updateRecordState('toText');
            else updateRecordState('normal');
          } else { updateRecordState('normal'); }
        }
      },
      onPanResponderRelease: () => {
        setIsRecording(false);
        const finalState = recordStateRef.current;
        if (finalState === 'cancelling') {
          setOverlayVisible(false); callbacksRef.current.onCancelRecord(); updateRecordState('normal');
        } else if (finalState === 'toText') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          try { audioRecorder.stop(); } catch(e){} 
          const audioUri = audioRecorder.uri;
          updateRecordState('editingText'); setIsTranscribing(true); setTranscribedText('');
          if (audioUri) {
            transcribeAudioToText(audioUri).then((text) => {
              if (recordStateRef.current === 'editingText') { setTranscribedText(text); setIsTranscribing(false); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }
            });
          } else { setIsTranscribing(false); setTranscribedText('未获取到录音文件，请重试。'); }
        } else { 
          setOverlayVisible(false); callbacksRef.current.onStopRecord(); updateRecordState('normal');
        } 
      },
      onPanResponderTerminate: () => { setIsRecording(false); setOverlayVisible(false); callbacksRef.current.onCancelRecord(); updateRecordState('normal'); }
    })
  ).current;

  const allActionItems = [
    { id: 'photo', icon: 'image', label: '媒体库', action: () => { onPickMedia(); closeAll(); } },
    { id: 'videoCall', icon: 'videocam', label: '视频通话', action: () => { if(onStartCall) onStartCall('video'); closeAll(); } },
    { id: 'audioCall', icon: 'call', label: '语音通话', action: () => { if(onStartCall) onStartCall('audio'); closeAll(); } },
    { id: 'location', icon: 'location', label: '位置', action: () => { if (onPickLocation) onPickLocation(); closeAll(); } },
  ];

  return (
    <>
      <Animated.View style={[styles.inputContainer, { backgroundColor: palette.background, borderTopColor: palette.chatBorder, paddingBottom: bottomPaddingAnim }]}>
        <View style={styles.inputBarRow}>
          <TouchableOpacity style={styles.iconButton} activeOpacity={0.6} onPress={() => { setInputMode(prev => prev === 'text' ? 'voice' : 'text'); if (inputMode === 'voice') Keyboard.dismiss(); }}>
            {inputMode === 'text' ? (
              <View style={[styles.wechatCustomCircle, { borderColor: palette.textPrimary }]}>
                <MaterialIcons name="wifi" size={17} color={palette.textPrimary} style={styles.wechatVoiceIconCorrected} />
              </View>
            ) : (
              <View style={[styles.wechatCustomCircle, { borderColor: palette.textPrimary }]}><Ionicons name="keypad" size={16} color={palette.textPrimary} /></View>
            )}
          </TouchableOpacity>

          {inputMode === 'text' ? (
            <TextInput style={[styles.wechatInput, { backgroundColor: palette.card, color: palette.textPrimary }]} placeholder="发送消息..." placeholderTextColor={palette.textSecondary} value={inputText} onChangeText={setInputText} multiline maxLength={500} onFocus={() => { activePanelRef.current = 'none'; setActivePanel('none'); if(onPanelVisibilityChange) onPanelVisibilityChange(false); }} />
          ) : (
            <View style={[styles.wechatInput, styles.voiceRecordButton, { backgroundColor: isRecording ? palette.separator : palette.card }]} {...panResponder.panHandlers}>
              <Text style={[styles.voiceRecordText, { color: palette.textPrimary }]}>{isRecording ? '松开 发送' : '按住 说话'}</Text>
            </View>
          )}
          
          {inputText.trim() && inputMode === 'text' ? (
            <TouchableOpacity style={[styles.sendButton, { backgroundColor: isChatLoaded ? palette.primary : palette.separator }]} onPress={handleSend} disabled={!isChatLoaded} activeOpacity={0.7}>
              <Ionicons name="arrow-up" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          ) : (
            <View style={styles.rightIconsGroup}>
              <TouchableOpacity style={styles.iconButton} onPress={() => togglePanel('emoji')} activeOpacity={0.6}><Ionicons name={activePanel === 'emoji' ? "happy" : "happy-outline"} size={28} color={activePanel === 'emoji' ? palette.primary : palette.textPrimary} /></TouchableOpacity>
              <TouchableOpacity style={[styles.iconButton, styles.plusIconSpacing]} onPress={() => togglePanel('action')} activeOpacity={0.6}><Ionicons name={activePanel === 'action' ? "add-circle" : "add-circle-outline"} size={28} color={activePanel === 'action' ? palette.primary : palette.textPrimary} /></TouchableOpacity>
            </View>
          )}
        </View>

        {activePanel === 'action' && (
          <View style={[styles.panelContainer, { backgroundColor: palette.background, height: PANEL_HEIGHT + insets.bottom, bottom: -insets.bottom }]}>
            <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}>
              <View style={styles.actionPage}>
                {allActionItems.map((item) => (
                  <TouchableOpacity key={item.id} style={styles.actionItem} onPress={item.action} activeOpacity={0.7}>
                    <View style={[styles.actionIconBox, { backgroundColor: palette.card }]}><Ionicons name={item.icon} size={30} color={palette.textPrimary} /></View>
                    <Text style={[styles.actionText, { color: palette.textSecondary }]}>{item.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        )}

        {activePanel === 'emoji' && (
          <View style={[styles.panelContainer, { backgroundColor: palette.background, paddingTop: 0, height: PANEL_HEIGHT + insets.bottom, bottom: -insets.bottom }]}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.verticalScrollContainer, { paddingBottom: insets.bottom + 20 }]}>
               <View style={styles.emojiVerticalGrid}>
                 {SYSTEM_EMOJIS.map((emoji, index) => (
                   <TouchableOpacity key={index} style={styles.emojiItemVertical} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setInputText(prev => prev + emoji); }} activeOpacity={0.5}><Text style={styles.emojiText}>{emoji}</Text></TouchableOpacity>
                 ))}
               </View>
            </ScrollView>
          </View>
        )}
      </Animated.View>

      {overlayVisible && (
        <View style={[styles.overlayContainer, { backgroundColor: overlayBg, position: 'absolute', bottom: -insets.bottom, left: 0, right: 0, height: SCREEN_HEIGHT + insets.bottom, zIndex: 9999 }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => { if(recordState==='editingText') Keyboard.dismiss(); }} />

          {recordState === 'editingText' ? (
            <Animated.View style={[styles.editModeWrapper, { bottom: insets.bottom + BUBBLE_BOTTOM_OFFSET - 80, transform: [{ translateY: editKeyboardOffsetAnim }] }]} pointerEvents="box-none">
              <View style={[styles.editTextBox, { backgroundColor: unifiedGlassBg, borderColor: unifiedGlassBorder }]}>
                {isTranscribing ? (
                  <View style={styles.transcribingCenter}><ActivityIndicator size="small" color={palette.primary} style={{ marginBottom: 12 }} /><Text style={{ color: palette.textSecondary, fontSize: 15 }}>AI 正在转换文字...</Text></View>
                ) : (
                  <TextInput style={[styles.editTextInput, { color: glassBaseText }]} value={transcribedText} onChangeText={setTranscribedText} multiline autoFocus={false} placeholder="识别为空，请手动输入..." placeholderTextColor={palette.textSecondary} />
                )}
              </View>
              <View style={styles.editActionsRow}>
                <TouchableOpacity style={[styles.editActionBtn, { backgroundColor: palette.card, borderWidth: 1, borderColor: palette.cardBorder }]} onPress={handleCancelEditedText}><Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 16 }}>取消</Text></TouchableOpacity>
                <View style={{ width: 16 }} />
                <TouchableOpacity style={[styles.editActionBtn, { backgroundColor: palette.primary }]} onPress={handleSendEditedText}><Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 16 }}>完成并发送</Text></TouchableOpacity>
              </View>
            </Animated.View>
          ) : (
            <>
              <View style={[styles.bubbleWrapper, { bottom: insets.bottom + BUBBLE_BOTTOM_OFFSET }]} pointerEvents="none">
                <View style={[styles.recordBubble, { backgroundColor: unifiedGlassBg, borderColor: unifiedGlassBorder }]}>
                  {recordState === 'cancelling' ? (
                    <Text style={[styles.bubbleFeedbackText, { color: cancelRed }]}>松开手指，取消发送</Text>
                  ) : recordState === 'toText' ? (
                    <View style={{ alignItems: 'center' }}><Ionicons name="text" size={24} color={palette.primary} style={{ marginBottom: 4 }} /><Text style={[styles.bubbleFeedbackText, { color: palette.primary, fontSize: 15 }]}>继续说话，松开智能识别</Text></View>
                  ) : (
                    <VoiceWaveform recordState={recordState} palette={palette} isDark={isDark} audioRecorder={audioRecorder} />
                  )}
                </View>
              </View>

              <View style={[styles.actionPillsRow, { bottom: insets.bottom + PILLS_BOTTOM_OFFSET }]} onLayout={measureActionZones} pointerEvents="none">
                <Animated.View style={[styles.pillLeftWrapper, { transform: [{ scale: cancelScaleAnim }, { rotate: '-12deg' }] }]}>
                  <View ref={cancelPillRef} style={[styles.actionPill, { backgroundColor: recordState === 'cancelling' ? cancelRed : unifiedGlassBg, borderColor: recordState === 'cancelling' ? cancelRed : unifiedGlassBorder }]}>
                    <Ionicons name="close" size={20} color={recordState === 'cancelling' ? '#FFFFFF' : glassBaseText} style={styles.pillIcon} /><Text style={[styles.pillText, { color: recordState === 'cancelling' ? '#FFFFFF' : glassBaseText }]}>取消</Text>
                  </View>
                </Animated.View>

                <Animated.View style={[styles.pillRightWrapper, { transform: [{ scale: textScaleAnim }, { rotate: '12deg' }] }]}>
                  <View ref={toTextPillRef} style={[styles.actionPill, { backgroundColor: recordState === 'toText' ? palette.primary : unifiedGlassBg, borderColor: recordState === 'toText' ? palette.primary : unifiedGlassBorder }]}>
                    <Ionicons name="text" size={20} color={recordState === 'toText' ? '#FFFFFF' : glassBaseText} style={styles.pillIcon} /><Text style={[styles.pillText, { color: recordState === 'toText' ? '#FFFFFF' : glassBaseText }]}>转文字</Text>
                  </View>
                </Animated.View>
              </View>

              <View style={[styles.bottomSemiCircle, { height: SEMI_CIRCLE_HEIGHT, borderTopLeftRadius: isIOS ? SEMI_CIRCLE_HEIGHT * 0.6 : SEMI_CIRCLE_HEIGHT * 0.8, borderTopRightRadius: isIOS ? SEMI_CIRCLE_HEIGHT * 0.6 : SEMI_CIRCLE_HEIGHT * 0.8, backgroundColor: isDark ? 'rgba(30, 30, 32, 0.98)' : 'rgba(250, 250, 250, 0.98)', paddingBottom: insets.bottom + (isIOS ? 10 : 0) }]} pointerEvents="none">
                <Text style={[styles.arcText, { color: isDark ? 'rgba(235,235,245,0.7)' : 'rgba(60,60,67,0.7)' }]}>{recordState === 'cancelling' ? '松开取消' : recordState === 'toText' ? '松开识别文字' : '向上滑动'}</Text>
              </View>
            </>
          )}
        </View>
      )}
    </>
  );
}); 
export default ChatInputBar;

const styles = StyleSheet.create({
  inputContainer: { paddingHorizontal: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth }, 
  inputBarRow: { flexDirection: 'row', alignItems: 'center' }, iconButton: { padding: 4, justifyContent: 'center', alignItems: 'center' }, wechatCustomCircle: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, justifyContent: 'center', alignItems: 'center' }, wechatVoiceIconCorrected: { transform: [{ rotate: '90deg' }], marginLeft: -1, marginTop: 0 }, wechatInput: { flex: 1, borderRadius: 20, paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 10 : 8, paddingBottom: Platform.OS === 'ios' ? 10 : 8, marginHorizontal: 8, fontSize: 16, minHeight: 40, maxHeight: 120, textAlignVertical: 'center' }, voiceRecordButton: { justifyContent: 'center', alignItems: 'center', paddingTop: 0, paddingBottom: 0, height: 40 }, voiceRecordText: { fontSize: 15, fontWeight: '600' }, rightIconsGroup: { flexDirection: 'row', alignItems: 'center' }, plusIconSpacing: { marginLeft: 8 }, sendButton: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center', marginLeft: 4 }, panelContainer: { position: 'absolute', left: 0, right: 0, paddingTop: 16 }, actionPage: { width: SCREEN_WIDTH, flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start', paddingHorizontal: 8 }, actionItem: { width: (SCREEN_WIDTH - 16) / 4, alignItems: 'center', marginVertical: 12 }, actionIconBox: { width: 62, height: 62, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginBottom: 8 }, actionText: { fontSize: 12, fontWeight: '400' }, verticalScrollContainer: { paddingHorizontal: 16, paddingTop: 16 }, emojiVerticalGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start' }, emojiItemVertical: { width: (SCREEN_WIDTH - 32) / 8, height: 45, justifyContent: 'center', alignItems: 'center', marginBottom: 12 }, emojiText: { fontSize: 32 }, 
  overlayContainer: { flex: 1 }, bubbleWrapper: { position: 'absolute', left: 0, right: 0, width: '100%', alignItems: 'center', justifyContent: 'center' }, recordBubble: { minWidth: 180, paddingHorizontal: 28, height: 72, borderRadius: 36, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 10 }, bubbleFeedbackText: { fontSize: 17, fontWeight: '600', letterSpacing: 0.3, textAlign: 'center' }, waveformContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4.5, height: 40 }, waveBar: { width: 3.5, height: '100%', borderRadius: 2 }, actionPillsRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 32 }, pillLeftWrapper: { flex: 0.46 }, pillRightWrapper: { flex: 0.46 }, actionPill: { flexDirection: 'row', height: 54, borderRadius: 27, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 6 }, pillIcon: { marginRight: 6 }, pillText: { fontSize: 16, fontWeight: '600', letterSpacing: 0.2 }, bottomSemiCircle: { position: 'absolute', bottom: 0, width: '100%', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.05, shadowRadius: 12, elevation: 5 }, arcText: { fontSize: 14, fontWeight: '500', letterSpacing: 1.2, textTransform: 'uppercase' }, editModeWrapper: { position: 'absolute', left: 0, right: 0, width: '100%', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }, editTextBox: { width: '100%', minHeight: 120, maxHeight: 200, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.2, shadowRadius: 24, elevation: 10, marginBottom: 20 }, editTextInput: { flex: 1, fontSize: 17, lineHeight: 24, textAlignVertical: 'top' }, editActionsRow: { flexDirection: 'row', justifyContent: 'center', width: '100%' }, editActionBtn: { flex: 1, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 5 }, transcribingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' }
});
// --- END OF FILE src/components/ChatInputBar.js ---