import Link from "next/link";
import { isConfigured } from "@/lib/db";
import { listTemplates } from "@/lib/repo";
import ImportForm from "@/components/ImportForm";
import { copyTemplateAction, deleteTemplateAction } from "./actions";

export const dynamic = "force-dynamic";

function Setup() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm">
      <h2 className="font-semibold text-amber-900">Database not configured</h2>
      <p className="mt-1 text-amber-900">
        Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code>, then run{" "}
        <code className="font-mono">supabase/schema.sql</code> against the
        project. Full steps are in <code className="font-mono">README.md</code>.
      </p>
    </div>
  );
}

export default async function Home() {
  if (!isConfigured()) return <Setup />;

  let templates;
  try {
    templates = await listTemplates();
  } catch (err) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm">
        <h2 className="font-semibold text-red-900">
          Could not reach the database
        </h2>
        <p className="mt-1 text-red-800">
          {err instanceof Error ? err.message : String(err)}
        </p>
        <p className="mt-2 text-red-800">
          If the tables do not exist yet, run{" "}
          <code className="font-mono">supabase/schema.sql</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-7">
      <ImportForm />

      <section>
        <h2 className="mb-3 text-sm font-semibold">
          Templates{" "}
          <span className="font-normal text-[var(--muted)]">
            ({templates.length})
          </span>
        </h2>

        {templates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--muted)]">
            No templates yet. Import a Spectora export above to get started.
          </p>
        ) : (
          <ul className="grid gap-2">
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--line)] bg-white p-4"
              >
                <div className="min-w-0">
                  <Link
                    href={`/templates/${t.id}`}
                    className="font-medium hover:text-[var(--accent)]"
                  >
                    {t.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {t.copied_from_name ? (
                      <>Copy of {t.copied_from_name} · </>
                    ) : t.source_filename ? (
                      <>From {t.source_filename} · </>
                    ) : null}
                    Updated {new Date(t.updated_at).toLocaleString()}
                  </p>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <Link
                    href={`/templates/${t.id}/report`}
                    className="rounded border border-[var(--line)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg)]"
                  >
                    Import report
                  </Link>
                  <form action={copyTemplateAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <input
                      type="hidden"
                      name="name"
                      value={`${t.name} (copy)`}
                    />
                    <button
                      type="submit"
                      className="rounded border border-[var(--line)] px-2.5 py-1.5 text-xs hover:bg-[var(--bg)]"
                    >
                      Duplicate
                    </button>
                  </form>
                  <form action={deleteTemplateAction}>
                    <input type="hidden" name="id" value={t.id} />
                    <button
                      type="submit"
                      className="rounded border border-[var(--line)] px-2.5 py-1.5 text-xs text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
