import type { IngestResult, StagedChange } from "@office/contracts";
import { OfficeService, REVIEW_ON_DESK, type TextItem } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { describe, expect, it, vi } from "vitest";
import { parseMetaDelivery, parseWhatsAppMessages, type WaIncoming } from "../src/social/webhooks";
import { ControlPlane, type OfficeRow } from "../src/tenancy";
import { CODE_TTL_MS, maskPhone, sessionFor, WaDirectory, type WaPerson } from "../src/whatsapp/links";
import { addUser, d1 } from "./d1";
import { morningDigest, officeWhatsApp, type WaDeps } from "../src/whatsapp/office";
import { WHISPER } from "../src/whatsapp/voice";

const PHONE = "919822012345";
const anil = { email: "anil@kaverielectricals.in", name: "Anil Kulkarni", role: "owner" as const };
const rajesh = { email: "rajesh@mehtaassociates.in", name: "Rajesh Mehta", role: "accountant" as const };

function memoryKv() {
  const m = new Map<string, string>();
  return { map: m, kv: (k: string, v?: string) => (v !== undefined && m.set(k, v), m.get(k) || null) };
}

/** A Workers AI stand-in: Whisper hears `heard`, the text model sorts it as `intent` and translates by echoing. */
function fakeAi(o: { heard?: string; language?: string; intent?: object } = {}) {
  const run = vi.fn(async (model: string, input: { messages?: { role: string; content: string }[] }) => {
    if (model === WHISPER) return { text: o.heard ?? "", transcription_info: { language: o.language ?? "hi" } };
    const system = input.messages?.[0]?.content ?? "";
    const user = input.messages?.[1]?.content ?? "";
    if (system.includes("sort voice notes")) return { response: JSON.stringify(o.intent ?? { kind: "question", party: null, english: o.heard }) };
    if (system.includes("Translate each numbered line")) return { response: JSON.stringify({ lines: user.split("\n").map((l) => `[hi] ${l.replace(/^\d+\.\s/, "")}`) }) };
    if (system.includes("into plain English")) return { response: JSON.stringify({ english: "Who owes me the most?" }) };
    return { response: "{}" };
  });
  return { ai: { run } as unknown as Ai, run };
}

