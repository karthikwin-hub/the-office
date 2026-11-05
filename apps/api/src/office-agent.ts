import { type JoinCode, type Platform, type Role, type StagedChange, PLATFORM_NAMES, Platform as PlatformEnum, ReadRequest, WhatsAppChange, type WhatsAppStatus } from "@office/contracts";
import { digestChannel, dispatch, nextMonth, OfficeService, parseCommand, type ApiResult, type TextItem } from "@office/engine";
import { emptyBooks, loadBooks, SAMPLE_SEED } from "@office/fixtures";
import { Agent } from "agents";
import { EmailMessage } from "cloudflare:email";
import { members } from "./auth";
import type { Env } from "./env";
import { plainMessage } from "./mail";
import { readPrefs, savePrefs } from "./prefs";
import { readScan, readText } from "./reading";
import { PlatformError } from "./social/adapter";
import { SocialHost } from "./social/host";
import { adaptersFor } from "./social";
import { MEDIA_ID } from "./social/media";
import { callbackUrl, newState, readState } from "./social/oauth";
import { TokenVault } from "./social/tokens";
import { parseMetaDelivery, parseWhatsAppMessages } from "./social/webhooks";
import { BooksStore } from "./store";
import { digestCron, istDate } from "./time";
import { sendTemplate, sendText, type WaKeys } from "./whatsapp/cloud";
import { linkFor, linkOf, maskPhone, newJoinCode, sessionFor, unlink, updateLink } from "./whatsapp/links";
import { morningDigest, officeWhatsApp, type WaDeps } from "./whatsapp/office";

export type Caller = { name: string; email: string; role: Role };
export const CALLER_HEADER = "x-office-caller";
export const SYSTEM: Caller = { name: "The Office", email: "office@localhost", role: "owner" };

export type InboundDocs = { from: string | null; subject: string; docs: { id: string; mimeType: string; filename: string }[]; skipped: string[] };

