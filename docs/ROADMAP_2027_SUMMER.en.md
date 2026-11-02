# 2027 Summer Execution Manual (Sync App)

[中文版](ROADMAP_2027_SUMMER.md) · English (this page)

> **Purpose**: when work resumes in summer 2027, read only this file. No need to re-read the 5,457 lines in `docs/specs/`, and no need to re-read the HTML roadmap on the desktop.
> **Generated**: 2026-11-02
> **Applies to**: `1a3aca4` (the 2026-11-01 pause point)
> **Total effort**: 39–57 days (assuming 8 productive hours per day). Summer is roughly 70 days, leaving 13–31 days of buffer.

---

## 0. Read this before starting (5 minutes)

### 0.1 Run these three commands first to confirm the project isn't broken

```bash
git log --oneline -3          # 1a3aca4 should be at the top
git status                    # should be clean
npx tsc --noEmit              # must be 0 errors
```

If `tsc` reports errors, fix them before starting. **Never build on a broken foundation.**

### 0.2 Three iron rules (violating any one means rolling back that day)

```text
1. Never change any color value in src/constants/colors.js
2. Never change SIZES / TYPOGRAPHY in src/constants/theme.js
3. Never change the public API of src/context/ThemeContext.js
```

Source: [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:45) §0.2

### 0.3 Install dependencies with this one command only

```bash
npx expo install <package>
```

**Do not use** `npm install` / `yarn add` / `pnpm add` / `bun add`. Reason: only `expo install` resolves SDK 58-compatible versions.

### 0.4 Run these at the end of every phase

```bash
npx expo lint                 # target 0 errors (current baseline is 136; may only go down)
npx tsc --noEmit              # must be 0 errors
git diff src/constants/       # must be empty
```

---

## 1. Overview: six phases, in order

| Phase | Content | Effort | Risk | Cuttable |
|---|---|---|---|---|
| **0** | TS type contracts (`types/` directory, purely additive) | 3 days | Very low | No |
| **A** | specs phases 1–5 (foundation / home / space / chat / cinema + browser) | 15–20 days | Medium | No |
| **B** | tsconfig strict + typing existing code | 3–5 days | Medium | No |
| **C** | TanStack Query + MMKV replacement | 8–12 days | **High** | Can cut to 5 pages |
| **D** | 42 pages `.js` → `.tsx` | 10–15 days | Medium | No |
| **E** | FCM replacing Expo Push | 3–5 days | Medium-high | **Cuttable** |
| **Total** | | **39–57 days** | | |

### 1.1 Why this order (do not change it)

```
Phase 0 (types/ is purely additive — zero-risk warm-up)
    ↓
Phase A (specs changes "where files live": split pages, build the component library)
    ↓  ← file structure is stable only after this point
Phase B (tsconfig strict, add types to existing code)
    ↓
Phase C (data layer rewrite: TanStack Query + MMKV)
    ↓
Phase D (pages .js → .tsx)
    ↓
Phase E (FCM, needs a real device)
```

**Core logic: decide where files live first, then decide what goes inside them.**

- Phase A splits [`src/app/(tabs)/chat.js`](../src/app/%28tabs%29/chat.js:1) into `/chat/index` + `/chat/contacts` + `/chat/search`
- Phase A also splits the cinema and browser pages
- **If you do the TS migration first, all of those splits force you to redo the migration**

### 1.2 Explicitly cut (do not do these)

| Cut item | Reason |
|---|---|
| RevenueCat subscriptions | Needs a real store listing + App Store product config; revisit in 2028 |
| Signed APK | Needs an Android signing key, and a 17-year-old cannot register a Google Play account |
| Firebase Crashlytics | Use Sentry's free tier instead — simpler |
| Firebase Analytics | User count is too small for the data to mean anything |

---

## 2. Phase 0: TS type contracts (3 days)

### 2.1 Goal

Create a `types/` directory at the project root. Write interface definitions only — **do not wire it into any existing code**.

### 2.2 Files to create

| File | Content |
|---|---|
| `types/user.ts` | User entity, `Sync ID`, partner pairing state enum (`Unpaired` / `Pending` / `Paired`) |
| `types/health.ts` | Water records (ml / goal / timestamp), meal check-ins (slow carbs / protein / done flag) |
| `types/social.ts` | Moments posts (author / image URL array / like list / comment tree) |
| `types/media.ts` | Media sniff results, SharePlay room state, control signals (`Play` / `Pause` / `Seek` / `Ping`) |
| `types/index.ts` | Barrel export |

### 2.3 Reference sources

Write the types against these real files — do not invent them:

