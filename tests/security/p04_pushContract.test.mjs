// --- START OF FILE tests/security/p04_pushContract.test.mjs ---
// ============================================================================
// TASK-P0.4 / 推送模块 — 最小契约测试
//
// 目的：P0.3 的 229 个测试集中在 auth / health / isolation / media cache，
//       推送模块零自动化覆盖。本测试锁定 sendPushNotification 的契约：
//         P04-PUSH-01 入参守卫：缺 receiverId 时不得发起任何网络调用；
//         P04-PUSH-02 调用契约：必须走 Edge Function `send-push`，
//                      body 字段为 { targetUserId, title, body, data }，
//                      且客户端绝不直接调用 Expo Push API / 查询他人 token；
//         P04-PUSH-03 返回值归一化：云函数 error / ok:false / 抛异常
//                      一律归一化为 { ok:false, reason }，绝不向上抛。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 通过 stub supabase 后运行真实源码，并记录实际下发的 invoke 参数。
//   - 退出码：0 全部通过；1 存在失败。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-push-'));
  const src = path.join(repoRoot, 'src/services/pushService.js');
  const dst = path.join(dir, 'src/services/pushService.js');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);

  // supabase stub：__INVOKE_IMPL__ 由 case.mjs 注入，用于模拟各种云函数返回
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
  return JSON.parse(child.stdout);
}

// ---------------------------------------------------------------------------
// P04-PUSH-01：入参守卫
// ---------------------------------------------------------------------------
test('P04-PUSH-01 缺 receiverId 时直接返回且不发起任何网络调用', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
const { __invokes } = await import('./src/services/supabase.js');
const cases = {};
for (const [k, v] of Object.entries({ empty: '', nullVal: null, undefinedVal: undefined, zero: 0 })) {
  __invokes.length = 0;
  cases[k] = { result: await sendPushNotification(v, 't', 'b'), invokeCount: __invokes.length };
}
process.stdout.write(JSON.stringify(cases));
`);
    for (const k of ['empty', 'nullVal', 'undefinedVal', 'zero']) {
      assert.deepEqual(out[k].result, { ok: false, reason: 'missing receiverId' }, `${k}: 必须返回 missing receiverId`);
      assert.equal(out[k].invokeCount, 0, `${k}: 不得发起任何 invoke 调用`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-PUSH-02：调用契约（走 Edge Function，不直连 Expo）
// ---------------------------------------------------------------------------
test('P04-PUSH-02 必须通过 Edge Function send-push 且 body 字段完整', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');
const { __invokes } = await import('./src/services/supabase.js');
__invokes.length = 0;
const result = await sendPushNotification('user-target', '标题', '正文', { route: '/chat_room', id: 'm1' });
const invokes = JSON.parse(JSON.stringify(__invokes));
__invokes.length = 0;
const resultNoData = await sendPushNotification('user-target', '标题', '正文');
const invokesNoData = JSON.parse(JSON.stringify(__invokes));
process.stdout.write(JSON.stringify({ result, invokes, resultNoData, invokesNoData }));
`);
    assert.deepEqual(out.result, { ok: true }, '云函数成功时透传结果');
    assert.equal(out.invokes.length, 1, '必须且仅调用一次云函数');
    assert.equal(out.invokes[0].name, 'send-push', '必须调用名为 send-push 的 Edge Function');
    assert.deepEqual(out.invokes[0].opts.body, {
      targetUserId: 'user-target',
      title: '标题',
      body: '正文',
      data: { route: '/chat_room', id: 'm1' },
    }, 'body 必须为 { targetUserId, title, body, data }');

    assert.equal(out.invokesNoData.length, 1);
    assert.deepEqual(out.invokesNoData[0].opts.body.data, {}, 'data 缺省必须为 {}（不得为 undefined）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-PUSH-03：返回值归一化（绝不向上抛）
// ---------------------------------------------------------------------------
test('P04-PUSH-03 云函数 error / ok:false / 抛异常一律归一化为 ok:false', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { sendPushNotification } = await import('./src/services/pushService.js');

globalThis.__INVOKE_IMPL__ = () => ({ data: null, error: { message: 'network down' } });
const errCase = await sendPushNotification('u', 't', 'b');

globalThis.__INVOKE_IMPL__ = () => ({ data: { ok: false, error: 'no token' }, error: null });
const notOkError = await sendPushNotification('u', 't', 'b');

globalThis.__INVOKE_IMPL__ = () => ({ data: { ok: false, reason: 'blocked' }, error: null });
const notOkReason = await sendPushNotification('u', 't', 'b');

globalThis.__INVOKE_IMPL__ = () => { throw new Error('boom'); };
const thrown = await sendPushNotification('u', 't', 'b');

globalThis.__INVOKE_IMPL__ = () => ({ data: { ok: true, delivered: 1 }, error: null });
const success = await sendPushNotification('u', 't', 'b');

globalThis.__INVOKE_IMPL__ = () => ({ data: null, error: null });
const nullData = await sendPushNotification('u', 't', 'b');

process.stdout.write(JSON.stringify({ errCase, notOkError, notOkReason, thrown, success, nullData }));
`);
    assert.deepEqual(out.errCase, { ok: false, reason: 'network down' }, '云函数 error → ok:false + reason');
    assert.deepEqual(out.notOkError, { ok: false, reason: 'no token' }, 'ok:false 优先取 error 字段');
    assert.deepEqual(out.notOkReason, { ok: false, reason: 'blocked' }, 'ok:false 无 error 时取 reason');
    assert.deepEqual(out.thrown, { ok: false, reason: 'boom' }, '抛异常必须被捕获并归一化');
    assert.deepEqual(out.success, { ok: true, delivered: 1 }, '成功时透传云函数结果');
    assert.deepEqual(out.nullData, { ok: true }, '云函数返回空 data 时回退 { ok:true }');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_pushContract.test.mjs ---
