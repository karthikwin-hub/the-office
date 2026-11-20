import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unstable_readConfig } from "wrangler";
import { describe, expect, it } from "vitest";

/** Releases: the staging Worker shares nothing with live, and tools/admin/deploy.sh deploys only the target it is given. */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIG = join(ROOT, "apps", "api", "wrangler.jsonc");
/** The parts of wrangler's resolved configuration these tests read. */
type Named = { binding: string; name: string; database_name: string; database_id: string; bucket_name: string; namespace_id: string };
type Config = {
  name?: string;
  routes?: unknown[];
  workers_dev?: boolean;
  vars: Record<string, unknown>;
  d1_databases: Named[];
  r2_buckets: Named[];
  durable_objects: { bindings: Named[] };
  send_email: Named[];
  ratelimits: Named[];
  ai?: { binding: string };
};
// Resolved as wrangler deploys it, inheritance included.
const read = (env?: string) => unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true }) as unknown as Config;

describe("the staging environment", () => {
  const live = read();
  const staging = read("staging");

  it("is its own Worker on workers.dev, with no custom domain", () => {
    expect(staging.name).toBe("the-office-staging");
    expect(staging.name).not.toBe(live.name);
    // Routes are inherited: without an empty list staging would take live's custom domains.
    expect(staging.routes).toEqual([]);
    expect(staging.workers_dev).toBe(true);
  });

  it("names no live database, bucket or rate-limit namespace", () => {
    const ldb = live.d1_databases[0]!;
    const sdb = staging.d1_databases[0]!;
    expect(sdb.binding).toBe("DB");
    expect(sdb.database_name).not.toBe(ldb.database_name);
    expect(sdb.database_id).not.toBe(ldb.database_id);
    expect(staging.r2_buckets.map((b) => b.bucket_name)).not.toContain(live.r2_buckets[0]!.bucket_name);
    expect(staging.ratelimits.map((r) => r.namespace_id)).not.toContain(live.ratelimits[0]!.namespace_id);
  });

  it("has every binding and setting live has", () => {
    const names = (c: Config) => [
      ...c.d1_databases.map((b) => b.binding),
      ...c.r2_buckets.map((b) => b.binding),
      ...c.durable_objects.bindings.map((b) => b.name),
      ...c.send_email.map((b) => b.name),
      ...c.ratelimits.map((b) => b.name),
      c.ai?.binding,
      ...Object.keys(c.vars),
    ];
    expect(names(staging).sort()).toEqual(names(live).sort());
    expect(staging.durable_objects.bindings).toEqual(live.durable_objects.bindings);
  });

  it("signs people in on a host the live sign-in cookie never reaches", () => {
    const liveDomain = String(live.vars.APP_DOMAIN);
    const host = new URL(String(staging.vars.BETTER_AUTH_URL)).hostname;
    expect(host === liveDomain || host.endsWith(`.${liveDomain}`)).toBe(false);
    expect(staging.vars.APP_DOMAIN).toBe("");
    expect(staging.vars.DATA_MODE).toBe("live");
  });
});

/**
 * Runs deploy.sh in a copy of the repository's layout, where `wrangler` and `pnpm` are stand-ins that write what they
 * were asked to a log. Nothing reaches Cloudflare.
 */
function sandbox(opts: { placeholders?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "office-deploy-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  const put = (path: string, text: string, exec = false) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    if (exec) chmodSync(join(dir, path), 0o755);
  };
  for (const f of ["tools/admin/deploy.sh", "tools/admin/admin.mjs"]) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(dir, f));
  }
  const config = readFileSync(CONFIG, "utf8");
  put("apps/api/wrangler.jsonc", opts.placeholders ? config : config.replaceAll("REPLACE_WITH_", "filled-in-"));
  const stub = (name: string) => `#!/bin/sh
echo "${name} $* token=\${CLOUDFLARE_API_TOKEN:-}" >> "${log}"
if [ "${name}" = wrangler ] && [ "$1 $2" = "d1 export" ]; then
  [ -n "\${FAIL_BACKUP:-}" ] && exit 1
  while [ $# -gt 0 ]; do [ "$1" = --output ] && printf 'CREATE TABLE office (id TEXT);' > "$2"; shift; done
fi
exit 0
`;
  put("apps/api/node_modules/.bin/wrangler", stub("wrangler"), true);
  put("bin/pnpm", stub("pnpm"), true);
  put("bin/age", `#!/bin/sh
echo "age $*" >> "${log}"
[ -n "\${FAIL_AGE:-}" ] && exit 1
while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done
cp "$1" "$out"
`, true);
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("sh", [join(dir, "tools/admin/deploy.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, ...env },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    writeFileSync(log, "");
    return { status: r.status, stderr: r.stderr, calls };
  };
  return { dir, run };
}

const STAGING = { CLOUDFLARE_API_TOKEN_OFFICE_STAGING: "staging-token" };
const LIVE = { CLOUDFLARE_API_TOKEN_SNILLD_OFFICE: "live-token" };

describe("deploy.sh", () => {
  it("needs a target, and deploys nothing without one", () => {
    const { run } = sandbox();
    for (const args of [[], ["production"], ["Live"]]) {
      const r = run(args, { ...LIVE, ...STAGING });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/staging\|live\|demo/);
      expect(r.calls).toEqual([]);
    }
  });

  it("deploys staging with staging's token, to --env staging only", () => {
    const { run } = sandbox();
    const r = run(["staging"], { ...LIVE, ...STAGING });
    expect(r.status).toBe(0);
    const wrangler = r.calls.filter((c) => c.startsWith("wrangler "));
    expect(wrangler.length).toBeGreaterThan(0);
    for (const c of wrangler) expect(c).toMatch(/ --env staging token=staging-token$/);
    expect(wrangler.at(-1)).toMatch(/^wrangler deploy /);
    expect(wrangler).toContainEqual(expect.stringMatching(/^wrangler d1 migrations apply DB --remote /));
  });

  it("deploys live with live's token, to the top level", () => {
    const { run } = sandbox();
    const r = run(["live"], { ...LIVE, ...STAGING });
    expect(r.status).toBe(0);
    const wrangler = r.calls.filter((c) => c.startsWith("wrangler "));
    for (const c of wrangler) expect(c).toMatch(/ --env {2}token=live-token$/);
    expect(wrangler.at(-1)).toMatch(/^wrangler deploy /);
  });

  it("stops when the target's own token is missing, even if the other one is there", () => {
    const { run } = sandbox();
    const live = run(["live"], STAGING);
    expect(live.status).toBe(1);
    expect(live.stderr).toMatch(/CLOUDFLARE_API_TOKEN_SNILLD_OFFICE .*--env=prod/);
    expect(live.calls).toEqual([]);
    const staging = run(["staging"], LIVE);
    expect(staging.status).toBe(1);
    expect(staging.stderr).toMatch(/CLOUDFLARE_API_TOKEN_OFFICE_STAGING .*--env=staging/);
    expect(staging.calls).toEqual([]);
  });

  it("refuses staging while wrangler.jsonc still has placeholders", () => {
    const { run } = sandbox({ placeholders: true });
    const r = run(["staging"], STAGING);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REPLACE_WITH_/);
    expect(r.calls).toEqual([]);
  });
});
