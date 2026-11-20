#!/usr/bin/env node
// Runs the real Worker for the end-to-end tests, entirely on this machine: `wrangler dev --local` with the live app's
// configuration (apps/api/wrangler.jsonc) less what needs Cloudflare (the account, routes, Workers AI) and the nightly cron,
// with a fresh local D1,
// R2 and Durable Object store under e2e/.state, and the web app the Worker serves from apps/web/dist (`pnpm build` first).
//
// The two secrets are random for each run and passed as --var, as the `api-local` launch entry does: nothing is read from
// Infisical, and nothing is written to a file. Email verification is off (the tests have no inbox). Workers AI is absent,
// so documents are read from their text layer only.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const api = join(root, "apps/api");
const state = join(import.meta.dirname, ".state");
export const PORT = Number(process.env.E2E_PORT ?? 8790);

if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  console.error("apps/web/dist is missing: run `pnpm build` first (the Worker serves the web app from it).");
  process.exit(1);
}

/** JSON with comments and trailing commas, as wrangler.jsonc is written. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0, inString = false; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("wrangler.jsonc: a /* comment is not closed");
      i = end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const live = parseJsonc(readFileSync(join(api, "wrangler.jsonc"), "utf8"));
const { account_id: _account, routes: _routes, env: _envs, ai: _ai, triggers: _cron, ...config } = live;
config.main = join(api, live.main);
config.assets = { ...live.assets, directory: join(api, live.assets.directory) };
config.d1_databases = live.d1_databases.map((d) => ({ ...d, migrations_dir: join(api, d.migrations_dir) }));
config.vars = {
  ...live.vars,
  BETTER_AUTH_URL: `http://localhost:${PORT}`,
  APP_DOMAIN: "",
  PLATFORM_OWNERS: "",
  EMAIL_VERIFICATION: "off",
};

rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
const configPath = join(state, "wrangler.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

const wrangler = join(api, "node_modules/.bin/wrangler");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" };
const migrated = spawnSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "-c", configPath, "--persist-to", state], {
  cwd: state,
  env,
  stdio: "inherit",
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const secret = () => randomBytes(32).toString("hex");
const args = ["dev", "--local", "-c", configPath, "--persist-to", state, "--ip", "127.0.0.1", "--port", String(PORT), "--show-interactive-dev-session=false"];
for (const [k, v] of Object.entries({ BETTER_AUTH_SECRET: secret(), SOCIAL_TOKEN_KEY: secret() })) args.push("--var", `${k}:${v}`);
const dev = spawn(wrangler, args, { cwd: state, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => dev.kill(signal));
dev.on("exit", (code) => process.exit(code ?? 0));
