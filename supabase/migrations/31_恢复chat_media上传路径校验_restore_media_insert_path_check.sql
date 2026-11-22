-- --- START OF FILE supabase/migrations/31_恢复chat_media上传路径校验_restore_media_insert_path_check.sql ---
-- ============================================================================
-- P1 R0 / 工作包 A / S2 — chat_media 双向授权修复（S2-a 写侧 + S2-b 读侧）
-- ============================================================================
-- S2 是两条独立越权链，必须分别修复、分别测试：
--
--   S2-a（跨命名空间上传，写侧）：
--     迁移 02 的 chat_media_authenticated_insert 含
--       (storage.foldername(name))[1] = auth.uid()::text
--     但迁移 03 把它覆盖为仅 `bucket_id = 'chat_media'`，路径校验丢失。
--     → 任意登录用户可向 chat_media/<他人 uid>/... 上传，污染他人命名空间、
--       占用配额，并为 S2-b 的引用攻击铺路。
--
--   S2-b（消息媒体引用越权，读侧）：
--     messages_insert_own（迁移 21）仅校验 auth.uid()=user_id 与 subtype 白名单，
--     不校验 media_url / thumbnail_url 指向的对象归属；
--     迁移 17 的 chat_media_participants_select 第 ③ 分支用
--       m.media_url LIKE '%/' || storage.objects.name
--     做后缀匹配（越权放大器）。
--     攻击链：A 直插 messages{user_id:A, receiver_id:A, media_url:'<B_uid>/secret.jpg'}
--       → 第 ③ 分支命中（A 是 user_id）→ A 对 B 的对象获得 createSignedUrl 权限
--       → 读取 B 的私密媒体。
--
-- 修复（双管齐下，同一迁移内完成，避免中间态仍可越权）：
--   (1) 写侧 S2-a：重建 chat_media_authenticated_insert，恢复 foldername 校验。
--   (2) 写侧 S2-b：新增 BEFORE INSERT 触发器 messages_guard_media_ownership()，
--       要求 media_url / thumbnail_url 首段 = NEW.user_id::text（只能引用自己命名空间）。
--   (3) 读侧 S2-b：重建 chat_media_participants_select，反查分支增加
--       「对象首段 = 消息发送方 uid」的命名空间闸门，彻底关闭引用越权。
--
-- 历史数据兼容（关键决策，已核实）：
--   * 现有 messages_guard_update()（迁移 21/29）对 media_url / thumbnail_url 的
--     UPDATE 仅放行「发送方撤回时清空」，**不允许批量改写**。
--     因此本迁移**不做** media_url 批量回填（回填会与既有触发器冲突）。
--   * 历史 media_url 可能仍是完整签名 URL。为保持「接收方读取历史媒体」不退化，
--     读侧反查分支**保留**后缀匹配，但**严格以命名空间闸门为前提**：
--         (storage.foldername(name))[1] = m.user_id::text
--     该闸门使后缀匹配不再具备放大器性质——对象必须位于「消息发送方」的命名空间，
--     攻击者无法借他人对象名命中。此为本迁移对「删除后缀兜底」的兼容性折中，
--     已在交付报告中登记，供三模型复核。
--   * 无法解析的历史值保留原值，由 owner = auth.uid() 分支兜底（仅上传者本人可读）。
--
-- 客户端兼容（已核实）：
--   * src/hooks/chat/useMediaUpload.js:115 生成 `${userId}/${prefix}_...` 相对路径，
--     天然满足 S2-a 与写侧触发器。
--   * src/hooks/chat/useSignedMediaUrl.js 走 createSignedUrl，不依赖后缀匹配。
--
-- 幂等性：DROP POLICY IF EXISTS / DROP TRIGGER IF EXISTS / CREATE OR REPLACE FUNCTION。
-- 安全：不输出密钥；不触碰生产库；仅在 Sync-Dev 验证。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. S2-a：恢复上传路径校验（写侧）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "chat_media_authenticated_insert" ON storage.objects;
CREATE POLICY "chat_media_authenticated_insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'chat_media'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ---------------------------------------------------------------------------
-- 2. S2-b 写侧：消息媒体引用必须属于发送方命名空间
-- ---------------------------------------------------------------------------
-- 仅当 media_url / thumbnail_url 非空时校验其首段 = NEW.user_id::text。
-- 系统卡片（SYNC_PARTNER_*）由 SECURITY DEFINER RPC 写入，媒体字段通常为 NULL，
-- 不受影响；即便非空，只要属于发送方命名空间也放行。
CREATE OR REPLACE FUNCTION public.messages_guard_media_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_media_first TEXT;
  v_thumb_first TEXT;