const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_MEDIA = 8 * 1024 * 1024;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
export const newDocId = () => `doc-u${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;

/**
 * One Office per business, and the only writer of its books. It keeps the
 * engine in memory, saves the records that changed after every request, tells
 * open browsers to refresh, and wakes each morning to let trusted agents do
 * their routine work and send the owner a digest.
 */
export class Office extends Agent<Env> {
  private store!: BooksStore;
  private office!: OfficeService;
  private vault!: TokenVault;
  private day = "";

  async onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS office_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.store = new BooksStore(sql);
    this.vault = new TokenVault(sql, this.env.SOCIAL_TOKEN_KEY);
    let books = this.store.load();
    if (books?.seed === SAMPLE_SEED && this.env.OFFICE_SEED !== "sample") {
      // Offices opened before new offices started empty were given the sample business; start them over.
      sql.exec("DELETE FROM office_kv");
      books = null;
    }
    if (!books) {
      books = await this.seed();
      this.store.save(books);
    }
    this.open(books);
    this.store.save(this.office.books);
    await this.scheduleDigest();
    await this.armPublishing();
  }

  private social(): SocialHost {
    return new SocialHost(this.office, this.vault, adaptersFor(this.env), { base: this.env.BETTER_AUTH_URL, mediaSecret: this.env.SOCIAL_TOKEN_KEY, kv: (k, v) => this.kv(k, v) });
  }

  private kv(k: string, v?: string): string | null {
    const sql = this.ctx.storage.sql;
    if (v !== undefined) sql.exec("INSERT INTO office_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
    return sql.exec<{ v: string }>("SELECT v FROM office_kv WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  /** Each person's skin and floor view, kept here so they follow that person to any machine. */
  private async prefs(request: Request, caller: Caller): Promise<Response> {
    const kv = this.kv.bind(this);
    if (request.method === "GET") return json(readPrefs(kv, caller.email));
    if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Not found" }, 404);
    const next = savePrefs(kv, caller.email, await request.json().catch(() => null));
    return next ? json(next) : json({ error: "Invalid preferences" }, 400);
  }

  /** A new office starts empty, named for its owner; the sample business is for demos and tests. */
  private async seed(): Promise<OfficeService["books"]> {
    if (this.env.OFFICE_SEED === "sample") return loadBooks();
    const owner = (await members(this.env)).users.find((u) => u.role === "owner");
    return emptyBooks({ owner: owner?.name ?? "", email: owner?.email, asOf: istDate() });
  }

  private open(books: OfficeService["books"]) {
    this.day = istDate();
    this.office = new OfficeService(books, { asOf: this.day, ingestEmail: this.env.INGEST_EMAIL });
    const saved = this.kv("settings");
    if (saved) this.office.updateSettings(JSON.parse(saved));
    this.social().reconcile();
  }

  /** The books' date follows the calendar in India. */
  private fresh() {
    if (istDate() !== this.day) this.open(this.office.books);
  }

  private commit() {
    const changed = this.store.save(this.office.books);
    const { users: _u, ...settings } = this.office.settings();
    const before = this.kv("settings");
    const after = JSON.stringify(settings);
    if (before !== after) this.kv("settings", after);
    if (changed || before !== after) this.broadcast(JSON.stringify({ type: "changed", at: Date.now() }));
  }

  private async scheduleDigest() {
    const cron = digestCron(this.office.settings().digestTime);
    const existing = this.getSchedules({ type: "cron" }).filter((s) => s.callback === "daily");
    if (existing.length === 1 && existing[0]!.type === "cron" && existing[0]!.cron === cron) return;
    for (const s of existing) await this.cancelSchedule(s.id);
    await this.schedule(cron, "daily");
  }

  /** One alarm for the next thing due: a post's time or a retry. */
  private async armPublishing() {
    const next = this.social().nextWake();
    const existing = this.getSchedules().filter((s) => s.callback === "publishTick");
    if (next && existing.length === 1 && existing[0]!.type === "scheduled" && Math.abs(existing[0]!.time - next) < 1000) return;
    for (const s of existing) await this.cancelSchedule(s.id);
    if (next) await this.schedule(new Date(next), "publishTick");
  }

  /** Whatever the last change asked of the platforms goes out now, then the next alarm is set. */
  private async afterChange() {
    const effects = this.office.takeEffects();
    if (effects.length) await this.social().run(effects);
    await this.armPublishing();
  }

  /** A post's time has come: it is checked again, then published, held back or left for posting by hand. */
  async publishTick() {
    this.fresh();
    this.office.publishDue(new Date().toISOString());
    await this.afterChange();
    this.commit();
  }

  async onRequest(request: Request): Promise<Response> {
    const caller = JSON.parse(request.headers.get(CALLER_HEADER) ?? "null") as Caller | null;
    if (!caller) return json({ error: "Sign in to continue." }, 401);
    this.fresh();
    try {
      const res = await this.route(request, caller);
      if (request.method !== "GET" || res.status === 302) {
        await this.afterChange();
        this.commit();
      }
      return res;
    } catch (e) {
      console.error("office request failed", e);
      return json({ error: "Something went wrong in the office. Try again." }, 500);
    }
  }

  private async route(request: Request, caller: Caller): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const post = request.method === "POST";

    if (post && path === "/internal/email") return json(await this.receiveEmail((await request.json()) as InboundDocs));
    if (post && path === "/internal/social/meta") return json(await this.receiveMeta(await request.json()));
    if (post && path === "/api/documents") return this.upload(request, caller);
    if (post && path === "/api/social/media" && request.headers.get("content-type")?.includes("multipart")) return this.uploadMedia(request, caller);
    const channel = /^\/api\/channels\/([a-z]+)\/(connect|callback)$/.exec(path);
    if (request.method === "GET" && channel) return channel[2] === "connect" ? this.startConnect(channel[1]!, caller) : this.finishConnect(channel[1]!, url, caller);
    const doc = /^\/api\/documents\/([^/]+)\/(read|scan)$/.exec(path);
    if (post && doc) return this.readStored(decodeURIComponent(doc[1]!), doc[2] as "read" | "scan", request);
    if (path === "/api/prefs") return this.prefs(request, caller);
    if (path === "/api/whatsapp" || path === "/api/whatsapp/code") return this.whatsappRoute(request, caller, path);

    if (request.method === "GET" && /^\/api\/exports\/(gstr3b|tds)\//.test(path)) {
      const { exportFile } = await import("@office/engine/excel");
      const file = await exportFile(this.office.ledger, path);
      if (!file) return json({ error: "Export not found" }, 404);
      return new Response(file.bytes, { headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${file.filename}"` } });
    }

    let body: unknown;
    if (request.method !== "GET" && request.headers.get("content-type")?.includes("json")) body = await request.json().catch(() => undefined);
    const res = dispatch(this.office, { method: request.method, path, query: url.searchParams, body, role: caller.role, user: { name: caller.name, email: caller.email }, mode: "live" });
    if (res.status !== 200) return json(res.body, res.status);

    if (/^\/api\/desk\/[^/]+$/.test(path) && post) await this.send([res.body as StagedChange]);
    if (path === "/api/settings") {
      if (request.method !== "GET") await this.scheduleDigest();
      return json(await this.withMembers(res));
    }
    if (path.startsWith("/api/exports/gstr1/")) {
      const period = path.split("/").pop()!;
      return json(res.body, 200, { "content-disposition": `attachment; filename="GSTR1_${this.office.books.business.gstin}_${period}.json"` });
    }
    return json(res.body);
  }

  /* ---------- Social channels ---------- */

  private back(params: Record<string, string>) {
    const to = new URL("/settings", this.env.BETTER_AUTH_URL);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    to.hash = "channels";
    return new Response(null, { status: 302, headers: { location: to.toString() } });
  }

  /** The owner leaves for the platform's sign-in page; nothing is stored until they come back. */
  private async startConnect(p: string, caller: Caller): Promise<Response> {
    if (caller.role !== "owner") return json({ error: "Only the owner can connect channels." }, 403);
    const parsed = PlatformEnum.safeParse(p);
    const adapter = parsed.success ? adaptersFor(this.env)[parsed.data] : undefined;
    if (!parsed.success || !adapter) return this.back({ connect_error: `${p} cannot be connected; post there by hand.` });
    if (!this.env.SOCIAL_TOKEN_KEY) return this.back({ connect_error: "Add SOCIAL_TOKEN_KEY as a Worker secret first, so sign-ins can be stored safely." });
    try {
      const { state, verifier } = await newState(this.env.SOCIAL_TOKEN_KEY, parsed.data, caller.email);
      return new Response(null, { status: 302, headers: { location: await adapter.authorizeUrl({ state, verifier, redirect: callbackUrl(this.env.BETTER_AUTH_URL, parsed.data) }) } });
    } catch (e) {
      return this.back({ connect_error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Back from the platform: the code becomes tokens, sealed in the Office, and the channel is connected. */
  private async finishConnect(p: string, url: URL, caller: Caller): Promise<Response> {
    if (caller.role !== "owner") return json({ error: "Only the owner can connect channels." }, 403);
    const parsed = PlatformEnum.safeParse(p);
    if (!parsed.success || !this.env.SOCIAL_TOKEN_KEY) return this.back({ connect_error: "That sign-in did not come from this office." });
    const platform: Platform = parsed.data;
    const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (denied) return this.back({ connect_error: denied.slice(0, 200) });
    const state = await readState(this.env.SOCIAL_TOKEN_KEY, platform, url.searchParams.get("state"));
    const code = url.searchParams.get("code");
    const adapter = adaptersFor(this.env)[platform];
    const ch = this.office.books.channels.find((c) => c.platform === platform);
    if (!state || !code || !adapter || !ch) return this.back({ connect_error: "The sign-in expired or did not come from this office. Try again." });
    try {
      const got = await adapter.exchange({ code, verifier: state.verifier, redirect: callbackUrl(this.env.BETTER_AUTH_URL, platform) });
      await this.vault.put(ch.id, got.tokens);
      this.office.connectChannel(ch.id, got.handle, got.followers);
      return this.back({ connected: platform });
    } catch (e) {
      console.error(`connect ${platform} failed`, e);
      return this.back({ connect_error: e instanceof PlatformError ? e.message : `${PLATFORM_NAMES[platform]} did not finish the sign-in.` });
    }
  }

  /** Product photos and framed pictures go to R2; the app shows them behind sign-in, platforms get signed links. */
  private async uploadMedia(request: Request, caller: Caller): Promise<Response> {
    if (caller.role !== "owner") return json({ error: "Only the owner can add pictures." }, 403);
    const form = await request.formData();
    const file = form.get("file") as File | string | null;
    if (!(file instanceof File)) return json({ error: "Attach a picture." }, 400);
    if (file.size > MAX_MEDIA) return json({ error: "Pictures up to 8 MB, please." }, 413);
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return json({ error: "Send a PNG, JPEG or WebP picture." }, 415);
    const id = `media-u${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
    if (!MEDIA_ID.test(id)) return json({ error: "Could not name the picture." }, 500);
    await this.env.DOCS.put(`media/${id}`, await file.arrayBuffer(), { httpMetadata: { contentType: file.type }, customMetadata: { by: caller.email } });
    const skuId = String(form.get("skuId") ?? "");
    const asset = this.office.addMedia({
      id,
      url: `/api/social/media/${id}`,
      kind: "image",
      alt: String(form.get("alt") ?? "").slice(0, 500),
      skuId: this.office.books.skus.some((s) => s.id === skuId) ? skuId : null,
      rights: form.get("rights") === "stock" ? "stock" : form.get("rights") === "generated" ? "generated" : "own",
      width: Number(form.get("width")) || null,
      height: Number(form.get("height")) || null,
    });
    return json(asset);
  }

  /**
   * A signed Meta webhook, already verified by the Worker: comments, reviews and WhatsApp messages.
   * WhatsApp from a linked number (or a JOIN code) is someone running the office, not a customer.
   */
  private async receiveMeta(body: unknown) {
    const kv = this.kv.bind(this);
    const handled = new Set<string>();
    let office = 0;
    for (const m of parseWhatsAppMessages(body)) {
      const out = await officeWhatsApp(this.waDeps(), m);
      if (!out) continue;
      handled.add(m.id);
      office++;
      await this.send(out.decided);
      const keys = this.waKeys();
      if (keys && out.text)
        await sendText(keys, out.to, out.text).catch((e) => console.error("whatsapp reply failed", e instanceof Error ? e.message : "unknown error"));
    }
    const connected = this.office.books.channels.filter((c) => c.mode === "connected");
    const own = new Set<string>();
    for (const c of connected) {
      const t = await this.vault.get(c.id);
      if (t) for (const id of [t.account, ...Object.values(t.extra)]) if (id) own.add(id);
    }
    const byPlatform = new Map(connected.map((c) => [PLATFORM_NAMES[c.platform], c.id]));
    const raws = parseMetaDelivery(body, own, Date.now(), (from, text) => Boolean(linkFor(kv, from)) || parseCommand(text).kind === "join")
      .filter((m) => !m.externalId || !handled.has(m.externalId))
      .map((m) => ({ ...m, channelId: byPlatform.get(m.platform) ?? "" }))
      .filter((m) => m.channelId);
    const r = this.office.receiveMessages(raws);
    return { received: r.added.length, leads: r.leads, replied: r.replied, office };
  }

  private waKeys(): WaKeys | null {
    const e = this.env;
    return e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID ? { token: e.WHATSAPP_TOKEN, phoneId: e.WHATSAPP_PHONE_NUMBER_ID, template: e.WHATSAPP_TEMPLATE ?? null } : null;
  }

  private waDeps(): WaDeps {
    return {
      kv: this.kv.bind(this),
      office: this.office,
      ai: this.env.AI,
      keys: this.waKeys(),
      base: this.env.BETTER_AUTH_URL,
      newDocId,
      store: async (key, bytes, contentType, meta) => void (await this.env.DOCS.put(key, bytes, { httpMetadata: { contentType }, customMetadata: meta })),
      readImage: (id, image, auto) => this.readImage(id, image, auto),
      readItems: (id, items, auto) => this.readItems(id, items, auto),
    };
  }

  /** Settings, under Your WhatsApp: a code to link this person's phone, their reply language and the morning digest. */
  private async whatsappRoute(request: Request, caller: Caller, path: string): Promise<Response> {
    const kv = this.kv.bind(this);
    const status = (): WhatsAppStatus => {
      const l = linkOf(kv, caller.email);
      const handle = this.office.books.channels.find((c) => c.platform === "whatsapp")?.handle ?? null;
      return { available: Boolean(this.waKeys()), linked: Boolean(l), number: l ? maskPhone(l.phone) : null, language: l?.language ?? "auto", digest: l?.digest ?? false, businessNumber: handle && /\d{6}/.test(handle.replace(/\D/g, "")) ? handle : null, template: Boolean(this.env.WHATSAPP_TEMPLATE) };
    };
    if (path === "/api/whatsapp/code" && request.method === "POST") {
      if (!this.waKeys()) return json({ error: "WhatsApp is not set up for this office yet: add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID." }, 409);
      const c = newJoinCode(kv, caller);
      const number = status().businessNumber;
      const digits = number?.replace(/\D/g, "") ?? "";
      return json({ ...c, businessNumber: number, link: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(`JOIN ${c.code}`)}` : null } satisfies JoinCode);
    }
    if (path !== "/api/whatsapp") return json({ error: "Not found" }, 404);
    if (request.method === "GET") return json(status());
    if (request.method === "DELETE") {
      if (unlink(kv, caller.email)) this.office.log("office-manager", `${caller.name} unlinked their WhatsApp from the office.`);
      return json(status());
    }
    if (request.method === "PUT") {
      const change = WhatsAppChange.safeParse(await request.json().catch(() => null));
      if (!change.success) return json({ error: "Invalid change" }, 400);
      if (!updateLink(kv, caller.email, change.data)) return json({ error: "Link your WhatsApp first." }, 409);
      return json(status());
    }
    return json({ error: "Not found" }, 404);
  }

  /** Who can sign in comes from the accounts, not the books. */
  private async withMembers(res: ApiResult) {
    const { users, invited } = await members(this.env);
    return { ...(res.body as object), users: users.map((u) => ({ name: u.name, email: u.email, role: u.role })), invited };
  }

  private async upload(request: Request, caller: Caller): Promise<Response> {
    const form = await request.formData();
    const file = form.get("file") as File | string | null;
    if (!(file instanceof File)) return json({ error: "Attach a file." }, 400);
    if (file.size > MAX_UPLOAD) return json({ error: "Files up to 10 MB, please." }, 413);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isImage = /^image\/(png|jpe?g|webp)$/.test(file.type);
    if (!isPdf && !isImage) return json({ error: "Send a PDF or a photo (PNG, JPEG or WebP)." }, 415);
    const parsed = ReadRequest.safeParse({ items: JSON.parse(String(form.get("items") ?? "[]")) });
    if (!parsed.success) return json({ error: "The text layer could not be read." }, 400);

    const id = newDocId();
    await this.env.DOCS.put(`docs/${id}`, await file.arrayBuffer(), { httpMetadata: { contentType: isPdf ? "application/pdf" : file.type }, customMetadata: { filename: file.name, by: caller.email } });
    this.office.receiveDocument({ id, file: `/api/files/${id}`, channel: "upload", from: null, pages: Number(form.get("pages") ?? 1) || 1 });
    const image = form.get("image") as File | string | null;
    if (parsed.data.items.length) return json(await this.readItems(id, parsed.data.items));
    const scan = image instanceof File ? await image.arrayBuffer() : isImage ? await file.arrayBuffer() : null;
    if (!scan) {
      this.office.failDocument(id, "it has no text and no picture of the page came with it.");
      return json({ error: "This PDF has no text, and the page could not be pictured. Try a photo of it." }, 422);
    }
    return json(await this.readImage(id, scan));
  }

  private async readItems(id: string, items: TextItem[], auto = true) {
    const e = await readText(this.env.AI, items, this.office.books);
    return this.office.ingest(id, e, auto);
  }

  private async readImage(id: string, image: ArrayBuffer, auto = true) {
    try {
      return this.office.ingest(id, await readScan(this.env.AI, image, this.office.books), auto);
    } catch (e) {
      console.error("vision read failed", e);
      this.office.failDocument(id, "the picture could not be read. Upload a clearer copy or the PDF.");
      const document = this.office.books.documents.find((d) => d.id === id)!;
      return { document, staged: null, message: "The picture could not be read. Upload a clearer copy or the PDF." };
    }
  }

  /** Emailed PDFs wait for an open browser to read their text; a page that has none comes back as a picture. */
  private async readStored(id: string, how: "read" | "scan", request: Request): Promise<Response> {
    const doc = this.office.books.documents.find((d) => d.id === id);
    if (!doc) return json({ error: "Document not found" }, 404);
    const auto = doc.channel !== "email" || this.knownSender(doc.from);
    if (how === "scan") {
      const image = await request.arrayBuffer();
      if (!image.byteLength || image.byteLength > MAX_UPLOAD) return json({ error: "Send a picture of the page up to 10 MB." }, 400);
      return json(await this.readImage(id, image, auto));
    }
    const parsed = ReadRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Send the document's text layer as items." }, 400);
    if (!parsed.data.items.length) return json(this.office.read(id, []));
    return json(await this.readItems(id, parsed.data.items, auto));
  }

  /** Only mail from a party already in the books may be posted without the owner. */
  private knownSender(from: string | null): boolean {
    const email = from?.toLowerCase();
    return Boolean(email && this.office.books.parties.some((p) => p.contact.email.toLowerCase() === email));
  }

  private async receiveEmail(mail: InboundDocs) {
    const auto = this.knownSender(mail.from);
    const results = [];
    for (const d of mail.docs) {
      this.office.receiveDocument({ id: d.id, file: `/api/files/${d.id}`, channel: "email", from: mail.from, pages: 1 });
      if (d.mimeType.startsWith("image/")) {
        const obj = await this.env.DOCS.get(`docs/${d.id}`);
        if (obj) results.push(await this.readImage(d.id, await obj.arrayBuffer(), auto));
      }
    }
    if (mail.skipped.length) this.office.log("accountant", `Left out ${mail.skipped.join(", ")} from ${mail.from ?? "an email"}: only PDFs and photos up to 10 MB are read.`);
    if (!mail.docs.length && !mail.skipped.length) this.office.log("accountant", `An email from ${mail.from ?? "an unknown sender"} ("${mail.subject.slice(0, 80)}") had nothing attached.`);
    this.commit();
    return { received: mail.docs.length, read: results.length };
  }

  /** Approved reminders leave by email. Cloudflare only delivers to addresses verified on the account. */
  private async send(items: StagedChange[]) {
    for (const it of items) {
      if (it.kind !== "reminder" || it.status !== "approved") continue;
      const p = it.payload as { to?: string; subject?: string; body?: string; partyId?: string };
      const ref = { kind: "party" as const, id: p.partyId ?? null };
      if (!this.env.MAILER || !p.to || !p.subject || !p.body) {
        this.office.log("credit-controller", `Could not send the reminder to ${p.to ?? "the customer"}: email is not set up for this office.`, ref);
        continue;
      }
      try {
        const replyTo = this.office.settings().reminderPolicy.sendFrom;
        const raw = plainMessage({ fromName: this.office.books.business.name, from: this.env.MAIL_FROM, to: p.to, replyTo, subject: p.subject, body: p.body });
        await this.env.MAILER.send(new EmailMessage(this.env.MAIL_FROM, p.to, raw));
      } catch (e) {
        this.office.log("credit-controller", `Could not send the reminder to ${p.to}: ${e instanceof Error ? e.message : String(e)}`, ref);
      }
    }
  }

  /** Each morning: trusted agents do their routine work, and the owners hear what is waiting. */
  async daily() {
    this.fresh();
    const done = this.office.runTrusted();
    await this.send(done);
    await this.socialMorning();
    const pending = this.office.pending();
    const { users } = await members(this.env);
    const onWhatsApp = await this.whatsappDigests(users, pending.length);
    const owners = users.filter((u) => u.role === "owner" && !onWhatsApp.has(u.email.toLowerCase()));
    if (this.env.MAILER && owners.length && (pending.length || done.length)) {
      const link = this.env.BETTER_AUTH_URL ? `${this.env.BETTER_AUTH_URL.replace(/\/$/, "")}/desk` : "";
      const body = [
        `Good morning. ${pending.length ? `${pending.length} ${pending.length === 1 ? "thing is" : "things are"} waiting on your desk.` : "Nothing is waiting on your desk."}`,
        "",
        ...pending.slice(0, 12).map((s) => `- ${s.title}`),
        ...(pending.length > 12 ? [`- and ${pending.length - 12} more`] : []),
        ...(done.length ? ["", "Done on their own since yesterday:", ...done.map((s) => `- ${s.title} (${s.decidedBy})`)] : []),
        ...(link ? ["", link] : []),
      ].join("\n");
      for (const o of owners) {
        try {
          const subject = pending.length ? `${pending.length} waiting on your desk` : "Your office this morning";
          await this.env.MAILER.send(new EmailMessage(this.env.MAIL_FROM, o.email, plainMessage({ fromName: "The Office Manager", from: this.env.MAIL_FROM, to: o.email, subject, body })));
        } catch (e) {
          this.office.log("office-manager", `Could not send the morning digest to ${o.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.office.log("office-manager", `Morning round: ${done.length ? `${done.length} routine ${done.length === 1 ? "task" : "tasks"} done by trusted agents; ` : ""}${pending.length} waiting on your desk.`);
    this.commit();
  }

  /** Everyone who asked for the digest on WhatsApp gets it there if WhatsApp allows; returns who was reached. */
  private async whatsappDigests(users: { name: string; email: string; role: Role }[], waiting: number): Promise<Set<string>> {
    const reached = new Set<string>();
    const keys = this.waKeys();
    if (!keys) return reached;
    const kv = this.kv.bind(this);
    for (const u of users) {
      const link = linkOf(kv, u.email);
      if (!link) continue;
      const how = digestChannel({ wantsWhatsApp: link.digest, lastAt: sessionFor(kv, link.phone).lastAt, now: Date.now(), template: Boolean(keys.template) });
      try {
        if (how === "whatsapp") await sendText(keys, link.phone, await morningDigest(this.waDeps(), link.phone, u, link.language === "auto" ? null : link.language));
        else if (how === "template") await sendTemplate(keys, link.phone, `${waiting} waiting on your desk. Reply desk to see them.`);
        else continue;
        reached.add(u.email.toLowerCase());
      } catch (e) {
        this.office.log("office-manager", `Could not send ${u.name} the morning digest on WhatsApp${e instanceof Error ? `: ${e.message}` : ""}. It went by email instead.`);
      }
    }
    return reached;
  }

  /**
   * The Social Media Manager's morning: numbers and comments from each connected channel,
   * anything overdue published or held back, and from the 25th, next month's calendar drafted for the desk.
   */
  private async socialMorning() {
    if (!this.office.hired("social-media-manager")) return;
    try {
      const pulled = await this.social().pull();
      if (pulled.metrics) this.office.log("social-media-manager", `Updated the results of ${pulled.metrics} ${pulled.metrics === 1 ? "post" : "posts"} from the platforms.`);
      this.office.publishDue(new Date().toISOString());
      const month = nextMonth(this.day.slice(0, 7));
      if (Number(this.day.slice(8, 10)) >= 25 && !this.office.books.calendars.some((c) => c.month === month && c.status !== "superseded")) this.office.draftCalendar(month);
      await this.afterChange();
    } catch (e) {
      console.error("social morning failed", e);
    }
  }
}
