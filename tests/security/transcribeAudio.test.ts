/// <reference lib="deno.ns" />
/// <reference lib="deno.unstable" />
// --- START OF FILE tests/security/transcribeAudio.test.ts ---
/**
 * Batch B — transcribe-audio Edge Function 单元测试（Deno，mock 上游 + mock Supabase）
 *
 * 运行：
 *   deno test --allow-env --allow-net --allow-read tests/security/transcribeAudio.test.ts
 *
 * T6/B02 变更：Edge Function 现在导出 createHandler(deps)，允许注入 mock 的
 * createClient 与 fetch。因此本测试可以在「有效身份 + 有效配额」前提下，
 * 完整驱动请求处理链（鉴权 → 解析 → 格式/时长/体积校验 → 配额预占 →
 * 上游调用 → 释放/消费），且绝不触达真实 Supabase 或真实 Groq。
 *
 * 覆盖：
 *   B1  无 Authorization → 401 UNAUTHORIZED
 *   B2  无效 JWT → 401 UNAUTHORIZED
 *   B3  缺少 GROQ_API_KEY → 503 NOT_CONFIGURED
 *   B4  非 POST → 405 METHOD_NOT_ALLOWED
 *   B5  非 multipart / 无 file → 400 INVALID_INPUT
 *   B6  空文件 → 400 INVALID_INPUT
 *   B7  超过字节上限 → 413 PAYLOAD_TOO_LARGE
 *   B8  不支持的格式 → 415 UNSUPPORTED_FORMAT
 *   B9  配额预占返回 NULL → 429 QUOTA_EXCEEDED
 *   B10 配额 RPC 返回 error → 503 QUOTA_UNAVAILABLE
 *   B11 上游成功 → 200 { text }，且预占被消费（不释放）
 *   B12 上游 5xx 重试后仍失败 → 502 UPSTREAM_ERROR，且预占被消费（尝试计数）
 *   B13 上游超时 → 504 UPSTREAM_TIMEOUT，且预占被消费（结果不确定）
 *   B14 上游 401 → 503 NOT_CONFIGURED（不重试）
 *   B15 上游 200 但无 text → 502 UPSTREAM_ERROR
 *   B16 上游原始响应/音频/token 不进入返回体
 *   B17 客户端传入的 model/url 参数被忽略（固定服务端配置）
 *   B18 真实时长超限（WAV 头）→ 413 PAYLOAD_TOO_LARGE
 *   B19 鉴权失败时上游零调用（不消耗成本）
 *   B20 配额预占失败时上游零调用
 *   B21 请求生命周期截止时间耗尽 → 504，且不发起新尝试
 */

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(actual: T, expected: T, name: string): void {
  ok(
    actual === expected,
    name,
    actual === expected ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// 环境与 mock 基础设施
// ---------------------------------------------------------------------------
const VALID_TOKEN = 'valid.jwt.token';
const VALID_USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RESERVATION_ID = '11111111-2222-3333-4444-555555555555';

interface MockState {
  // 上游行为
  upstreamStatus: number;
  upstreamBody: unknown;
  upstreamDelayMs: number;
  upstreamCalls: number;
  upstreamThrowAbort: boolean;
  // 配额行为
  reserveMode: 'ok' | 'null' | 'error' | 'throw';
  reserveCalls: number;
  releaseCalls: number;
  releaseArgs: { p_reservation_id: string; p_user_id: string }[];
  // 鉴权行为
  authValid: boolean;
}

const state: MockState = {
  upstreamStatus: 200,
  upstreamBody: { text: '你好世界' },
  upstreamDelayMs: 0,
  upstreamCalls: 0,
  upstreamThrowAbort: false,
  reserveMode: 'ok',
  reserveCalls: 0,
  releaseCalls: 0,
  releaseArgs: [],
  authValid: true,
};

function resetState(): void {
  state.upstreamStatus = 200;
  state.upstreamBody = { text: '你好世界' };
  state.upstreamDelayMs = 0;
  state.upstreamCalls = 0;
  state.upstreamThrowAbort = false;
  state.reserveMode = 'ok';
  state.reserveCalls = 0;
  state.releaseCalls = 0;
  state.releaseArgs = [];
  state.authValid = true;
}

// mock fetch：拦截 Groq 上游
const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('api.groq.com')) {
    state.upstreamCalls++;
    if (state.upstreamThrowAbort) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (state.upstreamDelayMs > 0) {
      await new Promise((r) => setTimeout(r, state.upstreamDelayMs));
    }
    return new Response(JSON.stringify(state.upstreamBody), {
      status: state.upstreamStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

// mock createClient：区分 anon client（鉴权）与 admin client（配额 RPC）
function mockCreateClient(_url: string, key: string, _opts?: unknown) {
  const isService = key === 'test-service-key';
  if (!isService) {
    // anon client：仅用于 auth.getUser
    return {
      auth: {
        getUser: async (_token: string) => {
          if (state.authValid) {
            return { data: { user: { id: VALID_USER_ID } }, error: null };
          }
          return { data: { user: null }, error: { message: 'invalid jwt' } };
        },
      },
    };
  }
  // admin client：用于配额 RPC
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'transcribe_quota_reserve') {
        state.reserveCalls++;
        if (state.reserveMode === 'error') {
          return { data: null, error: { message: 'db error' } };
        }
        if (state.reserveMode === 'throw') {
          throw new Error('network down');
        }
        if (state.reserveMode === 'null') {
          return { data: null, error: null };
        }
        return { data: RESERVATION_ID, error: null };
      }
      if (fn === 'transcribe_quota_release') {
        state.releaseCalls++;
        state.releaseArgs.push(args as { p_reservation_id: string; p_user_id: string });
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };
}

// ---------------------------------------------------------------------------
// 加载被测 handler（注入 mock 依赖）
// ---------------------------------------------------------------------------
const FN_PATH = new URL('../../supabase/functions/transcribe-audio/index.ts', import.meta.url);

async function loadHandler(): Promise<(req: Request) => Promise<Response>> {
  // 每次重新导入以拿到最新环境变量
  const mod = await import(`${FN_PATH.href}?t=${Date.now()}`);
  return mod.createHandler({
    // 注入 mock：类型在 Deno 运行时由被测模块的 HandlerDeps 约束，这里用 any 绕过
    // 远程 esm.sh 类型解析（测试文件不参与项目 tsc）。
    createClient: mockCreateClient as unknown as never,
    fetch: mockFetch,
  });
}

// ---------------------------------------------------------------------------
// 请求构造辅助
// ---------------------------------------------------------------------------
/**
 * 构造一个「时长可验证」的合法 WAV 表单。
 *
 * 🔒 T6.2/FIX-03：服务端对无法解析时长的音频 fail-closed（415）。
 *   因此默认夹具必须是带合法 RIFF/fmt/data 头的 WAV，否则所有
 *   正常路径用例都会被时长校验拦截。`bytes` 控制 data 块大小，
 *   从而控制总字节数（用于空文件 / 超限 / 正常等场景）。
 *
 * 采样率 8000Hz、单声道、16bit → byteRate = 16000。
 * dataSize = max(0, bytes - 44)，总大小 ≈ bytes。
 */
function makeAudioForm(bytes = 1024, name = 'voice.wav', type = 'audio/wav'): FormData {
  const form = new FormData();
  if (bytes <= 0) {
    // 空文件：保留空 blob（B6 走 size<=0 分支）
    form.append('file', new File([new Uint8Array(0)], name, { type }));
    return form;
  }
  const headerSize = 44;
  const dataSize = Math.max(0, bytes - headerSize);
  const buf = new Uint8Array(headerSize + dataSize);
  const dv = new DataView(buf.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };
  const byteRate = 16000;
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true); // chunk size
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 8000, true); // sample rate
  dv.setUint32(28, byteRate, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  form.append('file', new File([buf], name, { type }));
  return form;
}

/** 构造一个声明时长超限的 WAV 头（RIFF/WAVE/fmt/data） */
function makeLongWavForm(durationSec: number): FormData {
  // 采样率 8000Hz，单声道，16bit → byteRate = 16000
  const byteRate = 16000;
  const dataSize = byteRate * durationSec;
  const buf = new Uint8Array(44);
  const dv = new DataView(buf.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true); // chunk size
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 8000, true); // sample rate
  dv.setUint32(28, byteRate, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  const form = new FormData();
  form.append('file', new File([buf], 'voice.wav', { type: 'audio/wav' }));
  return form;
}

function makeReq(opts: {
  method?: string;
  auth?: string | null;
  form?: FormData | null;
  rawBody?: BodyInit | null;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.auth !== null && opts.auth !== undefined) {
    headers['Authorization'] = opts.auth;
  }
  const method = opts.method ?? 'POST';
  let body: BodyInit | null = null;
  if (opts.form !== undefined && opts.form !== null) {
    body = opts.form;
  } else if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  }
  return new Request('http://localhost/transcribe-audio', { method, headers, body });
}

// ---------------------------------------------------------------------------
// 测试执行
// ---------------------------------------------------------------------------
console.log('\n=== Batch B: transcribe-audio Edge Function ===\n');

// 环境变量基线
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:54321');
Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
Deno.env.set('GROQ_API_KEY', 'test-groq-key');
Deno.env.set('TRANSCRIBE_MAX_BYTES', '4096');
Deno.env.set('TRANSCRIBE_MAX_DURATION_SEC', '120');
Deno.env.set('TRANSCRIBE_UPSTREAM_TIMEOUT_MS', '200');
Deno.env.set('TRANSCRIBE_UPSTREAM_RETRIES', '1');
Deno.env.set('TRANSCRIBE_REQUEST_DEADLINE_MS', '55000');

const handler = await loadHandler();

// B1 无 Authorization
resetState();
{
  const res = await handler(makeReq({ auth: null, form: makeAudioForm() }));
  eq(res.status, 401, 'B1 无 Authorization → 401');
  const body = await res.json();
  eq(body?.error?.code, 'UNAUTHORIZED', 'B1 错误码 UNAUTHORIZED');
}

// B2 无效 JWT
resetState();
state.authValid = false;
{
  const res = await handler(makeReq({ auth: 'Bearer not-a-real-jwt', form: makeAudioForm() }));
  eq(res.status, 401, 'B2 无效 JWT → 401');
  const body = await res.json();
  eq(body?.error?.code, 'UNAUTHORIZED', 'B2 错误码 UNAUTHORIZED');
}

// B3 缺少 GROQ_API_KEY
resetState();
{
  const saved = Deno.env.get('GROQ_API_KEY');
  Deno.env.delete('GROQ_API_KEY');
  const h2 = await loadHandler();
  const res = await h2(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 503, 'B3 缺少 GROQ_API_KEY → 503');
  const body = await res.json();
  eq(body?.error?.code, 'NOT_CONFIGURED', 'B3 错误码 NOT_CONFIGURED');
  if (saved) Deno.env.set('GROQ_API_KEY', saved);
}

// B4 非 POST
resetState();
{
  const res = await handler(makeReq({ method: 'GET', auth: `Bearer ${VALID_TOKEN}` }));
  eq(res.status, 405, 'B4 GET → 405');
  const body = await res.json();
  eq(body?.error?.code, 'METHOD_NOT_ALLOWED', 'B4 错误码 METHOD_NOT_ALLOWED');
}

// B5 无 file 字段（有效身份）
resetState();
{
  const form = new FormData();
  form.append('model', 'whisper-large-v3');
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form }));
  eq(res.status, 400, 'B5 无 file 字段 → 400');
  const body = await res.json();
  eq(body?.error?.code, 'INVALID_INPUT', 'B5 错误码 INVALID_INPUT');
}