BEGIN
  IF NEW.media_url IS NOT NULL AND length(NEW.media_url) > 0 THEN
    v_media_first := split_part(NEW.media_url, '/', 1);
    IF v_media_first IS DISTINCT FROM NEW.user_id::text THEN
      RAISE EXCEPTION 'messages.media_url 必须位于发送方命名空间（首段=user_id），实际首段=%', v_media_first
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.thumbnail_url IS NOT NULL AND length(NEW.thumbnail_url) > 0 THEN
    v_thumb_first := split_part(NEW.thumbnail_url, '/', 1);
    IF v_thumb_first IS DISTINCT FROM NEW.user_id::text THEN
      RAISE EXCEPTION 'messages.thumbnail_url 必须位于发送方命名空间（首段=user_id），实际首段=%', v_thumb_first
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_guard_media_ownership_trg ON public.messages;
CREATE TRIGGER messages_guard_media_ownership_trg
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.messages_guard_media_ownership();

-- ---------------------------------------------------------------------------
-- 3. S2-b 读侧：重建 chat_media_participants_select（命名空间闸门）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;
CREATE POLICY "chat_media_participants_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat_media'
  AND (
    -- ① 自己的命名空间（新数据，走 btree 索引）
    (storage.foldername(name))[1] = auth.uid()::text

    -- ② 对象 owner 即当前用户（上传者本人，覆盖多账号/历史）
    OR owner = auth.uid()

    -- ③ 反查消息：我是发送方或接收方，且对象位于「消息发送方」命名空间
    OR EXISTS (
      SELECT 1
        FROM public.messages m
       WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
         -- 命名空间闸门：对象首段必须等于消息发送方 uid（关闭 S2-b 引用越权）
         AND (storage.foldername(name))[1] = m.user_id::text
         AND (
           -- 新数据：相对对象路径精确匹配
           m.media_url = storage.objects.name
           OR m.thumbnail_url = storage.objects.name
           -- 历史数据：完整 URL 后缀匹配（受上方命名空间闸门约束，非放大器）
           OR m.media_url LIKE '%/' || storage.objects.name
           OR m.thumbnail_url LIKE '%/' || storage.objects.name
         )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 4. 自检（执行后手动核对，不自动运行）
-- ---------------------------------------------------------------------------
-- 4.1 chat_media 全部策略（应含 insert 带 foldername 校验、select 带命名空间闸门）：
--   SELECT policyname, cmd, qual, with_check
--     FROM pg_policies
--    WHERE schemaname='storage' AND tablename='objects'
--      AND (qual LIKE '%chat_media%' OR with_check LIKE '%chat_media%')
--    ORDER BY cmd, policyname;
--
-- 4.2 messages 触发器（应含 messages_guard_media_ownership_trg）：
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid='public.messages'::regclass AND NOT tgisinternal;
--
-- 4.3 历史 media_url 形态统计（只读，用于登记残留）：
--   SELECT
--     count(*) FILTER (WHERE media_url LIKE 'http%')      AS full_url_rows,
--     count(*) FILTER (WHERE media_url IS NOT NULL
--                        AND media_url NOT LIKE 'http%')  AS relative_rows,
--     count(*) FILTER (WHERE media_url IS NULL)           AS null_rows
--   FROM public.messages;

-- --- END OF FILE supabase/migrations/31_恢复chat_media上传路径校验_restore_media_insert_path_check.sql ---