- User / pairing: [`src/hooks/useAuth.js`](../src/hooks/useAuth.js:1), [`src/app/bind_partner.js`](../src/app/bind_partner.js:1)
- Health data: [`src/hooks/health/useHealthStorage.js`](../src/hooks/health/useHealthStorage.js:22) (the `KEYS` constant), [`src/hooks/useHealthData.js`](../src/hooks/useHealthData.js:1)
- Social: [`src/app/chat/moments.js`](../src/app/chat/moments.js:1)
- Media / sync: [`src/hooks/useCinema.js`](../src/hooks/useCinema.js:1), [`src/hooks/useSyncRoom.js`](../src/hooks/useSyncRoom.js:1)
- Database columns: [`docs/DB_SCHEMA_REFERENCE.md`](DB_SCHEMA_REFERENCE.md:1)

### 2.4 Acceptance

```bash
npx tsc --noEmit    # must be 0 errors (types/ is purely additive and does not affect existing code)
```

- [ ] All 5 files created
- [ ] Every interface has a comment saying which table / hook it maps to
- [ ] `tsc --noEmit` passes

---

## 3. Phase A: specs phases 1–5 (15–20 days)

### 3.1 What to read

**Read only these two files — do not read the whole master spec:**

| Phase | Section to read |
|---|---|
| Phase 1 foundation | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:64) §11 |
| Phase 2 home | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:1) §12 |
| Phase 3 space + settings | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:1) §13 |
| Phase 4 chat | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md:19) §14 |
| Phase 5 cinema + browser | [`SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md:1) §15 |

**Visual / motion rules** (check against these in every phase): [`SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:1) §3, §4

### 3.2 Key outputs of phase 1 (everything later depends on them)

| File | Purpose |
|---|---|
| `src/constants/motion.js` | Shared motion parameters (`DURATION` / `SPRING` / `EASING` / `SCALE`) |
| `src/constants/haptics.js` | Already exists; needs tiered levels added |
| `src/components/ui/` | 8 components already exist; fill in the gaps per spec |

**The only new dependency:**

```bash
npx expo install @shopify/flash-list
```

### 3.3 The fixed workflow for every phase

```text
1. Read that phase's spec section
2. Work through the change list file by file
3. After each file → save → check visually via hot reload
4. When the whole phase is done → run the three acceptance commands
5. Walk every page on real devices (iOS + Android): light / dark / motion / haptics
6. Tick off that phase's acceptance checklist item by item
7. All green → move to the next phase
```

### 3.4 Acceptance

- [ ] Phase 1: `@shopify/flash-list` installed, `expo-doctor` reports no errors
- [ ] Phase 2: home partner card / water / 2×2 meals / check-in all working
- [ ] Phase 3: space page 4 cards + settings split into L3 pages + profile page tweaks done
- [ ] Phase 4: chat page is pure IM; contacts / add-friend search are standalone pages
- [ ] Phase 5: cinema split + search lobby + browser split done
- [ ] Every phase ends with `tsc --noEmit` passing and `git diff src/constants/` empty

---

## 4. Phase B: tsconfig strict + typing existing code (3–5 days)

### 4.1 Goal

Turn [`tsconfig.json`](../tsconfig.json:1) from an empty config into strict mode, then fix every error.

### 4.2 Current state

```json
{
  "compilerOptions": {},
  "extends": "expo/tsconfig.base",
  "exclude": ["supabase/functions"]
}
```

### 4.3 Options to enable (in order, one at a time)

```text
1. "strict": true                    ← most painful, most errors
2. "noUncheckedIndexedAccess": true  ← array access must be null-checked
3. "noImplicitOverride": true
4. "exactOptionalPropertyTypes": true ← optional props cannot receive undefined
```

**Do not enable them all at once.** Enable one → fix → run `tsc` → enable the next.

### 4.4 If `strict: true` produces more than 200 errors

**Fallback**: enable only these for now and defer full `strict` until after phase D:

```json
{
  "compilerOptions": {
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noImplicitAny": false
  }
}
```

### 4.5 Acceptance

- [ ] `tsconfig.json` has at least `strictNullChecks` enabled
- [ ] `npx tsc --noEmit` passes
- [ ] `npx expo lint` error count ≤ 136 (current baseline)

---

## 5. Phase C: TanStack Query + MMKV replacement (8–12 days, high risk)

### 5.1 This is the only link in the chain that might not finish

**Why**: all 42 pages currently use hand-written `useEffect` + `useState` + `supabase.from(...)`. Switching to TanStack Query means:

- Every page's data fetching becomes `useQuery`
- Every write operation becomes `useMutation`
- Cache invalidation logic has to be redesigned (`queryClient.invalidateQueries`)
- Optimistic updates have to be rewritten (the current `patchMessage` approach)

**42 pages × ~2 queries each = 84 queries to convert.**

### 5.2 Fallback plan (important)

**If fewer than 10 pages are converted by day 5, immediately downgrade to "only the 5 core pages":**

