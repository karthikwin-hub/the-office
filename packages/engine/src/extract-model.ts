import type { Region, Totals } from "@office/contracts";
import { z } from "zod";
import { checkExtraction, type ExtractContext, type Extraction, type ExtractedLine, gstinValid, parseAmount, parseDate, type TextItem } from "./extract";
import { pctOf } from "./money";

/**
 * When a layout defeats the rules, a language model reads the text layer and
 * names, for every value, the numbered run it was printed in. A value is only
 * highlighted if that run really contains it; scans read by the vision model
 * have no runs, so nothing is highlighted and the card says so.
 */

const Cited = z.object({ value: z.union([z.string(), z.number()]).nullable(), item: z.number().int().nullable().optional() });
const Money = z.union([z.string(), z.number()]).nullable().optional();

export const ModelInvoice = z.object({
  kind: z.enum(["purchase_bill", "sales_invoice"]).optional(),
  number: Cited,
  date: Cited,
  partyName: Cited,
  partyGstin: Cited,
  lines: z
    .array(
      z.object({
        description: z.string(),
        hsn: z.union([z.string(), z.number()]).nullable().optional(),
        qty: z.union([z.string(), z.number()]).nullable().optional(),
        unit: z.string().nullable().optional(),
        rate: Money,
        taxable: Money,
        gstRate: z.union([z.string(), z.number()]).nullable().optional(),
        tax: Money,
        item: z.number().int().nullable().optional(),
      }),
    )
    .max(60),
  totals: z.object({ taxable: Cited, cgst: Cited.optional(), sgst: Cited.optional(), igst: Cited.optional(), roundOff: Cited.optional(), total: Cited }),
});
export type ModelInvoice = z.infer<typeof ModelInvoice>;

/** JSON schema handed to the model so it answers in exactly this shape. */
export const MODEL_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["purchase_bill", "sales_invoice"] },
    number: { $ref: "#/$defs/cited" },
    date: { $ref: "#/$defs/cited" },
    partyName: { $ref: "#/$defs/cited" },
    partyGstin: { $ref: "#/$defs/cited" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" }, hsn: { type: "string" }, qty: { type: "number" }, unit: { type: "string" }, rate: { type: "string" }, taxable: { type: "string" }, gstRate: { type: "number" }, tax: { type: "string" }, item: { type: "integer" } },
        required: ["description", "taxable"],
      },
    },
    totals: {
      type: "object",
      properties: { taxable: { $ref: "#/$defs/cited" }, cgst: { $ref: "#/$defs/cited" }, sgst: { $ref: "#/$defs/cited" }, igst: { $ref: "#/$defs/cited" }, roundOff: { $ref: "#/$defs/cited" }, total: { $ref: "#/$defs/cited" } },
      required: ["taxable", "total"],
    },
  },
  required: ["number", "date", "partyName", "partyGstin", "lines", "totals"],
  $defs: { cited: { type: "object", properties: { value: { type: ["string", "number", "null"] }, item: { type: ["integer", "null"] } }, required: ["value"] } },
} as const;

export function modelPrompt(items: TextItem[], business: { legalName: string; gstin: string }): { system: string; user: string } {
  const runs = items.slice(0, 600).map((i, n) => `[${n}] p${i.page} (${i.x.toFixed(2)},${i.y.toFixed(2)}) ${i.str}`);
  return {
    system: [
      "You read Indian GST tax invoices and bills for an accounts office. Answer only with JSON in the given schema.",
      `Our business is ${business.legalName}, GSTIN ${business.gstin}. If we are the buyer it is a purchase_bill; if we issued it, a sales_invoice. partyName and partyGstin are the other side.`,
      "Copy values exactly as printed. For each value give `item`, the number in square brackets of the run that contains it. Use null when a value is not printed. Never compute or guess a figure.",
    ].join("\n"),
    user: `Text runs, each with page and position (x, y from the top left, as page fractions):\n${runs.join("\n")}`,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s,₹]|rs\.?/g, "");

