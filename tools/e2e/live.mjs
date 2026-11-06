#!/usr/bin/env node
// End-to-end check of the live office against `wrangler dev` (or a deployment).
//
//   node tools/e2e/live.mjs [baseUrl] --owner email:password --accountant email:password
//
// Signs in, lets the background reader take emailed PDFs, checks the desk,
// approves one bill, confirms a second browser sees changes pushed over the
// WebSocket, and that the accountant cannot approve. Last, it brings in existing
// books, which fixes the office's start date. Screenshots go to screenshots/live/.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const [ownerEmail, ownerPassword] = (flag("--owner") ?? "").split(":");
const [acctEmail, acctPassword] = (flag("--accountant") ?? "").split(":");
const base = args[0] ?? "http://localhost:8787";
const out = join(resolve(import.meta.dirname, "../.."), "screenshots/live");
await mkdir(out, { recursive: true });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function signedIn(email, password, name) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(base);
  await page.getByRole("heading", { name: /sign in|open your office/i }).waitFor();
  await page.screenshot({ path: join(out, `signin-${name}.png`) });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  const picker = page.locator(".office-choice").first();
  const consent = page.getByRole("heading", { name: /updated our terms|before you start/i });
  await Promise.race([page.locator(".topbar-business").waitFor(), picker.waitFor(), consent.waitFor()]);
  if (await consent.isVisible()) {
    await page.screenshot({ path: join(out, `consent-${name}.png`) });
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /continue/i }).click();
    await Promise.race([page.locator(".topbar-business").waitFor(), picker.waitFor()]);
    check(true, `${name} accepted the current terms and privacy notice`);
  }
  if (await picker.isVisible()) await picker.click();
  await page.locator(".topbar-business").waitFor();
  return page;
}

const owner = await signedIn(ownerEmail, ownerPassword, "owner");
/** Every office request names the office: `/api/desk` is `/api/o/<office>/desk`. */
const officeId = await owner.evaluate(() => localStorage.getItem("office.active"));
check(Boolean(officeId), `the owner is in office ${officeId}`);
const o = (path) => `/api/o/${officeId}/${path.replace(/^\/api\//, "")}`;
const other = await fetch(`${base}${o("/api/desk")}`);
check(other.status === 401, `the office refuses a request with no session (${other.status})`);
check(await owner.getByRole("button", { name: "Sign out" }).isVisible(), "owner is signed in");

// The background reader takes emailed PDFs as soon as the office opens.
const unread = async (page) => page.evaluate(async (path) => (await (await fetch(path)).json()).length, o("/api/documents/unread"));
let left = await unread(owner);
for (let i = 0; i < 20 && left > 0; i++) {
  await owner.waitForTimeout(1000);
  left = await unread(owner);
}
check(left === 0, `background reader emptied the inbox (${left} left)`);
await owner.waitForTimeout(1500);
check(!(await owner.getByText("reconnecting").isVisible()), "live updates are connected");
await owner.screenshot({ path: join(out, "floor-owner.png") });

await owner.locator(".topbar-nav").getByRole("link", { name: /your desk/i }).click();
await owner.locator(".approval").first().waitFor();
const cards = await owner.locator(".approval").count();
check(cards > 0, `desk shows ${cards} cards`);
await owner.screenshot({ path: join(out, "desk-owner.png") });

const acct = await signedIn(acctEmail, acctPassword, "accountant");
check(await acct.locator(".role-banner").isVisible(), "accountant sees the role banner");
await acct.goto(`${base}/desk`);
await acct.locator(".approval").first().waitFor();
const acctApprove = acct.locator(".approval").filter({ hasText: /post bill/i }).first().locator(".btn-primary");
check((await acctApprove.count()) === 0 || (await acctApprove.isDisabled()), "accountant cannot approve a bill");
await acct.screenshot({ path: join(out, "desk-accountant.png") });

// The owner approves a bill (or a reminder, once the bills are done); the accountant's open desk drops it without a reload.
const bill = owner.locator(".approval:not(.approval-decided)").filter({ hasText: /post bill|send a reminder/i }).first();
const title = (await bill.locator("h3, h2").first().textContent())?.trim() ?? "";
await bill.locator(".btn-primary").click();
const pending = owner.locator(".approval:not(.approval-decided)").filter({ has: owner.getByText(title, { exact: true }) });
for (let i = 0; i < 10 && (await pending.count()) > 0; i++) await owner.waitForTimeout(300);
check((await pending.count()) === 0, `owner approved "${title}"`);
let gone = false;
for (let i = 0; i < 10 && !gone; i++) {
  await acct.waitForTimeout(500);
  gone = !(await acct.getByText(title, { exact: true }).isVisible());
}
check(gone, "the accountant's desk updated over the WebSocket");

