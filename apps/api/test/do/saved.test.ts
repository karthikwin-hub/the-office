import { Books, ROUTES } from "@office/contracts";
import { type EditLog, type OfficeService, verifyChain } from "@office/engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SqlCsStore } from "../../src/customer/store";
import { docKey, fileUrl } from "../../src/keys";
import type { Office } from "../../src/office-agent";
import type { SqlRoutineLog } from "../../src/routines";
import { ControlPlane } from "../../src/tenancy";
import { asCaller, callerFor, LEGACY_NAME, person } from "./office";
import beforeCustomerService from "./saved/before-customer-service.json";
import beforeEditLog from "./saved/before-edit-log.json";
import beforeTenancy from "./saved/before-tenancy.json";
import beforeTwoFactor from "./saved/before-two-factor.json";

// Each fixture is an office's storage as an earlier version of the Office left it, written by that version's own code
// (saved/generate.mjs). A change to what the Office stores (a table, an office_kv key, a book's shape, a schema step)
// adds a fixture here for the version before it; do not regenerate the committed ones.

type Fixture = {
  commit: string;
  office: string;
  owner: { name: string; email: string };
  tables: Record<string, { create: string; also: string[]; rows: Record<string, unknown>[] }>;
  r2: Record<string, { body: string; contentType: string; customMetadata?: Record<string, string> }>;
};
type Inside = {
  office: OfficeService;
  edits: EditLog & { all(): ReturnType<EditLog["list"]> };
  conversations: SqlCsStore;
  runs: SqlRoutineLog;
  kv(k: string): string | null;
};
const inside = (o: Office) => o as unknown as Inside;

const SAVED_PHONE = "919845012345";
let phones = 0;

/** Opens an office whose Durable Object holds what `saved` holds, under a fresh office id and owner. */
async function seeded(saved: Fixture) {
  const owner = await person(saved.owner.name);
  const made = await new ControlPlane(env.DB).createOffice({
    name: "Saved Books Traders",
    owner: { ...owner, emailVerified: true },
    ingestDomain: env.INGEST_DOMAIN,
  });
  if ("error" in made) throw new Error(made.error);
  // Phone numbers are unique across offices (wa_link), and the tests share one database.
  const phone = `9198${String(++phones).padStart(8, "0")}`;
  const text = JSON.stringify(saved).replaceAll(saved.office, made.id).replaceAll(saved.owner.email, owner.email).replaceAll(SAVED_PHONE, phone);
  const fixture = JSON.parse(text) as Fixture;
  const doId = env.Office.idFromName(made.id);
  await runInDurableObject(env.Office.get(doId), async (_o, state) => {
    // Nothing of today's code may be in the storage before the old version's: not the SDK's tables, nor its own versions.
    await state.storage.deleteAll();
    await state.storage.put(LEGACY_NAME, made.id);
    const sql = state.storage.sql;
    for (const [name, t] of Object.entries(fixture.tables)) {
      sql.exec(t.create);
      for (const s of t.also) sql.exec(s);
      for (const row of t.rows) {
        const cols = Object.keys(row);
        sql.exec(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
      }
    }
  });
  // Today's Office then wakes on that storage as a deployed one would: a new instance, constructor and all.
  await runInDurableObject(env.Office.get(doId), (_o, state) => state.abort("the old version stops")).catch(() => {});
  const stub = env.Office.get(doId);
  for (const [key, o] of Object.entries(fixture.r2))
    await env.DOCS.put(key, o.body, { httpMetadata: { contentType: o.contentType }, customMetadata: o.customMetadata });
  return { id: made.id, owner, stub, fixture, phone };
}

/** The books as the fixture stored them, read the way BooksStore reads them today. */
function storedBooks(f: Fixture): Books {
  const raw: Record<string, unknown> = {};
  for (const r of f.tables.book_rows!.rows as { coll: string; id: string; json: string }[]) {
    if (r.id === "_") raw[r.coll] = JSON.parse(r.json);
    else ((raw[r.coll] ??= []) as unknown[]).push(JSON.parse(r.json));
  }
  return Books.parse(raw);
}

const ids = (books: Books) =>
  Object.fromEntries(Object.entries(books).flatMap(([k, v]) => (Array.isArray(v) ? [[k, v.map((x) => (x as { id?: string }).id ?? null)]] : [])));

const SAVED: [string, Fixture][] = [
  ["before tenancy (one office, files under docs/, WhatsApp links in the office)", beforeTenancy as Fixture],
  ["before customer service and routine history", beforeCustomerService as Fixture],
  ["before the edit log", beforeEditLog as Fixture],
  ["before two-step sign-in and agents SDK 0.33 (the last live version before the security fixes)", beforeTwoFactor as Fixture],
];

describe.each(SAVED)("an office saved %s", (_what, saved) => {
  it("opens with its books, settings, files and history, and takes a write", async () => {
    const { id, owner, stub, fixture } = await seeded(saved);
    const me = callerFor(id, owner);
    const before = storedBooks(fixture);

    const res = await stub.fetch(await asCaller(me, ROUTES.settings));
    expect(res.status).toBe(200);
    const settings = (await res.json()) as { digestTime: string; reminderPolicy: { firstAfterDays: number }; business: { phone: string } };
    expect(settings.digestTime).toBe("07:30");
    expect(settings.reminderPolicy.firstAfterDays).toBe(4);
    expect(settings.business.phone).toBe("+91 80 4000 1234");

    const prefs = await stub.fetch(await asCaller(me, ROUTES.prefs));
    expect(await prefs.json()).toEqual({ skin: "loft", wholeFloor: true });

    const editsBefore = (fixture.tables.book_edits?.rows ?? []) as { seq: number; hash: string }[];
    await runInDurableObject(stub, async (o) => {
      const books = inside(o).office.books;
      // Everything saved is still there, in its order; opening may add what is due today (a reorder, a log line).
      const now = ids(books);
      for (const [coll, saved] of Object.entries(ids(before))) expect(now[coll]?.slice(0, saved.length), coll).toEqual(saved);
      // The change the owner approved then is still approved, and what waited still waits.
      expect(before.staged.some((s) => s.status === "approved")).toBe(true);
      for (const s of before.staged) expect(books.staged.find((x) => x.id === s.id)?.status, s.id).toBe(s.status);
      expect(inside(o).kv("schema_version")).toBe("2");
      expect(inside(o).kv("office:id")).toBe(id);
      // Every document's file is under this office, wherever that version kept it.
      for (const d of books.documents.slice(0, 2)) expect(d.file).toBe(fileUrl(id, d.id));
      const log = inside(o).edits.all();
      expect(log.slice(0, editsBefore.length).map((e) => [e.seq, e.hash])).toEqual(editsBefore.map((e) => [e.seq, e.hash]));
      expect(verifyChain(log)).toBe(true);
      // The morning digest stays scheduled once, at the time the owner chose (07:30 IST is 02:00 UTC).
      const daily = o.getSchedules({ type: "cron" }).filter((s) => s.callback === "daily");
      expect(daily.map((s) => (s.type === "cron" ? s.cron : null))).toEqual(["0 2 * * *"]);
    });

    // Files moved under the office's prefix, with their type and metadata, and the old keys are gone.
    for (const [key, o] of Object.entries(fixture.r2)) {
      const at = key.startsWith("o/") ? key : docKey(id, key.slice("docs/".length));
      const obj = await env.DOCS.get(at);
      expect(await obj?.text(), at).toBe(o.body);
      expect(obj?.httpMetadata?.contentType).toBe(o.contentType);
      if (o.customMetadata) expect(obj?.customMetadata).toEqual(o.customMetadata);
      if (at !== key) expect(await env.DOCS.head(key)).toBeNull();
    }

    const write = await stub.fetch(
      await asCaller(me, ROUTES.settings, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ business: { ...settings.business, phone: "+91 80 4000 9999" } }),
      }),
    );
    expect(write.status).toBe(200);
    await runInDurableObject(stub, async (o, state) => {
      const log = inside(o).edits.all();
      expect(verifyChain(log)).toBe(true);
      const last = log.at(-1)!;
      expect([last.coll, last.action, last.changes]).toEqual([
        "business",
        "change",
        [{ field: "phone", before: "+91 80 4000 1234", after: "+91 80 4000 9999" }],
      ]);
      if (!editsBefore.length) expect(log[0]?.action).toBe("baseline");
      const business = state.storage.sql.exec<{ json: string }>("SELECT json FROM book_rows WHERE coll = 'business'").one();
      expect(JSON.parse(business.json).phone).toBe("+91 80 4000 9999");
    });
  });
});