export function fromModel(answer: unknown, items: TextItem[], ctx: ExtractContext): Extraction {
  const m = ModelInvoice.parse(answer);
  const regions: Region[] = [];
  let ungrounded = 0;
  /**
   * Accepts a citation only if the cited run really contains the value; an
   * uncited value is looked for on the page (amounts from the bottom, where
   * totals are printed). A value printed nowhere stays ungrounded.
   */
  const cite = (key: string, label: string, c: { value: string | number | null; item?: number | null } | undefined) => {
    if (!c || c.value === null || c.value === "") return;
    const want = norm(String(c.value));
    const asDate = parseDate(String(c.value));
    const has = (i: TextItem) => norm(i.str).includes(want) || (asDate !== null && parseDate(i.str) === asDate);
    const cited = c.item !== null && c.item !== undefined ? items[c.item] : undefined;
    const isAmount = parseAmount(String(c.value)) !== null && !asDate;
    const found = cited && has(cited) ? cited : isAmount ? items.findLast(has) : items.find(has);
    if (found) regions.push({ key, label, page: found.page, box: [found.x, found.y, found.w, found.h] });
    else if (items.length) ungrounded++;
  };
  const str = (c: { value: string | number | null } | undefined) => (c?.value === null || c?.value === undefined ? null : String(c.value).trim());
  const money = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : (parseAmount(typeof v === "number" ? v.toFixed(2) : v) ?? 0));

  const kind = m.kind ?? "purchase_bill";
  const gstin = str(m.partyGstin)?.toUpperCase().replace(/^GSTIN[:\s]*/, "") ?? null;
  const party = (gstin && ctx.parties.find((p) => p.gstin === gstin)) || ctx.parties.find((p) => p.name.toLowerCase() === str(m.partyName)?.toLowerCase()) || null;
  const partyState = gstin?.slice(0, 2) ?? party?.stateCode ?? null;
  const placeOfSupply = kind === "purchase_bill" ? ctx.business.stateCode : (partyState ?? ctx.business.stateCode);
  const intra = (kind === "purchase_bill" ? (partyState ?? ctx.business.stateCode) : placeOfSupply) === ctx.business.stateCode;

  cite("number", kind === "purchase_bill" ? "Bill number" : "Invoice number", m.number);
  cite("date", "Date", m.date);
  cite("party", kind === "purchase_bill" ? "Supplier" : "Customer", m.partyName);
  cite("gstin", kind === "purchase_bill" ? "Supplier GSTIN" : "Customer GSTIN", m.partyGstin);

  const lines: ExtractedLine[] = m.lines.map((l, n) => {
    const taxable = money(l.taxable);
    const gstRate = Number(String(l.gstRate ?? 0).replace("%", "")) || 0;
    const half = pctOf(taxable, gstRate * 50);
    const qty = Math.round(Number(String(l.qty ?? 1).replace(/[^\d.]/g, "")) || 1);
    const sku = ctx.skus.find((s) => s.name.toLowerCase() === l.description.toLowerCase()) ?? null;
    const it = l.item !== null && l.item !== undefined ? items[l.item] : undefined;
    if (it) regions.push({ key: `line.${n}.description`, label: `Line ${n + 1} description`, page: it.page, box: [it.x, it.y, it.w, it.h] });
    return {
      skuId: sku?.id ?? null,
      description: l.description,
      hsn: String(l.hsn ?? sku?.hsn ?? ""),
      qty,
      unit: (l.unit ?? "OTH").toUpperCase().slice(0, 3),
      ratePaise: money(l.rate) || taxable,
      discountPct: 0,
      taxablePaise: taxable,
      gstRate,
      cgstPaise: intra ? half : 0,
      sgstPaise: intra ? half : 0,
      igstPaise: intra ? 0 : pctOf(taxable, gstRate * 100),
      printedTaxPaise: l.tax === null || l.tax === undefined ? (intra ? 2 * half : pctOf(taxable, gstRate * 100)) : money(l.tax),
    };
  });

  const t = m.totals;
  const totals: Totals = { taxablePaise: money(t.taxable.value), cgstPaise: money(t.cgst?.value), sgstPaise: money(t.sgst?.value), igstPaise: money(t.igst?.value), roundOffPaise: money(t.roundOff?.value), totalPaise: money(t.total.value) };
  cite("totals.taxable", "Taxable value", t.taxable);
  cite("totals.cgst", "CGST", t.cgst);
  cite("totals.sgst", "SGST", t.sgst);
  cite("totals.igst", "IGST", t.igst);
  cite("totals.total", "Invoice total", t.total);

  const dateRaw = str(m.date);
  const out: Extraction = {
    kind,
    number: str(m.number),
    date: dateRaw ? parseDate(dateRaw) : null,
    partyName: party?.name ?? str(m.partyName),
    partyGstin: gstin && gstinValid(gstin) ? gstin : gstin,
    partyId: party?.id ?? null,
    placeOfSupply,
    intra,
    lines,
    totals,
    regions,
    checks: [],
    method: "model",
  };
  out.checks = checkExtraction(out, ctx);
  out.checks.push(
    items.length
      ? { key: "grounded", label: "Every figure found on the page", ok: ungrounded === 0, detail: ungrounded ? `${ungrounded} value${ungrounded === 1 ? " was" : "s were"} not where the model said; compare with the page.` : "Each value was matched to the text it came from." }
      : { key: "grounded", label: "Figures can be highlighted", ok: false, detail: "Read from an image by the vision model, so nothing can be highlighted. Compare with the page before approving." },
  );
  return out;
}

/** The rules' reading is good enough unless it missed the number, the lines or a total that adds up. */
export function needsModel(e: Extraction): boolean {
  const failed = new Set(e.checks.filter((c) => !c.ok).map((c) => c.key));
  return !e.number || !e.lines.length || failed.has("total") || failed.has("taxable") || failed.has("lines");
}
