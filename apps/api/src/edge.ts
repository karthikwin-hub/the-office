import type { MiddlewareHandler } from "hono";
import { authScope } from "./auth";
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

/** The only stored types a browser may show from the app's origin: they run no script there. */
const INLINE_TYPES: Record<string, string> = { "application/pdf": "application/pdf", "image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/webp": "image/webp" };
/** On every stored file: no script, no plugins, no same-origin access, nothing loaded, and never framed. Chrome still shows a PDF under it. */
export const FILE_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

/**
 * Headers for a file from R2. The stored content type came from whoever sent the file (an email attachment says
 * whatever its sender wrote), so it decides nothing beyond this: a PDF or a photo shows in the browser, anything else
 * downloads as bytes. This also covers objects stored before the check, with any type.
 */
export function fileHeaders(storedType: string | undefined, filename: string | null): Record<string, string> {
  const inline = INLINE_TYPES[(storedType ?? "").split(";")[0]!.trim().toLowerCase()];
  const name = filename?.replace(/["\\\r\n]/g, "") ?? "";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const disposition = `${inline ? "inline" : "attachment"}${name ? `; filename="${ascii}"${ascii === name ? "" : `; filename*=UTF-8''${encodeURIComponent(name)}`}` : ""}`;
  return { "content-type": inline ?? "application/octet-stream", "content-disposition": disposition, "content-security-policy": FILE_CSP, "x-content-type-options": "nosniff" };
}

/**
 * Whether a request's Origin is the app itself: this host, or one of the origins Better Auth trusts (BETTER_AUTH_URL,
 * and APP_DOMAIN with every address under it: the console and each office) on BETTER_AUTH_URL's scheme and port.
 * `null` and anything unparsable are not.
 */
export function ownOrigin(env: Pick<Env, "BETTER_AUTH_URL" | "APP_DOMAIN">, origin: string | null, requestUrl: string): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.origin !== origin.toLowerCase().replace(/\/$/, "")) return false;
  if (o.origin === new URL(requestUrl).origin) return true;
  const scheme = env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).protocol : null;
  return authScope(env).origins.some((t) => (t.startsWith("*.") ? o.protocol === scheme && o.host.endsWith(t.slice(1)) : t === o.origin));
}

/**
 * Cross-origin by design, so not held to the app's Origin: platform webhooks (their signature is the check), the
 * website chat, and platform sign-in callbacks. Sign-in itself is held to it: Better Auth checks the Origin only when
 * a cookie comes with the request, which would let another site sign a visitor into an account of its choosing.
 */
const CROSS_ORIGIN = /^\/api\/(hooks\/|chat\/|channels\/[a-z]+\/callback$)/;
/** What the app sends in a body: JSON, file uploads, and a page pictured in the browser for the scanner. */
const BODY_TYPES = /^(application\/json|multipart\/form-data|image\/(png|jpeg|webp))\s*(;|$)/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Against cross-site requests riding the session cookie: anything under /api that changes something, and the live
 * WebSocket, must come from the app's own pages. The Origin is the defence (browsers send it on every such request);
 * the body type check adds that text/plain and form-encoded bodies, which a plain HTML form sends, are refused.
 * Multipart is a form type too, so uploads rest on the Origin alone.
 */
export const sameOrigin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const upgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
  if ((SAFE_METHODS.has(c.req.method) && !upgrade) || CROSS_ORIGIN.test(new URL(c.req.url).pathname)) return next();
  if (!ownOrigin(c.env, c.req.header("origin") ?? null, c.req.url)) return c.json({ error: "This request did not come from the app. Reload the page and try again." }, 403);
  if (upgrade) return next();
  const type = c.req.header("content-type");
  // A browser's body-less POST says Content-Length: 0, which may still arrive as an empty stream.
  const length = c.req.header("content-length");
  const hasBody = length !== undefined ? length.trim() !== "0" : c.req.header("transfer-encoding") !== undefined || c.req.raw.body !== null;
  if (type ? !BODY_TYPES.test(type) : hasBody) return c.json({ error: "Send this as JSON." }, 415);
  return next();
};
