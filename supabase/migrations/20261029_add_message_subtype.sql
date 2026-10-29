-- --- START OF FILE supabase/migrations/20261029_add_message_subtype.sql ---
-- 任务 3：重构文本前缀协议
-- 将原先塞在 text 字段里的 [SYNC_XXX] 前缀，拆分为独立的 subtype 字段。
-- subtype 为 NULL 表示普通聊天消息；非空表示系统/协议消息类型。

ALTER TABLE messages ADD COLUMN subtype text;

-- --- END OF FILE supabase/migrations/20261029_add_message_subtype.sql ---
