// --- START OF FILE tests/security/p04_chatContract.test.mjs ---
// ============================================================================
// TASK-P0.4 / 聊天模块 — 最小契约测试
//
// 目的：P0.3 的 229 个测试集中在 auth / health / isolation / media cache，
//       聊天模块几乎零自动化覆盖。本测试锁定聊天模块三个「纯函数契约」，
//       防止后续重构（P1）无意改变消息渲染 / 列表预览 / 存储路径归一化语义：
//         P04-CHAT-01 formatDbMsg：DB 行 → UI 消息对象（撤回文案、isMe、时间戳）；
//         P04-CHAT-02 formatPreview：会话列表预览文案（按 type/subtype 协议）；
//         P04-CHAT-03 cleanStoragePath：媒体存储路径归一化（剥离桶名/完整 URL，
//                     拒绝本地 URI）。
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - formatDbMsg / formatPreview 通过 stub 依赖后运行真实源码；
//     cleanStoragePath 从真实源码精确抽取（该文件 import 大量原生模块）。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** 从真实 useMediaUpload 源码抽取 cleanStoragePath 函数源码（该文件含大量原生 import）。 */
function extractCleanStoragePath() {
  // P1.4 R8：useMediaUpload 已迁移为 .ts，按 .ts 优先、.js 兜底解析真实源码。
  const mediaRel = ['src/hooks/chat/useMediaUpload.ts', 'src/hooks/chat/useMediaUpload.js']
    .find((rel) => fs.existsSync(path.join(repoRoot, rel)));
  if (!mediaRel) throw new Error('未找到 useMediaUpload 源码（.ts 或 .js）');
  const src = fs.readFileSync(path.join(repoRoot, mediaRel), 'utf8');
  const start = src.indexOf('export function cleanStoragePath(');
  if (start < 0) throw new Error('未找到 cleanStoragePath');
  const endMarker = '\n}\n';
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error('未找到 cleanStoragePath 结束位置');
  const fn = src.slice(start, end + endMarker.length);
  // 该函数依赖模块级常量 STORAGE_BUCKET，抽取时一并注入。
  const withConst = `const STORAGE_BUCKET = 'chat_media';\n${fn}`;
  // P1.4 R8：.ts 源含类型注解，需用项目自带 TypeScript 编译器做类型擦除后再注入沙箱。
  if (mediaRel.endsWith('.ts')) {
    const ts = createRequire(import.meta.url)('typescript');
    return ts.transpileModule(withConst, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
      fileName: 'useMediaUpload.ts',
    }).outputText;
  }
  return withConst;
}

function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-chat-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  mk('@react-native-async-storage/async-storage', {
    'package.json': JSON.stringify({ name: '@react-native-async-storage/async-storage', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `const s=new Map();export default { async getItem(k){return s.has(k)?s.get(k):null;}, async setItem(k,v){s.set(k,String(v));}, async removeItem(k){s.delete(k);}, async multiSet(p){for(const [k,v] of p)s.set(k,String(v));}, async multiRemove(ks){for(const k of ks)s.delete(k);}, async getAllKeys(){return [...s.keys()];}, async clear(){s.clear();} };`,
  });

  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
export const useEffect = () => {};
export const useCallback = (fn) => fn;
export const useMemo = (fn) => fn();
export const useRef = (v) => ({ current: v });
export const createContext = (v) => ({ __ctx: v });
export const useContext = () => ({});
export default { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext };
`,
  });

  mk('expo-router', {
    'package.json': JSON.stringify({ name: 'expo-router', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const useFocusEffect = () => {}; export default { useFocusEffect };`,
  });

  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const impactAsync = async () => {}; export const notificationAsync = async () => {}; export const ImpactFeedbackStyle = {}; export const NotificationFeedbackType = {}; export default {};`,
  });

  mk('@supabase/supabase-js', {
    'package.json': JSON.stringify({ name: '@supabase/supabase-js', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': 'export function createClient(){ return {}; } export default { createClient };',
  });

  // P1.4 R6：useChatMessages / useChatList 已迁移为 .ts，按 .ts 优先、.js 兜底解析。
  //   .ts 源含 `import type` 等类型语法，Node 无法直接执行，需用项目自带 TypeScript
  //   编译器做类型擦除后以 .js 落盘（与生产构建同一套编译器，非手写改写）。
  const requireTs = createRequire(import.meta.url);
  const ts = requireTs('typescript');
  const resolveSrc = (rel) => {
    const tsRel = rel.replace(/\.js$/, '.ts');
    return fs.existsSync(path.join(repoRoot, tsRel)) ? tsRel : rel;
  };
  const copy = (rel) => {
    const actual = resolveSrc(rel);
    const src = path.join(repoRoot, actual);
    // 沙箱内 import 路径统一为 .js，故以 rel 落盘。
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (actual.endsWith('.ts')) {
      const code = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        fileName: path.basename(actual),
      }).outputText;
      fs.writeFileSync(dst, code);
    } else {
      fs.copyFileSync(src, dst);
    }
  };
  copy('src/hooks/chat/useChatMessages.js');
  copy('src/hooks/chat/useChatList.js');
  // P1.0 工作包 B：useChatList/useChatMessages 现依赖 useOwnerKey（→ useAuth）
  copy('src/hooks/useOwnerKey.js');

  // stub 依赖
  const stub = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  // useOwnerKey 依赖 useAuth 导出的 ownerId / authEpoch；测试仅需稳定默认值
  stub('src/hooks/useAuth.js', `export const useAuth = () => ({ ownerId: null, authEpoch: 0 }); export default { useAuth };`);
  stub('src/services/supabase.js', `export const supabase = { from(){ return { select(){return this;}, eq(){return this;}, single(){return Promise.resolve({data:null,error:null});}, order(){return this;}, limit(){return this;}, insert(){return Promise.resolve({error:null});}, update(){return this;}, delete(){return this;}, in(){return this;} }; }, channel(){ return { on(){return this;}, subscribe(){return this;} }; }, removeChannel(){ return Promise.resolve(); } };`);
  stub('src/services/mediaCache.js', `export const downloadToSandbox = async () => null; export const persistMedia = async () => null; export const resolveLocalMedia = async () => null;`);
  stub('src/hooks/chat/useSignedMediaUrl.js', `export const getSignedUrl = async () => null;`);

  // 抽取 cleanStoragePath 到独立模块
  fs.mkdirSync(path.join(dir, 'src/hooks/chat'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/hooks/chat/_cleanPath.js'), `${extractCleanStoragePath()}\n`);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'resolve-hook.mjs'),
    `export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!/\\.[a-z0-9]+$/i.test(s)){try{return await n(s+'.js',c);}catch{}}return n(s,c);}`);
  return dir;
}

function runInSandbox(dir, body) {
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(entry,
    `import {register} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {fileURLToPath} from 'node:url';const h=path.dirname(fileURLToPath(import.meta.url));register(pathToFileURL(path.join(h,'resolve-hook.mjs')).href,import.meta.url);const _log=console.log.bind(console);console.log=(...a)=>console.error(...a);console.info=(...a)=>console.error(...a);await import('./case.mjs');`);
  fs.writeFileSync(path.join(dir, 'case.mjs'), body);
  const child = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (child.status !== 0) {
    throw new Error(`sandbox failed (status ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  return JSON.parse(child.stdout);
}

