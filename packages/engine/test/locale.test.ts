import { INDIA, officeDate, readLocale } from "@office/contracts";
import { describe, expect, it } from "vitest";

describe("the office's locale", () => {
  it("reads a stored locale, and falls back to India for anything unsupported", () => {
    expect(readLocale({ country: "IN", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata" })).toEqual(INDIA);
    expect(readLocale({ country: "GB", currency: "GBP", locale: "en-GB", timeZone: "Europe/London" })).toEqual(INDIA);
    expect(readLocale(null)).toEqual(INDIA);
  });

  it("dates by the office's clock, not the server's", () => {
    // 20:00 UTC on 4 November is already 5 November in India.
    expect(officeDate(INDIA, Date.UTC(2026, 10, 4, 20, 0))).toBe("2026-11-05");
    expect(officeDate(INDIA, Date.UTC(2026, 10, 4, 18, 0))).toBe("2026-11-04");
  });
});
