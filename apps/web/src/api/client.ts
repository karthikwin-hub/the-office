import {
  type AgeingReport,
  type AgentRoomView,
  type AskResponse,
  type AuditReport,
  type CashReport,
  type Decision,
  type DeskView,
  type Document,
  type DocumentView,
  type GstReport,
  type HiringView,
  type IngestResult,
  type MarketingReport,
  type OfficeView,
  type OperationsReport,
  type PartyView,
  type PeopleReport,
  type Prefs,
  ROUTES,
  type SalesReport,
  type SalesTeamReport,
  type Session,
  type Settings,
  type SocialReport,
  type StagedChange,
  type TdsReport,
  type TextItem,
  type Trace,
  type TrustLevel,
  type AgentState,
  type BrandVoice,
  type Channel,
  type MediaAsset,
  type Post,
  type PublishingPack,
  type JoinCode,
  type WhatsAppDemoReply,
  type WhatsAppStatus,
} from "@office/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const isLive = import.meta.env.VITE_DATA !== "mock" && import.meta.env.VITE_DATA !== "hybrid";

let liveRole: Session["role"] | null = null;

/** The live office takes the role from the signed-in account; in mockups, `?as=accountant` previews the office as the accountant sees it. */
export function viewingAs(): "owner" | "accountant" {
  if (liveRole) return liveRole;
  const fromUrl = new URLSearchParams(location.search).get("as");
  if (fromUrl === "accountant" || fromUrl === "owner") sessionStorage.setItem("office.as", fromUrl);
  return sessionStorage.getItem("office.as") === "accountant" ? "accountant" : "owner";
}

