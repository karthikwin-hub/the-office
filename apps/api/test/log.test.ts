import { afterEach, describe, expect, it, vi } from "vitest";
import { line, log, routeOf, scrub, withRequest } from "../src/log";

/** What a careless caller might hand the logger: everything a request to the office can carry. */
const PRIVATE = {
  cookie: "better-auth.session_token=s3ss10nT0k3nAbCdEfGhIjKlMnOp.SiGnAtUrE",
  bearer: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmlsIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ",
  apiKey: "re_live_9fK2mQ7xL4pZ8vB3nR6tW1yH5jD0",
  email: "anil.kumar@kaverielectricals.in",
  name: "Anil Kumar",
  address: "14 MG Road, Indiranagar, Bengaluru 560038",
  phone: "+91 98450 12345",
  amount: "₹1,24,500.00",
  pan: "ABCPK1234F",
  gstin: "29ABCPK1234F1Z5",
  document: "Tax invoice no. KE/2026/118 for 40 LED panels",
};

const request = () =>
  new Request("https://app.office.snilld.in/api/o/off_abcdefgh23456789/bills?phone=919845012345", {
    method: "POST",
    headers: { cookie: PRIVATE.cookie, authorization: PRIVATE.bearer, "x-api-key": PRIVATE.apiKey, "content-type": "application/json" },
    body: JSON.stringify(PRIVATE),
  });

/** None of the private values, nor a recognisable piece of one, appears in what was logged. */
function expectNothingPrivate(logged: string) {
  for (const [what, value] of Object.entries(PRIVATE)) {
    expect(logged, what).not.toContain(value);
    for (const piece of value.split(/[\s,.=]+/).filter((p) => p.length >= 6 && !/^(Bearer|invoice|panels|Indiranagar)$/i.test(p)))
      expect(logged, `${what}: ${piece}`).not.toContain(piece);
  }
  for (const piece of ["98450", "12345", "1,24,500", "560038", "Indiranagar", "MG Road"]) expect(logged).not.toContain(piece);
}

describe("a log line", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is one structured line with the event, level, request id, office id and route", () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    withRequest("8f1c2a3b4c5d6e7f-BOM", () =>
      log(
        "error",
        "export.failed",
        { officeId: "off_abcdefgh23456789", route: "/api/o/:office/office-admin/export", status: 500, ms: 12 },
        new TypeError("part 2 failed"),
      ),
    );
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]![0]).toEqual({
      event: "export.failed",
      level: "error",
      requestId: "8f1c2a3b4c5d6e7f-BOM",
      officeId: "off_abcdefgh23456789",
      route: "/api/o/:office/office-admin/export",
      status: 500,
      ms: 12,
      errorName: "TypeError",
      error: "part 2 failed",
    });
    // Each line is plain data: it serialises to one line of JSON.
    expect(JSON.stringify(out.mock.calls[0]![0])).not.toContain("\n");
  });

  it("built from a request full of secrets and personal data contains none of them", async () => {
    const req = request();
    const body = (await req.clone().json()) as typeof PRIVATE;
    const url = new URL(req.url);
    // Everything a hurried change might pass: the path, the query, the headers, the body, and an error that quotes them.
    let parseError: unknown;
    try {
      JSON.parse(`${body.name}, ${body.address}, ${body.document}`);
    } catch (e) {
      parseError = e;
    }
    const lines = withRequest(req.headers.get("cf-ray") ?? "no-ray", () => [
      line("error", "mail.failed", { route: routeOf(url.pathname + url.search), message: `could not send to ${body.email} (${body.phone})` }),
      line("error", "request.failed", { route: routeOf(url.pathname) }, parseError),
      line(
        "error",
        "mail.failed",
        {},
        new Error(`422: "${body.name}" <${body.email}> is not a valid recipient for ${body.amount}, PAN ${body.pan}, GSTIN ${body.gstin}`),
      ),
      line("warn", "auth.refused", { message: `authorization: ${req.headers.get("authorization")} cookie=${req.headers.get("cookie")}` }),
      line("error", "upstream.failed", { message: `key=${req.headers.get("x-api-key")}` }, new Error(JSON.stringify(body))),
      line("info", "unknown.fields", { ...(body as object), message: body.document.slice(0, 0) } as never),
    ]);
    const logged = lines.map((l) => JSON.stringify(l)).join("\n");
    expectNothingPrivate(logged);
    // What it does keep is still useful.
    expect(lines[0]).toMatchObject({ event: "mail.failed", route: "/api/o/:id/bills", message: "could not send to [email] ([number])" });
    expect(lines[1]).toMatchObject({ errorName: "SyntaxError", route: "/api/o/:id/bills" });
    expect(lines[2]!.error).toBe("422: [quoted] <[email]> is not a valid recipient for [amount], PAN [pan], GSTIN [gstin]");
  });

  it("keeps fixed messages as written, and only known fields", () => {
    expect(scrub("backup to India failed")).toBe("backup to India failed");
    expect(scrub("The office could not write part 2 of the export (500).")).toBe("The office could not write part 2 of the export (500).");
    expect(scrub("the token expired")).toBe("the token expired");
    expect(line("info", "x", { password: "hunter2" } as never)).toEqual({ event: "x", level: "info" });
    expect(line("info", "Not An Event!").event).toBe("invalid-event");
    expect(scrub("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });

  it("names a route by its pattern, never by the ids, names or addresses in a path", () => {
    expect(routeOf("/api/bills/bill_8F2k/approve")).toBe("/api/bills/:id/approve");
    expect(routeOf("/api/team/anil.kumar@kaverielectricals.in")).toBe("/api/team/:id");
    expect(routeOf("/internal/export/part")).toBe("/internal/export/part");
  });
});