// ---------------------------------------------------------------------------
// P04-CHAT-01：formatDbMsg 契约
// ---------------------------------------------------------------------------
test('P04-CHAT-01 formatDbMsg 正确映射 DB 行到 UI 消息对象', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { formatDbMsg } = await import('./src/hooks/chat/useChatMessages.js');
const me = 'user-me';
const other = 'user-other';
const createdAt = '2026-11-20T10:00:00.000Z';
const normal = formatDbMsg({ id: 'm1', type: 'text', subtype: null, text: 'hi', media_url: null, thumbnail_url: null, duration: 0, user_id: me, created_at: createdAt }, me);
const img = formatDbMsg({ id: 'm2', type: 'image', subtype: null, text: '', media_url: 'chat_media/u/a.jpg', thumbnail_url: null, duration: 0, user_id: other, created_at: createdAt }, me);
const recallMine = formatDbMsg({ id: 'm3', type: 'action', subtype: null, text: 'ignored', media_url: null, thumbnail_url: null, duration: 0, user_id: me, created_at: createdAt }, me);
const recallOther = formatDbMsg({ id: 'm4', type: 'action', subtype: null, text: 'ignored', media_url: null, thumbnail_url: null, duration: 0, user_id: other, created_at: createdAt }, me);
const withSubtype = formatDbMsg({ id: 'm5', type: 'action', subtype: 'SYNC_SYSTEM', text: '系统消息', media_url: null, thumbnail_url: null, duration: 0, user_id: other, created_at: createdAt }, me);
process.stdout.write(JSON.stringify({ normal, img, recallMine, recallOther, withSubtype, ts: new Date(createdAt).getTime() }));
`);
    assert.equal(out.normal.id, 'm1');
    assert.equal(out.normal.type, 'text');
    assert.equal(out.normal.subtype, null, 'subtype 缺省应为 null');
    assert.equal(out.normal.text, 'hi');
    assert.equal(out.normal.isMe, true, '本人消息 isMe=true');
    assert.equal(out.normal.timestamp, out.ts, 'timestamp 必须为 created_at 的毫秒值');
    assert.equal(out.img.isMe, false, '他人消息 isMe=false');
    assert.equal(out.img.mediaUrl, 'chat_media/u/a.jpg', 'mediaUrl 必须透传 media_url');
    assert.equal(out.recallMine.text, '你撤回了一条消息', '本人撤回文案');
    assert.equal(out.recallOther.text, '对方撤回了一条消息', '对方撤回文案');
    assert.equal(out.withSubtype.text, '系统消息', '有 subtype 的 action 消息保留原文（不替换撤回文案）');
    assert.equal(out.withSubtype.subtype, 'SYNC_SYSTEM');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-CHAT-02：formatPreview 契约
// ---------------------------------------------------------------------------
test('P04-CHAT-02 formatPreview 按 type/subtype 协议生成预览文案', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { formatPreview } = await import('./src/hooks/chat/useChatList.js');
const cases = {
  nullMsg: formatPreview(null),
  image: formatPreview({ type: 'image' }),
  video: formatPreview({ type: 'video' }),
  audio: formatPreview({ type: 'audio' }),
  location: formatPreview({ type: 'location' }),
  cinemaInvite: formatPreview({ type: 'cinema_invite' }),
  cinemaEnded: formatPreview({ type: 'text', subtype: 'SYNC_CINEMA_ENDED' }),
  partnerInvite: formatPreview({ type: 'text', subtype: 'SYNC_PARTNER_INVITE' }),
  partnerAccepted: formatPreview({ type: 'text', subtype: 'SYNC_PARTNER_ACCEPTED' }),
  partnerRejected: formatPreview({ type: 'text', subtype: 'SYNC_PARTNER_REJECTED' }),
  partnerUnbound: formatPreview({ type: 'text', subtype: 'SYNC_PARTNER_UNBOUND' }),
  system: formatPreview({ type: 'text', subtype: 'SYNC_SYSTEM', text: '系统提示' }),
  plainText: formatPreview({ type: 'text', text: '你好' }),
  emptyText: formatPreview({ type: 'text', text: '' }),
};
process.stdout.write(JSON.stringify(cases));
`);
    assert.equal(out.nullMsg, '点击进入会话...');
    assert.equal(out.image, '[图片]');
    assert.equal(out.video, '[视频]');
    assert.equal(out.audio, '[语音]');
    assert.equal(out.location, '[位置]');
    assert.equal(out.cinemaInvite, '[邀请同步观影]');
    assert.equal(out.cinemaEnded, '[本次同步放映已结束]');
    assert.equal(out.partnerInvite, '[健康搭子邀请]');
    assert.equal(out.partnerAccepted, '你们已成为健康搭子！');
    assert.equal(out.partnerRejected, '已拒绝健康搭子邀请');
    assert.equal(out.partnerUnbound, '已解除健康守护伴侣关系');
    assert.equal(out.system, '系统提示');
    assert.equal(out.plainText, '你好');
    assert.equal(out.emptyText, '暂无新消息', '空文本回退到默认文案');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P04-CHAT-03：cleanStoragePath 契约
