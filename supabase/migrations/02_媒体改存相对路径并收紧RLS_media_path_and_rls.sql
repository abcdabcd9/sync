-- --- START OF FILE supabase/migrations/02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql ---
-- ============================================================================
-- P0-2 / P0-3：媒体改存相对对象路径 + 按 user_id 命名空间收紧 RLS
-- ============================================================================
-- 背景：
--   上一版迁移（03_聊天媒体桶私有化_private_chat_media_bucket.sql）把 chat_media 桶私有化，
--   但前端把「7 天有效期的签名 URL」直接写进了 messages.media_url / thumbnail_url。
--   后果：
--     1. 7 天后所有历史图片 / 视频 / 语音全部 403，且无法恢复
--        （库里没有存对象路径，无法重新签名）。
--     2. 对象路径没有 user_id 前缀，RLS 只能用 LIKE '%' || name || '%' 反查
--        messages 表 —— 全表扫描，btree 索引完全失效。
--
-- 本迁移目标：
--   1. 历史数据回填：从签名 URL 中正则提取对象路径，写回 media_url / thumbnail_url。
--   2. 上传策略收紧：对象路径首段必须等于 auth.uid()，杜绝跨用户写入。
--   3. 读取策略优化：优先用 storage.foldername(name)[1] 精确匹配，
--      再兜底「按对象名反查 messages」以兼容历史数据。
--   4. 索引改为精确匹配（去掉 LIKE 全表扫描）。
--
-- 执行顺序：
--   1) 先执行本 SQL（回填历史数据 + 收紧 RLS）
--   2) 再发布前端代码（useMediaUpload / useAudioRecorder 存相对路径，
--      useSignedMediaUrl 按需签名）
--   若顺序颠倒：新前端读到旧签名 URL 时，兼容层会提取路径重新签名，
--   功能仍可用，但 RLS 的精确匹配会因库里仍是完整 URL 而失效。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 历史数据回填：签名 URL → 相对对象路径
-- ---------------------------------------------------------------------------
-- 签名 URL 形如：
--   https://xxx.supabase.co/storage/v1/object/sign/chat_media/user_id/img_123.jpg?token=...
-- 公开 URL 形如：
--   https://xxx.supabase.co/storage/v1/object/public/chat_media/user_id/img_123.jpg
-- 目标：提取 chat_media/ 之后、? 或 # 之前的部分。
--
-- 说明：
--   - 用 substring(... from '...') 而非 regexp_replace，避免贪婪匹配误伤。
--   - 只处理以 http 开头的值，已是相对路径的行原样保留（幂等，可重复执行）。
--   - 若 URL 中不含 /chat_media/，substring 返回 NULL，此时保留原值不动。
UPDATE public.messages
SET media_url = COALESCE(
  substring(media_url from '/chat_media/([^?#]+)'),
  media_url
)
WHERE media_url LIKE 'http%'
  AND media_url LIKE '%/chat_media/%';

UPDATE public.messages
SET thumbnail_url = COALESCE(
  substring(thumbnail_url from '/chat_media/([^?#]+)'),
  thumbnail_url
)
WHERE thumbnail_url LIKE 'http%'
  AND thumbnail_url LIKE '%/chat_media/%';

-- ---------------------------------------------------------------------------
-- 1.5 清理「全开」遗留策略（P0，2026-10-31 线上导出时发现）
-- ---------------------------------------------------------------------------
-- 这两条是公开桶时代在 Dashboard 手工建的，条件为
--   auth.role() = 'authenticated'
-- 等价于「任何登录用户」。PostgreSQL 的 PERMISSIVE 策略是 OR 关系，
-- 只要它们存在，下面第 2、3 节收紧后的策略就完全失效：
--   · read media   → 任何登录用户可读全库所有聊天图片/视频/语音
--   · upload media → 任何登录用户可往别人目录塞文件
-- 必须在重建策略之前删除，否则等于没改。
DROP POLICY IF EXISTS "Allow logged-in users to read media"   ON storage.objects;
DROP POLICY IF EXISTS "Allow logged-in users to upload media" ON storage.objects;

-- ---------------------------------------------------------------------------
-- 2. 上传策略：对象路径首段必须等于当前用户 ID
-- ---------------------------------------------------------------------------
-- 前端路径格式：`${user.id}/${prefix}_${ts}_${rand}.${ext}`
-- storage.foldername(name) 返回路径的目录段数组，[1] 即首段。
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
-- 3. 读取策略：user_id 目录精确匹配 + 历史数据兜底
-- ---------------------------------------------------------------------------
-- 说明：
--   createSignedUrl 由服务端签发，本身不经过 RLS 的 SELECT 校验；
--   该策略主要用于兜底「直接访问对象路径」的场景（SDK 内部重定向、
--   未来可能启用的 download() 调用）。
DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;
CREATE POLICY "chat_media_participants_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat_media'
  AND (
    -- ① 自己的命名空间：直接放行（覆盖自己上传的所有媒体）
    (storage.foldername(name))[1] = auth.uid()::text
    -- ② 兜底：历史数据（无 user_id 前缀）按对象名精确反查 messages
    OR EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
        AND (
          m.media_url = storage.objects.name
          OR m.thumbnail_url = storage.objects.name
        )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 4. 索引：改为精确匹配（去掉 LIKE '%...%' 全表扫描）
-- ---------------------------------------------------------------------------
-- 旧索引在 LIKE '%' || name || '%' 下完全无法使用，重建为普通 btree 索引，
-- 供 `m.media_url = storage.objects.name` 精确匹配使用。
DROP INDEX IF EXISTS public.idx_messages_media_url;
DROP INDEX IF EXISTS public.idx_messages_thumbnail_url;

CREATE INDEX IF NOT EXISTS idx_messages_media_url
  ON public.messages (media_url)
  WHERE media_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_thumbnail_url
  ON public.messages (thumbnail_url)
  WHERE thumbnail_url IS NOT NULL;

-- ============================================================================
-- 回滚说明（如需临时恢复旧行为，请谨慎评估风险）：
--   -- 1) 恢复旧上传策略（不校验 user_id 前缀）
--   DROP POLICY IF EXISTS "chat_media_authenticated_insert" ON storage.objects;
--   CREATE POLICY "chat_media_authenticated_insert"
--   ON storage.objects FOR INSERT TO authenticated
--   WITH CHECK (bucket_id = 'chat_media');
--
--   -- 2) 恢复旧读取策略（LIKE 反查）
--   DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;
--   CREATE POLICY "chat_media_participants_select"
--   ON storage.objects FOR SELECT TO authenticated
--   USING (
--     bucket_id = 'chat_media'
--     AND EXISTS (
--       SELECT 1 FROM public.messages m
--       WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
--         AND (m.media_url LIKE '%' || storage.objects.name || '%'
--              OR m.thumbnail_url LIKE '%' || storage.objects.name || '%')
--     )
--   );
--
--   -- 3) 数据回填不可逆（签名 URL 已丢失 token，无法还原），
--   --    但相对路径是更正确的形态，无需回滚。
-- ============================================================================
-- --- END OF FILE supabase/migrations/02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql ---
