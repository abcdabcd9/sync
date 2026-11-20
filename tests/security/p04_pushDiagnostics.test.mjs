// --- START OF FILE tests/security/p04_pushDiagnostics.test.mjs ---
// ============================================================================
// TASK-P0.4 / FIX-C — 推送错误诊断（脱敏）回归测试
//
// 背景：`supabase.functions.invoke` 在非 2xx 时抛 FunctionsHttpError，
//       `error.message` 恒为「Edge Function returned a non-2xx status code」，
//       丢失真实 HTTP 状态码与服务端错误码，导致无法区分
//       401 / 403 / 404 / 500 / 502。
//
// 本测试锁定 FIX-C 的契约：
//   P04-PUSH-D01  FunctionsHttpError 携带 context.status 时，
//                 返回值必须带 status 与 category，reason 取服务端 error 字段；
//   P04-PUSH-D02  状态码 → 类别映射正确（401/403/404/500/502）；
//   P04-PUSH-D03  脱敏红线：日志与返回值中绝不出现 JWT / Push Token /
//                 service_role key / Authorization 头等敏感串；
//   P04-PUSH-D04  无 HTTP 状态（纯网络错误）时保持旧返回形状 { ok, reason }，
//                 不附加 status/category（向后兼容）。
//
// 说明：不联网、不使用真实 .env / Token / 用户数据。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-pushdiag-'));
  const src = path.join(repoRoot, 'src/services/pushService.js');
  const dst = path.join(dir, 'src/services/pushService.js');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);

  fs.writeFileSync(path.join(dir, 'src/services/supabase.js'), `
export const __invokes = [];
export const supabase = {
  functions: {
    async invoke(name, opts) {
      __invokes.push({ name, opts });
      if (typeof globalThis.__INVOKE_IMPL__ === 'function') return globalThis.__INVOKE_IMPL__(name, opts);
      return { data: { ok: true }, error: null };
    },
  },
};
`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);console.warn=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return { out: JSON.parse(child.stdout), stderr: child.stderr };
}

// 构造一个模拟 FunctionsHttpError 的对象：带 context.status 与 context.json()
function httpErrorCase(status, serverError) {
  return `
globalThis.__INVOKE_IMPL__ = () => ({
  data: null,
  error: {
    message: 'Edge Function returned a non-2xx status code',
    context: {
      status: ${status},
      json: async () => ({ error: ${JSON.stringify(serverError)} }),
    },
  },
});
`;
}

