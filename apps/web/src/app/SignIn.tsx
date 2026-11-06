import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { BRAND } from "@office/contracts";
import { account } from "../api/client";
import { BrandPlate, currentDocuments, LegalFooter } from "./Legal";

type Mode = "sign-in" | "sign-up";

/**
 * The front door. Anyone can make an account; an account on its own sees nothing.
 * It opens an office of its own, or joins one from an invitation link.
 */
export function SignIn({ invited, staff }: { invited: boolean; staff?: { appAddress: string; appHref: string } }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(invited ? "sign-up" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "sign-in") return account.signIn(email, password);
      await account.signUp(name, email, password);
      // If this fails the gate asks again after sign-in; the account exists either way.
      await account.consent(currentDocuments()).catch(() => undefined);
    },
    onSuccess: () => qc.resetQueries(),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const heading = staff ? "Platform console" : mode === "sign-in" ? "Sign in" : invited ? "Join the office" : "Make an account";
  const lede = staff
    ? `For the people who run ${BRAND.name}: every business on the platform, onboarding and suspending. Sign in with your work account; businesses sign in at ${staff.appAddress}.`
    : invited
    ? "You were invited to an office. Sign in, or make an account with the address the invitation went to."
    : mode === "sign-in"
      ? "Welcome back."
      : "Then open your office, or join one from an invitation link. Each business's books are seen only by the people in it.";

  return (
    <main className="signin" id="main">
      <div className="signin-door">
        <BrandPlate />
        <h1>{heading}</h1>
        <p className="muted">{lede}</p>
        <form onSubmit={onSubmit} className="signin-form">
          {mode === "sign-up" ? (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" className="input" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
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
          </div>
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
            {submit.isPending ? "One moment" : mode === "sign-in" ? "Sign in" : "Make the account"}
          </button>
        </form>
        <p className="signin-switch">
          {staff ? (
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
