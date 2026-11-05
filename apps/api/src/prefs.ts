import { DEFAULT_PREFS, Prefs, PrefsChange } from "@office/contracts";

type Kv = (k: string, v?: string) => string | null;

/** Each person's skin and floor view, kept in the Office so they follow that person to any machine. */
export function readPrefs(kv: Kv, email: string): Prefs {
  let saved: unknown = {};
  try {
    saved = JSON.parse(kv(prefsKey(email)) ?? "{}");
  } catch {}
  return Prefs.parse({ ...DEFAULT_PREFS, ...(saved && typeof saved === "object" ? saved : {}) });
}

/** Merges a partial change into what that person has saved; anything unrecognised is refused. */
export function savePrefs(kv: Kv, email: string, change: unknown): Prefs | null {
  const body = PrefsChange.safeParse(change);
  if (!body.success) return null;
  const next = { ...readPrefs(kv, email), ...body.data };
  kv(prefsKey(email), JSON.stringify(next));
  return next;
}

const prefsKey = (email: string) => `prefs:${email.trim().toLowerCase()}`;
