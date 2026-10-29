// --- START OF FILE supabase/functions/send-push/index.ts ---
/**
 * Edge Function: send-push
 *
 * 安全推送网关。客户端不再直接持有/调用 Expo Push API，
 * 也不再自行查询他人的 expo_push_token。
 *
 * 请求体：
 *   { targetUserId: string, title: string, body: string, data?: Record<string, unknown> }
 *
 * 安全模型：
 *   1. 必须携带有效 JWT（Authorization: Bearer <access_token>）
 *   2. 由服务端解析 JWT 得到 sender，绝不信任客户端传来的 senderId
 *   3. 校验 sender 与 target 存在社交关系（好友 / 健康搭子 / 会话关系）
 *   4. 目标用户的 expo_push_token 只在服务端读取，绝不下发到客户端
 *
 * 部署：
 *   npx supabase functions deploy send-push
 *
 * 环境变量（Supabase 自动注入，无需手动配置）：
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface PushPayload {
  targetUserId?: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** 校验字符串字段：非空、长度受限 */
function isValidText(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

/**
 * 去除文本中的 Emoji / 变体选择符 / 零宽连接符 / 区域指示符，
 * 保证推送 title 与 body 100% 为纯文字。
 * 覆盖范围：Emoji 主区、杂项符号、装饰符号、箭头、变体选择符、ZWJ、肤色修饰符、旗帜。
 */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE00}-\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