// ---------------------------------------------------------------------------
// P04-PUSH-D01：携带 context.status 时返回 status/category，reason 取服务端 error
// ---------------------------------------------------------------------------
test('P04-PUSH-D01 FunctionsHttpError 携带 status 时返回 status/category 且 reason 取服务端错误', () => {
  const dir = buildSandbox();
  try {
    const { out } = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
${httpErrorCase(403, 'Not authorized to push to this user')}
const r = await sendPushNotification('u', 't', 'b');
process.stdout.write(JSON.stringify(r));
`);
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.equal(out.category, 'forbidden');
    assert.equal(out.reason, 'Not authorized to push to this user');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-PUSH-D02：状态码 → 类别映射
// ---------------------------------------------------------------------------
test('P04-PUSH-D02 状态码映射为稳定类别（401/403/404/500/502）', () => {
  const dir = buildSandbox();
  try {
    const { out } = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
const results = {};
const cases = [
  [401, 'Invalid or expired token'],
  [403, 'Not authorized to push to this user'],
  [404, 'Target profile not found'],
  [500, 'Server misconfigured'],
  [502, 'Expo push failed'],
];
for (const [status, msg] of cases) {
  globalThis.__INVOKE_IMPL__ = () => ({
    data: null,
    error: {
      message: 'Edge Function returned a non-2xx status code',
      context: { status, json: async () => ({ error: msg }) },
    },
  });
  results[status] = await sendPushNotification('u', 't', 'b');
}
process.stdout.write(JSON.stringify(results));
`);
    assert.equal(out['401'].category, 'auth');
    assert.equal(out['403'].category, 'forbidden');
    assert.equal(out['404'].category, 'target_missing');
    assert.equal(out['500'].category, 'server_config');
    assert.equal(out['502'].category, 'upstream');
    for (const s of ['401', '403', '404', '500', '502']) {
      assert.equal(out[s].ok, false, `${s}: 必须 ok:false`);
      assert.equal(out[s].status, Number(s), `${s}: status 必须回填`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-PUSH-D03：脱敏红线 — 日志与返回值不得含敏感串
// ---------------------------------------------------------------------------
test('P04-PUSH-D03 日志与返回值绝不泄露 JWT / Push Token / service_role key', () => {
  const dir = buildSandbox();
  try {
    const SENSITIVE = {
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRETPAYLOAD.SIGNATURE',
      pushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      serviceRole: 'service_role_key_should_never_leak_1234567890',
    };
    const { out, stderr } = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
// 模拟一个「恶意/异常」错误对象：把敏感串塞进 message 与 context 的无关字段，
// 但服务端 error 字段本身是安全的短错误码。
globalThis.__INVOKE_IMPL__ = () => ({
  data: null,
  error: {
    message: 'Edge Function returned a non-2xx status code',
    context: {
      status: 403,
      // 模拟请求头里可能存在的 Authorization（不应被读取/输出）
      headers: { Authorization: 'Bearer ${SENSITIVE.jwt}' },
      json: async () => ({ error: 'Not authorized to push to this user' }),
    },
  },
});
const r = await sendPushNotification('u', 't', 'b');
process.stdout.write(JSON.stringify(r));
`);
    const serialized = JSON.stringify(out);
    const combined = serialized + '\n' + stderr;
    for (const [name, secret] of Object.entries(SENSITIVE)) {
      assert.equal(
        combined.includes(secret),
        false,
        `脱敏失败：${name} 出现在日志或返回值中`
      );
    }
    // 返回值只应包含安全字段
    assert.deepEqual(Object.keys(out).sort(), ['category', 'ok', 'reason', 'status']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-PUSH-D04：无 HTTP 状态（纯网络错误）保持旧形状，向后兼容
// ---------------------------------------------------------------------------
test('P04-PUSH-D04 无 context.status 时保持旧返回形状 { ok, reason }', () => {
  const dir = buildSandbox();
  try {
    const { out } = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
globalThis.__INVOKE_IMPL__ = () => ({ data: null, error: { message: 'network down' } });
const r = await sendPushNotification('u', 't', 'b');
process.stdout.write(JSON.stringify(r));
`);
    assert.deepEqual(out, { ok: false, reason: 'network down' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-PUSH-D05：负向脱敏 — 服务端 error 字符串本身被污染（含模拟 Token）
//
// L4 第六批第 3 项：不能假设云函数一定只返回稳定错误码。若响应体 error
//   字段被注入 JWT / Push Token / service_role key / Bearer 头，本地必须
//   在写入日志与返回值前完成脱敏，绝不外泄。
// ---------------------------------------------------------------------------
test('P04-PUSH-D05 服务端 error 字符串含模拟 Token 时必须脱敏', () => {
  const dir = buildSandbox();
  try {
    const SENSITIVE = {
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRETPAYLOAD.SIGNATURE',
      pushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
      serviceRole: 'sb_secret_abcdefghijklmnopqrstuvwxyz',
      bearer: 'Bearer abc.def.ghi',
    };
    // 服务端把敏感串拼进 error 字段（模拟上游/代理污染）
    const polluted =
      `push failed jwt=${SENSITIVE.jwt} token=${SENSITIVE.pushToken} ` +
      `key=${SENSITIVE.serviceRole} auth=${SENSITIVE.bearer}`;
    const { out, stderr } = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
globalThis.__INVOKE_IMPL__ = () => ({
  data: null,
  error: {
    message: 'Edge Function returned a non-2xx status code',
    context: {
      status: 502,
      json: async () => ({ error: ${JSON.stringify(polluted)} }),
    },
  },
});
const r = await sendPushNotification('u', 't', 'b');
process.stdout.write(JSON.stringify(r));
`);
    const combined = JSON.stringify(out) + '\n' + stderr;
    for (const [name, secret] of Object.entries(SENSITIVE)) {
      assert.equal(
        combined.includes(secret),
        false,
        `脱敏失败：服务端 error 中的 ${name} 泄露到日志或返回值`
      );
    }
    // 仍保留诊断价值：状态码与类别必须存在
    assert.equal(out.ok, false);
    assert.equal(out.status, 502);
    assert.equal(out.category, 'upstream');
    // 脱敏占位符应出现（证明确实做了替换，而非整段丢弃）
    assert.ok(out.reason.includes('[REDACTED]'), 'reason 应包含 [REDACTED] 占位符');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_pushDiagnostics.test.mjs ---
