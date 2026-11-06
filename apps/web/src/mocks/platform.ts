import { type PlatformBusiness, type PlatformInvited, PlatformOnboard, PlatformStatusChange } from "@office/contracts";
import { HttpResponse } from "msw";

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

/** A handful of businesses, as the platform owners' console sees them in the mockup. */
let businesses: PlatformBusiness[] = [
  { id: "off_mk2pqhuh8dy4w7fa", name: "Mehta Hardware", status: "active", opened: ago(2), onboardedBy: "puja@snilldai.com", address: null, ingestEmail: "mehta-hardware-4hkq@in.office.snilld.in", owners: [], people: 0, ownerInvite: { email: "ravi@mehtahardware.in", expiresAt: ahead(12), expired: false }, lastEvent: ago(2) },
  { id: "kaveri-electricals", name: "Kaveri Electricals", status: "active", opened: ago(64), onboardedBy: null, address: "https://kaveri.office.snilld.in", ingestEmail: "kaveri-electricals@in.office.snilld.in", owners: [{ name: "Anil Kulkarni", email: "anil@kaverielectricals.in" }], people: 2, ownerInvite: null, lastEvent: ago(0) },
  { id: "off_t7sz3nrwq9bm2ckx", name: "Shah Textiles", status: "active", opened: ago(41), onboardedBy: "puja@snilldai.com", address: "https://shahtextiles.office.snilld.in", ingestEmail: "shah-textiles-9xwp@in.office.snilld.in", owners: [{ name: "Bina Shah", email: "bina@shahtextiles.in" }], people: 3, ownerInvite: null, lastEvent: ago(1) },
  { id: "off_a3jd8kfu2hv6pyre", name: "Rao Dental Clinic", status: "active", opened: ago(19), onboardedBy: null, address: null, ingestEmail: "rao-dental-clinic-2m7d@in.office.snilld.in", owners: [{ name: "Dr. Kavya Rao", email: "kavya@raodental.in" }], people: 1, ownerInvite: null, lastEvent: ago(6) },
  { id: "off_w9ce4xbt6gn3qzlm", name: "Green Leaf Caterers", status: "suspended", opened: ago(88), onboardedBy: null, address: null, ingestEmail: "green-leaf-caterers-7rbn@in.office.snilld.in", owners: [{ name: "Joseph Fernandes", email: "joseph@greenleaf.in" }], people: 2, ownerInvite: null, lastEvent: ago(9) },
  { id: "off_h6vy2rmk8pd4scue", name: "Sundar Motors", status: "active", opened: ago(30), onboardedBy: "puja@snilldai.com", address: null, ingestEmail: "sundar-motors-5qte@in.office.snilld.in", owners: [], people: 0, ownerInvite: { email: "sundar@sundarmotors.in", expiresAt: ago(16), expired: true }, lastEvent: ago(30) },
  { id: "off_q4nf7tzc3wk8bhja", name: "Lakshmi Stores", status: "deleting", opened: ago(120), onboardedBy: null, address: null, ingestEmail: "lakshmi-stores-8ycv@in.office.snilld.in", owners: [{ name: "Lakshmi Iyer", email: "lakshmi@lakshmistores.in" }], people: 1, ownerInvite: null, lastEvent: ago(3) },
];

const invited = (b: PlatformBusiness, email: string): PlatformInvited => ({ id: b.id, name: b.name, email, link: `${location.origin}/?invite=mock-${b.id}`, emailed: true, expiresAt: ahead(14) });

export async function mockPlatform(request: Request, path: string): Promise<Response | null> {
  if (path === "/api/platform" && request.method === "GET") return HttpResponse.json({ you: { name: "Puja", email: "puja@snilldai.com" }, businesses });
  if (path === "/api/platform/businesses" && request.method === "POST") {
    const parsed = PlatformOnboard.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return HttpResponse.json({ error: "Give the business's name and its owner's email address." }, { status: 400 });
    const email = parsed.data.ownerEmail.toLowerCase();
    const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const b: PlatformBusiness = { id: `off_mock${Date.now().toString(36)}`, name: parsed.data.name, status: "active", opened: ago(0), onboardedBy: "puja@snilldai.com", address: null, ingestEmail: `${slug}@in.office.snilld.in`, owners: [], people: 0, ownerInvite: { email, expiresAt: ahead(14), expired: false }, lastEvent: ago(0) };
    businesses = [b, ...businesses];
    return HttpResponse.json(invited(b, email), { status: 201 });
  }
  const m = /^\/api\/platform\/businesses\/([^/]+)\/(status|owner-invitation)$/.exec(path);
  const b = m ? businesses.find((x) => x.id === decodeURIComponent(m[1]!)) : undefined;
  if (!m) return null;
  if (!b) return HttpResponse.json({ error: "Not found" }, { status: 404 });
  if (m[2] === "status") {
    const parsed = PlatformStatusChange.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return HttpResponse.json({ error: "Choose active or suspended." }, { status: 400 });
    if (b.status === "deleting") return HttpResponse.json({ error: "Its owner is deleting this office. Only they can restore it, within 30 days." }, { status: 409 });
    b.status = parsed.data.status;
    b.lastEvent = ago(0);
    return HttpResponse.json({ ok: true });
  }
  const email = ((await request.json().catch(() => null)) as { email?: string } | null)?.email ?? "";
  b.ownerInvite = { email, expiresAt: ahead(14), expired: false };
  b.lastEvent = ago(0);
  return HttpResponse.json(invited(b, email));
}
