import { type JoinCode, type Platform, type StagedChange, PLATFORM_NAMES, Platform as PlatformEnum, ReadRequest, WhatsAppChange, type WhatsAppStatus } from "@office/contracts";
import { digestChannel, dispatch, nextMonth, OfficeService, type ApiResult, type TextItem } from "@office/engine";
import { emptyBooks, loadBooks, SAMPLE_SEED } from "@office/fixtures";
import { Agent, type Connection, type ConnectionContext } from "agents";
import { EmailMessage } from "cloudflare:email";
import { CALLER_HEADER, type Caller, type InboundDocs, newDocId } from "./caller";
import type { Env } from "./env";
import { docKey, fileUrl, mediaKey, mediaUrl } from "./keys";
import { plainMessage } from "./mail";
import { readPrefs, savePrefs } from "./prefs";
import { meteredAi, QuotaError, take } from "./quota";
import { readScan, readText } from "./reading";
import { PlatformError } from "./social/adapter";
import { SocialHost } from "./social/host";
import { adaptersFor } from "./social";
import { MEDIA_ID } from "./social/media";
import { callbackUrl, newState, readState } from "./social/oauth";
import { TokenVault } from "./social/tokens";
import { parseMetaDelivery, parseWhatsAppMessages } from "./social/webhooks";
import { BooksStore } from "./store";
import { ControlPlane, ingestAddress, OFFICE_ID, type RouteKind } from "./tenancy";
import { digestCron, istDate } from "./time";
import { sendTemplate, sendText, type WaKeys } from "./whatsapp/cloud";
import { type Link, maskPhone, sessionFor, WaDirectory, type WaPerson } from "./whatsapp/links";
import { morningDigest, officeWhatsApp, type WaDeps } from "./whatsapp/office";

const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_MEDIA = 8 * 1024 * 1024;
/** Steps that bring an office's storage up to date, run once each, in order, when it wakes. */
const SCHEMA_VERSION = 2;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const ROUTE_KIND: Partial<Record<Platform, RouteKind>> = { facebook: "meta_page", instagram: "ig_account", threads: "threads", linkedin: "linkedin", x: "x", whatsapp: "wa_phone" };

/**
 * One Office per business, and the only writer of its books. It knows which office it is
 * from its name, checks that against what it stored the first time it woke, and refuses any
 * request meant for another office. It keeps the engine in memory, saves the records that
 * changed after every request, tells open browsers to refresh, and wakes each morning to let
 * trusted agents do their routine work and send the owners a digest.
 */
export class Office extends Agent<Env> {
  private store!: BooksStore;
  private office!: OfficeService;
  private vault!: TokenVault;
  private day = "";
  /** Null until the office knows who it is; an office that does not know does nothing. */
  private officeId: string | null = null;
  private ingestEmail = "";
  private businessName = "";
  private ai!: Ai;

  private ownName(): string | null {
    try {
      return this.name;
    } catch {
      return null;
    }
  }

  private log(message: string, e?: unknown) {
    const why = e instanceof Error ? `: ${e.message}` : "";
    console.error(`[office ${this.officeId ?? "unknown"}] ${message}${why}`);
  }

  private plane() {
    return new ControlPlane(this.env.DB);
  }

  async onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS office_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const name = this.ownName();
    const stored = this.kv("office:id");
    if (stored && name && stored !== name) throw new Error(`office ${name} holds the books of ${stored}`);
    const id = stored ?? name;
    if (!id || !OFFICE_ID.test(id)) return;
    const row = await this.plane().office(id);
    if (!row) return;
    if (!stored) this.kv("office:id", id);
    this.officeId = id;
    this.businessName = row.name;
    const routes = await this.plane().routesOf(id, "email");
    const primary = ingestAddress(row.slug, this.env.INGEST_DOMAIN);
    this.ingestEmail = routes.some((r) => r.externalId === primary) ? primary : (routes[0]?.externalId ?? primary);
    this.ai = meteredAi(this.env.AI, () => take(this.kv.bind(this), istDate(), "ai"));