// B6 空文件（有效身份）
resetState();
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm(0) }));
  eq(res.status, 400, 'B6 空文件 → 400');
  const body = await res.json();
  eq(body?.error?.code, 'INVALID_INPUT', 'B6 错误码 INVALID_INPUT');
}

// B7 超过字节上限（有效身份）
resetState();
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm(999999) }));
  eq(res.status, 413, 'B7 超大文件 → 413');
  const body = await res.json();
  eq(body?.error?.code, 'PAYLOAD_TOO_LARGE', 'B7 错误码 PAYLOAD_TOO_LARGE');
}

// B8 不支持的格式（有效身份）
resetState();
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm(1024, 'x.exe', 'application/x-msdownload') }));
  eq(res.status, 415, 'B8 非法格式 → 415');
  const body = await res.json();
  eq(body?.error?.code, 'UNSUPPORTED_FORMAT', 'B8 错误码 UNSUPPORTED_FORMAT');
}

// B9 配额预占返回 NULL → 429
resetState();
state.reserveMode = 'null';
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 429, 'B9 配额已满 → 429');
  const body = await res.json();
  eq(body?.error?.code, 'QUOTA_EXCEEDED', 'B9 错误码 QUOTA_EXCEEDED');
  eq(state.upstreamCalls, 0, 'B9 配额失败时上游零调用');
}

