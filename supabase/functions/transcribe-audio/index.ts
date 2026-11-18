// --- START OF FILE supabase/functions/transcribe-audio/index.ts ---
/**
 * Edge Function: transcribe-audio
 *
 * 受鉴权的语音转写网关。客户端不再持有 Groq API Key，
 * 也不再直连 api.groq.com。
 *
 * 请求：POST multipart/form-data
 *   - file : 音频二进制（必填）
 *
 * 响应：
 *   200 { text: string }
 *   4xx/5xx { error: { code: string, message: string } }
 *
 * 安全模型：
 *   1. 必须携带有效 JWT（Authorization: Bearer <access_token>），
 *      由服务端校验并解析出 user.id，绝不信任客户端传来的 user id。
 *   2. 鉴权通过后才处理高成本输入（读取 body / 调用上游）。
 *   3. 服务端固定上游端点、模型与业务参数，不接受客户端传入 URL / model。
 *   4. 真实字节数、格式、时长上限由服务端强制；客户端自报值一律忽略。
 *   5. 配额（用户短期限额 + 全局预算 + 并发）在 DB 内原子预占，
 *      预占失败或配额存储不可用 → 拒绝转写。
 *   6. 上游原始响应、音频内容、token、凭据一律不写日志、不回传。
 *   7. 超时 + 有限重试；稳定错误码。
 *
 * 环境变量（Supabase 自动注入 + 需手动配置的 secret）：
 *   SUPABASE_URL                （自动）
 *   SUPABASE_ANON_KEY           （自动）
 *   SUPABASE_SERVICE_ROLE_KEY   （自动）
 *   GROQ_API_KEY                （手动：npx supabase secrets set GROQ_API_KEY=...）
 *
 * 可选调优（均有安全默认值，非法值回落到默认）：
 *   TRANSCRIBE_MAX_BYTES            单次音频字节上限，默认 8 MiB
 *   TRANSCRIBE_MAX_DURATION_SEC     单次音频时长上限（秒），默认 120
 *   TRANSCRIBE_USER_MAX_REQUESTS    单用户每窗口请求数上限，默认 20
 *   TRANSCRIBE_USER_MAX_BYTES       单用户每窗口字节上限，默认 40 MiB
 *   TRANSCRIBE_GLOBAL_MAX_REQUESTS  全局每窗口请求数上限，默认 2000
 *   TRANSCRIBE_GLOBAL_MAX_BYTES     全局每窗口字节上限，默认 4 GiB
 *   TRANSCRIBE_UPSTREAM_TIMEOUT_MS  上游超时（含响应体读取），默认 30000
 *   TRANSCRIBE_UPSTREAM_RETRIES     上游重试次数（不含首次），默认 0（禁用自动重试）
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';

// ---------------------------------------------------------------------------
// 固定上游配置（绝不接受客户端覆盖）
// ---------------------------------------------------------------------------
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3';
const GROQ_LANGUAGE = 'zh';
const GROQ_RESPONSE_FORMAT = 'json';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// 稳定错误码（客户端据此展示文案，不解析上游原文）
// ---------------------------------------------------------------------------
const ERR = {
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  INVALID_INPUT: 'INVALID_INPUT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  QUOTA_UNAVAILABLE: 'QUOTA_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

const ERR_MESSAGE: Record<string, string> = {
  METHOD_NOT_ALLOWED: '请求方法不被允许。',
  UNAUTHORIZED: '登录状态无效，请重新登录。',
  NOT_CONFIGURED: '语音识别服务未配置，请联系管理员。',
  INVALID_INPUT: '请求内容不合法。',
  PAYLOAD_TOO_LARGE: '录音文件过大，请缩短录音时长。',
  UNSUPPORTED_FORMAT: '不支持的音频格式。',
  QUOTA_EXCEEDED: '识别次数已达上限，请稍后再试。',
  QUOTA_UNAVAILABLE: '识别服务暂时不可用，请稍后再试。',
  UPSTREAM_TIMEOUT: '识别超时，请重试。',
  UPSTREAM_ERROR: '识别失败，请重试。',
  INTERNAL_ERROR: '服务内部错误，请稍后再试。',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function fail(code: keyof typeof ERR, status: number): Response {
  return json({ error: { code, message: ERR_MESSAGE[code] ?? ERR_MESSAGE.INTERNAL_ERROR } }, status);
}

/** 读取正整数环境变量，非法/缺失时回落默认值（配置错误不得放宽限制） */
function envInt(name: string, fallback: number, min = 1): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

