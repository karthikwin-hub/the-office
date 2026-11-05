import { type AppKeys, call, type ChannelAdapter, type Fetch, notSetUp, PlatformError, type Tokens } from "./adapter";
import { challengeFor } from "./oauth";

const API = "https://api.x.com/2";

/**
 * Posting through OAuth 2.0 with PKCE. X's free tier is mostly write-only and capped per day, so
 * this adapter only posts and replies; mentions and numbers come in by CSV export.
 */
export function x(keys: AppKeys | null, f: Fetch = fetch): ChannelAdapter {
  const need = () => {
    if (!keys) throw notSetUp("X", ["X_CLIENT_ID", "X_CLIENT_SECRET"]);
    return keys;
  };
  const basic = (k: AppKeys) => `Basic ${btoa(`${k.id}:${k.secret}`)}`;
  const bearer = (t: Tokens) => ({ authorization: `Bearer ${t.access}` });
  const tokens = (r: { access_token: string; refresh_token?: string; expires_in?: number }, prev?: Tokens): Pick<Tokens, "access" | "refresh" | "expiresAt"> => ({
    access: r.access_token,
    refresh: r.refresh_token ?? prev?.refresh ?? null,
    expiresAt: r.expires_in ? Date.now() + r.expires_in * 1000 : null,
  });

  async function upload(t: Tokens, url: string, alt: string): Promise<string> {
    const img = await f(url);
    if (!img.ok) throw new PlatformError(`Could not read the picture to upload (${img.status})`, "retry");
    const form = new FormData();
    form.set("media", new Blob([await img.arrayBuffer()], { type: img.headers.get("content-type") ?? "image/jpeg" }));
    form.set("media_category", "tweet_image");
    const r = await call<{ data?: { id: string }; media_id_string?: string }>(f, `${API}/media/upload`, { method: "POST", headers: bearer(t), body: form });
    const id = r.data?.id ?? r.media_id_string;
    if (!id) throw new PlatformError("X did not return the picture's id", "final");
    if (alt) await call(f, `${API}/media/metadata`, { method: "POST", headers: bearer(t), json: { id, metadata: { alt_text: { text: alt.slice(0, 1000) } } } }).catch(() => null);
    return id;
  }

  return {
    platform: "x",
    async authorizeUrl({ state, redirect, verifier }) {
      const k = need();
      return `https://x.com/i/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: k.id, redirect_uri: redirect, state, scope: "tweet.read tweet.write users.read media.write offline.access", code_challenge: await challengeFor(verifier), code_challenge_method: "S256" })}`;
    },
    async exchange({ code, redirect, verifier }) {
      const k = need();
      const r = await call<{ access_token: string; refresh_token?: string; expires_in?: number }>(f, `${API}/oauth2/token`, { method: "POST", headers: { authorization: basic(k) }, form: { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: k.id } });
      const me = await call<{ data: { id: string; username: string; public_metrics?: { followers_count: number } } }>(f, `${API}/users/me?user.fields=public_metrics`, { headers: { authorization: `Bearer ${r.access_token}` } });
      return { tokens: { ...tokens(r), account: me.data.id, extra: { username: me.data.username } }, handle: `@${me.data.username}`, followers: me.data.public_metrics?.followers_count ?? null };
    },
    async refresh(t) {
      const k = need();
      if (!t.refresh) throw new PlatformError("X needs to be connected again", "expired");
      const r = await call<{ access_token: string; refresh_token?: string; expires_in?: number }>(f, `${API}/oauth2/token`, { method: "POST", headers: { authorization: basic(k) }, form: { grant_type: "refresh_token", refresh_token: t.refresh, client_id: k.id } });
      return { ...t, ...tokens(r, t) };
    },
    async publish(t, v, media) {
      const ids: string[] = [];
      for (const m of media.filter((x) => x.kind === "image").slice(0, 4)) ids.push(await upload(t, m.url, m.alt));
      const r = await call<{ data: { id: string } }>(f, `${API}/tweets`, { method: "POST", headers: bearer(t), json: { text: v.text, ...(ids.length ? { media: { media_ids: ids } } : {}) } });
      return { externalId: r.data.id, url: `https://x.com/${t.extra.username ?? "i"}/status/${r.data.id}` };
    },
    async reply(t, to, text) {
      if (!to.externalId) throw new PlatformError("This mention has no X id", "final");
      const r = await call<{ data: { id: string } }>(f, `${API}/tweets`, { method: "POST", headers: bearer(t), json: { text, reply: { in_reply_to_tweet_id: to.externalId } } });
      return { externalId: r.data.id };
    },
    async pull() {
      return { messages: [], metrics: [] };
    },
  };
}
