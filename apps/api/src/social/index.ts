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
    // The platform's own number (WHATSAPP_TOKEN) is never a business's channel: each business signs up its own.
    whatsapp: whatsapp({ app: keys(env.META_APP_ID, env.META_APP_SECRET), configId: env.WHATSAPP_CONFIG_ID ?? null }, f),
    linkedin: linkedin(keys(env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET), f),
    x: x(keys(env.X_CLIENT_ID, env.X_CLIENT_SECRET), f),
  };
}
