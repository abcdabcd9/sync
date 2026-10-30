-- --- START OF FILE supabase/migrations/20261029_add_message_subtype.sql ---
-- 任务 3：重构文本前缀协议
-- 将原先塞在 text 字段里的 [SYNC_XXX] 前缀，拆分为独立的 subtype 字段。
-- subtype 为 NULL 表示普通聊天消息；非空表示系统/协议消息类型。

-- ⚠️ 使用 IF NOT EXISTS：远程库可能已存在该列（例如手工建过或迁移被部分执行过），
--    否则 db push 会因 duplicate_column 报错中断整个迁移流程。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS subtype text;

-- --- END OF FILE supabase/migrations/20261029_add_message_subtype.sql ---
