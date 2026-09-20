import Link from "next/link";
import { notFound } from "next/navigation";
import { getLatestRun, getTemplateTree } from "@/lib/repo";

export const dynamic = "force-dynamic";

/**
 * The import trust report.
 *
 * The customer problem this answers: an inspection company is moving off
 * Spectora with a template they have tuned for four years. The question they
 * actually have is not "does your editor work" — it is "did all of it arrive,
 * and what did you change?" A green success toast does not answer that. This
 * page does, by showing the arithmetic, every column's disposition, and every
 * judgement call the importer made, with the source row number so they can go
 * and look.
 */

const STATUS_COPY: Record<
  string,
  { label: string; tone: string; blurb: string }
> = {
  imported: {
    label: "Imported",
    tone: "bg-emerald-50 text-emerald-900 border-emerald-200",
    blurb: "Read and stored as structured, editable data.",
  },
  preserved: {
    label: "Preserved",
    tone: "bg-sky-50 text-sky-900 border-sky-200",
    blurb: "Carried across intact, but not yet surfaced in the editor.",
  },
  empty_in_source: {
    label: "Empty in your export",
    tone: "bg-stone-50 text-stone-700 border-stone-200",
    blurb: "We support this, but every row was blank — nothing was lost.",
  },
  ignored_by_design: {
    label: "Not carried, on purpose",
    tone: "bg-amber-50 text-amber-900 border-amber-200",
    blurb: "Belongs to the old system, not to your template content.",
  },
  unsupported: {
    label: "Not supported",
    tone: "bg-red-50 text-red-900 border-red-200",
    blurb: "We do not handle this column. Anything in it did not come across.",
  },
  missing_from_export: {
    label: "Absent from the file",
    tone: "bg-stone-50 text-stone-700 border-stone-200",
    blurb: "We would import this, but your export did not include the column.",
  },
};

const SEVERITY_TONE: Record<string, string> = {
  error: "border-red-200 bg-red-50 text-red-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  notice: "border-stone-200 bg-stone-50 text-stone-700",
};

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-white p-3.5">
      <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-[var(--muted)]">{hint}</div>}
    </div>
  );
}

