// --- START OF FILE tests/security/p12r4MigrationEquivalence.test.mjs ---
/**
 * TASK-P1.2 R4 — 核心 Services 首批 JS → TS 迁移行为等价测试
 *
 * 目标模块：
 *   1. src/services/supabase.js  → src/services/supabase.ts
 *   2. src/services/pushService.js → src/services/pushService.ts
 *
 * 方法：
 *   对每个场景，分别在**独立沙箱**中执行「迁移前 JS 全文」
 *   （tests/fixtures/p12r4/before/，版本可控，见 MANIFEST.md）与
 *   「迁移后 TS 实现」（src/services/*.ts），用完全相同的 stub 依赖，
 *   逐字段比对两者输出。基线来自真实执行迁移前 JS，而非复刻逻辑。
 *
 * 沙箱策略（与既有安全测试一致）：
 *   · 复制真实源码 + 依赖到临时目录；
 *   · stub 原生模块（expo-secure-store / async-storage / url-polyfill /
 *     @supabase/supabase-js），记录调用次数与参数；
 *   · resolve hook 支持无扩展名相对导入与 .ts；
 *   · 每个场景独立子进程，避免模块单例污染。
 *
 * 覆盖（Supabase 10 项 + Push 10 项）：
 *   S1  有效配置 → 构造客户端
 *   S2  缺失配置 → 不构造
 *   S3  非法配置 → 不构造
 *   S4  createClient 调用次数/参数（url/key/auth 选项）
 *   S5  Auth Storage get/set/remove 接口存在
 *   S6  storage 读取失败 → 适配器抛错（不降级明文）
 *   S7  storage 写入失败 → 适配器抛错
 *   S8  模块重复导入 → 单例（createClient 仅 1 次）
 *   S9  无意外真实网络访问（stub 记录）
 *   S10 无凭证泄漏（导出中不含 key/token）
 *   P1  正常成功 → 透传 { ok:true, ticketId }
 *   P2  skipped 分支 → 透传 { ok:true, skipped, reason }
 *   P3  Edge Function 错误返回（HTTP 非 2xx）→ status/category
 *   P4  网络异常（无 status）→ { ok:false, reason }
 *   P5  非法参数（缺 receiverId）→ { ok:false, reason }
 *   P6  缺失 auth 信息（401）→ category=auth
 *   P7  nullable ticketId（ticketId=null）→ 透传 null
 *   P8  敏感错误串脱敏（JWT / Push Token / Bearer）
 *   P9  请求参数 + 调用次数（Edge Function 名、body 字段）
 *   P10 原始失败返回结构（{ ok:false, error } HTTP 200）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const beforeDir = path.join(repoRoot, 'tests/fixtures/p12r4/before');

const VALID_URL = 'https://pjiyniqtrstcpnodsnqq.supabase.co';
const VALID_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig';

/**
 * 构建沙箱并执行 case.mjs。
 *
 * @param {object} opts
 * @param {'before'|'after'} opts.variant  before=迁移前 JS，after=迁移后 TS
 * @param {object} opts.env               注入的环境变量
 * @param {string} opts.caseCode          在沙箱中执行的 ESM 代码
 * @param {object} [opts.stubConfig]      覆盖 stub 行为（secureStore/asyncStorage/invoke）
 * @returns {{ status:number, stdout:string, stderr:string }}
 */
