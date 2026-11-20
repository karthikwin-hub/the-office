import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { open } from "../../src/envelope";
import { asSystem, openOffice } from "./office";

const gunzip = async (bytes: ArrayBuffer) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();

describe("purging an office", () => {
  it("keeps its books and edit log only as a sealed copy, opened with the office's own key", async () => {
    const { id, stub } = await openOffice("Kaveri Electricals");
    const res = await stub.fetch(await asSystem(id, "/internal/purge"));
    expect(res.status).toBe(200);

    const { objects } = await env.DOCS.list({ prefix: `retained/${id}/` });
    expect(objects).toHaveLength(1);
    const obj = (await env.DOCS.get(objects[0]!.key))!;
    expect(obj.key).toMatch(/\.json\.gz\.enc$/);
    expect(obj.customMetadata).toMatchObject({ sealed: "OFB1", keepUntil: expect.stringMatching(/^\d{4}-03-31$/) });
    const bytes = new Uint8Array(await obj.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("Kaveri Electricals");

    await expect(open(env.SOCIAL_TOKEN_KEY!, bytes, "off_another000000000")).rejects.toThrow(/belongs to/);
    const kept = JSON.parse(await gunzip((await open(env.SOCIAL_TOKEN_KEY!, bytes, id)).plain)) as { office: string; books: { business: { name: string } }; edits: unknown[] };
    expect(kept.office).toBe(id);
    expect(kept.books.business.name).toBe("Kaveri Electricals");
    expect(kept.edits.length).toBeGreaterThan(0);

    // A purged office answers nothing more, and its storage is gone.
    expect((await stub.fetch(await asSystem(id, "/internal/export"))).status).toBe(404);
  });
});
