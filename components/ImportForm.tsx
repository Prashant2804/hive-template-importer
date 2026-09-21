"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { importTemplateAction, type ActionState } from "@/app/actions";

const initial: ActionState = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
    >
      {pending ? "Importing…" : "Import template"}
    </button>
  );
}

export default function ImportForm() {
  const [state, formAction] = useActionState(importTemplateAction, initial);

  return (
    <form
      action={formAction}
      className="rounded-lg border border-[var(--line)] bg-white p-5"
    >
      <h2 className="text-sm font-semibold">Import a Spectora template</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        In Spectora, open the template and choose{" "}
        <span className="font-medium text-[var(--ink)]">
          Export to spreadsheet &rarr; Export HTML Text
        </span>
        . Upload the spreadsheet it produces — not the plain-text export.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Export file</span>
            <input
              type="file"
              name="file"
              accept=".xls,.xlsx,.csv,.htm,.html"
              required
              className="block w-full rounded-md border border-[var(--line)] bg-white p-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--accent)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">
              Template name{" "}
              <span className="font-normal text-[var(--muted)]">
                (optional — defaults to the file name)
              </span>
            </span>
            <input
              type="text"
              name="name"
              placeholder="InterNACHI Residential"
              className="block w-full rounded-md border border-[var(--line)] p-2 text-sm"
            />
          </label>
        </div>
        <SubmitButton />
      </div>

      {state.message && !state.ok && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm"
        >
          <p className="font-medium text-red-900">{state.message}</p>
          {state.detail && (
            <p className="mt-1 whitespace-pre-wrap text-red-800">
              {state.detail}
            </p>
          )}
          <p className="mt-2 text-red-800">
            Nothing was imported, so your existing templates are unchanged.
          </p>
        </div>
      )}
    </form>
  );
}
