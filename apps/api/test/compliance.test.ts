import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dispatch, OfficeService, verifyChain } from "@office/engine";
import { ROUTES } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupKey, backupTarget, gzip, putObject, retainedKey } from "../src/backup";
import { SqlEditLog } from "../src/edits";
import type { Env } from "../src/env";

/** Enough of a Durable Object's SqlStorage over Node's SQLite, including `one()`. */
function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number)[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
}

const AS_OF = "2026-11-04";

describe("the edit log in the office's SQLite", () => {
  it("records each change with who made it, and keeps the hash chain across a restart", () => {
    const sql = sqlStorage();
    const o = new OfficeService(loadBooks(), { asOf: AS_OF, edits: new SqlEditLog(sql) });
    expect(new SqlEditLog(sql).count()).toBe(1);
    const res = dispatch(o, { method: "POST", path: ROUTES.complianceFiled("gstr1:2026-10"), query: new URLSearchParams(), body: { filedOn: AS_OF, ack: "AA2711" }, role: "accountant", user: { name: "Rajesh Mehta", email: "r@m.in" }, mode: "live" });
    expect(res.status).toBe(200);
    const log = new SqlEditLog(sql);
    const entries = log.all();
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.at(-1)).toMatchObject({ coll: "compliance", by: "Rajesh Mehta" });
    expect(log.list({ coll: "compliance" }).every((e) => e.coll === "compliance")).toBe(true);
    expect(verifyChain(entries)).toBe(true);

    const reopened = new OfficeService(loadBooks(), { asOf: AS_OF, edits: new SqlEditLog(sql) });
    expect(new SqlEditLog(sql).count()).toBe(entries.length);
    expect(reopened.booksRecord().editLog.intact).toBe(true);
  });

  it("refuses to change or delete an entry", () => {
    const sql = sqlStorage();
    new OfficeService(loadBooks(), { asOf: AS_OF, edits: new SqlEditLog(sql) });
    expect(() => sql.exec("UPDATE book_edits SET by_name = 'someone else'")).toThrow(/append-only/);
    expect(() => sql.exec("DELETE FROM book_edits")).toThrow(/append-only/);
    expect(new SqlEditLog(sql).count()).toBe(1);
  });
});

describe("the daily copy in India", () => {
  const env = (over: Partial<Env> = {}) => ({ INDIA_BACKUP_ENDPOINT: "https://s3.ap-south-1.amazonaws.com/", INDIA_BACKUP_BUCKET: "office-books-in", INDIA_BACKUP_REGION: "ap-south-1", INDIA_BACKUP_ACCESS_KEY_ID: "AKIDEXAMPLE", INDIA_BACKUP_SECRET_ACCESS_KEY: "test-secret-key", ...over }) as Env;
  afterEach(() => vi.unstubAllGlobals());

  it("is skipped until all five settings are there", () => {
    expect(backupTarget(env())).toMatchObject({ endpoint: "https://s3.ap-south-1.amazonaws.com", region: "ap-south-1" });
    expect(backupTarget(env({ INDIA_BACKUP_SECRET_ACCESS_KEY: undefined }))).toBeNull();
  });

  it("keeps one object per office per day, and deleted offices outside their prefix", () => {
    expect(backupKey("kaveri", "2026-11-04")).toBe("kaveri/2026-11-04.json.gz");
    expect(retainedKey("kaveri", "2026-11-04T21:30:00.000Z")).toBe("retained/kaveri/2026-11-04T21-30-00-000Z.json");
  });

  it("gzips the books", async () => {
    const zipped = await gzip(JSON.stringify({ hello: "books" }));
    const back = await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(back)).toEqual({ hello: "books" });
  });

  it("signs the upload with AWS Signature Version 4", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response("", { status: 200 });
    });
    const t = backupTarget(env())!;
    const body = new TextEncoder().encode("the books").buffer as ArrayBuffer;
    await putObject(t, "kaveri/2026-11-04.json.gz", body, "application/gzip", new Date("2026-11-04T21:30:00Z"));
    const { url, init } = seen[0]!;
    expect(url).toBe("https://s3.ap-south-1.amazonaws.com/office-books-in/kaveri/2026-11-04.json.gz");
    const h = init.headers as Record<string, string>;
    const payload = createHash("sha256").update("the books").digest("hex");
    expect(h["x-amz-content-sha256"]).toBe(payload);
    expect(h["x-amz-date"]).toBe("20261104T213000Z");

    const signed = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonical = ["PUT", "/office-books-in/kaveri/2026-11-04.json.gz", "", "content-type:application/gzip", "host:s3.ap-south-1.amazonaws.com", `x-amz-content-sha256:${payload}`, "x-amz-date:20261104T213000Z", "", signed, payload].join("\n");
    const scope = "20261104/ap-south-1/s3/aws4_request";
    const toSign = ["AWS4-HMAC-SHA256", "20261104T213000Z", scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const k = ["20261104", "ap-south-1", "s3", "aws4_request"].reduce<Buffer>((key, part) => createHmac("sha256", key).update(part).digest(), Buffer.from("AWS4test-secret-key"));
    const signature = createHmac("sha256", k).update(toSign).digest("hex");
    expect(h.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=${signed}, Signature=${signature}`);
  });

  it("says why when the store refuses", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Error>AccessDenied</Error>", { status: 403 }));
    await expect(putObject(backupTarget(env())!, "k", new ArrayBuffer(1), "application/gzip")).rejects.toThrow(/403/);
  });
});
