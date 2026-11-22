/**
 * 健康数据契约（TASK-P1.1 R0 — Phase B3 校正）
 *
 * 依据（逐字段核对，非猜测）：
 *   - `health_records` 表：bootstrap 第 148–155 行 + migration 07 第 132–139 行
 *     + migration 22（补 `updated_at`）
 *   - `src/hooks/health/useHealthCloud.js` 第 604–614 行（pending payload 真实字段）
 *   - `src/hooks/health/useHealthCloud.js` 第 459–466 行（upsert 写入列）
 *   - `src/hooks/health/useHealthStorage.js` 第 74–81 行（本地 state 初始值）
 *   - `src/hooks/health/constants.ts`（DEFAULT_MEALS 是**文案**，不是布尔）
 *
 * ⚠️ 关键校正（相对上一版）：
 *   1. `HealthPendingEntry.updatedAt` 是 `Date.now()` 的**毫秒数字**，不是字符串。
 *   2. pending 条目真实还带 `bootId` / `opSeq` / `opId` 三个操作身份字段
 *      （见 useHealthCloud 第 604–614 行），上一版完全缺失。
 *   3. `DEFAULT_MEALS`（`mealGuides`）是 `Record<string, string>` 的**指南文案**，
 *      与 `mealsStatus`（`Record<string, boolean>` 完成状态）是**两个不同概念**，
 *      上一版未区分。
 *   4. `health_records.water_amount` / `meals_status` / `updated_at` 在 DB 层
 *      均可空（有 DEFAULT 但非 NOT NULL），Row 类型如实反映。
 */

import type { HealthRecordsRow } from './database';

/**
 * 三餐完成状态（`mealsStatus`）。
 *
 * 键为餐次标识（`'早餐' | '午餐' | '晚餐'`），值为是否完成。
 * 真实来源：`useHealthCloud.js` 的 `EMPTY_MEALS` 与 `health_records.meals_status` JSONB。
 */
export type MealsStatus = Record<string, boolean>;

/**
 * 三餐饮食指南文案（`mealGuides`）。
 *
 * 键为餐次标识，值为指南文本。
 * 真实来源：`src/hooks/health/constants.ts#DEFAULT_MEALS`（值是长文案字符串）。
 *
 * ⚠️ 与 `MealsStatus` 是**不同概念**：这里是文案，那里是布尔完成状态。
 */
export type MealGuides = Record<string, string>;

/** 单日饮水 / 饮食记录（本地存储形态） */
export interface HealthDayRecord {
  /** 日期，格式 YYYY-MM-DD */
  recordDate: string;
  /** 饮水量（毫升） */
  water: number;
  /** 各餐完成状态，键为餐次标识 */
  meals: MealsStatus;
}

/**
 * `health_records` 表行（生产库权威结构）。
 *
 * ⚠️ 权威定义在 `database.ts#HealthRecordsRow`，此处**别名**引用，避免两处漂移。
 *
 * 列：id, user_id, record_date, water_amount, meals_status, updated_at
 *   - NOT NULL：id / user_id / record_date
 *   - 可空（有 DEFAULT）：water_amount / meals_status / updated_at
 *
 * 注意：`meals_status` 在 database.ts 中为 `unknown`（JSONB 不假设元素类型），
 * 客户端如需按 `MealsStatus` 使用，应显式收窄（见 `MealsStatus`）。
 */
export type HealthRecordRow = HealthRecordsRow;

/**
 * 云端同步的 pending 条目（`useHealthCloud` 本地队列结构）。
 *
 * 真实来源：`useHealthCloud.js` 第 604–614 行 `payload` 对象。
 * 键：`@sync_health_pending_v1_${ownerId}`
 *
 * 操作身份字段（bootId / opSeq / opId）用于跨进程重启后的入队仲裁：
 *   - `bootId`：本次进程启动标识（惰性生成）
 *   - `opSeq`：进程内严格单调序号
 *   - `opId`：`${bootId}-${opSeq}` 全局唯一操作 id
 */
export interface HealthPendingEntry {
  recordDate: string;
  water: number;
  meals: MealsStatus;
  ownerId: string;
  /** 修订号，用于冲突判定 */
  rev: number;
  /** 毫秒时间戳（`Date.now()`） */
  updatedAt: number;
  /** 进程启动标识 */
  bootId: string;
  /** 进程内单调序号 */
  opSeq: number;
  /** 全局唯一操作 id：`${bootId}-${opSeq}` */
  opId: string;
}

/** 打卡 / 连续天数状态（本地存储） */
export interface StreakState {
  /** 当前连续天数 */
  current: number;
  /** 历史最长连续天数 */
  longest: number;
  /** 最近一次打卡日期 YYYY-MM-DD */
  lastCheckInDate: string | null;
}

/** 健康本地存储键后缀（与 `useHealthStorage` 一致） */
export type HealthStorageSuffix =
  | 'water'
  | 'meals'
  | 'maxWater'
  | 'motto'
  | 'guides'
  | 'streak'
  | 'checkIn'
  | 'active';

/** 构造健康本地存储键（纯函数，与实现规则一致） */
export function healthStorageKey(userId: string, suffix: HealthStorageSuffix): string {
  return `@sync_health_v2_${userId}_${suffix}`;
}

/** 构造 pending 队列存储键（纯函数，与实现规则一致） */
export function healthPendingKey(ownerId: string): string {
  return `@sync_health_pending_v1_${ownerId}`;
}
