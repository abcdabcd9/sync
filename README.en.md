# Sync

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](LICENSE)
[![Expo SDK](https://img.shields.io/badge/Expo%20SDK-58-000020.svg)](https://docs.expo.dev/versions/v58.0.0/)
[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey.svg)](#)
[![Author](https://img.shields.io/badge/author-abcdabcd9-blue.svg)](https://github.com/abcdabcd9)

A mobile app I built myself, packing health check-ins, chat, a movie room, and a browser into one shell.

Written with Expo + React Native, backed by Supabase.

[中文版](README.zh.md) · [English](README.en.md)

Built by [@abcdabcd9](https://github.com/abcdabcd9) · Contact: tangchengzhi641@gmail.com / tangchengzhi171@gmail.com

> **This project is source-only. No prebuilt installers are provided.**
>
> - There is no APK / IPA in this repository, and the app is not published to any app store.
> - You must provision your own backend (Supabase project, database, storage bucket, Edge Function). No shared server is provided.
> - Push notifications require your own Firebase project and certificates. No credentials are included.
>
> In short: this is code you can run yourself, not a download-and-go app.

---

## What it does

**Health check-ins**
Log water and meals, track consecutive-day streaks. You can bind a health partner and see each other's progress.

**Chat**
One-on-one private chat with text, images, video, and voice. Voice messages can be transcribed to text (via Groq Whisper). Message recall, favorites, pinning, hiding, clearing, and chat backgrounds all actually work.

**Space**

- Movie room: video playback, create a room to watch together in sync, with danmaku comments
- Browser: built-in WebView that blocks ads and sniffs videos from web pages to cast straight into the movie room

**Settings**
Account, appearance (dark/light), storage management, notification permission requests.

> Everything above **actually works**. Below is a separate list of "what doesn't work yet", so you don't step on landmines.

---

## Getting it running

You need Node 20+, a Supabase project, and Android Studio or Xcode.

```bash
git clone https://github.com/abcdabcd9/sync.git
cd sync
npm install
cp .env.example .env
```

Then edit `.env` and fill in your Supabase config:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_GROQ_API_KEY=your-groq-key   # optional; voice-to-text is unavailable without it
```

Run it:

```bash
npx expo run:android
npx expo run:ios
```

> It uses native modules like expo-notifications and expo-video, so Expo Go can't run it fully. You need a development build.

For the database, run the SQL files in `supabase/migrations/` in filename order inside the Supabase SQL Editor.

Push runs on **Firebase Cloud Messaging (FCM)**. Expo's push service forwards to FCM (Android) / APNs (iOS) under the hood, so there are two steps:

1. Drop the two Firebase config files into the project root (both are in `.gitignore`, so they never reach the repo):
   - `google-services.json` (Android)
   - `GoogleService-Info.plist` (iOS)
2. Deploy the push gateway Edge Function:

```bash
npx supabase functions deploy send-push
```

> Without those two files the app still runs, but it can't obtain a push token and notifications are skipped silently. For EAS cloud builds they're injected as EAS Secrets (see the comments in `.gitignore`).
>
> For local development, drop `google-services.json` and `GoogleService-Info.plist` into the project root (both are ignored by `.gitignore`). `app.json` no longer references these files, so their absence won't break config resolution.

There are 19 migration scripts, numbered `01_` through `19_`. **Execute them in numeric order**:

| No. | File | Purpose |
| --- | --- | --- |
| 01 | `01_消息表加subtype字段_add_message_subtype.sql` | Adds a `subtype` column to the messages table, splitting the `[SYNC_XXX]` prefix into its own column |
| 02 | `02_媒体改存相对路径并收紧RLS_media_path_and_rls.sql` | Stores media as relative object paths and tightens RLS by `user_id` namespace |
| 03 | `03_聊天媒体桶私有化_private_chat_media_bucket.sql` | Switches the `chat_media` bucket from public to private |
| 04 | `04_SyncID修改频率限制触发器_sync_id_limit_trigger.sql` | Sync ID can only change once every 365 days, enforced by a server-side trigger |
| 05 | `05_双向解绑伴侣RPC_unbind_partner_rpc.sql` | Atomically unbinds both sides on the server, avoiding one-sided leftovers |
| 06 | `06_核心表启用RLS基线_enable_all_rls.sql` | Enables RLS on core business tables and writes baseline policies |
| 07 | `07_补齐5张核心表_create_core_tables.sql` | Adds the 5 missing core tables + unique constraints + indexes + signup trigger + GRANT + Realtime |
| 08 | `08_删除7条全开RLS策略_core_rls_policies.sql` | Drops 7 dangerous `USING (true)` policies and closes friend-request privilege escalation |
| 09 | `09_补齐缺失RPC函数_missing_rpcs.sql` | Adds `delete_my_account` and `get_server_time` |
| 10 | `10_修复注册时sync_id为空_fix_handle_new_user_sync_id.sql` | Fixes `sync_id` being NULL at signup and backfills historical NULLs |
| 11 | `11_补齐7张表GRANT授权_grant_table_privileges.sql` | Adds table-level GRANTs for 7 tables, resolving `permission denied` |
| 12 | `12_开启Realtime实时刷新_enable_realtime_publication.sql` | Adds `messages` / `health_records` to the Realtime publication |
| 13 | `13_全部表加入Realtime_all_tables.sql` | Dynamically walks the `public` schema and adds every business table to the Realtime publication |
| 14 | `14_修复unbind_partner提权风险_harden_unbind_partner.sql` | Fixes the `SECURITY DEFINER` privilege-escalation risk in `unbind_partner` by pinning `search_path` and tightening execute grants |
| 15 | `15_收紧profiles敏感列读取_restrict_profiles_sensitive_columns.sql` | Restricts reads of sensitive `profiles` columns (`expo_push_token` / `public_key`) so they're no longer visible to every signed-in user |
| 16 | `16_Realtime白名单_restrict_realtime_publication.sql` | Narrows the Realtime publication from "add every table dynamically" to an explicit allowlist |
| 17 | `17_修复chat_media签名读取策略_fix_signed_url_select_policy.sql` | Fixes the storage read policy behind `createSignedUrl` returning `Object not found` |
| 18 | `18_会话删除与清空RPC_delete_conversation_rpc.sql` | Adds the `delete_conversation` RPC so "delete this chat / clear chat history" actually reaches the cloud |
| 19 | `19_会话软删除_仅删我方视角_soft_delete_conversation.sql` | Turns conversation deletion into a **one-sided soft delete**: `messages.deleted_by UUID[]` + GIN index, marking only your own side as deleted while the other party is unaffected |

> All scripts are idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP POLICY IF EXISTS`), so re-running them is safe.
>
> ⚠️ **Migrations 18 and 19 are replacements, not additions.** 18 implemented a physical two-sided `DELETE` (you delete it, the other party loses it too); 19 changes that to a one-sided soft delete. **A fresh database just runs 01 → 19.** On a database with existing data, running 19 overwrites the function body defined in 18 — no rollback needed.

Note: **`chat_media` is a Storage bucket, not a table.** The table-creation script can't create it. You need to manually create a bucket named `chat_media` in Dashboard → Storage (private is recommended; policies are in `03_聊天媒体桶私有化_private_chat_media_bucket.sql`).

Note: **For a database that already has live data, validate `08_删除7条全开RLS策略_core_rls_policies.sql` on a test database first.** It only drops policies and doesn't touch data, but RLS blocking is silent — dropping the wrong policy won't raise an error, it will just make the frontend receive empty arrays. After running it, walk through "send message / receive message / check in / add friend" to confirm.

---

## Tech stack

- Expo SDK 58 / React Native 0.88 / React 19
- Expo Router (file-based routing)
- Supabase (Auth, Postgres, Storage, Realtime, Edge Functions)
- AsyncStorage + expo-secure-store for local caching
- expo-video / expo-audio for playback
- expo-notifications + Firebase Cloud Messaging (FCM) for push, relayed through Expo Push Service

The code is JavaScript. `src/types/` holds the directory and notes reserved for a TypeScript migration, which hasn't started.

---

## Directory layout

```text
src/
├── app/          # Routes; each file is a screen
├── components/   # Components; ui/ holds the generic ones
├── hooks/        # Hooks grouped by module
├── services/     # Supabase, push, media cache
├── constants/    # Colors, theme, motion, feature flags
└── scripts/      # Scripts injected into the WebView (ad blocking, sniffing)
supabase/
├── functions/    # Edge Functions
└── migrations/   # Database migrations
```

The layering is roughly: routes → business components → UI atoms → hooks → services. Data always reads the local cache first, then requests the cloud, so a cloud outage won't leave you with a blank screen.

---

## What doesn't work yet (honest list)

The project is still early. The UI is built out, but some features are shells only. The categories below are ordered by "how broken", and every item has been verified in practice.

### 1. Pure placeholder pages (all you get is "coming soon")

| Page | File |
| --- | --- |
| Private space | `src/app/private/index.js` |
| Moments | `src/app/moments/index.js` |

The 4 cards on the Space page are hardcoded and don't read feature flags, so these two cards always show, and tapping them lands on a placeholder page.

### 2. Settings that "save but do nothing"

These toggles can be tapped, saved to AsyncStorage, and survive an app restart, but **no code reads them**, so nothing happens:

| Setting | Location |
| --- | --- |
| Earpiece mode | Settings → Chat |
| Message preview | Settings → Chat |
| Care mode | Settings → More |
| Interface language | Settings → More |
| Auto-download images / videos / files | Settings → Download |
| Allow others to add me as friend | Settings → Privacy |
| Allow finding me via Sync ID | Settings → Privacy |
| Moments visibility | Settings → Privacy |
| New message / partner / sound notifications | Settings → Notifications |

The reason is documented in the comments of `src/hooks/useAppSettings.js`: this hook only handles "storing", not "using"; wiring up behavior is a later phase. Also, auto-download in `useChatMessages.js` runs unconditionally and ignores the setting entirely.

### 3. Chat features that "do nothing when tapped"

| Feature | Reality |
| --- | --- |
| Video / voice call | Only shows an Alert telling you to use WeChat instead (`handleStartCall` in `ChatRoomInner.js`) |
| Blocklist | You can add someone, but sending and receiving messages never checks it — you can still chat after blocking |
| Starred friends | Only stores a flag; affects neither sorting nor any display |
| Do not disturb | Only changes the badge style in the conversation list; push notifications still ring |
| Per-friend permission settings | Pure local state, never written to the database, gone on exit |
| Location message | The screen still exists (`src/app/chat/location.js`), but the entry point in the chat input bar has been removed |

### 4. The movie room has no lobby

Room IDs are generated locally with `Crypto.randomUUID()`. There is no room list and no lobby — the only way to share a room is to send the room ID via "invite a friend to watch together".

### 5. Multi-account switching isn't real multi-session

"Switch account" actually signs out the current account and jumps to the login page with the email pre-filled. It does not keep multiple sessions alive at once.

### 6. Other

- Simplified Chinese only for now; no i18n
- The relation network (multiple partners, small circles) is a reserved design — the code has a feature flag constant but no implementation. The design doc is in [`docs/specs/`](docs/specs/)
- The project uses React 19, so `npx expo lint` reports 136 problems (112 errors / 24 warnings), almost all style suggestions from the new `react-hooks/*` rules. They don't affect runtime
- No end-to-end encryption (honestly disclosed in `src/constants/security.js`)
- Account deletion depends on the `delete_my_account` RPC, which is provided by `09_补齐缺失RPC函数_missing_rpcs.sql`, so the deletion flow works

---

## Contributing

Issues and pull requests are welcome. Two things to read before you touch anything:

- [`AGENTS.md`](AGENTS.md): hard rules around Expo versions (don't write Expo APIs from memory — check the docs for the matching version first), the command list, and routing conventions
- [`docs/README.en.md`](docs/README.en.md): the documentation index. Read [`docs/DB_SCHEMA_REFERENCE.en.md`](docs/DB_SCHEMA_REFERENCE.en.md) before changing the database

If you're looking for a place to start, every item in the "What doesn't work yet" section above is a known gap — pick any of them. Before submitting, run:

```bash
npx tsc --noEmit
npx expo lint
```

`npx expo lint` currently reports 136 problems (112 errors / 24 warnings). They're style suggestions from the new `react-hooks/*` rules under React 19 and are a known baseline — no need to fix them.

---

## What's actually built

This isn't a "got the demo running" project. Here's what's genuinely done:

**Database layer**

- **19 Supabase migration scripts**, replayable in order from table creation through RLS hardening
- **All 7 core tables have RLS enabled**: `profiles`, `messages`, `friends`, `friend_requests`, `health_records`, `moments`, `complaints` — not a single one is left open
- Policies aren't just "allow everything": only the receiver can approve a friend request (no self-approval), health record writes carry `WITH CHECK (auth.uid() = user_id)` (no forging), and moments are filtered by `visibility`
- **Every `SECURITY DEFINER` function pins `search_path`** and is restricted to `authenticated` only — this is the classic PostgreSQL privilege-escalation vector, and [`14_修复unbind_partner提权风险_harden_unbind_partner.sql`](supabase/migrations/14_修复unbind_partner提权风险_harden_unbind_partner.sql) exists specifically to fix it
- Chat media bucket is private: `chat_media` has public reads disabled, replaced by 4 fine-grained policies plus signed URLs

**Server side**

- **Edge Function push service** ([`supabase/functions/send-push/index.ts`](supabase/functions/send-push/index.ts)): verifies the caller → looks up the recipient's Expo Push Token → sends the push → prunes dead tokens
- All credentials go through `Deno.env.get()`; there are no hardcoded secrets anywhere in the repo
- Uses Expo Push Service rather than talking to FCM directly, so self-hosters don't need Firebase certificates

**Client**

- Expo Router file-based routing, 40+ screens under `src/app/`
- Hand-rolled UI component library (`src/components/ui/`), no third-party UI framework
- Built-in browser with ad blocking, media sniffing, and desktop UA spoofing (`src/scripts/browser/`)
- Synced watch party: playback position stays aligned across both devices, with a seek lock to prevent jitter

**Engineering**

- GitHub Actions CI: blocking `tsc --noEmit` plus non-blocking ESLint (the baseline is documented in the workflow comments)
- Three READMEs (Chinese / English / Simplified Chinese), bilingual `SECURITY.md` and `CONTRIBUTING.md`
- Every documentation link is script-verified — zero broken links

---

## Author

**abcdabcd9** — independent developer

- GitHub: [@abcdabcd9](https://github.com/abcdabcd9)
- Contact: tangchengzhi641@gmail.com / tangchengzhi171@gmail.com

I built this end to end on my own — database schema, the 19 migration scripts above, the Edge Function push service, and every UI component. If you find it useful, a star is the best way to say thanks.

---

## License

GNU AGPLv3 License — see [`LICENSE`](LICENSE).

This project is licensed under the GNU Affero General Public License v3.0. Anyone who runs this software (or a modified version) as a network service must offer the complete Corresponding Source to those users, as required by section 13 of the AGPLv3. Commercial use must comply with the AGPLv3 terms; for a closed-source commercial license that waives the copyleft obligations, contact the author.