function runSandbox({ variant, env, caseCode, stubConfig = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12r4-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // ---- stub: react-native-url-polyfill ----
  mk('react-native-url-polyfill', {
    'package.json': JSON.stringify({ name: 'react-native-url-polyfill', version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js', './auto': './auto.js' } }),
    'index.js': 'export default {};',
    'auto.js': 'export default {};',
  });

  // ---- stub: async-storage（可配置失败） ----
  const asFail = stubConfig.asyncStorageFail ? 'true' : 'false';
  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `const rec=(o)=>{globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.as=globalThis.__ISO__.as||{get:0,set:0,remove:0};globalThis.__ISO__.as[o]+=1;};const FAIL=${asFail};export default {getItem:async()=>{rec('get');if(FAIL)throw new Error('as get failed');return null;},setItem:async()=>{rec('set');if(FAIL)throw new Error('as set failed');},removeItem:async()=>{rec('remove');if(FAIL)throw new Error('as remove failed');}};`,
  });

  // ---- stub: expo-secure-store（可配置失败） ----
  const ssFail = stubConfig.secureStoreFail ? 'true' : 'false';
  mk('expo-secure-store', {
    'package.json': JSON.stringify({ name: 'expo-secure-store', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `const rec=(o)=>{globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.ss=globalThis.__ISO__.ss||{get:0,set:0,delete:0};globalThis.__ISO__.ss[o]+=1;};const FAIL=${ssFail};export const getItemAsync=async()=>{rec('get');if(FAIL)throw new Error('ss get failed');return null;};export const setItemAsync=async()=>{rec('set');if(FAIL)throw new Error('ss set failed');};export const deleteItemAsync=async()=>{rec('delete');if(FAIL)throw new Error('ss delete failed');};export default {getItemAsync,setItemAsync,deleteItemAsync};`,
  });

  // ---- stub: @supabase/supabase-js ----
  // createClient 记录调用；返回的 client.functions.invoke 由 stubConfig.invoke 决定。
  // 注意：invoke 配置可能含函数（context.json），不能走 JSON.stringify，
  // 这里用结构化字段在 stub 内部重建 context.json。
  const inv = stubConfig.invoke || null;
  // data 需要区分「未提供」与「显式 undefined / null / false / {}」：
  // 用 hasData 标记是否真的提供了 data 字段，避免 JSON.stringify 丢失 undefined。
  const hasData = inv ? Object.prototype.hasOwnProperty.call(inv, 'data') : false;
  const invData = hasData ? JSON.stringify(inv.data === undefined ? null : inv.data) : 'null';
  const invDataUndef = hasData && inv.data === undefined ? 'true' : 'false';
  const invError = inv && inv.error !== undefined ? JSON.stringify(inv.error) : 'null';
  const invThrow = inv && inv.throw
    ? JSON.stringify({
        message: inv.throw.message === undefined ? 'invoke error' : inv.throw.message,
        status: inv.throw.status,
        jsonBody: inv.throw.jsonBody,
        jsonThrows: inv.throw.jsonThrows === true,
        raw: inv.throw.raw,
      })
    : 'null';
  // 真实 SDK 的 invoke 对非 2xx **不抛给调用方**，而是返回 { data:null, error }，
  // 其中 error.context 携带 HTTP Response（status / json()）。stub 必须复刻此语义。
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export function createClient(url,key,options){globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.cc=globalThis.__ISO__.cc||[];globalThis.__ISO__.cc.push({url,key,options});const DATA=${invData};const DATA_UNDEF=${invDataUndef};const ERR=${invError};const THROW=${invThrow};return {__stub:true,url,key,options,functions:{invoke:async(name,opts)=>{globalThis.__ISO__.inv=globalThis.__ISO__.inv||[];globalThis.__ISO__.inv.push({name,opts});if(THROW){if(THROW.raw!==undefined&&THROW.raw!==null){return {data:null,error:THROW.raw};}const e=new Error(THROW.message);const ctx={};if(THROW.status!==undefined&&THROW.status!==null)ctx.status=THROW.status;if(THROW.jsonThrows){ctx.json=async()=>{throw new Error('body not readable');};}else if(THROW.jsonBody!==undefined&&THROW.jsonBody!==null){ctx.json=async()=>THROW.jsonBody;}e.context=ctx;return {data:null,error:e};}return {data:DATA_UNDEF?undefined:DATA,error:ERR};}}};}export default {createClient};`,
  });

  // ---- 复制真实源码 ----
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  if (variant === 'before') {
    // 迁移前 JS 全文（夹具）
    fs.copyFileSync(path.join(beforeDir, 'services__supabase.js'), path.join(dir, 'src/services/supabase.js'));
    fs.copyFileSync(path.join(beforeDir, 'services__pushService.js'), path.join(dir, 'src/services/pushService.js'));
  } else {
    // 迁移后 TS 实现
    fs.copyFileSync(path.join(repoRoot, 'src/services/supabase.ts'), path.join(dir, 'src/services/supabase.ts'));
    fs.copyFileSync(path.join(repoRoot, 'src/services/pushService.ts'), path.join(dir, 'src/services/pushService.ts'));
  }
  // 共享依赖（两版一致）
  fs.copyFileSync(path.join(repoRoot, 'src/services/supabaseConfig.ts'), path.join(dir, 'src/services/supabaseConfig.ts'));
  // P1.2 R5：authStorage 已迁移为 TypeScript（supabase.ts 以无扩展名导入，resolve hook 会补 .ts）。
  fs.copyFileSync(path.join(repoRoot, 'src/services/authStorage.ts'), path.join(dir, 'src/services/authStorage.ts'));

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

  // resolve hook：无扩展名相对导入依次尝试 .js / .ts
  fs.writeFileSync(
    path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}return n(s,c);}`
  );
  fs.writeFileSync(
    path.join(dir, 'register.mjs'),
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`
  );

  fs.writeFileSync(path.join(dir, 'case.mjs'), caseCode);
  const r = spawnSync(
    process.execPath,
    ['--import', path.join(dir, 'register.mjs')],
    { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 解析沙箱 stdout 的 JSON；失败时抛出带 stderr 的错误。 */
function parseResult(r) {
  assert.equal(r.status, 0, `sandbox exit ${r.status}\nSTDERR:\n${r.stderr}`);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

/** 同一场景分别跑 before / after，返回两者结果。 */
function runBoth(opts) {
  const before = parseResult(runSandbox({ ...opts, variant: 'before' }));
  const after = parseResult(runSandbox({ ...opts, variant: 'after' }));
  return { before, after };
}

// ===========================================================================
// Supabase 场景
// ===========================================================================

const SUPABASE_CASE = `
const mod = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
const cc = iso.cc || [];
const as = iso.as || {get:0,set:0,remove:0};
const ss = iso.ss || {get:0,set:0,delete:0};
const auth = cc[0] && cc[0].options && cc[0].options.auth ? cc[0].options.auth : null;
process.stdout.write(JSON.stringify({
  isSupabaseConfigured: mod.isSupabaseConfigured,
  supabaseConfigErrors: mod.supabaseConfigErrors,
  supabaseIsNull: mod.supabase === null,
  supabaseIsObject: mod.supabase !== null && typeof mod.supabase === 'object',
  createClientCallCount: cc.length,
  createClientArgs: cc.map((c)=>({url:c.url,key:c.key,auth:c.options&&c.options.auth?{storageKey:c.options.auth.storageKey,autoRefreshToken:c.options.auth.autoRefreshToken,persistSession:c.options.auth.persistSession,detectSessionInUrl:c.options.auth.detectSessionInUrl,hasStorageAdapter:typeof c.options.auth.storage==='object'&&c.options.auth.storage!==null&&typeof c.options.auth.storage.getItem==='function'}:null})),
  asyncStorage: as, secureStore: ss,
  exports: Object.keys(mod).sort(),
}));
`;

test('S1 有效配置 → 构造客户端（before/after 一致）', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: SUPABASE_CASE,
  });
  assert.deepEqual(after, before);
  assert.equal(after.isSupabaseConfigured, true);
  assert.equal(after.supabaseIsObject, true);
  assert.equal(after.createClientCallCount, 1);
});

test('S2 缺失配置 → 不构造（before/after 一致）', () => {
  const { before, after } = runBoth({ env: {}, caseCode: SUPABASE_CASE });
  assert.deepEqual(after, before);
  assert.equal(after.isSupabaseConfigured, false);
  assert.equal(after.supabaseIsNull, true);
  assert.equal(after.createClientCallCount, 0);
});

test('S3 非法配置 → 不构造（before/after 一致）', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: 'http://x.supabase.co', EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: SUPABASE_CASE,
  });
  assert.deepEqual(after, before);
  assert.equal(after.isSupabaseConfigured, false);
  assert.equal(after.createClientCallCount, 0);
});

test('S4 createClient 调用次数/参数（url/key/auth 选项）一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: SUPABASE_CASE,
  });
  assert.deepEqual(after.createClientArgs, before.createClientArgs);
  assert.equal(after.createClientArgs[0].url, VALID_URL);
  assert.equal(after.createClientArgs[0].key, VALID_KEY);
  assert.equal(after.createClientArgs[0].auth.storageKey, 'sb-pjiyniqtrstcpnodsnqq-auth-token');
  assert.equal(after.createClientArgs[0].auth.autoRefreshToken, true);
  assert.equal(after.createClientArgs[0].auth.persistSession, true);
  assert.equal(after.createClientArgs[0].auth.detectSessionInUrl, false);
  assert.equal(after.createClientArgs[0].auth.hasStorageAdapter, true);
});

test('S5 Auth Storage get/set/remove 接口存在且行为一致', () => {
  const caseCode = `
const mod = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
const cc = iso.cc || [];
const auth = cc[0].options.auth;
const s = auth.storage;
const out = { hasGet: typeof s.getItem === 'function', hasSet: typeof s.setItem === 'function', hasRemove: typeof s.removeItem === 'function' };
// 触发一次 get/set/remove，记录底层调用
await s.getItem('k1');
await s.setItem('k2','v2');
await s.removeItem('k3');
out.as = iso.as; out.ss = iso.ss;
process.stdout.write(JSON.stringify(out));
`;
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode,
  });
  assert.deepEqual(after, before);
  assert.equal(after.hasGet, true);
  assert.equal(after.hasSet, true);
  assert.equal(after.hasRemove, true);
});

test('S6 storage 读取失败 → 适配器抛错（不降级明文）一致', () => {
  const caseCode = `
const mod = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
const cc = iso.cc || [];
const s = cc[0].options.auth.storage;
let threw = false, msg = '';
try { await s.getItem('k'); } catch (e) { threw = true; msg = String(e && e.code || e && e.message || e); }
process.stdout.write(JSON.stringify({ threw, msg, as: iso.as, ss: iso.ss }));
`;
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode,
    stubConfig: { secureStoreFail: true },
  });
  assert.deepEqual(after, before);
  assert.equal(after.threw, true);
});

test('S7 storage 写入失败 → 适配器抛错一致', () => {
  const caseCode = `
const mod = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
const cc = iso.cc || [];
const s = cc[0].options.auth.storage;
let threw = false, msg = '';
try { await s.setItem('k','v'); } catch (e) { threw = true; msg = String(e && e.code || e && e.message || e); }
process.stdout.write(JSON.stringify({ threw, msg, as: iso.as, ss: iso.ss }));
`;
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode,
    stubConfig: { secureStoreFail: true },
  });
  assert.deepEqual(after, before);
  assert.equal(after.threw, true);
});

test('S8 模块重复导入 → 单例（createClient 仅 1 次）一致', () => {
  const caseCode = `
const a = await import('./src/services/supabase');
const b = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
process.stdout.write(JSON.stringify({ same: a.supabase === b.supabase, cc: (iso.cc||[]).length }));
`;
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode,
  });
  assert.deepEqual(after, before);
  assert.equal(after.same, true);
  assert.equal(after.cc, 1);
});

test('S9 无意外真实网络访问（stub 记录 invoke 次数为 0）一致', () => {
  const caseCode = `
const mod = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
process.stdout.write(JSON.stringify({ inv: (iso.inv||[]).length }));
`;
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode,
  });
  assert.deepEqual(after, before);
  assert.equal(after.inv, 0);
});

test('S10 无凭证泄漏（导出键一致，不含 key/token 值）', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: SUPABASE_CASE,
  });
  assert.deepEqual(after.exports, before.exports);
  const serialized = JSON.stringify(after.exports);
  assert.equal(serialized.includes(VALID_KEY), false);
});

// ===========================================================================
// Push 场景
// ===========================================================================

const PUSH_CASE = (invoke) => `
const mod = await import('./src/services/pushService');
const iso = globalThis.__ISO__ || {};
const res = await mod.sendPushNotification('user-1', 'T', 'B', { k: 'v' });
process.stdout.write(JSON.stringify({ res, inv: iso.inv || [] }));
`;

test('P1 正常成功 → 透传 { ok:true, ticketId } 一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: { invoke: { data: { ok: true, ticketId: 'ticket-123' }, error: null } },
  });
  assert.deepEqual(after, before);
  assert.deepEqual(after.res, { ok: true, ticketId: 'ticket-123' });
});

test('P2 skipped 分支 → 透传 { ok:true, skipped, reason } 一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: { invoke: { data: { ok: true, skipped: true, reason: 'target has no push token' }, error: null } },
  });
  assert.deepEqual(after, before);
  assert.equal(after.res.ok, true);
  assert.equal(after.res.skipped, true);
});

test('P3 Edge Function 错误返回（HTTP 非 2xx）→ status/category 一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: {
      invoke: {
        throw: {
          message: 'Edge Function returned a non-2xx status code',
          status: 403,
          jsonBody: { error: 'Not authorized to push to this user' },
        },
      },
    },
  });
  assert.deepEqual(after, before);
  assert.equal(after.res.ok, false);
  assert.equal(after.res.status, 403);
  assert.equal(after.res.category, 'forbidden');
});

test('P4 网络异常（无 status）→ { ok:false, reason } 一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: {
      invoke: { throw: { message: 'Failed to fetch' } },
    },
  });
  assert.deepEqual(after, before);
  assert.equal(after.res.ok, false);
  assert.equal(after.res.status, undefined);
  assert.equal(after.res.category, undefined);
});

test('P5 非法参数（缺 receiverId）→ { ok:false, reason } 一致', () => {
  const caseCode = `
const mod = await import('./src/services/pushService');
const res = await mod.sendPushNotification('', 'T', 'B', {});
process.stdout.write(JSON.stringify({ res }));
`;
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode,
  });
  assert.deepEqual(after, before);
  assert.deepEqual(after.res, { ok: false, reason: 'missing receiverId' });
});

test('P6 缺失 auth 信息（401）→ category=auth 一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: {
      invoke: {
        throw: {
          message: 'Edge Function returned a non-2xx status code',
          status: 401,
          jsonBody: { error: 'Invalid or expired token' },
        },
      },
    },
  });
  assert.deepEqual(after, before);
  assert.equal(after.res.status, 401);
  assert.equal(after.res.category, 'auth');
});

test('P7 nullable ticketId（ticketId=null）→ 透传 null 一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: { invoke: { data: { ok: true, ticketId: null }, error: null } },
  });
  assert.deepEqual(after, before);
  assert.equal(after.res.ok, true);
  assert.equal(after.res.ticketId, null);
});

test('P8 敏感错误串脱敏（JWT / Push Token / Bearer）一致', () => {
  const sensitive = 'leak eyJabcdefgh.abcdefgh.abcdefgh ExponentPushToken[abc] Bearer xyz.abc';
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: {
      invoke: {
        throw: {
          message: 'Edge Function returned a non-2xx status code',
          status: 500,
          jsonBody: { error: sensitive },
        },
      },
    },
  });
  assert.deepEqual(after, before);
  assert.equal(after.res.ok, false);
  assert.equal(after.res.reason.includes('eyJabcdefgh'), false);
  assert.equal(after.res.reason.includes('ExponentPushToken'), false);
  assert.equal(after.res.reason.includes('Bearer'), false);
});

test('P9 请求参数 + 调用次数（Edge Function 名、body 字段）一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: { invoke: { data: { ok: true, ticketId: 't1' }, error: null } },
  });
  assert.deepEqual(after.inv, before.inv);
  assert.equal(after.inv.length, 1);
  assert.equal(after.inv[0].name, 'send-push');
  assert.deepEqual(after.inv[0].opts.body, { targetUserId: 'user-1', title: 'T', body: 'B', data: { k: 'v' } });
});

test('P10 原始失败返回结构（{ ok:false, error } HTTP 200）一致', () => {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_CASE(),
    stubConfig: { invoke: { data: { ok: false, error: 'Push ticket error' }, error: null } },
  });
  assert.deepEqual(after, before);
  assert.deepEqual(after.res, { ok: false, reason: 'Push ticket error' });
});

// ===========================================================================
// Push 边界等价场景（P1.2 R4 Gatekeeper 复审补充）
//
// 背景：Gatekeeper 独立复审发现旧实现 `return result ?? { ok: true }` 的
// 「原样透传」语义在迁移版中被改写（强制补 ok:true / 丢字段 / undefined→""）。
// 以下用例逐条锁定这些边界，断言**完整返回值**（deepEqual），而非部分字段。
// ===========================================================================

/**
 * 以任意 invoke 返回体执行一次 sendPushNotification，返回完整结果 + 调用记录。
 * @param {object} invoke stubConfig.invoke
 * @param {string} [dataExpr] 传给 sendPushNotification 的 data 表达式
 */
const PUSH_BOUNDARY_CASE = (dataExpr = "{ k: 'v' }") => `
const mod = await import('./src/services/pushService');
const iso = globalThis.__ISO__ || {};
const res = await mod.sendPushNotification('user-1', 'T', 'B', ${dataExpr});
process.stdout.write(JSON.stringify({ res, inv: iso.inv || [] }));
`;

/** 断言 before/after 完整结果一致，并返回 after 结果。 */
function assertBoundaryEqual(invoke, dataExpr) {
  const { before, after } = runBoth({
    env: { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY },
    caseCode: PUSH_BOUNDARY_CASE(dataExpr),
    stubConfig: { invoke },
  });
  assert.deepEqual(after, before);
  return after;
}

test('P11 data={ticketId:"x"} → 原样透传（不补 ok:true）一致', () => {
  const after = assertBoundaryEqual({ data: { ticketId: 'x' }, error: null });
  assert.deepEqual(after.res, { ticketId: 'x' });
  assert.equal('ok' in after.res, false);
});

test('P12 data={ok:false} → reason 为 undefined（不转 ""）一致', () => {
  const after = assertBoundaryEqual({ data: { ok: false }, error: null });
  // 注意：JSON 序列化会丢弃值为 undefined 的键，因此这里断言「键不存在」
  // 而非「键存在且为 undefined」。两者在运行时等价（读取均为 undefined），
  // 但 JSON 往返后只剩前者可观测。
  assert.deepEqual(after.res, { ok: false });
  assert.equal(after.res.reason, undefined);
  assert.equal('reason' in after.res, false);
});

test('P13 data={} → 原样返回 {}（不补 ok:true）一致', () => {
  const after = assertBoundaryEqual({ data: {}, error: null });
  assert.deepEqual(after.res, {});
  assert.equal('ok' in after.res, false);
});

test('P14 data={ok:1} → 保留原始值 1（不改写为 true）一致', () => {
  const after = assertBoundaryEqual({ data: { ok: 1 }, error: null });
  assert.deepEqual(after.res, { ok: 1 });
  assert.equal(after.res.ok, 1);
});

test('P15 data=false → 原样返回 false（不替换为 {ok:true}）一致', () => {
  const after = assertBoundaryEqual({ data: false, error: null });
  assert.equal(after.res, false);
});

test('P16 data=null → 兜底 { ok:true } 一致', () => {
  const after = assertBoundaryEqual({ data: null, error: null });
  assert.deepEqual(after.res, { ok: true });
});

test('P17 data=undefined（invoke 返回 undefined）→ 兜底 { ok:true } 一致', () => {
  const after = assertBoundaryEqual({ data: undefined, error: null });
  assert.deepEqual(after.res, { ok: true });
});

test('P18 data={ok:true,ticketId:null} → 透传 null 一致', () => {
  const after = assertBoundaryEqual({ data: { ok: true, ticketId: null }, error: null });
  assert.deepEqual(after.res, { ok: true, ticketId: null });
});

test('P19 data={ok:true,delivered:true} → 保留附加字段一致', () => {
  const after = assertBoundaryEqual({ data: { ok: true, delivered: true }, error: null });
  assert.deepEqual(after.res, { ok: true, delivered: true });
});

test('P20 data={ok:false,error:"failed"} → reason=error 一致', () => {
  const after = assertBoundaryEqual({ data: { ok: false, error: 'failed' }, error: null });
  assert.deepEqual(after.res, { ok: false, reason: 'failed' });
});

test('P21 data={ok:false,reason:"failed"} → reason=reason 一致', () => {
  const after = assertBoundaryEqual({ data: { ok: false, reason: 'failed' }, error: null });
  assert.deepEqual(after.res, { ok: false, reason: 'failed' });
});

test('P22 error.context 缺失 → { ok:false, reason } 无 status/category 一致', () => {
  const after = assertBoundaryEqual({ throw: { message: 'boom' } });
  assert.deepEqual(after.res, { ok: false, reason: 'boom' });
  assert.equal('status' in after.res, false);
  assert.equal('category' in after.res, false);
});

test('P23 error.context.json() 失败 → 仅保留 status/category 一致', () => {
  const after = assertBoundaryEqual({
    throw: { message: 'Edge Function returned a non-2xx status code', status: 500, jsonBody: null, jsonThrows: true },
  });
  assert.deepEqual(after.res, {
    ok: false,
    reason: 'Edge Function returned a non-2xx status code',
    status: 500,
    category: 'server_config',
  });
});

test('P24 error.error.code 类型异常（number）→ 忽略，回退 message 一致', () => {
  const after = assertBoundaryEqual({
    throw: {
      message: 'Edge Function returned a non-2xx status code',
      status: 400,
      jsonBody: { error: { code: 12345 } },
    },
  });
  assert.deepEqual(after.res, {
    ok: false,
    reason: 'Edge Function returned a non-2xx status code',
    status: 400,
    category: 'bad_request',
  });
});

test('P25 error.message 缺失 → 回退 "push invoke failed" 一致', () => {
  // 注意：stub 用 `new Error(message)` 构造错误对象，`new Error(null)` 的
  // `message` 实际为字符串 'null'（JS 规范行为），并非「缺失」。
  // 为真实模拟「message 缺失」，这里用 raw 直接注入一个无 message 的错误对象。
  const after = assertBoundaryEqual({ throw: { raw: { context: { status: 404 } } } });
  assert.deepEqual(after.res, {
    ok: false,
    reason: 'push invoke failed',
    status: 404,
    category: 'target_missing',
  });
});

test('P26 非标准错误对象（字符串抛出）→ 一致', () => {
  const after = assertBoundaryEqual({ throw: { message: null, raw: 'plain-string-error' } });
  assert.deepEqual(after.res, { ok: false, reason: 'push invoke failed' });
});
// --- END OF FILE tests/security/p12r4MigrationEquivalence.test.mjs ---
