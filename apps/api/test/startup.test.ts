import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Worker and Office share one bundle, so whatever a source imports statically is built in every isolate before its first
 * request, and its objects stay on the heap for the garbage collector to walk (docs/adr/0005-workers-free-plan.md).
 */
describe("what every isolate loads", () => {
  it("never imports the 2.3 MB sample business statically: only the office seeding the sample loads it", () => {
    const src = join(import.meta.dirname, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((f) => /^\s*import\s[^;]*?from\s+"@office\/fixtures"/m.test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
