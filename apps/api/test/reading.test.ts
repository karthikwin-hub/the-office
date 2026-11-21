import { loadBooks } from "@office/fixtures";
import { describe, expect, it } from "vitest";
import { proposeLayout, TEXT_MODEL } from "../src/reading";

const business = loadBooks().business;
const headers = ["Bill Ref", "Bill Dt", "Supplier", "Basic", "Net"];
const sample = [["P-1", "10-11-2026", "Shakti Cables", "1000", "1180"]];
const guess = { number: "Bill Ref", date: "Bill Dt", party: "Supplier" };

/** A Workers AI binding that answers with `answer` and records what it was asked. */
function fakeAi(answer: unknown) {
  const calls: { model: string; input: { messages: { content: string }[]; response_format: unknown } }[] = [];
  const ai = {
    run: async (model: string, input: never) => {
      calls.push({ model, input });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as Ai;
  return { ai, calls };
}

describe("a model's suggestion for a register's columns", () => {
  it("keeps only real headers not already taken, and never replaces a column found by its name", async () => {
    const { ai, calls } = fakeAi({
      response: { kind: "purchase_bill", mapping: { taxable: "Basic", total: "Net", number: "Net", gstin: "GSTIN (made up)", qty: "1000" } },
    });
    const r = await proposeLayout(ai, { headers, sample, guess }, business);
    expect(r).toEqual({ kind: "purchase_bill", mapping: { ...guess, taxable: "Basic", total: "Net" } });
    expect(calls[0]!.model).toBe(TEXT_MODEL);
    // It is shown the headers and the sample rows, and nothing else from the file.
    expect(calls[0]!.input.messages[1]!.content).toBe(`${JSON.stringify(headers)}\n${JSON.stringify(sample[0])}`);
  });

  it("falls back to the names it found when the model fails or answers nonsense", async () => {
    expect(await proposeLayout(fakeAi(new Error("quota spent")).ai, { headers, sample, guess }, business)).toEqual({ kind: null, mapping: guess });
    // No Workers AI binding at all, as when the Worker runs locally.
    expect(await proposeLayout(undefined as unknown as Ai, { headers, sample, guess }, business)).toEqual({ kind: null, mapping: guess });
    expect(await proposeLayout(fakeAi({ response: "no idea" }).ai, { headers, sample, guess }, business)).toEqual({ kind: null, mapping: guess });
    expect((await proposeLayout(fakeAi({ response: { kind: "refund", mapping: null } }).ai, { headers, sample, guess }, business)).kind).toBeNull();
  });
});
