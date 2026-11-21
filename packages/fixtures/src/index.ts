/// <reference path="./json.d.ts" />
import raw from "../data/office.json";
import { Books } from "@office/contracts";

/**
 * The seeded sample business (Kaveri Electricals), validated against the contracts.
 * Regenerate with `pnpm data`. Each call returns a fresh copy that callers may mutate.
 */
export function loadBooks(): Books {
  return Books.parse(structuredClone(raw));
}

export { sampleRoutineRuns } from "./routines";
export { sampleCustomerService, sampleConversations } from "./customers";

export { emptyBooks, SAMPLE_SEED, SEED_AS_OF, STATES } from "./empty";
