import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { marked } from "marked";

/** The legal pages are written in docs/legal and become HTML at build time, so the app serves the same text the lawyer reviewed. */
const LEGAL_FILES = {
  terms: "terms.md",
  privacy: "privacy-notice.md",
  subprocessors: "subprocessors.md",
  "data-processing": "data-processing.md",
  "ai-notice": "customer-notice-template.md",
};

function legalPages(): Plugin {
  const id = "virtual:legal";
  return {
    name: "legal-pages",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const pages = Object.fromEntries(
        Object.entries(LEGAL_FILES).map(([page, file]) => {
          const path = fileURLToPath(new URL(`../../docs/legal/${file}`, import.meta.url));
          this.addWatchFile(path);
          return [page, marked.parse(readFileSync(path, "utf8"), { async: false })];
        }),
      );
      return `export default ${JSON.stringify(pages)};`;
    },
  };
}

/** The builds whose /api is answered in the browser by MSW (`src/mocks`); every other build talks to the Worker. */
const DEMO_DATA = new Set(["mock", "hybrid"]);

/**
 * `public/mockServiceWorker.js` is MSW's worker, which answers /api/* from made-up data. Only the demo builds
 * (VITE_DATA=mock or hybrid) use it, so the live build leaves it out: a page there could otherwise register it.
 * Vite copies `public/` whole, so the file is removed from the output once the build is written.
 */
export function mockWorkerOnlyInDemo(): Plugin {
  let outDir = "";
  let demo = false;
  return {
    name: "mock-worker-only-in-demo",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      demo = DEMO_DATA.has(String(config.env.VITE_DATA ?? ""));
    },
    closeBundle() {
      if (!demo) rmSync(join(outDir, "mockServiceWorker.js"), { force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), legalPages(), mockWorkerOnlyInDemo()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
