#!/usr/bin/env node
// ============================================================================
// 最小可重复回归测试（无测试框架 / 纯 Node ESM）
//
// 用法：
//   node tests/regression/run_all.mjs
//
// 覆盖：
//   A. 配置解析契约（含 R1 hostname 首段为空、R3 Key 控制字符边界）
//   B. 客户端隔离（stub 真实 supabase.js：异常 0 构造/0 存储；正常 1 构造且 auth 保持）
//   C. storageKey 逐字节回归
//   D. RootLayout 静态结构（拦截在 Provider 之前、错误页无上下文依赖）
//
// 说明：
//   - 不联网、不使用真实 .env / 真实 Token。
//   - 隔离测试通过临时目录 + stub 模块运行真实源码，结束后自动清理。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 仓库根：tests/regression -> tests -> root
const repoRoot = path.resolve(here, '../..');
// 源码已迁移为 TypeScript（P1.2 R0）。沙箱在纯 Node 下运行，
// 因此读取 .ts 源码并在沙箱内以 .js 落盘后 import，测试逻辑保持不变。
const configPath = path.join(repoRoot, 'src/services/supabaseConfig.ts');
const supabasePath = path.join(repoRoot, 'src/services/supabase.ts');
// P1.2 R5：authStorage 已迁移为 TypeScript。
const authStoragePath = path.join(repoRoot, 'src/services/authStorage.ts');
const layoutPath = path.join(repoRoot, 'src/app/_layout.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push({ name, detail }); }
  const mark = cond ? '✅' : '❌';
  console.log(`  ${mark} ${name}${cond ? '' : '  → ' + safe(detail)}`);
}
function safe(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------------------------------------------------------------------------
// A. 配置解析契约
// ---------------------------------------------------------------------------
async function sectionA() {
  console.log('\n[A] 配置解析契约');
  const { parseSupabaseConfig, CONFIG_ERROR } = await import(pathToFileURL(configPath).href);
  const KEY = 'fake-anon-key';

  // A1 缺失
  let r = parseSupabaseConfig(undefined, undefined);
  check('A1 全缺失 → ok:false', r.ok === false);
  check('A1 错误码含 MISSING_URL', r.errors.includes(CONFIG_ERROR.MISSING_URL));
  check('A1 错误码含 MISSING_KEY', r.errors.includes(CONFIG_ERROR.MISSING_KEY));
  check('A1 失败不返回 storageKey', r.storageKey === undefined);

  // A2 仅缺 key
  r = parseSupabaseConfig('https://abc.supabase.co', undefined);
  check('A2 仅缺 key → 仅 MISSING_KEY', r.ok === false && r.errors.length === 1 && r.errors[0] === CONFIG_ERROR.MISSING_KEY);

  // A3 空白串
  r = parseSupabaseConfig('   ', '   ');
  check('A3 空白串 → MISSING_URL+MISSING_KEY', r.ok === false && r.errors.includes(CONFIG_ERROR.MISSING_URL) && r.errors.includes(CONFIG_ERROR.MISSING_KEY));

  // A4 http://
  r = parseSupabaseConfig('http://abc.supabase.co', KEY);
  check('A4 http:// → INVALID_PROTOCOL', r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_PROTOCOL));

  // A5 ftp://
  r = parseSupabaseConfig('ftp://abc.supabase.co', KEY);
  check('A5 ftp:// → INVALID_PROTOCOL', r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_PROTOCOL));

  // A6 无 scheme
  r = parseSupabaseConfig('abc.supabase.co', KEY);
  check('A6 无 scheme → INVALID_URL', r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_URL));

  // A7 完全非法
  r = parseSupabaseConfig('not a url', KEY);
  check('A7 非法 URL → INVALID_URL', r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_URL));

  // A8 内嵌凭据
  r = parseSupabaseConfig('https://user:pass@abc.supabase.co', KEY);
  check('A8 内嵌凭据 → INVALID_URL', r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_URL));

  // A9 合法
  r = parseSupabaseConfig('https://abc.supabase.co', KEY);
  check('A9 合法 → ok:true', r.ok === true);
  check('A9 storageKey 正确', r.storageKey === 'sb-abc-auth-token', r.storageKey);
  check('A9 url/key 回传', r.url === 'https://abc.supabase.co' && r.key === KEY);

  // A10 大小写协议
  r = parseSupabaseConfig('HTTPS://abc.supabase.co', KEY);
  check('A10 大写 HTTPS 接受', r.ok === true && r.storageKey === 'sb-abc-auth-token');

  // A11 前后空白 trim
  r = parseSupabaseConfig('  https://abc.supabase.co  ', '  ' + KEY + '  ');
  check('A11 前后空白被 trim', r.ok === true && r.url === 'https://abc.supabase.co' && r.key === KEY);

  // ---- R1：hostname 首段为空 ----
  for (const bad of ['https://.example.com', 'https://..example.com', 'https://.']) {
    r = parseSupabaseConfig(bad, KEY);
    check(`R1 ${bad} → INVALID_URL`, r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_URL), r);
    check(`R1 ${bad} 不生成 sb--auth-token`, r.storageKey === undefined, r.storageKey);
  }
  // R1 正常对照
  r = parseSupabaseConfig('https://abc.example.com', KEY);
  check('R1 正常 https://abc.example.com → sb-abc-auth-token', r.ok === true && r.storageKey === 'sb-abc-auth-token');

  // ---- R3：Key 控制字符 ----
  const badKeys = {
    LF: 'abc\ndef',
    CR: 'abc\rdef',
    NUL: 'abc\u0000def',
    TAB: 'abc\tdef',
    DEL: 'abc\u007fdef',
  };
  for (const [name, k] of Object.entries(badKeys)) {
    r = parseSupabaseConfig('https://abc.supabase.co', k);
    check(`R3 Key 含 ${name} → INVALID_KEY`, r.ok === false && r.errors.includes(CONFIG_ERROR.INVALID_KEY), r.errors);
    check(`R3 Key 含 ${name} 不返回 key`, r.key === undefined);
  }
  // R3 正常对照：普通 key 与含可见特殊字符的 key 仍接受
  r = parseSupabaseConfig('https://abc.supabase.co', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig-_x');
  check('R3 正常 JWT 形态 key 接受', r.ok === true);
  r = parseSupabaseConfig('https://abc.supabase.co', 'key.with.dots-and_underscores');
  check('R3 含 . - _ 的 key 接受', r.ok === true);

  // R3 与 MISSING_KEY 不重复
  r = parseSupabaseConfig('https://abc.supabase.co', '');
  check('R3 空 key 只报 MISSING_KEY 不报 INVALID_KEY', r.ok === false && r.errors.includes(CONFIG_ERROR.MISSING_KEY) && !r.errors.includes(CONFIG_ERROR.INVALID_KEY));
}

