"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  copyTemplate,
  deleteTemplate,
  saveImport,
  saveReport,
} from "@/lib/repo";
import { parseSpectoraExport } from "@/lib/spectora/parse";
import { ImportError } from "@/lib/spectora/types";
import { htmlToText, sanitizeCommentHtml } from "@/lib/spectora/html";

export interface ActionState {
  ok: boolean;
  message?: string;
  detail?: string;
  templateId?: string;
}

/**
 * Import a Spectora export.
 *
 * A failed import is still recorded, with its error, so "I tried to import
 * this and it did not work" leaves a trace the customer and we can both look
 * at instead of just an alert box that disappears.
 */
export async function importTemplateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const file = formData.get("file");
  const nameOverride = String(formData.get("name") ?? "").trim();

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a Spectora export file to import." };
  }
  if (file.size > 10 * 1024 * 1024) {
    return {
      ok: false,
      message: "That file is larger than 10 MB.",
      detail:
        "Template exports are normally well under 1 MB. If this really is a template export, tell us and we will raise the limit.",
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let parsed;
  try {
    parsed = parseSpectoraExport(bytes, file.name, {
      templateName: nameOverride || undefined,
    });
  } catch (err) {
    if (err instanceof ImportError) {
      // Record the failure against no template, so the run log is complete.
      try {
        await saveReport(
          null,
          {
            filename: file.name,
            bytes: bytes.length,
            detectedFormat: "unknown",
            claimedExtension:
              (file.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase(),
            sheetName: "",
            headerRow: 0,
            stats: {
              sourceRows: 0,
              dataRows: 0,
              skippedRows: 0,
              sections: 0,
              items: 0,
              comments: 0,
              commentsWithHtml: 0,
              commentsWithLinks: 0,
              commentsWithoutText: 0,
              columnsSeen: 0,
              columnsImported: 0,
              columnsUnsupported: 0,
            },
            coverage: [],
            issues: [],
          },
          "failed",
          { code: err.code, message: err.message, detail: err.detail },
        );
      } catch {
        // Logging the failure must never mask the failure itself.
      }
      return { ok: false, message: err.message, detail: err.detail };
    }
    return {
      ok: false,
      message: "Something went wrong reading that file.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let templateId: string;
  try {
    const saved = await saveImport(parsed.template, parsed.report);
    templateId = saved.templateId;
  } catch (err) {
    return {
      ok: false,
      message: "The file was read correctly, but saving it failed.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  revalidatePath("/");
  redirect(`/templates/${templateId}/report`);
}

export async function renameSectionAction(formData: FormData) {
  const id = String(formData.get("id"));
  const templateId = String(formData.get("templateId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const { error } = await db().from("sections").update({ name }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath(`/templates/${templateId}`);
}

export async function renameItemAction(formData: FormData) {
  const id = String(formData.get("id"));
  const templateId = String(formData.get("templateId"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const { error } = await db().from("items").update({ name }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath(`/templates/${templateId}`);
}

/**
 * Save an edited comment.
 *
 * The body is re-sanitised on the way in. The editor is a plain textarea over
 * the HTML source, which is a deliberate limitation: a rich-text editor that
 * silently rewrites markup is exactly how an inspector's careful formatting
 * gets mangled, and building a trustworthy one was not the best use of two
 * days. See NOTES.md.
 */
export async function saveCommentAction(formData: FormData) {
  const id = String(formData.get("id"));
  const templateId = String(formData.get("templateId"));
  const name = String(formData.get("name") ?? "").trim();
  const rawBody = String(formData.get("body_html") ?? "");

  if (!name) throw new Error("A comment needs a name.");

  const { html } = sanitizeCommentHtml(rawBody);
  const { error } = await db()
    .from("comments")
    .update({
      name,
      body_html: html,
      body_text: htmlToText(html),
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath(`/templates/${templateId}`);
}

export async function renameTemplateAction(formData: FormData) {
  const id = String(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const { error } = await db().from("templates").update({ name }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath(`/templates/${id}`);
  revalidatePath("/");
}

export async function copyTemplateAction(formData: FormData) {
  const id = String(formData.get("id"));
  const proposed = String(formData.get("name") ?? "").trim();
  const newId = await copyTemplate(id, proposed || "Copy");
  revalidatePath("/");
  redirect(`/templates/${newId}`);
}

export async function deleteTemplateAction(formData: FormData) {
  const id = String(formData.get("id"));
  await deleteTemplate(id);
  revalidatePath("/");
  redirect("/");
}
