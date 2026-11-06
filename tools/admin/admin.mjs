#!/usr/bin/env node
// Looking after the offices on the live database. Run it through Infisical so wrangler has the account's token:
//
//   infisical run --env=dev --silent -- node tools/admin/admin.mjs <command> [args]
//
//   list                                 every office: status, people, routes, history, last activity
//   suspend <office> | resume <office>   closes an office to its people, or opens it again
//   invite-owner <office> <email>        a new owner invitation link, for an office that lost its owner
//   route <office> <kind> <external id>  sends a page, account or WhatsApp number (kind wa_phone) to an office
//   purge-soon <office>                  a deleted office is purged at the next nightly run instead of after 30 days
//   backup                               the whole control plane as SQL, into backups/
//   forget-user <email>                  removes a person's account, sessions, memberships, WhatsApp link and consent records (DPDP request)
//   requests [done <id>]                 lists the open "Delete my account" requests, or completes one
//   subdomain <office> <label>           gives an office its own address, <label>.APP_DOMAIN, in two runs (see below)
//   subdomain <office> --remove          takes it away again; the office opens on the console
//
// Add --local to work on `wrangler dev`'s database instead.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const api = join(root, "apps/api");
const args = process.argv.slice(2);
const local = args.includes("--local");
const [command, ...rest] = args.filter((a) => a !== "--local");
const OFFICE = /^(off_[a-z2-9]{16}|kaveri-electricals)$/;
const KINDS = new Set(["email", "wa_phone", "meta_page", "ig_account", "threads", "linkedin", "x", "support_email", "widget"]);
const env = { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN_SNILLD_OFFICE };
const lit = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const CONFIG = join(api, "wrangler.jsonc");
const configVar = (name) => new RegExp(`"${name}":\\s*"([^"]+)"`).exec(readFileSync(CONFIG, "utf8"))?.[1] ?? null;
// The same rules as `subdomainProblem` in packages/contracts/src/api.ts.
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;
const RESERVED = new Set(["console", "demo", "www", "app", "api", "admin", "auth", "mail", "email", "in", "help", "support", "status", "docs", "blog", "static", "cdn", "assets", "media", "dev", "staging", "test"]);
const END_OF_CUSTOMERS = "// customers end";

