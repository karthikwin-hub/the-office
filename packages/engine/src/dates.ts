const DAY = 86_400_000;

export function toUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / DAY);
}

export function addDays(iso: string, days: number): string {
  return new Date(toUtc(iso) + days * DAY).toISOString().slice(0, 10);
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function monthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function nextMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Indian financial-year quarter id, e.g. FY2026-27-Q2 */
export function quarterOf(iso: string): string {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const fy = m >= 4 ? y : y - 1;
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return `FY${fy}-${String((fy + 1) % 100).padStart(2, "0")}-Q${q}`;
}

export function quarterMonths(quarter: string): string[] {
  const match = /^FY(\d{4})-\d{2}-Q([1-4])$/.exec(quarter);
  if (!match) throw new Error(`Bad quarter ${quarter}`);
  const fy = Number(match[1]);
  const q = Number(match[2]);
  const startMonth = [4, 7, 10, 1][q - 1]!;
  const year = q === 4 ? fy + 1 : fy;
  return [0, 1, 2].map((i) => `${year}-${String(startMonth + i).padStart(2, "0")}`);
}

export function quarterLabel(quarter: string): string {
  const months = quarterMonths(quarter);
  const fmt = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleString("en-IN", { month: "long", timeZone: "UTC" });
  return `${fmt(months[0]!)} to ${fmt(months[2]!)}`;
}

export function monthLabel(period: string, style: "long" | "short" = "long"): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleString("en-IN", { month: style, year: "numeric", timeZone: "UTC" });
}

export function dateLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function weekStart(iso: string): string {
  const d = new Date(toUtc(iso));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(iso, -dow);
}
