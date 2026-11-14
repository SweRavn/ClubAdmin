// SPDX-License-Identifier: AGPL-3.0-only
// The shared, safe Markdown subset (P2.3, ADR 0053; P2.4 reuses it): text is
// parsed into a small tree that the web and the app render with their own
// elements. No raw HTML ever: everything is text. Supported: paragraphs
// (blank lines separate them, single line breaks are kept), bullet lists
// (`- ` or `* `), numbered lists (`1. `), **strong**, *emphasis* (or
// _emphasis_), links `[text](url)` and bare `https://` addresses. Links are
// only `https:` and `mailto:`; anything else stays text. Email is sent as
// plain text, so the Markdown source reads as it is written.

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; href: string; children: MarkdownInline[] }
  | { type: "break" };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] };

/** Whether a link target is allowed (https or mailto). */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "mailto:" && /^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(trimmed)) return trimmed;
  } catch {
    return null;
  }
  return null;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

/** Parses the inline syntax of one line (or several joined by breaks). */
export function parseInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("\n")) {
      flush();
      out.push({ type: "break" });
      i += 1;
      continue;
    }
    if (rest.startsWith("**")) {
      const end = rest.indexOf("**", 2);
      if (end > 2) {
        flush();
        out.push({ type: "strong", children: parseInline(rest.slice(2, end)) });
        i += end + 2;
        continue;
      }
    }
    const marker = rest[0];
    if ((marker === "*" || marker === "_") && rest[1] !== marker && rest[1] !== " ") {
      const end = rest.indexOf(marker, 1);
      if (end > 1 && rest[end - 1] !== " ") {
        flush();
        out.push({ type: "em", children: parseInline(rest.slice(1, end)) });
        i += end + 1;
        continue;
      }
    }
    if (marker === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        const href = safeHref(link[2]!);
        flush();
        if (href) out.push({ type: "link", href, children: parseInline(link[1]!) });
        else out.push({ type: "text", text: link[1]! });
        i += link[0].length;
        continue;
      }
    }
    if (rest.startsWith("https://") && (i === 0 || /\s|\(/.test(text[i - 1]!))) {
      const bare = /^https:\/\/[^\s<>()]+[^\s<>().,;:!?]/.exec(rest);
      const href = bare ? safeHref(bare[0]) : null;
      if (bare && href) {
        flush();
        out.push({ type: "link", href, children: [{ type: "text", text: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }
    buffer += rest[0];
    i += 1;
  }
  flush();
  return out;
}

/** Parses text into blocks (paragraphs and lists). */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const endParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    }
    paragraph = [];
  };
  const endList = () => {
    if (list) {
      blocks.push({ type: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    }
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (line.trim() === "") {
      endParagraph();
      endList();
    } else if (bullet || numbered) {
      endParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) endList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the list item.
      list.items[list.items.length - 1] += `\n${line.trim()}`;
    } else {
      endList();
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return blocks;
}

/** The text without markup (previews, push never uses it). */
export function markdownToPlain(source: string): string {
  const inline = (nodes: MarkdownInline[]): string =>
    nodes
      .map((n) => (n.type === "text" ? n.text : n.type === "break" ? " " : inline(n.children)))
      .join("");
  return parseMarkdown(source)
    .map((b) =>
      b.type === "paragraph" ? inline(b.children) : b.items.map((i) => inline(i)).join(" · "),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