// An upload goes to R2 and is read from its text layer in the browser; a bill already in the books is set aside.
await owner.goto(`${base}/rooms/accountant`);
await owner.locator('input[type="file"]').setInputFiles(join(resolve(import.meta.dirname, "../.."), "apps/web/public/docs/doc-p0002.pdf"));
const setAside = owner.locator(".intake").getByText(/already recorded|set aside/i).first();
await setAside.waitFor({ timeout: 20_000 }).catch(() => undefined);
check(await setAside.isVisible(), "an uploaded copy of a recorded bill is set aside");
const stored = await owner.evaluate(async ([path, office]) => {
  const docs = await (await fetch(path)).json();
  const up = docs.find((d) => d.channel === "upload" && d.file.startsWith(`/api/o/${office}/files/`));
  return up ? (await fetch(up.file)).headers.get("content-type") : null;
}, [o("/api/documents"), officeId]);
check(stored === "application/pdf", `the upload is served back from R2 (${stored})`);
await owner.screenshot({ path: join(out, "room-accountant-upload.png") });

const session = await acct.evaluate(async (path) => (await fetch(path)).json(), o("/api/session"));
check(session.role === "accountant" && session.mode === "live", "accountant session is live and read-only");
const spoof = await acct.evaluate(async (path) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-office-as": "owner" }, body: '{"hired":true}' })).status, o("/api/hiring/marketer"));
check(spoof === 403, `accountant cannot hire, even claiming to be the owner (${spoof})`);
const elsewhere = await acct.evaluate(async () => (await fetch("/api/o/off_aaaaaaaaaaaaaaaa/desk")).status);
check(elsewhere === 404, `an office the accountant is not in does not exist for them (${elsewhere})`);
const old = await owner.evaluate(async () => (await fetch("/api/desk")).status);
check(old === 404, `the old single-office paths are gone (${old})`);

// Social media: demo channels without a stored sign-in post by hand, and nothing reaches the Office unsigned.
const social = await owner.evaluate(async (path) => (await fetch(path)).json(), o("/api/reports/social"));
check(social.channels.every((c) => c.mode === "manual" || c.connectedAt), "channels without a stored sign-in are posted by hand");
const unsigned = await fetch(`${base}/api/hooks/meta`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"object":"instagram","entry":[]}' });
check(unsigned.status === 401, `an unsigned Meta webhook is refused (${unsigned.status})`);
const handshake = await fetch(`${base}/api/hooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
check(handshake.status === 403, `a webhook handshake with the wrong token is refused (${handshake.status})`);
const media = await fetch(`${base}/media/${officeId}/media-u1?exp=9999999999&sig=forged`);
check(media.status === 404, `a forged media link finds nothing (${media.status})`);
const acctConnect = await acct.evaluate(async (path) => (await fetch(path, { redirect: "manual" })).status, o("/api/channels/instagram/connect"));
check(acctConnect === 403, `the accountant cannot connect a channel (${acctConnect})`);
const acctVoice = await acct.evaluate(async (path) => (await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, o("/api/social/voice"));
check(acctVoice === 403, `the accountant cannot change the brand voice (${acctVoice})`);

await owner.goto(`${base}/rooms/social-media-manager`);
await owner.locator(".channel-strip").waitFor();
check((await owner.locator(".channel-bay").count()) === social.channels.length, "the room shows every channel");
await owner.screenshot({ path: join(out, "room-social-media-manager.png"), fullPage: true });

const manual = social.posts.flatMap((p) => p.variants.filter((v) => v.status === "scheduled" && social.channels.find((c) => c.id === v.channelId)?.mode === "manual").map((v) => [p.id, v.channelId]))[0];
if (manual) {
  const [postId, channelId] = manual;
  const pack = await owner.evaluate(async (path) => (await fetch(path)).json(), o(`/api/social/posts/${postId}/variants/${channelId}/pack`));
  check(pack.text?.length > 0 && pack.steps?.length > 0, `a publishing pack is ready for ${channelId}`);
  const posted = await owner.evaluate(
    async ([path, url]) => (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) })).json(),
    [o(`/api/social/posts/${postId}/variants/${channelId}/posted`), `https://example.com/e2e/${postId}/${channelId}`],
  );
  check(posted.variants?.find((v) => v.channelId === channelId)?.status === "published", `Mark as posted records ${postId} on ${channelId}`);
}

await owner.goto(`${base}${o("/api/channels/instagram/connect")}`);
await owner.waitForURL(/\/settings/);
check(/connect_error=/.test(owner.url()), "connecting without the platform's keys comes back with a reason");
await owner.locator("#channels").waitFor();
await owner.screenshot({ path: join(out, "settings-channels.png"), fullPage: true });