describe("history the Office kept outside the books", () => {
  it("moves WhatsApp links an office kept itself to the shared directory, and forgets the codes", async () => {
    const { id, owner, stub, phone } = await seeded(beforeTenancy as Fixture);
    expect((await stub.fetch(await asCaller(callerFor(id, owner), ROUTES.settings))).status).toBe(200);
    const link = await env.DB.prepare("SELECT phone, active_office_id, language, digest FROM wa_link WHERE user_id = ?").bind(owner.id).first();
    expect(link).toEqual({ phone, active_office_id: id, language: "kn", digest: 1 });
    await runInDurableObject(stub, (_o, state) => {
      const left = state.storage.sql.exec<{ k: string }>("SELECT k FROM office_kv WHERE k LIKE 'wa:%'").toArray();
      expect(left).toEqual([]);
    });
  });

  it("keeps customer conversations and routine runs saved before the edit log", async () => {
    const { id, owner, stub } = await seeded(beforeEditLog as Fixture);
    expect((await stub.fetch(await asCaller(callerFor(id, owner), ROUTES.settings))).status).toBe(200);
    await runInDurableObject(stub, (o) => {
      const [thread] = inside(o).conversations.threads(10);
      expect(thread?.name).toBe("Ravi");
      expect(
        inside(o)
          .conversations.messages(thread!.id)
          .map((m) => m.text),
      ).toEqual(["Are you open on Sunday?", "We are open 10 to 2 on Sundays."]);
      const saved = (beforeEditLog as Fixture).tables.routine_run!.rows as { routine: string; id: string }[];
      for (const r of saved)
        expect(
          inside(o)
            .runs.runs(r.routine, 10)
            .map((x) => x.id),
        ).toContain(r.id);
    });
  });
});
