# NOTES

What I built, what I deliberately left out, and how I checked it.

---

## The customer problem I optimised for

The brief's framing did the most work here: an inspection company is coming off
Spectora with a template they have tuned for four years, and *preserving that
work matters more than originality*. They will not retype it. So the risk is
not "the editor is ugly" — it is "something quietly did not come across, and
they find out three inspections later."

Almost every decision below follows from that.

---

## The hard part: ordering

This is the bug I would have shipped if I had trusted the format.

Spectora exports a column called **`Order (w/i item)`**. The obvious reading is
"sort comments by this." That is wrong in a way that does not show up until it
matters:

- The value is scoped **within an item**, so `0` appears 113 times across the
  file. It is not a global sort key.
- Worse, it is **not unique within an item either**. In this export, **42 of
  the 69 items contain duplicate order values** — sequences like
  `[0, 0, 1, 1, 2, 3]`.

`ORDER BY source_order` on a set with ties has **no defined result** in
Postgres. Two runs can return different orders for the same data. For a
customer whose whole complaint is "preserve my tuning," silently reshuffling
their comments is the worst possible failure: it is invisible, it is
inconsistent, and it destroys exactly the thing they were paying us to keep.

**The fix:** sort on `(source_order, source_row)`. `source_row` is the original
1-based spreadsheet row, unique by construction, so the sort is *total* and
reproducible. Comments that tie on order keep precisely the relative order they
had in the file. `source_row` is therefore not debugging residue — it is load-
bearing, which is why it is a column at every level of the schema.

Tests `tests/parse.test.ts → ordering` assert that the fixture actually
contains ties (so the guard stays exercised), that resolved positions are dense
and unique, that ties resolve by file order, and that two parses of the same
bytes produce identical output.

The report surfaces this to the user as a notice rather than hiding it:
*"N comments shared an Order value with a sibling. Ties were broken by original
file order, so the sequence you see matches the export."*

---

## Other things the real file taught me

I would not have guessed any of these from the format description. All came
from profiling the actual export before writing the parser.

**The file lies about its type.** It is named `.xls` but the bytes start with
`PK` — it is a ZIP-based XLSX. `openpyxl` refuses it purely on the extension.
The importer sniffs magic bytes and ignores the name. A customer whose
perfectly good file gets rejected reads that as *our* product being broken.

**Entities need opposite treatment in two columns.** Names arrive
HTML-escaped: the section an inspector sees as `Siding, Flashing & Trim`
arrives as the literal text `Siding, Flashing &amp; Trim`, and must be decoded
or every ampersand renders wrong. But `Comment Text` is an HTML fragment, where
`&amp;` is *correct markup* for a literal ampersand — decoding it there would
emit a bare `&` into HTML. Same characters, opposite handling. There is a test
pinning both directions, because this is exactly the kind of thing a later
refactor "tidies up" into a single shared helper and breaks.

**`Comment Text` is sometimes HTML and sometimes not.** 198 of 309 populated
cells contain markup; 111 are bare text. Bare text is escaped and wrapped into
`<p>` so that every stored body is valid HTML and the editor has one format to
deal with rather than two.

**Blank comment text is not an error.** 83 rows have no text at all. They are
`checkbox` and `number` data-collection fields (In Attendance, Occupancy,
Temperature), not broken comments. Flagging them would have produced 83 scary
warnings about a healthy file — the fastest way to teach someone to ignore the
report.

**There is a genuine duplicate.** `Fireplace / Damper Doors / Damper Inoperable`
appears twice. I import both and flag it. Deduplicating would be presumptuous:
the inspector may have two variants on purpose, and deleting one is precisely
the silent data loss this project exists to prevent.

**11 names carry padding whitespace** (`Temperature `, `Corrosion `). I trim
them — otherwise two spellings of one name become two records — and report each
one with its row number.

Entity decoding happens on 235 rows, which is routine rather than interesting,
so it is summarised as a single notice instead of 235 of them. Signal beats
completeness in a report nobody will read twice.

---

## Where I chose to go further: the import trust report

The baseline gives you a template and a success message. The customer's real
question is *"did all four years of it arrive, and what did you change?"*, and
a success message does not answer that.

So `/templates/[id]/report` shows:

- **The arithmetic.** `comments + skipped = rows in your file`, stated
  explicitly. If it does not balance, the page says so rather than rounding it
  off.