// B10 配额 RPC 返回 error → 503
resetState();
state.reserveMode = 'error';
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 503, 'B10 配额存储不可用 → 503');
  const body = await res.json();
  eq(body?.error?.code, 'QUOTA_UNAVAILABLE', 'B10 错误码 QUOTA_UNAVAILABLE');
}

// B11 上游成功 → 200 { text }，预占被消费（不释放）
resetState();
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 200, 'B11 上游成功 → 200');
  const body = await res.json();
  eq(body?.text, '你好世界', 'B11 返回转写文本');
  eq(state.upstreamCalls, 1, 'B11 上游调用 1 次');
  eq(state.releaseCalls, 0, 'B11 成功后不释放预占（已消费）');
}

// B12 上游 5xx 重试后仍失败 → 502，预占被消费（尝试计数）
resetState();
state.upstreamStatus = 500;
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 502, 'B12 上游 5xx → 502');
  const body = await res.json();
  eq(body?.error?.code, 'UPSTREAM_ERROR', 'B12 错误码 UPSTREAM_ERROR');
  eq(state.upstreamCalls, 2, 'B12 重试 1 次（共 2 次尝试）');
  eq(state.releaseCalls, 0, 'B12 已发出尝试 → 不释放预占（尝试计数）');
}

// B13 上游超时 → 504，预占被消费（结果不确定）
resetState();
state.upstreamThrowAbort = true;
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 504, 'B13 上游超时 → 504');
  const body = await res.json();
  eq(body?.error?.code, 'UPSTREAM_TIMEOUT', 'B13 错误码 UPSTREAM_TIMEOUT');
  eq(state.releaseCalls, 0, 'B13 超时结果不确定 → 不释放预占');
}

