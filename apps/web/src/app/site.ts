/**
 * Where this page is. With an app domain (for example `office.snilld.in`), the bare domain is the product page,
 * `app.<domain>` signs businesses in and lists their offices, `console.<domain>` is the platform owners' console,
 * and an office with a subdomain opens on `<subdomain>.<domain>`. Without one (workers.dev, localhost, the
 * mockups), everything is on one host and the console is at `?platform`.
 */
export type Place = { kind: "product" } | { kind: "app" } | { kind: "platform" } | { kind: "office"; subdomain: string } | { kind: "single" };

let appDomain: string | null = null;

/** Asked once, before anything renders; an unreachable Worker leaves the app on one host. */
export async function loadSite(): Promise<void> {
  try {
    const r = await fetch("/api/health");
    appDomain = ((await r.json()) as { appDomain?: string | null }).appDomain ?? null;
  } catch {
    appDomain = null;
  }
}

export const hasAppDomain = () => appDomain !== null;

export function place(host = location.hostname): Place {
  if (!appDomain) return new URLSearchParams(location.search).has("platform") ? { kind: "platform" } : { kind: "single" };
  if (host === appDomain) return { kind: "product" };
  if (!host.endsWith(`.${appDomain}`)) return { kind: "single" };
  const label = host.slice(0, -appDomain.length - 1);
  if (label === "app") return { kind: "app" };
  if (label === "console") return { kind: "platform" };
  return label.includes(".") ? { kind: "single" } : { kind: "office", subdomain: label };
}

const at = (label: string | null, path: string) => {
  if (!appDomain) return path;
  const port = location.port ? `:${location.port}` : "";
  return `${location.protocol}//${label ? `${label}.` : ""}${appDomain}${port}${path}`;
};

/** Where businesses sign in and choose an office. */
export const appUrl = (path = "/") => at("app", path);
export const officeUrl = (subdomain: string, path = "/") => at(subdomain, path);
export const demoUrl = () => at("demo", "/");