function wrangler(...a) {
  return execFileSync(join(api, "node_modules/.bin/wrangler"), a, { cwd: api, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
function sql(query) {
  const out = JSON.parse(wrangler("d1", "execute", "office", local ? "--local" : "--remote", "--json", "--command", query));
  return out.flatMap((r) => r.results ?? []);
}
function office(id) {
  if (!OFFICE.test(id ?? "")) fail(`Not an office id: ${id}`);
  const [o] = sql(`SELECT id, name, status FROM office WHERE id = ${lit(id)}`);
  if (!o) fail(`No office ${id}`);
  return o;
}
function audit(id, action, detail = null) {
  return `INSERT INTO audit (office_id, actor, action, detail, at) VALUES (${lit(id)}, 'admin', ${lit(action)}, ${lit(detail)}, ${Date.now()})`;
}
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The account, its sign-ins, memberships, WhatsApp link and consent records go; each office's audit says so first. */
function forgetUser(email) {
  const [u] = sql(`SELECT id, name FROM user WHERE lower(email) = ${lit(email)}`);
  if (!u) fail(`No account for ${email}.`);
  const sole = sql(`SELECT o.id, o.name FROM membership m JOIN office o ON o.id = m.office_id WHERE m.user_id = ${lit(u.id)} AND m.role = 'owner'
    AND (SELECT COUNT(*) FROM membership x WHERE x.office_id = m.office_id AND x.role = 'owner') = 1`);
  if (sole.length) fail(`${u.name} is the only owner of ${sole.map((o) => `${o.name} (${o.id})`).join(", ")}. Hand those over or delete them first.`);
  const offices = sql(`SELECT office_id FROM membership WHERE user_id = ${lit(u.id)}`);
  sql(`${offices.map((o) => `${audit(o.office_id, "member.forgotten", "account removed on request")};`).join(" ")}
    DELETE FROM wa_code WHERE user_id = ${lit(u.id)}; DELETE FROM wa_link WHERE user_id = ${lit(u.id)};
    DELETE FROM membership WHERE user_id = ${lit(u.id)}; DELETE FROM invitation WHERE email = ${lit(email)};
    DELETE FROM consent WHERE user_id = ${lit(u.id)};
    DELETE FROM session WHERE user_id = ${lit(u.id)}; DELETE FROM account WHERE user_id = ${lit(u.id)}; DELETE FROM user WHERE id = ${lit(u.id)}`);
  console.log(`Removed ${u.name}'s account from ${offices.length} offices. Their name may remain in those offices' books, where the business keeps it as a record.`);
}

/**
 * An office's own address takes two runs. The first adds `<label>.APP_DOMAIN` to the Worker's custom domains in
 * wrangler.jsonc, to be committed and deployed. The second checks that the address answers, then switches the office
 * over: from then on the console sends its people there. With --local only the database changes.
 */
async function subdomain(o, label) {
  const domain = local ? "office.localhost" : configVar("APP_DOMAIN");
  if (!domain) fail("APP_DOMAIN is not set in apps/api/wrangler.jsonc.");
  const text = readFileSync(CONFIG, "utf8");
  if (label === "--remove") {
    const [row] = sql(`SELECT subdomain FROM office WHERE id = ${lit(o.id)}`);
    if (!row?.subdomain) fail(`${o.name} has no address of its own.`);
    sql(`UPDATE office SET subdomain = NULL WHERE id = ${lit(o.id)}; ${audit(o.id, "office.subdomain", "removed")}`);
    const line = new RegExp(`^.*"${row.subdomain}\\.${domain.replace(/\./g, "\\.")}".*\\n`, "m");
    if (!local && line.test(text)) writeFileSync(CONFIG, text.replace(line, ""));
    console.log(`${o.name} opens on the console again.${local ? "" : ` Removed ${row.subdomain}.${domain} from wrangler.jsonc: commit and deploy to take the address down.`}`);
    return;
  }
  if (!SUBDOMAIN.test(label)) fail("Use 2 to 32 lower-case letters, digits or hyphens, starting and ending with a letter or digit.");
  if (RESERVED.has(label)) fail(`"${label}" is kept for the product itself; choose another.`);
  const [taken] = sql(`SELECT id, name FROM office WHERE subdomain = ${lit(label)}`);
  if (taken && taken.id !== o.id) fail(`${label}.${domain} already belongs to ${taken.name} (${taken.id}).`);
  const host = `${label}.${domain}`;
  if (!local && !text.includes(`"${host}"`)) {
    if (!text.includes(END_OF_CUSTOMERS)) fail(`Could not find "${END_OF_CUSTOMERS}" in apps/api/wrangler.jsonc.`);
    writeFileSync(CONFIG, text.replace(END_OF_CUSTOMERS, `{ "pattern": "${host}", "custom_domain": true },\n    ${END_OF_CUSTOMERS}`));
    console.log(`Added ${host} to apps/api/wrangler.jsonc for ${o.name}.\nNext: commit it, deploy, wait a few minutes for the certificate, then run this same command again.`);
    return;
  }
  if (!local) {
    const health = await fetch(`https://${host}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (health?.appDomain !== domain) fail(`https://${host} is not answering as the office yet. Check the deploy finished; a new certificate can take up to 15 minutes. Then run this again.`);
  }
  sql(`UPDATE office SET subdomain = ${lit(label)} WHERE id = ${lit(o.id)}; ${audit(o.id, "office.subdomain", host)}`);
  console.log(`${o.name} now opens on ${local ? "http" : "https"}://${host}${local ? ":8787" : ""}. Its people are sent there from the console.`);
}

switch (command) {
  case "list": {
    const rows = sql(`SELECT o.id, o.name, o.status, o.created_at,
      (SELECT COUNT(*) FROM membership m WHERE m.office_id = o.id) AS people,
      (SELECT COUNT(*) FROM route r WHERE r.office_id = o.id) AS routes,
      (SELECT COUNT(*) FROM audit a WHERE a.office_id = o.id) AS events,
      (SELECT MAX(at) FROM audit a WHERE a.office_id = o.id) AS last_at
      FROM office o ORDER BY o.created_at`);
    const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
    console.table(rows.map((r) => ({ id: r.id, name: r.name, status: r.status, opened: day(r.created_at), people: r.people, routes: r.routes, events: r.events, "last activity": day(r.last_at) })));
    break;
  }
  case "suspend":
  case "resume": {
    const o = office(rest[0]);
    const status = command === "suspend" ? "suspended" : "active";
    sql(`UPDATE office SET status = ${lit(status)}, deleted_at = NULL WHERE id = ${lit(o.id)}; ${audit(o.id, `office.${status}`)}`);
    console.log(`${o.name} is ${status}.`);
    break;
  }
  case "invite-owner": {
    const o = office(rest[0]);
    const email = (rest[1] ?? "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) fail("Give the owner's email address.");
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("base64url");
    const at = Date.now();
    sql(`INSERT INTO invitation (office_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (${lit(o.id)}, ${lit(email)}, 'owner', ${lit(hash)}, 'admin', ${at}, ${at + 14 * 86400_000})
      ON CONFLICT (office_id, email) DO UPDATE SET role = 'owner', token_hash = excluded.token_hash, invited_by = 'admin', created_at = excluded.created_at, expires_at = excluded.expires_at, accepted_at = NULL;
      ${audit(o.id, "invitation.sent", `${email} as owner`)}`);
    const base = local ? "http://localhost:8787" : configVar("BETTER_AUTH_URL");
    console.log(`Owner invitation for ${email} to ${o.name}, good for 14 days. Send them this link:\n${base}/?invite=${token}`);
    break;
  }
  case "route": {
    const o = office(rest[0]);
    const [kind, external] = rest.slice(1);
    if (!KINDS.has(kind) || !external) fail(`route <office> <${[...KINDS].join("|")}> <external id>`);
    const [taken] = sql(`SELECT office_id FROM route WHERE kind = ${lit(kind)} AND external_id = ${lit(external)}`);
    if (taken && taken.office_id !== o.id) fail(`${kind} ${external} already goes to ${taken.office_id}.`);
    sql(`INSERT INTO route (kind, external_id, office_id, created_at) VALUES (${lit(kind)}, ${lit(external)}, ${lit(o.id)}, ${Date.now()}) ON CONFLICT DO NOTHING; ${audit(o.id, "route.added", `${kind} ${external}`)}`);
    console.log(`${kind} ${external} now goes to ${o.name}.`);
    break;
  }
  case "purge-soon": {
    const o = office(rest[0]);
    if (o.status !== "deleting") fail(`${o.name} is ${o.status}; only a deleted office can be purged.`);
    sql(`UPDATE office SET deleted_at = 0 WHERE id = ${lit(o.id)}; ${audit(o.id, "office.purge-soon")}`);
    console.log(`${o.name} will be purged at the next nightly run (21:30 UTC).`);
    break;
  }
  case "backup": {
    const dir = join(root, "backups");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `office-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.sql`);
    wrangler("d1", "export", "office", local ? "--local" : "--remote", "--output", file);
    console.log(`Saved ${file}. It holds account data: keep it out of git and delete it when done.`);
    break;
  }
  case "forget-user": {
    forgetUser((rest[0] ?? "").trim().toLowerCase());
    break;
  }
  case "requests": {
    const [action, id] = rest;
    if (!action) {
      const open = sql("SELECT id, email, kind, note, created_at FROM rights_request WHERE status = 'open' ORDER BY created_at");
      const day = (ms) => new Date(ms).toISOString().slice(0, 10);
      if (!open.length) console.log("No open requests.");
      else console.table(open.map((r) => ({ id: r.id, email: r.email, kind: r.kind, asked: day(r.created_at), "days open": Math.floor((Date.now() - r.created_at) / 86400_000), note: r.note ?? "" })));
      break;
    }
    if (action !== "done" || !/^req_[0-9a-f-]{36}$/.test(id ?? "")) fail("requests            lists the open requests\nrequests done <id>  completes one: deletes the account it asks about");
    const [r] = sql(`SELECT id, email, kind, status FROM rights_request WHERE id = ${lit(id)}`);
    if (!r) fail(`No request ${id}`);
    if (r.status !== "open") fail(`Request ${id} is already ${r.status}.`);
    forgetUser(r.email);
    sql(`UPDATE rights_request SET status = 'done', done_at = ${Date.now()}, done_by = 'admin' WHERE id = ${lit(id)}`);
    console.log(`Request ${id} is done.`);
    break;
  }
  case "subdomain": {
    await subdomain(office(rest[0]), rest[1] ?? "");
    break;
  }
  default:
    console.log(`Commands: list, suspend, resume, invite-owner, route, purge-soon, backup, forget-user, requests, subdomain. See the top of ${import.meta.filename}.`);
    process.exit(command ? 1 : 0);
}
