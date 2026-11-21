import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import raw from "../data/office.json";
import { emptyBooks, SAMPLE_SEED, STATES } from "../src/empty";

describe("the light entry for new offices", () => {
  it("keeps the sample's seed and states, so regenerating the sample cannot leave it behind", () => {
    const sample = raw as { seed: number; states: Record<string, string> };
    expect(SAMPLE_SEED).toBe(sample.seed);
    expect(JSON.stringify(STATES)).toBe(JSON.stringify(sample.states));
    expect(emptyBooks({ owner: "Asha", asOf: "2026-11-21" }).states).toEqual(sample.states);
  });

  it("does not import the sample business", () => {
    const src = readFileSync(new URL("../src/empty.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\s/.test(l));
    expect(imports).toEqual(['import { AGENTS, Books, DEFAULT_VOICE } from "@office/contracts";']);
  });
});
