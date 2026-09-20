/**
 * Seed the database with the committed Spectora export.
 *
 * The assignment asks that the live app open with a template already imported,
 * so a reviewer has something to explore immediately. This runs the exact same
 * parser and persistence path as the upload form — there is no separate
 * "seed" code path that could drift from the real one.
 *
 *   npx tsx scripts/seed.ts
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseSpectoraExport } from "../lib/spectora/parse";
import { saveImport } from "../lib/repo";
import { ImportError } from "../lib/spectora/types";

const DEFAULT_FIXTURE = "fixtures/InterNACHI Residential -2026-09-20.xls";

async function main() {
  const path = process.argv[2] ?? DEFAULT_FIXTURE;

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "Missing Supabase credentials.\n" +
        "Run with them in the environment, e.g.:\n" +
        "  set -a && source .env.local && set +a && npx tsx scripts/seed.ts",
    );
    process.exit(1);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    console.error(`Could not read ${path}`);
    process.exit(1);
  }

  console.log(`Parsing ${path} (${(bytes.length / 1024).toFixed(0)} KB)…`);

  let parsed;
  try {
    parsed = parseSpectoraExport(bytes, basename(path));
  } catch (err) {
    if (err instanceof ImportError) {
      console.error(`Import failed [${err.code}]: ${err.message}`);
      if (err.detail) console.error(err.detail);
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  const { template, report } = parsed;
  console.log(
    `  ${report.stats.sections} sections, ${report.stats.items} items, ` +
      `${report.stats.comments} comments, ${report.stats.skippedRows} skipped`,
  );
  console.log(`  ${report.issues.length} decisions recorded`);

  const { templateId } = await saveImport(template, report);
  console.log(`\nSeeded. Open /templates/${templateId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
