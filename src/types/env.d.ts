/**
 * Expo 公开环境变量类型声明（TASK-P1.2 R4）
 *
 * 背景：
 *   Expo 在打包时会把 `process.env.EXPO_PUBLIC_*` 静态内联进客户端产物。
 *   Metro 运行时确实提供全局 `process`（见 `expo/types/metro-require.d.ts`），
 *   但该文件未纳入本仓库 tsconfig 的 include，且项目未声明 `@types/node`，
 *   因此 TS 无法识别 `process`。
 *
 * 处理原则：
 *   - 不引入 `@types/node`（会污染 RN 环境、引入 Node 专属全局）；
 *   - 不修改 tsconfig include / 不新增 exclude；
 *   - 仅声明本项目实际使用的公开环境变量，保持最小面。
 *
 * 注意：`EXPO_PUBLIC_*` 属于"公开配置"，会被内联进客户端产物，
 *       严禁在此声明或放置服务端私密密钥（如 service_role key）。
 */
declare const process: {
  env: {
    /** Supabase 项目 URL（公开配置） */
    readonly EXPO_PUBLIC_SUPABASE_URL?: string;
    /** Supabase anon key（公开配置，受 RLS 保护） */
    readonly EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
    /** 其余 Expo 公开变量按需扩展 */
    readonly [key: string]: string | undefined;
  };
};
