import { z } from "zod";
import { IsoDate } from "./entities";

/** The three templates a new office fills in to bring its existing books. */
export const ImportKind = z.enum(["parties", "products", "open-items"]);
export type ImportKind = z.infer<typeof ImportKind>;

export const IMPORT_FILES: Record<ImportKind, { label: string; template: string }> = {
  parties: { label: "Customers and suppliers", template: "/templates/parties.csv" },
  products: { label: "Products and stock", template: "/templates/products.csv" },
  "open-items": { label: "Unpaid invoices and bills", template: "/templates/open-items.csv" },
};

/** Up to this many data rows in one file; the whole import must also fit in one Desk card. */
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_BYTES = 1_000_000;

export const ImportFile = z
  .object({
    kind: ImportKind,
    name: z.string().trim().min(1).max(120),
    csv: z.string().max(IMPORT_MAX_BYTES, "Files up to 1 MB, please. Split a bigger one in two."),
    /** Where the host stored the file, so each brought-forward item links back to it. */
    file: z.string().max(200).nullable().optional(),
  })
  .strict();
export type ImportFile = z.infer<typeof ImportFile>;

export const ImportCheck = z
  .object({
    booksFrom: IsoDate,
    files: z.array(ImportFile).min(1).max(3),
  })
  .strict()
  .refine((v) => new Set(v.files.map((f) => f.kind)).size === v.files.length, "Send each kind of file once.");
export type ImportCheck = z.infer<typeof ImportCheck>;

/** `file` is null and `row` 0 for a problem with the import as a whole, such as the start date. */
export const ImportIssue = z.object({ file: ImportKind.nullable(), row: z.number().int(), column: z.string(), message: z.string() });
export type ImportIssue = z.infer<typeof ImportIssue>;

export const ImportPreview = z.object({
  booksFrom: IsoDate,
  /** The books already have a start date, so this import must use it. */
  booksFromFixed: z.boolean(),
  files: z.array(z.object({ kind: ImportKind, name: z.string(), rows: z.number().int() })),
  counts: z.object({
    customers: z.number().int(),
    suppliers: z.number().int(),
    products: z.number().int(),
    stock: z.number().int(),
    invoices: z.number().int(),
    bills: z.number().int(),
    receivablePaise: z.number().int(),
    payablePaise: z.number().int(),
  }),
  issues: z.array(ImportIssue),
  /** No issues, and something to bring in. */
  ready: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;
