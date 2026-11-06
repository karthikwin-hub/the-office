/**
 * Where this page is. With an app domain (for example `office.snilld.in`), the bare domain is the product page,
 * `console.<domain>` signs people in and lists their offices, and an office with a subdomain opens on
 * `<subdomain>.<domain>`. Without one (workers.dev, localhost, the mockups), everything is on one host.
 */
export type Place = { kind: "product" } | { kind: "console" } | { kind: "office"; subdomain: string } | { kind: "single" };

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
  if (!appDomain) return { kind: "single" };
  if (host === appDomain) return { kind: "product" };
  if (!host.endsWith(`.${appDomain}`)) return { kind: "single" };
  const label = host.slice(0, -appDomain.length - 1);
  if (label === "console") return { kind: "console" };
  return label.includes(".") ? { kind: "single" } : { kind: "office", subdomain: label };
}

const at = (label: string | null, path: string) => {
  if (!appDomain) return path;
  const port = location.port ? `:${location.port}` : "";
  return `${location.protocol}//${label ? `${label}.` : ""}${appDomain}${port}${path}`;
};

export const consoleUrl = (path = "/") => at("console", path);
export const officeUrl = (subdomain: string, path = "/") => at(subdomain, path);
export const demoUrl = () => at("demo", "/");
