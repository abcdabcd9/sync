# docs — Documentation index

This directory holds all documentation for the Sync project. Code lives in [`../src/`](../src/), database migrations in [`../supabase/migrations/`](../supabase/migrations/).

[中文版](README.md) · English (this page)

## 1. Operations manuals (follow them step by step)

| Document | Purpose | When to read |
| --- | --- | --- |
| [`RESET_DATABASE.md`](RESET_DATABASE.md) · [中文](RESET_DATABASE.zh.md) · [EN](RESET_DATABASE.en.md) | 6-step manual for a full database reset: clear `auth.users` → clear the 7 business tables → clear Storage → verify everything is empty → confirm the schema is intact → clear the app's local cache | When you want to wipe all test data and start acceptance testing from scratch |
| [`DB_SCHEMA_REFERENCE.md`](DB_SCHEMA_REFERENCE.md) · [中文](DB_SCHEMA_REFERENCE.zh.md) · [EN](DB_SCHEMA_REFERENCE.en.md) | Snapshot of the real structure of the live Supabase project: column definitions for the 7 tables, a policy-by-policy RLS inventory, triggers, RPCs, and fix priorities | Before changing table structure, troubleshooting permission issues, or writing a new migration |

## 2. Development records

| Document | Purpose |
| --- | --- |
| [`DEV_LOG.md`](DEV_LOG.md) | Development log: what was done in each phase, what broke, and how it was fixed, in chronological order. Start here when asking "why is this change like this?" |
| [`TFG_DATA.md`](TFG_DATA.md) | Project data summary for the thesis / defense (scale, tech stack, effort statistics) |
| [`ROADMAP_2027_SUMMER.md`](ROADMAP_2027_SUMMER.md) · [中文](ROADMAP_2027_SUMMER.md) | 2027 summer execution manual: the order of the six phases, effort estimates, risk points, fallback plans, daily workflow, and acceptance criteria. **Read only this file when work resumes** |

## 3. Design documents (`specs/`)

`specs/` holds only **descriptions of the current code** and **architecture diagrams**:

| Document | Content |
| --- | --- |
| [`specs/CODEBASE_MAP.md`](specs/CODEBASE_MAP.md) · [中文](specs/CODEBASE_MAP.md) | **Architecture of the current code**: tech stack, five-layer split, full route tree, business modules, data model, data layer, realtime sync, chat subsystem. Describes what exists, not what's planned |
| [`specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md`](specs/SYNC_APP_ARCHITECTURE_DIAGRAMS.md) | Architecture diagrams: module layering, data flow, screen relationships |

> Internal planning documents (refactor execution plan, relation-network interface reservation, etc.) are not published with this repository and are kept locally by the maintainer.

## 4. About the PDFs

The `.pdf` files under `docs/` and `docs/specs/` are rendered exports of the Markdown above and are **not tracked by git** (see `docs/**/*.pdf` in [`../.gitignore`](../.gitignore)). They exist only on your machine; anyone who clones the repo won't get them.

If you need a PDF, re-export it from the Markdown source. Don't treat the PDF as the only copy.

## 5. Conventions for new documents

1. Operations manuals go in the `docs/` root, with all-caps filenames and underscores (e.g. `RESET_DATABASE.md`).
2. Current-state descriptions and architecture diagrams go in `docs/specs/`.
3. After adding a document, come back and update the tables in this index.
4. Never write real keys, passwords, or sensitive information beyond the project ref into a document.
5. For bilingual documents, name the Chinese version `NAME.zh.md` and the English version `NAME.en.md`, and keep `NAME.md` as the entry point (its content matches `.zh.md`). All three files must carry a language switcher at the top.
6. **Task process documents, security reviews, vulnerability analyses, source context, and internal test reports never enter this repository.** See the "Engineering document management rules" section in [`../AGENTS.md`](../AGENTS.md).
