# docs — Documentation index

This directory holds all public documentation for the Sync project. Code lives in [`../src/`](../src/), database migrations in [`../supabase/migrations/`](../supabase/migrations/).

[中文版](README.md) · English (this page)

## Directory layout

| Directory | Contents |
| --- | --- |
| [`architecture/`](architecture/) | Architecture descriptions and diagrams of the current code (describes what exists, not what's planned) |
| [`development/`](development/) | Development log, roadmap, thesis / defense data |
| [`operations/`](operations/) | Operations manuals: database reset, live schema snapshot |
| [`reference/`](reference/) | Baseline, regression checklist, and other reference material |

## 1. Architecture (`architecture/`)

| Document | Content |
| --- | --- |
| [`architecture/CODEBASE_MAP.md`](architecture/CODEBASE_MAP.md) · [中文](architecture/CODEBASE_MAP.md) · [EN](architecture/CODEBASE_MAP.en.md) | **Architecture of the current code**: tech stack, five-layer split, full route tree, business modules, data model, data layer, realtime sync, chat subsystem. Describes what exists, not what's planned |
| [`architecture/ARCHITECTURE_DIAGRAMS.md`](architecture/ARCHITECTURE_DIAGRAMS.md) | Architecture diagrams: module layering, data flow, screen relationships |

## 2. Development records (`development/`)

| Document | Purpose |
| --- | --- |
| [`development/DEV_LOG.md`](development/DEV_LOG.md) | Development log: what was done in each phase, what broke, and how it was fixed, in chronological order. Start here when asking "why is this change like this?" |
| [`development/TFG_DATA.md`](development/TFG_DATA.md) | Project data summary for the thesis / defense (scale, tech stack, effort statistics) |
| [`development/ROADMAP_2027_SUMMER.md`](development/ROADMAP_2027_SUMMER.md) · [中文](development/ROADMAP_2027_SUMMER.md) · [EN](development/ROADMAP_2027_SUMMER.en.md) | 2027 summer execution manual: the order of the six phases, effort estimates, risk points, fallback plans, daily workflow, and acceptance criteria. **Read only this file when work resumes** |

## 3. Operations manuals (`operations/`, follow them step by step)

| Document | Purpose | When to read |
| --- | --- | --- |
| [`operations/RESET_DATABASE.md`](operations/RESET_DATABASE.md) · [中文](operations/RESET_DATABASE.zh.md) · [EN](operations/RESET_DATABASE.en.md) | 6-step manual for a full database reset: clear `auth.users` → clear the 7 business tables → clear Storage → verify everything is empty → confirm the schema is intact → clear the app's local cache | When you want to wipe all test data and start acceptance testing from scratch |
| [`operations/DB_SCHEMA_REFERENCE.md`](operations/DB_SCHEMA_REFERENCE.md) · [中文](operations/DB_SCHEMA_REFERENCE.zh.md) · [EN](operations/DB_SCHEMA_REFERENCE.en.md) | Snapshot of the real structure of the live Supabase project: column definitions for the 7 tables, a policy-by-policy RLS inventory, triggers, RPCs, and fix priorities | Before changing table structure, troubleshooting permission issues, or writing a new migration |

## 4. Reference material (`reference/`)

| Document | Purpose |
| --- | --- |
| [`reference/BASELINE.md`](reference/BASELINE.md) | Pre-refactor baseline snapshot (build, lint, typecheck, directory scale, etc.) |
| [`reference/REGRESSION.md`](reference/REGRESSION.md) | Regression test checklist and execution records |

> Internal planning documents (refactor execution plan, relation-network interface reservation, etc.) are not published with this repository and are kept locally by the maintainer (see `.internal/`, which is git-ignored).

## 5. About the PDFs

The `.pdf` files under the `docs/` subdirectories are rendered exports of the Markdown above and are **not tracked by git** (see `docs/**/*.pdf` in [`../.gitignore`](../.gitignore)). They exist only on your machine; anyone who clones the repo won't get them.

If you need a PDF, re-export it from the Markdown source. Don't treat the PDF as the only copy.

## 6. Conventions for new documents

1. Put documents in the matching subdirectory: architecture → `architecture/`, development records → `development/`, operations manuals → `operations/`, reference material → `reference/`.
2. Use all-caps filenames with underscores (e.g. `RESET_DATABASE.md`).
3. After adding a document, come back and update the tables in this index.
4. Never write real keys, passwords, or sensitive information beyond the project ref into a document.
5. For bilingual documents, name the Chinese version `NAME.zh.md` and the English version `NAME.en.md`, and keep `NAME.md` as the entry point (its content matches `.zh.md`). All three files must carry a language switcher at the top.
6. **Task process documents, security reviews, vulnerability analyses, source context, and internal test reports never enter this repository.** See the "Engineering document management rules" section in [`../AGENTS.md`](../AGENTS.md).
