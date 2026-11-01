-- --- START OF FILE supabase/migrations/17_修复chat_media签名读取策略_fix_signed_url_select_policy.sql ---
-- ============================================================================
-- 修复：createSignedUrl 返回 `StorageApiError: Object not found`
-- ============================================================================
-- 现象：
--   客户端日志显示
--     [Storage Upload] 开始上传，路径: <uid>/img_xxx.jpeg
--     [Storage Upload] 上传结果: 成功
--     生成签名 URL 失败: [StorageApiError: Object not found]
--   即「对象确实上传成功，但紧接着对同一路径签名却报对象不存在」。
--
-- 根因：
--   Supabase Storage 的 createSignedUrl 在服务端会以「当前登录用户身份」
--   对 storage.objects 做一次 SELECT 权限校验。若 RLS 判定不可见，
--   服务端返回的是 `Object not found`（而不是 403），
--   因此极易被误判为「文件没上传成功」。
--
--   迁移 02 建立的策略为：
--     USING (
--       bucket_id = 'chat_media'
--       AND (
--         (storage.foldername(name))[1] = auth.uid()::text   -- ① 自己的命名空间
--         OR EXISTS (                                        -- ② 反查 messages
--           SELECT 1 FROM public.messages m
--           WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
--             AND (m.media_url = storage.objects.name
--                  OR m.thumbnail_url = storage.objects.name)
--         )
--       )
--     )
--
--   该策略存在两个缺口：
--     A. 上传成功 → 消息 insert 之前，messages 表里还没有对应行，
--        此时 ① 若因多账号切换导致 auth.uid() 与路径首段不一致，
--        ② 又查不到消息行，两条分支同时落空 → 签名被拒。
--     B. 对象 owner 字段未被纳入判断。owner 是 Storage 在 INSERT 时
--        由服务端写入的真实上传者，比客户端传入的路径前缀更可信。
--
-- 修复策略：
--   1. 保留「自己的命名空间」精确匹配（性能最好，走索引）。
--   2. 新增「对象 owner = auth.uid()」分支 —— 覆盖上传者本人，
--      即使路径前缀与当前会话 uid 不一致（多账号/历史数据）也能签名。
--   3. 保留「反查 messages」兜底 —— 覆盖接收方读取对方媒体。
--   4. 反查分支同时兼容「相对路径」与「历史完整 URL」两种存储形态。
--
-- 安全性说明：
--   本迁移只放宽「读取」范围，且放宽的边界严格限定为
--   「对象由我上传」或「我是该消息的发送方/接收方」，
--   不会导致任何用户可读取他人私密媒体。
-- ============================================================================

DROP POLICY IF EXISTS "chat_media_participants_select" ON storage.objects;

CREATE POLICY "chat_media_participants_select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'chat_media'
  AND (
    -- ① 自己的命名空间：路径首段即当前用户 id（新数据，走 btree 索引）
    (storage.foldername(name))[1] = auth.uid()::text

    -- ② 对象 owner 即当前用户：覆盖多账号切换 / 路径前缀与会话不一致的场景
    OR owner = auth.uid()

    -- ③ 兜底：我是该消息的发送方或接收方
    OR EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE (m.user_id = auth.uid() OR m.receiver_id = auth.uid())
        AND (
          -- 新数据：media_url 存相对对象路径，精确匹配
          m.media_url = storage.objects.name
          OR m.thumbnail_url = storage.objects.name
          -- 历史数据：media_url 可能仍是完整签名/公开 URL，用后缀匹配兜底
          OR m.media_url LIKE '%/' || storage.objects.name
          OR m.thumbnail_url LIKE '%/' || storage.objects.name
        )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 诊断查询（可选，手动执行以确认策略生效）
-- ---------------------------------------------------------------------------
-- 1) 查看 chat_media 当前所有策略
--   SELECT policyname, cmd, qual
--   FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects'
--     AND qual LIKE '%chat_media%';
--
-- 2) 确认某个对象是否存在及其 owner
--   SELECT name, owner, bucket_id, created_at
--   FROM storage.objects
--   WHERE bucket_id = 'chat_media'
--   ORDER BY created_at DESC
--   LIMIT 20;
--
-- 3) 确认当前会话 uid
--   SELECT auth.uid();
-- ============================================================================
-- --- END OF FILE supabase/migrations/17_修复chat_media签名读取策略_fix_signed_url_select_policy.sql ---
