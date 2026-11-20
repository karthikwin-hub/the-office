import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dispatch, OfficeService, verifyChain } from "@office/engine";
import { ROUTES } from "@office/contracts";
import { loadBooks } from "@office/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBackup } from "../../../tools/admin/open-backup.mjs";
import { backupKey, backupTarget, deleteObjects, gzip, listObjects, putObject, retainedKey, sealedCopy } from "../src/backup";
import { envelopeHeader, open } from "../src/envelope";
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
    const res = dispatch(o, {
      method: "POST",
      path: ROUTES.complianceFiled("gstr1:2026-10"),
      query: new URLSearchParams(),
      body: { filedOn: AS_OF, ack: "AA2711" },
      role: "accountant",
      user: { name: "Rajesh Mehta", email: "r@m.in" },
      mode: "live",
    });
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
  const env = (over: Partial<Env> = {}) =>
    ({
      INDIA_BACKUP_ENDPOINT: "https://s3.ap-south-1.amazonaws.com/",
      INDIA_BACKUP_BUCKET: "office-books-in",
      INDIA_BACKUP_REGION: "ap-south-1",
      INDIA_BACKUP_ACCESS_KEY_ID: "AKIDEXAMPLE",
      INDIA_BACKUP_SECRET_ACCESS_KEY: "test-secret-key",
      ...over,
    }) as Env;
  afterEach(() => (vi.unstubAllGlobals(), vi.restoreAllMocks()));

  it("is skipped until all five settings are there", () => {
    expect(backupTarget(env())).toMatchObject({ endpoint: "https://s3.ap-south-1.amazonaws.com", region: "ap-south-1" });
    expect(backupTarget(env({ INDIA_BACKUP_SECRET_ACCESS_KEY: undefined }))).toBeNull();
  });

  it("keeps one object per office per day, and deleted offices outside their prefix", () => {
    expect(backupKey("kaveri", "2026-11-04")).toBe("kaveri/2026-11-04.json.gz.enc");
    expect(retainedKey("kaveri", "2026-11-04T21:30:00.000Z")).toBe("retained/kaveri/2026-11-04T21-30-00-000Z.json.gz.enc");
  });

  it("gzips the books", async () => {
    const zipped = await gzip(JSON.stringify({ hello: "books" }));
    const back = await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(back)).toEqual({ hello: "books" });
  });

  it("seals each copy with a fresh data key wrapped by the office's own key, and the restore tool opens it", async () => {
    const secret = "backup-test-root-key-not-a-real-one";
    const books = {
      office: "off_kaveri2345678abcd",
      at: "2026-11-04T21:30:00.000Z",
      books: { business: { name: "Kaveri Electricals", gstin: "29ABCDE1234F1Z5" } },
      edits: [{ seq: 1, by: "Anil" }],
    };
    const sealed = await sealedCopy(secret, books.office, books);
    const text = new TextDecoder("latin1").decode(sealed);
    expect(text).not.toContain("Kaveri");
    expect(text).not.toContain("29ABCDE1234F1Z5");
    expect(envelopeHeader(sealed)).toMatchObject({ v: 1, alg: "A256GCM", office: books.office });
    // The documented way back: tools/admin/open-backup.mjs, on Node alone.
    expect(await openBackup(secret, sealed)).toEqual(books);
    const again = await sealedCopy(secret, books.office, books);
    expect(envelopeHeader(again)!.dek).not.toBe(envelopeHeader(sealed)!.dek);

    await expect(openBackup("another-root-key", sealed)).rejects.toThrow();
    await expect(open(secret, sealed, "off_shah234567890abcd")).rejects.toThrow(/belongs to/);
    const changed = sealed.slice();
    changed[changed.length - 5]! ^= 1;
    await expect(openBackup(secret, changed)).rejects.toThrow();
    // A header moved onto another office's copy fails: it is bound into the ciphertext, and the data key to the office.
    const other = await sealedCopy(secret, "off_shah234567890abcd", books);
    const swapped = new Uint8Array([
      ...sealed.subarray(0, 8 + new DataView(sealed.buffer).getUint32(4)),
      ...other.subarray(8 + new DataView(other.buffer).getUint32(4)),
    ]);
    await expect(openBackup(secret, swapped)).rejects.toThrow();
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
    const canonical = [
      "PUT",
      "/office-books-in/kaveri/2026-11-04.json.gz",
      "",
      "content-type:application/gzip",
      "host:s3.ap-south-1.amazonaws.com",
      `x-amz-content-sha256:${payload}`,
      "x-amz-date:20261104T213000Z",
      "",
      signed,
      payload,
    ].join("\n");
    const scope = "20261104/ap-south-1/s3/aws4_request";
    const toSign = ["AWS4-HMAC-SHA256", "20261104T213000Z", scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const k = ["20261104", "ap-south-1", "s3", "aws4_request"].reduce<Buffer>(
      (key, part) => createHmac("sha256", key).update(part).digest(),
      Buffer.from("AWS4test-secret-key"),
    );
    const signature = createHmac("sha256", k).update(toSign).digest("hex");
    expect(h.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=${signed}, Signature=${signature}`);
  });

  it("signs the listing's query string the way Signature Version 4 wants it, and reads every page", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(
        "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>kaveri/2026-11-04.json.gz</Key></Contents><Contents><Key>kaveri/a&amp;b</Key></Contents><NextContinuationToken>1/x=</NextContinuationToken></ListBucketResult>",
      );
    });
    const page = await listObjects(backupTarget(env())!, "kaveri/", "0/y=", new Date("2026-11-04T21:30:00Z"));
    expect(page).toEqual({ keys: ["kaveri/2026-11-04.json.gz", "kaveri/a&b"], truncated: true, next: "1/x=" });
    const { url, init } = seen[0]!;
    const qs = "continuation-token=0%2Fy%3D&list-type=2&prefix=kaveri%2F";
    expect(url).toBe(`https://s3.ap-south-1.amazonaws.com/office-books-in?${qs}`);
    const h = init.headers as Record<string, string>;
    const empty = createHash("sha256").update("").digest("hex");
    const canonical = [
      "GET",
      "/office-books-in",
      qs,
      "host:s3.ap-south-1.amazonaws.com",
      `x-amz-content-sha256:${empty}`,
      "x-amz-date:20261104T213000Z",
      "",
      "host;x-amz-content-sha256;x-amz-date",
      empty,
    ].join("\n");
    const scope = "20261104/ap-south-1/s3/aws4_request";
    const toSign = ["AWS4-HMAC-SHA256", "20261104T213000Z", scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const k = ["20261104", "ap-south-1", "s3", "aws4_request"].reduce<Buffer>(
      (key, part) => createHmac("sha256", key).update(part).digest(),
      Buffer.from("AWS4test-secret-key"),
    );
    expect(h.authorization).toContain(`Signature=${createHmac("sha256", k).update(toSign).digest("hex")}`);

    // A store that says there is more without a token for it still says there is more.
    vi.stubGlobal(
      "fetch",
      async () => new Response("<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>kaveri/1</Key></Contents></ListBucketResult>"),
    );
    expect(await listObjects(backupTarget(env())!, "kaveri/")).toEqual({ keys: ["kaveri/1"], truncated: true, next: null });
  });

  it("deletes in one request with the body's MD5, and fails when the store keeps any key", async () => {
    // Workers have MD5 in WebCrypto for this; Node does not, so the test lends it Node's.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (alg, data) =>
      alg === "MD5"
        ? new Uint8Array(
            createHash("md5")
              .update(new Uint8Array(data as ArrayBuffer))
              .digest(),
          ).buffer
        : digest(alg, data),
    );
    const seen: { url: string; init: RequestInit }[] = [];
    let answer = "<DeleteResult></DeleteResult>";
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => (seen.push({ url: String(url), init }), new Response(answer)));
    await deleteObjects(backupTarget(env())!, ["kaveri/1.json.gz", "kaveri/<2>"]);
    const { url, init } = seen[0]!;
    expect(url).toBe("https://s3.ap-south-1.amazonaws.com/office-books-in?delete=");
    expect(init.method).toBe("POST");
    const body = new Uint8Array(init.body as ArrayBuffer);
    expect(new TextDecoder().decode(body)).toContain(
      "<Quiet>true</Quiet><Object><Key>kaveri/1.json.gz</Key></Object><Object><Key>kaveri/&lt;2&gt;</Key></Object>",
    );
    expect((init.headers as Record<string, string>)["content-md5"]).toBe(createHash("md5").update(body).digest("base64"));
    answer = "<DeleteResult><Error><Key>kaveri/1.json.gz</Key><Code>AccessDenied</Code></Error></DeleteResult>";
    await expect(deleteObjects(backupTarget(env())!, ["kaveri/1.json.gz"])).rejects.toThrow(/AccessDenied/);
    await expect(
      deleteObjects(
        backupTarget(env())!,
        Array.from({ length: 1001 }, (_, i) => `k${i}`),
      ),
    ).rejects.toThrow(/1,000/);
  });

  it("says why when the store refuses", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Error>AccessDenied</Error>", { status: 403 }));
    await expect(putObject(backupTarget(env())!, "k", new ArrayBuffer(1), "application/gzip")).rejects.toThrow(/403/);
  });
});