// B14 上游 401 → 503 NOT_CONFIGURED（不重试）
resetState();
state.upstreamStatus = 401;
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 503, 'B14 上游 401 → 503');
  const body = await res.json();
  eq(body?.error?.code, 'NOT_CONFIGURED', 'B14 错误码 NOT_CONFIGURED');
  eq(state.upstreamCalls, 1, 'B14 上游鉴权失败不重试（1 次）');
}

// B15 上游 200 但无 text → 502
resetState();
state.upstreamBody = { text: '' };
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 502, 'B15 上游无 text → 502');
  const body = await res.json();
  eq(body?.error?.code, 'UPSTREAM_ERROR', 'B15 错误码 UPSTREAM_ERROR');
}

// B16 错误响应体不含上游原始内容 / token / 音频
resetState();
state.upstreamStatus = 500;
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  const text = await res.text();
  ok(!text.includes('test-groq-key'), 'B16a 错误体不含 GROQ_API_KEY');
  ok(!text.includes('Bearer'), 'B16b 错误体不含 Authorization');
  ok(!text.includes('api.groq.com'), 'B16c 错误体不含上游 URL');
}

// B17 客户端传入的 model/url 参数被忽略（固定服务端配置）
resetState();
{
  const form = makeAudioForm();
  form.append('model', 'evil-model');
  form.append('url', 'https://evil.example.com');
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form }));
  eq(res.status, 200, 'B17 客户端 model/url 被忽略 → 仍 200');
  const body = await res.json();
  eq(body?.text, '你好世界', 'B17 正常返回');
}

