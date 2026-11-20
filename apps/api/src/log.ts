import { AsyncLocalStorage } from "node:async_hooks";
import type { ErrorHandler, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";

/**
 * The service's logs: one structured line per event, which Workers Logs indexes field by field (a line is logged as an
 * object, not a string, so `event`, `officeId` and the rest can be queried). docs/handbook/04-deployment.md has the queries.
 *
 * A line says what happened and where, never to whom or about what: no secrets, tokens, cookies, request or email
 * bodies, document contents, names, addresses, phone numbers or amounts. It takes only the fields below, never a
 * request, and free text (a fixed message, an error's message) is scrubbed of quoted text and of anything shaped like
 * an email address, phone number, amount, PAN, GSTIN or token.
 */

/** On every response, and on every request the Worker makes to an office: the id that finds a request's lines. */
export const REQUEST_ID_HEADER = "x-request-id";

export type Level = "info" | "warn" | "error";

/** What a line may say besides its event: ids, counts, a route pattern and short fixed text. */
export type Fields = {
  officeId?: string | null;
  route?: string;
  method?: string;
  status?: number | null;
  ms?: number;
  count?: number;
  offices?: number;
  closed?: number;
  step?: string;
  channel?: string;
  until?: string;
  /** Fixed text, written in the code: never built from a person's or a document's data. */
  message?: string;
};

const FIELDS = [
  "route",
  "method",
  "status",
  "ms",
  "count",
  "offices",
  "closed",
  "step",
  "channel",
  "until",
  "message",
] as const satisfies readonly (keyof Fields)[];

/** The request (or cron run, or email) being handled, so every line in it says which one without passing it around. */
type Scope = { requestId: string; officeId: string | null; started: number; logged: boolean };
const scope = new AsyncLocalStorage<Scope>();

/** Ids we put on a line come from Cloudflare or from us; anything else in the header is not taken. */
const ID = /^[\w-]{1,64}$/;
const EVENT = /^[a-z][\w.-]{0,63}$/;

export const newRequestId = () => crypto.randomUUID();

/** Cloudflare's `cf-ray` when there is one (the id in its own request logs), else a new one. */
export function requestIdOf(headers: Headers, header = "cf-ray"): string {
  const v = headers.get(header);
  return v && ID.test(v) ? v : newRequestId();
}

export function withRequest<T>(requestId: string, fn: () => T, officeId: string | null = null): T {
  return scope.run({ requestId: ID.test(requestId) ? requestId : newRequestId(), officeId, started: Date.now(), logged: false }, fn);
}

export const currentRequestId = (): string | null => scope.getStore()?.requestId ?? null;

/** The request is now known to be about this office: its later lines say so. */
export function inOffice(officeId: string) {
  const s = scope.getStore();
  if (s && ID.test(officeId)) s.officeId = officeId;
}

/**
 * Free text loses what could be a person's data or a secret. Fixed messages pass through unchanged. Anything quoted goes
 * first: errors quote the input they choked on (JSON.parse does), and a name or street address cannot be told by its
 * shape, so text a line carries must be written in the code, never built from a person's or a document's data.
 */
const SCRUB: [RegExp, string | ((m: string) => string)][] = [
  [/"[^"]*"|`[^`]*`|(?<!\w)'[^']*'(?!\w)/g, "[quoted]"],
  [/["`].*$/, "[quoted]"],
  [/[^\s@<>"'(),;:[\]]+@[^\s@<>"'(),;:[\]]+/g, "[email]"],
  [/\b(bearer|basic)\s+\S+/gi, "$1 [secret]"],
  [/\b(token|key|secret|password|cookie|session)(\s*[:=]\s*)\S+/gi, "$1$2[secret]"],
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g, "[gstin]"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan]"],
  [/(₹|\brs\.?|\binr)\s*\d[\d,]*(\.\d+)?/gi, "[amount]"],
  [/\+?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[number]" : m)],
  [/[A-Za-z0-9_\-+=]{24,}/g, "[secret]"],
];
const MAX_TEXT = 300;

export function scrub(text: string): string {
  let out = text;
  for (const [re, to] of SCRUB) out = typeof to === "string" ? out.replace(re, to) : out.replace(re, to);
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…` : out;
}

/** A path as a pattern: plain words stay; a segment that could be an id, a name or an address becomes `:id`. */
export const routeOf = (path: string) =>
  path
    .split("?")[0]!
    .split("/")
    .map((s) => (s === "" || /^[a-z][a-z-]{0,30}$/.test(s) ? s : ":id"))
    .join("/")
    .slice(0, 120);

export type Line = Record<string, string | number>;

/** Builds the line: exported for the test that checks what a line can hold. */
export function line(level: Level, event: string, fields: Fields = {}, error?: unknown): Line {
  const s = scope.getStore();
  const out: Line = { event: EVENT.test(event) ? event : "invalid-event", level };
  if (s) out.requestId = s.requestId;
  const officeId = fields.officeId ?? s?.officeId;
  if (officeId && ID.test(officeId)) out.officeId = officeId;
  for (const k of FIELDS) {
    const v = fields[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    // A route is a pattern written in the code (or made by routeOf); everything else is scrubbed.
    else if (typeof v === "string") out[k] = k === "route" ? v.slice(0, 120) : scrub(v);
  }
  if (error !== undefined) {
    out.errorName = error instanceof Error ? scrub(error.name) : typeof error;
    out.error = scrub(error instanceof Error ? error.message : String(error));
  }
  return out;
}

export function log(level: Level, event: string, fields?: Fields, error?: unknown): void {
  const l = line(level, event, fields, error);
  if (level === "error") console.error(l);
  else if (level === "warn") console.warn(l);
  else console.log(l);
}

/**
 * First on every request: takes its id, runs everything after it inside that request's scope, and puts the id on the
 * response. A request that ends in a 5xx gets one line; others none, as Cloudflare's own invocation log (found by the
 * same ray id) already has them and the free plan's 200,000 log events a day must also hold the office's own lines.
 */
export const requestLog: MiddlewareHandler = async (c, next) => {
  const requestId = requestIdOf(c.req.raw.headers);
  await withRequest(requestId, async () => {
    await next();
    const s = scope.getStore();
    if (c.res.status >= 500 && s && !s.logged)
      log("error", "request.5xx", { route: routePath(c), method: c.req.method, status: c.res.status, ms: Date.now() - s.started });
  });
  // A WebSocket upgrade cannot be copied, and its headers reach no page.
  if (c.res.status === 101) return;
  try {
    c.res.headers.set(REQUEST_ID_HEADER, requestId);
  } catch {
    const res = new Response(c.res.body, c.res);
    res.headers.set(REQUEST_ID_HEADER, requestId);
    c.res = undefined;
    c.res = res;
  }
};

export const GENERIC_ERROR = { error: "Something went wrong. Try again." };

/** Anything a route throws: logged once, with its route and error, and answered with words that give nothing away. */
export const requestFailed: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException && err.status < 500) return err.getResponse();
  const s = scope.getStore();
  if (s) s.logged = true;
  log("error", "request.failed", { route: routePath(c), method: c.req.method, status: 500, ms: s ? Date.now() - s.started : undefined }, err);
  return c.json(GENERIC_ERROR, 500);
};
