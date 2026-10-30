-- --- START OF FILE supabase/migrations/20261030_unbind_partner_rpc.sql ---
-- 双向解绑伴侣 RPC
-- 目的：以 SECURITY DEFINER 权限在服务端原子完成双向解绑，
--       避免客户端直接 UPDATE 对方 profiles 行（受 RLS 限制）导致单向残留，
--       同时精准改写两人之间的"同意绑定"历史卡片，不误伤其他消息。

CREATE OR REPLACE FUNCTION unbind_partner(target_partner_id UUID)
RETURNS void AS $$
BEGIN
  -- 1. 双向解绑：清空双方的 bound_partner_id
  UPDATE profiles
  SET bound_partner_id = NULL
  WHERE id = auth.uid() OR id = target_partner_id;

  -- 2. 精准更新两人之间的“同意绑定”历史卡片，改为解除绑定状态
  UPDATE messages
  SET text = '', subtype = 'SYNC_PARTNER_UNBOUND'
  WHERE subtype = 'SYNC_PARTNER_ACCEPTED'
    AND (
      (user_id = auth.uid() AND receiver_id = target_partner_id)
      OR
      (user_id = target_partner_id AND receiver_id = auth.uid())
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
-- --- END OF FILE supabase/migrations/20261030_unbind_partner_rpc.sql ---
