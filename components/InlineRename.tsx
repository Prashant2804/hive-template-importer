"use client";

import { useState } from "react";

/**
 * Click-to-rename for section and item headings.
 *
 * Kept deliberately small: a text input, Enter to save, Escape to cancel. The
 * server action does the write, so this holds no state the database does not
 * already own.
 */
export default function InlineRename({
  id,
  templateId,
  name,
  action,
  className = "",
  label,
}: {
  id: string;
  templateId: string;
  name: string;
  action: (formData: FormData) => Promise<void>;
  className?: string;
  label: string;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`Rename ${label}`}
        className={`group text-left ${className}`}
      >
        {name}
        <span className="ml-1.5 text-xs font-normal text-[var(--muted)] opacity-0 transition group-hover:opacity-100">
          rename
        </span>
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        await action(fd);
        setEditing(false);
      }}
      className="flex items-center gap-1.5"
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="templateId" value={templateId} />
      <input
        name="name"
        defaultValue={name}
        autoFocus
        required
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
        className="rounded border border-[var(--line)] px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-white"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="rounded border border-[var(--line)] px-2 py-1 text-xs"
      >
        Cancel
      </button>
    </form>
  );
}
