import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { unstable_readConfig } from "wrangler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, toOffice } from "../src/app";
import { CALLER_HEADER, system } from "../src/caller";
import { CALLER_SEAL_HEADER, callerSealed } from "../src/caller-seal";
import type { Env } from "../src/env";
import { exportArchive } from "../src/export";
import worker from "../src/index";

// The Worker's entry point exports the Office, whose SDK needs workerd; the cron and mail handlers do not.
vi.mock("../src/office-agent", () => ({ Office: class {} }));
import { GENERIC_ERROR, inOffice, type Line, line, log, REQUEST_ID_HEADER, requestFailed, requestLog, routeOf, scrub, withRequest } from "../src/log";

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
    expect(out.mock.calls[0]?.[0]).toEqual({
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
    expect(JSON.stringify(out.mock.calls[0]?.[0])).not.toContain("\n");
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
    expect(lines[2]?.error).toBe("422: [quoted] <[email]> is not a valid recipient for [amount], PAN [pan], GSTIN [gstin]");
  });

  it("keeps fixed messages as written, and only known fields", () => {
    expect(scrub("backup to India failed")).toBe("backup to India failed");
    expect(scrub("The office could not write part 2 of the export (500).")).toBe("The office could not write part 2 of the export (500).");
    expect(scrub("the token expired")).toBe("the token expired");
    expect(line("info", "x", { password: "hunter2" } as never)).toEqual({ event: "x", level: "info" });
    expect(line("info", "Not An Event!").event).toBe("invalid-event");
    expect(line("error", "social.pull-failed", { channel: "ch_1732000123" }).channel).toBe("ch_1732000123");
    expect(line("error", "social.pull-failed", { channel: "anil@kaveri.in" }).channel).toBe("invalid-id");
    expect(scrub("x".repeat(1000)).length).toBeLessThanOrEqual(301);
    expect(scrub("Order 1,24,500 for 124500.00 and 12,000/- to SBIN0001234 a/c 00112233445")).toBe(
      "Order [number] for [amount] and [amount] to [ifsc] a/c [number]",
    );
    // An unmatched quote hides the rest, across lines (a ZodError's message is multi-line JSON).
    expect(scrub('Invalid input: [\n  {\n    "path": ["name"],\n    "received": "Anil Kumar')).toBe(
      "Invalid input: [\n  {\n    [quoted]: [[quoted]],\n    [quoted]: [quoted]",
    );
    expect(scrub('first line "Anil Kumar\n14 MG Road')).toBe("first line [quoted]");
  });

  it("scrubs a huge error message quickly: the free plan has 10 ms of CPU a request", () => {
    for (const big of ["a".repeat(64_000), `${"9".repeat(64_000)}@`, `"${"x ".repeat(32_000)}`]) {
      const started = performance.now();
      expect(scrub(big).length).toBeLessThanOrEqual(301);
      // Linear now: well under this on any runner; the quadratic pattern took seconds.
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it("names a route by its pattern, never by the ids, names or addresses in a path", () => {
    expect(routeOf("/api/bills/bill_8F2k/approve")).toBe("/api/bills/:id/approve");
    expect(routeOf("/api/team/anil.kumar@kaverielectricals.in")).toBe("/api/team/:id");
    expect(routeOf("/internal/export/part")).toBe("/internal/export/part");
  });
});

const RAY = "8f1c2a3b4c5d6e7f-BOM";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const env = (extra: Record<string, unknown> = {}) =>
  ({ DATA_MODE: "test", APP_DOMAIN: "", BETTER_AUTH_URL: "https://app.the-office.test", BETTER_AUTH_SECRET: "log-test-secret", ...extra }) as unknown as Env;
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0] as Line);

describe("each request's id", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is Cloudflare's ray id, or a new one, and comes back on the response", async () => {
    const ray = await app.request("/api/health", { headers: { "cf-ray": RAY } }, env());
    expect(ray.headers.get(REQUEST_ID_HEADER)).toBe(RAY);
    const none = await app.request("/api/health", {}, env());
    expect(none.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
    // A header that is not an id is not taken, and the person asking cannot choose the id.
    const odd = await app.request("/api/health", { headers: { "cf-ray": "a b;c", [REQUEST_ID_HEADER]: "mine" } }, env());
    expect(odd.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
    // Pages from the asset server get it too, alongside the security headers.
    const page = await app.request(
      "/",
      { headers: { "cf-ray": RAY } },
      env({ ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) } }),
    );
    expect(page.headers.get(REQUEST_ID_HEADER)).toBe(RAY);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("goes to the office with the sealed caller, set by the Worker, never by the person asking", async () => {
    const reached: Headers[] = [];
    const Office = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (req: Request) => {
          reached.push(req.headers);
          return new Response("ok");
        },
      }),
    };
    const caller = system("off_abcdefgh23456789");
    const asked = new Request("https://office.internal/api/settings", { headers: { [REQUEST_ID_HEADER]: "chosen-by-the-caller" } });
    await withRequest(RAY, () => toOffice(env({ Office }), asked, caller));
    await toOffice(env({ Office }), asked, caller);
    expect(reached[0]?.get(REQUEST_ID_HEADER)).toBe(RAY);
    expect(reached[1]?.get(REQUEST_ID_HEADER)).toMatch(UUID);
    for (const h of reached) {
      expect(h.get(CALLER_HEADER)).toBe(JSON.stringify(caller));
      expect(await callerSealed("log-test-secret", h.get(CALLER_HEADER) ?? "", h.get(CALLER_SEAL_HEADER))).toBe(true);
    }
  });
});

