/**
 * Seed the database with the committed Spectora export.
 *
 * The assignment asks that the live app open with a template already imported,
 * so a reviewer has something to explore immediately. This runs the exact same
 * parser and persistence path as the upload form — there is no separate
 * "seed" code path that could drift from the real one.
 *
 *   npm run seed
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseSpectoraExport } from "../lib/spectora/parse";
import { saveImport } from "../lib/repo";
import { ImportError } from "../lib/spectora/types";

const DEFAULT_FIXTURE = "fixtures/InterNACHI Residential -2026-09-20.xls";

/**
 * Load .env.local into process.env.
 *
 * Next.js does this automatically for `next dev` and `next build`, but a plain
 * tsx script does not -- so without this the script sees no credentials even
 * though the file is sitting right there, which is a confusing way to fail.
 * Existing environment variables win, so CI and one-off overrides still work.
 */
function loadEnvFile(path = ".env.local"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

async function main() {
  const path = process.argv[2] ?? DEFAULT_FIXTURE;

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "Missing Supabase credentials.\n" +
        "Create .env.local with NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY (see .env.example), then re-run `npm run seed`.",
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
