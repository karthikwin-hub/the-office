#!/usr/bin/env node
// Builds the handbook: docs/handbook/0*.md into one self-contained HTML file that works offline and can be emailed.
//
//   pnpm docs
//
// Diagrams (SVG) are inlined, screenshots and fonts embedded, so the file makes no outside requests.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Marked } from "marked";

const root = resolve(import.meta.dirname, "../..");
const dir = join(root, "docs/handbook");
const out = join(dir, "the-office-handbook.html");
const fonts = join(root, "packages/ui/node_modules/@fontsource/atkinson-hyperlegible-next/files");
const REPO = "https://github.com/karthikwin-hub/the-office/blob/main";

const files = readdirSync(dir).filter((f) => /^\d\d-.+\.md$/.test(f)).sort();
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
    .replace(/<svg /, `<svg id="${id}" `)
    .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${css.replace(/^\s*\.([\w-]+)\{/gm, `#${id} .$1{`)}</style>`);
  return `<figure class="diagram">${svg}<figcaption>${escape(alt)}</figcaption></figure>`;
}

function embedImage(path, alt) {
  const data = readFileSync(path).toString("base64");
  return `<figure class="shot"><img alt="${escape(alt)}" src="data:image/png;base64,${data}"><figcaption>${escape(alt)}</figcaption></figure>`;
}

const toc = [];
const sections = files.map((file, i) => {
  const n = i + 1;
  const used = new Set();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let id = `s${n}-${slug(text)}`;
        while (used.has(id)) id += "-";
        used.add(id);
        if (depth === 1) {
          toc.push({ n, id, text, children: [] });
          return `<header class="doc-head"><p class="doc-num">Part ${n}</p><h1 id="${id}">${text}</h1></header>`;
        }
        if (depth === 2) toc.at(-1)?.children.push({ id, text });
        return `<h${depth} id="${id}">${text}</h${depth}>`;
      },
      image({ href, text }) {
        const path = resolve(dir, href);
        return extname(path) === ".svg" ? inlineSvg(path, text) : embedImage(path, text);
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const target = /^https?:/.test(href) ? href : `${REPO}/${join("docs/handbook", href).replace(/^(\.\.\/)+/, "")}`;
        return `<a href="${escape(target)}">${text}</a>`;
      },
    },
  });
  const html = marked
    .parse(readFileSync(join(dir, file), "utf8"))
    .replace(/<p>(<figure[\s\S]*?<\/figure>)<\/p>/g, "$1")
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<blockquote>\s*<p><strong>([^<]+?)[.:]?<\/strong>/g, (_, label) => {
      const kind = /one paragraph/i.test(label) ? "summary" : /decision/i.test(label) ? "decision" : "note";
      return `<blockquote class="callout ${kind}"><p><strong class="callout-label">${label}</strong>`;
    })
    .replace(/<strong>(Open[^<]*)<\/strong>/g, '<strong class="open">$1</strong>')
    .replace(/<td>(<strong>)?(Done|Built|Next|Planned|Not started, by design|Preview on the books)(<\/strong>)?<\/td>/g, (_, _b, status) => `<td><span class="tag tag-${slug(status)}">${status}</span></td>`);
  return `<section class="doc" id="part-${n}">${html}</section>`;
});

const font = (file, weight, style = "normal") =>
  `@font-face{font-family:"Atkinson Hyperlegible Next";font-style:${style};font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${readFileSync(join(fonts, file)).toString("base64")}) format("woff2")}`;

const css = [
  font("atkinson-hyperlegible-next-latin-400-normal.woff2", 400),
  font("atkinson-hyperlegible-next-latin-400-italic.woff2", 400, "italic"),
  font("atkinson-hyperlegible-next-latin-600-normal.woff2", 600),
  font("atkinson-hyperlegible-next-latin-700-normal.woff2", 700),
  readFileSync(join(import.meta.dirname, "handbook.css"), "utf8"),
].join("\n");

const nav = toc
  .map((d) => `<li><a class="nav-doc" href="#${d.id}"><span class="nav-num">${d.n}</span>${d.text}</a><ol>${d.children.map((c) => `<li><a href="#${c.id}">${c.text.replace(/^\d+(\.\d+)*\.?\s*/, "")}</a></li>`).join("")}</ol></li>`)
  .join("");

const cover = `<section class="cover" id="top">
  <p class="cover-mark">Agentic Office by Snilld AI</p>
  <h1 class="cover-title">Product and technical handbook</h1>
  <p class="cover-lede">AI agents that keep a small business's books, show their work and change nothing without the owner's approval. India first; built to travel.</p>
  <dl class="cover-meta">
    <div><dt>Version</dt><dd>${escape(version)}</dd></div>
    <div><dt>Date</dt><dd>${escape(today)}</dd></div>
    <div><dt>Live</dt><dd><a href="https://the-office.the-office-agents.workers.dev">the-office.the-office-agents.workers.dev</a></dd></div>
    <div><dt>Demo</dt><dd><a href="https://the-office-mock.the-office-agents.workers.dev">the-office-mock.the-office-agents.workers.dev</a></dd></div>
  </dl>
  <ol class="cover-contents">${toc.map((d) => `<li><a href="#${d.id}"><span class="nav-num">${d.n}</span>${d.text}</a></li>`).join("")}</ol>
  <p class="cover-note">Audience: the team, consultants and partners. Each part opens with a one-paragraph summary; technical detail follows.</p>
</section>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Office: product and technical handbook</title>
<style>${css}</style>
</head>
<body>
<aside class="sidebar" aria-label="Contents">
  <a class="brand" href="#top">Agentic Office <span>Handbook</span></a>
  <nav><ol>${nav}</ol></nav>
  <p class="sidebar-foot">Version ${escape(version)} · ${escape(today)}</p>
</aside>
<main>
${cover}
${sections.join("\n")}
<footer class="foot">Built from <code>docs/handbook</code> with <code>pnpm docs</code>. Version ${escape(version)}.</footer>
</main>
<script>
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
</script>
</body>
</html>
`;

writeFileSync(out, page);
console.log(`Wrote ${out.replace(root + "/", "")} (${Math.round(page.length / 1024)} KB, ${files.length} parts)`);
