// --- START OF FILE src/hooks/chat/useFriendActions.js ---
import { useCallback } from 'react';

import { supabase } from '../../services/supabase';

/**
 * 好友关系操作数据层（删除好友 / 更新备注）
 *
 * 🔒 安全审计 #7 同款约束：friends 关系必须包含当前用户自身，
 *    因此删除时同时限定 user_id 与 friend_id，禁止代他人删除关系。
 *
 * 说明：friends 表在双向关系下可能存两条记录（A→B / B→A），
 * 也可能只存一条。这里用 or 条件一次性清掉两个方向，保证彻底解除。
 */
export function useFriendActions(user) {
  /**
   * 删除好友（双向解除）
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  const deleteFriend = useCallback(
    async (friendId) => {
      if (!user?.id) return { ok: false, error: '未登录' };
      if (!friendId) return { ok: false, error: '缺少好友 ID' };
      if (friendId === user.id) return { ok: false, error: '不能删除自己' };

      try {
        // 🔒 只允许删除「与自己相关」的关系行
        const { error } = await supabase
          .from('friends')
          .delete()
          .or(
            `and(user_id.eq.${user.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${user.id})`
          );

        if (error) return { ok: false, error: error.message };

        // 同步清理已通过的好友请求，避免对方仍出现在「已接受」列表里
        await supabase
          .from('friend_requests')
          .delete()
          .or(
            `and(sender_id.eq.${user.id},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${user.id})`
          )
          .eq('status', 'accepted');

        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || '删除失败' };
      }
    },
    [user]
  );

  /**
   * 更新好友备注（仅更新「我 → 对方」这一条记录）
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  const updateRemark = useCallback(
    async (friendId, remark) => {
      if (!user?.id) return { ok: false, error: '未登录' };
      if (!friendId) return { ok: false, error: '缺少好友 ID' };

      try {
        // 🔒 归属校验：只能改自己名下的关系行
        const { error } = await supabase
          .from('friends')
          .update({ remark: remark || null })
          .eq('user_id', user.id)
          .eq('friend_id', friendId);

        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || '更新失败' };
      }
    },
    [user]
  );

  return { deleteFriend, updateRemark };
}
// --- END OF FILE src/hooks/chat/useFriendActions.js ---
