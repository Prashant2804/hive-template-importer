import Link from "next/link";
import { notFound } from "next/navigation";
import { getTemplateTree } from "@/lib/repo";
import CommentEditor from "@/components/CommentEditor";
import InlineRename from "@/components/InlineRename";
import {
  copyTemplateAction,
  renameItemAction,
  renameSectionAction,
  renameTemplateAction,
} from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function TemplatePage({
  params,
}: {
  params: { id: string };
}) {
  const template = await getTemplateTree(params.id);
  if (!template) notFound();

  const itemCount = template.sections.reduce((n, s) => n + s.items.length, 0);
  const commentCount = template.sections.reduce(
    (n, s) => n + s.items.reduce((m, i) => m + i.comments.length, 0),
    0,
  );

  return (
    <div className="grid gap-6">
      <div>
        <Link
          href="/"
          className="text-xs text-[var(--muted)] hover:text-[var(--ink)]"
        >
          &larr; All templates
        </Link>

        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <InlineRename
              id={template.id}
              templateId={template.id}
              name={template.name}
              action={renameTemplateAction}
              label="template"
              className="text-lg font-semibold"
            />
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              {template.sections.length} sections · {itemCount} items ·{" "}
              {commentCount} comments
              {template.copied_from_name && (
                <> · copied from {template.copied_from_name}</>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href={`/templates/${template.id}/report`}
              className="rounded border border-[var(--line)] px-3 py-1.5 text-xs hover:bg-white"
            >
              Import report
            </Link>
            <form action={copyTemplateAction}>
              <input type="hidden" name="id" value={template.id} />
              <input
                type="hidden"
                name="name"
                value={`${template.name} (copy)`}
              />
              <button
                type="submit"
                className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                Duplicate this template
              </button>
            </form>
          </div>
        </div>
      </div>

      {template.copied_from_name && (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
          This is an independent copy. Editing it does not touch{" "}
          {template.copied_from_name}.
        </p>
      )}

      <div className="grid gap-5">
        {template.sections.map((section) => (
          <section
            key={section.id}
            className="overflow-hidden rounded-lg border border-[var(--line)] bg-white"
          >
            <header className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg)] px-4 py-2.5">
              <InlineRename
                id={section.id}
                templateId={template.id}
                name={section.name}
                action={renameSectionAction}
                label="section"
                className="text-sm font-semibold"
              />
              <span className="text-xs text-[var(--muted)]">
                {section.items.length} item
                {section.items.length === 1 ? "" : "s"}
              </span>
            </header>

            <div className="divide-y divide-[var(--line)]">
              {section.items.map((item) => (
                <div key={item.id}>
                  <div className="flex items-baseline justify-between gap-3 px-4 py-2">
                    <InlineRename
                      id={item.id}
                      templateId={template.id}
                      name={item.name}
                      action={renameItemAction}
                      label="item"
                      className="text-sm font-medium text-[var(--muted)]"
                    />
                    <span className="text-xs text-[var(--muted)]">
                      {item.comments.length}
                    </span>
                  </div>
                  <ul className="border-t border-dashed border-[var(--line)] bg-white">
                    {item.comments.map((c) => (
                      <CommentEditor
                        key={c.id}
                        comment={c}
                        templateId={template.id}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
