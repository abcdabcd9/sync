-- --- START OF FILE supabase/migrations/06_核心表启用RLS基线_enable_all_rls.sql ---
-- ============================================================================
-- 安全防线 P0：为核心业务表补齐 RLS（行级安全策略）
-- ============================================================================
-- 覆盖表：profiles / messages / health_records / friends / complaints / moments
--
-- 本迁移相对「初版草案」的修正点（均已对照前端真实调用核对）：
--   1. complaints 表实际列名为 reporter_id（非 user_id），策略已修正。
--   2. moments 表实际列名为 author_id（非 user_id），策略已修正。
--   3. messages 已读回执：前端会把「对方发给我」的消息置为已读
--      （useChatMessages: update is_read where user_id=对方 and receiver_id=我），
--      因此额外增加一条「接收方可更新已读状态」的 UPDATE 策略，
--      否则已读回执会被静默拦截。
--   4. health_records 的 FOR ALL 补齐 WITH CHECK，防止 INSERT 越权写入他人记录。
--   5. moments 的 SELECT 不再无脑 USING(true)，改为按 visibility 收紧：
--      - 公开(all) 所有人可读
--      - 好友可见(friends) 仅作者的好友可读
--      - 私密(private) 仅作者本人可读
--      避免直接调用 API 绕过前端过滤读取私密动态。
--   6. friends 的 FOR ALL 拆分为 SELECT / INSERT / UPDATE / DELETE，
--      允许「双向」删除与更新备注（前端 delete 使用 or(user_id, friend_id)）。
--   7. complaints / moments 增加 CREATE TABLE IF NOT EXISTS 建表语句，
--      避免表尚未创建时 ALTER TABLE ... ENABLE RLS 直接报错；
--      其余表（profiles/messages/health_records/friends）为既有核心表，
--      由早期迁移创建，此处仅启用 RLS。
--
-- 说明：
--   - 所有策略均先 DROP POLICY IF EXISTS，保证可重复执行（幂等）。
--   - SECURITY DEFINER 函数（如 unbind_partner）以函数属主身份运行，
--     不受本文件 RLS 限制，双向解绑逻辑不受影响。
--   - service_role（如 send-push 云函数）默认绕过 RLS，不受影响。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles：所有人可读（用于搜索 sync_id / 展示昵称头像），仅本人可改
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles;
CREATE POLICY "profiles_select_all"
ON public.profiles
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
ON public.profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- 2. messages：仅收发双方可读；发送方可增删改；接收方可更新已读状态
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_select_participants" ON public.messages;
CREATE POLICY "messages_select_participants"
ON public.messages
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR auth.uid() = receiver_id);

DROP POLICY IF EXISTS "messages_insert_own" ON public.messages;
CREATE POLICY "messages_insert_own"
ON public.messages
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- 发送方可更新自己的消息（撤回、改写 subtype 等）
DROP POLICY IF EXISTS "messages_update_own" ON public.messages;
CREATE POLICY "messages_update_own"
ON public.messages
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- 接收方可把「发给自己的消息」标记为已读（is_read 回执）
-- 仅允许改 is_read 字段由应用层保证，RLS 层面放行该行更新。
DROP POLICY IF EXISTS "messages_update_receiver_read" ON public.messages;
CREATE POLICY "messages_update_receiver_read"
ON public.messages
FOR UPDATE
TO authenticated
USING (auth.uid() = receiver_id)
WITH CHECK (auth.uid() = receiver_id);

DROP POLICY IF EXISTS "messages_delete_own" ON public.messages;
CREATE POLICY "messages_delete_own"
ON public.messages
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. health_records：本人可读写；伴侣可读（通过 bound_partner_id 关联）
-- ---------------------------------------------------------------------------
ALTER TABLE public.health_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "health_records_select_own_or_partner" ON public.health_records;
CREATE POLICY "health_records_select_own_or_partner"
ON public.health_records
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.bound_partner_id = health_records.user_id
  )
);

-- 本人可增删改自己的记录（WITH CHECK 防止伪造 user_id 写入他人记录）
DROP POLICY IF EXISTS "health_records_manage_own" ON public.health_records;
CREATE POLICY "health_records_manage_own"
ON public.health_records
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4. friends：双方均可读；本人可新增；双方均可改备注/删除（双向关系）
-- ---------------------------------------------------------------------------
ALTER TABLE public.friends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friends_select_participants" ON public.friends;
CREATE POLICY "friends_select_participants"
ON public.friends
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR auth.uid() = friend_id);

