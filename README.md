# Template Importer — Spectora → Hive

Import an inspection template that a company has spent years tuning, let them
work with it, and keep their changes.

**Live app:** _(add your Vercel URL here)_
**Walkthrough video:** _(add your unlisted YouTube link here)_

No login. The app opens on an already-imported template so there is something
to explore straight away.

---

## What it does

1. **Import** a Spectora `Export to spreadsheet → Export HTML Text` file.
   Text, hierarchy and ordering are preserved; anything skipped or unsupported
   is shown, never quietly dropped.
2. **Review** the import. Every column in the source file gets a disposition,
   and every judgement call the importer made is listed with the spreadsheet
   row number so it can be checked against the original.
3. **Edit** section names, item names, comment names and comment text. Changes
   persist.
4. **Copy** a template and edit the copy independently. The original is
   untouched.
5. **Store** all of it in Postgres (Supabase). Everything survives a restart.

---

## The input file

`fixtures/InterNACHI Residential -2026-09-20.xls`

- **Template:** InterNACHI Residential, one of the templates Spectora offers
  out of the box.
- **Source:** loaded into a free Spectora trial account and exported with
  **Export to spreadsheet → Export HTML Text** on 20 September 2026.
- **Contents:** 392 rows — 13 sections, 69 items, 392 comments. Sample
  material only; no real customer information.

Despite the `.xls` name, the file is a **ZIP-based XLSX**. The importer detects
this from the file's magic bytes and ignores the extension, because trusting
the extension makes strict readers reject a perfectly good file.

---

## Setup

### Requirements

Node 18.17+ and a Supabase project (the free tier is enough).

### 1. Install

```bash
npm install
```

### 2. Create the database

In the Supabase dashboard open **SQL Editor**, paste the contents of
[`supabase/schema.sql`](supabase/schema.sql), and run it. It creates the
tables, the `copy_template` function, the `updated_at` triggers, and enables
RLS.

It is safe to re-run.

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in both values from
**Supabase → Project Settings → API**:

```bash
cp .env.example .env.local
```

| Variable | Where it comes from | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | e.g. `https://abcd.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key | **Server-side only.** Never commit it, never expose it to the browser. |

The service role key is used because this build has no end-user login: all
writes happen in server actions. RLS is enabled with no public policy, so the
anon key cannot read or write these tables even if it leaked.

### 4. Seed a template (optional)

```bash
set -a && source .env.local && set +a
npm run seed
```

This runs the committed export through the same parser and persistence path as
the upload form. You can also just upload the file through the UI.

### 5. Run

```bash
npm run dev      # http://localhost:3000
npm test         # 28 parser tests, no database required
npm run typecheck
```

---

## Deploying to Vercel

1. Push this repo to GitHub and import it at
   [vercel.com/new](https://vercel.com/new). Framework preset: **Next.js**;
   everything else default.
2. Add both environment variables under **Settings → Environment Variables**
   for Production (and Preview, if you want preview deploys to work).
3. Deploy, then seed once against the same database — either run `npm run seed`
   locally with the production credentials, or upload the export through the
   deployed UI.

---

## Layout

```
app/
  page.tsx                      template list + import form
  actions.ts                    server actions (import, edit, copy, delete)
  templates/[id]/page.tsx       the editor
  templates/[id]/report/page.tsx  the import trust report
components/
  ImportForm.tsx                upload + inline error reporting
  CommentEditor.tsx             per-comment expand-and-edit
  InlineRename.tsx              click-to-rename for sections and items
lib/
  spectora/
    parse.ts                    the importer
    columns.ts                  column contract + per-column policy
    html.ts                     entity handling, sanitisation, text projection
    types.ts                    shared types
  repo.ts                       batched persistence and tree reads
  db.ts                         Supabase client
supabase/schema.sql             tables, copy_template(), triggers, RLS
tests/parse.test.ts             28 tests, including every failure case
fixtures/                       the committed Spectora export
scripts/seed.ts                 seeds the committed export
```

---

## The data model

```
templates ──< sections ──< items ──< comments
     │
     └──< import_runs ──< import_issues
                       └─< import_coverage
```

A template is structured rows, never one opaque HTML blob. HTML survives only
inside `comments.body_html` — the one place the brief allows it, and the one
place inspectors actually use it (links to DIY articles, paragraphs, the
occasional bold run).

Three details worth knowing:

- **`source_row` is kept at every level.** Spectora's `Order (w/i item)` is
  item-scoped *and* non-unique, so the original row number is the only total,
  reproducible tiebreaker. See NOTES.md.
- **`severity_raw` / `answer_type_raw` sit beside the parsed values.** A value
  we do not recognise is preserved and flagged, not discarded.
- **`import_runs` / `import_issues` / `import_coverage` are written in the same
  flow as the content**, so a stored template always carries the evidence of
  how it got there.

---

## Known limitations

Written up properly in [NOTES.md](NOTES.md). The short version: no photo
import, no reordering or adding/deleting in the editor, no auth, comment text
is edited as HTML source rather than in a rich-text editor, and re-importing
creates a new template rather than merging into an existing one.

---

## Credits

- [SheetJS (`xlsx`)](https://sheetjs.com) — spreadsheet reading
- [`sanitize-html`](https://github.com/apostrophecms/sanitize-html) — the
  comment-body allow-list
- Next.js, Supabase, Tailwind
- Built with Claude (Claude Code) as the coding tool — see NOTES.md for what
  that actually meant in practice.
