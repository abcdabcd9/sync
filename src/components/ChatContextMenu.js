// --- START OF FILE src/components/ChatContextMenu.js ---
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Dimensions, Animated, Easing, DeviceEventEmitter } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function ChatContextMenu({ actionMessage, onClose, onCopy, onSave, onFavorite, onDelete, onRecall }) {
  const [visible, setVisible] = useState(false);
  const scaleAnim = React.useRef(new Animated.Value(0.8)).current;
  const opacityAnim = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (actionMessage) {
      setVisible(true);
      // 🍎 核心修复：打开菜单时，全局隐藏悬浮播放器
      DeviceEventEmitter.emit('hideFloatingPlayer', true);
      Animated.parallel([
        Animated.timing(scaleAnim, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 150, useNativeDriver: true })
      ]).start();
    }
  }, [actionMessage]);

  const handleClose = () => {
    Animated.parallel([
      Animated.timing(scaleAnim, { toValue: 0.8, duration: 100, useNativeDriver: true }),
      Animated.timing(opacityAnim, { toValue: 0, duration: 100, useNativeDriver: true })
    ]).start(() => {
      setVisible(false);
      // 🍎 菜单关闭时，恢复悬浮播放器
      DeviceEventEmitter.emit('hideFloatingPlayer', false);
      onClose();
    });
  };

  if (!actionMessage || !visible) return null;

  const { pageX, pageY, width, height } = actionMessage.layout;
  const isMedia = actionMessage.type === 'image' || actionMessage.type === 'video';
  
  const isRecallable = actionMessage.isMe && 
                       actionMessage.type !== 'action' && 
                       (Date.now() - actionMessage.timestamp <= 3 * 60 * 1000);

  const menuWidth = isRecallable ? 280 : 240; 
  const menuHeight = 56;
  
  let top = pageY - menuHeight - 12;
  const isTopSpaceEnough = top > 50;
  if (!isTopSpaceEnough) {
    top = pageY + height + 12;
  }

  let left = pageX + (width / 2) - (menuWidth / 2);
  if (left < 16) left = 16;
  if (left + menuWidth > SCREEN_WIDTH - 16) left = SCREEN_WIDTH - menuWidth - 16;

  return (
    <Modal visible={visible} transparent={true} animationType="none" onRequestClose={handleClose}>
      <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={handleClose}>
        <Animated.View style={[styles.menuContainer, { top, left, width: menuWidth, opacity: opacityAnim, transform: [{ scale: scaleAnim }] }]}>
          
          {!isMedia ? (
            <TouchableOpacity style={styles.menuItem} onPress={() => { onCopy(actionMessage.text); handleClose(); }}>
              <Ionicons name="copy-outline" size={18} color="#FFFFFF" />
              <Text style={styles.menuText}>复制</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.menuItem} onPress={() => { onSave(actionMessage.mediaUrl); handleClose(); }}>
              <Ionicons name="download-outline" size={18} color="#FFFFFF" />
              <Text style={styles.menuText}>保存</Text>
            </TouchableOpacity>
          )}

          <View style={styles.divider} />
          <TouchableOpacity style={styles.menuItem} onPress={() => { onFavorite(); handleClose(); }}>
            <Ionicons name="star-outline" size={18} color="#FFFFFF" />
            <Text style={styles.menuText}>收藏</Text>
          </TouchableOpacity>

          {isRecallable && (
            <>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.menuItem} onPress={() => { onRecall(actionMessage.id); handleClose(); }}>
                <Ionicons name="arrow-undo-outline" size={18} color="#FFFFFF" />
                <Text style={styles.menuText}>撤回</Text>
              </TouchableOpacity>
            </>
          )}

          <View style={styles.divider} />
          <TouchableOpacity style={styles.menuItem} onPress={() => { onDelete(actionMessage.id); handleClose(); }}>
            <Ionicons name="trash-outline" size={18} color="#FF3B30" />
            <Text style={[styles.menuText, { color: '#FF3B30' }]}>删除</Text>
          </TouchableOpacity>

        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  menuContainer: { position: 'absolute', flexDirection: 'row', backgroundColor: '#4C4C4C', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 10, justifyContent: 'space-around', alignItems: 'center' },
  menuItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  menuText: { color: '#FFFFFF', fontSize: 11, marginTop: 4, fontWeight: '500' },
  divider: { width: StyleSheet.hairlineWidth, height: 24, backgroundColor: 'rgba(255,255,255,0.2)' }
});
// --- END OF FILE src/components/ChatContextMenu.js ---