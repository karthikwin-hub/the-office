import type { PostMetrics, PostVariant, SocialMessage } from "@office/contracts";
import type { IncomingMessage } from "@office/engine";
import { type AppKeys, call, type ChannelAdapter, type Connected, type Fetch, notSetUp, PlatformError, type Pulled, type SignedMedia, type Tokens } from "./adapter";

/**
 * Meta's four channels. Written against the Graph API as documented in 2025: check the versions and
 * permission names in the Meta app dashboard when the app is created, since Meta renames them often.
 */
export const GRAPH_VERSION = "v21.0";
const FB = `https://graph.facebook.com/${GRAPH_VERSION}`;
const IG = `https://graph.instagram.com/${GRAPH_VERSION}`;
const TH = "https://graph.threads.net/v1.0";

const qs = (o: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const zero = (): PostMetrics => ({ views: 0, likes: 0, comments: 0, saves: 0, shares: 0, clicks: 0, enquiries: 0 });
const since = (iso: string) => Date.parse(iso) || 0;

/** Instagram and Threads build a container, then publish it once the platform has fetched the media. */
async function waitForContainer(f: Fetch, url: string, tries = 6, gapMs = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const s = await call<{ status_code?: string; status?: string; error_message?: string }>(f, url);
    const code = s.status_code ?? s.status;
    if (!code || code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new PlatformError(`The platform could not use the picture${s.error_message ? `: ${s.error_message}` : ""}`, "final");
    await sleep(gapMs);
  }
  throw new PlatformError("The platform is still processing the picture", "retry", 120);
}

/* ---------- Instagram (Instagram API with Instagram login) ---------- */

export function instagram(keys: AppKeys | null, f: Fetch = fetch, opts: { gapMs?: number } = {}): ChannelAdapter {
  const need = () => {
    if (!keys) throw notSetUp("Instagram", ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"]);
    return keys;
  };
  const longLived = async (short: string): Promise<{ access_token: string; expires_in?: number }> =>
    call(f, `https://graph.instagram.com/access_token?${qs({ grant_type: "ig_exchange_token", client_secret: need().secret, access_token: short })}`);
  return {
    platform: "instagram",
    async authorizeUrl({ state, redirect }) {
      const k = need();
      return `https://www.instagram.com/oauth/authorize?${qs({ client_id: k.id, redirect_uri: redirect, response_type: "code", state, scope: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages" })}`;
    },
    async exchange({ code, redirect }): Promise<Connected> {
      const k = need();
      const raw = await call<{ access_token?: string; user_id?: string | number; data?: { access_token: string; user_id: string | number }[] }>(f, "https://api.instagram.com/oauth/access_token", {
        method: "POST",
        form: { client_id: k.id, client_secret: k.secret, grant_type: "authorization_code", redirect_uri: redirect, code: code.replace(/#_$/, "") },
      });
      const short = raw.access_token ?? raw.data?.[0]?.access_token;
      if (!short) throw new PlatformError("Instagram did not return a token", "final");
      const long = await longLived(short);
      const me = await call<{ user_id?: string; id: string; username: string; followers_count?: number }>(f, `${IG}/me?${qs({ fields: "user_id,username,followers_count", access_token: long.access_token })}`);
      const tokens: Tokens = { access: long.access_token, refresh: null, expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null, account: String(me.user_id ?? me.id), extra: { username: me.username } };
      return { tokens, handle: `@${me.username}`, followers: me.followers_count ?? null };
    },
    async refresh(t) {
      const r = await call<{ access_token: string; expires_in?: number }>(f, `https://graph.instagram.com/refresh_access_token?${qs({ grant_type: "ig_refresh_token", access_token: t.access })}`);
      return { ...t, access: r.access_token, expiresAt: r.expires_in ? Date.now() + r.expires_in * 1000 : t.expiresAt };
    },
    async publish(t, v: PostVariant, media: SignedMedia[]) {
      if (!media.length) throw new PlatformError("Instagram needs a picture", "final");
      const images = media.filter((m) => m.kind === "image").slice(0, 10);
      const at = { access_token: t.access };
      let creation: string;
      if (images.length === 1) {
        creation = (await call<{ id: string }>(f, `${IG}/${t.account}/media`, { method: "POST", form: { ...at, image_url: images[0]!.url, caption: v.text, ...(images[0]!.alt ? { alt_text: images[0]!.alt } : {}) } })).id;
      } else {
        const children: string[] = [];
        for (const m of images) children.push((await call<{ id: string }>(f, `${IG}/${t.account}/media`, { method: "POST", form: { ...at, image_url: m.url, is_carousel_item: "true", ...(m.alt ? { alt_text: m.alt } : {}) } })).id);
        creation = (await call<{ id: string }>(f, `${IG}/${t.account}/media`, { method: "POST", form: { ...at, media_type: "CAROUSEL", children: children.join(","), caption: v.text } })).id;
      }
      await waitForContainer(f, `${IG}/${creation}?${qs({ fields: "status_code", access_token: t.access })}`, 6, opts.gapMs ?? 2000);
      const done = await call<{ id: string }>(f, `${IG}/${t.account}/media_publish`, { method: "POST", form: { ...at, creation_id: creation } });
      const link = await call<{ permalink?: string }>(f, `${IG}/${done.id}?${qs({ fields: "permalink", access_token: t.access })}`).catch(() => ({ permalink: undefined }));
      return { externalId: done.id, url: link.permalink ?? null };
    },
    async reply(t, to: SocialMessage, text) {
      if (!to.externalId) throw new PlatformError("This comment has no Instagram id", "final");
      if (to.kind === "dm") {
        const r = await call<{ message_id?: string }>(f, `${IG}/${t.account}/messages`, { method: "POST", json: { recipient: { id: to.threadId }, message: { text } }, headers: { authorization: `Bearer ${t.access}` } });
        return { externalId: r.message_id ?? null };
      }
      const r = await call<{ id: string }>(f, `${IG}/${to.externalId}/replies`, { method: "POST", form: { access_token: t.access, message: text } });
      return { externalId: r.id };
    },
    async pull(t, { since: from, externalIds }): Promise<Pulled> {
      const messages: IncomingMessage[] = [];
      const metrics: Pulled["metrics"] = [];
      for (const id of externalIds) {
        try {
          const c = await call<{ data: { id: string; text: string; username?: string; timestamp: string; from?: { id: string } }[] }>(f, `${IG}/${id}/comments?${qs({ fields: "id,text,username,timestamp,from", access_token: t.access })}`);
          for (const x of c.data) {
            if (since(x.timestamp) <= since(from) || x.from?.id === t.account || x.username === t.extra.username) continue;
            messages.push({ id: `ig-${x.id}`, externalId: x.id, platform: "Instagram", channelId: "", kind: "comment", author: x.username ? `@${x.username}` : "Someone on Instagram", at: new Date(x.timestamp).toISOString(), rating: null, text: x.text, postId: null, threadId: id });
          }
          const ins = await call<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(f, `${IG}/${id}/insights?${qs({ metric: "views,likes,comments,saved,shares", access_token: t.access })}`);
          const m = zero();
          for (const d of ins.data) {
            const n = d.total_value?.value ?? d.values?.[0]?.value ?? 0;
            if (d.name === "views") m.views = n;
            if (d.name === "likes") m.likes = n;
            if (d.name === "comments") m.comments = n;
            if (d.name === "saved") m.saves = n;
            if (d.name === "shares") m.shares = n;
          }
          metrics.push({ externalId: id, metrics: m });
        } catch (e) {
          if (e instanceof PlatformError && (e.kind === "expired" || e.kind === "rate_limited")) throw e;
        }
      }
      return { messages, metrics };
    },
  };
}

/* ---------- Facebook Page ---------- */

export function facebook(keys: AppKeys | null, f: Fetch = fetch): ChannelAdapter {
  const need = () => {
    if (!keys) throw notSetUp("Facebook", ["META_APP_ID", "META_APP_SECRET"]);
    return keys;
  };
  return {
    platform: "facebook",
    async authorizeUrl({ state, redirect }) {
      const k = need();
      return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${qs({ client_id: k.id, redirect_uri: redirect, state, response_type: "code", scope: "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,pages_read_user_content,read_insights" })}`;
    },
    async exchange({ code, redirect }): Promise<Connected> {
      const k = need();
      const short = await call<{ access_token: string }>(f, `${FB}/oauth/access_token?${qs({ client_id: k.id, client_secret: k.secret, redirect_uri: redirect, code })}`);
      const long = await call<{ access_token: string }>(f, `${FB}/oauth/access_token?${qs({ grant_type: "fb_exchange_token", client_id: k.id, client_secret: k.secret, fb_exchange_token: short.access_token })}`);
      const pages = await call<{ data: { id: string; name: string; access_token: string; followers_count?: number }[] }>(f, `${FB}/me/accounts?${qs({ fields: "id,name,access_token,followers_count", access_token: long.access_token })}`);
      const page = pages.data[0];
      if (!page) throw new PlatformError("This Facebook account manages no Page. Create the business Page first, or give this account a role on it.", "final");
      // A Page token from a long-lived user token does not expire.
      return { tokens: { access: page.access_token, refresh: null, expiresAt: null, account: page.id, extra: { page: page.id } }, handle: page.name, followers: page.followers_count ?? null };
    },
    async publish(t, v, media) {
      const images = media.filter((m) => m.kind === "image");
      const base = { access_token: t.access };
      let id: string;
      if (images.length === 1) {
        const r = await call<{ id: string; post_id?: string }>(f, `${FB}/${t.account}/photos`, { method: "POST", form: { ...base, url: images[0]!.url, caption: v.text, ...(images[0]!.alt ? { alt_text_custom: images[0]!.alt } : {}) } });
        id = r.post_id ?? r.id;
      } else if (images.length > 1) {
        const attached: string[] = [];
        for (const m of images.slice(0, 10)) attached.push((await call<{ id: string }>(f, `${FB}/${t.account}/photos`, { method: "POST", form: { ...base, url: m.url, published: "false", ...(m.alt ? { alt_text_custom: m.alt } : {}) } })).id);
        const form: Record<string, string> = { ...base, message: v.text };
        attached.forEach((a, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: a })));
        id = (await call<{ id: string }>(f, `${FB}/${t.account}/feed`, { method: "POST", form })).id;
      } else {
        id = (await call<{ id: string }>(f, `${FB}/${t.account}/feed`, { method: "POST", form: { ...base, message: v.text, ...(v.link ? { link: v.link } : {}) } })).id;
      }
      return { externalId: id, url: `https://www.facebook.com/${id}` };
    },
    async reply(t, to, text) {
      if (!to.externalId) throw new PlatformError("This comment has no Facebook id", "final");
      if (to.kind === "review") throw new PlatformError("Facebook does not let Pages reply to recommendations through the API; reply on the Page", "final");
      const r = await call<{ id: string }>(f, `${FB}/${to.externalId}/comments`, { method: "POST", form: { access_token: t.access, message: text } });
      return { externalId: r.id };
    },
    async pull(t, { externalIds }) {
      const metrics: Pulled["metrics"] = [];
      for (const id of externalIds) {
        try {
          const p = await call<{ shares?: { count: number }; reactions?: { summary: { total_count: number } }; comments?: { summary: { total_count: number } } }>(f, `${FB}/${id}?${qs({ fields: "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", access_token: t.access })}`);
          const m = zero();
          m.likes = p.reactions?.summary.total_count ?? 0;
          m.comments = p.comments?.summary.total_count ?? 0;
          m.shares = p.shares?.count ?? 0;
          const ins = await call<{ data: { name: string; values: { value: number }[] }[] }>(f, `${FB}/${id}/insights?${qs({ metric: "post_impressions_unique,post_clicks", access_token: t.access })}`).catch(() => ({ data: [] }));
          for (const d of ins.data) {
            if (d.name === "post_impressions_unique") m.views = d.values[0]?.value ?? 0;
            if (d.name === "post_clicks") m.clicks = d.values[0]?.value ?? 0;
          }
          metrics.push({ externalId: id, metrics: m });
        } catch (e) {
          if (e instanceof PlatformError && (e.kind === "expired" || e.kind === "rate_limited")) throw e;
        }
      }
      // Comments arrive by webhook.
      return { messages: [], metrics };
    },
  };
}

/* ---------- Threads ---------- */

export function threads(keys: AppKeys | null, f: Fetch = fetch, opts: { gapMs?: number } = {}): ChannelAdapter {
  const need = () => {
    if (!keys) throw notSetUp("Threads", ["THREADS_APP_ID", "THREADS_APP_SECRET"]);
    return keys;
  };
  const create = async (t: Tokens, form: Record<string, string>) => {
    const c = await call<{ id: string }>(f, `${TH}/${t.account}/threads`, { method: "POST", form: { access_token: t.access, ...form } });
    return c.id;
  };
  const publishContainer = async (t: Tokens, id: string, media: boolean) => {
    if (media) await waitForContainer(f, `${TH}/${id}?${qs({ fields: "status,error_message", access_token: t.access })}`, 6, opts.gapMs ?? 3000);
    return (await call<{ id: string }>(f, `${TH}/${t.account}/threads_publish`, { method: "POST", form: { access_token: t.access, creation_id: id } })).id;
  };
  return {
    platform: "threads",
    async authorizeUrl({ state, redirect }) {
      const k = need();
      return `https://threads.net/oauth/authorize?${qs({ client_id: k.id, redirect_uri: redirect, response_type: "code", state, scope: "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_manage_insights" })}`;
    },
    async exchange({ code, redirect }) {
      const k = need();
      const short = await call<{ access_token: string; user_id: string | number }>(f, "https://graph.threads.net/oauth/access_token", { method: "POST", form: { client_id: k.id, client_secret: k.secret, grant_type: "authorization_code", redirect_uri: redirect, code } });
      const long = await call<{ access_token: string; expires_in?: number }>(f, `https://graph.threads.net/access_token?${qs({ grant_type: "th_exchange_token", client_secret: k.secret, access_token: short.access_token })}`);
      const me = await call<{ id: string; username: string }>(f, `${TH}/me?${qs({ fields: "id,username", access_token: long.access_token })}`);
      return { tokens: { access: long.access_token, refresh: null, expiresAt: long.expires_in ? Date.now() + long.expires_in * 1000 : null, account: me.id, extra: { username: me.username } }, handle: `@${me.username}`, followers: null };
    },
    async refresh(t) {
      const r = await call<{ access_token: string; expires_in?: number }>(f, `https://graph.threads.net/refresh_access_token?${qs({ grant_type: "th_refresh_token", access_token: t.access })}`);
      return { ...t, access: r.access_token, expiresAt: r.expires_in ? Date.now() + r.expires_in * 1000 : t.expiresAt };
    },
    async publish(t, v, media) {
      const images = media.filter((m) => m.kind === "image").slice(0, 20);
      let id: string;
      if (!images.length) id = await create(t, { media_type: "TEXT", text: v.text });
      else if (images.length === 1) id = await create(t, { media_type: "IMAGE", image_url: images[0]!.url, text: v.text, ...(images[0]!.alt ? { alt_text: images[0]!.alt } : {}) });
      else {
        const children: string[] = [];
        for (const m of images) children.push(await create(t, { media_type: "IMAGE", image_url: m.url, is_carousel_item: "true", ...(m.alt ? { alt_text: m.alt } : {}) }));
        id = await create(t, { media_type: "CAROUSEL", children: children.join(","), text: v.text });
      }
      const done = await publishContainer(t, id, images.length > 0);
      const link = await call<{ permalink?: string }>(f, `${TH}/${done}?${qs({ fields: "permalink", access_token: t.access })}`).catch(() => ({ permalink: undefined }));
      return { externalId: done, url: link.permalink ?? null };
    },
    async reply(t, to, text) {
      if (!to.externalId) throw new PlatformError("This reply has no Threads id", "final");
      const id = await create(t, { media_type: "TEXT", text, reply_to_id: to.externalId });
      return { externalId: await publishContainer(t, id, false) };
    },
    async pull(t, { since: from, externalIds }) {
      const messages: IncomingMessage[] = [];
      const metrics: Pulled["metrics"] = [];
      for (const id of externalIds) {
        try {
          const r = await call<{ data: { id: string; text?: string; username?: string; timestamp: string }[] }>(f, `${TH}/${id}/replies?${qs({ fields: "id,text,username,timestamp", access_token: t.access })}`);
          for (const x of r.data) {
            if (!x.text || since(x.timestamp) <= since(from) || x.username === t.extra.username) continue;
            messages.push({ id: `th-${x.id}`, externalId: x.id, platform: "Threads", channelId: "", kind: "comment", author: x.username ? `@${x.username}` : "Someone on Threads", at: new Date(x.timestamp).toISOString(), rating: null, text: x.text, postId: null, threadId: id });
          }
          const ins = await call<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(f, `${TH}/${id}/insights?${qs({ metric: "views,likes,replies,reposts,quotes,shares", access_token: t.access })}`);
          const m = zero();
          for (const d of ins.data) {
            const n = d.total_value?.value ?? d.values?.[0]?.value ?? 0;
            if (d.name === "views") m.views = n;
            if (d.name === "likes") m.likes = n;
            if (d.name === "replies") m.comments = n;
            if (d.name === "reposts" || d.name === "quotes" || d.name === "shares") m.shares += n;
          }
          metrics.push({ externalId: id, metrics: m });
        } catch (e) {
          if (e instanceof PlatformError && (e.kind === "expired" || e.kind === "rate_limited")) throw e;
        }
      }
      return { messages, metrics };
    },
  };
}

/* ---------- WhatsApp Cloud API ---------- */

/**
 * A single business uses a system user token and its phone number id, both Worker secrets, so "connecting"
 * only checks them. Replies are free inside the 24 hours after a customer writes; broadcasts are paid templates.
 */
export function whatsapp(keys: { token: string; phoneId: string; template: string | null } | null, f: Fetch = fetch): ChannelAdapter {
  const need = () => {
    if (!keys) throw notSetUp("WhatsApp", ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]);
    return keys;
  };
  const send = (t: Tokens, body: Record<string, unknown>) =>
    call<{ messages?: { id: string }[] }>(f, `${FB}/${t.account}/messages`, { method: "POST", json: { messaging_product: "whatsapp", recipient_type: "individual", ...body }, headers: { authorization: `Bearer ${t.access}` } });
  return {
    platform: "whatsapp",
    async authorizeUrl({ state, redirect }) {
      need();
      return `${redirect}?${qs({ code: "system-user", state })}`;
    },
    async exchange() {
      const k = need();
      const n = await call<{ id: string; display_phone_number?: string; verified_name?: string }>(f, `${FB}/${k.phoneId}?${qs({ fields: "display_phone_number,verified_name" })}`, { headers: { authorization: `Bearer ${k.token}` } });
      return { tokens: { access: k.token, refresh: null, expiresAt: null, account: n.id, extra: { ...(k.template ? { template: k.template } : {}), templateLanguage: "en" } }, handle: n.display_phone_number ?? n.verified_name ?? "WhatsApp Business", followers: null };
    },
    async publish() {
      throw new PlatformError("WhatsApp posts go out as broadcasts or by hand as a Status", "final");
    },
    async reply(t, to, text) {
      if (!to.threadId) throw new PlatformError("No phone number to reply to", "final");
      if (to.replyBy && Date.parse(to.replyBy) < Date.now()) throw new PlatformError("WhatsApp's 24-hour reply window has closed", "final");
      const r = await send(t, { to: to.threadId, type: "text", text: { preview_url: false, body: text }, ...(to.externalId ? { context: { message_id: to.externalId } } : {}) });
      return { externalId: r.messages?.[0]?.id ?? null };
    },
    async broadcast(t, { template, language, text, audience }) {
      if (!template) throw new PlatformError("Broadcasts need an approved marketing template: add its name as WHATSAPP_TEMPLATE", "not_set_up");
      let sent = 0;
      let failed = 0;
      for (const to of audience) {
        try {
          await send(t, { to, type: "template", template: { name: template, language: { code: language }, components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\s*\n\s*/g, " · ").replace(/\s{4,}/g, " ").slice(0, 1024) }] }] } });
          sent++;
        } catch (e) {
          if (e instanceof PlatformError && (e.kind === "rate_limited" || e.kind === "expired")) throw e;
          failed++;
        }
      }
      return { sent, failed };
    },
    async pull() {
      // Messages arrive only by webhook; WhatsApp has no post metrics.
      return { messages: [], metrics: [] };
    },
  };
}
