import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { marked } from "marked";

/** The legal pages are written in docs/legal and become HTML at build time, so the app serves the same text the lawyer reviewed. */
const LEGAL_FILES = { terms: "terms.md", privacy: "privacy-notice.md", subprocessors: "subprocessors.md", "data-processing": "data-processing.md", "ai-notice": "customer-notice-template.md" };

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

export default defineConfig({
  plugins: [react(), legalPages()],
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
