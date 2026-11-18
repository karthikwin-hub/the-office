import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { BRAND } from "@office/contracts";
import { account } from "../api/client";
import { BrandPlate, currentDocuments, LegalFooter } from "./Legal";

type Mode = "sign-in" | "sign-up" | "forgot" | "reset";

/** What a password-reset link brought back: a token to choose a new password with, or word that it has expired. */
function resetFromUrl(): { token: string | null; expired: boolean } | null {
  const p = new URLSearchParams(location.search);
  if (!p.has("reset-password")) return null;
  const token = p.get("token");
  return { token, expired: p.get("error") === "INVALID_TOKEN" || !token };
}

/** Takes the reset link's token out of the address bar, so it is not left in the history or shared by accident. */
function clearResetUrl() {
  const u = new URL(location.href);
  for (const k of ["reset-password", "token", "error"]) u.searchParams.delete(k);
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

/**
 * The front door. Anyone can make an account; an account on its own sees nothing.
 * It opens an office of its own, or joins one from an invitation link.
 * A forgotten password is replaced through a link sent to the account's email.
 * An invitation link is looked up first: a used or expired one opens on Sign in, since the
 * person most likely already has an account, and a live one names its office and address.
 */
export function SignIn({ invite = null, onInviteSpent, staff }: { invite?: string | null; onInviteSpent?: () => void; staff?: { appAddress: string; appHref: string } }) {
  const qc = useQueryClient();
  const [reset] = useState(resetFromUrl);
  const peek = useQuery({ queryKey: ["invitation", invite], queryFn: () => account.peekInvitation(invite!), enabled: Boolean(invite) && !reset, retry: false, staleTime: Infinity });
  const invited = Boolean(invite) && !peek.isError;
  const [mode, setModeState] = useState<Mode>(reset ? "reset" : invite ? "sign-up" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A spent link: forget it, and sign in instead of making a second account.
  useEffect(() => {
    if (!peek.isError) return;
    onInviteSpent?.();
    setModeState((m) => (m === "sign-up" ? "sign-in" : m));
    setNotice("That invitation link has already been used or has expired. If you have an account, sign in; to join an office for the first time, ask its owner for a new invitation.");
  }, [peek.isError]); // eslint-disable-line react-hooks/exhaustive-deps
  // A live one: the address it was sent to goes in the form.
  useEffect(() => {
    if (peek.data) setEmail((e) => e || peek.data.email);
  }, [peek.data]);

  const submit = useMutation({
    mutationFn: async (): Promise<"signed-in" | "link-sent" | "changed"> => {
      if (mode === "forgot") {
        await account.requestPasswordReset(email);
        return "link-sent";
      }
      if (mode === "reset") {
        if (password !== confirm) throw new Error("The two passwords are not the same.");
        await account.resetPassword(password, reset?.token ?? "").catch((e: Error) => {
          throw new Error(/token/i.test(e.message) ? "That link has expired or was already used. Ask for a new one." : e.message);
        });
        return "changed";
      }
      if (mode === "sign-in") await account.signIn(email, password);
      else {
        await account.signUp(name, email, password);
        // If this fails the gate asks again after sign-in; the account exists either way.
        await account.consent(currentDocuments()).catch(() => undefined);
      }
      return "signed-in";
    },
    onSuccess: (done) => {
      if (done === "link-sent")
        return setNotice(
          `If there is an account for that address, a link to choose a new password is on its way. It works for an hour.${invited && peek.data && email.trim().toLowerCase() === peek.data.email.toLowerCase() ? ` If you never made an account for ${peek.data.email}, no email will come: choose "Make an account" instead.` : ""}`,
        );
      if (done === "changed") {
        clearResetUrl();
        setPassword("");
        setConfirm("");
        setModeState("sign-in");
        return setNotice("Your password is changed, and you are signed out everywhere else. Sign in with the new one.");
      }
      void qc.resetQueries();
    },
    onError: (e) => {
      // Making an account for an address that already has one: sign in with it instead, keeping what was typed.
      if (mode === "sign-up" && /already exists/i.test(e.message)) {
        setModeState("sign-in");
        setNotice(`There is already an account for ${email}. Sign in with its password${invited ? " to join the office" : ""}, or choose "Forgotten your password?".`);
        submit.reset();
      }
      // Signing in with the invited address before an account was made for it: point to making one.
      else if (mode === "sign-in" && invited && peek.data && email.trim().toLowerCase() === peek.data.email.toLowerCase())
        setNotice(`If you have not made an account for ${peek.data.email} yet, choose "Make an account": the invitation to ${peek.data.officeName} is waiting for it.`);
    },
  });
  const setMode = (m: Mode) => {
    if (mode === "reset") clearResetUrl();
    submit.reset();
    if (!peek.isError) setNotice(null);
    setModeState(m);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    submit.mutate();
  };

  const expired = mode === "reset" && Boolean(reset?.expired);
  const heading =
    mode === "forgot"
      ? "Forgotten password"
      : mode === "reset"
        ? "Choose a new password"
        : staff
          ? "Platform console"
          : invited && peek.data
            ? `Join ${peek.data.officeName}`
            : mode === "sign-in"
              ? "Sign in"
              : invited
                ? "Join the office"
                : "Make an account";
  const lede =
    mode === "forgot"
      ? "Give the email address you sign in with. We will send a link to choose a new password."
      : mode === "reset"
        ? expired
          ? "That link has expired or was already used. Links work for an hour, once."
          : "At least 10 characters. Once it is changed, you are signed out everywhere else."
        : staff
          ? `For the people who run ${BRAND.name}: every business on the platform, onboarding and suspending. Sign in with your work account; businesses sign in at ${staff.appAddress}.`
          : invited
            ? peek.data
              ? `You were invited to ${peek.data.officeName} as ${peek.data.role === "owner" ? "an owner" : "its accountant"}, at ${peek.data.email}. Make an account with that address, or sign in if you already have one.`
              : "You were invited to an office. Sign in, or make an account with the address the invitation went to."
            : mode === "sign-in"
              ? "Welcome back."
              : "Then open your office, or join one from an invitation link. Each business's books are seen only by the people in it.";
  const action = mode === "forgot" ? "Send the link" : mode === "reset" ? "Change the password" : mode === "sign-in" ? "Sign in" : "Make the account";

  return (
    <main className="signin" id="main">
      <div className="signin-door">
        <BrandPlate />
        <h1>{heading}</h1>
        <p className="muted">{lede}</p>
        {notice ? (
          <p className="signin-notice" role="status">
            {notice}
          </p>
        ) : null}
        {expired ? (
          <button type="button" className="btn btn-primary" onClick={() => setMode("forgot")}>
            Ask for a new link
          </button>
        ) : (
          <form onSubmit={onSubmit} className="signin-form">
            {mode === "sign-up" ? (
              <div className="field">
                <label htmlFor="name">Your name</label>
                <input id="name" className="input" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            ) : null}
            {mode !== "reset" ? (
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            ) : null}
            {mode !== "forgot" ? (
              <div className="field">
                <label htmlFor="password">{mode === "reset" ? "New password" : "Password"}</label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  required
                  minLength={mode === "sign-in" ? undefined : 10}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === "sign-up" ? <span className="muted">At least 10 characters.</span> : null}
                {mode === "sign-in" ? (
                  <button type="button" className="link-button signin-forgot" onClick={() => setMode("forgot")}>
                    Forgotten your password?
                  </button>
                ) : null}
              </div>
            ) : null}
            {mode === "reset" ? (
              <div className="field">
                <label htmlFor="confirm">The new password again</label>
                <input id="confirm" className="input" type="password" autoComplete="new-password" required minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
            ) : null}
            {mode === "sign-up" ? (
              <label className="check">
                <input type="checkbox" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                <span>
                  I accept the{" "}
                  <a href="/legal/terms" target="_blank" rel="noreferrer">
                    terms of service
                  </a>{" "}
                  and I have read the{" "}
                  <a href="/legal/privacy" target="_blank" rel="noreferrer">
                    privacy notice
                  </a>
                  .
                </span>
              </label>
            ) : null}
            {submit.error ? (
              <p className="form-error" role="alert">
                {submit.error.message}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={submit.isPending}>
              {submit.isPending ? "One moment" : action}
            </button>
          </form>
        )}
        <p className="signin-switch">
          {mode === "forgot" || mode === "reset" ? (
            <>
              Remembered it?{" "}
              <button type="button" className="link-button" onClick={() => setMode("sign-in")}>
                Sign in
              </button>
            </>
          ) : staff ? (
            <>
              No account yet? Make one at <a href={staff.appHref}>{staff.appAddress}</a> with the address on the platform owners' list, then come back.
            </>
          ) : mode === "sign-in" ? (
            <>
              New here?{" "}
              <button type="button" className="link-button" onClick={() => setMode("sign-up")}>
                Make an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button" className="link-button" onClick={() => setMode("sign-in")}>
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
      <LegalFooter />
    </main>
  );
}