// B18 真实时长超限（WAV 头声明 200 秒 > 120 秒上限）→ 413
resetState();
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeLongWavForm(200) }));
  eq(res.status, 413, 'B18 时长超限 → 413');
  const body = await res.json();
  eq(body?.error?.code, 'PAYLOAD_TOO_LARGE', 'B18 错误码 PAYLOAD_TOO_LARGE');
  eq(state.upstreamCalls, 0, 'B18 时长超限时上游零调用');
}

// B19 鉴权失败时上游零调用
resetState();
state.authValid = false;
{
  await handler(makeReq({ auth: 'Bearer bad', form: makeAudioForm() }));
  eq(state.upstreamCalls, 0, 'B19 鉴权失败时上游零调用（不消耗成本）');
}

// B20 配额预占失败时上游零调用
resetState();
state.reserveMode = 'null';
{
  await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(state.upstreamCalls, 0, 'B20 配额预占失败时上游零调用');
}

// B21 请求生命周期截止时间耗尽 → 504，且不发起新尝试
resetState();
{
  const saved = Deno.env.get('TRANSCRIBE_REQUEST_DEADLINE_MS');
  Deno.env.set('TRANSCRIBE_REQUEST_DEADLINE_MS', '5000'); // 最小合法值
  const h2 = await loadHandler();
  // 让上游每次调用都耗时超过截止时间（模拟慢上游）
  state.upstreamDelayMs = 0;
  state.upstreamThrowAbort = true;
  const res = await h2(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 504, 'B21 截止时间/超时 → 504');
  if (saved) Deno.env.set('TRANSCRIBE_REQUEST_DEADLINE_MS', saved);
}

// B17 CORS 预检
resetState();
{
  const res = await handler(makeReq({ method: 'OPTIONS', auth: null }));
  eq(res.status, 200, 'B22a OPTIONS 预检 → 200');
  ok(res.headers.get('Access-Control-Allow-Origin') === '*', 'B22b 返回 CORS 头');
}

// ---------------------------------------------------------------------------
// T6.2 / FIX-02：禁用自动重试；每次实际上游调用均对应一次配额消耗
// ---------------------------------------------------------------------------

// B23 默认配置（未设置 TRANSCRIBE_UPSTREAM_RETRIES）→ 上游 5xx 只调用 1 次
resetState();
{
  const saved = Deno.env.get('TRANSCRIBE_UPSTREAM_RETRIES');
  Deno.env.delete('TRANSCRIBE_UPSTREAM_RETRIES');
  const h2 = await loadHandler();
  state.upstreamStatus = 500;
  const res = await h2(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 502, 'B23 默认无重试 → 502');
  eq(state.upstreamCalls, 1, 'B23 默认禁用自动重试（上游仅 1 次调用）');
  if (saved !== undefined) Deno.env.set('TRANSCRIBE_UPSTREAM_RETRIES', saved);
}

// B24 每次上游尝试独立预占配额（reserve 次数 == 上游调用次数）
resetState();
{
  const saved = Deno.env.get('TRANSCRIBE_UPSTREAM_RETRIES');
  Deno.env.set('TRANSCRIBE_UPSTREAM_RETRIES', '2'); // 显式允许 2 次重试
  const h2 = await loadHandler();
  state.upstreamStatus = 500;
  const res = await h2(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  eq(res.status, 502, 'B24 重试后仍失败 → 502');
  eq(state.upstreamCalls, 3, 'B24 上游共 3 次尝试（1 + 2 重试）');
  // 关键：每次上游调用都必须对应一次配额预占（尝试计数）
  eq(state.reserveCalls, 3, 'B24 每次上游尝试独立预占配额（reserve 3 次）');
  if (saved !== undefined) Deno.env.set('TRANSCRIBE_UPSTREAM_RETRIES', saved);
  else Deno.env.delete('TRANSCRIBE_UPSTREAM_RETRIES');
}

// ---------------------------------------------------------------------------
// T6.2 / FIX-03：请求体大小在 multipart 解析前限制
// ---------------------------------------------------------------------------

// B25 Content-Length 超限 → 在解析前拒绝（413），且上游零调用
resetState();
{
  const big = new Uint8Array(999999);
  const req = new Request('http://localhost/transcribe-audio', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'multipart/form-data; boundary=x',
      'Content-Length': String(big.length),
    },
    body: big,
  });
  const res = await handler(req);
  eq(res.status, 413, 'B25 Content-Length 超限 → 413（解析前拒绝）');
  const body = await res.json();
  eq(body?.error?.code, 'PAYLOAD_TOO_LARGE', 'B25 错误码 PAYLOAD_TOO_LARGE');
  eq(state.upstreamCalls, 0, 'B25 解析前拒绝时上游零调用');
}