function stripEmoji(input: string): string {
  return input.replace(EMOJI_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/** 判断是否为「无效昵称」：空 / 纯数字 / 通用占位词 */
const INVALID_NAME_TOKENS = new Set(['聊天', '新消息', 'TA', 'ta', 'Ta', '未知用户', '用户', 'undefined', 'null']);
function isInvalidName(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return true; // 纯数字（如 '1'）
  return INVALID_NAME_TOKENS.has(s);
}

/**
 * 解析发送者展示昵称（服务端权威，绝不信任客户端）：
 *   1. profiles.nickname
 *   2. profiles.username（若为邮箱则截取 @ 前用户名）
 *   3. 兜底 '健康搭子'
 */
function resolveSenderNickname(nickname: unknown, username: unknown): string {
  const nick = typeof nickname === 'string' ? stripEmoji(nickname.trim()) : '';
  if (!isInvalidName(nick)) return nick.slice(0, 60);

  const uname = typeof username === 'string' ? stripEmoji(username.trim()) : '';
  if (uname) {
    const localPart = uname.includes('@') ? uname.split('@')[0] : uname;
    if (!isInvalidName(localPart)) return localPart.slice(0, 60);
  }
  return '健康搭子';
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ---- CORS 预检 ----
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // ---- 1. 校验调用者 JWT ----
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing or malformed Authorization header' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('send-push: 缺少必要的环境变量');
    return json({ error: 'Server misconfigured' }, 500);
  }

  // 用调用者的 JWT 建客户端，getUser 会向 Auth 服务验证签名与有效期
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  const senderId = userData.user.id;

  // ---- 2. 解析并校验请求体 ----
  let payload: PushPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { targetUserId, body, data } = payload;

  if (!isValidText(targetUserId, 64)) {
    return json({ error: 'targetUserId is required' }, 400);
  }
  // ⚠️ title 不再由客户端决定（客户端传什么都会被服务端覆盖），因此不再强制校验
  if (!isValidText(body, 500)) {
    return json({ error: 'body is required (max 500 chars)' }, 400);
  }
  if (targetUserId === senderId) {
    return json({ error: 'Cannot push to yourself' }, 400);
  }

  // 使用 service_role 客户端做特权读取（绕过 RLS，但仅限服务端）
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- 3. 权限校验：sender 与 target 必须存在社交关系 ----
  // 同时取出 sender 的昵称，用于服务端覆盖推送标题（前端不再硬编码 'TA'）
  const { data: relation, error: relationError } = await adminClient
    .from('profiles')
    .select('id, bound_partner_id, nickname, username')
    .eq('id', senderId)
    .single();

  if (relationError || !relation) {
    return json({ error: 'Sender profile not found' }, 403);
  }

  // 🔑 推送标题以「发送者真实昵称」为准，客户端传入的 title 一律丢弃
  const senderProfile = relation as {
    id: string;
    bound_partner_id: string | null;
    nickname: string | null;
    username: string | null;
  };
  const senderNickname = resolveSenderNickname(senderProfile.nickname, senderProfile.username);

  let allowed = relation.bound_partner_id === targetUserId;

  if (!allowed) {
    // 反向绑定：对方把我设为搭子
    const { data: reverse } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', targetUserId)
      .eq('bound_partner_id', senderId)
      .maybeSingle();
    allowed = Boolean(reverse);
  }

  if (!allowed) {
    // 好友关系表（若存在）
    const { data: friendship } = await adminClient
      .from('friends')
      .select('id')
      .or(
        `and(user_id.eq.${senderId},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${senderId})`
      )
      .limit(1);
    allowed = Array.isArray(friendship) && friendship.length > 0;
  }

  if (!allowed) {
    return json({ error: 'Not authorized to push to this user' }, 403);
  }

  // ---- 4. 服务端查询目标用户的 Push Token ----
  const { data: targetProfile, error: targetError } = await adminClient
    .from('profiles')
    .select('expo_push_token')
    .eq('id', targetUserId)
    .single();

  if (targetError || !targetProfile) {
    return json({ error: 'Target profile not found' }, 404);
  }

  const pushToken: string | null = targetProfile.expo_push_token ?? null;
  if (!pushToken) {
    // 对方未开启通知，属正常情况，不视为错误
    return json({ ok: true, skipped: true, reason: 'target has no push token' });
  }

  // ---- 5. 服务端发起真正的推送 ----
  // 🔒 载荷统一：title 与 data.targetName 一律由服务端权威覆盖，
  //    客户端传入的任何 title / targetName（'聊天'、'1'、'TA' 等）全部丢弃。
  const safeData: Record<string, unknown> = { ...(data ?? {}) };
  safeData.targetName = senderNickname; // 点击跳转时携带的真实昵称
  if (!safeData.targetId) safeData.targetId = senderId; // 兜底：跳转目标会话的对方 ID

  // 🚫 纯文字策略：title 与 body 一律剥离 Emoji，确保通知栏 100% 无表情符号
  const safeTitle = stripEmoji(senderNickname) || '健康搭子';
  const safeBody = stripEmoji(body) || '新消息';

  const expoMessage = {
    to: pushToken,
    sound: 'default',
    title: safeTitle, // 通知栏大字永远是发件人昵称（已去 Emoji）
    body: safeBody, // body 只保留纯文字内容（已去 Emoji）
    data: safeData,
  };

  try {
    const expoRes = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(expoMessage),
    });

    const expoJson = await expoRes.json().catch(() => null);

    if (!expoRes.ok) {
      console.error('send-push: Expo API 返回错误', expoRes.status, expoJson);
      return json({ error: 'Expo push failed', status: expoRes.status }, 502);
    }

    // Expo 会在 200 响应体里返回 ticket 级错误（如 DeviceNotRegistered）
    const ticket = expoJson?.data;
    if (ticket?.status === 'error') {
      console.warn('send-push: Expo ticket 错误', ticket);
      // Token 失效时清理，避免后续无效推送
      if (ticket?.details?.error === 'DeviceNotRegistered') {
        await adminClient
          .from('profiles')
          .update({ expo_push_token: null })
          .eq('id', targetUserId);
      }
      return json({ ok: false, error: ticket.message ?? 'Push ticket error' }, 200);
    }

    return json({ ok: true, ticketId: ticket?.id ?? null });
  } catch (e) {
    console.error('send-push: 网络异常', e);
    return json({ error: 'Failed to reach Expo push service' }, 502);
  }
});
// --- END OF FILE supabase/functions/send-push/index.ts ---
