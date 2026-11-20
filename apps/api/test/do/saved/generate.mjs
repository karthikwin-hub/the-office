#!/usr/bin/env node
// Writes the storage of an office as an earlier version of the Office Durable Object left it, for saved.test.ts.
//
//   node apps/api/test/do/saved/generate.mjs <commit> <name>
//
// It takes that commit's own contracts, engine, fixtures and storage classes out of git, bundles them with zod 3 (the
// `zod/v3` that ships inside zod 4, as zod 3.25), and runs them on Node's SQLite the way that version's `onStart` and
// `commit()` did: the sample business cut to three records a list, a settings change, an approved staged change, a
// WhatsApp link and a person's skin where that version had them. The agents SDK of the time (0.0.113) is not run; its
// tables and the morning digest's schedule row are written in that SDK's own shapes. The result is
// `<name>.json`: every table's CREATE statement and rows, and the R2 objects.
//
// Do not regenerate a fixture that is committed: each one pins what a version wrote. Add a new one for a new version.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [commit, name] = process.argv.slice(2);
if (!commit || !name) throw new Error("usage: generate.mjs <commit> <name>");
const here = import.meta.dirname;
const root = resolve(here, "../../../../..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
const has = (path) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${path}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const work = mkdtempSync(join(tmpdir(), "saved-office-"));
try {
  execFileSync("tar", ["-x", "-C", work], { input: execFileSync("git", ["archive", commit, "packages", "apps/api/src"], { cwd: root, maxBuffer: 1 << 30 }) });
  const api = createRequire(join(root, "apps/api/package.json"));
  const zod3 = join(dirname(api.resolve("zod/package.json")), "v3/index.js");
  const esbuild = createRequire(api.resolve("wrangler"))("esbuild");

  const files = {
    edits: has("apps/api/src/edits.ts"),
    routines: has("apps/api/src/routines.ts"),
    customers: has("apps/api/src/customer/store.ts"),
    links: has("apps/api/src/whatsapp/links.ts"),
  };
  const entry = join(work, "entry.ts");
  writeFileSync(
    entry,
    [
      `export { Books } from "@office/contracts";`,
      `export * as fixtures from "@office/fixtures";`,
      `export { OfficeService } from "@office/engine";`,
      `export { BooksStore } from "./apps/api/src/store";`,
      `export { digestCron } from "./apps/api/src/time";`,
      `export { savePrefs } from "./apps/api/src/prefs";`,
      files.edits ? `export { SqlEditLog } from "./apps/api/src/edits";` : `export const SqlEditLog = null;`,
      files.routines ? `export { SqlRoutineLog } from "./apps/api/src/routines";` : `export const SqlRoutineLog = null;`,
      files.customers
        ? `export { SqlCsStore } from "./apps/api/src/customer/store"; export { CsThread, CsMessage } from "@office/contracts";`
        : `export const SqlCsStore = null;`,
      files.links ? `export * as links from "./apps/api/src/whatsapp/links";` : `export const links = null;`,
    ].join("\n"),
  );
  const out = join(work, "old.mjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "error",
    alias: {
      zod: zod3,
      "@office/contracts": join(work, "packages/contracts/src/index.ts"),
      "@office/engine": join(work, "packages/engine/src/index.ts"),
      "@office/fixtures": join(work, "packages/fixtures/src/index.ts"),
    },
    nodePaths: [join(root, "packages/engine/node_modules"), join(root, "apps/api/node_modules")],
    external: ["pdfjs-dist", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const old = await import(out);

  // The Durable Object's SQL storage, on Node's SQLite.
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...args) {
      const rows = db.prepare(query).all(...args.map((a) => (a === undefined ? null : a)));
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  sql.exec("CREATE TABLE IF NOT EXISTS office_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const kv = (k, v) => {
    if (v !== undefined) sql.exec("INSERT INTO office_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
    return sql.exec("SELECT v FROM office_kv WHERE k = ?", k).toArray()[0]?.v ?? null;
  };
  const tenancy = has("apps/api/src/tenancy.ts");
  const OFFICE = "off_savedbooksabcdef";
  const OWNER = { name: "Anil Kumar", email: "owner@saved.office.test" };
  const AS_OF = "2026-11-04";
  const r2 = {};

  // Each table as that version's onStart created it, in its order.
  if (tenancy) kv("office:id", OFFICE);
  const store = new old.BooksStore(sql);
  const edits = old.SqlEditLog ? new old.SqlEditLog(sql) : null;
  const runs = old.SqlRoutineLog ? new old.SqlRoutineLog(sql) : null;
  const conversations = old.SqlCsStore ? new old.SqlCsStore(sql) : null;
  sql.exec("CREATE TABLE IF NOT EXISTS social_tokens (channel_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at INTEGER NOT NULL)");

  // The sample business, three records a list (every party and item, which the rest name), seeded as a real office is
  // (a sample-seeded office starts over).
  const sample = old.fixtures.loadBooks();
  const whole = new Set(["parties", "skus", "stock", "agents", "channels"]);
  const cut = Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, Array.isArray(v) && !whole.has(k) ? v.slice(0, 3) : v]));
  cut.seed = 0;
  cut.business = { ...cut.business, name: "Saved Books Traders" };
  cut.documents = cut.documents.map((d, i) => {
    if (i > 1) return d;
    const file = tenancy ? `/api/o/${OFFICE}/files/${d.id}` : `/api/files/${d.id}`;
    const key = tenancy ? `o/${OFFICE}/docs/${d.id}` : `docs/${d.id}`;
    r2[key] = { body: `%PDF-1.4\n% ${d.id}, as uploaded\n`, contentType: "application/pdf", customMetadata: { filename: `${d.id}.pdf`, by: OWNER.email } };
    r2[`${key}.txt`] = { body: `Text of ${d.id}`, contentType: "text/plain" };
    return { ...d, file };
  });
  const books = old.Books.parse(cut);
  store.save(books);
  if (tenancy) kv("schema_version", "2");

  const office = new old.OfficeService(books, {
    asOf: AS_OF,
    ingestEmail: "saved@in.the-office.test",
    routines: runs ?? undefined,
    conversations: conversations ?? undefined,
    edits: edits ?? undefined,
  });
  const commitAs = (by) => {
    if (typeof office.recordEdits === "function") office.recordEdits(by);
    store.save(office.books);
    const { users: _u, ...settings } = office.settings();
    kv("settings", JSON.stringify(settings));
  };
  commitAs("The Office");
  office.updateSettings({
    digestTime: "07:30",
    reminderPolicy: { ...office.settings().reminderPolicy, firstAfterDays: 4 },
    business: { phone: "+91 00 0000 1234" },
  });
  commitAs(OWNER.name);
  const pending = office.books.staged.find((s) => s.status === "pending");
  if (pending) {
    office.decide(pending.id, { action: "approve" }, OWNER.name);
    commitAs(OWNER.name);
  }
  old.savePrefs(kv, OWNER.email, { skin: "loft", wholeFloor: true });

  if (old.links && !tenancy) {
    const { code } = old.links.newJoinCode(kv, { email: OWNER.email, name: OWNER.name, role: "owner" }, Date.parse("2026-11-05T05:00:00Z"));
    old.links.redeemJoinCode(kv, "+91 00000 12345", code, Date.parse("2026-11-05T05:01:00Z"));
    old.links.updateLink(kv, OWNER.email, { language: "kn", digest: true });
  }
  if (runs && old.fixtures.sampleRoutineRuns) for (const r of old.fixtures.sampleRoutineRuns(AS_OF).slice(0, 2)) runs.record(r);
  if (conversations) {
    // One WhatsApp conversation the Customer Service agent answered, in that version's shapes.
    const at = "2026-11-05T06:00:00.000Z";
    const later = "2026-11-05T06:00:40.000Z";
    const thread = {
      id: "cs-t-saved1",
      channel: "whatsapp",
      key: "910000067890",
      name: "Ravi",
      partyId: null,
      verifiedContact: null,
      status: "resolved",
      subject: null,
      startedAt: at,
      lastAt: later,
      lastInboundAt: at,
      disclosed: true,
      handoffs: 0,
      firstReplySeconds: 40,
      test: false,
    };
    conversations.saveThread(old.CsThread.parse(thread));
    conversations.addMessage(
      old.CsMessage.parse({
        id: "cs-m-saved1",
        threadId: thread.id,
        at,
        direction: "in",
        by: "customer",
        text: "Are you open on Sunday?",
        intent: "hours",
        ground: null,
        status: "received",
        externalId: "wamid.saved1",
        error: null,
      }),
    );
    conversations.addMessage(
      old.CsMessage.parse({
        id: "cs-m-saved2",
        threadId: thread.id,
        at: later,
        direction: "out",
        by: "agent",
        text: "We are open 10 to 2 on Sundays.",
        intent: "hours",
        ground: "fact",
        status: "sent",
        externalId: "wamid.saved2",
        error: null,
      }),
    );
  }

  // The agents SDK 0.0.113's tables, and the digest it scheduled (onStart's scheduleDigest).
  sql.exec("CREATE TABLE IF NOT EXISTS cf_agents_state ( id TEXT PRIMARY KEY NOT NULL, state TEXT )");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cf_agents_queues ( id TEXT PRIMARY KEY NOT NULL, payload TEXT, callback TEXT, created_at INTEGER DEFAULT (unixepoch()) )",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cf_agents_schedules ( id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)), callback TEXT, payload TEXT, type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')), time INTEGER, delayInSeconds INTEGER, cron TEXT, created_at INTEGER DEFAULT (unixepoch()) )",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers ( id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, server_url TEXT NOT NULL, callback_url TEXT NOT NULL, client_id TEXT, auth_url TEXT, server_options TEXT )",
  );
  sql.exec(
    "INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, cron, time, created_at) VALUES (?, ?, ?, 'cron', ?, ?, ?)",
    "Xs4vQ0b1k",
    "daily",
    null,
    old.digestCron(office.settings().digestTime),
    Math.floor(Date.parse("2026-11-06T02:00:00Z") / 1000),
    Math.floor(Date.parse("2026-11-05T05:00:00Z") / 1000),
  );

  const tables = {};
  for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY rowid").all())
    tables[t.name] = { create: t.sql, also: [], rows: db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all() };
  for (const t of db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type != 'table' AND sql IS NOT NULL ORDER BY rowid").all())
    tables[t.tbl_name].also.push(t.sql);

  const [subject, date] = git("log", "-1", "--format=%s%n%cI", commit).trim().split("\n");
  const fixture = { commit: git("rev-parse", "--short", commit).trim(), subject, date, office: OFFICE, owner: OWNER, tables, r2 };
  mkdirSync(here, { recursive: true });
  writeFileSync(join(here, `${name}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${name}.json: ${Object.keys(tables).join(", ")}; ${Object.keys(r2).length} R2 objects`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