async function call<T>(path: string, init?: { method?: string; body?: unknown; query?: Record<string, string | undefined> }): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.query ?? {})) if (v) qs.set(k, v);
  const res = await fetch(qs.size ? `${path}?${qs}` : path, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", "x-office-as": viewingAs() },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "include",
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function auth(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`/api/auth/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), credentials: "include" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, err.message ?? (res.status === 401 ? "That email and password do not match." : res.statusText));
  }
}

export const account = {
  status: () => call<{ hasOwner: boolean }>("/api/auth-status"),
  signIn: (email: string, password: string) => auth("sign-in/email", { email, password, rememberMe: true }),
  signUp: (name: string, email: string, password: string) => auth("sign-up/email", { name, email, password }),
  signOut: () => auth("sign-out"),
  invite: (email: string) => call<{ invited: string }>("/api/invites", { method: "POST", body: { email } }),
};

export const api = {
  session: async () => {
    const s = await call<Session>(ROUTES.session);
    liveRole = s.mode === "live" ? s.role : null;
    return s;
  },
  office: () => call<OfficeView>(ROUTES.office),
  agent: (id: string) => call<AgentRoomView>(ROUTES.agent(id)),
  desk: () => call<DeskView>(ROUTES.desk),
  decide: (id: string, d: Decision) => call<StagedChange>(ROUTES.decide(id), { method: "POST", body: d }),
  sales: (from?: string, to?: string) => call<SalesReport>(ROUTES.sales, { query: { from, to } }),
  ageing: () => call<AgeingReport>(ROUTES.ageing),
  gst: (period?: string) => call<GstReport>(ROUTES.gst, { query: { period } }),
  tds: (quarter?: string) => call<TdsReport>(ROUTES.tds, { query: { quarter } }),
  cash: () => call<CashReport>(ROUTES.cash),
  salesTeam: () => call<SalesTeamReport>(ROUTES.salesTeam),
  marketing: () => call<MarketingReport>(ROUTES.marketing),
  social: () => call<SocialReport>(ROUTES.social),
  operations: () => call<OperationsReport>(ROUTES.operations),
  people: (period?: string) => call<PeopleReport>(ROUTES.people, { query: { period } }),
  audit: (period?: string) => call<AuditReport>(ROUTES.audit, { query: { period } }),
  trace: (figureId: string) => call<Trace>(ROUTES.trace(figureId)),
  documents: () => call<Document[]>(ROUTES.documents),
  unread: () => call<Document[]>(ROUTES.unread),
  importReturn: (body: { content: string; filedOn?: string }) => call<{ form: string; period: string; summary: string; findings: number }>(ROUTES.importReturn, { method: "POST", body }),
  readDocument: (id: string, items: TextItem[]) => call<IngestResult>(ROUTES.readDocument(id), { method: "POST", body: { items } }),
  /** A page with no text, pictured in the browser, for the vision model. Live office only. */
  scanDocument: async (id: string, image: Blob): Promise<IngestResult> => {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}/scan`, { method: "POST", body: image, headers: { "content-type": image.type }, credentials: "include" });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, err.error ?? res.statusText);
    }
    return res.json() as Promise<IngestResult>;
  },
  upload: async (form: FormData): Promise<IngestResult> => {
    const res = await fetch(ROUTES.documents, { method: "POST", body: form, headers: { "x-office-as": viewingAs() }, credentials: "include" });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, err.error ?? res.statusText);
    }
    return res.json() as Promise<IngestResult>;
  },
  document: (id: string) => call<DocumentView>(ROUTES.document(id)),
  party: (id: string) => call<PartyView>(ROUTES.party(id)),
  ask: (question: string) => call<AskResponse>(ROUTES.ask, { method: "POST", body: { question } }),
  hiring: () => call<HiringView>(ROUTES.hiring),
  hire: (agentId: string, change: { hired?: boolean; trustLevel?: TrustLevel }) => call<AgentState>(ROUTES.hire(agentId), { method: "POST", body: change }),
  settings: () => call<Settings>(ROUTES.settings),
  saveSettings: (s: Partial<Settings>) => call<Settings>(ROUTES.settings, { method: "PUT", body: s }),
  prefs: () => call<Prefs>(ROUTES.prefs),
  savePrefs: (p: Partial<Prefs>) => call<Prefs>(ROUTES.prefs, { method: "PUT", body: p }),
  whatsapp: () => call<WhatsAppStatus>(ROUTES.whatsapp),
  whatsappCode: () => call<JoinCode>(ROUTES.whatsappCode, { method: "POST" }),
  saveWhatsApp: (c: Partial<Pick<WhatsAppStatus, "language" | "digest">>) => call<WhatsAppStatus>(ROUTES.whatsapp, { method: "PUT", body: c }),
  unlinkWhatsApp: () => call<WhatsAppStatus>(ROUTES.whatsapp, { method: "DELETE" }),
  whatsappDemo: (m: { text?: string; voice?: string }) => call<WhatsAppDemoReply>(ROUTES.whatsappDemo, { method: "POST", body: m }),
  editVariant: (postId: string, channelId: string, edit: { text?: string; link?: string | null; mediaIds?: string[] }) => call<Post>(ROUTES.socialVariant(postId, channelId), { method: "PUT", body: edit }),
  markPosted: (postId: string, channelId: string, url: string) => call<Post>(ROUTES.socialPosted(postId, channelId), { method: "POST", body: { url } }),
  pack: (postId: string, channelId: string) => call<PublishingPack>(ROUTES.socialPack(postId, channelId)),
  importMetrics: (content: string) => call<{ matched: number; unmatched: number }>(ROUTES.socialMetricsImport, { method: "POST", body: { content } }),
  draftCalendar: (month: string) => call<StagedChange>(ROUTES.socialCalendarDraft, { method: "POST", body: { month } }),
  saveVoice: (voice: BrandVoice) => call<BrandVoice>(ROUTES.socialVoice, { method: "PUT", body: voice }),
  setupChannel: (id: string, change: { handle?: string; mode?: "manual"; postingHours?: { from: string; to: string } }) => call<Channel>(ROUTES.socialChannel(id), { method: "POST", body: change }),
  /** Live: the platform's sign-in page, and back to Settings. Mockups: connects at once. */
  connectChannel: async (platform: string): Promise<Channel | null> => {
    if (isLive) {
      location.assign(ROUTES.socialConnect(platform));
      return null;
    }
    return call<Channel>(ROUTES.socialConnect(platform), { method: "POST" });
  },
  uploadMedia: async (form: FormData): Promise<MediaAsset> => {
    const res = await fetch(ROUTES.socialMedia, { method: "POST", body: form, headers: { "x-office-as": viewingAs() }, credentials: "include" });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, err.error ?? res.statusText);
    }
    return res.json() as Promise<MediaAsset>;
  },
};

/**
 * Fetches a file and hands it to the browser as a download. A plain link would
 * skip the role header, and in mockups the service worker never sees navigations.
 */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { headers: { "x-office-as": viewingAs() }, credentials: "include" });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const exportUrl = {
  gstr1: (period: string) => ROUTES.exportGstr1(period),
  gstr3b: (period: string) => ROUTES.exportGstr3b(period),
  tds: (quarter: string) => ROUTES.exportTds(quarter),
};
