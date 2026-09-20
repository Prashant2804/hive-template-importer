import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { parseSpectoraExport, detectFormat } from "../lib/spectora/parse";
import { ImportError } from "../lib/spectora/types";
import {
  decodeEntities,
  htmlToText,
  sanitizeCommentHtml,
} from "../lib/spectora/html";

const FIXTURE = "fixtures/InterNACHI Residential -2026-09-20.xls";
const bytes = readFileSync(FIXTURE);

function parseFixture() {
  return parseSpectoraExport(bytes, "InterNACHI Residential -2026-09-20.xls");
}

/** Build an in-memory workbook so failure cases do not need checked-in junk. */
function sheetToBuffer(rows: string[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

const HEADERS = [
  "Section Name",
  "Item Name",
  "Comment Name",
  "Comment Text",
  "Comment Type (info, limit, defect)",
  "Category (-1: Low, 0: Med, 1: High)",
  "Order (w/i item)",
  "Answer Type (boolean, checkbox, date, number, range, text)",
];

describe("format detection", () => {
  test("recognises the export as XLSX despite its .xls filename", () => {
    const { report } = parseFixture();
    assert.equal(report.detectedFormat, "xlsx");
    assert.equal(report.claimedExtension, "xls");
  });

  test("detects raw signatures directly", () => {
    assert.equal(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), "xlsx");
    assert.equal(detectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), "xls");
    assert.equal(
      detectFormat(new TextEncoder().encode("<html><table></table></html>")),
      "html",
    );
  });
});

describe("faithful import of the committed template", () => {
  test("imports every data row with nothing silently dropped", () => {
    const { report } = parseFixture();
    assert.equal(report.stats.dataRows, 392);
    assert.equal(report.stats.comments, 392);
    assert.equal(report.stats.skippedRows, 0);
    // The arithmetic the customer actually cares about.
    assert.equal(
      report.stats.comments + report.stats.skippedRows,
      report.stats.dataRows,
    );
  });

  test("builds the expected hierarchy", () => {
    const { template, report } = parseFixture();
    assert.equal(template.sections.length, 13);
    assert.equal(report.stats.sections, 13);
    assert.equal(report.stats.items, 69);
  });

  test("preserves section order as it appeared in the file", () => {
    const { template } = parseFixture();
    assert.equal(template.sections[0].name, "Inspection Details");
    assert.equal(template.sections[1].name, "Exterior");
    assert.equal(template.sections[12].name, "Garage");
    template.sections.forEach((s, i) => assert.equal(s.position, i));
  });
});

describe("entity handling", () => {
  test("decodes entities in names", () => {
    const { template } = parseFixture();
    const exterior = template.sections.find((s) => s.name === "Exterior")!;
    const names = exterior.items.map((i) => i.name);
    assert.ok(names.includes("Siding, Flashing & Trim"));
    assert.ok(!names.some((n) => n.includes("&amp;")));
  });

  test("does NOT decode entities inside comment HTML bodies", () => {
    // In the body, &amp; is correct HTML for a literal ampersand. Decoding it
    // would emit a bare & into markup. This is the asymmetry that makes the
    // two columns need different treatment.
    const { template } = parseFixture();
    const bodies = template.sections
      .flatMap((s) => s.items)
      .flatMap((i) => i.comments)
      .map((c) => c.bodyHtml);
    const withAmp = bodies.filter((b) => b.includes("&amp;"));
    assert.ok(withAmp.length > 0, "expected escaped ampersands to survive");
    // ...and the plain-text projection should show the decoded character.
    const decodedText = htmlToText(withAmp[0]);
    assert.ok(decodedText.includes("&"));
    assert.ok(!decodedText.includes("&amp;"));
  });

  test("decodeEntities unwinds double escaping", () => {
    assert.equal(decodeEntities("A &amp;amp; B"), "A & B");
    assert.equal(decodeEntities("5 &lt; 10"), "5 < 10");
    assert.equal(decodeEntities("&#8212;"), "—");
  });
});

