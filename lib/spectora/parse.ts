import * as XLSX from "xlsx";
import {
  COLUMN_SPECS,
  PHOTO_PATTERN,
  PHOTO_NOTE_CAPTION,
  PHOTO_NOTE_URL,
  normaliseHeader,
  type ColumnSpec,
} from "./columns";
import {
  decodeEntities,
  htmlToText,
  looksLikeHtml,
  sanitizeCommentHtml,
  textToHtml,
} from "./html";
import {
  ImportError,
  type AnswerType,
  type ColumnCoverage,
  type CommentType,
  type ImportIssue,
  type ParseResult,
  type ParsedComment,
  type ParsedItem,
  type ParsedSection,
  type Severity,
} from "./types";

const ANSWER_TYPES: AnswerType[] = [
  "boolean",
  "checkbox",
  "date",
  "number",
  "range",
  "text",
];
const COMMENT_TYPES: CommentType[] = ["info", "limit", "defect"];

/**
 * Detect what the bytes actually are.
 *
 * Worth its own function because the observed export is named ".xls" but is a
 * ZIP-based XLSX. Trusting the extension makes the strict readers refuse the
 * file, which is exactly the kind of failure that reads to a customer as "your
 * importer is broken" when the file was fine.
 */
export function detectFormat(buf: Uint8Array): string {
  if (buf.length >= 4) {
    if (buf[0] === 0x50 && buf[1] === 0x4b) return "xlsx"; // "PK" zip
    if (
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0
    )
      return "xls"; // OLE2 compound document
  }
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(buf.slice(0, 2048))
    .trim()
    .toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<table"))
    return "html";
  if (head.includes(",") || head.includes("\t")) return "csv";
  return "unknown";
}

interface ResolvedColumn {
  index: number;
  header: string;
  spec?: ColumnSpec;
  photo?: { n: number; caption: boolean };
}

function resolveColumns(headers: string[]) {
  const byKey = new Map<string, ResolvedColumn>();
  const resolved: ResolvedColumn[] = [];

  headers.forEach((header, index) => {
    const norm = normaliseHeader(header);
    if (!norm) {
      resolved.push({ index, header });
      return;
    }

    const photo = norm.match(PHOTO_PATTERN);
    if (photo) {
      resolved.push({
        index,
        header,
        photo: { n: Number(photo[1]), caption: Boolean(photo[2]) },
      });
      return;
    }

    // Longest matching prefix wins, so "default value 2" beats "default value".
    let best: { spec: ColumnSpec; len: number } | null = null;
    for (const spec of COLUMN_SPECS) {
      for (const m of spec.match) {
        if ((norm === m || norm.startsWith(m + " ") || norm.startsWith(m)) &&
            (!best || m.length > best.len)) {
          best = { spec, len: m.length };
        }
      }
    }

    const entry: ResolvedColumn = { index, header, spec: best?.spec };
    resolved.push(entry);
    if (best && !byKey.has(best.spec.key)) byKey.set(best.spec.key, entry);
  });

  return { resolved, byKey };
}

/** Find the header row rather than assuming row 1. */
function findHeaderRow(grid: unknown[][]): number {
  const limit = Math.min(grid.length, 15);
  for (let r = 0; r < limit; r++) {
    const norms = (grid[r] || []).map((c) => normaliseHeader(String(c ?? "")));
    const hasSection = norms.some((n) => n.startsWith("section name") || n === "section");
    const hasComment = norms.some((n) => n.startsWith("comment name"));
    if (hasSection && hasComment) return r;
  }
  throw new ImportError(
    "HEADER_NOT_FOUND",
    "Could not find the template header row in this file.",
    'Expected a row containing "Section Name" and "Comment Name" within the first 15 rows. ' +
      "Make sure you used Spectora's Export to spreadsheet -> Export HTML Text on a template, " +
      "not an inspection report export.",
  );
}

