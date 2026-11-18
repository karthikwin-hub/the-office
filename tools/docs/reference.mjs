#!/usr/bin/env node
// Builds the reference: docs/reference/agentic-office-reference.md into docs/reference/index.html,
// one self-contained page (fonts, diagrams and screenshots embedded) that works offline and can be emailed.
//
//   node tools/docs/reference.mjs        (or: pnpm docs:reference)
//
// Each "# " heading in the Markdown is a part, numbered in the sidebar; "## " headings are its sections.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Marked } from "marked";

const root = resolve(import.meta.dirname, "../..");
const source = join(root, "docs/reference/agentic-office-reference.md");
const dir = dirname(source);
const out = join(dir, "index.html");
const fonts = join(root, "packages/ui/node_modules/@fontsource/atkinson-hyperlegible-next/files");
const REPO = "https://github.com/karthikwin-hub/the-office/blob/main";

const version = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
})();
const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An SVG's own <style> would leak into the page; its selectors are scoped to the diagram. */
function inlineSvg(path, alt) {
  const id = `d-${basename(path, ".svg")}`;
  const svg = readFileSync(path, "utf8")
    .replace(/<\?xml[^>]*>/, "")
    .replace(/<svg /, `<svg id="${id}" role="img" aria-label="${escape(alt)}" `)
    .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${css.replace(/^\s*\.([\w-]+)\{/gm, `#${id} .$1{`)}</style>`);
  return `<figure class="diagram">${svg}<figcaption>${escape(alt)}</figcaption></figure>`;
}
function embedImage(path, alt) {
  const type = extname(path) === ".jpg" || extname(path) === ".jpeg" ? "jpeg" : "png";
  return `<figure class="shot"><img alt="${escape(alt)}" loading="lazy" src="data:image/${type};base64,${readFileSync(path).toString("base64")}"><figcaption>${escape(alt)}</figcaption></figure>`;
}

// Split the document into parts at each top-level heading; anything before the first is a comment.
const text = readFileSync(source, "utf8").replace(/<!--[\s\S]*?-->/g, "");
const parts = text.split(/^(?=# )/m).filter((p) => p.startsWith("# "));

const toc = [];
const sections = parts.map((md, i) => {
  const n = i + 1;
  const used = new Set();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        let id = depth === 1 ? slug(inner) : `${n}-${slug(inner)}`;
        while (used.has(id)) id += "-";
        used.add(id);
        if (depth === 1) {
          toc.push({ n, id, text: inner, children: [] });
          return `<header class="doc-head"><p class="doc-num">Part ${n}</p><h1 id="${id}">${inner}</h1></header>`;
        }
        if (depth === 2) toc.at(-1)?.children.push({ id, text: inner });
        return `<h${depth} id="${id}">${inner}</h${depth}>`;
      },
      image({ href, text: alt }) {
        const path = resolve(dir, href);
        return extname(path) === ".svg" ? inlineSvg(path, alt) : embedImage(path, alt);
      },
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = /^(https?:|mailto:|#)/.test(href) ? href : `${REPO}/${join("docs/reference", href).replace(/^(\.\.\/)+/, "")}`;
        return `<a href="${escape(target)}">${inner}</a>`;
      },
    },
  });
  const html = marked
    .parse(md)
    .replace(/<p>(<figure[\s\S]*?<\/figure>)<\/p>/g, "$1")
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<blockquote>\s*<p><strong>([^<]+?)[.:]?<\/strong>/g, (_, label) => {
      const kind = /one paragraph/i.test(label) ? "summary" : /decision/i.test(label) ? "decision" : "note";
      return `<blockquote class="callout ${kind}"><p><strong class="callout-label">${label}</strong>`;
    });
  return `<section class="doc" id="part-${n}">${html}</section>`;
});

const font = (file, weight, style = "normal") =>
  `@font-face{font-family:"Atkinson Hyperlegible Next";font-style:${style};font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${readFileSync(join(fonts, file)).toString("base64")}) format("woff2")}`;

// The handbook's look, plus what a reference needs: code blocks, a find box, and the parts as cards on the cover.
const extra = `
pre { background: #1f2329; color: #e9edf2; padding: 14px 16px; border-radius: 4px; overflow-x: auto; font-size: 0.84rem; line-height: 1.5; margin: 14px 0 22px; }
pre code { background: none; color: inherit; padding: 0; font-size: inherit; white-space: pre; }
:not(pre) > code { background: var(--paper); border: 1px solid var(--rule-soft); border-radius: 3px; padding: 0 4px; font-size: 0.88em; overflow-wrap: anywhere; }
.doc a, .doc td { overflow-wrap: anywhere; }
.find { margin: 0 0 18px; }
.find label { display: block; font-size: 0.78rem; color: var(--muted); margin-bottom: 4px; }
.find input { width: 100%; padding: 7px 9px; border: 1px solid var(--plan-line); border-radius: 3px; font: inherit; font-size: 0.9rem; background: #fff; color: var(--graphite); }
.find input:focus-visible { outline: 2px solid var(--carbon); outline-offset: 1px; }
.find-none { font-size: 0.82rem; color: var(--muted); margin: 6px 2px 0; }
.sidebar li.is-hidden { display: none; }
mark.hit { background: #fff1b8; color: inherit; border-radius: 2px; }
.cover-parts { list-style: none; padding: 0; margin: 0 0 28px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; max-width: 900px; }
.cover-parts a { display: block; height: 100%; padding: 12px 14px; border: 1px solid var(--plan-line); border-radius: 4px; text-decoration: none; color: var(--graphite); background: #fff; }
.cover-parts a:hover, .cover-parts a:focus-visible { border-color: var(--carbon); }
.cover-parts b { display: block; margin-bottom: 4px; }
.cover-parts span { display: block; font-size: 0.85rem; color: var(--muted); line-height: 1.4; }
.top-link { position: fixed; right: 20px; bottom: 20px; padding: 6px 10px; border: 1px solid var(--plan-line); border-radius: 3px; background: #fff; color: var(--graphite); text-decoration: none; font-size: 0.82rem; }
@media print { .find, .top-link { display: none; } pre { white-space: pre-wrap; } }
`;
const css = [
  font("atkinson-hyperlegible-next-latin-400-normal.woff2", 400),
  font("atkinson-hyperlegible-next-latin-400-italic.woff2", 400, "italic"),
  font("atkinson-hyperlegible-next-latin-600-normal.woff2", 600),
  font("atkinson-hyperlegible-next-latin-700-normal.woff2", 700),
  readFileSync(join(import.meta.dirname, "handbook.css"), "utf8"),
  extra,
].join("\n");

// The first sentence after "In one paragraph" in each part, for its card on the cover.
const blurbs = sections.map((html) => {
  const m = /class="callout-label">In one paragraph<\/strong>\s*([\s\S]*?)<\/p>/.exec(html);
  const plain = (m?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  return plain.split(/(?<=\.)\s/)[0] ?? "";
});

const nav = toc
  .map((d) => `<li data-part="part-${d.n}"><a class="nav-doc" href="#${d.id}"><span class="nav-num">${d.n}</span>${d.text}</a><ol>${d.children.map((c) => `<li data-section="${c.id}"><a href="#${c.id}">${c.text.replace(/^\d+(\.\d+)*\.?\s*/, "")}</a></li>`).join("")}</ol></li>`)
  .join("");

const cover = `<section class="cover" id="top">
  <p class="cover-mark">Agentic Office by Snilld AI</p>
  <h1 class="cover-title">Reference guide</h1>
  <p class="cover-lede">What the product does for a business, how it is built and run, how to use it, and how to support it: one place to look things up.</p>
  <dl class="cover-meta">
    <div><dt>Version</dt><dd>${escape(version)}</dd></div>
    <div><dt>Date</dt><dd>${escape(today)}</dd></div>
    <div><dt>App</dt><dd><a href="https://app.office.snilld.in">app.office.snilld.in</a></dd></div>
    <div><dt>Demo</dt><dd><a href="https://demo.office.snilld.in">demo.office.snilld.in</a></dd></div>
  </dl>
  <ol class="cover-parts">${toc.map((d, i) => `<li><a href="#${d.id}"><b><span class="nav-num">${d.n}</span>${d.text}</b><span>${escape(blurbs[i] ?? "")}</span></a></li>`).join("")}</ol>
  <p class="cover-note">Built from <code>docs/reference/agentic-office-reference.md</code>. Edit the Markdown, then run <code>node tools/docs/reference.mjs</code>.</p>
</section>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Office reference guide</title>
<style>${css}</style>
</head>
<body>
<aside class="sidebar" aria-label="Contents">
  <a class="brand" href="#top">Agentic Office <span>Reference guide</span></a>
  <div class="find">
    <label for="find">Find in this guide</label>
    <input id="find" type="search" placeholder="For example: invitation, deploy, GST" autocomplete="off">
    <p class="find-none" id="find-none" hidden>Nothing matches. Try another word.</p>
  </div>
  <nav><ol>${nav}</ol></nav>
  <p class="sidebar-foot">Version ${escape(version)} · ${escape(today)}</p>
</aside>
<main>
${cover}
${sections.join("\n")}
<footer class="foot">Built from <code>docs/reference/agentic-office-reference.md</code> with <code>node tools/docs/reference.mjs</code>. Version ${escape(version)}, ${escape(today)}.</footer>
</main>
<a class="top-link" href="#top">Back to the top</a>
<script>
  // The sidebar follows the reading position.
  const links = new Map([...document.querySelectorAll(".sidebar a[href^='#']")].map((a) => [a.getAttribute("href").slice(1), a]));
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      document.querySelectorAll(".sidebar a.here").forEach((a) => a.classList.remove("here"));
      const a = links.get(e.target.id);
      a?.classList.add("here");
      a?.scrollIntoView({ block: "nearest" });
    }
  }, { rootMargin: "0px 0px -75% 0px" });
  document.querySelectorAll("h1[id], h2[id]").forEach((h) => seen.observe(h));

  // Find: keeps in the sidebar only the sections whose text mentions every word typed.
  const sectionText = new Map();
  document.querySelectorAll(".doc").forEach((doc) => {
    let current = null, buf = [];
    const flush = () => current && sectionText.set(current, buf.join(" ").toLowerCase());
    for (const el of doc.children) {
      const h = el.matches("h2[id]") ? el : null;
      if (h) { flush(); current = h.id; buf = [h.textContent]; } else if (current) buf.push(el.textContent);
    }
    flush();
  });
  const input = document.getElementById("find"), none = document.getElementById("find-none");
  input.addEventListener("input", () => {
    const words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let any = false;
    document.querySelectorAll(".sidebar li[data-part]").forEach((part) => {
      let partHit = false;
      part.querySelectorAll("li[data-section]").forEach((li) => {
        const hay = sectionText.get(li.dataset.section) ?? "";
        const hit = !words.length || words.every((w) => hay.includes(w));
        li.classList.toggle("is-hidden", !hit);
        partHit ||= hit;
      });
      const title = part.querySelector(".nav-doc").textContent.toLowerCase();
      const show = !words.length || partHit || words.every((w) => title.includes(w));
      part.classList.toggle("is-hidden", !show);
      part.querySelector("ol").style.display = words.length && partHit ? "block" : "";
      any ||= show;
    });
    none.hidden = any;
  });
</script>
</body>
</html>
`;

writeFileSync(out, page);
console.log(`Wrote ${out.replace(root + "/", "")} (${Math.round(page.length / 1024)} KB, ${parts.length} parts)`);
