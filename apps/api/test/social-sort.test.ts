import { loadBooks } from "@office/fixtures";
import { OfficeService } from "@office/engine";
import { describe, expect, it } from "vitest";
import { QuotaError } from "../src/quota";
import { sortInbox } from "../src/social/sort";

const install = {
  id: "ans-install",
  title: "Do you install fans?",
  examples: ["do you install ceiling fans"],
  answer: "Yes. Our electrician fits a ceiling fan for ₹300 within Pune.",
  enabled: true,
};

const inbox = (texts: string[]) => {
  const books = structuredClone(loadBooks());
  books.agents.find((a) => a.agentId === "social-media-manager")!.trustLevel = "trusted";
  const office = new OfficeService(books, { asOf: "2026-11-04" });
  office.books.customerService.answers = [install];
  // Only these messages: the sample's own open messages are not part of this test.
  office.books.socialInbox = [];
  office.receiveMessages(
    texts.map((text, i) => ({
      id: `ig-s${i}`,
      platform: "Instagram",
      channelId: "ch-instagram",
      kind: "comment" as const,
      author: "@meera",
      at: "2026-11-04T10:00:00+05:30",
      rating: null,
      text,
    })),
  );
  return office;
};

const fakeAi = (answer: (user: string, n: number) => unknown) => {
  let n = 0;
  return { run: async (_m: string, input: { messages: { content: string }[] }) => answer(input.messages[1]!.content, n++) } as unknown as Ai;
};

describe("the model sorts the messages the rules were unsure of", () => {
  it("sends the saved answer it picks, and leaves the owner the one it cannot place", async () => {
    const office = inbox(["Could your man fit my new fan this week?", "Is the shop near the bus stand?"]);
    const ai = fakeAi((user) =>
      user.includes("fit my new fan")
        ? { response: JSON.stringify({ intent: "answer", answerId: "ans-install", confidence: 0.8, summary: "Wants a fan fitted" }) }
        : { response: { intent: "other", answerId: null, confidence: 0.4, summary: "Asks where the shop is" } },
    );
    expect(await sortInbox(ai, office)).toEqual({ asked: 2, sorted: 2 });
    const [fit, where] = ["ig-s0", "ig-s1"].map((id) => office.books.socialInbox.find((m) => m.id === id)!);
    expect(fit).toMatchObject({ status: "replied", basis: "saved_answer" });
    expect(where).toMatchObject({ status: "open", toOwner: "none of your saved answers fits" });
  });

  it("stops at the day's allowance, and does nothing without the model", async () => {
    const office = inbox(["Could your man fit my new fan this week?"]);
    expect(
      await sortInbox(
        fakeAi(() => {
          throw new QuotaError("social_ai");
        }),
        office,
      ),
    ).toEqual({ asked: 0, sorted: 0 });
    expect(await sortInbox(null, office)).toEqual({ asked: 0, sorted: 0 });
    expect(office.inboxSortJobs()).toHaveLength(1);
  });
});
