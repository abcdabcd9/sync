/**
 * 类型契约统一出口（TASK-P1.1 R0）
 *
 * 用法：`import type { ProfileRow, ChatMessage } from '@/types';`
 * 或相对路径 `import type { ... } from '../types';`
 *
 * 注意：本文件只做 re-export，不包含任何运行时代码逻辑。
 *
 * 分层（Phase D）：
 *   - 基础：result
 *   - 身份/认证：auth、user
 *   - 领域：social、chat、health、cinema、browser、push
 *   - 数据层：database（12 张表 Row/Insert/Update）、rpc（客户端/内部 RPC）
 *   - 存储/媒体：media、cache
 *   - 设置/主题：settings
 *   - 服务边界：transcription、edge
 *   - 导航：navigation
 */

/* 基础 */
export * from './result';

/* 身份 / 认证 */
export * from './auth';
export * from './user';

/* 领域 */
export * from './social';
export * from './chat';
export * from './health';
export * from './cinema';
export * from './browser';
export * from './push';

/* 数据层 */
export * from './database';
export * from './rpc';

/* 存储 / 媒体 */
export * from './media';
export * from './cache';

/* 设置 / 主题 */
export * from './settings';

/* 服务边界 */
export * from './transcription';
export * from './edge';

/* 导航 */
export * from './navigation';
