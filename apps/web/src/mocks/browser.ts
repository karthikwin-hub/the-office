import { ambientFrom, checkPersonaNames, DEFAULT_PREFS, Prefs, PrefsChange, ReadRequest, readPersonaNames, type Role, ROUTES } from "@office/contracts";
import { dispatch, mockConnect, OfficeService, runMockEffects } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { delay, http, HttpResponse, passthrough } from "msw";
import { setupWorker } from "msw/browser";
import { mockMe, mockOfficeAdmin } from "./office";
import { mockMore, seedMock, settleCs } from "./customers";
import { mockPlatform } from "./platform";
import { mockWhatsApp } from "./whatsapp";

const USERS: Record<Role, { name: string; email: string }> = {
  owner: { name: "Anil Kulkarni", email: "anil@kaverielectricals.in" },
  accountant: { name: "Rajesh Mehta", email: "rajesh@mehtaassociates.in" },
};

/** Route prefixes already served by the real Worker when running in hybrid mode. */
const liveRoutes = (import.meta.env.VITE_LIVE_ROUTES ?? "")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

const PREFS_KEY = "office.prefs.server";
const NAMES_KEY = "office.personas.server";

let office: OfficeService | null = null;
const getOffice = () => {
  if (office) return office;
  office = new OfficeService(loadBooks());
  seedMock(office);
  return office;
};

/** Fresh books, as if the office had just opened. Used by review screenshots. */
export function resetOffice() {
  office = null;
}

