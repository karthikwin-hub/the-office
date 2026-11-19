/**
 * Checks for the riskier things a signed-in person can do. Owners and platform owners hold the keys to
 * a business's books, so they need two-factor sign-in before anything owner-only.
 */

/** What an owner without two-factor sign-in is told; the web app reads `code` and opens the enrolment. */
export const TWO_FACTOR_NEEDED = { error: "Set up two-step sign-in for your account first. It keeps your business's books safe if your password leaks.", code: "two_factor_required" } as const;

/** True when this person must still turn two-factor sign-in on before acting as an owner. */
export const twoFactorMissing = (user: { twoFactorEnabled: boolean }) => !user.twoFactorEnabled;
