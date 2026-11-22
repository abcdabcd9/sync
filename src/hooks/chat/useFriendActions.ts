// --- START OF FILE src/hooks/chat/useFriendActions.ts ---
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
export interface FriendActionsUser {
  id?: string | null;
}

export interface FriendActionResult {
  ok: boolean;
  error?: string;
  created?: boolean;
}

export interface FriendActionsApi {
  deleteFriend: (friendId: string) => Promise<FriendActionResult>;
  updateRemark: (friendId: string, remark: string | null | undefined) => Promise<FriendActionResult>;
}

/**
 * 从任意异常中取出 message。
 *
 * ⚠️ P1.4 R6-A4：必须严格保持原 JS 的 `e?.message || fallback` 语义。
 *    R5 迁移时额外加了 `typeof msg === 'string'` 运行时过滤，导致
 *    `message` 为非字符串（如数字、对象）时行为改变：
 *      旧 JS：返回该真值（如 123 / {}），仅 falsy 才兜底；
 *      R5 TS：一律兜底，丢失原始信息。
 *    这里只用 TS 类型断言表达「message 可能是 string」，**不加任何运行时判断**，
 *    让 `||` 的短路语义与旧实现完全一致。
 */
const errMessage = (e: unknown, fallback: string): string => {
  const msg = (e as { message?: string } | null | undefined)?.message;
  return msg || fallback;
};

export function useFriendActions(user: FriendActionsUser | null | undefined): FriendActionsApi {
  /**
   * 删除好友（双向解除）
   */
  const deleteFriend = useCallback(
    async (friendId: string): Promise<FriendActionResult> => {
      if (!user?.id) return { ok: false, error: '未登录' };
      if (!friendId) return { ok: false, error: '缺少好友 ID' };
      if (friendId === user.id) return { ok: false, error: '不能删除自己' };

      try {
        // 🔒 只允许删除「与自己相关」的关系行
        const { error } = await supabase!
          .from('friends')
          .delete()
          .or(
            `and(user_id.eq.${user.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${user.id})`
          );

        if (error) return { ok: false, error: error.message };

        // 同步清理已通过的好友请求，避免对方仍出现在「已接受」列表里
        await supabase!
          .from('friend_requests')
          .delete()
          .or(
            `and(sender_id.eq.${user.id},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${user.id})`
          )
          .eq('status', 'accepted');

        return { ok: true };
      } catch (e) {
        return { ok: false, error: errMessage(e, '删除失败') };
      }
    },
    [user]
  );

  /**
   * 更新好友备注（仅更新「我 → 对方」这一条记录）
   *
   * 🔒 备注是「个人视角」数据：只写 user_id = 我 的那一行，
   *    绝不触碰对方名下的行，因此不会影响对方看到的备注。
   *
   * 🐞 修复 P04-BUG-01（备注修改无效）：
   *    历史实现只 `.eq('user_id', user.id).eq('friend_id', friendId)`，
   *    但好友关系可能只存了「对方 → 我」这一条（contacts.js 接受请求时
   *    只插入 { user_id: 我, friend_id: 对方 }；若关系由对方发起并接受，
   *    则库里只有对方那一行）。此时 UPDATE 命中 0 行，PostgREST 仍返回
   *    成功（无 error），前端误报「已保存」——表现为「备注改了没反应」。
   *
   *    修复策略：
   *      1) 先 UPDATE 我方行，并用 `.select('id')` 校验实际影响行数；
   *      2) 若命中 0 行，先校验「双方确实存在合法好友关系」（任一方向），
   *         再 UPSERT 我方行（user_id=我, friend_id=对方）。
   *         —— 绝不凭空创建好友关系：无合法关系时直接报错。
   *      3) 唯一约束 friends_user_friend_key(user_id, friend_id) 保证
   *         UPSERT 幂等，不会产生重复行。
   */
  const updateRemark = useCallback(
    async (friendId: string, remark: string | null | undefined): Promise<FriendActionResult> => {
      if (!user?.id) return { ok: false, error: '未登录' };
      if (!friendId) return { ok: false, error: '缺少好友 ID' };
      if (friendId === user.id) return { ok: false, error: '不能给自己设备注' };

      const nextRemark = remark ? remark : null;

      try {
        // 1) 先尝试更新「我 → 对方」这一行，并取回受影响行以校验
        const { data: updated, error: updateError } = await supabase!
          .from('friends')
          .update({ remark: nextRemark })
          .eq('user_id', user.id)
          .eq('friend_id', friendId)
          .select('id');

        if (updateError) return { ok: false, error: updateError.message };

        if (Array.isArray(updated) && updated.length > 0) {
          return { ok: true };
        }

        // 2) 命中 0 行：先确认双方存在合法好友关系（任一方向）
        const { data: relation, error: relError } = await supabase!
          .from('friends')
          .select('id, user_id, friend_id')
          .or(
            `and(user_id.eq.${user.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${user.id})`
          )
          .limit(1);

        if (relError) return { ok: false, error: relError.message };
        if (!Array.isArray(relation) || relation.length === 0) {
          // 无合法好友关系：拒绝创建，避免通过备注接口伪造好友关系
          return { ok: false, error: '好友关系不存在，无法设置备注' };
        }

        // 3) 合法关系存在，UPSERT 我方视角的行（唯一约束保证幂等）
        const { data: upserted, error: upsertError } = await supabase!
          .from('friends')
          .upsert(
            { user_id: user.id, friend_id: friendId, remark: nextRemark },
            { onConflict: 'user_id,friend_id' }
          )
          .select('id');

        if (upsertError) return { ok: false, error: upsertError.message };
        if (!Array.isArray(upserted) || upserted.length === 0) {
          return { ok: false, error: '备注保存失败，请重试' };
        }

        return { ok: true, created: true };
      } catch (e) {
        return { ok: false, error: errMessage(e, '更新失败') };
      }
    },
    [user]
  );

  return { deleteFriend, updateRemark };
}
// --- END OF FILE src/hooks/chat/useFriendActions.ts ---
