import { AGENT_BY_ID, type PersonaNames } from "@office/contracts";

/** Who an agent is in the Lived-in office. Only the picture uses this; the agent's work does not change. */
export type Persona = {
  agentId: string;
  name: string;
  drink: "tea" | "filter coffee" | "coffee" | "green tea" | "lemon tea";
  /** Month and day, `MM-DD`. Fictional, so the team has something to celebrate. */
  birthday: string;
  /** Picks which of a topic's lines this person tends to say. */
  manner: "warm" | "dry" | "brisk";
};

export const PERSONAS: Record<string, Persona> = Object.fromEntries(
  (
    [
      ["office-manager", "Kavya", "filter coffee", "01-14", "warm"],
      ["customer-service", "Ananya", "lemon tea", "09-02", "warm"],
      ["accountant", "Meera", "tea", "03-21", "dry"],
      ["credit-controller", "Arjun", "coffee", "07-09", "brisk"],
      ["tax-clerk", "Farhan", "tea", "11-27", "dry"],
      ["auditor", "Lakshmi", "filter coffee", "05-30", "dry"],
      ["sales-rep", "Vikram", "coffee", "02-11", "brisk"],
      ["quote-desk", "Neha", "green tea", "08-18", "brisk"],
      ["account-manager", "Rahul", "tea", "12-05", "warm"],
      ["marketer", "Ishita", "coffee", "04-16", "warm"],
      ["market-watcher", "Sameer", "tea", "10-08", "dry"],
      ["social-media-manager", "Tara", "lemon tea", "06-24", "warm"],
      ["storekeeper", "Gopal", "tea", "01-29", "brisk"],
      ["buyer", "Priya", "filter coffee", "09-19", "brisk"],
      ["compliance-officer", "Joseph", "coffee", "03-03", "dry"],
      ["payroll-clerk", "Sunita", "tea", "07-26", "warm"],
    ] as const
  ).map(([agentId, name, drink, birthday, manner]) => [agentId, { agentId, name, drink, birthday, manner }]),
);

const FALLBACK: Omit<Persona, "agentId" | "name"> = { drink: "tea", birthday: "01-01", manner: "dry" };

/** The persona with the owner's name for it, if they gave one. */
export function personaFor(agentId: string, names: PersonaNames = {}): Persona {
  const p = PERSONAS[agentId] ?? { agentId, name: AGENT_BY_ID[agentId]?.short ?? agentId, ...FALLBACK };
  return names[agentId] ? { ...p, name: names[agentId]! } : p;
}

/** "Meera, Accountant": how the Lived-in office labels an agent. */
export function personaLabel(agentId: string, names: PersonaNames = {}): string {
  const role = AGENT_BY_ID[agentId]?.short;
  const name = personaFor(agentId, names).name;
  return role && role !== name ? `${name}, ${role}` : name;
}