// Routines: every scheduled job is listed with its owner, and running one now records a run.
const routines = await owner.evaluate(async (path) => (await fetch(path)).json(), o("/api/routines"));
check(routines.routines?.some((r) => r.id === "morning-digest" && r.active), "the morning digest is listed as a routine");
const ran = await owner.evaluate(async (path) => {
  const r = await fetch(path, { method: "POST" });
  return { status: r.status, body: await r.json() };
}, o("/api/routines/compliance-due/run"));
check(ran.status === 200 || ran.status === 409, `running a routine now is recorded or refused with a reason (${ran.status})`);
const runs = await owner.evaluate(async (path) => (await fetch(path)).json(), o("/api/routines/compliance-due/runs"));
check(ran.status !== 200 || runs.runs?.[0]?.trigger === "manual", "the manual run is in the routine's history");
const acctRun = await acct.evaluate(async (path) => (await fetch(path, { method: "POST" })).status, o("/api/routines/compliance-due/run"));
check(acctRun === 403, `the accountant cannot run a routine (${acctRun})`);
await owner.goto(`${base}/routines`);
await owner.locator(".routine").first().waitFor();
check((await owner.locator(".routine").count()) >= 5, "the Routines page lists the office's routines");
await owner.screenshot({ path: join(out, "routines.png"), fullPage: true });

// Customer service: a website visitor asks for a refund, the agent hands it over, the owner answers and the visitor sees it.
const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ownerFetch = (path, init) => owner.evaluate(async ([p, i]) => {
  const r = await fetch(p, i);
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, init]);
const hiring = await ownerFetch(o("/api/hiring"));
const wasHired = hiring.body?.agents?.find((a) => a.agentId === "customer-service")?.hired ?? false;
await ownerFetch(o("/api/hiring/customer-service"), json("POST", { hired: true, trustLevel: "trusted" }));
const widget = await ownerFetch(o("/api/customers/widget"), json("PUT", { enabled: true }));
const key = widget.body?.key;
check(Boolean(key), `turning on the website chat gives it a key (${key})`);
const script = await fetch(`${base}/w/${key}.js`);
check(script.status === 200 && (script.headers.get("content-type") ?? "").includes("javascript"), `the chat script is served publicly (${script.status})`);
const visitor = `e2e-visitor-${Date.now().toString(36)}-abcdef`;
const chat = await fetch(`${base}/api/chat/${key}`, json("POST", { visitor, text: "Two coils arrived damaged, I want a refund." }));
check(chat.status === 200, `a visitor's message is taken without signing in (${chat.status})`);
const desk = await ownerFetch(o("/api/customers"));
const thread = desk.body?.threads?.find((t) => t.key === visitor);
check(thread?.status === "handed_off", `a refund is handed to the owner (${thread?.status})`);
const answer = "Sorry about that. Send us a photo and we will replace them.";
const replied = await ownerFetch(o(`/api/customers/threads/${thread?.id}/reply`), json("POST", { text: answer }));
check(replied.status === 200, `the owner answers in the conversation (${replied.status})`);
const seen = await (await fetch(`${base}/api/chat/${key}?visitor=${visitor}`)).json();
check(seen.messages?.some((m) => m.from === "us" && m.text === answer), "the visitor sees the owner's answer in the chat");
const acctReply = await acct.evaluate(async ([p, b]) => (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: b })).status, [o(`/api/customers/threads/${thread?.id}/reply`), JSON.stringify({ text: "x" })]);
check(acctReply === 403, `the accountant cannot answer customers (${acctReply})`);
await owner.goto(`${base}/rooms/customer-service`);
await owner.locator(".cs-threads").waitFor();
await owner.screenshot({ path: join(out, "room-customer-service.png"), fullPage: true });
await ownerFetch(o("/api/customers/widget"), json("PUT", { enabled: false }));
const closed = await fetch(`${base}/w/${key}.js`);
check(closed.status === 404, `the chat script is gone once the chat is off (${closed.status})`);
if (!wasHired) await ownerFetch(o("/api/hiring/customer-service"), json("POST", { hired: false }));

