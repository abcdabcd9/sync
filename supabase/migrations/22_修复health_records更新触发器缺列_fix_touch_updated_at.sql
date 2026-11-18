-- --- START OF FILE supabase/migrations/22_修复health_records更新触发器缺列_fix_touch_updated_at.sql ---
-- ============================================================================
-- TASK-P0.2 / Batch A：修复 health_records 的 UPDATE 触发器缺列缺陷
-- ============================================================================
-- 缺陷来源（历史迁移，非本次引入）：
--   07_补齐5张核心表_create_core_tables.sql 第 152-164 行：
--     · 定义 touch_updated_at()，函数体硬编码 NEW.updated_at
--     · 在 health_records 上挂 BEFORE UPDATE 触发器调用它
--   但同一迁移第 132-139 行建 health_records 时**没有 updated_at 列**
--   （实际列：id / user_id / record_date / water_amount / meals_status / created_at）。
--
-- 后果：
--   任何对 health_records 的 UPDATE 都会抛
--     record "new" has no field "updated_at"  (SQLSTATE 42703)
--   即「更新今天的饮水量 / 餐食状态」在服务端必然失败。
--   之所以线上没被大面积发现，是因为 useHealthCloud.js 走的是
--   upsert（INSERT ... ON CONFLICT DO UPDATE）—— 首次插入不触发 BEFORE UPDATE，
--   只有真正命中冲突走 UPDATE 分支时才会踩到。
--
-- 修复方式（不改历史迁移，只做向前修复）：
--   1. 给 health_records 补上 updated_at 列（与迁移 07 的意图一致）。
--   2. 让 touch_updated_at() 对「没有 updated_at 列的表」安全跳过，
--      避免未来再有表误挂该触发器时静默失败。
--
-- 幂等性：ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE。
-- 不修改任何历史迁移文件。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 补列
-- ---------------------------------------------------------------------------
ALTER TABLE public.health_records
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT timezone('utc', now());

COMMENT ON COLUMN public.health_records.updated_at IS
  '最后更新时间，由 health_records_touch_updated_at 触发器自动维护。';

-- 回填历史行的 updated_at（用 created_at 兜底，避免 NULL）
UPDATE public.health_records
SET updated_at = COALESCE(updated_at, created_at, timezone('utc', now()))
WHERE updated_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. 让 touch_updated_at() 对缺列的表安全跳过
-- ---------------------------------------------------------------------------
-- 用 to_jsonb(NEW) 判断列是否存在，避免直接引用 NEW.updated_at 触发 42703。
-- 这样即使将来有表误挂该触发器，也只是不更新时间戳，而不是让整条 UPDATE 失败。
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF to_jsonb(NEW) ? 'updated_at' THEN
    NEW.updated_at = timezone('utc', now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. 自检（执行后可单独运行）
-- ---------------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='health_records'
--     AND column_name='updated_at';
-- 期望：返回 1 行。
--
-- UPDATE public.health_records SET water_amount = water_amount
--   WHERE user_id = auth.uid() AND record_date = current_date;
-- 期望：不再报 record "new" has no field "updated_at"。

-- --- END OF FILE supabase/migrations/22_修复health_records更新触发器缺列_fix_touch_updated_at.sql ---
