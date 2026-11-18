// The hub's operator pages (docs/hub.md § A privacy page): GET /privacy, the
// operator's own text from BRIDGE_HUB_PRIVACY_FILE, and GET /terms, from
// BRIDGE_HUB_TERMS_FILE. Each is read again on each request so an edit shows
// at once; with no file, a plain notice: what this software keeps, or that the
// operator has published no terms. Every sign-in page links to both (oauth.ts
// shell).
//
// A Markdown file is rendered here with every character of it escaped:
// headings, paragraphs, lists, quotes, rules, **bold**, *italic*, `code`, and
// links to https, http, mailto or a path on this hub; raw HTML shows as text.
// An .html file is the operator's own page, served whole under a policy that
// runs no script, sends no form and loads nothing but its inline styles and
// images.

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { PRODUCT_NAME } from "../shared/version.js";
import { esc, shell } from "./oauth.js";

/** The largest privacy or terms file the hub serves. */
const MAX_BYTES = 256 * 1024;

/** The operator pages, and what each page says when it has no file or cannot read it. */
export type OperatorPage = "privacy" | "terms";
const PAGES: Record<OperatorPage, { setting: string; title: string; heading: string; what: string }> = {
  privacy: { setting: "BRIDGE_HUB_PRIVACY_FILE", title: "privacy", heading: "Privacy", what: "privacy notice" },
  terms: { setting: "BRIDGE_HUB_TERMS_FILE", title: "terms", heading: "Terms", what: "terms of service" },
};

const HEADERS = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "cache-control": "no-cache" };
const RENDERED_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const OPERATOR_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export interface PrivacyAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const rendered = (page: OperatorPage, status: number, title: string, body: string): PrivacyAnswer => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": RENDERED_CSP, ...HEADERS },
  body: shell(title, body, { wide: true, current: page }),
});

/** An operator page: the operator's file, or the built-in notice; `warn` hears a file that cannot be served. */
export async function operatorPage(page: OperatorPage, file: string | null, warn: (message: string) => void): Promise<PrivacyAnswer> {
  const p = PAGES[page];
  const title = `${PRODUCT_NAME}: ${p.title}`;
  if (!file) return rendered(page, 200, title, page === "privacy" ? BUILT_IN : BUILT_IN_TERMS);
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES / 1024} KB`);
    text = await readFile(file, "utf8");
  } catch (e) {
    warn(`web: cannot serve ${p.setting} (${e instanceof Error ? e.message : String(e)})`);
    return rendered(page, 503, title, `<h1>${p.heading}</h1><p>This hub's ${p.what} cannot be shown right now. Ask whoever runs the hub for it.</p>`);
  }
  if (/^\.html?$/i.test(extname(file))) {
    return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": OPERATOR_HTML_CSP, ...HEADERS }, body: text };
  }
  const heading = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  return rendered(page, 200, heading ? heading.replace(/[*`]/g, "") : title, renderMarkdown(text));
}

/** The page for /privacy. */
export const privacyPage = (file: string | null, warn: (message: string) => void) => operatorPage("privacy", file, warn);

/** A link target the rendered page keeps: the web or mail, or a path on this hub; never a script. */
const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

/** Inline Markdown: `code`, links, **bold** and *italic*, on text escaped first, so nothing in it is HTML. */
function inline(raw: string): string {
  const codes: string[] = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => (SAFE_HREF.test(href) ? `<a href="${href}">${text}</a>` : text));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

/** The Markdown a privacy notice needs, as HTML: blocks by line, inline rules within them. */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[][] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    const kept = quote.filter((q) => q.length);
    if (kept.length) out.push(`<blockquote>${kept.map((q) => `<p>${inline(q.join(" "))}</p>`).join("")}</blockquote>`);
    para = [];
    list = null;
    quote = [];
  };
  for (const line of text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t);
    if (heading) {
      flush();
      const n = heading[1]!.length;
      out.push(`<h${n}>${inline(heading[2]!)}</h${n}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(t);
    if (quoted) {
      if (para.length || list) flush();
      if (!quote.length) quote.push([]);
      if (quoted[1]!.trim()) quote[quote.length - 1]!.push(quoted[1]!.trim());
      else quote.push([]);
      continue;
    }
    const item = /^(?:([-*+])|\d+[.)])\s+(.*)$/.exec(t);
    if (item) {
      const tag = item[1] ? "ul" : "ol";
      if (para.length || quote.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(item[2]!);
      continue;
    }
    // An indented line under a list item continues that item.
    if (list && /^\s/.test(line)) {
      list.items[list.items.length - 1] += ` ${t}`;
      continue;
    }
    if (list || quote.length) flush();
    para.push(t);
  }
  flush();
  return out.join("\n");
}

/**
 * The notice when the operator has set no file: what this software keeps on
 * the server, from its code (hub.ts, oauth.ts, web.ts), and nothing it cannot
 * know, such as who runs the hub or where. docs/hub-privacy-template.md is the
 * long form an operator starts from.
 */
const BUILT_IN = `<h1>Privacy on this hub</h1>
<p>This is a ${PRODUCT_NAME} hub. Whoever runs it has not published a privacy notice here: ask them who they are, where the server is and how they handle your data. This page says what the software itself keeps on the server.</p>
<h2>What it keeps</h2>
<ul>
<li><strong>You, as a person in its table:</strong> a name, when you were added, a SHA-256 hash of your token (never the token), your email when you signed in with Figma or Google or whoever runs the hub set it, and the id Figma or Google uses for your account. Kept until whoever runs the hub removes you.</li>
<li><strong>Apps you signed in:</strong> each app's name and the addresses it returns to, and a hash of its refresh token, which lasts 30 days and is replaced each time it is used. Access tokens are held in memory only, for an hour.</li>
<li><strong>This browser, if you signed in here:</strong> a hash of a cookie that makes the next sign-in one click, for 30 days. <em>Use another account</em> on the sign-in page forgets it.</li>
<li><strong>The Figma plugin, if it signed in through the browser:</strong> a hash of its own credential, which works while you are in the table.</li>
<li><strong>Files:</strong> what the tools write for an app connected by URL, and what you upload, in a folder of your own. Each file is deleted an hour after it was written, and its download link lasts an hour.</li>
<li><strong>Logs:</strong> names from the table, the names of Figma files as they connect, the names of apps, ids, sizes and timings, the network address of a client turned away after too many refused tokens, and the origin of a web page whose connection it refused. Never a token, never an email, and never what is in a design.</li>
</ul>
<h2>What passes through</h2>
<p>Your designs pass through the hub between the Figma plugin and your apps. They are held in memory while a request is answered, and for an app connected by URL while its sessions are open, and are not written to the server's disk, except the files above.</p>
<p>Your AI app sends what its agent reads to that app's model provider, as it does with anything else you share with it.</p>`;

/** The notice at /terms when the operator has set no file: the software cannot say on what terms a hub is run. */
const BUILT_IN_TERMS = `<h1>Terms on this hub</h1>
<p>This is a ${PRODUCT_NAME} hub. Whoever runs it has not published terms of service here: ask them on what terms they offer it.</p>
<p>The ${PRODUCT_NAME} software itself is open source under the MIT License, which comes without warranty of any kind.</p>`;
