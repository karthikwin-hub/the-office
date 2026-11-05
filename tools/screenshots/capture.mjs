#!/usr/bin/env node
// Screenshots for design review rounds.
//
//   node tools/screenshots/capture.mjs app [baseUrl]        every screen, desktop and phone
//   node tools/screenshots/capture.mjs stories [story ids]   Storybook stories from packages/ui/storybook-static
//   --dir <folder> serves a static build itself; output goes to screenshots/latest/
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const out = join(root, "screenshots/latest");
const args = process.argv.slice(2);
const mode = args.shift() ?? "app";
const dirFlag = args.indexOf("--dir");
const serveDir = dirFlag >= 0 ? resolve(args.splice(dirFlag, 2)[1]) : null;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png" };

/** A static server with SPA fallback, enough for a Vite or Storybook build. */
async function serve(dir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(dir, path);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(dir, "index.html");
    }
    try {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://localhost:${server.address().port}`, close: () => server.close() };
}

/** Every screen of the office. `as` previews the accountant's view. */
export const SCREENS = [
  ["floor", "/"],
  ["room-office-manager", "/rooms/office-manager"],
  ["room-accountant", "/rooms/accountant"],
  ["room-credit-controller", "/rooms/credit-controller"],
  ["room-tax-clerk", "/rooms/tax-clerk"],
  ["room-auditor", "/rooms/auditor"],
  ["room-sales-rep", "/rooms/sales-rep"],
  ["room-quote-desk", "/rooms/quote-desk"],
  ["room-account-manager", "/rooms/account-manager"],
  ["room-marketer", "/rooms/marketer"],
  ["room-market-watcher", "/rooms/market-watcher"],
  ["room-social-media-manager", "/rooms/social-media-manager"],
  ["room-storekeeper", "/rooms/storekeeper"],
  ["room-buyer", "/rooms/buyer"],
  ["room-compliance-officer", "/rooms/compliance-officer"],
  ["room-payroll-clerk", "/rooms/payroll-clerk"],
  ["boardroom-accounts", "/boardroom/accounts"],
  ["boardroom-accounts-ageing", "/boardroom/accounts/ageing"],
  ["boardroom-accounts-gst", "/boardroom/accounts/gst"],
  ["boardroom-accounts-tds", "/boardroom/accounts/tds"],
  ["boardroom-accounts-cash", "/boardroom/accounts/cash"],
  ["boardroom-sales", "/boardroom/sales"],
  ["boardroom-marketing", "/boardroom/marketing"],
  ["boardroom-social", "/boardroom/social"],
  ["boardroom-social-inbox", "/boardroom/social/inbox"],
  ["boardroom-social-posts", "/boardroom/social/posts"],
  ["boardroom-social-calendar", "/boardroom/social/calendar"],
  ["settings-channels", "/settings#channels"],
  ["boardroom-operations", "/boardroom/operations"],
  ["boardroom-people", "/boardroom/people"],
  ["audit", "/audit"],
  ["desk", "/desk"],
  ["hiring", "/hiring"],
  ["settings", "/settings"],
  ["party", "/parties/C13"],
  ["source-figure", "/boardroom/accounts/ageing?figure=ageing%3Aparty%3AC13"],
  ["source-document", "/desk?doc=doc-p0086&region=totals.total"],
  ["ask", "/?ask=open"],
  ["accountant-floor", "/?as=accountant"],
  ["accountant-audit", "/audit?as=accountant"],
  ["accountant-desk", "/desk?as=accountant"],
];

const FULL = process.env.FULL !== "0";
const VIEWPORTS = { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } };

async function main() {
  await mkdir(out, { recursive: true });
  const server = serveDir ? await serve(serveDir) : null;
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
  const shots = [];
  try {
    if (mode === "stories") {
      const base = server?.url ?? args.shift() ?? "http://localhost:6006";
      const index = await (await fetch(`${base}/index.json`)).json();
      const ids = args.length ? args : Object.keys(index.entries).filter((k) => index.entries[k].type === "story");
      const page = await browser.newPage({ viewport: VIEWPORTS.desktop, reducedMotion: "reduce" });
      for (const id of ids) {
        await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`, { waitUntil: "networkidle" });
        await page.waitForTimeout(400);
        const file = join(out, `story-${id}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
      }
    } else {
      const base = server?.url ?? args.shift() ?? "http://localhost:4173";
      const only = args.length ? new Set(args) : null;
      for (const [vp, size] of Object.entries(VIEWPORTS)) {
        const ctx = await browser.newContext({ viewport: size, reducedMotion: "reduce", deviceScaleFactor: vp === "phone" ? 2 : 1 });
        for (const [name, path] of SCREENS) {
          if (only && !only.has(name)) continue;
          const page = await ctx.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
          await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
          await page.waitForSelector("[data-ready]", { timeout: 15000 }).catch(() => errors.push("never became ready"));
          await page.waitForTimeout(500);
          const file = join(out, `${name}-${vp}.png`);
          await page.screenshot({ path: file, fullPage: FULL });
          shots.push(file);
          if (errors.length) console.warn(`${name} (${vp}): ${errors.join(" | ")}`);
          await page.close();
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server?.close();
  }
  console.log(`${shots.length} screenshots in ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
