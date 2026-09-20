import { db } from "./db";
import type { ImportReport, ParsedTemplate } from "./spectora/types";

export interface TemplateRow {
  id: string;
  name: string;
  copied_from_id: string | null;
  copied_from_name: string | null;
  source_filename: string | null;
  source_format: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentRow {
  id: string;
  item_id: string;
  name: string;
  body_html: string;
  body_text: string;
  source_was_html: boolean;
  comment_type: string | null;
  severity: string | null;
  severity_raw: string | null;
  answer_type: string | null;
  answer_type_raw: string | null;
  options: string[];
  unit_options: string[];
  recommendation: string | null;
  estimate_min: string | null;
  estimate_max: string | null;
  source_order: number | null;
  source_row: number | null;
  position: number;
  extra: Record<string, string>;
}

export interface ItemRow {
  id: string;
  name: string;
  position: number;
  source_row: number | null;
  comments: CommentRow[];
}

export interface SectionRow {
  id: string;
  name: string;
  position: number;
  source_row: number | null;
  items: ItemRow[];
}

export interface TemplateTree extends TemplateRow {
  sections: SectionRow[];
}

/**
 * Persist a parsed template and its import evidence.
 *
 * Inserts are batched per level rather than per row: the InterNACHI template
 * is 392 comments, and doing that one round trip at a time turns a fast import
 * into a visibly slow one.
 */
export async function saveImport(
  template: ParsedTemplate,
  report: ImportReport,
): Promise<{ templateId: string; importRunId: string }> {
  const sb = db();

  const { data: tpl, error: tplErr } = await sb
    .from("templates")
    .insert({
      name: template.name,
      source_filename: report.filename,
      source_format: report.detectedFormat,
      imported_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (tplErr) throw new Error(`Could not create template: ${tplErr.message}`);
  const templateId = tpl.id as string;

  try {
    // --- sections ---------------------------------------------------------
    const { data: sectionRows, error: secErr } = await sb
      .from("sections")
      .insert(
        template.sections.map((s) => ({
          template_id: templateId,
          name: s.name,
          position: s.position,
          source_row: s.sourceRowFirst,
        })),
      )
      .select("id, position");
    if (secErr) throw new Error(`Could not save sections: ${secErr.message}`);

    const sectionIdByPos = new Map<number, string>(
      (sectionRows ?? []).map((r) => [r.position as number, r.id as string]),
    );

    // --- items ------------------------------------------------------------
    const itemPayload = template.sections.flatMap((s) =>
      s.items.map((it) => ({
        section_id: sectionIdByPos.get(s.position)!,
        name: it.name,
        position: it.position,
        source_row: it.sourceRowFirst,
      })),
    );
    const { data: itemRows, error: itemErr } = await sb
      .from("items")
      .insert(itemPayload)
      .select("id, section_id, position");
    if (itemErr) throw new Error(`Could not save items: ${itemErr.message}`);

    const itemIdByKey = new Map<string, string>(
      (itemRows ?? []).map((r) => [
        `${r.section_id}:${r.position}`,
        r.id as string,
      ]),
    );

    // --- comments ---------------------------------------------------------
    const commentPayload = template.sections.flatMap((s) =>
      s.items.flatMap((it) => {
        const itemId = itemIdByKey.get(
          `${sectionIdByPos.get(s.position)}:${it.position}`,
        )!;
        return it.comments.map((c) => ({
          item_id: itemId,
          name: c.name,
          body_html: c.bodyHtml,
          body_text: c.bodyText,
          source_was_html: c.sourceWasHtml,
          comment_type: c.commentType,
          severity: c.severity,
          severity_raw: c.severityRaw,
          answer_type: c.answerType,
          answer_type_raw: c.answerTypeRaw,
          options: c.options,
          unit_options: c.unitOptions,
          recommendation: c.recommendation,
          default_value: c.defaultValue,
          default_value_2: c.defaultValue2,
          default_unit_type: c.defaultUnitType,
          default_location: c.defaultLocation,
          estimate_min: c.estimateMin,
          estimate_max: c.estimateMax,
          source_order: c.sourceOrder,
          source_row: c.sourceRow,
          position: c.position,
          extra: c.extra,
        }));
      }),
    );

    for (const chunk of chunked(commentPayload, 500)) {
      const { error } = await sb.from("comments").insert(chunk);
      if (error) throw new Error(`Could not save comments: ${error.message}`);
    }

    const importRunId = await saveReport(templateId, report, "succeeded");
    return { templateId, importRunId };
  } catch (err) {
    // A partial template is worse than none: the whole point is trustworthy
    // import, so an interrupted run rolls its own template away.
    await sb.from("templates").delete().eq("id", templateId);
    throw err;
  }
}

export async function saveReport(
  templateId: string | null,
  report: ImportReport,
  status: "succeeded" | "failed",
  failure?: { code: string; message: string; detail?: string },
): Promise<string> {
  const sb = db();
  const { data: run, error } = await sb
    .from("import_runs")
    .insert({
      template_id: templateId,
      filename: report.filename,
      bytes: report.bytes,
      detected_format: report.detectedFormat,
      claimed_extension: report.claimedExtension,
      sheet_name: report.sheetName,
      header_row: report.headerRow,
      status,
      error_code: failure?.code ?? null,
      error_message: failure?.message ?? null,
      error_detail: failure?.detail ?? null,
      stats: report.stats,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not save import run: ${error.message}`);
  const runId = run.id as string;

  if (report.issues.length > 0) {
    for (const chunk of chunked(report.issues, 500)) {
      await sb.from("import_issues").insert(
        chunk.map((i) => ({
          import_run_id: runId,
          severity: i.severity,
          code: i.code,
          message: i.message,
          source_row: i.sourceRow ?? null,
          raw: i.raw ?? null,
        })),
      );
    }
  }

  if (report.coverage.length > 0) {
    await sb.from("import_coverage").insert(
      report.coverage.map((c) => ({
        import_run_id: runId,
        column_name: c.column,
        status: c.status,
        populated_rows: c.populatedRows,
        note: c.note,
      })),
    );
  }

  return runId;
}

export async function listTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await db()
    .from("templates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as TemplateRow[];
}

export async function getTemplateTree(id: string): Promise<TemplateTree | null> {
  const sb = db();
  const { data: tpl, error: tplErr } = await sb
    .from("templates")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (tplErr) throw new Error(tplErr.message);
  if (!tpl) return null;

  const { data: sections, error: secErr } = await sb
    .from("sections")
    .select("id, name, position, source_row")
    .eq("template_id", id)
    .order("position");
  if (secErr) throw new Error(secErr.message);

  const sectionIds = (sections ?? []).map((s) => s.id as string);
  const { data: items, error: itemErr } = sectionIds.length
    ? await sb
        .from("items")
        .select("id, section_id, name, position, source_row")
        .in("section_id", sectionIds)
        .order("position")
    : { data: [], error: null };
  if (itemErr) throw new Error(itemErr.message);

  const itemIds = (items ?? []).map((i) => i.id as string);
  const comments: CommentRow[] = [];
  for (const chunk of chunked(itemIds, 200)) {
    const { data, error } = await sb
      .from("comments")
      .select("*")
      .in("item_id", chunk)
      .order("position");
    if (error) throw new Error(error.message);
    comments.push(...((data ?? []) as CommentRow[]));
  }

  const commentsByItem = new Map<string, CommentRow[]>();
  for (const c of comments) {
    const list = commentsByItem.get(c.item_id) ?? [];
    list.push(c);
    commentsByItem.set(c.item_id, list);
  }
  for (const list of commentsByItem.values()) {
    list.sort((a, b) => a.position - b.position);
  }

  const itemsBySection = new Map<string, ItemRow[]>();
  for (const i of items ?? []) {
    const list = itemsBySection.get(i.section_id as string) ?? [];
    list.push({
      id: i.id as string,
      name: i.name as string,
      position: i.position as number,
      source_row: (i.source_row as number) ?? null,
      comments: commentsByItem.get(i.id as string) ?? [],
    });
    itemsBySection.set(i.section_id as string, list);
  }
  for (const list of itemsBySection.values()) {
    list.sort((a, b) => a.position - b.position);
  }

  return {
    ...(tpl as TemplateRow),
    sections: (sections ?? []).map((s) => ({
      id: s.id as string,
      name: s.name as string,
      position: s.position as number,
      source_row: (s.source_row as number) ?? null,
      items: itemsBySection.get(s.id as string) ?? [],
    })),
  };
}

export async function getLatestRun(templateId: string) {
  const sb = db();
  const { data: run, error } = await sb
    .from("import_runs")
    .select("*")
    .eq("template_id", templateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) return null;

  const [{ data: issues }, { data: coverage }] = await Promise.all([
    sb
      .from("import_issues")
      .select("*")
      .eq("import_run_id", run.id)
      .order("source_row", { nullsFirst: true }),
    sb
      .from("import_coverage")
      .select("*")
      .eq("import_run_id", run.id)
      .order("id"),
  ]);

  return { run, issues: issues ?? [], coverage: coverage ?? [] };
}

export async function copyTemplate(
  id: string,
  newName: string,
): Promise<string> {
  const { data, error } = await db().rpc("copy_template", {
    src_id: id,
    new_name: newName,
  });
  if (error) throw new Error(`Could not copy template: ${error.message}`);
  return data as string;
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await db().from("templates").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
