import { loadBooks } from "@office/fixtures";
import { OfficeService } from "@office/engine";
import { describe, expect, it } from "vitest";
import { QuotaError } from "../src/quota";
import { writeWithAi } from "../src/social/write";

const month = () => {
  const office = new OfficeService(structuredClone(loadBooks()), { asOf: "2026-11-04" });
  const calendarId = (office.draftCalendar("2027-01").payload as { calendarId: string }).calendarId;
  return { office, calendarId };
};

/** A stand-in for Workers AI that answers each prompt with what `answer` returns for it. */
const fakeAi = (answer: (system: string, user: string, n: number) => unknown) => {
  let n = 0;
  return {
    run: async (_model: string, input: { messages: { content: string }[] }) => answer(input.messages[0]!.content, input.messages[1]!.content, n++),
  } as unknown as Ai;
};

describe("the model writes a month's captions", () => {
  it("keeps captions whose figures come from the facts, and the template for the rest", async () => {
    const { office, calendarId } = month();
    const total = office.aiDraftJobs(calendarId).length;
    const ai = fakeAi((_s, user, n) => {
      if (n === 1) throw new Error("model down");
      const price = /\[(price:[^\]]+)\] [^:]+: (₹[\d,]+)/.exec(user);
      if (n === 2) return { response: JSON.stringify({ text: "Now only ₹1, today only.", factIds: [] }) };
      return {
        response: { text: price ? `In stock at the counter, ${price[2]}.` : "Drop in and ask us anything about wiring.", factIds: price ? [price[1]] : [] },
      };
    });
    const r = await writeWithAi(ai, office, calendarId);
    expect(r.tried).toBe(total);
    expect(r.written).toBeGreaterThan(0);
    expect(r.written).toBeLessThanOrEqual(total - 2);
    expect(office.books.staged.find((s) => s.id === "chg-cal-2027-01")!.summary).toContain(`Written with AI: ${r.written} of ${total}`);
    const texts = office.books.posts.filter((p) => p.calendarId === calendarId).flatMap((p) => p.variants.map((v) => v.text));
    expect(texts.some((t) => t.includes("₹1,"))).toBe(false);
    expect(texts.some((t) => t.includes("Now only ₹1"))).toBe(false);
  });

  it("stops at the day's allowance and leaves the rest to templates", async () => {
    const { office, calendarId } = month();
    const ai = fakeAi((_s, _u, n) => {
      if (n >= 3) throw new QuotaError("social_ai");
      return { response: { text: "Drop in and ask us anything about wiring.", factIds: [] } };
    });
    const r = await writeWithAi(ai, office, calendarId);
    expect(r.tried).toBe(3);
  });

  it("does nothing without the model", async () => {
    const { office, calendarId } = month();
    expect(await writeWithAi(null, office, calendarId)).toEqual({ written: 0, tried: 0 });
  });
});
