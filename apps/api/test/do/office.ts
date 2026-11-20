import { env, runInDurableObject } from "cloudflare:test";
import { CALLER_HEADER, type Caller, system } from "../../src/caller";
import { CALLER_SEAL_HEADER, sealCaller } from "../../src/caller-seal";
import { ControlPlane } from "../../src/tenancy";

export type Person = { id: string; name: string; email: string };

let n = 0;
/** A person with an account, not yet in any office. */
export async function person(name: string): Promise<Person> {
  const id = `user-${Date.now().toString(36)}-${++n}`;
  const email = `${id}@the-office.test`;
  const at = Date.now();
  await env.DB.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
    .bind(id, name, email, at, at)
    .run();
  return { id, name, email };
}

/** A new office with its owner, as the Worker opens one. */
export async function openOffice(name = `Test office ${++n}`) {
  const owner = await person("Anil");
  const made = await new ControlPlane(env.DB).createOffice({ name, owner: { ...owner, emailVerified: true }, ingestDomain: env.INGEST_DOMAIN });
  if ("error" in made) throw new Error(made.error);
  const stub = env.Office.get(env.Office.idFromName(made.id));
  // The test pool's workerd (vitest 3) predates ctx.id.name, so the office is named the way the SDK reads a PartyServer-era name.
  await runInDurableObject(stub, (_o, state) => state.storage.put(LEGACY_NAME, made.id));
  return { id: made.id, owner, stub };
}

export const LEGACY_NAME = "__ps_name";

export const callerFor = (officeId: string, p: Person, role: Caller["role"] = "owner"): Caller => ({
  userId: p.id,
  name: p.name,
  email: p.email,
  role,
  officeId,
});

/** A request to an office's Durable Object as the Worker sends it: the path within the office and who is asking, sealed. */
export async function asCaller(caller: Caller | null, path: string, init: RequestInit = {}): Promise<Request> {
  const req = new Request(`https://office.internal${path}`, init);
  if (!caller) return req;
  const header = JSON.stringify(caller);
  req.headers.set(CALLER_HEADER, header);
  req.headers.set(CALLER_SEAL_HEADER, await sealCaller(env.BETTER_AUTH_SECRET, header));
  return req;
}

export type Heard = { socket: WebSocket | null; messages: string[]; closed: { code: number; reason: string } | null };

/** What a browser on this upgrade would hear within `ms`: every message, and the close if one came. */
export async function listen(res: Response, ms = 150): Promise<Heard> {
  const heard: Heard = { socket: res.webSocket, messages: [], closed: null };
  const ws = res.webSocket;
  if (!ws) return heard;
  ws.addEventListener("message", (e) => heard.messages.push(String(e.data)));
  ws.addEventListener("close", (e) => void (heard.closed = { code: e.code, reason: e.reason }));
  ws.accept();
  await new Promise((r) => setTimeout(r, ms));
  return heard;
}

/** Waits for more of what an open socket hears. */
export const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

export const asSystem = (officeId: string, path: string, body: unknown = {}) =>
  asCaller(system(officeId), path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