/** The Graph API: a media id gives a link, and the link gives the file. */
function fakeGraph(bytes = new Uint8Array([1, 2, 3, 4]), mime = "image/jpeg") {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) return Response.json({ url: "https://lookaside.fbsbx.com/whatsapp/media/abc", mime_type: mime, file_size: bytes.byteLength });
    if (u.startsWith("https://lookaside.fbsbx.com/")) return new Response(bytes, { headers: { "content-type": mime } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function setup(o: { ai?: Ai; fetch?: typeof fetch } = {}) {
  const office = new OfficeService(loadBooks());
  const { kv, map } = memoryKv();
  const stored: { key: string; contentType: string }[] = [];
  const readImage = vi.fn(async (docId: string): Promise<IngestResult> => {
    const staged = office.pending().find((s) => s.kind === "ledger_entry")!;
    return { document: office.books.documents[0]!, staged: { ...staged, id: staged.id, payload: { ...staged.payload, docId } }, message: "Read" };
  });
  const readItems = vi.fn(async (_docId: string, _items: TextItem[]): Promise<IngestResult> => ({ document: office.books.documents[0]!, staged: office.pending().find((s) => s.kind === "ledger_entry")!, message: "Read" }));
  let n = 0;
  const deps: WaDeps = {
    kv,
    officeId: "off_kaveri",
    office,
    ai: o.ai ?? fakeAi().ai,
    keys: { token: "test-token", phoneId: "1234567890", template: null },
    base: "https://office.example",
    fetch: o.fetch ?? fakeGraph(),
    now: Date.parse("2026-11-04T04:00:00Z"),
    newDocId: () => `doc-wa${++n}`,
    store: async (key, _b, contentType) => void stored.push({ key, contentType }),
    readImage,
    readItems,
  };
  return { office, kv, map, deps, stored, readImage, readItems };
}
const msg = (o: Partial<WaIncoming>): WaIncoming => ({ id: `wamid.${Math.random().toString(36).slice(2)}`, from: PHONE, at: "2026-11-04T09:30:00+05:30", kind: "text", text: "", media: null, ...o });
/** The person the Worker found behind the phone, as the office sees them. */
const person = (who: { email: string; name: string; role: "owner" | "accountant" } = anil): WaPerson => ({ phone: PHONE, userId: `u-${who.name.split(" ")[0]!.toLowerCase()}`, name: who.name, email: who.email, role: who.role, language: "auto", digest: false });

async function directory() {
  const db = d1();
  let now = Date.parse("2026-11-04T04:00:00Z");
  const a = addUser(db, { id: "u-anil", ...anil });
  const r = addUser(db, { id: "u-rajesh", ...rajesh });
  const cp = new ControlPlane(db, () => now);
  const kaveri = (await cp.createOffice({ name: "Kaveri Electricals", owner: a, ingestDomain: "in.test" })) as OfficeRow;
  const mehta = (await cp.createOffice({ name: "Mehta Associates", owner: r, ingestDomain: "in.test" })) as OfficeRow;
  return { db, cp, kaveri, mehta, a, r, dir: new WaDirectory(db, () => now), tick: (ms: number) => (now += ms) };
}

describe("linking a number", () => {
  it("links with a six-digit code from the person's own phone, once, within 15 minutes", async () => {
    const { dir, kaveri, tick } = await directory();
    const { code, expiresAt } = await dir.newJoinCode(kaveri.id, "u-anil");
    expect(code).toMatch(/^\d{6}$/);
    expect(Date.parse(expiresAt) - Date.parse("2026-11-04T04:00:00Z")).toBe(CODE_TTL_MS);
    expect(await dir.redeem("0000", "999999")).toEqual({ error: "badCode" });
    tick(60_000);
    const r = await dir.redeem("+91 98220 12345", code);
    expect(r).toMatchObject({ officeId: kaveri.id, link: { phone: PHONE, userId: "u-anil", email: anil.email, activeOfficeId: kaveri.id, language: "auto", digest: false } });
    expect((await dir.linkOfUser("u-anil"))?.phone).toBe(PHONE);
    expect(await dir.personIn(kaveri.id, PHONE)).toMatchObject({ role: "owner" });
    expect(await dir.redeem(PHONE, code)).toEqual({ error: "badCode" });
  });

  it("refuses an expired code and replaces an older one", async () => {
    const { dir, kaveri, tick } = await directory();
    const first = (await dir.newJoinCode(kaveri.id, "u-anil", () => 0.1)).code;
    const second = (await dir.newJoinCode(kaveri.id, "u-anil", () => 0.9)).code;
    expect(await dir.redeem(PHONE, first)).toEqual({ error: "badCode" });
    tick(CODE_TTL_MS + 1);
    expect(await dir.redeem(PHONE, second)).toEqual({ error: "badCode" });
  });

  it("stops a number guessing after five wrong codes in an hour", async () => {
    const { dir, kaveri, tick } = await directory();
    const { code } = await dir.newJoinCode(kaveri.id, "u-anil");
    for (let i = 0; i < 5; i++) expect(await dir.redeem(PHONE, "000000")).toEqual({ error: "badCode" });
    expect(await dir.redeem(PHONE, code)).toEqual({ error: "tooMany" });
    tick(3600_001);
    expect(await dir.redeem(PHONE, code)).toEqual({ error: "badCode" });
  });

  it("lets an office's own number redeem only that office's codes", async () => {
    const { dir, kaveri, mehta } = await directory();
    const { code } = await dir.newJoinCode(mehta.id, "u-rajesh");
    expect(await dir.redeem(PHONE, code, kaveri.id)).toEqual({ error: "badCode" });
    expect(await dir.redeem(PHONE, code, mehta.id)).toMatchObject({ officeId: mehta.id });
  });

  it("unlinks, and shows the number only masked", async () => {
    const { dir, kaveri } = await directory();
    await dir.redeem(PHONE, (await dir.newJoinCode(kaveri.id, "u-anil")).code);
    expect(maskPhone(PHONE)).toBe("+91 ••••• ••345");
    expect(await dir.unlink("u-anil")).toMatchObject({ phone: PHONE });
    expect(await dir.linkByPhone(PHONE)).toBeNull();
    expect(await dir.unlink("u-anil")).toBeNull();
  });

  it("says the number is linked when the Worker has just redeemed its code", async () => {
    const { deps } = setup();
    const out = await officeWhatsApp(deps, msg({ text: "JOIN 482193" }), person(), { joined: true });
    expect(out!.text).toBe("Linked. You can run the office from here now. Send help to see how.");
  });

  it("puts the business's name over replies for someone in several offices", async () => {
    const { deps } = setup();
    const out = await officeWhatsApp(deps, msg({ text: "help" }), person(), { heading: "Kaveri Electricals" });
    expect(out!.text.startsWith("*Kaveri Electricals*\n")).toBe(true);
  });

  it("keeps a linked number's messages out of the social inbox", () => {
    const delivery = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { contacts: [], messages: [
        { id: "wamid.owner", from: PHONE, timestamp: "1762229400", type: "text", text: { body: "desk" } },
        { id: "wamid.cust", from: "919000000001", timestamp: "1762229400", type: "text", text: { body: "MCB price?" } },
        { id: "wamid.join", from: "919000000002", timestamp: "1762229400", type: "text", text: { body: "JOIN 482193" } },
      ] } }] }],
    };
    const linked = new Set([PHONE]);
    const inbox = parseMetaDelivery(delivery, new Set(), Date.now(), (from, text) => linked.has(from) || /^join\s*\d{6}$/i.test(text));
    expect(inbox.map((m) => m.externalId)).toEqual(["wamid.cust"]);
    expect(parseWhatsAppMessages(delivery).map((m) => m.id)).toEqual(["wamid.owner", "wamid.cust", "wamid.join"]);
  });
});