| Page | File |
|---|---|
| Home | [`src/app/(tabs)/index.js`](../src/app/%28tabs%29/index.js:1) |
| Chat list | [`src/app/(tabs)/chat.js`](../src/app/%28tabs%29/chat.js:1) |
| Chat room | [`src/components/ChatRoomInner.js`](../src/components/ChatRoomInner.js:84) |
| Cinema | [`src/app/cinema.js`](../src/app/cinema.js:34) |
| Browser | [`src/app/browser/index.js`](../src/app/browser/index.js:35) |

**TanStack Query and hand-written `useEffect` can coexist** — you do not have to convert everything at once. Convert the rest in 2028.

### 5.3 MMKV replacement

**Confirm one thing first**: MMKV needs a native module and **cannot run in Expo Go**.

```bash
npx expo install react-native-mmkv
npx expo run:ios      # must use a development build, not Expo Go
```

If you don't want to deal with development builds, **MMKV can be skipped entirely** — `AsyncStorage` is more than enough for your user count, and switching gives no user-visible benefit.

### 5.4 Acceptance

- [ ] TanStack Query installed, `QueryClientProvider` mounted in [`src/app/_layout.js`](../src/app/_layout.js:63)
- [ ] At least 5 core pages use `useQuery` / `useMutation`
- [ ] Cache invalidation works correctly (list refreshes automatically after sending a message)
- [ ] `tsc --noEmit` passes

---

## 6. Phase D: 42 pages `.js` → `.tsx` (10–15 days)

### 6.1 Migration order (leaf to root)

```text
1. src/constants/        (9 files, no dependencies)
2. src/components/ui/    (8 files, depends only on constants)
3. src/hooks/            (27 files, depends on services + types)
4. src/services/         (3 files)
5. src/components/       (32 files, depends on hooks)
6. src/app/              (42 files, last)
```

**Why this order**: going leaf-to-root means each layer's types are inferred automatically once the layer below is typed — no hand-writing needed.

### 6.2 Migration steps per file

```text
1. git mv src/xxx.js src/xxx.tsx
2. Add a Props interface (components) or parameter types (hooks)
3. Run npx tsc --noEmit
4. Fix errors (do not use any to bypass unless it truly cannot be inferred)
5. Verify that page on a real device
6. git commit
```

### 6.3 Prohibitions

```text
❌ Do not use any to bypass errors (use unknown + type guards)
❌ Do not use @ts-ignore (use @ts-expect-error + a comment explaining why)
❌ Do not change 10 files before running tsc (change 1–2 at a time)
```

### 6.4 Acceptance

- [ ] No `.js` files under `src/` (except config files like `eslint.config.js`)
- [ ] `npx tsc --noEmit` passes
- [ ] `npx expo lint` error count ≤ 136
- [ ] Every page walked through on both platforms on real devices

---

## 7. Phase E: FCM replacing Expo Push (3–5 days, cuttable)

### 7.1 Decide whether to do it at all

**The project currently uses Expo Push** ([`src/hooks/usePushNotifications.js`](../src/hooks/usePushNotifications.js:133), `getExpoPushTokenAsync`).

Expo Push's limitation: **when the app is killed by the OS, notifications may be delayed or dropped.**

**If you only have a few dozen users, this limitation doesn't matter.** Skip phase E entirely.

### 7.2 If you do it

```bash
npx expo install @react-native-firebase/app @react-native-firebase/messaging
npx expo run:ios      # must use a development build
```

Files to change:

| File | Change |
|---|---|
| [`src/hooks/usePushNotifications.js`](../src/hooks/usePushNotifications.js:1) | `getExpoPushTokenAsync` → `messaging().getToken()` |
| [`supabase/functions/send-push/index.ts`](../supabase/functions/send-push/index.ts:95) | Expo Push API → FCM HTTP v1 API |
| `app.json` | Add `google-services.json` / `GoogleService-Info.plist` config |

### 7.3 Acceptance

- [ ] Real device receives pushes (foreground / background / killed — all three states)
- [ ] Edge Function logs show no errors

---

## 8. Daily routine (fixed workflow)

### 8.1 Morning (10 minutes)

```bash
git status                    # confirm clean
git pull                      # if there is a remote
npx tsc --noEmit              # confirm the baseline is green
```

Open this file, find "which phase am I on today", and read that spec section.

### 8.2 Daytime (8 hours)

```text
1. Change only 1–2 files at a time
2. Run tsc --noEmit immediately after each change
3. Fix errors immediately — do not accumulate them
4. git commit after each small feature
```

### 8.3 Evening (10 minutes)

```bash
npx tsc --noEmit
npx expo lint
git add -A && git commit -m "Phase X: what I did today"
```

**Commit every day.** Do not save it up for the weekend — if something breaks, the rollback cost gets much higher.

### 8.4 Commit message format