const handler = http.all("/api/*", async ({ request }) => {
  const url = new URL(request.url);
  if (liveRoutes.some((p: string) => url.pathname.startsWith(p))) return passthrough();
  await delay(import.meta.env.MODE === "test" ? 0 : 90);
  const role: Role = request.headers.get("x-office-as") === "accountant" ? "accountant" : "owner";
  if (/^\/api\/exports\/(gstr3b|tds)\//.test(url.pathname)) {
    const { exportFile } = await import("@office/engine/excel");
    const file = await exportFile(getOffice().ledger, url.pathname);
    if (!file) return HttpResponse.json({ error: "Export not found" }, { status: 404 });
    return new HttpResponse(file.bytes, { headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${file.filename}"` } });
  }
  if (request.method === "POST" && url.pathname === "/api/documents") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return HttpResponse.json({ error: "Attach a file." }, { status: 400 });
    const parsed = ReadRequest.safeParse({ items: JSON.parse(String(form.get("items") ?? "[]")) });
    if (!parsed.success) return HttpResponse.json({ error: "The text layer could not be read." }, { status: 400 });
    const office = getOffice();
    const id = `doc-u${Date.now().toString(36)}`;
    office.receiveDocument({ id, file: URL.createObjectURL(file), channel: "upload", from: null, pages: Number(form.get("pages") ?? 1) });
    const result = office.read(id, parsed.data.items);
    if (!result.staged && !parsed.data.items.length) {
      office.failDocument(id, "it is a scan or photo. In the live office the vision model reads these.");
      return HttpResponse.json({ ...result, message: "This is a scan or photo. In the live office the vision model reads these; the mockup reads PDFs with text only." });
    }
    return HttpResponse.json(result);
  }
  if (request.method === "POST" && url.pathname === ROUTES.onboardingStage) {
    const body = (await request.json().catch(() => null)) as { files?: { csv?: unknown }[] } | null;
    for (const f of body?.files ?? []) if (typeof f.csv === "string") Object.assign(f, { file: URL.createObjectURL(new Blob([f.csv], { type: "text/csv" })) });
    const res = dispatch(getOffice(), { method: "POST", path: url.pathname, query: url.searchParams, body, role, user: USERS[role], mode: "mock" });
    return HttpResponse.json(res.body as object, { status: res.status });
  }
  const connect = /^\/api\/channels\/([a-z]+)\/connect$/.exec(url.pathname);
  if (connect) {
    if (role !== "owner") return HttpResponse.json({ error: "Only the owner can connect channels." }, { status: 403 });
    try {
      return HttpResponse.json(mockConnect(getOffice(), connect[1]!));
    } catch (e) {
      return HttpResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/social/media" && request.headers.get("content-type")?.includes("multipart")) {
    if (role !== "owner") return HttpResponse.json({ error: "Only the owner can add pictures." }, { status: 403 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !/^image\/(png|jpe?g|webp)$/.test(file.type)) return HttpResponse.json({ error: "Send a PNG, JPEG or WebP picture." }, { status: 415 });
    const asset = getOffice().addMedia({ id: `media-u${Date.now().toString(36)}`, url: URL.createObjectURL(file), kind: "image", alt: String(form.get("alt") ?? ""), skuId: (form.get("skuId") as string | null) || null, rights: form.get("rights") === "generated" ? "generated" : "own", width: Number(form.get("width")) || null, height: Number(form.get("height")) || null });
    return HttpResponse.json(asset);
  }
  if (url.pathname === "/api/me") return mockMe(role, USERS, getOffice());
  if (url.pathname.startsWith("/api/platform")) return (await mockPlatform(request, url.pathname)) ?? HttpResponse.json({ error: "Not found" }, { status: 404 });
  const more = await mockMore(request, url.pathname, role, getOffice());
  if (more) return more;
  if (url.pathname.startsWith("/api/office-admin")) return (await mockOfficeAdmin(request, url.pathname, role, getOffice(), USERS))!;
  if (url.pathname.startsWith("/api/whatsapp")) {
    const res = await mockWhatsApp(request, url.pathname, role, getOffice(), USERS[role]);
    if (res) {
      if (request.method !== "GET") runMockEffects(getOffice());
      return res;
    }
  }
  if (url.pathname === ROUTES.ambient && request.method === "GET") {
    return HttpResponse.json(ambientFrom(getOffice().books, readPersonaNames(localStorage.getItem(NAMES_KEY)), getOffice().books.business.asOf));
  }
  if (url.pathname === ROUTES.personas) {
    if (role !== "owner") return HttpResponse.json({ error: "Only the owner can rename the team." }, { status: 403 });
    const checked = checkPersonaNames(await request.json().catch(() => null));
    if ("error" in checked) return HttpResponse.json(checked, { status: 400 });
    localStorage.setItem(NAMES_KEY, JSON.stringify(checked.names));
    return HttpResponse.json({ names: checked.names });
  }
  if (url.pathname === ROUTES.weather) {
    return HttpResponse.json({ weather: { city: "Pune", tempC: 27, sky: "cloudy", at: new Date().toISOString() } });
  }
  if (url.pathname === "/api/prefs") {
    const saved = Prefs.parse({ ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") });
    if (request.method === "GET") return HttpResponse.json(saved);
    const change = PrefsChange.safeParse(await request.json().catch(() => null));
    if (!change.success) return HttpResponse.json({ error: "Invalid preferences" }, { status: 400 });
    const next = { ...saved, ...change.data };
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    return HttpResponse.json(next);
  }
  let body: unknown;
  if (request.method !== "GET" && request.headers.get("content-type")?.includes("json")) body = await request.json();
  const res = dispatch(getOffice(), { method: request.method, path: url.pathname, query: url.searchParams, body, role, user: USERS[role], mode: "mock" });
  if (request.method !== "GET") {
    runMockEffects(getOffice());
    settleCs(getOffice());
  }
  const headers: Record<string, string> = {};
  if (res.status === 200 && url.pathname.startsWith("/api/exports/gstr1/")) {
    const period = url.pathname.split("/").pop()!;
    headers["content-disposition"] = `attachment; filename="GSTR1_${getOffice().ledger.books.business.gstin}_${period}.json"`;
  }
  return HttpResponse.json(res.body as never, { status: res.status, headers });
});

export async function startMocks() {
  const worker = setupWorker(handler);
  await worker.start({ onUnhandledRequest: "bypass", quiet: true, serviceWorker: { url: "/mockServiceWorker.js" } });
}
