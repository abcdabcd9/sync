import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, Pressable, Animated, Platform } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';
import { useHealthData } from '../hooks/useHealthData';
import { SPRING, DURATION } from '../constants/motion';
import { haptic } from '../constants/haptics';

export default function MealDetailSheet({
  meal,
  // 🛡️ FINAL-03 / FINAL-04：sessionOwnerKey 是「当前认证身份」（userId::authEpoch），
  //    由 Provider 的 currentOwnerKey 提供，**不**随 selectedMeal 变 null。
  //    旧实现误把 selectedMealOwnerKey（选中态所属身份，关闭后为 null）当作当前身份，
  //    导致正常关闭被误判为「身份失效」→ 退出动画被截断（FINAL-03）；
  //    切号后 selectedMeal 仍保留旧对象 → ownerKey 仍是旧身份 → 旧弹窗继续可见（FINAL-04）。
  sessionOwnerKey,
  // 🛡️ 当前选择实例 id：同账号连续打开同一餐次时 sessionOwnerKey 不变，
  //    必须靠 selectionId 区分不同实例，否则旧关闭动画会误关新实例。
  selectionId,
  checked,
  onClose,
  onConfirm,
  onUndo,
}) {
  const { colors: palette } = useAppTheme();
  const { mealGuides } = useHealthData();
  
  const [isVisible, setIsVisible] = useState(false);
  const [internalMeal, setInternalMeal] = useState(null);

  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  // 🛡️ Round 4A 收尾 / R4A-02（修复 2）：打开会话令牌。
  //    每次「打开」自增，关闭动画的完成回调捕获启动时的令牌；
  //    回调执行时若令牌已变（期间发生了新的打开 / 身份切换），则整体丢弃，
  //    绝不关闭新弹窗、绝不改写新会话内部状态。
  //    注意：不能用餐次字符串判断身份——不同会话可以打开同一餐次。
  const openTokenRef = useRef(0);

  // 🛡️ Round 4A 最终封版 / FINAL-03 + FINAL-04：**合法用户主动关闭**标记（state，非 ref）。
  //    问题：撤销打卡 / 确认打卡 会先调用 onUndo/onConfirm，Provider 侧同步把
  //    selectedMeal 置 null → meal 变 null → modalVisible 立刻 false，退出动画被截断。
  //    解决：handleClose 启动退出动画时记录「本次关闭所属的**当前认证身份** + 选择实例」，
  //    动画完成回调里复位。渲染期派生改为：
  //      (isVisible && !!meal) ||
  //      (closing !== null && closing.sessionOwnerKey === sessionOwnerKey &&
  //       closing.selectionId === selectionId)
  //      - 合法关闭：sessionOwnerKey 不变（它是当前身份，不随 meal 变 null）→ 动画期间保持可见；
  //      - 身份失效：切号 / 登出 → sessionOwnerKey 变化 → 当帧即隐藏（FINAL-04）；
  //      - 同账号重开同一餐次：sessionOwnerKey 不变但 selectionId 变化 → 旧动画失效。
  //    ⚠️ 关键：绝不能再用 selectedMealOwnerKey 判断——它在关闭后就是 null，
  //       会把「合法关闭」误判为「身份失效」（FINAL-03 的根因）。
  //    ⚠️ 必须用 state 而非 ref：ref 在渲染期读取会被 react-hooks/refs 判定为违规，
  //       且 ref 变更不触发重渲染，无法保证 Modal 在动画期间保持可见。
  const [closing, setClosing] = useState(null);

  // 🛡️ Round 4A 收尾 / R4A-02（修复 1）：Modal 可见性在**渲染期**派生。
  //    仅靠 useEffect 关闭会残留一帧「meal 已为 null 但 isVisible 仍为 true」的旧账号内容。
  //    这里把「内部可见态」与「当前确有 meal」做与运算：身份切换导致 meal→null 时，
  //    当前渲染即不可见，无需等待 effect。正常用户关闭时 meal 仍为真，
  //    退出动画期间 Modal 保持可见，动画结束后 isVisible 才置 false —— 原有动画设计不变。
  //    ⚠️ closing 参与派生：合法关闭时即使 meal 已 null 也保持可见（退出动画完整）；
  //       但仅当「当前认证身份」与「选择实例」都一致时才生效（身份切换 / 新实例即失效）。
  //    ⚠️ selectionId 为 null 表示「当前没有选中实例」（合法关闭后 Provider 会把
  //       selectedMeal 置 null → selectedMealSelectionId 变 null）。此时不能拿它
  //       与 closing.selectionId 比较，否则合法关闭会被判为「实例已变」→ 动画截断。
  //       只有出现**新的非空实例**（selectionId != null 且不同）才让旧关闭标记失效。
  //
  //    ⚠️ closing 必须参与 modalVisible：合法关闭时 Provider 会先把 meal 置 null，
  //       若可见性只看 isVisible && !!meal，退出动画会被立即截断（FINAL-03 根因）。
  //       但 closing 只在「当前认证身份 + 选择实例」都匹配时才生效，
  //       身份切换 / 新实例出现时当帧即失效（FINAL-04）。
  const closingMatchesCurrent =
    closing !== null &&
    closing.sessionOwnerKey === sessionOwnerKey &&
    (selectionId == null || closing.selectionId === selectionId);

  const modalVisible = (isVisible && !!meal) || closingMatchesCurrent;

  // 🛡️ 记录「上一次真正打开」的 meal + selectionId，用于区分「新打开」与「closing 变化」。
  //    必须用 ref：它只在 effect 内读写，不参与渲染，也不应触发重渲染。
  const lastOpenRef = useRef({ meal: null, selectionId: null });

  // 🛡️ 单一生命周期 effect：同时处理「打开」与「关闭收尾」。
  //    ⚠️ 为什么不能拆成两个 effect：拆分会多出一处 setState-in-effect（ESLint 新增错误）。
  //    ⚠️ 为什么 closing 变化不能触发「打开」分支：动画完成回调 setClosing(null) 会重跑本
  //       effect，若此时父组件尚未把 meal 置 null（纯 UI 关闭场景），会误判为「新打开」而
  //       重开弹窗（T-18-04 卡死根因）。因此用 lastOpenRef 判断「是否真的是新打开」：
  //       只有 meal 非空且 (meal, selectionId) 与上次打开不同，才执行打开分支。
  useEffect(() => {
    if (meal) {
      const prev = lastOpenRef.current;
      const isNewOpen = prev.meal !== meal || prev.selectionId !== selectionId;
      if (!isNewOpen) return;
      lastOpenRef.current = { meal, selectionId };
      // 新一轮打开：令牌自增，使任何在途的旧关闭回调失效
      openTokenRef.current += 1;
      // 新会话打开 → 清掉上一轮可能残留的关闭标记
      setClosing(null);
      setInternalMeal(meal);
      setIsVisible(true);
      Animated.parallel([
        Animated.spring(scaleAnim, { ...SPRING.bouncy, toValue: 1, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: DURATION.fast, useNativeDriver: true })
      ]).start();
      return;
    }
    // meal 为 null：区分「合法关闭」与「身份/实例失效」。
    //    - 合法关闭（closingMatchesCurrent）：保留可见性让退出动画跑完，由 handleClose
    //      的完成回调统一 setClosing(null) + setIsVisible(false) + onClose()；
    //    - 身份失效 / 新实例：立即自增令牌（作废在途旧回调）并隐藏。
    //    同时清空 lastOpenRef，确保下次打开同一餐次仍被识别为「新打开」。
    lastOpenRef.current = { meal: null, selectionId: null };
    if (!closingMatchesCurrent) {
      openTokenRef.current += 1;
      setIsVisible(false);
      setInternalMeal(null);
    }
  }, [meal, closing, sessionOwnerKey, selectionId, scaleAnim, opacityAnim, closingMatchesCurrent]);

  const handleClose = () => {
    // 捕获本次关闭所属的会话令牌
    const tokenAtClose = openTokenRef.current;
    // 标记「本次是合法用户主动关闭」并记录所属**当前认证身份** + 选择实例 →
    // 退出动画期间即使 meal 已 null 也保持可见；
    // 但身份切换（sessionOwnerKey 变化）或新实例（selectionId 变化）时该标记自动失效。
    setClosing({ sessionOwnerKey: sessionOwnerKey ?? null, selectionId: selectionId ?? null });
    Animated.parallel([
      // 强制统一：全部使用 useNativeDriver: true，绝不越界
      Animated.spring(scaleAnim, { ...SPRING.bouncy, toValue: 0.9, useNativeDriver: true }),
      Animated.timing(opacityAnim, { toValue: 0, duration: DURATION.fast, useNativeDriver: true })
    ]).start(({ finished }) => {
      // 🛡️ 修复 2：动画被新打开动画取代（finished=false）或期间令牌已变，
      //    说明这是「旧会话的迟到回调」，必须整体丢弃。
      if (!finished) return;
      if (tokenAtClose !== openTokenRef.current) return;
      setClosing(null);
      setIsVisible(false);
      onClose();
    });
  };

  const handleAction = () => {
    if (checked) {
      haptic.warning();
      onUndo();
    } else {
      haptic.success();
      onConfirm();
    }
    handleClose();
  };

  const guideText = internalMeal && mealGuides ? mealGuides[internalMeal] : '';
  const lines = guideText ? guideText.split('\n').filter(line => line.trim() !== '') : [];
  const rule = lines.length > 0 ? lines[0] : '暂无饮食建议';
  const bullets = lines.slice(1);

  return (
    <Modal visible={modalVisible} transparent animationType="none" onRequestClose={handleClose}>
      {/* 巧妙修复：直接对带有深色背景的父容器应用 opacity 动画，完美兼容 Native Driver */}
      <Animated.View style={[styles.overlay, { opacity: opacityAnim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        
        <Animated.View 
          style={[
            styles.card, 
            { backgroundColor: palette.card, transform: [{ scale: scaleAnim }] }
          ]} 
        >
          <Pressable onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.title, { color: palette.textPrimary }]}>{internalMeal} 饮食建议</Text>
            
            <View style={[styles.guideBox, { backgroundColor: palette.background }]}>
              <Text style={[styles.rule, { color: palette.primary }]}>{rule}</Text>
              
              {bullets.length > 0 ? bullets.map((line, index) => (
                <Text key={index} style={[styles.line, { color: palette.textPrimary }]}>{line}</Text>
              )) : (
                <Text style={[styles.line, { color: palette.textSecondary, textAlign: 'center' }]}>
                  请前往“我的 - 偏好设置”定制专属食谱
                </Text>
              )}
            </View>

            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: checked ? palette.background : palette.primary }]}
              onPress={handleAction}
            >
              <Text style={[styles.actionText, { color: checked ? palette.primary : '#FFFFFF' }]}>
                {checked ? '撤销打卡' : '确认打卡'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Animated.View>
        
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.45)', // 静态背景色移至此处
    justifyContent: 'center', 
    alignItems: 'center', 
    padding: 24 
  },
  card: { 
    width: '100%', 
    borderRadius: 24, 
    padding: 24, 
    ...Platform.select({
      ios: {
        shadowColor: '#000', 
        shadowOffset: { width: 0, height: 12 }, 
        shadowOpacity: 0.2, 
        shadowRadius: 24, 
      },
      android: {
        elevation: 0, 
      }
    })
  },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: 0.35, marginBottom: 20, textAlign: 'center' },
  guideBox: { padding: 16, borderRadius: 12, marginBottom: 24 },
  rule: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  line: { fontSize: 14, lineHeight: 24, letterSpacing: -0.24, marginBottom: 4 },
  actionBtn: { height: 50, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  actionText: { fontSize: 17, fontWeight: '600', letterSpacing: -0.41 },
});