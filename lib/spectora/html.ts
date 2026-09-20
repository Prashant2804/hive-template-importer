import sanitizeHtml from "sanitize-html";

/**
 * Entity handling is the subtlest part of this import, so it gets its own file.
 *
 * The Spectora export escapes entities in the *name* columns: the section that
 * an inspector sees as "Siding, Flashing & Trim" arrives as the literal text
 * "Siding, Flashing &amp; Trim". Those must be decoded or every ampersand in
 * the template renders wrong.
 *
 * The Comment Text column is the opposite. It holds an HTML fragment, and the
 * "&amp;" inside it is *correct HTML* for a literal ampersand. Decoding it
 * there would produce invalid markup and, in the worst case, turn text into
 * tags. So: decode names, never decode comment bodies.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  deg: "°",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  times: "×",
  middot: "·",
  bull: "•",
};

/**
 * Decode HTML entities in a plain-text field. Runs repeatedly because Spectora
 * exports are sometimes double-escaped ("&amp;amp;") depending on how the
 * template was originally authored.
 */
export function decodeEntities(input: string, maxPasses = 3): string {
  let out = input;
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = out.replace(
      /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
      (whole, body: string) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
          const code = parseInt(body.slice(2), 16);
          return Number.isFinite(code) ? safeFromCode(code, whole) : whole;
        }
        if (body.startsWith("#")) {
          const code = parseInt(body.slice(1), 10);
          return Number.isFinite(code) ? safeFromCode(code, whole) : whole;
        }
        const named = NAMED[body.toLowerCase()];
        return named !== undefined ? named : whole;
      },
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

function safeFromCode(code: number, fallback: string): string {
  if (code <= 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** True when the cell looks like markup rather than bare text. */
export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(value);
}

/**
 * Allow-list for comment bodies.
 *
 * The assignment explicitly permits HTML inside individual comment fields, and
 * these templates lean on it: 86 anchor tags of DIY reference links, plus
 * paragraphs and the occasional <strong>. We keep the tags an inspector
 * actually uses and drop anything that could execute. Dropped tags are
 * reported, never silently swallowed.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "ul",
  "ol",
  "li",
  "a",
  "span",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "sub",
  "sup",
];

export interface SanitizeOutcome {
  html: string;
  /** Tag names present in the source that the allow-list removed. */
  removedTags: string[];
  linkCount: number;
}

export function sanitizeCommentHtml(raw: string): SanitizeOutcome {
  const present = new Set<string>();
  for (const m of raw.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) {
    present.add(m[1].toLowerCase());
  }

  const html = sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      span: ["style"],
      div: ["style"],
      p: ["style"],
    },
    // Inspectors' templates link to http:// DIY articles as well as https://.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedStyles: {
      "*": {
        "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
        "font-weight": [/^bold$/, /^\d{3}$/],
        "font-style": [/^italic$/],
        "text-decoration": [/^underline$/, /^line-through$/],
      },
    },
    transformTags: {
      // Any link that opens a new tab gets the security rel, added for us.
      a: (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (out.target === "_blank") out.rel = "noopener noreferrer";
        return { tagName, attribs: out };
      },
    },
  });

  const kept = new Set<string>();
  for (const m of html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) {
    kept.add(m[1].toLowerCase());
  }
  const removedTags = [...present].filter((t) => !kept.has(t)).sort();
  const linkCount = (html.match(/<a\b/gi) || []).length;

  return { html, removedTags, linkCount };
}

/**
 * Plain-text projection of a comment body. Used for search, for the
 * preservation checksum, and for showing a readable preview in the review
 * screen without rendering untrusted-looking markup in a table cell.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "• ");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decodeEntities(stripped)
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

/** Wrap a bare-text comment so every stored body is valid HTML. */
export function textToHtml(text: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) return "";
  return paras
    .map(
      (p) =>
        `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