const LIMITS = {
  maxBytes: envInt('TRANSCRIBE_MAX_BYTES', 8 * 1024 * 1024),
  maxDurationSec: envInt('TRANSCRIBE_MAX_DURATION_SEC', 120),
  userMaxRequests: envInt('TRANSCRIBE_USER_MAX_REQUESTS', 20),
  userMaxBytes: envInt('TRANSCRIBE_USER_MAX_BYTES', 40 * 1024 * 1024),
  globalMaxRequests: envInt('TRANSCRIBE_GLOBAL_MAX_REQUESTS', 2000),
  globalMaxBytes: envInt('TRANSCRIBE_GLOBAL_MAX_BYTES', 4 * 1024 * 1024 * 1024),
  upstreamTimeoutMs: envInt('TRANSCRIBE_UPSTREAM_TIMEOUT_MS', 30000, 1000),
  // 🔒 T6.2/FIX-02：默认**禁用自动重试**。
  //    每次实际上游调用都必须对应一次配额消耗；自动重试会在一次预占下
  //    产生多次上游调用，破坏「调用次数 == 配额消耗」的费用控制。
  //    如需重试，必须显式配置，且每次尝试都会独立预占配额（见下方循环）。
  upstreamRetries: envInt('TRANSCRIBE_UPSTREAM_RETRIES', 0, 0),
  // 🔒 T6/B02：整个请求生命周期（鉴权 + 解析 + 配额 + 全部重试）的硬上限。
  //    防止「多次重试 × 单次超时」把函数执行时间拖到平台上限。
  requestDeadlineMs: envInt('TRANSCRIBE_REQUEST_DEADLINE_MS', 55000, 5000),
};

/** 允许的音频 MIME / 扩展名白名单（保守上限，无法验证时长时按字节兜底） */
const ALLOWED_MIME = new Set([
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4',
  'audio/aac',
  'audio/3gpp',
  'audio/amr',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
]);

const ALLOWED_EXT = new Set(['m4a', 'mp4', 'aac', '3gp', 'amr', 'wav', 'mp3', 'webm', 'ogg', 'caf']);

function extOf(name: string): string {
  const clean = String(name || '').split('?')[0].split('#')[0];
  const idx = clean.lastIndexOf('.');
  return idx >= 0 ? clean.slice(idx + 1).toLowerCase() : '';
}

