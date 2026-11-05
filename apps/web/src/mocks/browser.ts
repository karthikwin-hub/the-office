import { DEFAULT_PREFS, Prefs, PrefsChange, ReadRequest, type Role } from "@office/contracts";
import { dispatch, mockConnect, OfficeService, runMockEffects } from "@office/engine";
import { loadBooks } from "@office/fixtures";
import { delay, http, HttpResponse, passthrough } from "msw";
import { setupWorker } from "msw/browser";

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

let office: OfficeService | null = null;
const getOffice = () => (office ??= new OfficeService(loadBooks()));

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
  if (request.method !== "GET") runMockEffects(getOffice());
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