    this.store = new BooksStore(sql);
    this.vault = new TokenVault(sql, this.env.SOCIAL_TOKEN_KEY, id);
    let books = this.store.load();
    if (books?.seed === SAMPLE_SEED && this.env.OFFICE_SEED !== "sample") {
      // Offices opened before new offices started empty were given the sample business; start them over.
      sql.exec("DELETE FROM office_kv WHERE k != 'office:id'");
      books = null;
    }
    if (!books) {
      books = await this.seed(id, row.name);
      this.store.save(books);
      this.kv("schema_version", String(SCHEMA_VERSION));
    }
    await this.migrate(books);
    this.open(books);
    this.store.save(this.office.books);
    const named = this.office.books.business.name.trim();
    if (named && named !== row.name && this.env.OFFICE_SEED !== "sample") {
      await this.plane().rename(id, named);
      this.businessName = named;
    }
    await this.scheduleDigest();
    await this.armPublishing();
  }

  /** Each step runs once. Step 1 moves files under this office's prefix; step 2 moves WhatsApp links to the shared directory. */
  private async migrate(books: OfficeService["books"]) {
    const id = this.officeId!;
    let v = Number(this.kv("schema_version") ?? 0);
    if (v < 1) {
      for (const d of books.documents) {
        const m = /^\/api\/files\/(.+)$/.exec(d.file);
        if (!m) continue;
        await this.moveObject(`docs/${m[1]}`, docKey(id, m[1]!));
        await this.moveObject(`docs/${m[1]}.txt`, docKey(id, `${m[1]}.txt`));
        d.file = fileUrl(id, m[1]!);
      }
      for (const a of books.media) {
        const m = /^\/api\/social\/media\/(.+)$/.exec(a.url);
        if (!m) continue;
        await this.moveObject(`media/${m[1]}`, mediaKey(id, m[1]!));
        a.url = mediaUrl(id, m[1]!);
      }
      this.store.save(books);
      this.kv("schema_version", String((v = 1)));
    }
    if (v < 2) {
      const sql = this.ctx.storage.sql;
      const dir = new WaDirectory(this.env.DB);
      for (const r of sql.exec<{ v: string }>("SELECT v FROM office_kv WHERE k LIKE 'wa:link:%' AND v != ''").toArray()) {
        try {
          const old = JSON.parse(r.v) as { phone: string; email: string; language: Link["language"]; digest: boolean; linkedAt: string };
          await dir.importLegacy(id, old);
        } catch (e) {
          this.log("could not move a WhatsApp link", e);
        }
      }
      sql.exec("DELETE FROM office_kv WHERE k LIKE 'wa:link:%' OR k LIKE 'wa:by-email:%' OR k LIKE 'wa:code:%' OR k LIKE 'wa:pending:%'");
      this.kv("schema_version", String((v = 2)));
    }
  }

  /** Copies, checks the copy is there, then removes the old key. A missing source is already moved. */
  private async moveObject(from: string, to: string) {
    const obj = await this.env.DOCS.get(from);
    if (!obj) return;
    await this.env.DOCS.put(to, await obj.arrayBuffer(), { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
    if (await this.env.DOCS.head(to)) await this.env.DOCS.delete(from);
  }

  private social(): SocialHost {
    return new SocialHost(this.office, this.vault, adaptersFor(this.env), { base: this.env.BETTER_AUTH_URL, officeId: this.officeId!, mediaSecret: this.env.SOCIAL_TOKEN_KEY, kv: (k, v) => this.kv(k, v) });
  }

  private kv(k: string, v?: string): string | null {
    const sql = this.ctx.storage.sql;
    if (v !== undefined) sql.exec("INSERT INTO office_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
    return sql.exec<{ v: string }>("SELECT v FROM office_kv WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  /** Each person's skin and floor view in this office, kept here so they follow that person to any machine. */
  private async prefs(request: Request, caller: Caller): Promise<Response> {
    const kv = this.kv.bind(this);
    if (request.method === "GET") return json(readPrefs(kv, caller.email));
    if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Not found" }, 404);
    const next = savePrefs(kv, caller.email, await request.json().catch(() => null));
    return next ? json(next) : json({ error: "Invalid preferences" }, 400);
  }

  /** A new office starts empty, with the name it was opened with and its owner; the sample business is for demos and tests. */
  private async seed(officeId: string, name: string): Promise<OfficeService["books"]> {
    if (this.env.OFFICE_SEED === "sample") return loadBooks();
    const owner = (await this.plane().members(officeId)).find((u) => u.role === "owner");
    const books = emptyBooks({ owner: owner?.name ?? "", email: owner?.email, asOf: istDate() });
    books.business.name = name;
    return books;
  }

  private open(books: OfficeService["books"]) {
    this.day = istDate();
    this.office = new OfficeService(books, { asOf: this.day, ingestEmail: this.ingestEmail });
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
    if (!this.officeId) return;
    this.fresh();
    this.office.publishDue(new Date().toISOString());
    await this.afterChange();
    this.commit();
  }

  /** Open browsers listen here. The Worker checked the membership; this checks the request was meant for this office. */
  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const caller = JSON.parse(ctx.request.headers.get(CALLER_HEADER) ?? "null") as Caller | null;
    if (!this.officeId || !caller || caller.officeId !== this.officeId) {
      connection.close(1008, "Not found");
      return;
    }
    return super.onConnect(connection, ctx);
  }

  async onRequest(request: Request): Promise<Response> {
    const caller = JSON.parse(request.headers.get(CALLER_HEADER) ?? "null") as Caller | null;
    if (!caller) return json({ error: "Sign in to continue." }, 401);
    if (!this.officeId || caller.officeId !== this.officeId) return json({ error: "Not found" }, 404);
    const path = new URL(request.url).pathname;
    if (this.kv("office:purged")) return json({ error: "Not found" }, 404);
    if (request.method === "POST" && path === "/internal/purge") return json(await this.purge());
    this.fresh();
    try {
      const res = await this.route(request, caller);
      if (request.method !== "GET" || res.status === 302) {
        await this.afterChange();
        this.commit();
      }
      return res;
    } catch (e) {
      if (e instanceof QuotaError) return json({ error: e.message }, 429);
      this.log("request failed", e);
      return json({ error: "Something went wrong in the office. Try again." }, 500);
    }
  }

  private async route(request: Request, caller: Caller): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const post = request.method === "POST";

    if (post && path === "/internal/email") return json(await this.receiveEmail((await request.json()) as InboundDocs));
    if (post && path === "/internal/social/meta") return json(await this.receiveMeta(await request.json()));
    if (post && path === "/internal/whatsapp") return json(await this.receiveShared((await request.json()) as SharedMessage));
    if (post && path === "/internal/export") return json(this.exportBooks());
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
    if (path.startsWith("/api/channels") && request.method !== "GET") await this.syncRoutes();
    if (path === "/api/settings") {
      if (request.method !== "GET") {
        await this.scheduleDigest();
        const name = this.office.books.business.name.trim();
        if (name && name !== this.businessName) {
          await this.plane().rename(this.officeId!, name);
          this.businessName = name;
        }
      }
      return json(await this.withMembers(res));
    }
    if (path.startsWith("/api/exports/gstr1/")) {
      const period = path.split("/").pop()!;
      return json(res.body, 200, { "content-disposition": `attachment; filename="GSTR1_${this.office.books.business.gstin}_${period}.json"` });
    }
    return json(res.body);
  }

  /* ---------- Export and purge ---------- */

  /** The books and settings, for the owner's export. Platform tokens never leave the vault. */
  private exportBooks() {
    const { users: _u, ...settings } = this.office.settings();
    return { office: this.officeId, exportedAt: new Date().toISOString(), books: this.office.books, settings };
  }

  /** The end of a deleted office: its storage and alarms go. The Worker removes its files and rows. */
  private async purge() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS office_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.kv("office:id", this.officeId!);
    this.kv("office:purged", String(Date.now()));
    return { purged: true };
  }

  /* ---------- Social channels ---------- */

  private back(params: Record<string, string>) {
    const to = new URL("/settings", this.env.BETTER_AUTH_URL);
    to.searchParams.set("office", this.officeId!);
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
      const { state, verifier } = await newState(this.env.SOCIAL_TOKEN_KEY, parsed.data, caller.email, this.officeId!);
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
    if (!state || state.officeId !== this.officeId || state.by !== caller.email || !code || !adapter || !ch) return this.back({ connect_error: "The sign-in expired or did not come from this office. Try again." });
    try {
      const got = await adapter.exchange({ code, verifier: state.verifier, redirect: callbackUrl(this.env.BETTER_AUTH_URL, platform) });
      const claimed = await this.claimIds(platform, [got.tokens.account, ...Object.values(got.tokens.extra)]);
      if (!claimed) return this.back({ connect_error: `That ${PLATFORM_NAMES[platform]} account is connected to another office. Disconnect it there first.` });
      await this.vault.put(ch.id, got.tokens);
      this.office.connectChannel(ch.id, got.handle, got.followers);
      await this.syncRoutes();
      return this.back({ connected: platform });
    } catch (e) {
      this.log(`connect ${platform} failed`, e);
      return this.back({ connect_error: e instanceof PlatformError ? e.message : `${PLATFORM_NAMES[platform]} did not finish the sign-in.` });
    }
  }

  /** The ids webhooks will name for this channel. The shared WhatsApp number belongs to no one office. */
  private routeIds(platform: Platform, ids: (string | null | undefined)[]): { kind: RouteKind; id: string }[] {
    const kind = ROUTE_KIND[platform];
    if (!kind) return [];
    return ids.filter((id): id is string => Boolean(id) && /^[\w:.-]{1,120}$/.test(id!) && !(kind === "wa_phone" && id === this.env.WHATSAPP_PHONE_NUMBER_ID)).map((id) => ({ kind, id }));
  }

  private async claimIds(platform: Platform, ids: (string | null | undefined)[]): Promise<boolean> {
    const plane = this.plane();
    const wanted = this.routeIds(platform, ids);
    const got: typeof wanted = [];
    for (const r of wanted) {
      if (await plane.claimRoute(this.officeId!, r.kind, r.id)) got.push(r);
      else {
        for (const g of got) await plane.dropRoute(this.officeId!, g.kind, g.id);
        return false;
      }
    }
    return true;
  }

  /** The route table follows the connected channels: a disconnected page stops reaching this office. */
  private async syncRoutes() {
    const plane = this.plane();
    const want = new Set<string>();
    for (const c of this.office.books.channels) {
      if (c.mode !== "connected") continue;
      const t = await this.vault.get(c.id);
      if (t) for (const r of this.routeIds(c.platform, [t.account, ...Object.values(t.extra)])) want.add(`${r.kind}|${r.id}`);
    }
    for (const r of await plane.routesOf(this.officeId!)) if (r.kind !== "email" && !want.has(`${r.kind}|${r.externalId}`)) await plane.dropRoute(this.officeId!, r.kind, r.externalId);
    for (const w of want) {
      const [kind, id] = w.split("|") as [RouteKind, string];
      await plane.claimRoute(this.officeId!, kind, id);
    }
  }

  /** Product photos and framed pictures go to R2 under this office; the app shows them behind sign-in, platforms get signed links. */
  private async uploadMedia(request: Request, caller: Caller): Promise<Response> {
    if (caller.role !== "owner") return json({ error: "Only the owner can add pictures." }, 403);
    const form = await request.formData();
    const file = form.get("file") as File | string | null;
    if (!(file instanceof File)) return json({ error: "Attach a picture." }, 400);
    if (file.size > MAX_MEDIA) return json({ error: "Pictures up to 8 MB, please." }, 413);
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return json({ error: "Send a PNG, JPEG or WebP picture." }, 415);
    take(this.kv.bind(this), istDate(), "upload", file.size);
    const id = `media-u${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
    if (!MEDIA_ID.test(id)) return json({ error: "Could not name the picture." }, 500);
    await this.env.DOCS.put(mediaKey(this.officeId!, id), await file.arrayBuffer(), { httpMetadata: { contentType: file.type }, customMetadata: { by: caller.email } });
    const skuId = String(form.get("skuId") ?? "");
    const asset = this.office.addMedia({
      id,
      url: mediaUrl(this.officeId!, id),
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
   * This office's part of a signed Meta webhook: comments and reviews on its own pages, and messages
   * to its own WhatsApp number. Someone in the office writing to that number is running it, not a customer.
   */
  private async receiveMeta(body: unknown) {
    const dir = new WaDirectory(this.env.DB);
    const keys = await this.ownWaKeys();
    const handled = new Set<string>();
    const people = new Set<string>();
    let office = 0;
    for (const m of parseWhatsAppMessages(body)) {
      let person = await dir.personIn(this.officeId!, m.from);
      let joined = false;
      const join = m.kind === "text" ? /^join\s*(\d{6})$/i.exec(m.text.trim()) : null;
      if (join) {
        const r = await dir.redeem(m.from, join[1]!, this.officeId!);
        if ("error" in r) {
          handled.add(m.id);
          continue;
        }
        person = await dir.personIn(this.officeId!, m.from);
        joined = true;
      }
      if (!person) continue;
      people.add(person.phone);
      const out = await officeWhatsApp(this.waDeps(keys), m, person, { joined });
      if (!out) continue;
      handled.add(m.id);
      office++;
      await this.send(out.decided);
      if (keys && out.text) await sendText(keys, out.to, out.text).catch((e) => this.log("whatsapp reply failed", e));
    }
    const connected = this.office.books.channels.filter((c) => c.mode === "connected");
    const own = new Set<string>();
    for (const c of connected) {
      const t = await this.vault.get(c.id);
      if (t) for (const id of [t.account, ...Object.values(t.extra)]) if (id) own.add(id);
    }
    const byPlatform = new Map(connected.map((c) => [PLATFORM_NAMES[c.platform], c.id]));
    const raws = parseMetaDelivery(body, own, Date.now(), (from) => people.has(from.replace(/\D/g, "")))
      .filter((m) => !m.externalId || !handled.has(m.externalId))
      .map((m) => ({ ...m, channelId: byPlatform.get(m.platform) ?? "" }))
      .filter((m) => m.channelId);
    const r = this.office.receiveMessages(raws);
    return { received: r.added.length, leads: r.leads, replied: r.replied, office };
  }

  /** Someone in this office, on the shared number. The Worker found them and chose this office; replies go back on the shared number. */
  private async receiveShared(msg: SharedMessage) {
    const m = parseWhatsAppMessages(msg.body)[0];
    if (!m || !msg.person) return { office: 0 };
    const person = await new WaDirectory(this.env.DB).personIn(this.officeId!, msg.person.phone);
    if (!person || person.userId !== msg.person.userId) return { office: 0 };
    const keys = this.sharedWaKeys();
    const out = await officeWhatsApp(this.waDeps(keys), m, person, { joined: msg.joined, heading: msg.heading });
    if (!out) return { office: 0 };
    await this.send(out.decided);
    if (keys && out.text) await sendText(keys, out.to, out.text).catch((e) => this.log("whatsapp reply failed", e));
    return { office: 1 };
  }

  private sharedWaKeys(): WaKeys | null {
    const e = this.env;
    return e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID ? { token: e.WHATSAPP_TOKEN, phoneId: e.WHATSAPP_PHONE_NUMBER_ID, template: e.WHATSAPP_TEMPLATE ?? null } : null;
  }

  /** An office's own WhatsApp number, if it connected one; otherwise the shared number. */
  private async ownWaKeys(): Promise<WaKeys | null> {
    const ch = this.office.books.channels.find((c) => c.platform === "whatsapp" && c.mode === "connected");
    const t = ch ? await this.vault.get(ch.id) : null;
    if (t && t.account && t.account !== this.env.WHATSAPP_PHONE_NUMBER_ID) return { token: t.access, phoneId: t.account, template: t.extra.template ?? null };
    return this.sharedWaKeys();
  }

  private waDeps(keys: WaKeys | null): WaDeps {
    return {
      kv: this.kv.bind(this),
      officeId: this.officeId!,
      office: this.office,
      ai: this.ai,
      keys,
      base: this.env.BETTER_AUTH_URL,
      newDocId,
      store: async (key, bytes, contentType, meta) => {
        take(this.kv.bind(this), istDate(), "upload", typeof bytes === "string" ? bytes.length : bytes.byteLength);
        await this.env.DOCS.put(key, bytes, { httpMetadata: { contentType }, customMetadata: meta });
      },
      readImage: (id, image, auto) => this.readImage(id, image, auto),
      readItems: (id, items, auto) => this.readItems(id, items, auto),
    };
  }

  /** Settings, under Your WhatsApp: a code to link this person's phone, their reply language and the morning digest. */
  private async whatsappRoute(request: Request, caller: Caller, path: string): Promise<Response> {
    const dir = new WaDirectory(this.env.DB);
    const status = async (): Promise<WhatsAppStatus> => {
      const l = await dir.linkOfUser(caller.userId);
      const handle = this.office.books.channels.find((c) => c.platform === "whatsapp")?.handle ?? null;
      return { available: Boolean(this.sharedWaKeys()), linked: Boolean(l), number: l ? maskPhone(l.phone) : null, language: l?.language ?? "auto", digest: l?.digest ?? false, businessNumber: handle && /\d{6}/.test(handle.replace(/\D/g, "")) ? handle : null, template: Boolean(this.env.WHATSAPP_TEMPLATE) };
    };
    if (path === "/api/whatsapp/code" && request.method === "POST") {
      if (!this.sharedWaKeys()) return json({ error: "WhatsApp is not set up yet: add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID." }, 409);
      const c = await dir.newJoinCode(this.officeId!, caller.userId);
      const number = (await status()).businessNumber;
      const digits = number?.replace(/\D/g, "") ?? "";
      return json({ ...c, businessNumber: number, link: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(`JOIN ${c.code}`)}` : null } satisfies JoinCode);
    }
    if (path !== "/api/whatsapp") return json({ error: "Not found" }, 404);
    if (request.method === "GET") return json(await status());
    if (request.method === "DELETE") {
      if (await dir.unlink(caller.userId)) this.office.log("office-manager", `${caller.name} unlinked their WhatsApp.`);
      return json(await status());
    }
    if (request.method === "PUT") {
      const change = WhatsAppChange.safeParse(await request.json().catch(() => null));
      if (!change.success) return json({ error: "Invalid change" }, 400);
      if (!(await dir.update(caller.userId, change.data))) return json({ error: "Link your WhatsApp first." }, 409);
      return json(await status());
    }
    return json({ error: "Not found" }, 404);
  }

  /** Who can sign in comes from this office's memberships, not the books. */
  private async withMembers(res: ApiResult) {
    const plane = this.plane();
    const [users, invited] = await Promise.all([plane.members(this.officeId!), plane.invitations(this.officeId!)]);
    return { ...(res.body as object), users: users.map((u) => ({ name: u.name, email: u.email, role: u.role })), invited: invited.map((i) => ({ email: i.email, role: i.role })) };
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
    take(this.kv.bind(this), istDate(), "upload", file.size);

    const id = newDocId();
    await this.env.DOCS.put(docKey(this.officeId!, id), await file.arrayBuffer(), { httpMetadata: { contentType: isPdf ? "application/pdf" : file.type }, customMetadata: { filename: file.name, by: caller.email } });
    this.office.receiveDocument({ id, file: fileUrl(this.officeId!, id), channel: "upload", from: null, pages: Number(form.get("pages") ?? 1) || 1 });
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
    const e = await readText(this.ai, items, this.office.books);
    return this.office.ingest(id, e, auto);
  }

  private async readImage(id: string, image: ArrayBuffer, auto = true) {
    try {
      return this.office.ingest(id, await readScan(this.ai, image, this.office.books), auto);
    } catch (e) {
      const why = e instanceof QuotaError ? e.message : "The picture could not be read. Upload a clearer copy or the PDF.";
      if (!(e instanceof QuotaError)) this.log("vision read failed", e);
      this.office.failDocument(id, e instanceof QuotaError ? "the office's reading for today is used up; read it again tomorrow." : "the picture could not be read. Upload a clearer copy or the PDF.");
      const document = this.office.books.documents.find((d) => d.id === id)!;
      return { document, staged: null, message: why };
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
      this.office.receiveDocument({ id: d.id, file: fileUrl(this.officeId!, d.id), channel: "email", from: mail.from, pages: 1 });
      if (d.mimeType.startsWith("image/")) {
        const obj = await this.env.DOCS.get(docKey(this.officeId!, d.id));
        if (obj) results.push(await this.readImage(d.id, await obj.arrayBuffer(), auto));
      }
    }
    if (mail.skipped.length) this.office.log("accountant", `Left out ${mail.skipped.join(", ")} from ${mail.from ?? "an email"}: only PDFs and photos up to 10 MB are read.`);
    if (!mail.docs.length && !mail.skipped.length) this.office.log("accountant", `An email from ${mail.from ?? "an unknown sender"} ("${mail.subject.slice(0, 80)}") had nothing attached.`);
    this.commit();
    return { received: mail.docs.length, read: results.length };
  }

  /** Approved reminders leave from the shared address under the business's name; replies go to the business. */
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
        const replyTo = this.office.settings().reminderPolicy.sendFrom || this.office.books.business.email || undefined;
        const raw = plainMessage({ fromName: this.office.books.business.name || this.businessName, from: this.env.MAIL_FROM, to: p.to, replyTo, subject: p.subject, body: p.body });
        await this.env.MAILER.send(new EmailMessage(this.env.MAIL_FROM, p.to, raw));
      } catch (e) {
        this.office.log("credit-controller", `Could not send the reminder to ${p.to}: ${e instanceof Error ? e.message : String(e)}`, ref);
      }
    }
  }

  /** Each morning: trusted agents do their routine work, and the owners hear what is waiting. */
  async daily() {
    if (!this.officeId || this.kv("office:purged")) return;
    const row = await this.plane().office(this.officeId);
    if (!row || row.status !== "active") return;
    this.fresh();
    const done = this.office.runTrusted();
    await this.send(done);
    await this.socialMorning();
    const pending = this.office.pending();
    const users = await this.plane().members(this.officeId);
    const onWhatsApp = await this.whatsappDigests(pending.length);
    const owners = users.filter((u) => u.role === "owner" && !onWhatsApp.has(u.userId));
    if (this.env.MAILER && owners.length && (pending.length || done.length)) {
      const link = this.env.BETTER_AUTH_URL ? `${this.env.BETTER_AUTH_URL.replace(/\/$/, "")}/desk?office=${this.officeId}` : "";
      const body = [
        `Good morning. ${pending.length ? `${pending.length} ${pending.length === 1 ? "thing is" : "things are"} waiting on your desk at ${row.name}.` : `Nothing is waiting on your desk at ${row.name}.`}`,
        "",
        ...pending.slice(0, 12).map((s) => `- ${s.title}`),
        ...(pending.length > 12 ? [`- and ${pending.length - 12} more`] : []),
        ...(done.length ? ["", "Done on their own since yesterday:", ...done.map((s) => `- ${s.title} (${s.decidedBy})`)] : []),
        ...(link ? ["", link] : []),
      ].join("\n");
      for (const o of owners) {
        try {
          const subject = pending.length ? `${row.name}: ${pending.length} waiting on your desk` : `${row.name} this morning`;
          await this.env.MAILER.send(new EmailMessage(this.env.MAIL_FROM, o.email, plainMessage({ fromName: `${row.name} · The Office`, from: this.env.MAIL_FROM, to: o.email, subject, body })));
        } catch (e) {
          this.office.log("office-manager", `Could not send the morning digest to ${o.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.office.log("office-manager", `Morning round: ${done.length ? `${done.length} routine ${done.length === 1 ? "task" : "tasks"} done by trusted agents; ` : ""}${pending.length} waiting on your desk.`);
    this.commit();
  }

  /** Everyone in this office who asked for the digest on WhatsApp gets it there if WhatsApp allows; returns who was reached. */
  private async whatsappDigests(waiting: number): Promise<Set<string>> {
    const reached = new Set<string>();
    const keys = this.sharedWaKeys();
    if (!keys) return reached;
    const kv = this.kv.bind(this);
    const plane = this.plane();
    for (const link of await new WaDirectory(this.env.DB).linksIn(this.officeId!)) {
      const how = digestChannel({ wantsWhatsApp: link.digest, lastAt: sessionFor(kv, link.phone).lastAt, now: Date.now(), template: Boolean(keys.template) });
      const heading = (await plane.officesOf(link.userId)).filter((o) => o.status === "active").length > 1 ? this.businessName : undefined;
      try {
        if (how === "whatsapp") await sendText(keys, link.phone, await morningDigest(this.waDeps(keys), link.phone, link, link.language === "auto" ? null : link.language, heading));
        else if (how === "template") await sendTemplate(keys, link.phone, `${heading ? `${heading}: ` : ""}${waiting} waiting on your desk. Reply desk to see them.`);
        else continue;
        reached.add(link.userId);
      } catch (e) {
        this.office.log("office-manager", `Could not send ${link.name} the morning digest on WhatsApp${e instanceof Error ? `: ${e.message}` : ""}. It went by email instead.`);
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
      this.log("social morning failed", e);
    }
  }
}

type SharedMessage = { body: unknown; person: WaPerson | null; joined: boolean; heading?: string };
