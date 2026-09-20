import type { ColumnStatus } from "./types";

/**
 * The column contract for a Spectora "Export to spreadsheet -> Export HTML
 * Text" file.
 *
 * Headers are matched on a normalised key rather than an exact string, because
 * the header text carries human annotations that Spectora can reasonably
 * reword between versions -- e.g. 'Category (-1: Low, 0: Med, 1: High)' and
 * 'Answer Type (boolean, checkbox, date, number, range, text)'. Matching the
 * leading words makes the importer survive that churn instead of hard-failing
 * on a cosmetic change.
 */

export interface ColumnSpec {
  /** Stable internal key used throughout the parser. */
  key: string;
  /** Header text as it appears in the observed export. */
  label: string;
  /** Normalised prefixes that identify this column. First match wins. */
  match: string[];
  required?: boolean;
  /** Default disposition when the column exists and has values. */
  status: Extract<ColumnStatus, "imported" | "preserved" | "ignored_by_design">;
  note: string;
}

/** Lowercase, collapse whitespace, drop the parenthetical annotation. */
export function normaliseHeader(raw: string): string {
  return String(raw ?? "")
    .replace(/ /g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

export const COLUMN_SPECS: ColumnSpec[] = [
  {
    key: "sectionName",
    label: "Section Name",
    match: ["section name", "section"],
    required: true,
    status: "imported",
    note: "Becomes a Section. Order follows first appearance in the file.",
  },
  {
    key: "itemName",
    label: "Item Name",
    match: ["item name", "item"],
    required: true,
    status: "imported",
    note: "Becomes an Item under its Section. Order follows first appearance.",
  },
  {
    key: "commentName",
    label: "Comment Name",
    match: ["comment name"],
    required: true,
    status: "imported",
    note: "Becomes a Comment. Editable.",
  },
  {
    key: "commentText",
    label: "Comment Text",
    match: ["comment text"],
    status: "imported",
    note: "Stored as sanitised HTML plus a plain-text projection. Editable.",
  },
  {
    key: "commentType",
    label: "Comment Type (info, limit, defect)",
    match: ["comment type"],
    status: "imported",
    note: "Mapped to info / limit / defect. Unrecognised values are preserved and flagged.",
  },
  {
    key: "category",
    label: "Category (-1: Low, 0: Med, 1: High)",
    match: ["category"],
    status: "imported",
    note: "Severity. -1/0/1 mapped to low/medium/high; raw value kept alongside.",
  },
  {
    key: "options",
    label: "Multiple Choice Options (comma-separated)",
    match: ["multiple choice options", "multiple choice"],
    status: "imported",
    note: "Split on commas, trimmed. Empty entries from trailing commas are dropped and flagged.",
  },
  {
    key: "unitOptions",
    label: "Unit Type Options",
    match: ["unit type options"],
    status: "imported",
    note: "Split on commas. Applies to numeric answers.",
  },
  {
    key: "recommendation",
    label: "Recommendation (from list)",
    match: ["recommendation"],
    status: "imported",
    note: "Preserved verbatim (observed values: pro, monitor).",
  },
  {
    key: "order",
    label: "Order (w/i item)",
    match: ["order w i item", "order"],
    status: "imported",
    note: "Item-scoped sort key. Not unique -- resolved with source row order as tiebreaker.",
  },
  {
    key: "answerType",
    label: "Answer Type",
    match: ["answer type"],
    status: "imported",
    note: "boolean / checkbox / date / number / range / text. Unknown values preserved and flagged.",
  },
  // NOTE: "Default Value 2" must be declared before "Default Value", because
  // resolveColumns matches on longest prefix first and we never want the
  // range upper-bound column to be swallowed by the plain default.
  {
    key: "defaultValue2",
    label: 'Default Value 2 (for "range" types)',
    match: ["default value 2"],
    status: "preserved",
    note: "Upper bound for range answers. Carried across, not yet editable.",
  },
  {
    key: "defaultValue",
    label: "Default Value",
    match: ["default value"],
    status: "preserved",
    note: "Carried across; the editor does not expose it yet.",
  },
  {
    key: "estimateMin",
    label: "Default Estimate Min",
    match: ["default estimate min"],
    status: "preserved",
    note: "Repair-cost estimate floor. Carried across, not yet editable.",
  },
  {
    key: "estimateMax",
    label: "Default Estimate Max",
    match: ["default estimate max"],
    status: "preserved",
    note: "Repair-cost estimate ceiling. Carried across, not yet editable.",
  },
  {
    key: "defaultUnitType",
    label: "Default Unit Type",
    match: ["default unit type"],
    status: "preserved",
    note: "Carried across, not yet editable.",
  },
  {
    key: "defaultLocation",
    label: "Default Location",
    match: ["default location"],
    status: "preserved",
    note: "Carried across, not yet editable.",
  },
  {
    key: "locked",
    label: "Locked",
    match: ["locked"],
    status: "preserved",
    note: "Spectora-side edit lock. Preserved but not enforced by this editor.",
  },
  {
    key: "simpleFormat",
    label: "Simple Format",
    match: ["simple format"],
    status: "preserved",
    note: "Spectora rendering flag. Preserved, no equivalent here yet.",
  },
  {
    key: "disablePhotos",
    label: "Disable Photos",
    match: ["disable photos"],
    status: "preserved",
    note: "Preserved. Photo handling is out of scope for this importer.",
  },
  {
    key: "uses",
    label: "Uses",
    match: ["uses"],
    status: "ignored_by_design",
    note: "Usage counter from the source account, not template content. Deliberately not carried.",
  },
  {
    key: "lastModified",
    label: "Last Modified",
    match: ["last modified"],
    status: "ignored_by_design",
    note: "Timestamp from the source system. Our own audit timestamps replace it.",
  },
];

/** Photo columns are generated, so they are matched by pattern not by list. */
export const PHOTO_PATTERN = /^default photo (\d+)( caption)?$/;

export const PHOTO_NOTE_CAPTION =
  "Photo caption. Photo import is not supported: we store no binary assets, and the export carries only Spectora-hosted URLs that would break once the account lapses.";
export const PHOTO_NOTE_URL =
  "Photo URL pointing at Spectora-hosted media. Not imported -- see NOTES.md; mirroring the asset is deliberately out of scope for this build.";
