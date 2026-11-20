# 0003. PDF text layers are read in the browser

- **Status:** accepted
- **Date:** 2026-11-05 (`8daa09e`; pdf.js in `apps/web` from the first commit)
- **Deciders:** founders

## Context

Most bills arrive as PDFs with a text layer. Parsing a PDF costs far more CPU than a Worker request allows on the free
plan (0005), and a Worker parser would also be a large attack surface for untrusted files.

## Decision

On upload, the browser opens the PDF with pdf.js and sends its text runs (`items`) with the file. The office reads the
runs with deterministic rules first and asks the text model only when the rules miss (`apps/api/src/reading.ts`,
`readText`). A document without a text layer is rendered to an image and read by the vision model (`readScan`).
Emailed PDFs wait until a member's browser reads them (the `unread` push, `apps/web/src/intake/watch.ts`).

## Consequences

- The Worker never parses a PDF; CPU stays inside the free plan.
- The text runs come from the uploader's browser, so they are as trustworthy as the uploader. The engine recomputes
  every line and tax amount and checks them against the stated totals, and the result is staged for approval with the
  highlighted source region (0004), so a mismatch shows to the person approving.
- Emailed documents are read only after someone opens the app.