-- 只能以自己为 user_id 建立好友关系
DROP POLICY IF EXISTS "friends_insert_own" ON public.friends;
CREATE POLICY "friends_insert_own"
ON public.friends
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- 双向更新（备注 remark 等）：任一方均可更新该关系行
DROP POLICY IF EXISTS "friends_update_participants" ON public.friends;
CREATE POLICY "friends_update_participants"
ON public.friends
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id OR auth.uid() = friend_id)
WITH CHECK (auth.uid() = user_id OR auth.uid() = friend_id);

-- 双向删除：任一方均可解除好友关系
DROP POLICY IF EXISTS "friends_delete_participants" ON public.friends;
CREATE POLICY "friends_delete_participants"
ON public.friends
FOR DELETE
TO authenticated
USING (auth.uid() = user_id OR auth.uid() = friend_id);

-- ---------------------------------------------------------------------------
-- 5. complaints：建表（若不存在）+ 仅允许本人提交（reporter_id），不开放读取
-- ---------------------------------------------------------------------------
-- 说明：
--   - 使用 IF NOT EXISTS，若表已存在则跳过，不会覆盖既有数据。
--   - reporter_id 默认取 auth.uid()，即使前端漏传也会落到当前登录用户。
--   - ON DELETE CASCADE：举报人注销后其举报记录一并清理。
CREATE TABLE IF NOT EXISTS public.complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE DEFAULT auth.uid(),
  target_id UUID,
  reason TEXT,
  content TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT clock_timestamp()
);

ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "complaints_insert_own" ON public.complaints;
CREATE POLICY "complaints_insert_own"
ON public.complaints
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = reporter_id);

-- ---------------------------------------------------------------------------
-- 6. moments：建表（若不存在）+ 按 visibility 收紧读取；作者可增删改自己的动态
-- ---------------------------------------------------------------------------
-- 说明：
--   - 使用 IF NOT EXISTS，若表已存在则跳过，不会覆盖既有数据。
--   - 列定义与前端 src/app/chat/moments.js 的查询字段保持一致
--     （author_id / content / images / visibility / created_at）。
CREATE TABLE IF NOT EXISTS public.moments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE DEFAULT auth.uid(),
  content TEXT,
  images JSONB DEFAULT '[]'::jsonb,
  visibility TEXT DEFAULT 'all',
  created_at TIMESTAMPTZ DEFAULT clock_timestamp()
);

ALTER TABLE public.moments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "moments_select_visible" ON public.moments;
CREATE POLICY "moments_select_visible"
ON public.moments
FOR SELECT
TO authenticated
USING (
  -- 作者本人始终可读
  auth.uid() = author_id
  -- 公开动态：所有人可读
  OR visibility = 'all'
  -- 好友可见：仅作者的好友可读
  OR (
    visibility = 'friends'
    AND EXISTS (
      SELECT 1
      FROM public.friends f
      WHERE (f.user_id = auth.uid() AND f.friend_id = moments.author_id)
         OR (f.friend_id = auth.uid() AND f.user_id = moments.author_id)
    )
  )
);

DROP POLICY IF EXISTS "moments_manage_own" ON public.moments;
CREATE POLICY "moments_manage_own"
ON public.moments
FOR ALL
TO authenticated
USING (auth.uid() = author_id)
WITH CHECK (auth.uid() = author_id);

-- ============================================================================
-- 回滚说明（如需临时恢复旧行为，请谨慎评估风险）：
--   ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.health_records DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.friends DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.complaints DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.moments DISABLE ROW LEVEL SECURITY;
--   （对应 DROP POLICY IF EXISTS ... 亦可单独移除某条策略）
--   本迁移新建的 complaints / moments 表如需彻底回滚，需额外执行
--   DROP TABLE IF EXISTS public.complaints;
--   DROP TABLE IF EXISTS public.moments;
--   （会连同表内数据一并删除，请先备份）
-- ============================================================================
-- --- END OF FILE supabase/migrations/06_核心表启用RLS基线_enable_all_rls.sql ---