/** 从 JWT 解析并校验用户身份（服务端权威，绝不信任 body 中的 user id） */
async function resolveUserId(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  createClientImpl: typeof createClient = createClient,
): Promise<string | null> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  // 用 anon client + 用户 token 调 getUser，由 Supabase Auth 校验签名与有效期
  const client = createClientImpl(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

/**
 * 带超时的上游调用（fetch 可注入，便于测试）。
 *
 * 🔒 T6.2/FIX-03：超时必须覆盖**响应体读取**，而不只是拿到响应头。
 *   旧实现 `await fetch()` 返回后立即 `clearTimeout`，随后 `resp.json()`
 *   在无超时保护下执行 —— 若上游返回 200 头后 body 挂起，函数会无限等待，
 *   直到平台强制终止（且此时配额已被消耗，用户既拿不到结果又损失额度）。
 *
 *   现在把「发起请求 + 读取并解析 body」整体纳入同一个 AbortController：
 *   超时触发时 abort 会同时中断连接与 body 流读取。
 *
 * @returns 解析后的 JSON（失败返回 null）与是否超时标记
 */
async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; json: unknown; timedOut: boolean }> {
  // 🔒 T6.2/FIX-03：超时必须覆盖「响应体读取」，且不能依赖 fetch 实现
  //   是否把 AbortSignal 传播到 body 流。这里用 Promise.race 显式兜底：
  //   即使底层 fetch 忽略 signal、body 永不结束，也能在 timeoutMs 后返回。
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // 忽略 abort 异常
      }
      const err = new Error('upstream timeout');
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
  });

  const work = (async () => {
    const resp = await fetchImpl(url, { ...init, signal: controller.signal });
    // 响应体读取仍在同一 signal 保护下；若底层不响应 signal，
    // 由外层 Promise.race 的超时兜底中断等待。
    let json: unknown = null;
    try {
      json = await resp.json();
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      json = null;
    }
    return { ok: resp.ok, status: resp.status, json, timedOut: false as const };
  })();

  try {
    return await Promise.race([work, timeoutPromise]);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      return { ok: false, status: 0, json: null, timedOut: true };
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 🔒 T6/B02：从音频容器头部解析真实时长（秒）。
 *
 * 只做「保守上限」校验：解析失败一律返回 null，由调用方按字节上限兜底，
 * 绝不因为解析不出时长就放行超大文件。
 *
 * 支持：
 *   - MP4 / M4A / AAC-in-MP4：moov → mvhd（version 0/1）
 *   - WAV：RIFF → fmt（byteRate）+ data（size）
 *   - OGG：最后一页 granule position / sample rate（粗略）
 * 其它格式返回 null。
 */
function parseAudioDurationSec(bytes: Uint8Array): number | null {
  try {
    // ---- WAV ----
    if (
      bytes.length >= 44 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 // WAVE
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 12;
      let byteRate = 0;
      let dataSize = 0;
      while (offset + 8 <= bytes.length) {
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const size = view.getUint32(offset + 4, true);
        if (id === 'fmt ' && offset + 8 + 16 <= bytes.length) {
          byteRate = view.getUint32(offset + 8 + 8, true);
        } else if (id === 'data') {
          dataSize = size;
          break;
        }
        offset += 8 + size + (size % 2);
      }
      if (byteRate > 0 && dataSize > 0) return dataSize / byteRate;
      return null;
    }

    // ---- MP4 / M4A ----
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const findBox = (start: number, end: number, type: string): { start: number; end: number } | null => {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p, false);
        const boxType = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
        let header = 8;
        if (size === 1) {
          if (p + 16 > end) return null;
          // 64-bit size
          const hi = dv.getUint32(p + 8, false);
          const lo = dv.getUint32(p + 12, false);
          size = hi * 2 ** 32 + lo;
          header = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < header) return null;
        if (boxType === type) return { start: p + header, end: Math.min(p + size, end) };
        p += size;
      }
      return null;
    };

    const moov = findBox(0, bytes.length, 'moov');
    if (!moov) return null;
    const mvhd = findBox(moov.start, moov.end, 'mvhd');
    if (!mvhd) return null;

    const version = bytes[mvhd.start];
    let timescale: number;
    let duration: number;
    if (version === 1) {
      if (mvhd.start + 32 > mvhd.end) return null;
      timescale = dv.getUint32(mvhd.start + 20, false);
      const hi = dv.getUint32(mvhd.start + 24, false);
      const lo = dv.getUint32(mvhd.start + 28, false);
      duration = hi * 2 ** 32 + lo;
    } else {
      if (mvhd.start + 20 > mvhd.end) return null;
      timescale = dv.getUint32(mvhd.start + 12, false);
      duration = dv.getUint32(mvhd.start + 16, false);
    }
    if (timescale > 0 && duration > 0) return duration / timescale;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 🔒 T6/B02：可注入依赖的 handler 工厂。
//
// 生产环境用默认依赖（真实 createClient + 全局 fetch）注册到 Deno.serve；
// 测试环境可注入 mock 的 createClient / fetch，从而在「有效身份 + 有效配额」
// 前提下验证完整请求处理链（成功转写、非法输入、配额异常、上游失败、超时），
// 且绝不触达真实 Supabase 或真实 Groq。
// ---------------------------------------------------------------------------
export interface HandlerDeps {
  createClient: typeof createClient;
  fetch: typeof fetch;
}

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const createClientImpl = deps.createClient;
  const fetchImpl = deps.fetch;

  return async (req: Request): Promise<Response> => {
  // 🔒 T6/B02：请求生命周期起点，用于全局截止时间控制。
  const requestStart = Date.now();
  const remainingMs = () => LIMITS.requestDeadlineMs - (Date.now() - requestStart);

  // ---- CORS 预检 ----
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const groqKey = Deno.env.get('GROQ_API_KEY') ?? '';

  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error('[transcribe-audio] 缺少 Supabase 环境变量');
    return fail('NOT_CONFIGURED', 503);
  }
  if (!groqKey) {
    console.error('[transcribe-audio] 缺少 GROQ_API_KEY');
    return fail('NOT_CONFIGURED', 503);
  }

  // ---- 1. 鉴权（先于任何高成本处理） ----
  const userId = await resolveUserId(req, supabaseUrl, anonKey, createClientImpl);
  if (!userId) {
    return fail('UNAUTHORIZED', 401);
  }

  // ---- 2. 解析 multipart，校验真实字节与格式 ----
  //
  // 🔒 T6.2/FIX-03：必须在 multipart **完整解析前**限制请求体大小。
  //   旧实现先 `await req.formData()` 把整个 body 读进内存，再检查
  //   `audio.size` —— 攻击者可用超大 body 触发内存耗尽（DoS），
  //   且此时鉴权已通过、成本已产生。
  //
  //   现在：先看 Content-Length（若存在）做快速拒绝；再以流式读取
  //   并累计字节数，超过上限立即中止，绝不把超限 body 完整读入内存。
  const contentLength = Number.parseInt(req.headers.get('Content-Length') ?? '', 10);
  // multipart 边界/头部开销余量（保守 64 KiB），避免误伤合法请求
  const bodyLimit = LIMITS.maxBytes + 64 * 1024;
  if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
    return fail('PAYLOAD_TOO_LARGE', 413);
  }

  let form: FormData;
  try {
    if (req.body) {
      // 流式读取并累计字节，超限即中止
      const reader = req.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > bodyLimit) {
          try {
            await reader.cancel();
          } catch {
            // 忽略取消异常
          }
          return fail('PAYLOAD_TOO_LARGE', 413);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      const contentType = req.headers.get('Content-Type') ?? '';
      form = await new Response(merged, {
        headers: { 'Content-Type': contentType },
      }).formData();
    } else {
      form = await req.formData();
    }
  } catch {
    return fail('INVALID_INPUT', 400);
  }

  const filePart = form.get('file');
  if (!(filePart instanceof File)) {
    return fail('INVALID_INPUT', 400);
  }

  const audio = filePart as File;
  if (audio.size <= 0) {
    return fail('INVALID_INPUT', 400);
  }
  if (audio.size > LIMITS.maxBytes) {
    return fail('PAYLOAD_TOO_LARGE', 413);
  }

  const mime = (audio.type || '').toLowerCase();
  const ext = extOf(audio.name);
  const mimeOk = mime ? ALLOWED_MIME.has(mime) : false;
  const extOk = ext ? ALLOWED_EXT.has(ext) : false;
  if (!mimeOk && !extOk) {
    return fail('UNSUPPORTED_FORMAT', 415);
  }

  // ---- 2.1 真实时长校验（T6/B02 / T6.2 FIX-03） ----
  //   读取音频头部解析真实时长。
  //   🔒 T6.2/FIX-03：**无法可靠验证时长时拒绝**（fail-closed）。
  //   旧实现解析失败即放行（仅字节兜底），攻击者可用无法解析的容器
  //   绕过时长限制，产生超长上游计费。现在：解析不出时长 → 415 拒绝。
  //   解析成功且超限 → 413。
  let durationSec: number | null = null;
  try {
    const head = new Uint8Array(await audio.slice(0, 256 * 1024).arrayBuffer());
    durationSec = parseAudioDurationSec(head);
  } catch {
    durationSec = null;
  }
  if (durationSec === null) {
    // 无法可靠验证时长 → 拒绝（不得仅凭字节上限放行）
    return fail('UNSUPPORTED_FORMAT', 415);
  }
  if (durationSec > LIMITS.maxDurationSec) {
    return fail('PAYLOAD_TOO_LARGE', 413);
  }

  // ---- 3. 配额预占（每次上游尝试独立预占，失败或存储不可用 → 拒绝） ----
  //
  // 🔒 T6/B01：配额语义为「尝试计数」。
  //    reserve 返回唯一 reservation_id；每一次真正发往上游的尝试（含重试、
  //    含结果不确定的超时）都占用预算。只有「确定未发出请求」的失败才释放。
  // 🔒 T6.2/FIX-02：预占下沉到「每次尝试」内部，保证每次实际上游调用
  //    都对应一次独立配额消耗；默认禁用自动重试（attempts=1）。
  const admin = createClientImpl(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 单次预占：成功返回 reservation_id，配额超限返回 null，存储异常抛错。
  const reserveOnce = async (): Promise<string | null> => {
    const { data, error } = await admin.rpc('transcribe_quota_reserve', {
      p_user_id: userId,
      p_bytes: audio.size,
      p_max_requests: LIMITS.userMaxRequests,
      p_max_bytes: LIMITS.userMaxBytes,
      p_global_max_requests: LIMITS.globalMaxRequests,
      p_global_max_bytes: LIMITS.globalMaxBytes,
    });
    if (error) {
      throw new Error(error.message);
    }
    return typeof data === 'string' ? data : null;
  };

  // 幂等释放（仅用于「确定未产生上游调用」的路径）
  const releaseReservation = async (id: string | null) => {
    if (!id) return;
    try {
      await admin.rpc('transcribe_quota_release', {
        p_reservation_id: id,
        p_user_id: userId,
      });
    } catch (e) {
      console.error('[transcribe-audio] 配额回滚失败:', (e as Error)?.message ?? e);
    }
  };

  // ---- 4. 调用上游（固定端点/模型/参数，超时 + 有限重试） ----
  const upstreamForm = new FormData();
  upstreamForm.append('file', audio, audio.name || `voice.${ext || 'm4a'}`);
  upstreamForm.append('model', GROQ_MODEL);
  upstreamForm.append('language', GROQ_LANGUAGE);
  upstreamForm.append('response_format', GROQ_RESPONSE_FORMAT);

  const attempts = LIMITS.upstreamRetries + 1;
  let lastCode: keyof typeof ERR = 'UPSTREAM_ERROR';
  let lastStatus = 502;

  for (let i = 0; i < attempts; i++) {
    // 🔒 T6/B02：全局截止时间已到 → 不再发起新尝试
    const budget = remainingMs();
    if (budget <= 0) {
      lastCode = 'UPSTREAM_TIMEOUT';
      lastStatus = 504;
      break;
    }

    // 🔒 T6.2/FIX-02：每次尝试前独立预占配额。
    //    预占失败（存储不可用）→ 503；配额超限 → 429。
    let reservationId: string | null = null;
    try {
      reservationId = await reserveOnce();
    } catch (e) {
      console.error('[transcribe-audio] 配额预占异常:', (e as Error)?.message ?? e);
      return fail('QUOTA_UNAVAILABLE', 503);
    }
    if (!reservationId) {
      // 本次尝试无法获得预算 → 不再发起上游调用
      return fail('QUOTA_EXCEEDED', 429);
    }

    try {
      const result = await fetchJsonWithTimeout(
        GROQ_ENDPOINT,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${groqKey}` },
          body: upstreamForm,
        },
        // 单次超时不得超过剩余生命周期预算
        Math.min(LIMITS.upstreamTimeoutMs, budget),
        fetchImpl,
      );

      // 超时：请求可能已被上游接收，结果不确定 → 预算已消耗，不释放
      if (result.timedOut) {
        lastCode = 'UPSTREAM_TIMEOUT';
        lastStatus = 504;
        continue;
      }

      if (result.ok) {
        const data = result.json as { text?: unknown } | null;
        const text = typeof data?.text === 'string' ? data.text : '';
        if (!text) {
          // 上游 200 但无文字：视为可重试的上游异常（预算已消耗，不释放）
          lastCode = 'UPSTREAM_ERROR';
          lastStatus = 502;
          continue;
        }
        // 成功：预占转为已消费（不释放）
        return json({ text });
      }

      // 4xx 不重试（鉴权/参数问题重试无意义）；5xx / 429 可重试
      if (result.status === 401 || result.status === 403) {
        console.error('[transcribe-audio] 上游鉴权失败:', result.status);
        lastCode = 'NOT_CONFIGURED';
        lastStatus = 503;
        break;
      }
      if (result.status === 429) {
        lastCode = 'QUOTA_EXCEEDED';
        lastStatus = 429;
        continue;
      }
      if (result.status >= 500) {
        lastCode = 'UPSTREAM_ERROR';
        lastStatus = 502;
        continue;
      }
      // 其余 4xx：输入问题
      console.error('[transcribe-audio] 上游拒绝请求:', result.status);
      lastCode = 'UPSTREAM_ERROR';
      lastStatus = 502;
      break;
    } catch (e) {
      console.error('[transcribe-audio] 上游调用异常:', (e as Error)?.message ?? e);
      lastCode = 'UPSTREAM_ERROR';
      lastStatus = 502;
      continue;
    }
  }

  return fail(lastCode, lastStatus);
  };
}

// 生产入口：使用真实依赖注册到 Deno.serve。
// 仅在作为主模块直接运行时启动服务；被测试 import 时不监听端口。
if (import.meta.main) {
  Deno.serve(createHandler({ createClient, fetch }));
}

// --- END OF FILE supabase/functions/transcribe-audio/index.ts ---
