import { INDIA, officeDate } from "@office/contracts";

/** Today's date in India, which is the books' date. Moves to `officeDate(office.locale)` once offices outside India exist. */
export const istDate = (now = Date.now()) => officeDate(INDIA, now);

/** "08:45" in India as a daily cron in UTC. */
export function digestCron(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const utc = (((h * 60 + m - 330) % 1440) + 1440) % 1440;
  return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
}
