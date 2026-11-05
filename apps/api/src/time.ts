/** Today's date in India, which is the books' date. */
export const istDate = (now = Date.now()) => new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);

/** "08:45" in India as a daily cron in UTC. */
export function digestCron(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const utc = (((h * 60 + m - 330) % 1440) + 1440) % 1440;
  return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
}
