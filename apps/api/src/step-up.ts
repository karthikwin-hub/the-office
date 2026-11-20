import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, isAPIError, sessionMiddleware } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";

/**
 * Checks for the riskier things a signed-in person can do. Owners and platform owners hold the keys to
 * a business's books, so they need two-factor sign-in before anything owner-only; exporting the books,
 * inviting someone, changing who is an owner and deleting the office also need a recent sign-in or a
 * fresh password or code, so a session cookie that leaked hours ago cannot do them.
 */

/** What an owner without two-factor sign-in is told; the web app reads `code` and opens the enrolment. */
export const TWO_FACTOR_NEEDED = {
  error: "Set up two-step sign-in for your account first. It keeps your business's books safe if your password leaks.",
  code: "two_factor_required",
} as const;

/** True when this person must still turn two-factor sign-in on before acting as an owner. */
export const twoFactorMissing = (user: { twoFactorEnabled: boolean }) => !user.twoFactorEnabled;

/** How long a sign-in, or a password or code typed again, counts as fresh. */
export const FRESH_MS = 15 * 60 * 1000;

/** What a stale session is told; the web app reads `code`, asks for the password or a code, and tries again. */
export const STEP_UP_NEEDED = {
  error: "Confirm it is you: type your password or a code from your authenticator app, then try again.",
  code: "step_up_required",
} as const;

/** Signed in within FRESH_MS, or confirmed with a password or code since. */
export const isFresh = (s: { createdAt: Date | number; stepUpAt?: Date | number | null }, now = Date.now()) =>
  now - new Date(s.createdAt).getTime() < FRESH_MS || (s.stepUpAt != null && now - new Date(s.stepUpAt).getTime() < FRESH_MS);

/** Tries one account gets at step-up in FRESH_MS, from any number of addresses; a right answer starts the count again. */
export const STEP_UP_TRIES = 10;

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type Counter = { key: string; count: number; lastRequest: number };

/**
 * Takes one try from this account's allowance, atomically, so a burst of guesses cannot all read the same
 * count. Kept in the rate-limit table, whose old rows Better Auth prunes.
 */
async function takeTry(ctx: Ctx, key: string, retried = false): Promise<boolean> {
  const now = Date.now();
  const byKey = [{ field: "key", value: key }];
  const took = await ctx.context.adapter.incrementOne({
    model: "rateLimit",
    where: [...byKey, { field: "count", operator: "lt", value: STEP_UP_TRIES }, { field: "lastRequest", operator: "gt", value: now - FRESH_MS }],
    increment: { count: 1 },
  });
  if (took) return true;
  const row = await ctx.context.adapter.findOne<Counter>({ model: "rateLimit", where: byKey });
  if (row && now - Number(row.lastRequest) < FRESH_MS) return false;
  if (row) {
    const restarted = await ctx.context.adapter.incrementOne({
      model: "rateLimit",
      where: [...byKey, { field: "lastRequest", operator: "lte", value: Number(row.lastRequest) }],
      increment: {},
      set: { count: 1, lastRequest: now },
    });
    if (restarted) return true;
  } else
    try {
      await ctx.context.adapter.create({ model: "rateLimit", data: { key, count: 1, lastRequest: now } });
      return true;
    } catch {
      // Someone else made the row first; count against it.
    }
  return !retried && takeTry(ctx, key, true);
}

/** As the two-factor plugin stores it: encrypted with the auth secret, sometimes as `base32:` text. */
async function totpSecret(key: Parameters<typeof symmetricDecrypt>[0]["key"], data: string): Promise<string> {
  const secret = await symmetricDecrypt({ key, data });
  return secret.startsWith("base32:") ? new TextDecoder().decode(base32.decode(secret.slice(7).toUpperCase())) : secret;
}

/** Someone signed in checking codes against an account that already has two-factor on: only an attacker needs that. */
const CODE_CHECKS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const enrolling = new WeakMap<object, { email: string; name: string }>();

type Mail = (to: string, subject: string, lines: string[]) => Promise<unknown>;

/**
 * `POST /api/auth/step-up` with `{ code }` (the authenticator's), or `{ password }` for someone without
 * two-factor: marks this session as freshly confirmed. Inside Better Auth so it shares its origin check
 * and its rate limit, which counts in D1. Also tells people by email when two-factor sign-in is turned on
 * or off for their account.
 */
export const stepUp = (mail: Mail) =>
  ({
    id: "step-up",
    schema: { session: { fields: { stepUpAt: { type: "date", required: false, input: false } } } },
    endpoints: {
      stepUp: createAuthEndpoint(
        "/step-up",
        {
          method: "POST",
          body: z.object({ password: z.string().min(1).max(256).optional(), code: z.string().min(6).max(12).optional() }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const { password, code } = ctx.body;
          const tally = `step-up:${user.id}`;
          if (!(await takeTry(ctx, tally)))
            throw APIError.fromStatus("TOO_MANY_REQUESTS", { message: "Too many wrong tries. Sign out, then sign in again to go on." });
          let ok = false;
          if ((user as { twoFactorEnabled?: boolean }).twoFactorEnabled) {
            // With two-factor on, only the second factor counts: a stolen cookie and a leaked password are not enough.
            if (!code) throw APIError.fromStatus("BAD_REQUEST", { message: "Type the code your authenticator app shows." });
            const row = await ctx.context.adapter.findOne<{ secret: string; verified: boolean | null }>({
              model: "twoFactor",
              where: [{ field: "userId", value: user.id }],
            });
            if (row && row.verified !== false)
              ok = await createOTP(await totpSecret(ctx.context.secretConfig, row.secret), { digits: 6, period: 30 }).verify(code.replace(/\s+/g, ""));
          } else if (password) {
            const login = (await ctx.context.internalAdapter.findAccounts(user.id)).find((a) => a.providerId === "credential" && a.password);
            ok = Boolean(login?.password) && (await ctx.context.password.verify({ hash: login!.password!, password }));
          }
          if (!ok) throw APIError.fromStatus("UNAUTHORIZED", { message: code ? "That code is not right." : "That password is not right." });
          await ctx.context.adapter.deleteMany({ model: "rateLimit", where: [{ field: "key", value: tally }] });
          await ctx.context.internalAdapter.updateSession(session.token, { stepUpAt: new Date() });
          return ctx.json({ ok: true });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => CODE_CHECKS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const signedIn = await getSessionFromCtx(ctx);
            if (!signedIn) return; // the second step of a sign-in: the plugin counts and locks those
            if ((signedIn.user as { twoFactorEnabled?: boolean }).twoFactorEnabled)
              throw APIError.fromStatus("FORBIDDEN", { message: "Two-step sign-in is already on." });
            if (ctx.request) enrolling.set(ctx.request, { email: signedIn.user.email, name: signedIn.user.name });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const who = ctx.path === "/two-factor/disable" ? ctx.context.session?.user : ctx.request ? enrolling.get(ctx.request) : undefined;
            if (!who) return;
            const on = ctx.path !== "/two-factor/disable";
            await mail(who.email, on ? "Two-step sign-in is now on for your account" : "Two-step sign-in was turned off for your account", [
              `Hello ${who.name},`,
              "",
              on
                ? "Signing in to your account now asks for a code from an authenticator app as well as your password."
                : "Signing in to your account now asks only for your password.",
              "",
              'If this was not you, someone has your password: choose "Forgotten your password?" on the sign-in page at once, and write to us so we can reset two-step sign-in.',
            ]);
          }),
        },
      ],
    },
    rateLimit: [{ pathMatcher: (path: string) => path === "/step-up", window: 300, max: 5 }],
  }) satisfies BetterAuthPlugin;