// ---------------------------------------------------------------------------
test('P04-CHAT-03 cleanStoragePath 归一化媒体存储路径', () => {
  const dir = buildSandbox();
  try {
    const out = runInSandbox(dir, `
const { cleanStoragePath } = await import('./src/hooks/chat/_cleanPath.js');
const cases = {
  fullUrl: cleanStoragePath('https://proj.supabase.co/storage/v1/object/public/chat_media/user/a.jpg'),
  fullUrlQuery: cleanStoragePath('https://proj.supabase.co/storage/v1/object/sign/chat_media/user/a.jpg?token=xyz#frag'),
  bucketPrefixed: cleanStoragePath('chat_media/user/b.mp4'),
  plainRelative: cleanStoragePath('user/c.m4a'),
  localFile: cleanStoragePath('file:///var/mobile/a.jpg'),
  contentUri: cleanStoragePath('content://media/external/a.jpg'),
  phUri: cleanStoragePath('ph://ABC-123'),
  dataUri: cleanStoragePath('data:image/png;base64,AAAA'),
  empty: cleanStoragePath(''),
  nullVal: cleanStoragePath(null),
  nonString: cleanStoragePath(123),
  whitespace: cleanStoragePath('   '),
};
process.stdout.write(JSON.stringify(cases));
`);
    assert.equal(out.fullUrl, 'user/a.jpg', '完整 URL 必须截取 /chat_media/ 之后的相对路径');
    assert.equal(out.fullUrlQuery, 'user/a.jpg', '完整 URL 必须剥离 query / hash');
    assert.equal(out.bucketPrefixed, 'user/b.mp4', '带桶名前缀必须剥离 chat_media/');
    assert.equal(out.plainRelative, 'user/c.m4a', '纯相对路径原样返回');
    assert.equal(out.localFile, '', '本地 file:// URI 必须返回空串（非桶内对象）');
    assert.equal(out.contentUri, '', 'content:// URI 必须返回空串');
    assert.equal(out.phUri, '', 'ph:// URI 必须返回空串');
    assert.equal(out.dataUri, '', 'data: URI 必须返回空串');
    assert.equal(out.empty, '', '空串返回空串');
    assert.equal(out.nullVal, '', 'null 返回空串');
    assert.equal(out.nonString, '', '非字符串返回空串');
    assert.equal(out.whitespace, '', '纯空白返回空串');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// --- END OF FILE tests/security/p04_chatContract.test.mjs ---