describe("talking to the office", () => {
  it("lists the desk, approves by number and handles a repeated delivery once", async () => {
    const { deps, office } = setup();
    const who = person();
    for (const i of office.desk().items) if (REVIEW_ON_DESK.has(i.kind)) office.decide(i.id, { action: "reject" }, "test");
    const list = await officeWhatsApp(deps, msg({ text: "desk" }), who);
    expect(list!.text).toContain("Hello Anil.");
    const first = sessionFor(deps.kv, PHONE).list[0]!;
    const yes = msg({ text: "1 yes" });
    const out = await officeWhatsApp(deps, yes, who);
    expect(out!.text).toBe("1: approved.");
    expect(out!.decided.map((d: StagedChange) => d.id)).toEqual([first.id]);
    expect(await officeWhatsApp(deps, yes, who)).toBeNull();
  });

  it("translates a question asked in Hindi for the Office Manager, and answers in Hindi", async () => {
    const { ai, run } = fakeAi();
    const { deps } = setup({ ai });
    const who = person();
    const out = await officeWhatsApp(deps, msg({ text: "सबसे ज़्यादा बकाया किस पर है?" }), who);
    expect(run.mock.calls.some(([, i]) => JSON.stringify(i).includes("into plain English"))).toBe(true);
    expect(sessionFor(deps.kv, PHONE).language).toBe("hi");
    // The fake translation drops nothing, so the Hindi line is kept.
    expect(out!.text).toMatch(/^\[hi\] Customers owe ₹/);
  });

  it("reads a photo of a bill into the Accountant's intake, never posting it, and gives it a number", async () => {
    const graph = fakeGraph(new Uint8Array(2048), "image/jpeg");
    const { deps, stored, readImage, office } = setup({ fetch: graph });
    const who = person();
    const out = await officeWhatsApp(deps, msg({ kind: "image", media: { id: "media-1", mimeType: "image/jpeg", filename: null } }), who);
    expect(readImage).toHaveBeenCalledWith("doc-wa1", expect.any(ArrayBuffer), false);
    expect(stored[0]).toEqual({ key: "o/off_kaveri/docs/doc-wa1", contentType: "image/jpeg" });
    expect(office.books.documents.find((d) => d.id === "doc-wa1")).toMatchObject({ channel: "whatsapp", from: "Anil Kulkarni" });
    expect(out!.text).toMatch(/On your desk as item 1\.$/);
    expect(sessionFor(deps.kv, PHONE).list).toHaveLength(1);
    expect(vi.mocked(graph).mock.calls[0]![1]).toMatchObject({ headers: expect.anything() });
  });

  it("refuses a file over the size limit without downloading it", async () => {
    const graph = vi.fn(async () => Response.json({ url: "https://lookaside.fbsbx.com/x", mime_type: "image/jpeg", file_size: 50 * 1024 * 1024 })) as unknown as typeof fetch;
    const { deps, readImage } = setup({ fetch: graph });
    const who = person();
    const out = await officeWhatsApp(deps, msg({ kind: "image", media: { id: "big", mimeType: "image/jpeg", filename: null } }), who);
    expect(out!.text).toBe("I could not read that. Send a clearer photo or the PDF, up to 10 MB.");
    expect(readImage).not.toHaveBeenCalled();
    expect(vi.mocked(graph).mock.calls).toHaveLength(1);
  });

  it("turns a voice note about money paid out into a draft bill with the audio and transcript as its source", async () => {
    const heard = "टेम्पो के 2,400 दिए";
    const { ai } = fakeAi({ heard, language: "hi", intent: { kind: "expense", party: "Tempo driver", english: "Paid 2,400 for the tempo" } });
    const { deps, stored, readItems } = setup({ ai, fetch: fakeGraph(new Uint8Array(4096), "audio/ogg") });
    const who = person();
    const out = await officeWhatsApp(deps, msg({ kind: "audio", media: { id: "voice-1", mimeType: "audio/ogg", filename: null } }), who);
    expect(stored.map((s) => s.key)).toEqual(["o/off_kaveri/docs/doc-wa1", "o/off_kaveri/docs/doc-wa1.txt"]);
    const [, items, auto] = readItems.mock.calls[0]! as unknown as [string, TextItem[], boolean];
    expect(auto).toBe(false);
    expect(items.map((i) => i.str)).toEqual([expect.stringMatching(/^Bill from Tempo driver to /), expect.stringMatching(/^Date \d\d\/\d\d\/\d{4}$/), "Paid 2,400 for the tempo", heard]);
    expect(out!.text.startsWith(`मैंने सुना: "${heard}"`)).toBe(true);
    expect(out!.text).toContain("आपकी डेस्क पर आइटम 1 के रूप में।");
    expect(deps.office.allStaged().find((s) => s.summary.startsWith(`From a voice note: "${heard}"`))).toBeDefined();
  });

  it("answers a spoken question through the Office Manager, after saying what it heard", async () => {
    const { ai } = fakeAi({ heard: "Who owes me the most?", language: "en" });
    const { deps } = setup({ ai, fetch: fakeGraph(new Uint8Array(4096), "audio/ogg") });
    const who = person();
    const out = await officeWhatsApp(deps, msg({ kind: "audio", media: { id: "voice-2", mimeType: "audio/ogg", filename: null } }), who);
    expect(out!.text).toMatch(/^I heard: "Who owes me the most\?"\n\nCustomers owe ₹/);
  });

  it("notes a spoken quote request for the Quote Desk", async () => {
    const { ai } = fakeAi({ heard: "Quote Sai Krupa 40 LED panels", language: "en", intent: { kind: "quote", party: "Sai Krupa Builders", english: "Quote Sai Krupa 40 LED panels" } });
    const { deps, office } = setup({ ai, fetch: fakeGraph(new Uint8Array(4096), "audio/ogg") });
    const who = person();
    const leads = office.books.leads.length;
    const out = await officeWhatsApp(deps, msg({ kind: "audio", media: { id: "voice-3", mimeType: "audio/ogg", filename: null } }), who);
    expect(office.books.leads).toHaveLength(leads + 1);
    expect(office.books.leads.at(-1)).toMatchObject({ name: "Sai Krupa Builders", source: "WhatsApp voice note", nextStep: "Draft the quotation" });
    expect(out!.text).toContain("Noted for the Quote Desk.");
  });

  it("lets the accountant ask by voice, but never stages work from their voice notes", async () => {
    const { ai } = fakeAi({ heard: "paid 500 for courier", language: "en", intent: { kind: "expense", party: null, english: "paid 500 for courier" } });
    const { deps, readItems } = setup({ ai, fetch: fakeGraph(new Uint8Array(4096), "audio/ogg") });
    const who = person(rajesh);
    await officeWhatsApp(deps, msg({ kind: "audio", media: { id: "voice-4", mimeType: "audio/ogg", filename: null } }), who);
    expect(readItems).not.toHaveBeenCalled();
  });

  it("sends the morning digest with numbers the owner can answer", async () => {
    const { deps } = setup();
    const who = person();
    const text = await morningDigest(deps, PHONE, anil, null);
    expect(text).toMatch(/^Good morning, Anil\./);
    expect(sessionFor(deps.kv, PHONE).list.length).toBeGreaterThan(0);
  });
});
