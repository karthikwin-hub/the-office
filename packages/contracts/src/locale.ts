import { z } from "zod";

/**
 * Where an office's business is, the currency it counts in, how it writes numbers
 * and dates, and its clock. India is the only market today, so each list has one
 * value; new code reads these from the office instead of writing India in.
 */
export const OfficeCountry = z.enum(["IN"]);
export const OfficeCurrency = z.enum(["INR"]);
export const OfficeLanguage = z.enum(["en-IN"]);
export const OfficeTimeZone = z.enum(["Asia/Kolkata"]);

export const OfficeLocale = z.object({ country: OfficeCountry, currency: OfficeCurrency, locale: OfficeLanguage, timeZone: OfficeTimeZone }).strict();
export type OfficeLocale = z.infer<typeof OfficeLocale>;

export const INDIA: OfficeLocale = { country: "IN", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata" };

/** A stored locale, or India's when it is missing or names something we do not support. */
export function readLocale(raw: unknown): OfficeLocale {
  const parsed = OfficeLocale.safeParse(raw);
  return parsed.success ? parsed.data : INDIA;
}

/** Today's date on the office's clock, as YYYY-MM-DD. */
export function officeDate(where: Pick<OfficeLocale, "timeZone">, now: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: where.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
