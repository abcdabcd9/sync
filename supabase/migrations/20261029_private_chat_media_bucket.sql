-- --- START OF FILE supabase/migrations/20261029_private_chat_media_bucket.sql ---
-- ============================================================================
-- 🔒 安全审计 #14：私密媒体防泄露 —— 将 chat_media 桶私有化
-- ============================================================================
-- 背景：
--   旧实现使用 supabase.storage.from('chat_media').getPublicUrl(fileName) 生成
--   永久公开链接并写入 messages.media_url。任何人只要拿到该 URL（转发、日志、
--   截图、抓包）即可在无登录状态下永久访问私密图片 / 视频 / 语音。
--
-- 目标：
--   1. 将 chat_media 桶设为 private（public = false），公开链接立即失效（403）。
--   2. 客户端改用 createSignedUrl(fileName, 7 天) 生成带 token 的临时链接。
--   3. 通过 RLS 策略限制：仅「消息的发送者」与「消息的接收者」可以读取对象，
--      仅「已登录用户」可以上传到自己的命名空间。
--
-- ⚠️ 执行顺序：
--   本迁移必须与前端代码（useMediaUpload.js 的 createSignedUrl 改造）同时上线。
--   若先执行本 SQL 而前端仍用 getPublicUrl，历史与新消息的媒体都会 403 无法显示。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 桶私有化
-- ---------------------------------------------------------------------------
UPDATE storage.buckets
SET public = false
WHERE id = 'chat_media';

-- 兜底：若桶尚未创建（全新环境），以私有方式创建
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat_media',
  'chat_media',
  false,
  52428800, -- 50MB，与前端 MAX_MEDIA_BYTES 保持一致
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'video/mp4', 'video/quicktime', 'video/x-m4v',
    'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/mpeg', 'audio/x-m4a'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. 清理旧的公开读取策略（公开桶时代的遗留策略必须移除）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public read access for chat_media" ON storage.objects;
DROP POLICY IF EXISTS "chat_media public read" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read chat_media" ON storage.objects;
DROP POLICY IF EXISTS "chat_media_public_select" ON storage.objects;

-- ---------------------------------------------------------------------------
-- 3. 上传策略：登录用户可上传到 chat_media（文件名由客户端生成，前缀区分类型）
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "chat_media_authenticated_insert" ON storage.objects;
CREATE POLICY "chat_media_authenticated_insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'chat_media');

-- ---------------------------------------------------------------------------
-- 4. 读取策略：仅消息的发送者与接收者可以读取对应对象
-- ---------------------------------------------------------------------------
-- 说明：
--   messages.media_url / thumbnail_url 存的是「签名 URL」，其路径形如
--     .../storage/v1/object/sign/chat_media/img_1699999999_123.jpg?token=...
--   因此这里用 storage.foldername / split_part 无法直接匹配，
--   改为「按对象名反查 messages 表」：只要存在一条消息，其 media_url 或
--   thumbnail_url 包含该对象名，且当前用户是发送者或接收者，即允许读取。
--
--   注意：createSignedUrl 本身由服务端签发，不经过 RLS 的 SELECT 校验；
--   该策略主要用于兜底「直接访问对象路径」的场景（如 SDK 内部重定向、
--   以及未来可能启用的 download() 调用）。
DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;
CREATE POLICY "chat_media_participants_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat_media'
  AND EXISTS (
    SELECT 1
    FROM public.messages m
    WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
      AND (
        m.media_url LIKE '%' || storage.objects.name || '%'
        OR m.thumbnail_url LIKE '%' || storage.objects.name || '%'
      )
  )
);

-- ---------------------------------------------------------------------------
-- 5. 删除策略：仅上传者本人（对象 owner）可删除自己的媒体
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "chat_media_owner_delete" ON storage.objects;
CREATE POLICY "chat_media_owner_delete"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'chat_media' AND owner = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. 更新策略：仅上传者本人可覆盖自己的对象
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "chat_media_owner_update" ON storage.objects;
CREATE POLICY "chat_media_owner_update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'chat_media' AND owner = auth.uid())
WITH CHECK (bucket_id = 'chat_media' AND owner = auth.uid());

-- ---------------------------------------------------------------------------
-- 7. 索引优化：加速「按对象名反查消息」的 LIKE 查询
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_media_url
  ON public.messages (media_url)
  WHERE media_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_thumbnail_url
  ON public.messages (thumbnail_url)
  WHERE thumbnail_url IS NOT NULL;

-- ============================================================================
-- 回滚说明（如需临时恢复公开访问，请谨慎评估风险）：
--   UPDATE storage.buckets SET public = true WHERE id = 'chat_media';
--   DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;
--   DROP POLICY IF EXISTS "chat_media_authenticated_insert" ON storage.objects;
--   DROP POLICY IF EXISTS "chat_media_owner_delete" ON storage.objects;
--   DROP POLICY IF EXISTS "chat_media_owner_update" ON storage.objects;
-- ============================================================================
-- --- END OF FILE supabase/migrations/20261029_private_chat_media_bucket.sql ---
