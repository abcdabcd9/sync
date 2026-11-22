// --- START OF FILE tests/security/p10_r1_cinemaRoomId.test.mjs ---
// ============================================================================
// TASK-P1.0 / R1 — CLIENT-03 放映厅房间号跨账号复用修复测试
//
// 背景（GPT 最终执行前审查 CLIENT-03）：
//   src/app/cinema.js 旧实现用模块级 `lastCinemaRoomId`（仅存 roomId，不绑定账号），
//   初始化 `cinemaRoomId || lastCinemaRoomId || Crypto.randomUUID()`。
//   切号后 B 会复用 A 的历史房间号 → 进入 A 的放映厅（presence / 广播串号）。
//
// 修复：
//   模块级改为 `lastCinemaRoom = { ownerKey, roomId }`，并抽出纯函数
//   `resolveCinemaRoomId({ cinemaRoomId, lastRoom, currentOwnerKey, newUuid })`：
//     · 仅当 lastRoom.ownerKey === currentOwnerKey 时复用（同账号最小化/重挂载）；
//     · 真实身份切换（A→B / A→B→A / 同账号重新登录 authEpoch 变化）→ 生成新 UUID。
//
// 本测试直接 import 真实源码中的 resolveCinemaRoomId（经 Babel 转译 JSX），
// 断言针对真实函数行为，而非静态字符串匹配。
//
// 覆盖：
//   C1  首次进入（无历史、无上下文）→ 生成新 UUID
//   C2  同账号最小化后重挂载（ownerKey 相同）→ 复用同一房间号
//   C3  A→B 切号（ownerKey 不同）→ 不复用 A 的房间号，生成新 UUID
//   C4  A→B→A 切回（ownerKey 与 A 相同）→ 复用 A 的房间号（记录仍为 A）
//   C5  同账号重新登录（authEpoch 变化 → ownerKey 不同）→ 不复用，生成新 UUID
//   C6  邀请链接/上下文已带 roomId → 直接使用，不覆盖
//
// 说明：
//   - 不联网、不使用真实 .env / Token / 用户数据。
//   - 退出码：0 全部通过；1 存在失败。
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 沙箱：把真实 cinema.js 经 Babel 转译（JSX → createElement）后放入临时目录，
//       仅 import 其中的 resolveCinemaRoomId 纯函数。
//       cinema.js 顶部有大量 import（expo-* / react-native 等），Node 无法解析；
//       因此为这些模块建立最小 stub，保证 import 链可加载。
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-r1-cinemaroom-'));
  const nm = path.join(dir, 'node_modules');
  const mk = (pkg, files) => {
    const d = path.join(nm, pkg);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  };

  // react：cinema.js 只用到 hooks 与 memo，这里给出最小实现（本测试不驱动组件渲染）。
  mk('react', {
    'package.json': JSON.stringify({ name: 'react', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];
export const useEffect = () => {};
export const useRef = (v) => ({ current: v });
export const useCallback = (fn) => fn;
export const useMemo = (fn) => fn();
export const memo = (c) => c;
export default { useState, useEffect, useRef, useCallback, useMemo, memo };
`,
  });

  mk('react-native', {
    'package.json': JSON.stringify({ name: 'react-native', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `
export const View = () => null; export const Text = () => null; export const StyleSheet = { create: (o) => o };
export const TouchableOpacity = () => null; export const Platform = { OS: 'ios', select: (o) => o.ios };
export const useWindowDimensions = () => ({ width: 400, height: 800 });
export const PanResponder = { create: () => ({ panHandlers: {} }) };
export const Animated = { Value: class { constructor(v){ this.v=v; } interpolate(){ return this; } }, timing: () => ({ start(){} }), spring: () => ({ start(){} }), parallel: () => ({ start(){} }), View: () => null };
export const TextInput = () => null; export const KeyboardAvoidingView = () => null; export const Keyboard = { dismiss(){} };
export const TouchableWithoutFeedback = () => null; export const Dimensions = { get: () => ({ width: 400, height: 800 }) };
export const StatusBar = { setHidden(){} }; export const BackHandler = { addEventListener: () => ({ remove(){} }) };
export const ActivityIndicator = () => null;
export default {};
`,
  });

  mk('react-native-safe-area-context', {
    'package.json': JSON.stringify({ name: 'react-native-safe-area-context', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const SafeAreaView = () => null; export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 }); export default {};`,
  });

  mk('@expo/vector-icons', {
    'package.json': JSON.stringify({ name: '@expo/vector-icons', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const Ionicons = () => null; export default { Ionicons };`,
  });

  mk('expo-haptics', {
    'package.json': JSON.stringify({ name: 'expo-haptics', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const impactAsync = async () => {}; export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' }; export default {};`,
  });

  mk('expo-crypto', {
    'package.json': JSON.stringify({ name: 'expo-crypto', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `let n = 0; export const randomUUID = () => 'uuid-' + (++n); export default { randomUUID };`,
  });

  mk('expo-blur', {
    'package.json': JSON.stringify({ name: 'expo-blur', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const BlurView = () => null; export default { BlurView };`,
  });

  mk('expo-router', {
    'package.json': JSON.stringify({ name: 'expo-router', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const useRouter = () => ({ push(){}, back(){}, replace(){} }); export const useLocalSearchParams = () => ({}); export const useNavigation = () => ({ addListener: () => ({ remove(){} }) }); export default {};`,
  });

  mk('expo-video', {
    'package.json': JSON.stringify({ name: 'expo-video', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const VideoView = () => null; export const useVideoPlayer = () => ({}); export default {};`,
  });

  mk('expo', {
    'package.json': JSON.stringify({ name: 'expo', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const useEvent = () => undefined; export const useEventListener = () => {}; export default {};`,
  });

  mk('expo-brightness', {
    'package.json': JSON.stringify({ name: 'expo-brightness', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const requestPermissionsAsync = async () => ({}); export default {};`,
  });

  mk('expo-screen-orientation', {
    'package.json': JSON.stringify({ name: 'expo-screen-orientation', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const lockAsync = async () => {}; export const OrientationLock = { LANDSCAPE: 'landscape', PORTRAIT_UP: 'portrait' }; export default {};`,
  });

  mk('expo-keep-awake', {
    'package.json': JSON.stringify({ name: 'expo-keep-awake', version: '0.0.0', type: 'module', main: 'index.js' }),
    'index.js': `export const activateKeepAwakeAsync = async () => {}; export const deactivateKeepAwake = () => {}; export default {};`,
  });

  // 沙箱根 package.json：声明 ESM，使 .js 文件按模块解析。
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

  // 仓库内相对依赖（cinema.js 会 import 这些），用最小 stub 覆盖。
  // ⚠️ cinema.js 使用无扩展名 import（如 '../context/ThemeContext'），
  //    Node ESM 不会自动补 .js，因此 stub 必须写在「无扩展名」的精确路径上。
  const relStub = (rel, code) => {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, code);
  };
  relStub('src/context/ThemeContext', `export const useAppTheme = () => ({ isDark: false, colors: {} }); export default {};`);
  relStub('src/hooks/useCinema', `export const useCinema = () => ({}); export default {};`);
  relStub('src/hooks/useAuth', `export const useAuth = () => ({ user: null }); export default {};`);
  relStub('src/hooks/useOwnerKey', `export const useOwnerKey = () => ({ ownerKey: 'anon::0' }); export default {};`);
  relStub('src/components/cinema/EpisodeDrawer', `export default () => null;`);
  relStub('src/components/cinema/HiddenSnifferWebView', `export default () => null;`);

  // 真实 cinema.js：Babel 转译 JSX
  const babel = require('@babel/core');
  const jsxPlugin = require.resolve('@babel/plugin-transform-react-jsx');
  const src = path.join(repoRoot, 'src/app/cinema.js');
  let code = fs.readFileSync(src, 'utf8');
  const res = babel.transformSync(code, {
    filename: 'src/app/cinema.js',
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    plugins: [jsxPlugin],
  });
  code = res.code;
  const dst = path.join(dir, 'src/app/cinema.js');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, code);

  return { dir, entry: path.join(dir, 'src/app/cinema.js') };
}

// ---------------------------------------------------------------------------
// 加载真实 resolveCinemaRoomId
// ---------------------------------------------------------------------------
const sandbox = buildSandbox();
const mod = await import('file://' + sandbox.entry);
const { resolveCinemaRoomId, resolveOwnedCinemaRoomBinding } = mod;

test.after(() => {
  try { fs.rmSync(sandbox.dir, { recursive: true, force: true }); } catch (_) {}
});

// 生成器：每次调用返回不同 UUID（模拟 Crypto.randomUUID）
function uuidGen() {
  let n = 0;
  return () => `new-uuid-${++n}`;
}

// ---------------------------------------------------------------------------
// C1：首次进入（无历史、无上下文）→ 生成新 UUID
// ---------------------------------------------------------------------------
test('C1 首次进入生成新房间号', () => {
  const gen = uuidGen();
  const room = resolveCinemaRoomId({
    cinemaRoomId: null,
    lastRoom: { ownerKey: null, roomId: null },
    currentOwnerKey: 'A::1',
    newUuid: gen,
  });
  assert.equal(room, 'new-uuid-1');
});

// ---------------------------------------------------------------------------
// C2：同账号最小化后重挂载（ownerKey 相同）→ 复用同一房间号
// ---------------------------------------------------------------------------
test('C2 同账号重挂载复用房间号', () => {
  const gen = uuidGen();
  const room = resolveCinemaRoomId({
    cinemaRoomId: null,
    lastRoom: { ownerKey: 'A::1', roomId: 'room-A' },
    currentOwnerKey: 'A::1',
    newUuid: gen,
  });
  assert.equal(room, 'room-A');
});

// ---------------------------------------------------------------------------
// C3：A→B 切号（ownerKey 不同）→ 不复用 A 的房间号，生成新 UUID
// ---------------------------------------------------------------------------
test('C3 A→B 切号不复用 A 的房间号', () => {
  const gen = uuidGen();
  const room = resolveCinemaRoomId({
    cinemaRoomId: null,
    lastRoom: { ownerKey: 'A::1', roomId: 'room-A' },
    currentOwnerKey: 'B::1',
    newUuid: gen,
  });
  assert.equal(room, 'new-uuid-1');
  assert.notEqual(room, 'room-A');
});

// ---------------------------------------------------------------------------
// C4：A→B→A 切回（ownerKey 与 A 相同）→ 复用 A 的房间号（记录仍为 A）
// ---------------------------------------------------------------------------
test('C4 A→B→A 切回复用 A 的房间号', () => {
  const gen = uuidGen();
  // 切回 A 时，模块级记录仍是 A 的（B 期间未覆盖，或已被 B 覆盖则此处模拟记录为 A）
  const room = resolveCinemaRoomId({
    cinemaRoomId: null,
    lastRoom: { ownerKey: 'A::1', roomId: 'room-A' },
    currentOwnerKey: 'A::1',
    newUuid: gen,
  });
  assert.equal(room, 'room-A');
});

// ---------------------------------------------------------------------------
// C5：同账号重新登录（authEpoch 变化 → ownerKey 不同）→ 不复用，生成新 UUID
// ---------------------------------------------------------------------------
test('C5 同账号重新登录（authEpoch 变化）不复用', () => {
  const gen = uuidGen();
  const room = resolveCinemaRoomId({
    cinemaRoomId: null,
    lastRoom: { ownerKey: 'A::1', roomId: 'room-A' },
    currentOwnerKey: 'A::2', // 同 ownerId，authEpoch 变化
    newUuid: gen,
  });
  assert.equal(room, 'new-uuid-1');
  assert.notEqual(room, 'room-A');
});

// ---------------------------------------------------------------------------
// C6：邀请链接/上下文已带 roomId → 直接使用，不覆盖
// ---------------------------------------------------------------------------
test('C6 上下文已带 roomId 时直接使用', () => {
  const gen = uuidGen();
  const room = resolveCinemaRoomId({
    cinemaRoomId: 'invite-room-X',
    lastRoom: { ownerKey: 'A::1', roomId: 'room-A' },
    currentOwnerKey: 'B::1',
    newUuid: gen,
  });
  assert.equal(room, 'invite-room-X');
});

// ---------------------------------------------------------------------------
// C7：源码契约 —— cinema.js 必须使用 owner 绑定的 lastCinemaRoom（不得回退到裸 lastCinemaRoomId）
// ---------------------------------------------------------------------------
test('C7 cinema.js 使用 owner 绑定的房间号记录', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/app/cinema.js'), 'utf8');
  assert.match(src, /lastCinemaRoom\s*=\s*\{\s*ownerKey/, '应存在 owner 绑定的 lastCinemaRoom 赋值');
  assert.match(src, /resolveCinemaRoomId/, '应使用 resolveCinemaRoomId 纯函数');
  assert.doesNotMatch(src, /\blastCinemaRoomId\b/, '不得残留裸 lastCinemaRoomId 变量');
});

// CLIENT-03：这些用例覆盖 CinemaScreen 真实 owner 轮换 effect 使用的纯函数，
// 不替代 React Native 真机/完整组件生命周期回归。
test('C8 页面保持挂载时 A→B 必须换房间且绑定 B', () => {
  const gen = uuidGen();
  const original = { ownerKey: 'A::1', roomId: 'room-A' };
  const next = resolveOwnedCinemaRoomBinding({
    roomBinding: original, currentOwnerKey: 'B::2', newUuid: gen,
  });
  assert.deepEqual(next, { ownerKey: 'B::2', roomId: 'new-uuid-1' });
  assert.equal(original.roomId, 'room-A');
});

test('C9 同账号保持挂载时不应重建房间', () => {
  const original = { ownerKey: 'A::1', roomId: 'room-A' };
  const next = resolveOwnedCinemaRoomBinding({
    roomBinding: original, currentOwnerKey: 'A::1',
    newUuid: () => { throw new Error('不应生成新 UUID'); },
  });
  assert.strictEqual(next, original);
});

test('C10 A→B→A（epoch 已变化）不得复用历史 A 房间', () => {
  const gen = uuidGen();
  const original = { ownerKey: 'B::2', roomId: 'room-B' };
  const next = resolveOwnedCinemaRoomBinding({
    roomBinding: original, currentOwnerKey: 'A::3', newUuid: gen,
  });
  assert.equal(next.roomId, 'new-uuid-1');
  assert.equal(next.ownerKey, 'A::3');
});
