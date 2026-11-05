import type { TextItem } from "./extract";

/** The slice of a pdf.js document this module needs, so the engine does not depend on pdf.js. */
export type PdfLike = {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
};

type PdfTextItem = { str: string; transform: number[]; width: number };

/** Padding around a glyph run, in points, matching the boxes drawn on generated documents. */
const PAD = 2.5;

/**
 * Text runs with page-fraction boxes, origin top left. Runs in a scanned page are
 * absent, so an empty result means the document needs the vision model.
 */
export async function readTextLayer(pdf: PdfLike, maxPages = 6): Promise<TextItem[]> {
  const out: TextItem[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const { width: W, height: H } = page.getViewport({ scale: 1 });
    const { items } = await page.getTextContent();
    for (const raw of items as PdfTextItem[]) {
      if (typeof raw.str !== "string" || !raw.str.trim() || !raw.transform) continue;
      const [, , c, d, e, f] = raw.transform as [number, number, number, number, number, number];
      const size = Math.hypot(c, d) || 10;
      const top = f + size * 0.82 + PAD;
      const bottom = f - size * 0.25 - PAD;
      const r = (v: number) => Math.round(v * 100000) / 100000;
      out.push({ str: raw.str, page: n, x: r((e - PAD) / W), y: r((H - top) / H), w: r((raw.width + 2 * PAD) / W), h: r((top - bottom) / H) });
    }
  }
  return out;
}