// ---------------------------------------------------------------------------
// T6.2 / FIX-03：超时必须覆盖上游响应体读取
// ---------------------------------------------------------------------------

// B26 上游返回 headers 后 body 挂起 → 超时（504），不得无限等待
resetState();
{
  // 自定义 fetch：返回一个 body 永不结束的 Response
  const hangingFetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('api.groq.com')) {
      state.upstreamCalls++;
      const stream = new ReadableStream({
        start(controller) {
          // 只发一个字节后挂起，永不 close
          controller.enqueue(new TextEncoder().encode('{'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  // 单次上游超时下限为 1000ms（envInt min），设为 1000 以在合理时间内触发
  const savedTimeout = Deno.env.get('TRANSCRIBE_UPSTREAM_TIMEOUT_MS');
  Deno.env.set('TRANSCRIBE_UPSTREAM_TIMEOUT_MS', '1000');
  const mod = await import(`${FN_PATH.href}?t=${Date.now()}`);
  const h2 = mod.createHandler({
    createClient: mockCreateClient as unknown as never,
    fetch: hangingFetch,
  });
  const started = Date.now();
  const res = await h2(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeAudioForm() }));
  const elapsed = Date.now() - started;
  eq(res.status, 504, 'B26 响应体读取超时 → 504');
  const body = await res.json();
  eq(body?.error?.code, 'UPSTREAM_TIMEOUT', 'B26 错误码 UPSTREAM_TIMEOUT');
  ok(elapsed < 5000, 'B26 超时在合理时间内触发（未无限等待）', `实际 ${elapsed}ms`);
  if (savedTimeout !== undefined) Deno.env.set('TRANSCRIBE_UPSTREAM_TIMEOUT_MS', savedTimeout);
  else Deno.env.delete('TRANSCRIBE_UPSTREAM_TIMEOUT_MS');
}

// ---------------------------------------------------------------------------
// T6.2 / FIX-03：无法可靠验证时长/格式时拒绝（fail-closed）
// ---------------------------------------------------------------------------

// B27 声明为 m4a 但内容无法解析出时长 → 拒绝（不得仅凭字节上限放行）
resetState();
{
  // 1024 字节全零，既非 WAV 也非合法 MP4（无 moov/mvhd）。
  // 注意：不能复用 makeAudioForm（它现在生成合法 WAV），必须用真正不可解析的内容。
  const rawForm = new FormData();
  rawForm.append('file', new File([new Uint8Array(1024)], 'voice.m4a', { type: 'audio/m4a' }));
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: rawForm }));
  eq(res.status, 415, 'B27 无法验证时长的 m4a → 415（fail-closed）');
  const body = await res.json();
  eq(body?.error?.code, 'UNSUPPORTED_FORMAT', 'B27 错误码 UNSUPPORTED_FORMAT');
  eq(state.upstreamCalls, 0, 'B27 无法验证时上游零调用');
}

// B28 合法 WAV（时长可验证且在限内）→ 放行
resetState();
{
  const res = await handler(makeReq({ auth: `Bearer ${VALID_TOKEN}`, form: makeLongWavForm(1) }));
  eq(res.status, 200, 'B28 合法 WAV（1s）→ 200');
  eq(state.upstreamCalls, 1, 'B28 合法音频正常调用上游');
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n===== 结果：通过 ${passed} / 失败 ${failed} / 合计 ${passed + failed} =====`);
if (failed > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f}`));
  Deno.exit(1);
}
console.log('=== Batch B 单元测试全部通过 ===\n');

// --- END OF FILE tests/security/transcribeAudio.test.ts ---