describe("ordering", () => {
  test("Order values collide in the real file, so sorting needs a tiebreaker", () => {
    const { template } = parseFixture();
    let collidingItems = 0;
    for (const s of template.sections) {
      for (const it of s.items) {
        const orders = it.comments.map((c) => c.sourceOrder);
        if (new Set(orders).size !== orders.length) collidingItems++;
      }
    }
    assert.ok(
      collidingItems > 0,
      "fixture should exercise the tie case; if this fails the guard below is untested",
    );
  });

  test("positions are dense and unique within every item", () => {
    const { template } = parseFixture();
    for (const s of template.sections) {
      for (const it of s.items) {
        const positions = it.comments.map((c) => c.position);
        assert.deepEqual(
          positions,
          positions.map((_, i) => i),
          `positions not dense in ${s.name} / ${it.name}`,
        );
      }
    }
  });

  test("ties are broken by source row, never arbitrarily", () => {
    const { template } = parseFixture();
    for (const s of template.sections) {
      for (const it of s.items) {
        for (let i = 1; i < it.comments.length; i++) {
          const prev = it.comments[i - 1];
          const cur = it.comments[i];
          if (prev.sourceOrder === cur.sourceOrder) {
            assert.ok(
              prev.sourceRow < cur.sourceRow,
              `tie at ${s.name}/${it.name} not resolved by file order`,
            );
          }
        }
      }
    }
  });

  test("import is deterministic across runs", () => {
    const a = parseFixture().template;
    const b = parseFixture().template;
    assert.deepEqual(
      a.sections.map((s) => s.items.map((i) => i.comments.map((c) => c.name))),
      b.sections.map((s) => s.items.map((i) => i.comments.map((c) => c.name))),
    );
  });
});

