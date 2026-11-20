import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Books } from "@office/contracts";

// Written with zod 3 (before the zod 4 upgrade) from the first two records of every list in data/office.json:
// saved.json is a book as the office stores it; legacy-input.json is that book with every key that has a default
// removed, plus a post and a message in the shapes saved before channels existed; legacy-parsed.json is what
// zod 3 made of it. Do not regenerate these: they pin what books saved by earlier versions load as.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/saved-books/${name}.json`, import.meta.url), "utf8"));

describe("books saved by earlier versions", () => {
  it("load unchanged", () => {
    const saved = fixture("saved");
    expect(Books.parse(saved)).toEqual(saved);
  });

  it("fill in defaults and upgrade old posts and messages as they did before", () => {
    expect(Books.parse(fixture("legacy-input"))).toEqual(fixture("legacy-parsed"));
  });
});
