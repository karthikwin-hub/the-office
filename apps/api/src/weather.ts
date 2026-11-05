import type { Sky, Weather } from "@office/contracts";

/**
 * Roughly what it is like outside, for the Lived-in office's small talk. Only a
 * location rounded to about ten kilometres leaves us, to MET Norway, whose free
 * forecast may be used commercially with credit and an identifying User-Agent.
 * Any failure is simply no weather.
 */

export const MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const HOUR = 3600;

export type Where = { latitude?: unknown; longitude?: unknown; city?: unknown };
type CacheLike = { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };

/** MET Norway's symbol codes, for example `heavyrainandthunder` or `partlycloudy_day`, as one word. */
export function skyFrom(symbol: string): Sky {
  const s = symbol.toLowerCase();
  if (s.includes("thunder")) return "storm";
  if (s.includes("snow")) return "snow";
  if (s.includes("rain") || s.includes("sleet") || s.includes("drizzle")) return "rain";
  if (s.includes("fog")) return "fog";
  if (s.includes("cloudy")) return "cloudy";
  return "clear";
}

const round = (n: number) => Math.round(n * 10) / 10;

export async function weatherFor(where: Where | undefined, opts: { fetcher: typeof fetch; cache: CacheLike | null; userAgent: string; now?: number }): Promise<Weather | null> {
  const lat = Number(where?.latitude), lon = Number(where?.longitude);
  if (!where || !Number.isFinite(lat) || !Number.isFinite(lon) || where.latitude === undefined || where.longitude === undefined) return null;
  const city = typeof where.city === "string" && where.city.trim() ? where.city.trim().slice(0, 60) : null;
  const url = `${MET_URL}?lat=${round(lat)}&lon=${round(lon)}`;
  const key = new Request(url);
  try {
    let res = await opts.cache?.match(key);
    if (!res) {
      const fresh = await opts.fetcher(url, { headers: { "user-agent": opts.userAgent, accept: "application/json" } });
      if (!fresh.ok) return null;
      const body = await fresh.text();
      res = new Response(body, { headers: { "content-type": "application/json", "cache-control": `max-age=${HOUR}` } });
      await opts.cache?.put(key, res.clone());
    }
    const data = (await res.json()) as { properties?: { timeseries?: { time?: string; data?: { instant?: { details?: { air_temperature?: number } }; next_1_hours?: { summary?: { symbol_code?: string } }; next_6_hours?: { summary?: { symbol_code?: string } } } }[] } };
    const now = opts.now ?? Date.now();
    const series = data.properties?.timeseries ?? [];
    const slot = series.find((s) => s.time && Date.parse(s.time) + HOUR * 1000 > now) ?? series[0];
    const temp = slot?.data?.instant?.details?.air_temperature;
    const symbol = slot?.data?.next_1_hours?.summary?.symbol_code ?? slot?.data?.next_6_hours?.summary?.symbol_code;
    if (typeof temp !== "number" || !symbol) return null;
    return { city, tempC: Math.round(temp), sky: skyFrom(symbol), at: new Date(now).toISOString() };
  } catch {
    return null;
  }
}
