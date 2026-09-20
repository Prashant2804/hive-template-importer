/**
 * Types for the Spectora template import pipeline.
 *
 * The shape here is deliberately *not* "whatever Spectora gave us". It is the
 * shape our product wants: Template -> Section -> Item -> Comment. The parser's
 * job is to move a flat, denormalised spreadsheet into that tree without losing
 * anything, and to be honest about whatever it could not carry across.
 */

export type CommentType = "info" | "limit" | "defect";

/** Spectora encodes severity as -1 / 0 / 1. We keep the source value and a label. */
export type Severity = "low" | "medium" | "high";

export type AnswerType =
  | "boolean"
  | "checkbox"
  | "date"
  | "number"
  | "range"
  | "text";

/**
 * How a source column was handled. This is the backbone of the import trust
 * report: the assignment asks us to distinguish "the export did not contain
 * this" from "our importer does not support this", and those are different
 * rows in this enum.
 */
export type ColumnStatus =
  /** Read and stored as first-class structured data. */
  | "imported"
  /** Present in the export, carried across verbatim but not yet used by the editor. */
  | "preserved"
  /** We understand it and would import it, but this export had no values. */
  | "empty_in_source"
  /** We deliberately do not carry it. `note` must say why. */
  | "ignored_by_design"
  /** We saw the column but do not know what to do with it. Loud by design. */
  | "unsupported"
  /** Column we expected from the format spec but the file did not contain. */
  | "missing_from_export";

export interface ColumnCoverage {
  column: string;
  status: ColumnStatus;
  populatedRows: number;
  note: string;
}

export type IssueSeverity = "error" | "warning" | "notice";

export interface ImportIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** 1-based row number in the source sheet, matching what the user sees in Excel. */
  sourceRow?: number;
  /** The raw source values involved, so a human can judge the call themselves. */
  raw?: Record<string, unknown>;
}

export interface ParsedComment {
  name: string;
  /** Sanitised HTML. Empty string when the source cell was blank. */
  bodyHtml: string;
  /** Plain-text projection of bodyHtml, for search and for diffing. */
  bodyText: string;
  /** True when the source cell contained markup rather than bare text. */
  sourceWasHtml: boolean;
  commentType: CommentType | null;
  /** Raw source value of the Category column, preserved even if unrecognised. */
  severityRaw: string | null;
  severity: Severity | null;
  answerType: AnswerType | null;
  answerTypeRaw: string | null;
  options: string[];
  unitOptions: string[];
  recommendation: string | null;
  defaultValue: string | null;
  defaultValue2: string | null;
  defaultUnitType: string | null;
  defaultLocation: string | null;
  estimateMin: string | null;
  estimateMax: string | null;
  /** Spectora's "Order (w/i item)". Item-scoped, and NOT unique. See parse.ts. */
  sourceOrder: number | null;
  /** 1-based source sheet row. The stable tiebreaker that makes ordering safe. */
  sourceRow: number;
  /** Final resolved position within the item, dense and unique. */
  position: number;
  /** Anything from the row we carried but do not model as a column. */
  extra: Record<string, string>;
}

export interface ParsedItem {
  name: string;
  position: number;
  sourceRowFirst: number;
  comments: ParsedComment[];
}

export interface ParsedSection {
  name: string;
  position: number;
  sourceRowFirst: number;
  items: ParsedItem[];
}

export interface ParsedTemplate {
  name: string;
  sections: ParsedSection[];
}

export interface ImportStats {
  sourceRows: number;
  dataRows: number;
  skippedRows: number;
  sections: number;
  items: number;
  comments: number;
  commentsWithHtml: number;
  commentsWithLinks: number;
  commentsWithoutText: number;
  columnsSeen: number;
  columnsImported: number;
  columnsUnsupported: number;
}

export interface ImportReport {
  filename: string;
  bytes: number;
  /** "xlsx" | "xls" | "html" | "csv" — what the bytes actually were. */
  detectedFormat: string;
  /** The extension the file claimed. Kept because they disagree in practice. */
  claimedExtension: string;
  sheetName: string;
  headerRow: number;
  stats: ImportStats;
  coverage: ColumnCoverage[];
  issues: ImportIssue[];
}

export interface ParseResult {
  template: ParsedTemplate;
  report: ImportReport;
}

/** Thrown for failures the user needs to act on, with a human-readable reason. */
export class ImportError extends Error {
  code: string;
  detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.detail = detail;
  }
}
