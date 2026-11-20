import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mockWorkerOnlyInDemo } from "../vite.config";

/** A real Vite build of a page with the same `public/` file, so the check runs where Vite copies it. */
const roots: string[] = [];
async function built(data: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "office-web-build-"));
  roots.push(root);
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "index.html"), '<!doctype html><title>t</title><script type="module">console.log(1)</script>');
  writeFileSync(join(root, "public", "mockServiceWorker.js"), "/* msw */");
  writeFileSync(join(root, "public", "favicon.svg"), "<svg/>");
  if (data === undefined) delete process.env.VITE_DATA;
  else process.env.VITE_DATA = data;
  await build({ root, configFile: false, logLevel: "silent", plugins: [mockWorkerOnlyInDemo()], build: { outDir: "dist" } });
  return join(root, "dist");
}

const before = process.env.VITE_DATA;
afterEach(() => {
  if (before === undefined) delete process.env.VITE_DATA;
  else process.env.VITE_DATA = before;
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("the web build", () => {
  it("leaves MSW's mock service worker out of the live build", async () => {
    for (const data of [undefined, "live"]) {
      const dist = await built(data);
      expect(existsSync(join(dist, "index.html"))).toBe(true);
      expect(existsSync(join(dist, "favicon.svg"))).toBe(true);
      expect(existsSync(join(dist, "mockServiceWorker.js"))).toBe(false);
    }
  });

  it("keeps it in the demo builds, which answer /api in the browser", async () => {
    for (const data of ["mock", "hybrid"]) expect(existsSync(join(await built(data), "mockServiceWorker.js"))).toBe(true);
  });
});
