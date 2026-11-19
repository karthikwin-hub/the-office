import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";

/**
 * The one inline script in apps/web/index.html, which paints the last skin before the app loads.
 * A test recomputes it from the file, so changing that script without this hash fails the suite.
 */
export const SKIN_SCRIPT_HASH = "sha256-tJv0DiI8/AMnmm2th+DWl044vw9xtRxT3PJDERoKg7U=";
/** Cloudflare Turnstile, for a sign-in challenge: its script and the frame it draws. */
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * The web app's policy. Scripts only from this origin (plus the skin script by hash); styles allow inline because charts
 * write <style> into their SVG; the live WebSocket goes to this host or another office address on APP_DOMAIN.
 * apps/web/public/_headers carries the same text for pages the asset server sends without the Worker; a test keeps them equal.
 */
export function appCsp(env: Pick<Env, "APP_DOMAIN">): string {
  const domain = env.APP_DOMAIN?.toLowerCase();
  const sockets = domain ? ` wss://${domain} wss://*.${domain}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' '${SKIN_SCRIPT_HASH}' ${TURNSTILE}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${sockets}`,
    "worker-src 'self'",
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Everything that is not a page (JSON, files, redirects) loads nothing and runs nothing. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** On every response, page or not. HSTS without preload: adding the domain to browsers' preload lists is the owner's call. */
export const BASE_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "permissions-policy": "accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()",
};

/**
 * The chat widget's script and API run on a business's own website: they keep their CORS and get no framing rules,
 * which mean nothing to a script or a fetch and are not ours to set for someone else's page.
 */
const EMBEDDED = /^\/(w\/[^/]+$|api\/chat\/)/;

/** Security headers on every response the Worker sends. A route that set its own policy (a stored file) keeps it. */
export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  // A WebSocket upgrade cannot be copied into a new Response, and its headers do not reach a page.
  if (c.res.status === 101) return;
  // Responses from a Durable Object or the asset server have read-only headers; a copy does not.
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.headers.set(k, v);
  if (!EMBEDDED.test(new URL(c.req.url).pathname)) {
    res.headers.set("x-frame-options", "DENY");
    if (!res.headers.has("content-security-policy")) res.headers.set("content-security-policy", /^text\/html/i.test(res.headers.get("content-type") ?? "") ? appCsp(c.env) : API_CSP);
  }
  // Cleared first so Hono takes the copy as it is instead of copying it again.
  c.res = undefined;
  c.res = res;
};
