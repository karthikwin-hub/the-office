import { SkinId } from "@office/contracts";
import { describe, expect, it } from "vitest";
import { contrast, contrastPairs, mix, SKINS, skinStyle } from "../../ui/src/skins";

describe("office skins", () => {
  it("there is one skin for every skin id, and Blueprint keeps today's palette", () => {
    expect(SKINS.map((s) => s.id).sort()).toEqual([...SkinId.options].sort());
    const blueprint = SKINS.find((s) => s.id === "blueprint")!;
    expect(blueprint.tokens).toMatchObject({ paper: "#f3f5f7", carbon: "#27408b", graphite: "#2a2d31", stampRed: "#b42318", clearedGreen: "#2f6b3f" });
  });

  it("the contrast formula matches WCAG's own examples", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(mix("#000000", 0.5, "#ffffff")).toBe("#808080");
  });

  for (const skin of SKINS)
    it(`${skin.name} keeps every pair readable (WCAG 2.2 AA)`, () => {
      const failing = contrastPairs(skin)
        .map((p) => ({ ...p, ratio: Math.round(contrast(p.fg, p.bg) * 100) / 100 }))
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.name}: ${p.ratio} < ${p.min}`);
      expect(failing).toEqual([]);
    });

  for (const skin of SKINS)
    it(`${skin.name} keeps its texture faint and sets every token`, () => {
      expect(skin.tokens.textureOpacity).toBeLessThanOrEqual(0.04);
      const style = skinStyle(skin);
      expect(Object.values(style).every((v) => v !== "" && v !== "undefined")).toBe(true);
      expect(style["color-scheme"]).toBe(skin.dark ? "dark" : "light");
    });
});
