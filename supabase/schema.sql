-- Hive Inspect template importer -- schema
--
-- Design notes (the "model it" requirement):
--
-- A template is stored as structured rows, never as one opaque HTML blob.
-- The tree is templates -> sections -> items -> comments. HTML survives only
-- inside comments.body_html, which is the one place the assignment allows it
-- and the one place inspectors actually use it (links to DIY articles,
-- paragraphs, the occasional bold run).
--
-- Every level keeps source_row. That is not decoration: Spectora's
-- "Order (w/i item)" is item-scoped AND non-unique, so the original file row
-- is the only total, reproducible tiebreaker available. Dropping it would make
-- ordering undefined on re-import.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- templates

create table if not exists templates (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  -- Set when this template was produced by copying another one. The copy is a
  -- full independent tree; this is provenance only, never a shared reference.
  copied_from_id    uuid references templates(id) on delete set null,
  copied_from_name  text,
  source_filename   text,
  source_format     text,
  imported_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists sections (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references templates(id) on delete cascade,
  name         text not null,
  position     integer not null,
  source_row   integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists sections_template_pos_idx
  on sections(template_id, position);

create table if not exists items (
  id          uuid primary key default gen_random_uuid(),
  section_id  uuid not null references sections(id) on delete cascade,
  name        text not null,
  position    integer not null,
  source_row  integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists items_section_pos_idx on items(section_id, position);

create table if not exists comments (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references items(id) on delete cascade,
  name           text not null,
  -- Sanitised HTML fragment. Allowed because the assignment permits rich
  -- content per comment field; the allow-list lives in lib/spectora/html.ts.
  body_html      text not null default '',
  -- Plain-text projection, kept alongside for search and for cheap diffing of
  -- "did this survive the round trip".
  body_text      text not null default '',
  source_was_html boolean not null default false,

  comment_type   text,                    -- info | limit | defect
  severity       text,                    -- low | medium | high
  severity_raw   text,                    -- original -1 / 0 / 1, kept verbatim
  answer_type    text,                    -- boolean | checkbox | date | number | range | text
  answer_type_raw text,                   -- original, kept even when unrecognised

  options         jsonb not null default '[]'::jsonb,
  unit_options    jsonb not null default '[]'::jsonb,
  recommendation  text,
  default_value   text,
  default_value_2 text,
  default_unit_type text,
  default_location  text,
  estimate_min    text,
  estimate_max    text,

  -- Spectora's own order value. Retained so we can round-trip and so the
  -- review screen can show why two comments tied.
  source_order   integer,
  source_row     integer,
  -- Our resolved order: dense, unique within the item, total.
  position       integer not null,
  -- Anything carried across that the editor does not yet expose.
  extra          jsonb not null default '{}'::jsonb,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists comments_item_pos_idx on comments(item_id, position);
create index if not exists comments_text_idx
  on comments using gin (to_tsvector('english', body_text));

-- ------------------------------------------------------- the trust artefacts
--
-- These three tables are the "make the import easier to trust" improvement.
-- They are written in the same transaction as the content, so a stored
-- template always carries the evidence of how it got here.

create table if not exists import_runs (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid references templates(id) on delete cascade,
  filename        text not null,
  bytes           integer not null,
  detected_format text,
  claimed_extension text,
  sheet_name      text,
  header_row      integer,
  status          text not null default 'succeeded',  -- succeeded | failed
  error_code      text,
  error_message   text,
  error_detail    text,
  stats           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists import_runs_template_idx on import_runs(template_id);

create table if not exists import_issues (
  id             uuid primary key default gen_random_uuid(),
  import_run_id  uuid not null references import_runs(id) on delete cascade,
  severity       text not null,       -- error | warning | notice
  code           text not null,
  message        text not null,
  source_row     integer,
  raw            jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists import_issues_run_idx on import_issues(import_run_id);

create table if not exists import_coverage (
  id             uuid primary key default gen_random_uuid(),
  import_run_id  uuid not null references import_runs(id) on delete cascade,
  column_name    text not null,
  -- imported | preserved | empty_in_source | ignored_by_design
  -- | unsupported | missing_from_export
  status         text not null,
  populated_rows integer not null default 0,
  note           text not null default ''
);
create index if not exists import_coverage_run_idx on import_coverage(import_run_id);

-- ------------------------------------------------------------- copy support
--
-- Deep copy in one statement so a copy can never be half-made, and so the
-- copy shares no rows with the original. Everything below the template is
-- duplicated; only provenance columns point back.

create or replace function copy_template(src_id uuid, new_name text)
returns uuid
language plpgsql
as $$
declare
  new_id uuid;
begin
  insert into templates (name, copied_from_id, copied_from_name,
                         source_filename, source_format, imported_at)
  select new_name, t.id, t.name, t.source_filename, t.source_format, t.imported_at
  from templates t where t.id = src_id
  returning id into new_id;

  if new_id is null then
    raise exception 'template % not found', src_id;
  end if;

  with new_sections as (
    insert into sections (template_id, name, position, source_row)
    select new_id, s.name, s.position, s.source_row
    from sections s where s.template_id = src_id
    order by s.position
    returning id, position
  ),
  section_map as (
    select o.id as old_id, n.id as new_id
    from (select id, position from sections where template_id = src_id) o
    join new_sections n on n.position = o.position
  ),
  new_items as (
    insert into items (section_id, name, position, source_row)
    select m.new_id, i.name, i.position, i.source_row
    from items i join section_map m on m.old_id = i.section_id
    returning id, section_id, position
  ),
  item_map as (
    select oi.id as old_id, ni.id as new_id
    from items oi
    join section_map m on m.old_id = oi.section_id
    join new_items ni on ni.section_id = m.new_id and ni.position = oi.position
  )
  insert into comments (
    item_id, name, body_html, body_text, source_was_html,
    comment_type, severity, severity_raw, answer_type, answer_type_raw,
    options, unit_options, recommendation, default_value, default_value_2,
    default_unit_type, default_location, estimate_min, estimate_max,
    source_order, source_row, position, extra
  )
  select
    im.new_id, c.name, c.body_html, c.body_text, c.source_was_html,
    c.comment_type, c.severity, c.severity_raw, c.answer_type, c.answer_type_raw,
    c.options, c.unit_options, c.recommendation, c.default_value, c.default_value_2,
    c.default_unit_type, c.default_location, c.estimate_min, c.estimate_max,
    c.source_order, c.source_row, c.position, c.extra
  from comments c
  join item_map im on im.old_id = c.item_id;

  return new_id;
end;
$$;

-- ------------------------------------------------------------- housekeeping

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists templates_touch on templates;
create trigger templates_touch before update on templates
  for each row execute function touch_updated_at();
drop trigger if exists sections_touch on sections;
create trigger sections_touch before update on sections
  for each row execute function touch_updated_at();
drop trigger if exists items_touch on items;
create trigger items_touch before update on items
  for each row execute function touch_updated_at();
drop trigger if exists comments_touch on comments;
create trigger comments_touch before update on comments
  for each row execute function touch_updated_at();

-- Editing a comment should bump the template it belongs to, so the list can
-- show a truthful "last edited".
create or replace function touch_template_from_comment()
returns trigger language plpgsql as $$
begin
  update templates set updated_at = now()
  where id = (
    select s.template_id from items i
    join sections s on s.id = i.section_id
    where i.id = coalesce(new.item_id, old.item_id)
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists comments_touch_template on comments;
create trigger comments_touch_template after insert or update or delete on comments
  for each row execute function touch_template_from_comment();

-- ---------------------------------------------------------------------- RLS
--
-- This build has no end-user login: the reviewer opens a public URL. All
-- writes go through Next.js server actions using the service role key, which
-- bypasses RLS. RLS is enabled with no public policy so that the anon key
-- (which is shipped to the browser) cannot read or write the tables directly.

alter table templates       enable row level security;
alter table sections        enable row level security;
alter table items           enable row level security;
alter table comments        enable row level security;
alter table import_runs     enable row level security;
alter table import_issues   enable row level security;
alter table import_coverage enable row level security;
