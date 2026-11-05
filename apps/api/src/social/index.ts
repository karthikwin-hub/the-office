import type { Env } from "../env";
import type { AppKeys, Fetch } from "./adapter";
import type { Adapters } from "./host";
import { linkedin } from "./linkedin";
import { facebook, instagram, threads, whatsapp } from "./meta";
import { x } from "./x";

const keys = (id: string | undefined, secret: string | undefined): AppKeys | null => (id && secret ? { id, secret } : null);

/** Every platform with an adapter. Google Business updates stay manual: its posting API is closed to new apps. */
export function adaptersFor(env: Env, f: Fetch = fetch): Adapters {
  return {
    instagram: instagram(keys(env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET), f),
    facebook: facebook(keys(env.META_APP_ID, env.META_APP_SECRET), f),
    threads: threads(keys(env.THREADS_APP_ID, env.THREADS_APP_SECRET), f),
    whatsapp: whatsapp(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? { token: env.WHATSAPP_TOKEN, phoneId: env.WHATSAPP_PHONE_NUMBER_ID, template: env.WHATSAPP_TEMPLATE ?? null } : null, f),
    linkedin: linkedin(keys(env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET), f),
    x: x(keys(env.X_CLIENT_ID, env.X_CLIENT_SECRET), f),
  };
}