// ---------------------------------------------------------------------------
// B. 客户端隔离（真实 supabase.js + stub 依赖，独立子进程）
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf01-reg-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };
  mk('react-native-url-polyfill', {
    'package.json': JSON.stringify({ name: 'react-native-url-polyfill', version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js', './auto': './auto.js' } }),
    'index.js': 'globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.polyfill=(globalThis.__ISO__.polyfill||0)+1;export default {};',
    'auto.js': 'globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.polyfill=(globalThis.__ISO__.polyfill||0)+1;export default {};',
  });
  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `const rec=(o)=>{globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.as=globalThis.__ISO__.as||{get:0,set:0,remove:0};globalThis.__ISO__.as[o]+=1;};export default {getItem:async()=>{rec('get');return null;},setItem:async()=>{rec('set');},removeItem:async()=>{rec('remove');}};`,
  });
  mk('expo-secure-store', {
    'package.json': JSON.stringify({ name: 'expo-secure-store', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `const rec=(o)=>{globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.ss=globalThis.__ISO__.ss||{get:0,set:0,delete:0};globalThis.__ISO__.ss[o]+=1;};export const getItemAsync=async()=>{rec('get');return null;};export const setItemAsync=async()=>{rec('set');};export const deleteItemAsync=async()=>{rec('delete');};export default {getItemAsync,setItemAsync,deleteItemAsync};`,
  });
  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export function createClient(url,key,options){globalThis.__ISO__=globalThis.__ISO__||{};globalThis.__ISO__.cc=globalThis.__ISO__.cc||[];globalThis.__ISO__.cc.push({url,key,options});return {__stub:true,url,key,options};}export default {createClient};`,
  });
  // 复制真实源码
  // 注意：supabase.js 现在依赖 ./authStorage（C01/C02 抽取的适配器模块），
  // 沙箱必须一并复制，否则子进程会 ERR_MODULE_NOT_FOUND。
  fs.mkdirSync(path.join(dir, 'src/services'), { recursive: true });
  // 源码已迁移为 TypeScript（P1.2 R4 / R5）。Node 24 原生支持 .ts 类型擦除，
  // 沙箱以 .ts 落盘，resolve hook 会为无扩展名导入补 .ts。
  fs.copyFileSync(supabasePath, path.join(dir, 'src/services/supabase.ts'));
  fs.copyFileSync(configPath, path.join(dir, 'src/services/supabaseConfig.ts'));
  fs.copyFileSync(authStoragePath, path.join(dir, 'src/services/authStorage.ts'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  // resolve hook：允许无扩展名相对导入
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}try{return await n(s+'.ts',c);}catch{}}return n(s,c);}`);
  fs.writeFileSync(path.join(dir, 'entry.mjs'),
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);await import('./run_case.mjs');`);
  fs.writeFileSync(path.join(dir, 'run_case.mjs'), `
const mod = await import('./src/services/supabase');
const iso = globalThis.__ISO__ || {};
const cc = iso.cc || [];
const as = iso.as || {get:0,set:0,remove:0};
const ss = iso.ss || {get:0,set:0,delete:0};
process.stdout.write(JSON.stringify({
  isSupabaseConfigured: mod.isSupabaseConfigured,
  supabaseConfigErrors: mod.supabaseConfigErrors,
  supabaseIsNull: mod.supabase === null,
  supabaseIsObject: mod.supabase !== null && typeof mod.supabase === 'object',
  createClientCallCount: cc.length,
  createClientArgs: cc.map((c)=>({url:c.url,key:c.key,auth:c.options&&c.options.auth?{storageKey:c.options.auth.storageKey,autoRefreshToken:c.options.auth.autoRefreshToken,persistSession:c.options.auth.persistSession,detectSessionInUrl:c.options.auth.detectSessionInUrl,hasStorageAdapter:typeof c.options.auth.storage==='object'&&c.options.auth.storage!==null&&typeof c.options.auth.storage.getItem==='function'}:null})),
  asyncStorage: as, secureStore: ss,
}));`);
  return dir;
}

function runCase(dir, env) {
  const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
    cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  if (child.status !== 0) return { __error: true, stderr: child.stderr, stdout: child.stdout };
  return JSON.parse(child.stdout);
}

function sectionB() {
  console.log('\n[B] 客户端隔离（真实 supabase.js + stub）');
  const dir = buildSandbox();
  const VALID_URL = 'https://pjiyniqtrstcpnodsnqq.supabase.co';
  const VALID_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig';
  try {
    // B1 全缺失
    let r = runCase(dir, {});
    check('B1 子进程正常退出', !r.__error, r.__error ? r.stderr : null);
    if (!r.__error) {
      check('B1 isSupabaseConfigured=false', r.isSupabaseConfigured === false);
      check('B1 supabase=null', r.supabaseIsNull === true);
      check('B1 createClient 0 次', r.createClientCallCount === 0);
      check('B1 存储读写 0 次', r.asyncStorage.get + r.asyncStorage.set + r.asyncStorage.remove + r.secureStore.get + r.secureStore.set + r.secureStore.delete === 0, { a: r.asyncStorage, s: r.secureStore });
    }
    // B2 仅缺 key
    r = runCase(dir, { EXPO_PUBLIC_SUPABASE_URL: VALID_URL });
    check('B2 仅缺 key → 不构造', !r.__error && r.isSupabaseConfigured === false && r.createClientCallCount === 0);
    // B3 http
    r = runCase(dir, { EXPO_PUBLIC_SUPABASE_URL: 'http://x.supabase.co', EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY });
    check('B3 http → 不构造', !r.__error && r.isSupabaseConfigured === false && r.createClientCallCount === 0);
    // B4 非法 URL
    r = runCase(dir, { EXPO_PUBLIC_SUPABASE_URL: 'not-a-url', EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY });
    check('B4 非法 URL → 不构造', !r.__error && r.isSupabaseConfigured === false && r.createClientCallCount === 0);
    // B5 R1 hostname 首段为空 → 不构造
    r = runCase(dir, { EXPO_PUBLIC_SUPABASE_URL: 'https://.example.com', EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY });
    check('B5 R1 空首段 → 不构造', !r.__error && r.isSupabaseConfigured === false && r.createClientCallCount === 0, r.__error ? r.stderr : r);
    // B6 R3 Key 控制字符 → 不构造
    r = runCase(dir, { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'abc\ndef' });
    check('B6 R3 控制字符 key → 不构造', !r.__error && r.isSupabaseConfigured === false && r.createClientCallCount === 0, r.__error ? r.stderr : r);
    // B7 合法
    r = runCase(dir, { EXPO_PUBLIC_SUPABASE_URL: VALID_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY: VALID_KEY });
    check('B7 合法 → 子进程正常退出', !r.__error, r.__error ? r.stderr : null);
    if (!r.__error) {
      check('B7 isSupabaseConfigured=true', r.isSupabaseConfigured === true);
      check('B7 supabase 非 null', r.supabaseIsObject === true);
      check('B7 createClient 恰好 1 次', r.createClientCallCount === 1);
      check('B7 无错误码', Array.isArray(r.supabaseConfigErrors) && r.supabaseConfigErrors.length === 0);
      const a = r.createClientArgs[0] || {};
      check('B7 url 正确', a.url === VALID_URL);
      check('B7 key 正确', a.key === VALID_KEY);
      check('B7 storageKey 逐字节一致', a.auth && a.auth.storageKey === 'sb-pjiyniqtrstcpnodsnqq-auth-token', a.auth && a.auth.storageKey);
      check('B7 autoRefreshToken=true', a.auth && a.auth.autoRefreshToken === true);
      check('B7 persistSession=true', a.auth && a.auth.persistSession === true);
      check('B7 detectSessionInUrl=false', a.auth && a.auth.detectSessionInUrl === false);
      check('B7 storage 为适配器', a.auth && a.auth.hasStorageAdapter === true);
      check('B7 构造期存储读写 0 次', r.asyncStorage.get + r.asyncStorage.set + r.asyncStorage.remove + r.secureStore.get + r.secureStore.set + r.secureStore.delete === 0, { a: r.asyncStorage, s: r.secureStore });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// C. storageKey 逐字节回归
// ---------------------------------------------------------------------------
async function sectionC() {
  console.log('\n[C] storageKey 逐字节回归');
  const { parseSupabaseConfig } = await import(pathToFileURL(configPath).href);
  const KEY = 'fake-key';
  const legacy = (u) => `sb-${new URL(u).hostname.split('.')[0]}-auth-token`;
  const urls = [
    'https://pjiyniqtrstcpnodsnqq.supabase.co',
    'https://abcdefghijklmnop.supabase.co',
    'https://my-project-ref.supabase.co',
    'https://x.supabase.co',
    'https://a.b.c.d.example.com',
    'https://project-ref.supabase.in',
    'https://sub.domain.example.org',
    'https://UPPERCASE-REF.supabase.co',
    'https://ref-with-dash.supabase.co',
    'https://ref_with_underscore.supabase.co',
    'https://1234567890.supabase.co',
    'https://ref.supabase.co:443',
    'https://ref.supabase.co/some/path',
    'https://ref.supabase.co/',
    'https://ref.supabase.co?query=1',
    'https://xn--fiqs8s.example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://ref.supabase.co#frag',
  ];
  for (const u of urls) {
    const r = parseSupabaseConfig(u, KEY);
    check(`C ${u} → 与旧表达式一致`, r.ok === true && r.storageKey === legacy(u), { got: r.storageKey, want: legacy(u) });
  }
  const base = parseSupabaseConfig('https://ref.supabase.co', KEY).storageKey;
  const withPath = parseSupabaseConfig('https://ref.supabase.co/a/b?c=d', KEY).storageKey;
  check('C path/query 不影响 storageKey', base === withPath);
}

// ---------------------------------------------------------------------------
// D. RootLayout 静态结构
// ---------------------------------------------------------------------------
function sectionD() {
  console.log('\n[D] RootLayout 静态结构');
  const src = fs.readFileSync(layoutPath, 'utf8');
  check('D 导入 isSupabaseConfigured', /import\s*\{[^}]*isSupabaseConfigured[^}]*\}\s*from\s*'\.\.\/services\/supabase'/.test(src));
  check('D 导入 supabaseConfigErrors', /import\s*\{[^}]*supabaseConfigErrors[^}]*\}\s*from\s*'\.\.\/services\/supabase'/.test(src));
  const rootIdx = src.indexOf('export default function RootLayout()');
  check('D 存在 RootLayout', rootIdx !== -1);
  const guardIdx = src.indexOf('if (!isSupabaseConfigured)', rootIdx);
  const providerIdx = src.indexOf('<ThemeProvider>', rootIdx);
  check('D 守卫在 ThemeProvider 之前', guardIdx !== -1 && providerIdx !== -1 && guardIdx < providerIdx, { guardIdx, providerIdx });
  check('D 守卫返回 ConfigErrorView', /if\s*\(!isSupabaseConfigured\)\s*\{\s*return\s*<ConfigErrorView\s*\/>\s*;/.test(src));
  const cevStart = src.indexOf('function ConfigErrorView()');
  const cevEnd = src.indexOf('export default function RootLayout()');
  const cev = src.slice(cevStart, cevEnd);
  check('D ConfigErrorView 存在', cevStart !== -1 && cevEnd !== -1);
  check('D ConfigErrorView 无 Provider/hook/导航依赖', !/useAuth|useHealthData|useAppTheme|useRouter|useSegments|<Stack|router\./.test(cev));
  check('D ConfigErrorView 仅用 View/Text', /<View/.test(cev) && /<Text/.test(cev));
  const order = ['<ThemeProvider>', '<AuthProvider>', '<HealthProvider>', '<CinemaProvider>', '<BrowserSessionProvider>', '<RootNavigation />'];
  let last = -1, ok = true;
  for (const t of order) { const i = src.indexOf(t, rootIdx); if (i === -1 || i < last) { ok = false; break; } last = i; }
  check('D Provider 树顺序不变', ok);
  check('D 异常分支无 createClient/supabase 调用', !/createClient|supabase\./.test(src.slice(guardIdx, providerIdx)));
}

// ---------------------------------------------------------------------------
(async () => {
  console.log('===== TASK-P0.1-HF01 回归测试 =====');
  await sectionA();
  sectionB();
  await sectionC();
  sectionD();
  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} / 合计 ${pass + fail} =====`);
  if (fail > 0) {
    console.log('失败明细：');
    for (const f of failures) console.log(' -', f.name, safe(f.detail));
    process.exit(1);
  }
  process.exit(0);
})();
