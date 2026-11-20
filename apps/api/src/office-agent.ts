import { ambientFrom, BRAND, checkPersonaNames, ImportCheck, IMPORT_MAX_BYTES, type JoinCode, type Platform, type StagedChange, PLATFORM_NAMES, Platform as PlatformEnum, ReadRequest, readPersonaNames, ROUTES, WhatsAppChange, type WhatsAppStatus } from "@office/contracts";
import { assistantAddress, CalendarLinkInput, salesAddress, SalesUploadInput } from "@office/contracts";
import { gmailConfirmation, parseCommand, readForward } from "@office/engine";
import { digestChannel, dispatch, morningRound, nextMonth, OfficeService, RoutineError, routinesView, runNow, runOne, type ApiResult, type RoutineHost, type StepResult, type TextItem } from "@office/engine";
import { backupKey, backupTarget, putObject, retainedKey, retainedUntil, sealedCopy } from "./backup";
import { SqlEditLog } from "./edits";
import { OfficeExports } from "./export";
import { emptyBooks, loadBooks, SAMPLE_SEED } from "@office/fixtures";
import { Agent, type Connection, type ConnectionContext } from "agents";
import { CALLER_HEADER, type Caller, type InboundDocs, newDocId } from "./caller";
import { CALLER_SEAL_HEADER, callerSealed } from "./caller-seal";
import type { Env } from "./env";
import { docKey, fileUrl, mediaKey, mediaUrl } from "./keys";
import { fromGoogleForwarding, mailSender } from "./mail";
import { readPrefs, savePrefs } from "./prefs";
import { meteredAi, QuotaError, take } from "./quota";
import { readScan, readText } from "./reading";
import { PlatformError } from "./social/adapter";
import { SocialHost } from "./social/host";
import { adaptersFor } from "./social";
import { MEDIA_ID } from "./social/media";
import { callbackUrl, newState, readState, SpentStates } from "./social/oauth";
import { TokenVault } from "./social/tokens";
import { parseMetaDelivery, parseWhatsAppMessages } from "./social/webhooks";
import { BooksStore } from "./store";
import { SqlRoutineLog } from "./routines";
import { SqlCsStore } from "./customer/store";
import { type AssistantInbound, draftReply, fetchCalendar, plainAddress, SqlAssistantStore } from "./assistant";
import { countMail, forwardedByHand, MAIL_LIMITS, type MailAdmission, type MailDocs, type MailRate, MAIL_REFUSED, mailSenderOk, ownerOf, postsAlone, provenSender, salesSender } from "./inbound";
import { readSalesFile, salesReply, SqlSalesStore } from "./sales";
import { CustomerDesk } from "./customer/desk";
import { CS_AGENT, splitCustomerDms, type ChatPostBody, type SupportMail, supportAddress, toSupportInbound } from "./customer/channels";
import { ControlPlane, ingestAddress, OFFICE_ID, type RouteKind } from "./tenancy";
import { digestCron, istDate } from "./time";
import { sendTemplate, sendText, type WaKeys } from "./whatsapp/cloud";
import { type Link, maskPhone, sessionFor, WaDirectory, type WaPerson } from "./whatsapp/links";
import { morningDigest, officeWhatsApp, type WaDeps } from "./whatsapp/office";

const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_MEDIA = 8 * 1024 * 1024;
const MAX_IMPORT = 3 * IMPORT_MAX_BYTES + 10_000;
/** Steps that bring an office's storage up to date, run once each, in order, when it wakes. */
const SCHEMA_VERSION = 2;
/** Where the agents SDK looks for a Durable Object's name when the runtime does not give one (PartyServer's key). */
const LEGACY_NAME = "__ps_name";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** Who the Worker says is asking. Unchecked: only for tagging a socket, which `onConnect` closes unless `callerOf` agrees. */
const claimedCaller = (request: Request): Caller | null => {
  const c = parseJson(request.headers.get(CALLER_HEADER) ?? "null") as Caller | null;
  return c && typeof c === "object" && typeof c.userId === "string" && typeof c.officeId === "string" ? c : null;
};
const userTag = (userId: string) => `user:${userId}`;
/** The office itself (`system()` in caller.ts): only the Worker sends it, for mail, webhooks, export, purge and closing sockets. */
const SYSTEM_USER = "system";
const ROUTE_KIND: Partial<Record<Platform, RouteKind>> ={ facebook: "meta_page", instagram: "ig_account", threads: "threads", linkedin: "linkedin", x: "x", whatsapp: "wa_phone" };

/**
 * One Office per business, and the only writer of its books. It knows which office it is
 * from its name, checks that against what it stored the first time it woke, and refuses any
 * request meant for another office. It keeps the engine in memory, saves the records that
 * changed after every request, tells open browsers to refresh, and wakes each morning to let
 * trusted agents do their routine work and send the owners a digest.
 */
export class Office extends Agent<Env> {
  private store!: BooksStore;
  private edits!: SqlEditLog;
  private runs!: SqlRoutineLog;
  private conversations!: SqlCsStore;
  private assistantStore!: SqlAssistantStore;
  private salesStore!: SqlSalesStore;
  private office!: OfficeService;
  private vault!: TokenVault;
  private spentStates!: SpentStates;
  /** Exports being written, part by part, for the Worker (export.ts). */
  private exports: OfficeExports | null = null;
  private day = "";
  /** Requests inside `route()` now; a failed one reopens the books only when it is alone. */
  private routing = 0;
  /** Null until the office knows who it is; an office that does not know does nothing. */
  private officeId: string | null = null;
  private ingestEmail = "";
  private businessName = "";
  private slug = "";
  private ai!: Ai;
  private csAi!: Ai;
  private eaAi!: Ai;

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
    // The SDK takes its name from the runtime, which alarms set before 2026-03-15 do not carry; this is the name it falls back to.
    if ((await this.ctx.storage.get(LEGACY_NAME)) !== id) await this.ctx.storage.put(LEGACY_NAME, id);
    this.officeId = id;
    this.businessName = row.name;
    const routes = await this.plane().routesOf(id, "email");
    const primary = ingestAddress(row.slug, this.env.INGEST_DOMAIN);
    this.ingestEmail = routes.some((r) => r.externalId === primary) ? primary : (routes[0]?.externalId ?? primary);
    this.slug = row.slug;
    this.ai = meteredAi(this.env.AI, () => take(this.kv.bind(this), istDate(), "ai"));
    this.csAi = meteredAi(this.env.AI, () => take(this.kv.bind(this), istDate(), "cs_ai"));
    this.eaAi = meteredAi(this.env.AI, () => take(this.kv.bind(this), istDate(), "ea_ai"));