- **A disposition for every one of the 42 columns**, split into six states.
  The one that matters most is the distinction the brief asks for directly:
  **`empty_in_source`** ("we support this, your export had nothing in it —
  nothing was lost") versus **`unsupported`** ("we do not handle this, and
  there *was* data in it"). Collapsing those two into one "not imported"
  bucket is how you turn a fine import into a support ticket. The photo columns
  are the live example: all ten exist in the sheet and all ten are empty here,
  so they are `empty_in_source`, not a scary red row.
- **Every judgement call, with its spreadsheet row number**, grouped as *not
  imported* / *imported with a caveat* / *changed, for the record*, each with
  the raw source values behind a disclosure so a human can second-guess me.

The design rule throughout: never make the customer take our word for it.

---

## What I cut, and why

Two days, so most of the list is things I decided not to do.

**Photo import.** Ten `Default Photo N` columns plus captions. Cut because the
export carries Spectora-hosted URLs, so a faithful import means mirroring
someone else's binaries into our storage and dealing with expiry, auth and
cost — a project, not a feature. This export has zero photos populated, so it
costs the committed template nothing, and the report correctly distinguishes
"empty here" from "we cannot do this."

**Reordering, adding and deleting in the editor.** The brief asks me to decide
how far the editor should go. Import fidelity was the higher-value half, and
once you add reordering you have to answer what `source_order` means afterwards
and how re-import reconciles. Renaming and editing text — what the brief
explicitly names — is in.

**A rich-text (WYSIWYG) editor.** Comment bodies are edited as HTML source in a
textarea. A naive contenteditable rewrites markup on focus and would mangle the
careful formatting I just spent the import preserving. A trustworthy one is
days of work on its own. Source editing is honest about what it is doing, and
the allow-list re-sanitises on every save.

**Auth.** The brief permits a public URL and says to include access
instructions if there is a login. Skipping it removed a whole surface and let
the reviewer just open the link. In production this is the first thing to add —
`SUPABASE_SERVICE_ROLE_KEY` on the server is doing the job that per-user RLS
policies should do.

**Re-import / merge.** Importing the same file twice creates a second template.
Real reconciliation — matching by name, detecting renames, three-way merging
against edits already made — is genuinely hard and deserves more than a
leftover afternoon. Fresh import is predictable, and predictable beats a merge
that is subtly wrong.

**`Uses` and `Last Modified`.** Deliberately not carried. They describe the
source *account*, not the template's content. Marked `ignored_by_design` rather
than dropped in silence.

---

## Supported input

- Spectora `Export to spreadsheet → Export HTML Text`, as `.xlsx`, `.xls`
  (real OLE2), CSV, or an HTML table — detected from content, not extension.
- The header row is located by searching the first 15 rows for `Section Name` +
  `Comment Name`, rather than assuming row 1.
- Columns are matched on a normalised prefix, so Spectora rewording a header
  annotation (`Category (-1: Low, 0: Med, 1: High)` → `Category (severity)`)
  does not break the import. There is a test for this.
- **Required:** `Section Name`, `Item Name`, `Comment Name`. Missing any one is
  a hard failure that names the column and imports nothing.

### Known limitations

- Photos are not imported (above).
- Comment bodies are limited to the tag allow-list in `lib/spectora/html.ts`
  (`p, br, strong, b, em, i, u, ul, ol, li, a, span, div, h1–h4, blockquote,
  sub, sup`). Anything else is stripped **and reported per comment** with the
  tag names. Tables and images inside comment text would be dropped today.
- Link schemes are limited to `http`, `https`, `mailto`, `tel`. `http://` is
  allowed deliberately — several InterNACHI DIY references are not HTTPS, and
  silently dropping them would lose real content.
- Only the first worksheet is read. No export I saw uses a second one.
- A 10 MB upload cap. Template exports are well under 1 MB.
- Very large templates are imported in one request; there is no background job.
  Fine at this size, would need revisiting an order of magnitude up.
- **Dependencies.** Upgraded to Next.js 15.5 during the build after `npm audit`
  flagged critical advisories (including unauthenticated RCE) across the whole
  14.x line. `xlsx` is pinned to SheetJS's own 0.20.3 build from their CDN,
  because the npm package stopped receiving fixes at 0.18.5 and that version
  carries prototype-pollution and ReDoS advisories — which matter here, since
  the app parses uploaded files. `npm audit` still reports two findings with a
  single root cause: the PostCSS copy bundled inside Next (flagged high, with
  Next itself flagged moderate for bundling it). The fix only exists in Next 16.
  It is reachable only when compiling attacker-supplied CSS, and this app only
  ever compiles its own stylesheet at build time.

### Failure behaviour

Failures are explicit, leave the database untouched, and are recorded in
`import_runs` with their error so there is a trace afterwards rather than a
toast that vanishes.

| Case | Behaviour |
| --- | --- |
| Not a spreadsheet | `UNRECOGNISED_FILE`, nothing imported |
| No recognisable header row | `HEADER_NOT_FOUND`, with a hint about report-vs-template exports |
| Missing a required column | `MISSING_REQUIRED_COLUMNS`, naming it |
| Row missing Section/Item/Comment | Row skipped, listed as an error with its row number |
| Unknown column containing data | Imported anyway, column flagged `unsupported` with its row count |
| Unrecognised enum value | Raw value preserved in `*_raw`, flagged |
| Partial save failure | Template deleted; a half-imported template is worse than none |

---

## How the work was checked

Most of these checks were run by Claude during the build (see *Credit and AI
tool use* below for the split); the production checks in item 7 are mine.

1. **Profiled the real export before writing any parser code** — in Python,
   independently of the TypeScript — to get ground truth: 13 sections, 69
   items, 392 comments, and the column fill rates. Every number the importer
   produces was checked against that independent count. The ordering collisions
   and the duplicate comment were both found this way, not by reading docs.
2. **28 tests** (`npm test`), no database needed. They cover format detection,
   the hierarchy counts, entity handling in both directions, ordering (ties,
   density, determinism), preservation, sanitisation, and every failure case in
   the table above.
3. **A round-trip assertion**: every `Comment Name` in the source sheet, read by
   an independent code path, appears in the parsed tree. This is the test that
   would catch a whole section going missing.
4. **Determinism check**: parsing the same bytes twice yields identical output.
   This is what makes the ordering fix meaningful rather than incidental.
5. **Round-tripped the whole template through Postgres.** All 392
   parsed comments were loaded into a local Postgres 16 running this exact
   schema, read back with `ORDER BY s.position, i.position, c.position`, and diffed the
   result against the parser's own output. Identical, 392/392 — so the ordering
   guarantee survives the database and is not just true in memory. Counts in
   the database matched too: 13 sections, 69 items, 392 comments, 42 with
   links.
6. **Exercised `copy_template()` against real data, twice.** On a small fixture
   with deliberate order ties, and then on the full 392-comment template. The
   copy reproduced the ordering exactly; renaming every comment in the copy
   changed 392 rows in the copy and **0 in the original**; deleting the copy
   left the original intact. Copy independence is structural — the function
   deep-copies in a single statement, so a copy can never be half-made or share
   rows — but it was worth demonstrating rather than assuming.
7. **In production, by me.** Imported the committed export through the deployed
   app on Vercel against the real Supabase database: 392/392 rows accounted
   for, 0 skipped, 14 decisions reported. Checked the editor renders the full
   tree, that the `http://` DIY links survived sanitisation, and that entity
   decoding shows "Drain, Waste, & Vent Systems" correctly. Edit-and-reload and
   copy independence are demonstrated in the walkthrough video.

---

## Time spent

About **5 hours of my own hands-on time**, across the two days:

- Product exploration — the Spectora export and the Hive Inspect trial
- Reviewing the design decisions and the code until I could explain and change
  them
- Supabase and Vercel setup, deployment, and the production checks
- Recording the walkthrough

The implementation and most of the verification ran in Claude sessions inside
that window (see below). I'm stating it this way rather than as a per-phase
breakdown, because "parser: 3 hours" would imply I typed the parser, and I
didn't.

---

## Credit and AI tool use

**Existing code I built on:** SheetJS (`xlsx`) for spreadsheet reading,
`sanitize-html` for the comment allow-list, Next.js, Supabase, Tailwind. No
starter template beyond `create-next-app` conventions. The parser, schema,
`copy_template()`, the coverage/issue model and the report UI are written for
this assignment.

**AI tools:** built with Claude (via Claude Code / Cowork), which the brief
encourages. The split, stated plainly:

**What Claude did**

- **Profiled the real export before any parser existed** — column fill rates,
  distinct enum values, hierarchy counts, HTML tags and entities. Every
  non-obvious finding above (the XLSX-behind-`.xls`, the order collisions, the
  duplicate comment, the padded names) came out of that pass. Building against
  the real file rather than the documented format is what most changed the
  result.
- **Wrote the parser, schema, `copy_template()`, UI and tests.**
- **Ran the verification in items 1–6 above**, including the Python
  cross-check of counts and the Postgres round-trip, and caught its own bug
  mid-build: the first column spec let `Default Value` swallow
  `Default Value 2 (for "range" types)` by prefix match.

**What I did**

- Chose the stack (Next.js + Supabase) and the improvement to build (the import
  trust report), and supplied the real Spectora export.
- Reviewed the design decisions — `source_row` as the ordering tiebreaker,
  `empty_in_source` vs `unsupported`, what to cut — and the code, well enough
  to explain and change it.
- Set up Supabase and Vercel, deployed, and ran the production checks in
  item 7.

I'm responsible for what's shipped, as the brief says. This section exists so
you know which parts I executed and which I directed and verified.

No model is used *inside* the product. The import is deterministic parsing, not
inference — which for this customer is the right call: a template import that
"usually" gets the mapping right is not something you can ask someone to trust
with four years of work. The brief notes that validation and honest failure
matter for non-model importers too, and that is what the report and the failure
table are for.
