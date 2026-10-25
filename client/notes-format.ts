// Parsing for notes.md and other store Markdown, kept free of React so it can be tested directly.

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "item"; depth: number; checked: boolean | null; text: string }
  | { kind: "code"; text: string };

export interface ParsedNotes {
  description: string | null;
  focus: string | null;
  blocks: Block[];
}

export function parseMarkdown(source: string): ParsedNotes {
  let body = source.replace(/\r\n/g, "\n");
  let description: string | null = null;
  let focus: string | null = null;

  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (frontmatter) {
    description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim().replace(/^["']|["']$/g, "") ?? null;
    body = body.slice(frontmatter[0].length);
  }
  const tldr = /^\s*<tldr>([\s\S]*?)<\/tldr>\s*/.exec(body);
  if (tldr) {
    focus = tldr[1].trim() || null;
    body = body.slice(tldr[0].length);
  }

  const blocks: Block[] = [];
  const lines = body.split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (item) {
      flush();
      blocks.push({
        kind: "item",
        depth: Math.floor(item[1].replace(/\t/g, "  ").length / 2),
        checked: item[2] === undefined ? null : item[2] !== " ",
        text: item[3],
      });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Indented continuation of a list item.
    const last = blocks[blocks.length - 1];
    if (!paragraph.length && last?.kind === "item" && /^\s+\S/.test(line)) {
      last.text += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return { description, focus, blocks };
}

export type Segment =
  | { kind: "text"; text: string; bold?: boolean; code?: boolean }
  | { kind: "link"; label: string; href: string }
  | { kind: "path"; path: string; code: boolean };

const INLINE = /\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)|\*\*([^*]+)\*\*|`([^`]+)`/g;

/** A home-relative or absolute local path with at least one segment, e.g. ~/Projects or /etc/hosts. */
const LOCAL_PATH = /^(?:~|\/[\w.@+-]+)(?:\/[\w.@+-]+)*\/?$/;
const PATH_IN_TEXT = /(^|[\s(])((?:~|\/[\w.@+-]+)(?:\/[\w.@+-]+)+\/?)/g;

export function isLocalPath(text: string) {
  return LOCAL_PATH.test(text) && text !== "/" && text.includes("/");
}

/** Splits plain text so local paths in it become their own segments. */
function withPaths(text: string, segments: Segment[]) {
  let last = 0;
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const start = match.index + match[1].length;
    // Trailing sentence punctuation is not part of the path.
    const path = match[2].replace(/[.,;:]+$/, "");
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "path", path, code: false });
    last = start + path.length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
}

export function parseInline(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) withPaths(text.slice(last, match.index), segments);
    if (match[2]) segments.push({ kind: "link", label: match[1], href: match[2] });
    else if (match[3]) segments.push({ kind: "link", label: match[3], href: match[3] });
    else if (match[4]) segments.push({ kind: "text", text: match[4], bold: true });
    else if (match[5] && isLocalPath(match[5])) segments.push({ kind: "path", path: match[5], code: true });
    else if (match[5]) segments.push({ kind: "text", text: match[5], code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) withPaths(text.slice(last), segments);
  return segments;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PR = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

export type LinkTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "pr"; url: string }
  | { kind: "file"; path: string }
  | { kind: "web"; url: string };

/** Agent links are bare Paseo agent ids or paseo://agent/<id>. */
export function classifyLink(href: string, contextDir: string): LinkTarget {
  const agentId = href.replace(/^paseo:\/\/agent\//, "").split("#")[0];
  if (UUID.test(agentId)) return { kind: "agent", agentId };
  const pr = PR.exec(href);
  if (pr) return { kind: "pr", url: pr[0] };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "web", url: href };
  const path = href.startsWith(`${contextDir}/`) ? href.slice(contextDir.length + 1) : href.replace(/^\.\//, "");
  return { kind: "file", path: decodeURIComponent(path) };
}