    this.store = new BooksStore(sql);
    this.edits = new SqlEditLog(sql);
    this.runs = new SqlRoutineLog(sql);
    this.conversations = new SqlCsStore(sql);
    this.assistantStore = new SqlAssistantStore(sql);
    this.salesStore = new SqlSalesStore(sql);
    this.vault = new TokenVault(sql, this.env.SOCIAL_TOKEN_KEY, id);
    this.spentStates = new SpentStates(sql);
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
    this.office = new OfficeService(books, { asOf: this.day, ingestEmail: this.ingestEmail, routines: this.runs, conversations: this.conversations, assistant: this.assistantStore, sales: this.salesStore, edits: this.edits, backup: () => this.backupStatus() });
    const saved = this.kv("settings");
    if (saved) this.office.updateSettings(JSON.parse(saved));
    this.social().reconcile();
  }

  /**
   * A request that threw is undone: the engine opens again on the books as last saved, so whatever it changed
   * before the error is not saved by the next request. The store already holds them, so this costs a read only on failure.
   */
  private reopen() {
    try {
      const saved = this.store.load();
      if (saved) this.open(saved);
    } catch (e) {
      this.log("could not reopen the books after a failed request", e);
    }
  }

  /** The books' date follows the calendar in India. */
  private fresh() {
    if (istDate() !== this.day) this.open(this.office.books);
  }

  /** Saves the books, after writing what changed to the edit log as done by `by`. */
  private commit(by = BRAND.name) {
    this.office.recordEdits(by);
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

  /** Whatever the last change asked of the platforms and of customers goes out now, then the next alarm is set. */
  private async afterChange() {
    const effects = this.office.takeEffects();
    if (effects.length) await this.social().run(effects);
    await this.desk().run();
    await this.armPublishing();
  }

  private desk(): CustomerDesk {
    return new CustomerDesk({
      office: this.office,
      kv: this.kv.bind(this),
      ai: this.env.AI ? this.csAi : null,
      ownKeys: async () => {
        const k = await this.ownWaKeys();
        return k && k.phoneId !== this.env.WHATSAPP_PHONE_NUMBER_ID ? k : null;
      },
      sharedKeys: () => this.sharedWaKeys(),
      send: mailSender(this.env),
      mailFrom: this.env.MAIL_FROM,
      businessName: this.office.books.business.name || this.businessName,
      supportAddress: this.office.books.customerService.supportEmail,
      ownersOnWhatsApp: () => new WaDirectory(this.env.DB).linksIn(this.officeId!),
      log: (m, e) => this.log(m, e),
    });
  }

  /**
   * The Customer Service agent's addresses follow its hiring and the owner's switch: a support address
   * while it is on the team, and the website chat's key while the chat is on. Anything else is dropped.
   */
  private async syncCustomerRoutes() {
    const plane = this.plane();
    const cs = this.office.books.customerService;
    const hired = this.office.hired(CS_AGENT);
    const want = new Set<string>();
    const address = supportAddress(this.slug, this.env.INGEST_DOMAIN);
    if (hired && address) want.add(`support_email|${address}`);
    if (hired && cs.widget.enabled && cs.widget.key) want.add(`widget|${cs.widget.key}`);
    for (const r of await plane.routesOf(this.officeId!)) if ((r.kind === "support_email" || r.kind === "widget") && !want.has(`${r.kind}|${r.externalId}`)) await plane.dropRoute(this.officeId!, r.kind, r.externalId);
    for (const w of want) {
      const [kind, id] = w.split("|") as [RouteKind, string];
      await plane.claimRoute(this.officeId!, kind, id);
    }
    cs.supportEmail = hired ? address : null;
  }

  /** The website chat, as one visitor sees it: their messages and the replies that went out. */
  private chatMessages(visitor: string) {
    const t = this.conversations.threadByKey("web", visitor);
    const messages = t && !t.test ? this.conversations.messages(t.id).filter((m) => m.direction === "in" || m.status === "sent").map((m) => ({ id: m.id, at: m.at, from: m.direction === "in" ? ("you" as const) : ("us" as const), text: m.text })) : [];
    return { messages, business: this.office.books.business.name || this.businessName };
  }

  /** A post's time has come: it is checked again, then published, held back or left for posting by hand. */
  async publishTick() {
    if (!this.officeId || this.kv("office:purged")) return;
    this.fresh();
    await runOne(this.office, "publish-posts", "schedule", this.routineHost());
    await this.afterChange();
    this.commit();
  }

  /** Publishes whatever is due and says what happened, counted from the posts before and after. */
  private async publishNow(): Promise<StepResult> {
    const count = () => {
      const all = this.office.books.posts.flatMap((p) => p.variants);
      return { published: all.filter((v) => v.status === "published").length, failed: all.filter((v) => v.status === "failed").length };
    };
    const before = count();
    this.office.publishDue(new Date().toISOString());
    const effects = this.office.takeEffects();
    if (effects.length) await this.social().run(effects);
    const after = count();
    const published = after.published - before.published;
    const failed = Math.max(0, after.failed - before.failed);
    if (!published && !failed) return { outcome: "nothing", summary: effects.length ? "Posts were due, but none went out; they are held back or ready to post by hand." : "No post was due.", counts: { published: 0, failed: 0 } };
    return { outcome: failed ? (published ? "partial" : "failed") : "ok", summary: `${published} ${published === 1 ? "post" : "posts"} published${failed ? `; ${failed} failed and will be retried or held for you` : ""}.`, counts: { published, failed } };
  }

  /** What the routines need from this office: email, WhatsApp and the platforms. */
  private routineHost(): RoutineHost {
    return {
      sendReminders: (items) => this.send(items),
      socialMorning: () => this.socialMorning(),
      publish: () => this.publishNow(),
      digest: (notes) => this.digest(notes),
      refreshCalendars: () => this.refreshCalendars(),
    };
  }

  /** The SDK routes any path with `/sub/<class>/<name>` to a child agent of that name; an office has none, so no path reaches one. */
  async onBeforeSubAgent(): Promise<Response> {
    return json({ error: "Not found" }, 404);
  }

  /**
   * Open browsers listen here. The Worker checked the membership; this checks the request was meant for this office.
   * Browsers only hear `{"type":"changed"}`: the SDK's own frames (identity, state, MCP servers) are never sent, so
   * nothing goes out on a socket before this check, and none of them goes out after it.
   */
  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const caller = await this.callerOf(ctx.request);
    if (!this.officeId || !caller || caller.officeId !== this.officeId) {
      connection.close(1008, "Not found");
      return;
    }
    return super.onConnect(connection, ctx);
  }

  shouldSendProtocolMessages(): boolean {
    return false;
  }

  shouldConnectionBeReadonly(): boolean {
    return true;
  }

  /** Each socket is tagged with whose it is, so a person's sockets can be closed when they leave. */
  getConnectionTags(_connection: Connection, ctx: ConnectionContext): string[] {
    const caller = claimedCaller(ctx.request);
    return caller ? [userTag(caller.userId)] : [];
  }

  /** Browsers never speak on this socket. Anything sent, the SDK's state and RPC frames included, closes it unread. */
  async webSocketMessage(ws: WebSocket) {
    ws.close(1008, "This connection only listens.");
  }

  /** Someone left the office (`userId`), or it was suspended or deleted (everyone): their open screens stop hearing it. */
  private disconnect(userId: string | null): number {
    let closed = 0;
    for (const c of [...this.getConnections(userId ? userTag(userId) : undefined)]) {
      c.close(1008, userId ? "You are no longer in this office." : "This office is closed.");
      closed++;
    }
    return closed;
  }

  /** Who is asking, only if the Worker set and sealed it; anything else is no one. */
  private async callerOf(request: Request): Promise<Caller | null> {
    const header = request.headers.get(CALLER_HEADER);
    if (!header || !(await callerSealed(this.env.BETTER_AUTH_SECRET, header, request.headers.get(CALLER_SEAL_HEADER)))) return null;
    return claimedCaller(request);
  }

  async onRequest(request: Request): Promise<Response> {
    const caller = await this.callerOf(request);
    if (!caller) return json({ error: "Sign in to continue." }, 401);
    if (!this.officeId || caller.officeId !== this.officeId) return json({ error: "Not found" }, 404);
    const path = new URL(request.url).pathname;
    // Mail, webhooks, export, purge and closing sockets are the office's own work, asked for by the Worker, never by a person.
    if (path.startsWith("/internal/") && caller.userId !== SYSTEM_USER) return json({ error: "Not found" }, 404);
    if (request.method === "POST" && path === "/internal/disconnect") {
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
      return json({ closed: this.disconnect(typeof body.userId === "string" && body.userId ? body.userId : null) });
    }
    // Purging twice is done: the Worker retries a purge whose last steps failed, and must be able to finish it.
    if (request.method === "POST" && path === "/internal/purge" && this.kv("office:purged")) return json({ purged: true });
    if (this.kv("office:purged")) return json({ error: "Not found" }, 404);
    if (request.method === "POST" && path === "/internal/purge") {
      if (this.office && !this.env.SOCIAL_TOKEN_KEY) return json({ error: "SOCIAL_TOKEN_KEY is not set, so the books cannot be sealed for keeping: the office is not purged." }, 503);
      return json(await this.purge());
    }
    this.fresh();
    // The export only reads: its plan and parts skip the save that follows every other request.
    if (request.method === "POST" && path.startsWith("/internal/export/")) return this.exportRequest(path, request);
    this.routing++;
    try {
      const res = await this.route(request, caller)
        .catch((e: unknown) => {
          // Another request still working holds the engine it started on; swapping it would drop that request's changes.
          if (this.routing === 1) this.reopen();
          else this.log("a request failed while another was running; the books were not reopened");
          throw e;
        })
        .finally(() => this.routing--);
      if (request.method !== "GET" || res.status === 302) {
        this.office.recordEdits(caller.name);
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

    if (post && path === "/internal/mail-admit") return json(await this.admitMail((await request.json()) as MailAdmission));
    if (post && path === "/internal/email") return json(await this.receiveEmail((await request.json()) as MailDocs));
    if (post && path === "/internal/social/meta") return json(await this.receiveMeta(await request.json()));
    if (post && path === "/internal/whatsapp") return json(await this.receiveShared((await request.json()) as SharedMessage));
    if (post && path === "/internal/support-email") return json(await this.receiveSupport((await request.json()) as SupportMail));
    if (post && path === "/internal/sales-email") return json(await this.receiveSalesMail((await request.json()) as MailDocs));
    if (post && path === ROUTES.salesUpload) return this.uploadSales(request, caller);
    if (post && path === "/internal/assistant-email") return json(await this.receiveForAssistant((await request.json()) as AssistantInbound));
    if (path === ROUTES.assistantCalendar && (request.method === "PUT" || request.method === "DELETE")) return this.assistantCalendar(request, caller);
    if (request.method === "GET" && path === ROUTES.assistant && caller.role === "owner") await this.refreshCalendar(caller.email, 60 * 60_000);
    if (post && path === "/internal/chat") {
      const body = (await request.json()) as ChatPostBody;
      if (!this.office.hired(CS_AGENT) || !this.office.books.customerService.widget.enabled) return json({ error: "This chat is closed." }, 404);
      await this.desk().receive({ channel: "web", key: body.visitor, name: body.name || "Website visitor", text: body.text });
      return json(this.chatMessages(body.visitor));
    }
    if (post && path === "/internal/chat-messages") {
      const body = (await request.json()) as { visitor: string };
      return json(this.chatMessages(body.visitor));
    }
    if (post && path === "/api/customers/try") {
      if (caller.role !== "owner") return json({ error: "Only the owner can try the agent." }, 403);
      const body = (await request.json().catch(() => ({}))) as { text?: unknown };
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
      if (!text) return json({ error: "Write a message to try." }, 400);
      const r = await this.desk().receive({ channel: "web", key: `try:${caller.userId}`, name: "You, trying it", text, test: true });
      return json({ thread: this.office.customers.threadView(r.thread.id), notes: r.notes });
    }
    if (post && path === "/api/documents") return this.upload(request, caller);
    if (post && path === ROUTES.complianceProof) return this.uploadProof(request, caller);
    if (post && (path === ROUTES.onboardingCheck || path === ROUTES.onboardingStage)) return this.onboarding(request, caller, path === ROUTES.onboardingStage);
    if (post && path === "/api/social/media" && request.headers.get("content-type")?.includes("multipart")) return this.uploadMedia(request, caller);
    const channel = /^\/api\/channels\/([a-z]+)\/(connect|callback)$/.exec(path);
    if (request.method === "GET" && channel) return channel[2] === "connect" ? this.startConnect(channel[1]!, caller) : this.finishConnect(channel[1]!, url, caller);
    const doc = /^\/api\/documents\/([^/]+)\/(read|scan)$/.exec(path);
    if (post && doc) return this.readStored(decodeURIComponent(doc[1]!), doc[2] as "read" | "scan", request);
    if (path === "/api/prefs") return this.prefs(request, caller);
    if (request.method === "GET" && path === ROUTES.ambient) return json(ambientFrom(this.office.books, readPersonaNames(this.kv("personas")), this.day));
    if (path === ROUTES.personas && (request.method === "PUT" || post)) {
      if (caller.role !== "owner") return json({ error: "Only the owner can rename the team." }, 403);
      const checked = checkPersonaNames(await request.json().catch(() => null));
      if ("error" in checked) return json(checked, 400);
      this.kv("personas", JSON.stringify(checked.names));
      return json({ names: checked.names });
    }
    if (request.method === "GET" && path === "/api/routines") return json({ routines: routinesView(this.office, Date.now(), this.social().nextWake()) });
    const runRoutine = /^\/api\/routines\/([a-z-]+)\/run$/.exec(path);
    if (post && runRoutine) {
      if (caller.role !== "owner") return json({ error: "Only the owner can run a routine." }, 403);
      try {
        return json(await runNow(this.office, runRoutine[1]!, this.routineHost()));
      } catch (e) {
        if (e instanceof RoutineError) return json({ error: e.message }, 409);
        if (e instanceof Error && e.message.startsWith("Unknown routine")) return json({ error: "Routine not found" }, 404);
        throw e;
      }
    }
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

    if (/^\/api\/desk\/[^/]+$/.test(path) && post) {
      const item = res.body as StagedChange;
      if (item.kind === "email_reply") await this.sendReply(caller, item);
      else await this.send([item]);
    }
    if (path.startsWith("/api/channels") && request.method !== "GET") await this.syncRoutes();
    if (request.method !== "GET" && (path === `/api/hiring/${CS_AGENT}` || path === "/api/customers/widget")) await this.syncCustomerRoutes();
    if (request.method !== "GET" && path === "/api/hiring/executive-assistant") await this.syncAssistantRoute();
    if (request.method !== "GET" && path === "/api/hiring/marketplace-manager") await this.syncSalesRoute();
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

  /** `/internal/export/plan` lists what goes in the archive; `/internal/export/part` streams one part of it. */
  private async exportRequest(path: string, request: Request): Promise<Response> {
    this.exports ??= new OfficeExports(this.env.DOCS);
    try {
      if (path === "/internal/export/plan") return json(await this.exports.plan(this.officeId!, this.exportBooks()));
      if (path === "/internal/export/part") {
        const body = (await request.json().catch(() => ({}))) as { id?: unknown; part?: unknown };
        const res = typeof body.id === "string" && Number.isInteger(body.part) ? this.exports.part(body.id, body.part as number) : null;
        return res ?? json({ error: "No such export. Start it again." }, 410);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      this.log("export failed", e);
      return json({ error: "The office could not be read. Try again." }, 500);
    }
  }

  /** The end of a deleted office: its books and edit log are sealed and kept, then its storage and alarms go. The Worker removes its files and rows. */
  private async purge() {
    if (this.office) {
      const at = new Date().toISOString();
      const keepUntil = retainedUntil(new Date());
      const sealed = await sealedCopy(this.env.SOCIAL_TOKEN_KEY!, this.officeId!, { office: this.officeId, purgedAt: at, keepUntil, books: this.office.books, edits: this.edits.all() });
      await this.env.DOCS.put(retainedKey(this.officeId!, at), sealed, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { keepUntil, sealed: "OFB1", reason: "Companies Act s.128(5): books and their edit log are kept for eight years" },
      });
    }
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
    if (!state || state.officeId !== this.officeId || state.by !== caller.email || !code || !adapter || !ch || !this.spentStates.spend(state)) return this.back({ connect_error: "The sign-in expired or did not come from this office. Try again." });
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
    for (const r of await plane.routesOf(this.officeId!)) if (r.kind !== "email" && r.kind !== "support_email" && r.kind !== "widget" && r.kind !== "assistant_email" && r.kind !== "sales_email" && !want.has(`${r.kind}|${r.externalId}`)) await plane.dropRoute(this.officeId!, r.kind, r.externalId);
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
      const cmd = m.kind === "text" ? parseCommand(m.text) : null;
      if (cmd?.kind === "join") {
        const r = await dir.redeem(m.from, cmd.code, this.officeId!);
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
    const delivered = parseMetaDelivery(body, own, Date.now(), (from) => people.has(from.replace(/\D/g, ""))).filter((m) => !m.externalId || !handled.has(m.externalId));
    const { customers, rest } = splitCustomerDms(delivered, this.office.hired(CS_AGENT));
    const desk = this.desk();
    for (const m of customers) await desk.receive(m).catch((e) => this.log("customer message failed", e));
    const raws = rest.map((m) => ({ ...m, channelId: byPlatform.get(m.platform) ?? "" })).filter((m) => m.channelId);
    const r = this.office.receiveMessages(raws);
    return { received: r.added.length, leads: r.leads, replied: r.replied, office, customers: customers.length };
  }

  /** Mail to the support address. Mail from someone in the office is ignored; they answer from the desk. */
  private async receiveSupport(mail: SupportMail) {
    if (!this.office.hired(CS_AGENT)) return { outcome: "ignored" };
    const r = await this.desk().receive(toSupportInbound(mail));
    return { outcome: r.outcome, thread: r.thread.id };
  }

  /** The assistant's address follows its hiring: `<slug>.assistant@…` while it is on the team. */
  private async syncAssistantRoute() {
    const plane = this.plane();
    const address = assistantAddress(ingestAddress(this.slug, this.env.INGEST_DOMAIN));
    const hired = this.office.hired("executive-assistant");
    for (const r of await plane.routesOf(this.officeId!)) if (r.kind === "assistant_email" && (!hired || r.externalId !== address)) await plane.dropRoute(this.officeId!, r.kind, r.externalId);
    if (hired && address) await plane.claimRoute(this.officeId!, "assistant_email", address);
  }

  /** The Marketplace Manager's address follows its hiring: `<slug>.sales@…` while it is on the team. */
  private async syncSalesRoute() {
    const plane = this.plane();
    const address = salesAddress(ingestAddress(this.slug, this.env.INGEST_DOMAIN));
    const hired = this.office.hired("marketplace-manager");
    for (const r of await plane.routesOf(this.officeId!)) if (r.kind === "sales_email" && (!hired || r.externalId !== address)) await plane.dropRoute(this.officeId!, r.kind, r.externalId);
    if (hired && address) await plane.claimRoute(this.officeId!, "sales_email", address);
  }

  /**
   * Reports mailed to the sales address. Taken from the platforms' own domains and from people in
   * this office (who forward what the platforms sent them), when the sender is proven; anything else
   * is dropped unread.
   */
  private async receiveSalesMail(mail: MailDocs) {
    if (!this.office.hired("marketplace-manager")) return { outcome: "ignored" };
    const members = new Set((await this.plane().members(this.officeId!)).map((u) => u.email.toLowerCase()));
    const sender = salesSender(members, mail);
    if (!sender) {
      for (const d of mail.docs) await this.env.DOCS.delete(docKey(this.officeId!, d.id));
      this.office.log("marketplace-manager", "Set aside an email to the sales address from someone outside the office and the platforms, or whose sender could not be verified.");
      return { outcome: "refused" };
    }
    let read = 0;
    for (const d of mail.docs) {
      const obj = await this.env.DOCS.get(docKey(this.officeId!, d.id));
      if (!obj) continue;
      const r = await readSalesFile(this.office, { name: d.filename, bytes: await obj.arrayBuffer(), via: "email", sender });
      read += r.filter((i) => i.status === "read" || i.status === "payout").length;
    }
    if (!mail.docs.length) this.office.log("marketplace-manager", `An email to the sales address had no report attached${mail.skipped.length ? ` (${mail.skipped.length} file${mail.skipped.length === 1 ? "" : "s"} it could not read)` : ""}. If the platform sends a link, download the report and forward it.`);
    return { outcome: "read", read };
  }

  /** A report uploaded in the Marketplace Manager's room. */
  private async uploadSales(request: Request, caller: Caller): Promise<Response> {
    if (caller.role !== "owner") return json({ error: "Only the owner can add sales reports." }, 403);
    if (!this.office.hired("marketplace-manager")) return json({ error: "Hire the Marketplace Manager first." }, 409);
    const parsed = SalesUploadInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Attach a CSV, XLSX or zip file." }, 400);
    const bytes = parsed.data.encoding === "base64" ? Uint8Array.from(atob(parsed.data.content), (c) => c.charCodeAt(0)) : new TextEncoder().encode(parsed.data.content);
    if (bytes.byteLength > MAX_UPLOAD) return json({ error: "Files up to 10 MB, please." }, 413);
    take(this.kv.bind(this), istDate(), "upload", bytes.byteLength);
    const id = newDocId();
    await this.env.DOCS.put(docKey(this.officeId!, id), bytes, { customMetadata: { filename: parsed.data.file, by: caller.email } });
    const imports = await readSalesFile(this.office, { name: parsed.data.file, bytes: bytes.buffer as ArrayBuffer, via: "upload", sender: caller.email });
    return json({ imports, message: salesReply(imports), report: this.office.sales.report() });
  }

  private calendarKey = (owner: string) => `ea-cal:${owner.trim().toLowerCase()}`;

  /** The owner pastes their calendar's private address: it is read at once, and kept sealed like a platform token. */
  private async assistantCalendar(request: Request, caller: Caller): Promise<Response> {
    if (caller.role !== "owner") return json({ error: "The assistant works for each owner on their own." }, 403);
    const sample = this.env.OFFICE_SEED === "sample";
    if (request.method === "DELETE") {
      this.vault.drop(this.calendarKey(caller.email));
      this.office.assistant.clearCalendar(caller.email);
      return json(this.office.assistant.view(caller.email, sample));
    }
    const parsed = CalendarLinkInput.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Paste your calendar's private address." }, 400);
    if (!this.vault.ready) return json({ error: "The office cannot keep secrets yet: SOCIAL_TOKEN_KEY is not set." }, 503);
    const r = await fetchCalendar(parsed.data.url, this.day);
    if ("error" in r) return json({ error: r.error }, 422);
    await this.vault.put(this.calendarKey(caller.email), { access: parsed.data.url, refresh: null, expiresAt: null, account: caller.email.toLowerCase(), extra: {} });
    this.office.assistant.setCalendar(caller.email, r);
    return json(this.office.assistant.view(caller.email, sample));
  }

  /** Reads one owner's calendar again if the last copy is older than `staleMs`. */
  private async refreshCalendar(owner: string, staleMs: number): Promise<"read" | "failed" | "skipped"> {
    const doc = this.assistantStore.load(owner);
    if (!doc.calendar || (doc.calendar.fetchedAt && Date.now() - Date.parse(doc.calendar.fetchedAt) < staleMs)) return "skipped";
    const t = await this.vault.get(this.calendarKey(owner));
    if (!t) return "skipped";
    const r = await fetchCalendar(t.access, this.day);
    this.office.assistant.setCalendar(owner, r);
    return "error" in r ? "failed" : "read";
  }

  /** The morning: every owner's calendar read again. Owners who have left the office lose their record. */
  private async refreshCalendars(): Promise<{ read: number; failed: number }> {
    const owners = new Set((await this.plane().members(this.officeId!)).filter((u) => u.role === "owner").map((u) => u.email.toLowerCase()));
    let read = 0;
    let failed = 0;
    for (const o of this.assistantStore.owners()) {
      if (!owners.has(o)) {
        this.assistantStore.remove(o);
        this.vault.drop(this.calendarKey(o));
        continue;
      }
      const r = await this.refreshCalendar(o, 30 * 60_000);
      if (r === "read") read++;
      else if (r === "failed") failed++;
    }
    return { read, failed };
  }

  /**
   * Mail to the assistant's address. Only an owner's own mail is taken: forwarded by hand, or by a
   * Gmail filter (which sends as the owner), and proven so (see `ownerOf`). A bill goes to the
   * Accountant; anything else gets a draft. Mail that only claims to be an owner's is not drafted
   * from: its attachments wait on the desk, and the rest is set aside with a line in the log.
   */
  private async receiveForAssistant(mail: AssistantInbound) {
    if (!this.office.hired("executive-assistant")) return { outcome: "ignored" };
    const conf = fromGoogleForwarding(mail) ? gmailConfirmation(mail.from ?? mail.envelope, mail.subject, mail.text) : null;
    if (conf) {
      this.office.assistant.noteForwarding(conf);
      return { outcome: "forwarding" };
    }
    const owners = (await this.plane().members(this.officeId!)).filter((u) => u.role === "owner");
    const who = ownerOf(owners, mail);
    if (!who) return { outcome: "ignored" };
    const owner = who.owner;
    const byHand = forwardedByHand(owner, mail);
    const fwd = byHand ? readForward(mail.text) : null;
    const original = fwd
      ? { from: fwd.from, fromName: fwd.name, subject: fwd.subject || mail.subject.replace(/^(fwd?|fw):\s*/i, ""), text: fwd.body, messageId: null }
      : byHand
        ? null
        : { from: plainAddress(mail.from) ?? "", fromName: mail.name, subject: mail.subject, text: mail.text, messageId: mail.messageId };
    // By hand, the proven owner vouches for what they forward; by a filter, the message speaks for its own sender.
    const authenticated = who.proven && Boolean(mail.authenticated);
    if (!who.proven) this.office.log("executive-assistant", `Mail to the assistant's address said it was from ${owner.name} but could not be verified, so no reply was drafted${mail.docs.length && this.office.hired("accountant") ? "; its attachments wait on the desk" : ""}.`);
    if (mail.docs.length && this.office.hired("accountant")) {
      await this.receiveEmail({ from: original?.from ?? owner.email, subject: original?.subject ?? mail.subject, docs: mail.docs, skipped: mail.skipped, authenticated });
      if (!who.proven) return { outcome: "held" };
      this.office.assistant.receiveMail(owner.email, { from: original?.from ?? owner.email, fromName: original?.fromName ?? null, replyTo: null, subject: original?.subject ?? mail.subject, text: (original?.text ?? mail.text).slice(0, 6000), messageId: original?.messageId ?? null }, null, "to_accountant");
      return { outcome: "to_accountant" };
    }
    if (!who.proven) {
      for (const d of mail.docs) await this.env.DOCS.delete(docKey(this.officeId!, d.id));
      return { outcome: "unverified" };
    }
    if (!original || !original.from) {
      this.office.assistant.receiveMail(owner.email, { from: owner.email, fromName: owner.name, replyTo: null, subject: mail.subject, text: mail.text.slice(0, 6000), messageId: null }, null, "noted");
      return { outcome: "noted" };
    }
    const draft = await draftReply(this.env.AI ? this.eaAi : null, this.office, original, owner.name);
    const r = this.office.assistant.receiveMail(owner.email, { from: original.from, fromName: original.fromName, replyTo: original.from, subject: original.subject, text: original.text.slice(0, 6000), messageId: original.messageId }, draft);
    return { outcome: "drafted", draft: r.draft?.id ?? null };
  }

  /** An approved reply leaves from the office's address in the owner's name; the answer comes back to the owner. */
  private async sendReply(caller: Caller, item: StagedChange) {
    if (item.status !== "approved") return;
    const p = item.payload as { to?: string; subject?: string; body?: string; inReplyTo?: string | null; sentAt?: string };
    if (p.sentAt) return;
    const send = mailSender(this.env);
    if (!send || !p.to || !p.subject || !p.body) {
      this.office.assistant.markSent(caller.email, item.id, { sendError: "Email is not set up for this office. Copy the reply and send it yourself." });
      return;
    }
    try {
      await send({ fromName: `${caller.name}, ${this.office.books.business.name || this.businessName}`, to: p.to, replyTo: caller.email, subject: p.subject, body: p.body, inReplyTo: p.inReplyTo ?? null });
      this.office.assistant.markSent(caller.email, item.id, { sentAt: new Date().toISOString() });
    } catch (e) {
      this.office.assistant.markSent(caller.email, item.id, { sendError: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
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
      ...(this.office.hired("marketplace-manager") ? { readSales: async (_id: string, name: string, bytes: ArrayBuffer) => salesReply(await readSalesFile(this.office, { name, bytes, via: "whatsapp", sender: null })) } : {}),
      readItems: (id, items, auto) => this.readItems(id, items, auto),
    };
  }

  /** Settings, under Your WhatsApp: a code to link this person's phone, their reply language and the morning digest. */
  private async whatsappRoute(request: Request, caller: Caller, path: string): Promise<Response> {
    const dir = new WaDirectory(this.env.DB);
    const status = async (): Promise<WhatsAppStatus> => {
      const l = await dir.linkOfUser(caller.userId);
      const handle = this.office.books.channels.find((c) => c.platform === "whatsapp")?.handle ?? null;
      return { available: Boolean(this.sharedWaKeys()), linked: Boolean(l), number: l ? maskPhone(l.phone) : null, linkedAt: l ? new Date(l.linkedAt).toISOString() : null, language: l?.language ?? "auto", digest: l?.digest ?? false, businessNumber: handle && /\d{6}/.test(handle.replace(/\D/g, "")) ? handle : null, template: Boolean(this.env.WHATSAPP_TEMPLATE) };
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

  /** Existing books, as the templates' CSVs. Staging keeps each file, so every brought-forward item links back to its row. */
  private async onboarding(request: Request, caller: Caller, stage: boolean): Promise<Response> {
    const text = await request.text();
    if (text.length > MAX_IMPORT) return json({ error: "Up to 3 files of 1 MB each, please. Split a bigger file in two." }, 413);
    const parsed = ImportCheck.safeParse(parseJson(text));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Attach the files to bring in." }, 400);
    const preview = this.office.checkOnboarding(parsed.data);
    if (!stage) return json(preview);
    if (!preview.ready) return json({ error: "Some rows need fixing first.", preview }, 422);
    const files = await Promise.all(
      parsed.data.files.map(async (f) => {
        const id = newDocId();
        await this.env.DOCS.put(docKey(this.officeId!, id), f.csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" }, customMetadata: { filename: f.name, by: caller.email } });
        return { ...f, file: fileUrl(this.officeId!, id) };
      }),
    );
    const r = this.office.stageOnboarding({ ...parsed.data, files }, caller.name);
    return r.item ? json(r) : json({ error: "Some rows need fixing first.", preview: r.preview }, 422);
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
    const auto = doc.channel !== "email" || this.knownSender(doc.from, doc.id);
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

  /** Only mail from a party already in the books, proven to be theirs, may be posted without the owner. */
  private knownSender(from: string | null, docId: string): boolean {
    return postsAlone(this.office.books.parties, from, this.kv(`mail:verified:${docId}`) === "1");
  }

  /**
   * Asked by the Worker before it stores anything of a message: this hour's limits for the sender
   * and the office, the sender itself, then today's upload allowance. A refusal leaves one line in
   * the team log (a limit, once an hour), and nothing of the message is kept.
   */
  private async admitMail(a: MailAdmission) {
    const proven = provenSender(a)?.slice(0, 120) ?? null;
    const sender = (proven ?? plainAddress(a.from) ?? plainAddress(a.envelope) ?? "an unknown sender").slice(0, 120);
    let rate: MailRate | null = null;
    try {
      rate = JSON.parse(this.kv("mail:rate") ?? "null") as MailRate | null;
    } catch {
      rate = null;
    }
    const counted = countMail(rate, new Date().toISOString().slice(0, 13), proven);
    this.kv("mail:rate", JSON.stringify(counted.state));
    if (counted.refused) {
      if (counted.first) this.office.log("office-manager", MAIL_REFUSED[counted.refused](sender));
      return { admit: false };
    }
    const members = a.kind === "sales" || a.kind === "assistant" ? await this.plane().members(this.officeId!) : [];
    const ok = mailSenderOk(a, { hired: (agent) => this.office.hired(agent), members });
    if (ok === "refuse") this.office.log("marketplace-manager", "Set aside an email to the sales address from someone outside the office and the platforms, or whose sender could not be verified.");
    if (ok !== "admit") return { admit: false };
    if (a.bytes > 0 && proven) {
      try {
        take(this.kv.bind(this), istDate(), "upload", a.bytes);
      } catch (e) {
        if (!(e instanceof QuotaError)) throw e;
        this.office.log("office-manager", `Set aside an email from ${sender}: ${e.message}`);
        return { admit: false };
      }
    } else if (a.bytes > 0) {
      // Unproven mail has its own small allowance, so it cannot use up the office's uploads for the day.
      const key = `mail:unproven-bytes:${istDate()}`;
      const used = Number(this.kv(key) ?? 0);
      if (used + a.bytes > MAIL_LIMITS.unprovenBytesDay) {
        if (used <= MAIL_LIMITS.unprovenBytesDay) this.office.log("office-manager", "Set aside attachments from senders that could not be verified: today's allowance for them is used up. It starts again tomorrow.");
        this.kv(key, String(MAIL_LIMITS.unprovenBytesDay + 1));
        return { admit: false };
      }
      this.kv(key, String(used + a.bytes));
    }
    return { admit: true };
  }

  private async receiveEmail(mail: MailDocs) {
    const auto = postsAlone(this.office.books.parties, mail.from, mail.authenticated === true);
    const results = [];
    for (const d of mail.docs) {
      if (mail.authenticated === true) this.kv(`mail:verified:${d.id}`, "1");
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

  /**
   * Approved reminders leave from the shared address under the business's name; replies go to the business.
   * Each records when it went, or why it did not and how many times it was tried, so the morning can try again.
   */
  private async send(items: StagedChange[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const it of items) {
      if (it.kind !== "reminder" || it.status !== "approved") continue;
      const p = it.payload as { to?: string; subject?: string; body?: string; partyId?: string; sentAt?: string; sendError?: string; attempts?: number; triedAt?: string };
      if (p.sentAt) continue;
      const ref = { kind: "party" as const, id: p.partyId ?? null };
      p.attempts = (p.attempts ?? 0) + 1;
      p.triedAt = new Date().toISOString();
      const send = mailSender(this.env);
      if (!send || !p.to || !p.subject || !p.body) {
        p.sendError = "Email is not set up for this office.";
        this.office.log("credit-controller", `Could not send the reminder to ${p.to ?? "the customer"}: email is not set up for this office.`, ref);
        failed++;
        continue;
      }
      try {
        const replyTo = this.office.settings().reminderPolicy.sendFrom || this.office.books.business.email || undefined;
        await send({ fromName: this.office.books.business.name || this.businessName, to: p.to, replyTo, subject: p.subject, body: p.body });
        p.sentAt = new Date().toISOString();
        delete p.sendError;
        sent++;
      } catch (e) {
        p.sendError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        this.office.log("credit-controller", `Could not send the reminder to ${p.to}: ${p.sendError}`, ref);
        failed++;
      }
    }
    return { sent, failed };
  }

  /** Each morning: every routine in turn, each recorded on its own, and the digest last with what they found. */
  async daily() {
    if (!this.officeId || this.kv("office:purged")) return;
    const row = await this.plane().office(this.officeId);
    if (!row || row.status !== "active") return;
    this.fresh();
    await morningRound(this.office, this.routineHost());
    await this.afterChange();
    this.commit();
    await this.backupToIndia();
  }

  /** Today's copy of the books and the edit log, sealed, on servers in India. A failure is recorded and shown in Settings, and tried again tomorrow. */
  private async backupToIndia() {
    const target = backupTarget(this.env);
    if (!target) return;
    const at = new Date().toISOString();
    try {
      if (!this.env.SOCIAL_TOKEN_KEY) throw new Error("SOCIAL_TOKEN_KEY is not set, so the copy cannot be encrypted and was not sent.");
      const body = await sealedCopy(this.env.SOCIAL_TOKEN_KEY, this.officeId!, { office: this.officeId, at, books: this.office.books, edits: this.edits.all() });
      await putObject(target, backupKey(this.officeId!, istDate()), body, "application/octet-stream");
      this.kv("backup:last", JSON.stringify({ at, error: null }));
    } catch (e) {
      this.log("backup to India failed", e);
      const prev = JSON.parse(this.kv("backup:last") ?? "{}") as { at?: string | null };
      this.kv("backup:last", JSON.stringify({ at: prev.at ?? null, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  private backupStatus() {
    const target = backupTarget(this.env);
    const last = JSON.parse(this.kv("backup:last") ?? "{}") as { at?: string | null; error?: string | null };
    return {
      configured: Boolean(target),
      lastAt: last.at ?? null,
      lastError: last.error ?? null,
      where: target ? `${new URL(target.endpoint).host}, region ${target.region}` : "Not set up yet: the platform owner adds the bucket in India.",
    };
  }

  /** Proof of filing for a calendar item: the challan, acknowledgement or approval letter, kept with the office's files. */
  private async uploadProof(request: Request, caller: Caller): Promise<Response> {
    const form = await request.formData();
    const file = form.get("file") as File | string | null;
    if (!(file instanceof File)) return json({ error: "Attach a file." }, 400);
    if (file.size > MAX_UPLOAD) return json({ error: "Files up to 10 MB, please." }, 413);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf && !/^image\/(png|jpe?g|webp)$/.test(file.type)) return json({ error: "Send a PDF or a picture (PNG, JPEG or WebP)." }, 415);
    take(this.kv.bind(this), istDate(), "upload", file.size);
    const id = `proof-${crypto.randomUUID()}`;
    await this.env.DOCS.put(docKey(this.officeId!, id), await file.arrayBuffer(), { httpMetadata: { contentType: isPdf ? "application/pdf" : file.type }, customMetadata: { filename: file.name, by: caller.email } });
    return json({ file: fileUrl(this.officeId!, id), name: file.name.slice(0, 200) });
  }

  /** The owners hear what is waiting and what the routines found: on WhatsApp if they asked and it allows, otherwise by email. */
  private async digest(notes: string[]): Promise<StepResult> {
    const officeId = this.officeId!;
    const name = this.office.books.business.name || this.businessName;
    const pending = this.office.pending();
    const users = await this.plane().members(officeId);
    const onWhatsApp = await this.whatsappDigests(pending.length, notes);
    const owners = users.filter((u) => u.role === "owner" && !onWhatsApp.has(u.userId));
    const agendas = new Map(owners.map((o) => [o.userId, this.office.assistant.briefing(o.email)] as const));
    let emailed = 0;
    let failed = 0;
    const send = mailSender(this.env);
    if (send && owners.length && (pending.length || notes.length || [...agendas.values()].some(Boolean))) {
      const link = this.env.BETTER_AUTH_URL ? `${this.env.BETTER_AUTH_URL.replace(/\/$/, "")}/desk?office=${officeId}` : "";
      const body = [
        `Good morning. ${pending.length ? `${pending.length} ${pending.length === 1 ? "thing is" : "things are"} waiting on your desk at ${name}.` : `Nothing is waiting on your desk at ${name}.`}`,
        "",
        ...pending.slice(0, 12).map((s) => `- ${s.title}`),
        ...(pending.length > 12 ? [`- and ${pending.length - 12} more`] : []),
        ...(notes.length ? ["", "From this morning's routines:", ...notes.map((n) => `- ${n}`)] : []),
        ...(link ? ["", link] : []),
      ].join("\n");
      for (const o of owners) {
        const agenda = agendas.get(o.userId);
        if (!agenda && !pending.length && !notes.length) continue;
        try {
          const subject = pending.length ? `${name}: ${pending.length} waiting on your desk` : `${name} this morning`;
          // The agenda is this owner's own; nobody else's digest carries it.
          await send({ fromName: `${name} · ${BRAND.name}`, to: o.email, subject, body: agenda ? `${body}\n\nYour next three days, from your assistant:\n\n${agenda}` : body });
          emailed++;
        } catch (e) {
          failed++;
          this.office.log("office-manager", `Could not send the morning digest to ${o.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.office.log("office-manager", `Morning round: ${notes.length ? `${notes.join(" ")} ` : ""}${pending.length} waiting on your desk.`);
    const reached = emailed + onWhatsApp.size;
    if (!reached && !failed) return { outcome: "nothing", summary: pending.length || notes.length ? "No owner could be reached: email is not set up and nobody gets it on WhatsApp." : "Nothing to report this morning.", counts: { email: 0, whatsapp: 0, waiting: pending.length } };
    return { outcome: failed ? (reached ? "partial" : "failed") : "ok", summary: `Sent to ${reached} ${reached === 1 ? "owner" : "people"}${onWhatsApp.size ? `, ${onWhatsApp.size} on WhatsApp` : ""}${failed ? `; ${failed} could not be reached` : ""}. ${pending.length} waiting on the desk.`, counts: { email: emailed, whatsapp: onWhatsApp.size, waiting: pending.length, failed } };
  }

  /** Everyone in this office who asked for the digest on WhatsApp gets it there if WhatsApp allows; returns who was reached. */
  private async whatsappDigests(waiting: number, notes: string[]): Promise<Set<string>> {
    const found = notes.length ? `\n\n*From this morning's routines*\n${notes.map((n) => `• ${n}`).join("\n")}` : "";
    const reached = new Set<string>();
    const keys = this.sharedWaKeys();
    if (!keys) return reached;
    const kv = this.kv.bind(this);
    const plane = this.plane();
    for (const link of await new WaDirectory(this.env.DB).linksIn(this.officeId!)) {
      const how = digestChannel({ wantsWhatsApp: link.digest, lastAt: sessionFor(kv, link.phone).lastAt, now: Date.now(), template: Boolean(keys.template) });
      const heading = (await plane.officesOf(link.userId)).filter((o) => o.status === "active").length > 1 ? this.businessName : undefined;
      try {
        if (how === "whatsapp") await sendText(keys, link.phone, `${await morningDigest(this.waDeps(keys), link.phone, link, link.language === "auto" ? null : link.language, heading)}${found}`);
        else if (how === "template") await sendTemplate(keys, link.phone, `${heading ? `${heading}: ` : ""}${waiting} waiting on your desk${notes.length ? ` and ${notes.length} ${notes.length === 1 ? "note" : "notes"} from the routines` : ""}. Reply desk to see them.`);
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
  private async socialMorning(): Promise<StepResult> {
    const pulled = await this.social().pull();
    if (pulled.metrics) this.office.log("social-media-manager", `Updated the results of ${pulled.metrics} ${pulled.metrics === 1 ? "post" : "posts"} from the platforms.`);
    const published = await this.publishNow();
    const month = nextMonth(this.day.slice(0, 7));
    const draft = Number(this.day.slice(8, 10)) >= 25 && !this.office.books.calendars.some((c) => c.month === month && c.status !== "superseded");
    if (draft) this.office.draftCalendar(month);
    await this.afterChange();
    const parts = [
      pulled.metrics ? `results for ${pulled.metrics} ${pulled.metrics === 1 ? "post" : "posts"}` : "",
      pulled.messages ? `${pulled.messages} new ${pulled.messages === 1 ? "comment or review" : "comments and reviews"}` : "",
      published.counts?.published ? `${published.counts.published} overdue ${published.counts.published === 1 ? "post" : "posts"} published` : "",
      draft ? "next month's calendar drafted for your desk" : "",
    ].filter(Boolean);
    return parts.length ? { outcome: published.outcome === "failed" || published.outcome === "partial" ? "partial" : "ok", summary: `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()), counts: { metrics: pulled.metrics, messages: pulled.messages, published: published.counts?.published ?? 0, calendar: draft ? 1 : 0 } } : { outcome: "nothing", summary: "Nothing new from the platforms, and no post was overdue.", counts: { metrics: 0, messages: 0, published: 0, calendar: 0 } };
  }
}

type SharedMessage = { body: unknown; person: WaPerson | null; joined: boolean; heading?: string };
