import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { account } from "../api/client";

type Mode = "sign-in" | "join" | "open";

/**
 * The front door. The first person in opens the office and becomes its owner;
 * after that, only people the owner has invited can join.
 */
export function SignIn() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["auth-status"], queryFn: account.status, retry: false });
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (status.data && !status.data.hasOwner ? "open" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = useMutation({
    mutationFn: () => (mode === "sign-in" ? account.signIn(email, password) : account.signUp(name, email, password)),
    onSuccess: () => qc.resetQueries(),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const heading = mode === "open" ? "Open your office" : mode === "join" ? "Join the office" : "Sign in";
  const lede =
    mode === "open"
      ? "You are the first one in, so this account will own the office: it approves the team's work, hires and changes settings."
      : mode === "join"
        ? "Use the email address the owner invited. Accountants can read everything, download returns and answer the Auditor."
        : "Welcome back.";

  return (
    <main className="signin" id="main">
      <div className="signin-door">
        <p className="signin-plate">The Office</p>
        <h1>{heading}</h1>
        <p className="muted">{lede}</p>
        <form onSubmit={onSubmit} className="signin-form">
          {mode !== "sign-in" ? (
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
            {mode !== "sign-in" ? <span className="muted">At least 10 characters.</span> : null}
          </div>
          {submit.error ? (
            <p className="form-error" role="alert">
              {submit.error.message}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={submit.isPending}>
            {submit.isPending ? "One moment" : mode === "open" ? "Open the office" : mode === "join" ? "Join" : "Sign in"}
          </button>
        </form>
        {status.data?.hasOwner ? (
          <p className="signin-switch">
            {mode === "sign-in" ? (
              <>
                Invited by the owner?{" "}
                <button type="button" className="link-button" onClick={() => setChosen("join")}>
                  Join the office
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" className="link-button" onClick={() => setChosen("sign-in")}>
                  Sign in
                </button>
              </>
            )}
          </p>
        ) : null}
      </div>
    </main>
  );
}
