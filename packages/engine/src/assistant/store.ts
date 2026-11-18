import { type AssistantDoc, emptyAssistantDoc } from "@office/contracts";

/**
 * Where the Executive Assistant keeps each owner's own things: the office's SQLite when live,
 * memory in the demo and the tests. Outside the books, so none of it is in the team log, the
 * backups or what the accountant can read; deleting an owner deletes their record.
 */
export interface AssistantStore {
  load(owner: string): AssistantDoc;
  save(owner: string, doc: AssistantDoc): void;
  remove(owner: string): void;
  owners(): string[];
  /** Office-wide notes, such as Gmail's forwarding confirmation. */
  meta(key: string): string | null;
  setMeta(key: string, value: string | null): void;
}

export const ownerKey = (email: string) => email.trim().toLowerCase();

export class MemoryAssistantStore implements AssistantStore {
  private docs = new Map<string, AssistantDoc>();
  private notes = new Map<string, string>();
  load(owner: string) {
    return structuredClone(this.docs.get(ownerKey(owner)) ?? emptyAssistantDoc());
  }
  save(owner: string, doc: AssistantDoc) {
    this.docs.set(ownerKey(owner), structuredClone(doc));
  }
  remove(owner: string) {
    this.docs.delete(ownerKey(owner));
  }
  owners() {
    return [...this.docs.keys()];
  }
  meta(key: string) {
    return this.notes.get(key) ?? null;
  }
  setMeta(key: string, value: string | null) {
    if (value === null) this.notes.delete(key);
    else this.notes.set(key, value);
  }
}