export default async function ReportPage({
  params,
}: {
  params: { id: string };
}) {
  const [template, latest] = await Promise.all([
    getTemplateTree(params.id),
    getLatestRun(params.id),
  ]);
  if (!template) notFound();

  if (!latest) {
    return (
      <div className="grid gap-4">
        <h1 className="text-lg font-semibold">{template.name}</h1>
        <p className="rounded-lg border border-[var(--line)] bg-white p-6 text-sm text-[var(--muted)]">
          This template has no import record.
          {template.copied_from_name
            ? ` It was created by copying "${template.copied_from_name}", so its import evidence lives with the original.`
            : ""}
        </p>
        <Link
          href={`/templates/${template.id}`}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          Open the editor &rarr;
        </Link>
      </div>
    );
  }

  const { run, issues, coverage } = latest;
  const stats = (run.stats ?? {}) as Record<string, number>;

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const notices = issues.filter((i) => i.severity === "notice");

  const accounted = (stats.comments ?? 0) + (stats.skippedRows ?? 0);
  const balances = accounted === (stats.dataRows ?? 0);

  const grouped = new Map<string, typeof coverage>();
  for (const c of coverage) {
    const list = grouped.get(c.status) ?? [];
    list.push(c);
    grouped.set(c.status, list);
  }
  const order = [
    "imported",
    "preserved",
    "unsupported",
    "ignored_by_design",
    "empty_in_source",
    "missing_from_export",
  ];

  return (
    <div className="grid gap-7">
      <div>
        <Link
          href="/"
          className="text-xs text-[var(--muted)] hover:text-[var(--ink)]"
        >
          &larr; All templates
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">
            Import report — {template.name}
          </h1>
          <Link
            href={`/templates/${template.id}`}
            className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Open the editor
          </Link>
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {run.filename} · {(run.bytes / 1024).toFixed(0)} KB · read as{" "}
          <span className="font-medium text-[var(--ink)]">
            {run.detected_format}
          </span>
          {run.claimed_extension &&
            run.detected_format !== run.claimed_extension && (
              <>
                {" "}
                (the file is named <code>.{run.claimed_extension}</code>, but
                its contents are {run.detected_format} — we go by the contents)
              </>
            )}{" "}
          · sheet &ldquo;{run.sheet_name}&rdquo;, header on row {run.header_row}
        </p>
      </div>

      {/* The headline: does the arithmetic balance? */}
      <div
        className={`rounded-lg border p-4 ${
          balances && errors.length === 0
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-200 bg-amber-50"
        }`}
      >
        <p className="text-sm font-medium">
          {balances && errors.length === 0 ? (
            <>
              Every one of the {stats.dataRows} rows in your export is accounted
              for: {stats.comments} imported as comments
              {(stats.skippedRows ?? 0) > 0
                ? `, ${stats.skippedRows} skipped and listed below`
                : ", none skipped"}
              .
            </>
          ) : (
            <>
              {stats.comments} of {stats.dataRows} rows became comments,{" "}
              {stats.skippedRows} were skipped
              {!balances && " — and the numbers do not balance, which is a bug"}
              . Every one is listed below.
            </>
          )}
        </p>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Sections" value={stats.sections ?? 0} />
        <Stat label="Items" value={stats.items ?? 0} />
        <Stat label="Comments" value={stats.comments ?? 0} />
        <Stat
          label="With rich text"
          value={stats.commentsWithHtml ?? 0}
          hint={`${stats.commentsWithLinks ?? 0} contain links`}
        />
        <Stat
          label="No comment text"
          value={stats.commentsWithoutText ?? 0}
          hint="checkbox / data fields"
        />
        <Stat
          label="Skipped rows"
          value={stats.skippedRows ?? 0}
          hint={stats.skippedRows ? "see below" : "nothing dropped"}
        />
      </div>

      {/* Column-by-column disposition. */}
      <section>
        <h2 className="text-sm font-semibold">
          What happened to every column in your file
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Your export had {stats.columnsSeen} columns. &ldquo;Empty in your
          export&rdquo; and &ldquo;Not supported&rdquo; are different things:
          the first means there was nothing to lose, the second means there was.
        </p>

        <div className="mt-3 grid gap-4">
          {order
            .filter((s) => grouped.has(s))
            .map((status) => {
              const copy = STATUS_COPY[status];
              const rows = grouped.get(status)!;
              return (
                <div key={status}>
                  <div
                    className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium ${copy.tone}`}
                  >
                    {copy.label}
                    <span className="opacity-70">{rows.length}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-[var(--muted)]">
                    {copy.blurb}
                  </p>
                  <ul className="mt-2 grid gap-1.5">
                    {rows.map((c) => (
                      <li
                        key={c.id}
                        className="rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium">{c.column_name}</span>
                          <span className="text-xs tabular-nums text-[var(--muted)]">
                            {c.populated_rows} row
                            {c.populated_rows === 1 ? "" : "s"} with data
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-[var(--muted)]">
                          {c.note}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
        </div>
      </section>

      {/* Every judgement call, with a row number to go and check. */}
      <section>
        <h2 className="text-sm font-semibold">
          Decisions the importer made{" "}
          <span className="font-normal text-[var(--muted)]">
            ({issues.length})
          </span>
        </h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Anything the importer changed, skipped or could not interpret. Row
          numbers match your spreadsheet.
        </p>

        {issues.length === 0 ? (
          <p className="mt-3 rounded-lg border border-[var(--line)] bg-white p-4 text-sm text-[var(--muted)]">
            Nothing needed a judgement call.
          </p>
        ) : (
          <div className="mt-3 grid gap-4">
            {[
              ["error", errors, "Not imported"],
              ["warning", warnings, "Imported with a caveat"],
              ["notice", notices, "Changed, for the record"],
            ].map(([sev, list, heading]) => {
              const items = list as typeof issues;
              if (items.length === 0) return null;
              return (
                <div key={sev as string}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    {heading as string} ({items.length})
                  </h3>
                  <ul className="mt-1.5 grid gap-1.5">
                    {items.map((i) => (
                      <li
                        key={i.id}
                        className={`rounded-md border px-3 py-2 text-sm ${
                          SEVERITY_TONE[i.severity]
                        }`}
                      >
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          {i.source_row && (
                            <span className="font-mono text-xs opacity-70">
                              row {i.source_row}
                            </span>
                          )}
                          <span>{i.message}</span>
                        </div>
                        {i.raw && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs opacity-70">
                              source values
                            </summary>
                            <pre className="mt-1 overflow-x-auto rounded bg-white/70 p-2 text-[11px] leading-relaxed">
                              {JSON.stringify(i.raw, null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
