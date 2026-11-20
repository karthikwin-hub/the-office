import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_ID_HEADER } from "../../src/log";
import { asSystem, openOffice } from "./office";

describe("an office's log lines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carry the Worker's request id, the office and the route, and nothing the request held", async () => {
    const { id, stub } = await openOffice();
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = await asSystem(id, "/internal/mail-admit");
    // A body the office cannot read: its JSON error quotes the text, which must not reach the log.
    const bad = new Request(req, { body: "Anil Kumar, 14 MG Road, anil@kaverielectricals.in, +91 98450 12345" });
    bad.headers.set(REQUEST_ID_HEADER, "8f1c2a3b4c5d6e7f-BOM");
    const res = await stub.fetch(bad);
    expect(res.status).toBe(500);
    const lines = out.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(lines).toEqual([
      {
        event: "office.failed",
        level: "error",
        requestId: "8f1c2a3b4c5d6e7f-BOM",
        officeId: id,
        route: "/internal/mail-admit",
        message: "request failed",
        errorName: "SyntaxError",
        error: expect.any(String),
      },
    ]);
    const logged = JSON.stringify(lines);
    for (const p of ["Anil", "MG Road", "anil@", "98450"]) expect(logged).not.toContain(p);
  });
});
