# 0010. Reading any file: convert, recognise, map

- **Status:** proposed (bills and invoices in a sheet are the first part built)
- **Date:** 2026-11-21
- **Deciders:** founders

## Context

Offices send bills and invoices in layouts we have never seen, and spreadsheets of several kinds: marketplace sales
reports, bills or invoices listed one per row or one line per row, and Tally or ledger exports. Each office has its
own layouts. Until now a PDF or a photo was read as one bill (ADR 0003), and a spreadsheet only as a marketplace sales
report. Every figure must link to where it came from (`AGENTS.md`), amounts are computed by the engine and never by a
model, and the books may not leave Cloudflare or the office's own Durable Object except to Workers AI.

Converting every file to Markdown first (for example with microsoft/markitdown) was proposed. markitdown is a Python
package: it cannot run in a Worker, and a separate service would carry the books outside the tenancy checks. Markdown
also drops page positions and cell addresses, so a figure read from it could not be highlighted where it was printed.

## Decision

Every file goes through three steps.

1. **Convert** to a neutral source that keeps locations: text runs with their page and position for a PDF (the
   browser's text layer, as today), or sheets as rows of cells (`readSheets`, `packages/engine/src/sales/sheets.ts`).
   Formats we cannot open ourselves (`.xls`, `.ods`, `.docx`) will go through Workers AI `toMarkdown` in the Durable
   Object, and their tables will be read back into rows. Markdown is used only to show a file to a model, never as
   the record.
2. **Recognise** what the file is. Known layouts are matched by rules first. A sheet in a layout the office has not
   seen is matched by header names (`packages/engine/src/registers.ts`), and a model may only propose which column
   holds which field from the header row and a few sample rows: it never copies figures.
3. **Map to the canonical records the books already use.** A bill or invoice becomes an `Extraction`, which goes
   through the same `checkExtraction` and `stageExtraction` as a PDF bill. Sales stay `SalesLine`s; parties, items
   and balances go through the onboarding import.

A new sheet layout always asks the owner once, on a `sheet_layout` Desk card (in `ALWAYS_ASK`). The confirmed
columns are kept per office (`sheet_layout` in the office's SQLite, by `layoutKey` of the headers), so the next file
in the same layout is read without asking. Every bill or invoice read from it is still a staged item with its checks,
and each figure links to the cell it was read from (`Document.sheet`, `Region.cell`).

## Consequences

- One AI call at most per new layout, whatever the number of rows, and no figures written by a model.
- Owners confirm each new layout once; until then nothing from that file is read.
- Every spreadsheet path (sales, bills, onboarding) shares one layout memory and one card, so a layout cannot be read
  as two things.
- `toMarkdown`'s handling of tables is not documented and must be checked on real files before old `.xls` is read
  this way; images are never sent to it, so it spends no Workers AI allowance.
- Tally's XML export and ledger exports are later steps and are not covered yet.
