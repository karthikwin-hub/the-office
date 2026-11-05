import { ambientFrom, checkPersonaNames, readPersonaNames } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it, vi } from "vitest";
import { MET_URL, skyFrom, weatherFor } from "../src/weather";

const NOW = Date.parse("2026-11-05T05:10:00Z");
const met = (symbol: string, temp: number) => ({
  properties: {
    timeseries: [
      { time: "2026-11-05T04:00:00Z", data: { instant: { details: { air_temperature: 99 } }, next_1_hours: { summary: { symbol_code: "clearsky_day" } } } },
      { time: "2026-11-05T05:00:00Z", data: { instant: { details: { air_temperature: temp } }, next_1_hours: { summary: { symbol_code: symbol } } } },
    ],
  },
});
function memoryCache() {
  const m = new Map<string, string>();
  return { m, match: async (r: Request) => (m.has(r.url) ? new Response(m.get(r.url)) : undefined), put: async (r: Request, res: Response) => void m.set(r.url, await res.text()) };
}
const PUNE = { latitude: "18.5204", longitude: "73.8567", city: "Pune" };

describe("the weather for small talk", () => {
  it("asks MET Norway for a rounded location only, names itself, and reads the current hour", async () => {
    const fetcher = vi.fn(async () => Response.json(met("lightrainshowers_day", 24.6)));
    const w = await weatherFor(PUNE, { fetcher: fetcher as unknown as typeof fetch, cache: null, userAgent: "the-office/1.0 (test)", now: NOW });
    expect(w).toEqual({ city: "Pune", tempC: 25, sky: "rain", at: new Date(NOW).toISOString() });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${MET_URL}?lat=18.5&lon=73.9`);
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("the-office");
  });

  it("asks once an hour per place, from the cache after that", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => Response.json(met("cloudy", 21)));
    const opts = { fetcher: fetcher as unknown as typeof fetch, cache, userAgent: "t", now: NOW };
    await weatherFor(PUNE, opts);
    expect((await weatherFor({ ...PUNE, latitude: "18.49" }, opts))?.sky).toBe("cloudy");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("is simply no weather when there is no location, the service fails, or the answer is odd", async () => {
    const fetcher = vi.fn(async () => new Response("down", { status: 503 }));
    const opts = { fetcher: fetcher as unknown as typeof fetch, cache: null, userAgent: "t", now: NOW };
    expect(await weatherFor(undefined, opts)).toBeNull();
    expect(await weatherFor({ city: "Pune" }, opts)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await weatherFor(PUNE, opts)).toBeNull();
    expect(await weatherFor(PUNE, { ...opts, fetcher: (async () => Response.json({ nope: 1 })) as unknown as typeof fetch })).toBeNull();
    expect(await weatherFor(PUNE, { ...opts, fetcher: (async () => { throw new Error("offline"); }) as unknown as typeof fetch })).toBeNull();
  });

  it("reads MET Norway's symbols as one word", () => {
    expect(["heavyrainandthunder", "lightsnow", "rainshowers_night", "fog", "partlycloudy_day", "fair_day", "clearsky_night"].map(skyFrom)).toEqual(["storm", "snow", "rain", "fog", "cloudy", "clear", "clear"]);
  });
});

describe("the team's names and what they chat about", () => {
  it("takes only real agents and names made of letters, in any script", () => {
    expect(checkPersonaNames({ names: { accountant: "Revathi", "tax-clerk": "मोहन लाल" } })).toEqual({ names: { accountant: "Revathi", "tax-clerk": "मोहन लाल" } });
    expect(checkPersonaNames({ names: { accountant: "R2-D2" } })).toHaveProperty("error");
    expect(checkPersonaNames({ names: { accountant: "<b>x</b>" } })).toHaveProperty("error");
    expect(checkPersonaNames({ names: { accountant: "A".repeat(25) } })).toHaveProperty("error");
    expect(checkPersonaNames({ names: { robot: "Ravi" } })).toEqual({ error: "There is no agent called robot." });
    expect(checkPersonaNames({ names: {}, extra: 1 })).toHaveProperty("error");
    expect(readPersonaNames('{"accountant":"Revathi","gone":"X"}')).toEqual({ accountant: "Revathi" });
    expect(readPersonaNames("not json")).toEqual({});
  });

  it("reads festivals in the next fortnight and when each hired agent started, without changing the books", () => {
    const books = loadBooks();
    const before = JSON.stringify(books);
    const a = ambientFrom(books, { accountant: "Revathi" }, "2026-11-01");
    expect(JSON.stringify(books)).toBe(before);
    for (const f of a.festivals) expect(f.date >= "2026-11-01" && f.date <= "2026-11-15").toBe(true);
    expect(Object.keys(a.hiredOn).sort()).toEqual(books.agents.filter((x) => x.hired).map((x) => x.agentId).sort());
    expect(a.names).toEqual({ accountant: "Revathi" });
  });
});
