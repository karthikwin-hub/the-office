import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Books } from "@office/contracts";

// Written with zod 3 (before the zod 4 upgrade) from the first two records of every list in data/office.json:
// saved.json is a book as the office stores it; legacy-input.json is that book with every key that has a default
// removed, plus a post and a message in the shapes saved before channels existed; legacy-parsed.json is what
// zod 3 made of it. Do not regenerate these: they pin what books saved by earlier versions load as.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/saved-books/${name}.json`, import.meta.url), "utf8"));

type Loose = Record<string, unknown>;

/**
 * Keys added after the fixtures were written, with the value a book saved before them gets on load. Each new
 * defaulted key adds itself here; the fixtures stay as written, so everything else must still load exactly.
 */
function withLaterDefaults(book: unknown): unknown {
  const b = structuredClone(book) as Loose;
  for (const p of (b.posts as Loose[] | undefined) ?? []) {
    p.source ??= "agent";
    p.approvedBy ??= null;
    p.noticeAt ??= null;
    for (const v of (p.variants as Loose[] | undefined) ?? []) v.takenDownAt ??= null;
  }
  const voice = b.brandVoice as Loose | undefined;
  if (voice) for (const [k, v] of Object.entries({ audience: "", colours: [], imageStyle: "", logoMediaId: null, competitors: [] })) voice[k] ??= v;
  return b;
}

describe("books saved by earlier versions", () => {
  it("load unchanged", () => {
    const saved = fixture("saved");
    expect(Books.parse(saved)).toEqual(withLaterDefaults(saved));
  });

  it("fill in defaults and upgrade old posts and messages as they did before", () => {
    expect(Books.parse(fixture("legacy-input"))).toEqual(withLaterDefaults(fixture("legacy-parsed")));
  });
});
