import { type AppKeys, call, type ChannelAdapter, type Fetch, failure, notSetUp, PlatformError, type Tokens } from "./adapter";

/** LinkedIn supports each monthly API version for about a year; last month's is always live. */
export function linkedinVersion(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Posting as the owner's own member profile, which self-serve apps may do ("Share on LinkedIn"
 * with "Sign In with LinkedIn using OpenID Connect"). Company pages, comments and post analytics
 * need LinkedIn's Community Management approval, so replies and metrics come by hand or CSV.
 */
export function linkedin(keys: AppKeys | null, f: Fetch = fetch): ChannelAdapter {
  const need = () => {
    if (!keys) throw notSetUp("LinkedIn", ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"]);
    return keys;
  };
  const rest = (t: Tokens) => ({ authorization: `Bearer ${t.access}`, "linkedin-version": linkedinVersion(), "x-restli-protocol-version": "2.0.0" });

  async function uploadImage(t: Tokens, url: string): Promise<string> {
    const init = await call<{ value: { uploadUrl: string; image: string } }>(f, "https://api.linkedin.com/rest/images?action=initializeUpload", { method: "POST", headers: rest(t), json: { initializeUploadRequest: { owner: t.account } } });
    const img = await f(url);
    if (!img.ok) throw new PlatformError(`Could not read the picture to upload (${img.status})`, "retry");
    const put = await f(init.value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${t.access}`, "content-type": img.headers.get("content-type") ?? "image/jpeg" }, body: await img.arrayBuffer() });
    if (!put.ok) throw new PlatformError(`LinkedIn did not take the picture (${put.status})`, put.status >= 500 ? "retry" : "final");
    return init.value.image;
  }

  return {
    platform: "linkedin",
    async authorizeUrl({ state, redirect }) {
      const k = need();
      return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: "code", client_id: k.id, redirect_uri: redirect, state, scope: "openid profile w_member_social" })}`;
    },
    async exchange({ code, redirect }) {
      const k = need();
      const tok = await call<{ access_token: string; expires_in: number; refresh_token?: string }>(f, "https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", form: { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: k.id, client_secret: k.secret } });
      const me = await call<{ sub: string; name?: string }>(f, "https://api.linkedin.com/v2/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } });
      return { tokens: { access: tok.access_token, refresh: tok.refresh_token ?? null, expiresAt: Date.now() + tok.expires_in * 1000, account: `urn:li:person:${me.sub}`, extra: {} }, handle: me.name ?? "LinkedIn member", followers: null };
    },
    async publish(t, v, media) {
      const image = media.find((m) => m.kind === "image");
      const content = image ? { media: { id: await uploadImage(t, image.url), ...(image.alt ? { altText: image.alt.slice(0, 4086) } : {}) } } : undefined;
      const res = await f("https://api.linkedin.com/rest/posts", {
        method: "POST",
        headers: { ...rest(t), "content-type": "application/json" },
        body: JSON.stringify({
          author: t.account,
          // LinkedIn's "little text" format treats these as markup.
          commentary: v.text.replace(/([\\|{}@[\]()<>#*_~])/g, "\\$1"),
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
          ...(content ? { content } : {}),
        }),
      });
      if (!res.ok) throw failure(res.status, await res.json().catch(() => null), res.headers);
      const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
      if (!urn) throw new PlatformError("LinkedIn did not return the post's id", "final");
      return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
    },
    async reply() {
      throw new PlatformError("LinkedIn only lets approved partners reply through the API; reply on LinkedIn", "final");
    },
    async pull() {
      return { messages: [], metrics: [] };
    },
  };
}