function cell(row: unknown[], col?: ResolvedColumn): string {
  if (!col) return "";
  const v = row[col.index];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Names arrive HTML-escaped and sometimes padded. We decode and trim for
 * display, but record the original so the review screen can show that we
 * changed it -- silently rewriting an inspector's text is the thing this
 * whole exercise is trying to avoid.
 */
function cleanName(raw: string): {
  value: string;
  entityDecoded: boolean;
  whitespaceTrimmed: boolean;
} {
  const decoded = decodeEntities(raw);
  const trimmed = decoded.replace(/\s+/g, " ").trim();
  return {
    value: trimmed,
    // Entity decoding is the expected, correct reading of the format, so it is
    // not worth a per-row notice -- it would bury the real findings under 235
    // lines of "we turned &amp; into &". It is summarised once instead.
    entityDecoded: decoded !== raw,
    // Whitespace padding is a genuine inconsistency in the source template
    // that the inspector may want to know about, so this one is reported.
    whitespaceTrimmed: trimmed !== decoded,
  };
}

function parseSeverity(raw: string): Severity | null {
  const t = raw.trim();
  if (t === "-1") return "low";
  if (t === "0") return "medium";
  if (t === "1") return "high";
  return null;
}

function splitOptions(raw: string): { options: string[]; dropped: number } {
  if (!raw.trim()) return { options: [], dropped: 0 };
  const parts = raw.split(",").map((p) => decodeEntities(p).trim());
  const options = parts.filter((p) => p.length > 0);
  return { options, dropped: parts.length - options.length };
}

export interface ParseOptions {
  /** Overrides the template name derived from the filename. */
  templateName?: string;
}

export function parseSpectoraExport(
  buffer: ArrayBuffer | Uint8Array,
  filename: string,
  options: ParseOptions = {},
): ParseResult {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const detectedFormat = detectFormat(bytes);
  const claimedExtension = (filename.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();

  if (detectedFormat === "unknown") {
    throw new ImportError(
      "UNRECOGNISED_FILE",
      "This file is not a spreadsheet we can read.",
      `The first bytes of "${filename}" match no format we support (xlsx, xls, html table, csv). ` +
        "Nothing was imported.",
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "array", cellHTML: false, raw: false });
  } catch (err) {
    throw new ImportError(
      "UNREADABLE_WORKBOOK",
      "We could not open this spreadsheet.",
      `Detected format: ${detectedFormat}. Underlying reader error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ImportError(
      "NO_SHEETS",
      "This workbook contains no sheets.",
      "Nothing was imported.",
    );
  }

  const sheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: true,
    raw: false,
  });

  const headerRowIdx = findHeaderRow(grid);
  const headers = (grid[headerRowIdx] || []).map((h) => String(h ?? ""));
  const { resolved, byKey } = resolveColumns(headers);

  const missingRequired = COLUMN_SPECS.filter(
    (s) => s.required && !byKey.has(s.key),
  );
  if (missingRequired.length > 0) {
    throw new ImportError(
      "MISSING_REQUIRED_COLUMNS",
      `This export is missing required column${
        missingRequired.length > 1 ? "s" : ""
      }: ${missingRequired.map((s) => s.label).join(", ")}.`,
      `Found columns: ${headers.filter(Boolean).join(" | ")}. Nothing was imported.`,
    );
  }

  const issues: ImportIssue[] = [];
  const dataRows = grid.slice(headerRowIdx + 1);

  // Section -> Item -> Comment, all built in first-appearance order.
  const sections: ParsedSection[] = [];
  const sectionIndex = new Map<string, ParsedSection>();
  const itemIndex = new Map<string, ParsedItem>();
  const seenTriples = new Map<string, number>();

  let skippedRows = 0;
  let entityDecodedRows = 0;
  let commentsWithHtml = 0;
  let commentsWithLinks = 0;
  let commentsWithoutText = 0;
  const populated = new Map<number, number>();

  dataRows.forEach((row, i) => {
    // +2: one for the 0-based index, one for the header row itself, so the
    // number matches what the inspector sees in Excel's row gutter.
    const sourceRow = headerRowIdx + i + 2;

    resolved.forEach((c) => {
      if (String(row[c.index] ?? "").trim() !== "") {
        populated.set(c.index, (populated.get(c.index) || 0) + 1);
      }
    });

    const rawSection = cell(row, byKey.get("sectionName"));
    const rawItem = cell(row, byKey.get("itemName"));
    const rawComment = cell(row, byKey.get("commentName"));

    if (!rawSection.trim() && !rawItem.trim() && !rawComment.trim()) {
      const anyValue = resolved.some(
        (c) => String(row[c.index] ?? "").trim() !== "",
      );
      if (anyValue) {
        skippedRows++;
        issues.push({
          severity: "warning",
          code: "ROW_WITHOUT_IDENTITY",
          message:
            "Row has data but no Section, Item or Comment name, so it has nowhere to live. It was not imported.",
          sourceRow,
          raw: rowToObject(row, resolved),
        });
      } else {
        skippedRows++;
      }
      return;
    }

    const section = cleanName(rawSection);
    const item = cleanName(rawItem);
    const comment = cleanName(rawComment);

    if (!section.value || !item.value || !comment.value) {
      skippedRows++;
      issues.push({
        severity: "error",
        code: "INCOMPLETE_HIERARCHY",
        message: `Row is missing ${
          [
            !section.value && "Section Name",
            !item.value && "Item Name",
            !comment.value && "Comment Name",
          ]
            .filter(Boolean)
            .join(" and ")
        }. It was not imported.`,
        sourceRow,
        raw: rowToObject(row, resolved),
      });
      return;
    }

    if (section.entityDecoded || item.entityDecoded || comment.entityDecoded) {
      entityDecodedRows++;
    }

    if (
      section.whitespaceTrimmed ||
      item.whitespaceTrimmed ||
      comment.whitespaceTrimmed
    ) {
      const which = [
        section.whitespaceTrimmed && `Section "${rawSection}"`,
        item.whitespaceTrimmed && `Item "${rawItem}"`,
        comment.whitespaceTrimmed && `Comment "${rawComment}"`,
      ]
        .filter(Boolean)
        .join(", ");
      issues.push({
        severity: "notice",
        code: "NAME_WHITESPACE_TRIMMED",
        message: `Padding whitespace was trimmed from a name in this row (${which}). Without this, two spellings of the same name become two different records.`,
        sourceRow,
        raw: {
          before: { section: rawSection, item: rawItem, comment: rawComment },
          after: {
            section: section.value,
            item: item.value,
            comment: comment.value,
          },
        },
      });
    }

    let sec = sectionIndex.get(section.value);
    if (!sec) {
      sec = {
        name: section.value,
        position: sections.length,
        sourceRowFirst: sourceRow,
        items: [],
      };
      sectionIndex.set(section.value, sec);
      sections.push(sec);
    }

    const itemKey = `${section.value}\u0000${item.value}`;
    let it = itemIndex.get(itemKey);
    if (!it) {
      it = {
        name: item.value,
        position: sec.items.length,
        sourceRowFirst: sourceRow,
        comments: [],
      };
      itemIndex.set(itemKey, it);
      sec.items.push(it);
    }

    const tripleKey = `${itemKey}\u0000${comment.value}`;
    const prior = seenTriples.get(tripleKey);
    if (prior !== undefined) {
      issues.push({
        severity: "warning",
        code: "DUPLICATE_COMMENT",
        message: `"${comment.value}" appears more than once under ${section.value} / ${item.value}. Both copies were imported, because the duplicate may be intentional and deleting one would lose an inspector's edit.`,
        sourceRow,
        raw: { firstSeenAtRow: prior },
      });
    } else {
      seenTriples.set(tripleKey, sourceRow);
    }

    // --- comment body -------------------------------------------------
    const rawText = cell(row, byKey.get("commentText"));
    let bodyHtml = "";
    let sourceWasHtml = false;
    if (rawText.trim()) {
      sourceWasHtml = looksLikeHtml(rawText);
      // Critical: comment text is HTML, so entities inside it are *correct*
      // and must not be decoded. Bare text is escaped on the way in instead.
      const candidate = sourceWasHtml ? rawText : textToHtml(rawText);
      const outcome = sanitizeCommentHtml(candidate);
      bodyHtml = outcome.html;
      if (outcome.removedTags.length > 0) {
        issues.push({
          severity: "warning",
          code: "TAGS_REMOVED",
          message: `Unsupported markup removed from comment "${comment.value}": <${outcome.removedTags.join(">, <")}>. The text itself was kept.`,
          sourceRow,
          raw: { removedTags: outcome.removedTags },
        });
      }
      if (outcome.linkCount > 0) commentsWithLinks++;
      if (sourceWasHtml) commentsWithHtml++;
    } else {
      commentsWithoutText++;
    }
    const bodyText = htmlToText(bodyHtml);

    // --- enums ----------------------------------------------------------
    const rawCommentType = cell(row, byKey.get("commentType")).trim().toLowerCase();
    let commentType: CommentType | null = null;
    if (rawCommentType) {
      if ((COMMENT_TYPES as string[]).includes(rawCommentType)) {
        commentType = rawCommentType as CommentType;
      } else {
        issues.push({
          severity: "warning",
          code: "UNKNOWN_COMMENT_TYPE",
          message: `Unrecognised Comment Type "${rawCommentType}" on "${comment.value}". Imported without a type; the original value is kept in the row detail.`,
          sourceRow,
          raw: { value: rawCommentType },
        });
      }
    }

    const rawAnswerType = cell(row, byKey.get("answerType")).trim().toLowerCase();
    let answerType: AnswerType | null = null;
    if (rawAnswerType) {
      if ((ANSWER_TYPES as string[]).includes(rawAnswerType)) {
        answerType = rawAnswerType as AnswerType;
      } else {
        issues.push({
          severity: "warning",
          code: "UNKNOWN_ANSWER_TYPE",
          message: `Unrecognised Answer Type "${rawAnswerType}" on "${comment.value}". Imported without a type; the original value is kept.`,
          sourceRow,
          raw: { value: rawAnswerType },
        });
      }
    }

    const severityRaw = cell(row, byKey.get("category")).trim();
    const severity = severityRaw ? parseSeverity(severityRaw) : null;
    if (severityRaw && severity === null) {
      issues.push({
        severity: "warning",
        code: "UNKNOWN_CATEGORY",
        message: `Unrecognised Category "${severityRaw}" on "${comment.value}". Expected -1, 0 or 1. Raw value preserved.`,
        sourceRow,
        raw: { value: severityRaw },
      });
    }

    const { options, dropped } = splitOptions(cell(row, byKey.get("options")));
    if (dropped > 0) {
      issues.push({
        severity: "notice",
        code: "EMPTY_OPTION_DROPPED",
        message: `${dropped} empty choice${dropped > 1 ? "s" : ""} (from a trailing comma) removed from "${comment.value}".`,
        sourceRow,
      });
    }
    const { options: unitOptions } = splitOptions(
      cell(row, byKey.get("unitOptions")),
    );

    const orderRaw = cell(row, byKey.get("order")).trim();
    const sourceOrder = orderRaw === "" ? null : Number(orderRaw);
    if (orderRaw !== "" && !Number.isFinite(sourceOrder)) {
      issues.push({
        severity: "warning",
        code: "UNPARSEABLE_ORDER",
        message: `Order value "${orderRaw}" on "${comment.value}" is not a number. Falling back to file order for this comment.`,
        sourceRow,
      });
    }

    const extra: Record<string, string> = {};
    for (const key of [
      "locked",
      "simpleFormat",
      "disablePhotos",
      "defaultUnitType",
      "defaultLocation",
      "defaultValue2",
    ]) {
      const v = cell(row, byKey.get(key)).trim();
      if (v) extra[key] = v;
    }

    const parsed: ParsedComment = {
      name: comment.value,
      bodyHtml,
      bodyText,
      sourceWasHtml,
      commentType,
      severityRaw: severityRaw || null,
      severity,
      answerType,
      answerTypeRaw: rawAnswerType || null,
      options,
      unitOptions,
      recommendation: cell(row, byKey.get("recommendation")).trim() || null,
      defaultValue: cell(row, byKey.get("defaultValue")).trim() || null,
      defaultValue2: cell(row, byKey.get("defaultValue2")).trim() || null,
      defaultUnitType: cell(row, byKey.get("defaultUnitType")).trim() || null,
      defaultLocation: cell(row, byKey.get("defaultLocation")).trim() || null,
      estimateMin: cell(row, byKey.get("estimateMin")).trim() || null,
      estimateMax: cell(row, byKey.get("estimateMax")).trim() || null,
      sourceOrder: Number.isFinite(sourceOrder) ? (sourceOrder as number) : null,
      sourceRow,
      position: 0, // assigned below
      extra,
    };

    it.comments.push(parsed);
  });

  /**
   * THE ordering decision.
   *
   * Spectora's "Order (w/i item)" is scoped to the item and is NOT unique: in
   * the observed InterNACHI export, 42 of 69 items contain duplicate order
   * values (e.g. [0,0,1,1,2,3]). Sorting on that column alone therefore has no
   * defined result, and a different run can silently reshuffle comments an
   * inspector spent years arranging.
   *
   * We sort on (sourceOrder, sourceRow). The row number is unique by
   * construction, so the sort is total and reproducible, and comments that tie
   * on order keep exactly the relative order they had in the file.
   */
  let commentCount = 0;
  for (const sec of sections) {
    for (const it of sec.items) {
      it.comments.sort((a, b) => {
        const ao = a.sourceOrder ?? Number.MAX_SAFE_INTEGER;
        const bo = b.sourceOrder ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return a.sourceRow - b.sourceRow;
      });
      it.comments.forEach((c, idx) => {
        c.position = idx;
      });
      commentCount += it.comments.length;
    }
  }

  if (entityDecodedRows > 0) {
    issues.push({
      severity: "notice",
      code: "ENTITIES_DECODED",
      message: `HTML entities were decoded in the names of ${entityDecodedRows} row${entityDecodedRows > 1 ? "s" : ""} (for example "Siding, Flashing &amp; Trim" became "Siding, Flashing & Trim"). This is the correct reading of the export format, not a change to your content.`,
    });
  }

  const collisions = countOrderCollisions(sections);
  if (collisions > 0) {
    issues.push({
      severity: "notice",
      code: "ORDER_TIES_RESOLVED",
      message: `${collisions} comment${collisions > 1 ? "s" : ""} shared an Order value with a sibling. Ties were broken by original file order, so the sequence you see matches the export.`,
    });
  }

  // --- coverage report --------------------------------------------------
  const coverage: ColumnCoverage[] = [];
  const photoBuckets = { url: 0, caption: 0, urlRows: 0, captionRows: 0 };

  for (const c of resolved) {
    const rows = populated.get(c.index) || 0;
    if (c.photo) {
      if (c.photo.caption) {
        photoBuckets.caption++;
        photoBuckets.captionRows += rows;
      } else {
        photoBuckets.url++;
        photoBuckets.urlRows += rows;
      }
      continue;
    }
    if (!c.header.trim()) continue;
    if (!c.spec) {
      coverage.push({
        column: c.header,
        status: "unsupported",
        populatedRows: rows,
        note:
          rows > 0
            ? "Column not recognised by this importer and it contains data. Nothing from it was imported."
            : "Column not recognised by this importer. It was empty, so nothing was lost.",
      });
      if (rows > 0) {
        issues.push({
          severity: "warning",
          code: "UNSUPPORTED_COLUMN_WITH_DATA",
          message: `Column "${c.header}" is not supported by this importer and contains data in ${rows} row${rows > 1 ? "s" : ""}. That data was not imported.`,
        });
      }
      continue;
    }
    const status =
      c.spec.status !== "ignored_by_design" && rows === 0
        ? "empty_in_source"
        : c.spec.status;
    coverage.push({
      column: c.spec.label,
      status,
      populatedRows: rows,
      note:
        status === "empty_in_source"
          ? `Supported, but every row in this export was blank. ${c.spec.note}`
          : c.spec.note,
    });
  }

  if (photoBuckets.url > 0) {
    coverage.push({
      column: `Default Photo 1-${photoBuckets.url}`,
      status: photoBuckets.urlRows === 0 ? "empty_in_source" : "unsupported",
      populatedRows: photoBuckets.urlRows,
      note: PHOTO_NOTE_URL,
    });
    coverage.push({
      column: `Default Photo 1-${photoBuckets.caption} Caption`,
      status: photoBuckets.captionRows === 0 ? "empty_in_source" : "unsupported",
      populatedRows: photoBuckets.captionRows,
      note: PHOTO_NOTE_CAPTION,
    });
    if (photoBuckets.urlRows > 0) {
      issues.push({
        severity: "warning",
        code: "PHOTOS_NOT_IMPORTED",
        message: `This export references ${photoBuckets.urlRows} default photo${photoBuckets.urlRows > 1 ? "s" : ""}. Photo import is not supported in this build, so those references were not carried across.`,
      });
    }
  }

  for (const spec of COLUMN_SPECS) {
    if (!byKey.has(spec.key)) {
      coverage.push({
        column: spec.label,
        status: "missing_from_export",
        populatedRows: 0,
        note: "This importer supports this column, but the export did not contain it.",
      });
    }
  }

  const templateName =
    options.templateName?.trim() ||
    filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() ||
    "Imported template";

  const itemCount = sections.reduce((n, s) => n + s.items.length, 0);

  return {
    template: { name: templateName, sections },
    report: {
      filename,
      bytes: bytes.length,
      detectedFormat,
      claimedExtension,
      sheetName,
      headerRow: headerRowIdx + 1,
      stats: {
        sourceRows: grid.length,
        dataRows: dataRows.length,
        skippedRows,
        sections: sections.length,
        items: itemCount,
        comments: commentCount,
        commentsWithHtml,
        commentsWithLinks,
        commentsWithoutText,
        columnsSeen: resolved.filter((c) => c.header.trim()).length,
        columnsImported: coverage.filter(
          (c) => c.status === "imported" || c.status === "preserved",
        ).length,
        columnsUnsupported: coverage.filter((c) => c.status === "unsupported")
          .length,
      },
      coverage,
      issues,
    },
  };
}

function countOrderCollisions(sections: ParsedSection[]): number {
  let n = 0;
  for (const s of sections) {
    for (const it of s.items) {
      const counts = new Map<number, number>();
      for (const c of it.comments) {
        if (c.sourceOrder === null) continue;
        counts.set(c.sourceOrder, (counts.get(c.sourceOrder) || 0) + 1);
      }
      for (const v of counts.values()) if (v > 1) n += v;
    }
  }
  return n;
}

function rowToObject(
  row: unknown[],
  resolved: { index: number; header: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of resolved) {
    const v = String(row[c.index] ?? "").trim();
    if (v && c.header.trim()) out[c.header] = v;
  }
  return out;
}
