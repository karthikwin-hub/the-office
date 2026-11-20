import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * Serious and critical accessibility problems known on a screen today, by axe rule, each with why it is not fixed in
 * this change. A new one fails the run; a known one that is gone is reported so it can be taken off this list.
 */
export const KNOWN: Record<string, Record<string, string>> = {
  floor: {
    "label-content-name-mismatch":
      "Each room is a link whose aria-label ('The Accountant. Idle.') replaces the words it shows (its headline figure), so a voice-control user saying what they see does not reach it. The fix is in apps/web/src/screens/Floor.tsx, outside the test stream.",
  },
  boardroom: {
    "aria-prohibited-attr":
      'Observable Plot labels each mark\'s <g> by default (aria-label="rule" on a rule mark) without a role that allows a label. The fix is an ariaLabel or ariaHidden option on the marks in apps/web/src/reports, outside the test stream.',
  },
  routines: {
    "color-contrast":
      "A routine whose agent is not on the team is drawn at 70% opacity (.routine-off in apps/web/src/app/more.css), which takes its text below 4.5:1. The fix is a colour, not opacity, outside the test stream.",
  },
};

/** Checks the screen against WCAG 2.1 A and AA and fails on any serious or critical violation not listed in KNOWN. */
export async function checkA11y(page: Page, screen: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const known = KNOWN[screen] ?? {};
  const fresh = bad.filter((v) => !(v.id in known));
  for (const id of Object.keys(known))
    if (!bad.some((v) => v.id === id))
      test.info().annotations.push({ type: "a11y-fixed", description: `${screen}: ${id} no longer found; remove it from KNOWN` });
  const describe = (v: (typeof bad)[number]) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`;
  // Soft, so one run lists the problems of every screen it passes.
  expect.soft(fresh.map(describe), `serious or critical accessibility problems on ${screen}`).toEqual([]);
}
