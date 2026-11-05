import { z } from "zod";
import { AGENT_BY_ID } from "./catalog";
import { type Books, FestivalDate, IsoDate, IsoDateTime } from "./entities";

/**
 * The Lived-in skin draws the team as people. Everything here is for the picture
 * only: no agent reads it, and it changes nothing an agent does.
 */

/** A first name the owner gave an agent; letters (any script) and spaces. */
export const PersonaName = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u, "Use letters and spaces only.");

/** Only the names the owner changed; every other agent keeps its default. */
export const PersonaNames = z.record(z.string(), PersonaName);
export type PersonaNames = z.infer<typeof PersonaNames>;

/** A name per agent id; a missing agent goes back to its default. */
export const PersonaNamesChange = z.object({ names: PersonaNames }).strict();

export const Sky = z.enum(["clear", "cloudy", "rain", "storm", "fog", "snow"]);
export type Sky = z.infer<typeof Sky>;

/** Roughly what it is like outside where the person is looking from. */
export const Weather = z.object({ city: z.string().nullable(), tempC: z.number(), sky: Sky, at: IsoDateTime });
export type Weather = z.infer<typeof Weather>;
export const WeatherView = z.object({ weather: Weather.nullable() });
export type WeatherView = z.infer<typeof WeatherView>;

/** What the office already knows that the team can chat about. */
export const AmbientView = z.object({
  today: IsoDate,
  names: PersonaNames,
  festivals: z.array(FestivalDate),
  hiredOn: z.record(z.string(), IsoDate.nullable()),
});
export type AmbientView = z.infer<typeof AmbientView>;

/** Festivals in the next fortnight, each agent's start date, and the owner's names: read from the books, never written. */
export function ambientFrom(books: Pick<Books, "festivalCalendar" | "agents">, names: PersonaNames, today: string): AmbientView {
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
  return {
    today,
    names,
    festivals: books.festivalCalendar.filter((f) => f.date >= today && f.date <= until),
    hiredOn: Object.fromEntries(books.agents.filter((a) => a.hired).map((a) => [a.agentId, a.hiredOn])),
  };
}

/** Saved names, forgiving anything that no longer fits. */
export function readPersonaNames(raw: string | null): PersonaNames {
  try {
    const parsed = PersonaNames.safeParse(JSON.parse(raw ?? "{}"));
    return parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([id]) => AGENT_BY_ID[id])) : {};
  } catch {
    return {};
  }
}

/** A change from the owner: every name must be for a real agent and look like a name. */
export function checkPersonaNames(body: unknown): { names: PersonaNames } | { error: string } {
  const parsed = PersonaNamesChange.safeParse(body);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message === "Use letters and spaces only." ? "Use letters and spaces only, up to 24." : "Give each name as letters and spaces, up to 24." };
  const unknown = Object.keys(parsed.data.names).find((id) => !AGENT_BY_ID[id]);
  if (unknown) return { error: `There is no agent called ${unknown}.` };
  return { names: parsed.data.names };
}