describe("preservation guarantees", () => {
  test("every comment name in the source survives into the tree", () => {
    const wb = XLSX.read(bytes, { type: "array", raw: false });
    const grid = XLSX.utils.sheet_to_json<string[]>(
      wb.Sheets[wb.SheetNames[0]],
      { header: 1, defval: "", raw: false },
    );
    const sourceNames = grid
      .slice(1)
      .map((r) => decodeEntities(String(r[2] ?? "")).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .sort();

    const { template } = parseFixture();
    const importedNames = template.sections
      .flatMap((s) => s.items)
      .flatMap((i) => i.comments)
      .map((c) => c.name)
      .sort();

    assert.deepEqual(importedNames, sourceNames);
  });

  test("a genuine duplicate is kept, not silently deduplicated", () => {
    const { template, report } = parseFixture();
    const fireplace = template.sections.find((s) => s.name === "Fireplace")!;
    const damper = fireplace.items.find((i) => i.name === "Damper Doors")!;
    const inoperable = damper.comments.filter(
      (c) => c.name === "Damper Inoperable",
    );
    assert.equal(inoperable.length, 2, "both copies should be imported");
    assert.ok(
      report.issues.some((i) => i.code === "DUPLICATE_COMMENT"),
      "and the duplicate should be reported",
    );
  });

  test("links and their targets are preserved", () => {
    const { template, report } = parseFixture();
    const withLinks = template.sections
      .flatMap((s) => s.items)
      .flatMap((i) => i.comments)
      .filter((c) => c.bodyHtml.includes("<a "));
    assert.ok(withLinks.length > 0);
    assert.equal(report.stats.commentsWithLinks, withLinks.length);
    // http:// links must survive; several DIY references are not https.
    const allHtml = withLinks.map((c) => c.bodyHtml).join("");
    assert.ok(allHtml.includes('href="http://'));
    assert.ok(allHtml.includes('rel="noopener noreferrer"'));
  });

  test("comments legitimately without text are counted, not treated as errors", () => {
    const { report } = parseFixture();
    assert.equal(report.stats.commentsWithoutText, 83);
    assert.ok(!report.issues.some((i) => i.code === "EMPTY_COMMENT_TEXT"));
  });
});

describe("coverage reporting", () => {
  test("distinguishes empty-in-source from unsupported", () => {
    const { report } = parseFixture();
    const byCol = new Map(report.coverage.map((c) => [c.column, c]));
    // Photo columns exist in the sheet but are blank in this export.
    const photo = [...byCol.values()].find((c) => c.column.startsWith("Default Photo 1-"))!;
    assert.equal(photo.status, "empty_in_source");
    assert.equal(photo.populatedRows, 0);
    // Uses is populated but deliberately not carried.
    assert.equal(byCol.get("Uses")!.status, "ignored_by_design");
    assert.ok(byCol.get("Uses")!.populatedRows > 0);
  });

  test("every non-empty column header is accounted for", () => {
    const { report } = parseFixture();
    // 42 columns collapse to 22 named + 2 photo buckets in the report.
    assert.equal(report.stats.columnsSeen, 42);
    assert.ok(report.coverage.length > 0);
    assert.ok(report.coverage.every((c) => c.note.length > 0));
  });
});

describe("sanitisation", () => {
  test("strips scripts and event handlers but keeps the prose", () => {
    const out = sanitizeCommentHtml(
      '<p>Keep this<script>alert(1)</script> and <b onclick="x()">that</b></p>',
    );
    assert.ok(!out.html.includes("script"));
    assert.ok(!out.html.includes("onclick"));
    assert.ok(out.html.includes("Keep this"));
    assert.ok(out.html.includes("that"));
    assert.ok(out.removedTags.includes("script"));
  });

  test("reports removed tags so nothing vanishes quietly", () => {
    const out = sanitizeCommentHtml("<p>ok</p><iframe src='x'></iframe>");
    assert.ok(out.removedTags.includes("iframe"));
  });

  test("bare text is wrapped into paragraphs rather than left as a fragment", () => {
    const { template } = parseFixture();
    const plain = template.sections
      .flatMap((s) => s.items)
      .flatMap((i) => i.comments)
      .find((c) => !c.sourceWasHtml && c.bodyHtml);
    assert.ok(plain, "fixture has plain-text comments");
    assert.ok(plain!.bodyHtml.startsWith("<p>"));
  });
});

describe("failure cases", () => {
  test("rejects a file that is not a spreadsheet at all", () => {
    const junk = new TextEncoder().encode("\x00\x01\x02not a spreadsheet\xff");
    assert.throws(
      () => parseSpectoraExport(junk, "notes.bin"),
      (e: unknown) =>
        e instanceof ImportError && e.code === "UNRECOGNISED_FILE",
    );
  });

  test("rejects a spreadsheet with no recognisable header row", () => {
    const buf = sheetToBuffer([
      ["Address", "Client", "Date"],
      ["12 Elm St", "J. Doe", "2026-01-01"],
    ]);
    assert.throws(
      () => parseSpectoraExport(buf, "report.xlsx"),
      (e: unknown) =>
        e instanceof ImportError && e.code === "HEADER_NOT_FOUND",
    );
  });

  test("rejects an export missing a required column, naming it", () => {
    const buf = sheetToBuffer([
      ["Section Name", "Comment Name", "Comment Text"],
      ["Roof", "Missing shingle", "text"],
    ]);
    try {
      parseSpectoraExport(buf, "partial.xlsx");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ImportError);
      assert.equal(e.code, "MISSING_REQUIRED_COLUMNS");
      assert.ok(e.message.includes("Item Name"));
    }
  });

  test("a row missing its Item Name is skipped and reported, not guessed at", () => {
    const buf = sheetToBuffer([
      HEADERS,
      ["Roof", "Coverings", "Cracked tile", "text", "defect", "0", "0", "boolean"],
      ["Roof", "", "Orphan comment", "text", "defect", "0", "1", "boolean"],
    ]);
    const { report, template } = parseSpectoraExport(buf, "partial.xlsx");
    assert.equal(report.stats.comments, 1);
    assert.equal(report.stats.skippedRows, 1);
    const issue = report.issues.find((i) => i.code === "INCOMPLETE_HIERARCHY")!;
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(issue.sourceRow, 3);
    assert.equal(template.sections[0].items.length, 1);
  });

  test("an unknown column containing data is flagged loudly", () => {
    const buf = sheetToBuffer([
      [...HEADERS, "Inspector Mood"],
      ["Roof", "Coverings", "Cracked tile", "t", "defect", "0", "0", "boolean", "cheerful"],
    ]);
    const { report } = parseSpectoraExport(buf, "extra.xlsx");
    const cov = report.coverage.find((c) => c.column === "Inspector Mood")!;
    assert.equal(cov.status, "unsupported");
    assert.equal(cov.populatedRows, 1);
    assert.ok(
      report.issues.some((i) => i.code === "UNSUPPORTED_COLUMN_WITH_DATA"),
    );
  });

  test("unknown enum values are preserved rather than dropped", () => {
    const buf = sheetToBuffer([
      HEADERS,
      ["Roof", "Coverings", "Odd one", "t", "hazard", "7", "0", "signature"],
    ]);
    const { report, template } = parseSpectoraExport(buf, "enums.xlsx");
    const c = template.sections[0].items[0].comments[0];
    assert.equal(c.commentType, null);
    assert.equal(c.answerType, null);
    assert.equal(c.answerTypeRaw, "signature");
    assert.equal(c.severityRaw, "7");
    const codes = report.issues.map((i) => i.code);
    assert.ok(codes.includes("UNKNOWN_COMMENT_TYPE"));
    assert.ok(codes.includes("UNKNOWN_ANSWER_TYPE"));
    assert.ok(codes.includes("UNKNOWN_CATEGORY"));
  });

  test("tolerates reworded header annotations", () => {
    const buf = sheetToBuffer([
      [
        "Section Name",
        "Item Name",
        "Comment Name",
        "Comment Text",
        "Comment Type (informational, limitation, defect)",
        "Category (severity)",
        "Order (within item)",
        "Answer Type (yes/no etc)",
      ],
      ["Roof", "Coverings", "Cracked tile", "t", "defect", "0", "0", "boolean"],
    ]);
    const { report } = parseSpectoraExport(buf, "reworded.xlsx");
    assert.equal(report.stats.comments, 1);
    assert.equal(report.stats.columnsUnsupported, 0);
  });
});
