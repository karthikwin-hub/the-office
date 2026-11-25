import { ROUTES } from "@office/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { system } from "../../src/caller";
import { FILE_CSP } from "../../src/edge";
import { type ExportPlan, exportArchive } from "../../src/export";
import { attachmentRequest } from "../../src/files";
import { docKey } from "../../src/keys";
import { asCaller, asSystem, callerFor, openOffice } from "./office";

const latin1 = (b: ArrayBuffer | Uint8Array) => new TextDecoder("latin1").decode(b);

/** A stored object as R2 has it. */
async function raw(key: string) {
  const obj = (await env.DOCS.get(key))!;
  return { meta: obj.customMetadata, type: obj.httpMetadata?.contentType, bytes: new Uint8Array(await obj.arrayBuffer()) };
}

describe("an office's stored files", () => {
  it("are sealed with the office's key in R2, and served to its people as they were given", async () => {
    const { id, owner, stub } = await openOffice();
    const form = new FormData();
    form.set("file", new File(["%PDF-1.4 challan for Kaveri Electricals"], "challan नवंबर.pdf", { type: "application/pdf" }));
    const up = await stub.fetch(await asCaller(callerFor(id, owner), ROUTES.complianceProof, { method: "POST", body: form }));
    expect(up.status).toBe(200);
    const fileId = ((await up.json()) as { file: string }).file.split("/").at(-1)!;

    const stored = await raw(docKey(id, fileId));
    expect(stored.meta).toEqual({ sealed: "OFB1" });
    expect(stored.type).toBe("application/octet-stream");
    expect(latin1(stored.bytes)).not.toMatch(/challan|Kaveri|PDF-1\.4/);
    expect(latin1(stored.bytes)).not.toContain(owner.email);

    const res = await stub.fetch(await asCaller(callerFor(id, owner, "accountant"), `/api/files/${fileId}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="${"challan नवंबर.pdf".replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent("challan नवंबर.pdf")}`,
    );
    expect(res.headers.get("content-security-policy")).toBe(FILE_CSP);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(await res.text()).toBe("%PDF-1.4 challan for Kaveri Electricals");
  });

  it("opens only where they were stored: moved to another key or another office, a sealed file does not open", async () => {
    const { id, owner, stub } = await openOffice();
    const other = await openOffice();
    await stub.fetch(await asCaller(system(id), "/internal/files/doc-a", { method: "PUT", body: "bill A", headers: { "x-file-meta": "%7B%7D" } }));
    const sealed = await raw(docKey(id, "doc-a"));
    await env.DOCS.put(docKey(id, "doc-b"), sealed.bytes, { customMetadata: sealed.meta });
    await env.DOCS.put(docKey(other.id, "doc-a"), sealed.bytes, { customMetadata: sealed.meta });
    expect((await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/doc-a"))).status).toBe(200);
    const moved = await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/doc-b"));
    expect(moved.status).toBe(500);
    expect(await moved.text()).not.toContain("bill A");
    expect((await other.stub.fetch(await asCaller(callerFor(other.id, other.owner), "/api/files/doc-a"))).status).toBe(500);
  });

  it("still serves files stored before they were sealed, as they are", async () => {
    const { id, owner, stub } = await openOffice();
    await env.DOCS.put(docKey(id, "doc-old"), "%PDF-1.4 old", { httpMetadata: { contentType: "application/pdf" }, customMetadata: { filename: "old.pdf" } });
    const res = await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/doc-old"));
    expect(res.headers.get("content-disposition")).toBe('inline; filename="old.pdf"');
    expect(await res.text()).toBe("%PDF-1.4 old");
    expect((await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/doc-none"))).status).toBe(404);
    expect((await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/media-1"))).status).toBe(404);
  });

  it("takes an emailed attachment only from the Worker, seals it, and serves a 10 MB one whole", async () => {
    const { id, owner, stub } = await openOffice();
    const big = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const hand = (caller: Parameters<typeof asCaller>[0]) => {
      const r = attachmentRequest("doc-mail", { content: big, mimeType: "application/pdf", filename: 'bill "x"\r\n.pdf' }, "bills@supplier.test");
      return asCaller(caller, new URL(r.url).pathname, { method: "PUT", body: big, headers: r.headers });
    };
    expect((await stub.fetch(await hand(callerFor(id, owner)))).status).toBe(404);
    expect(await env.DOCS.head(docKey(id, "doc-mail"))).toBeNull();
    expect((await stub.fetch(await hand(system(id)))).status).toBe(200);
    expect((await raw(docKey(id, "doc-mail"))).meta).toEqual({ sealed: "OFB1" });
    const res = await stub.fetch(await asCaller(callerFor(id, owner), "/api/files/doc-mail"));
    expect(res.headers.get("content-disposition")).toBe('inline; filename="bill x.pdf"');
    const back = new Uint8Array(await res.arrayBuffer());
    expect(back.length).toBe(big.length);
    expect(back.every((b, i) => b === big[i])).toBe(true);
  });

  it("goes into the export as plain files, sealed or not", async () => {
    const { id, stub } = await openOffice();
    await stub.fetch(await asCaller(system(id), "/internal/files/doc-new", { method: "PUT", body: "sealed bill", headers: { "x-file-meta": "%7B%7D" } }));
    await env.DOCS.put(docKey(id, "doc-old"), "plain bill");
    expect((await raw(docKey(id, "doc-new"))).meta).toEqual({ sealed: "OFB1" });
    const plan = (await (await stub.fetch(await asSystem(id, "/internal/export/plan"))).json()) as ExportPlan;
    const { body, done } = exportArchive(plan, async (part) => stub.fetch(await asSystem(id, "/internal/export/part", { id: plan.id, part })));
    const zip = latin1(await new Response(body).arrayBuffer());
    await done;
    expect(zip).toContain("sealed bill");
    expect(zip).toContain("plain bill");
    expect(zip).not.toContain("OFB1");
  });

  it("takes a video for a Reel, sealed like a picture and shown as a video", async () => {
    const { id, owner, stub } = await openOffice();
    const upload = (file: File) => {
      const form = new FormData();
      form.set("file", file);
      return asCaller(callerFor(id, owner), ROUTES.socialMedia, { method: "POST", body: form });
    };
    const up = await stub.fetch(await upload(new File(["....ftypmp42 a short reel"], "reel.mp4", { type: "video/mp4" })));
    expect(up.status).toBe(200);
    const asset = (await up.json()) as { id: string; kind: string };
    expect(asset.kind).toBe("video");
    const res = await stub.fetch(await asCaller(callerFor(id, owner), `/api/social/media/${asset.id}`));
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe("....ftypmp42 a short reel");
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "long.mov", { type: "video/quicktime" });
    expect((await stub.fetch(await upload(big))).status).toBe(413);
    expect((await stub.fetch(await upload(new File(["GIF89a"], "a.gif", { type: "image/gif" })))).status).toBe(415);
  });
});

describe("a bill uploaded from the browser", () => {
  it("is refused when its bytes are not the PDF or picture it claims to be", async () => {
    const { id, owner, stub } = await openOffice();
    const upload = async (file: File, items?: string) => {
      const form = new FormData();
      form.set("file", file);
      if (items !== undefined) form.set("items", items);
      return stub.fetch(await asCaller(callerFor(id, owner), ROUTES.documents, { method: "POST", body: form }));
    };
    expect((await upload(new File(["<html><script>alert(1)</script>"], "bill.pdf", { type: "application/pdf" }))).status).toBe(415);
    expect((await upload(new File(["MZ not a picture"], "bill.png", { type: "image/png" }))).status).toBe(415);
    expect((await upload(new File(["%PDF-1.4 a bill"], "bill.pdf", { type: "application/pdf" }), "{not json")).status).toBe(400);
    const proof = new FormData();
    proof.set("file", new File(["<svg onload=alert(1)>"], "challan.pdf", { type: "application/pdf" }));
    expect((await stub.fetch(await asCaller(callerFor(id, owner), ROUTES.complianceProof, { method: "POST", body: proof }))).status).toBe(415);
  });
});