```text
PhaseA-1: add motion.js with shared motion parameters
PhaseB: enable strictNullChecks and fix 23 errors
PhaseC: switch home page to useQuery
PhaseD: migrate 9 files in src/constants/ to TS
```

---

## 9. When you get stuck (try in order)

### 9.1 Technical problems

```text
1. Read the last line of the error message first (not the first line)
2. Search the Expo docs: https://docs.expo.dev/versions/v58.0.0/
3. Search GitHub Issues (include the SDK version)
4. When asking AI, give it "the full error + the relevant file contents + what you already tried"
```

### 9.2 Stuck for more than 2 hours

**Skip it immediately and move to the next item.** Do not burn a whole day on one problem.

Write one line in `docs/DEV_LOG.md`:

```markdown
## 2027-07-XX
- Stuck on XXX, error YYY, tried ZZZ, unresolved. Skipping, will look again tomorrow.
```

### 9.3 Three consecutive days under 4 productive hours

**Stop and take a day off.** That is not laziness — it prevents the next 10 days from being wasted.

---

## 10. Progress tracker (tick daily)

| Phase | Planned days | Actual start | Actual end | Status |
|---|---|---|---|---|
| 0. TS type contracts | 3 | | | [ ] |
| A-1. Foundation | 3 | | | [ ] |
| A-2. Home | 4 | | | [ ] |
| A-3. Space + settings | 4 | | | [ ] |
| A-4. Chat | 4 | | | [ ] |
| A-5. Cinema + browser | 5 | | | [ ] |
| B. tsconfig strict | 4 | | | [ ] |
| C. TanStack Query + MMKV | 10 | | | [ ] |
| D. Page TS migration | 12 | | | [ ] |
| E. FCM (cuttable) | 4 | | | [ ] |

**Planned total: 53 days. Summer is 70 days, leaving 17 days of buffer.**

---

## 11. End-of-summer acceptance criteria

You have met the summer goal only when all of these are true:

- [ ] No `.js` files under `src/` (config files excepted)
- [ ] `npx tsc --noEmit` passes with `strictNullChecks` enabled
- [ ] `npx expo lint` error count ≤ 136
- [ ] specs phases 1–5 fully done, both platforms walked through on real devices
- [ ] At least 5 core pages use TanStack Query
- [ ] All 5 files in `types/` complete
- [ ] All changes committed + pushed

**Anything unfinished goes into `docs/DEV_LOG.md` and continues in 2028.**

---

## 12. What to do in 2028 (out of scope for this file)

- Integrate RevenueCat subscriptions
- Signed APK / publish to App Store + Google Play (requires being 18+)
- Convert the remaining 37 pages to TanStack Query
- Add tests (three core paths: sending a chat message / login / synchronized playback)
- Integrate Sentry error reporting
- Rename package `com.sync.app` → `com.abcdabcd9.sync`

---

## Appendix A: Key file index

| Purpose | File |
|---|---|
| Global constraints / visual rules / motion spec | [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC.md:1) |
| Phases 1–3 details | [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART2.md:1) |
| Phases 4–7 details | [`docs/specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md`](specs/SYNC_APP_REFACTOR_EXECUTION_SPEC_PART3.md:1) |
| Database column reference | [`docs/DB_SCHEMA_REFERENCE.md`](DB_SCHEMA_REFERENCE.md:1) |
| Historical pitfall log | [`docs/DEV_LOG.md`](DEV_LOG.md:1) |
| Architecture diagrams | [`docs/specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md`](specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md:1) |

## Appendix B: Known pitfalls (hit before 2026-11-01)

Source: [`docs/DEV_LOG.md`](DEV_LOG.md:1)

| Pitfall | Root cause | Fixed |
|---|---|---|
| Voice message won't play / disappears after re-entering | Wrong upload body type (not permissions, not RLS) | Yes |
| Android location is slow | Location strategy issue | Yes |
| Android fullscreen preview is blank | Rendering layer issue | Yes |
| Voice-to-text `Unsupported FormDataPart` | How FormData was constructed | Yes |
| Landscape photos get cropped | Image dimension calculation | Yes |
| Location card doesn't appear immediately / flickers on re-locate | State update timing | Yes |

**Do not step on these again.** If you see similar symptoms, check [`docs/DEV_LOG.md`](DEV_LOG.md:1) first.

## Appendix C: Current tech debt (2026-11-01 snapshot)

| Item | Status | Planned handling |
|---|---|---|
| 136 lint issues (112 errors / 24 warnings) | Unfixed | Fix along the way in phase D |
| 0 test files | Not done | 2028 |
| No error reporting | Not done | 2028 (Sentry) |
| Package name `com.sync.app` | Unchanged | Before publishing in 2028 |
| 6 categories of placeholder features | Not filled in | specs phases 2–6 |
| `EXPO_PUBLIC_GROQ_API_KEY` on the client | Unchanged | 2028 (move behind an Edge Function) |