describe("a request that fails", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is logged once, with its route and error, and answered with a generic error", async () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // No database: looking up the chat widget's office throws.
    const res = await app.request("/w/wabcdefgh2345.js", { headers: { "cf-ray": RAY, cookie: PRIVATE.cookie, authorization: PRIVATE.bearer } }, env());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(GENERIC_ERROR);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(RAY);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(lines(out)).toHaveLength(1);
    expect(lines(out)[0]).toMatchObject({ event: "request.failed", level: "error", requestId: RAY, route: "/w/:file", method: "GET", status: 500 });
    expect(lines(out)[0]?.errorName).toBeTypeOf("string");
    expectNothingPrivate(JSON.stringify(lines(out)));
  });

  it("with a 5xx it answered itself gets one line too; other answers get none", async () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const small = new Hono();
    small.use("*", requestLog);
    small.onError(requestFailed);
    small.use("/o/:office/*", async (c, next) => {
      inOffice(c.req.param("office"));
      await next();
    });
    small.get("/o/:office/busy", (c) => c.json({ error: "The office is busy." }, 503));
    small.get("/o/:office/fine", (c) => c.json({ ok: true }));
    small.get("/o/:office/gone", (c) => c.json({ error: "Not found" }, 404));

    expect((await small.request("/o/off_abcdefgh23456789/busy", { headers: { "cf-ray": RAY } })).status).toBe(503);
    expect(lines(out)).toEqual([
      {
        event: "request.5xx",
        level: "error",
        requestId: RAY,
        officeId: "off_abcdefgh23456789",
        route: "/o/:office/busy",
        method: "GET",
        status: 503,
        ms: expect.any(Number),
      },
    ]);
    await small.request("/o/off_abcdefgh23456789/fine");
    await small.request("/o/off_abcdefgh23456789/gone");
    expect(out).toHaveBeenCalledTimes(1);
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("the service's own lines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("all go through the logger", () => {
    const src = join(import.meta.dirname, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && f !== "log.ts");
    const raw = files.flatMap((f) =>
      readFileSync(join(src, f), "utf8")
        .split("\n")
        .map((text, i) => ({ at: `${f}:${i + 1}`, text }))
        .filter(({ text }) => /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(text)),
    );
    expect(raw.map((r) => r.at)).toEqual([]);
  });

  it("from the nightly cron name the step that failed, all under the run's own id", async () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // No database and no bucket: the purge and the retention sweep both fail; with no store in India, there is nothing to erase.
    await worker.scheduled({} as ScheduledController, env());
    const failed = lines(out);
    expect(failed.map((l) => [l.event, l.step])).toEqual([
      ["nightly.failed", "purge"],
      ["nightly.failed", "sweep-retained"],
    ]);
    expect(failed[0]?.requestId).toMatch(UUID);
    expect(failed[1]?.requestId).toBe(failed[0]?.requestId);
    expect(failed[0]?.errorName).toBe("TypeError");
  });

  it("from a failed export name the office and the request", async () => {
    const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withRequest(RAY, async () => {
      inOffice("off_abcdefgh23456789");
      const { body, done } = exportArchive({ id: "x", parts: 1, entries: 1 }, async () => new Response("no", { status: 500 }));
      body.pipeTo(new WritableStream()).catch(() => undefined);
      await done;
    });
    expect(lines(out)).toEqual([
      {
        event: "export.failed",
        level: "error",
        requestId: RAY,
        officeId: "off_abcdefgh23456789",
        errorName: "Error",
        error: "The office could not write part 1 of the export (500).",
      },
    ]);
  });
});

describe("Workers Logs", () => {
  const config = (env?: string) =>
    unstable_readConfig({ config: join(import.meta.dirname, "..", "wrangler.jsonc"), env }, { hideWarnings: true }) as unknown as {
      observability?: Record<string, unknown>;
    };

  it("keep every line, live and on staging, without the query strings of Cloudflare's own request logs", () => {
    for (const env of [undefined, "staging"])
      expect(config(env).observability, env ?? "live").toEqual({
        enabled: true,
        // The free plan's limit is met by logging little, never by sampling: a sampled-away error is an alert that never fires.
        head_sampling_rate: 1,
        redact_query_string: true,
        logs: { enabled: true, invocation_logs: true },
        issues: { enabled: true },
      });
  });
});