// The Lived-in skin draws the team as people over the same floor; rooms still open and only the owner renames anyone.
await owner.goto(`${base}/?skin=lived-in`);
await owner.locator(".floor-plan-overlay .person").first().waitFor();
check((await owner.locator(".floor-plan-overlay .person").count()) > 0, "the Lived-in floor draws the team");
const weather = await ownerFetch(o("/api/weather"));
check(weather.status === 200 && "weather" in (weather.body ?? {}), `the weather answers, or says it does not know (${JSON.stringify(weather.body)})`);
const renamed = await ownerFetch(o("/api/personas"), json("PUT", { names: { accountant: "Revathi" } }));
check(renamed.status === 200, `the owner renames the accountant (${renamed.status})`);
const acctRename = await acct.evaluate(async (p) => (await fetch(p, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"names":{}}' })).status, o("/api/personas"));
check(acctRename === 403, `the accountant cannot rename the team (${acctRename})`);
await owner.reload();
await owner.locator(".floor-plan-overlay .person").first().waitFor();
await owner.waitForTimeout(1500);
check(await owner.locator(".team-log-who").getByText("Revathi, Accountant").first().isVisible(), "the team log uses the new name");
await owner.screenshot({ path: join(out, "floor-lived-in.png") });
await owner.locator(".room-slot").filter({ hasText: /office manager/i }).first().click();
await owner.waitForURL(/\/rooms\/office-manager/);
check(true, "a room still opens through the people drawn over it");
await ownerFetch(o("/api/personas"), json("PUT", { names: {} }));

// Bringing in existing books: the accountant checks and sends the files, the owner approves one Desk card,
// and the unpaid invoice counts towards ageing with its CSV kept in R2. Last, because it fixes the books' start date.
const asOf = (await ownerFetch(o("/api/settings"))).body?.business?.asOf;
const booksFrom = `${asOf.slice(0, 8)}01`;
const before = new Date(Date.parse(`${booksFrom}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/");
const tag = Date.now().toString(36).toUpperCase();
const csv = {
  parties: `type,name,state,city,payment_terms_days\ncustomer,E2E Traders ${tag},Karnataka,Mysuru,30\n`,
  "open-items": `type,number,date,party,total,outstanding\ninvoice,E2E/${tag}/1,${before},E2E Traders ${tag},"25,000","12,500"\n`,
};
await acct.goto(`${base}/settings`);
const onboarding = acct.locator("section", { has: acct.getByRole("heading", { name: "Bring in your books" }) });
await onboarding.waitFor();
await onboarding.getByLabel("Books start on").fill(booksFrom);
await onboarding.getByLabel("Customers and suppliers").setInputFiles({ name: "parties.csv", mimeType: "text/csv", buffer: Buffer.from(csv.parties) });
await onboarding.getByLabel("Unpaid invoices and bills").setInputFiles({ name: "open-items.csv", mimeType: "text/csv", buffer: Buffer.from(csv["open-items"]) });
await onboarding.getByRole("button", { name: "Check the files" }).click();
await onboarding.locator(".onboarding-ready, [role=alert]").first().waitFor();
check(await onboarding.locator(".onboarding-ready").isVisible(), "the accountant's files read without an issue");
await onboarding.getByRole("button", { name: "Send to the Desk for approval" }).click();
await onboarding.getByRole("status").filter({ hasText: "Waiting on the" }).waitFor();
await acct.screenshot({ path: join(out, "settings-onboarding.png"), fullPage: true });
const huge = await acct.evaluate(async (p) => (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(3_100_000) })).status, o("/api/onboarding/check"));
check(huge === 413, `an import over the size limit is refused (${huge})`);
const importCard = (await ownerFetch(o("/api/desk"))).body?.items?.find((i) => i.kind === "onboarding");
check(Boolean(importCard), "the import waits on the owner's Desk");
const acctImport = await acct.evaluate(async (p) => (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"approve"}' })).status, o(`/api/desk/${importCard?.id}`));
check(acctImport === 403, `the accountant cannot approve the import (${acctImport})`);
await owner.goto(`${base}/desk`);
const card = owner.locator(".approval:not(.approval-decided)").filter({ hasText: "Bring in your books" });
await card.waitFor();
await owner.screenshot({ path: join(out, "desk-onboarding.png") });
await card.getByRole("button", { name: "Bring into the books" }).click();
for (let i = 0; i < 10 && (await card.count()) > 0; i++) await owner.waitForTimeout(300);
const ageing = (await ownerFetch(o("/api/reports/ageing"))).body;
check(ageing?.open?.some((x) => x.number === `E2E/${tag}/1` && x.outstandingPaise === 12_500_00), "the brought-forward invoice counts towards ageing");
const settled = (await ownerFetch(o("/api/settings"))).body?.business?.booksFrom;
check(settled === booksFrom, `the books now start on ${settled}`);
const kept = await owner.evaluate(async ([path, office]) => {
  const docs = await (await fetch(path)).json();
  const d = docs.find((x) => x.channel === "import" && x.file.startsWith(`/api/o/${office}/files/`));
  if (!d) return null;
  const r = await fetch(d.file);
  return `${r.headers.get("content-type")} ${(await r.text()).split("\n")[0]}`;
}, [o("/api/documents"), officeId]);
check(kept === "text/csv; charset=utf-8 type,number,date,party,total,outstanding", `the CSV is kept and served back (${kept})`);

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");
