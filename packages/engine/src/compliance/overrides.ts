/**
 * Government extensions and fee waivers that move a statutory date. Each names its circular so the
 * CA can check it; add a line here when a new one is issued. `dueOn` is the date that now applies.
 */
export type Override = { ruleId: string; period: string; dueOn: string; circular: string; note: string };

export const OVERRIDES: Override[] = [
  {
    ruleId: "aoc4",
    period: "2025-26",
    dueOn: "2026-12-31",
    circular: "MCA General Circular 05/2026",
    note: "Additional fees are waived for financial statements for FY 2025-26 filed by 31 December 2026.",
  },
  {
    ruleId: "mgt7",
    period: "2025-26",
    dueOn: "2027-01-31",
    circular: "MCA General Circular 05/2026",
    note: "Additional fees are waived for annual returns for FY 2025-26 filed by 31 January 2027.",
  },
  {
    ruleId: "csr2",
    period: "2025-26",
    dueOn: "2026-12-31",
    circular: "MCA General Circular 05/2026",
    note: "Filed with AOC-4, so the same waiver applies until 31 December 2026.",
  },
  {
    ruleId: "tax-audit",
    period: "2025-26",
    dueOn: "2026-10-21",
    circular: "CBDT Circular 07/2026",
    note: "The tax audit report for FY 2025-26 was extended from 30 September to 21 October 2026.",
  },
  {
    ruleId: "itr",
    period: "2025-26",
    dueOn: "2026-11-21",
    circular: "CBDT Circular 07/2026",
    note: "The return for FY 2025-26 for companies needing a tax audit was extended from 31 October to 21 November 2026.",
  },
];

export function overrideFor(ruleId: string, period: string): Override | null {
  return OVERRIDES.find((o) => o.ruleId === ruleId && o.period === period) ?? null;
}
