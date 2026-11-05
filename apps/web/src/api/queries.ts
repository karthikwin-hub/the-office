import type { Decision, TrustLevel } from "@office/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { account, api, isLive, officeAdmin } from "./client";

export const q = {
  me: () => queryOptions({ queryKey: ["me"], queryFn: account.me, staleTime: Infinity, retry: false }),
  officeAdmin: () => queryOptions({ queryKey: ["office-admin"], queryFn: officeAdmin.get }),
  session: () => queryOptions({ queryKey: ["session"], queryFn: api.session, staleTime: Infinity, retry: false }),
  office: () => queryOptions({ queryKey: ["office"], queryFn: api.office, refetchInterval: isLive ? false : 20_000 }),
  agent: (id: string) => queryOptions({ queryKey: ["agent", id], queryFn: () => api.agent(id) }),
  desk: () => queryOptions({ queryKey: ["desk"], queryFn: api.desk }),
  sales: (from?: string, to?: string) => queryOptions({ queryKey: ["report", "sales", from, to], queryFn: () => api.sales(from, to) }),
  ageing: () => queryOptions({ queryKey: ["report", "ageing"], queryFn: api.ageing }),
  gst: (period?: string) => queryOptions({ queryKey: ["report", "gst", period], queryFn: () => api.gst(period) }),
  tds: (quarter?: string) => queryOptions({ queryKey: ["report", "tds", quarter], queryFn: () => api.tds(quarter) }),
  cash: () => queryOptions({ queryKey: ["report", "cash"], queryFn: api.cash }),
  salesTeam: () => queryOptions({ queryKey: ["report", "sales-team"], queryFn: api.salesTeam }),
  marketing: () => queryOptions({ queryKey: ["report", "marketing"], queryFn: api.marketing }),
  social: () => queryOptions({ queryKey: ["report", "social"], queryFn: api.social }),
  operations: () => queryOptions({ queryKey: ["report", "operations"], queryFn: api.operations }),
  people: (period?: string) => queryOptions({ queryKey: ["report", "people", period], queryFn: () => api.people(period) }),
  audit: (period?: string) => queryOptions({ queryKey: ["report", "audit", period], queryFn: () => api.audit(period) }),
  trace: (figureId: string) => queryOptions({ queryKey: ["trace", figureId], queryFn: () => api.trace(figureId) }),
  documents: () => queryOptions({ queryKey: ["documents"], queryFn: api.documents }),
  document: (id: string) => queryOptions({ queryKey: ["document", id], queryFn: () => api.document(id), staleTime: 60_000 }),
  party: (id: string) => queryOptions({ queryKey: ["party", id], queryFn: () => api.party(id) }),
  hiring: () => queryOptions({ queryKey: ["hiring"], queryFn: api.hiring }),
  settings: () => queryOptions({ queryKey: ["settings"], queryFn: api.settings }),
  pack: (postId: string, channelId: string) => queryOptions({ queryKey: ["pack", postId, channelId], queryFn: () => api.pack(postId, channelId) }),
  routines: () => queryOptions({ queryKey: ["routines"], queryFn: api.routines }),
  ambient: () => queryOptions({ queryKey: ["ambient"], queryFn: api.ambient, staleTime: 30 * 60_000 }),
  weather: () => queryOptions({ queryKey: ["weather"], queryFn: api.weather, staleTime: 30 * 60_000, refetchInterval: 60 * 60_000, retry: false }),
  routineRuns: (id: string) => queryOptions({ queryKey: ["routines", id, "runs"], queryFn: () => api.routineRuns(id) }),
  customers: () => queryOptions({ queryKey: ["customers"], queryFn: api.customers, refetchInterval: isLive ? false : 15_000 }),
  thread: (id: string) => queryOptions({ queryKey: ["customers", "thread", id], queryFn: () => api.thread(id) }),
  orders: () => queryOptions({ queryKey: ["orders"], queryFn: api.orders }),
};

/** Any change in the office whose effects reach beyond one screen: everything but documents refetches. */
export function useChange<T = unknown>() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<T>) => run(),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "document" && x.queryKey[0] !== "session" }),
  });
}

/** A decision can change any figure in the office, so everything except documents is refetched. */
export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Decision }) => api.decide(id, decision),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "document" && x.queryKey[0] !== "session" }),
  });
}

export function useImportReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { content: string; filedOn?: string }) => api.importReturn(body),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "document" && x.queryKey[0] !== "session" }),
  });
}

export function useHire() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, change }: { agentId: string; change: { hired?: boolean; trustLevel?: TrustLevel } }) => api.hire(agentId, change),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "document" && x.queryKey[0] !== "session" }),
  });
}

/** Any social media change: a post edit, a channel, the voice. The whole office may move, so everything refetches. */
export function useSocial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "document" && x.queryKey[0] !== "session" }),
  });
}

export function useAsk() {
  return useMutation({ mutationFn: (question: string) => api.ask(question) });
}
