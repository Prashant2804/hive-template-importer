"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { saveCommentAction } from "@/app/actions";
import type { CommentRow } from "@/lib/repo";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

const TYPE_TONE: Record<string, string> = {
  defect: "bg-red-50 text-red-800 border-red-200",
  limit: "bg-amber-50 text-amber-800 border-amber-200",
  info: "bg-sky-50 text-sky-800 border-sky-200",
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export default function CommentEditor({
  comment,
  templateId,
}: {
  comment: CommentRow;
  templateId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li className="border-t border-[var(--line)] first:border-t-0">
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{comment.name}</span>
            {comment.comment_type && (
              <span
                className={`rounded border px-1.5 py-px text-[10px] uppercase tracking-wide ${
                  TYPE_TONE[comment.comment_type] ??
                  "border-stone-200 bg-stone-50 text-stone-700"
                }`}
              >
                {comment.comment_type}
              </span>
            )}
            {comment.severity && (
              <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-px text-[10px] text-stone-600">
                {SEVERITY_LABEL[comment.severity]}
              </span>
            )}
            {comment.answer_type && (
              <span className="rounded border border-stone-200 bg-white px-1.5 py-px text-[10px] text-stone-500">
                {comment.answer_type}
              </span>
            )}
          </div>

          {comment.body_html ? (
            <div
              className="comment-body mt-1 text-sm text-[var(--muted)]"
              // Safe: body_html is sanitised against an allow-list on import
              // and again on every save (see lib/spectora/html.ts).
              dangerouslySetInnerHTML={{ __html: comment.body_html }}
            />
          ) : (
            <p className="mt-1 text-sm italic text-[var(--muted)]">
              No comment text — this is a{" "}
              {comment.answer_type ?? "data"} field.
            </p>
          )}

          {comment.options.length > 0 && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Choices: {comment.options.join(" · ")}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--bg)]"
        >
          {open ? "Cancel" : "Edit"}
        </button>
      </div>

      {open && (
        <form
          action={async (fd) => {
            await saveCommentAction(fd);
            setOpen(false);
          }}
          className="border-t border-dashed border-[var(--line)] bg-[var(--bg)] px-3 py-3"
        >
          <input type="hidden" name="id" value={comment.id} />
          <input type="hidden" name="templateId" value={templateId} />

          <label className="block text-xs font-medium">
            Comment name
            <input
              name="name"
              defaultValue={comment.name}
              required
              className="mt-1 block w-full rounded border border-[var(--line)] p-2 text-sm"
            />
          </label>

          <label className="mt-2 block text-xs font-medium">
            Comment text{" "}
            <span className="font-normal text-[var(--muted)]">
              (HTML — your original markup, exactly as imported)
            </span>
            <textarea
              name="body_html"
              defaultValue={comment.body_html}
              rows={6}
              className="mt-1 block w-full rounded border border-[var(--line)] p-2 font-mono text-xs leading-relaxed"
            />
          </label>

          <p className="mt-1.5 text-[11px] text-[var(--muted)]">
            Paragraphs, bold, italics, lists and links are kept. Scripts and
            unknown tags are removed on save.
          </p>

          <div className="mt-2 flex items-center gap-2">
            <SaveButton />
            {comment.source_row && (
              <span className="text-[11px] text-[var(--muted)]">
                originally row {comment.source_row} of the export
              </span>
            )}
          </div>
        </form>
      )}
    </li>
  );
}
