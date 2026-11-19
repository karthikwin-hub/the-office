import { BRAND, type Me } from "@office/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { account, isLive, twoFactor } from "../api/client";
import { q } from "../api/queries";
import { Section } from "../screens/common";
import { BrandPlate, LegalFooter } from "./Legal";

/** The otpauth:// address as a QR code, drawn here: the secret never leaves the page for a QR service. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((dark, x) => (dark ? (d += `M${x} ${y}h1v1h-1z`) : null)));
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} width={200} height={200} shapeRendering="crispEdges" style={{ background: "#fff", display: "block" }}>
      <path d={path} fill="#000" />
    </svg>
  );
}

const secretOf = (uri: string) => new URL(uri).searchParams.get("secret") ?? "";

/**
 * Turning two-step sign-in on: the password, then the app scans the code, then one code from the app
 * confirms it. Nothing changes for the account until that last step.
 */
export function TwoFactorSetup({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [started, setStarted] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const start = useMutation({ mutationFn: () => twoFactor.enable(password), onSuccess: (r) => (setStarted(r), setPassword("")) });
  const confirm = useMutation({
    mutationFn: () => twoFactor.confirm(code),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      onDone?.();
    },
  });
  const begin = (e: FormEvent) => (e.preventDefault(), start.mutate());
  const finish = (e: FormEvent) => (e.preventDefault(), confirm.mutate());

  if (!started)
    return (
      <form onSubmit={begin} className="signin-form">
        <div className="field">
          <label htmlFor="tf-password">Your password</label>
          <input id="tf-password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {start.error ? (
          <p className="form-error" role="alert">
            {/password/i.test(start.error.message) ? "That password is not right." : start.error.message}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={start.isPending}>
          {start.isPending ? "One moment" : "Set up two-step sign-in"}
        </button>
      </form>
    );

  return (
    <form onSubmit={finish} className="signin-form">
      <p>1. In an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and the like), add an account by scanning this code.</p>
      <QrCode text={started.totpURI} label={`QR code to add ${BRAND.name} to an authenticator app`} />
      <p className="muted">
        Can't scan it? Type this key into the app instead: <code style={{ wordBreak: "break-all" }}>{secretOf(started.totpURI)}</code>
      </p>
      <p>2. Keep these backup codes somewhere safe, away from your phone. Each one signs you in once if you lose the phone.</p>
      <ul aria-label="Backup codes" style={{ fontFamily: "monospace", columns: 2, listStyle: "none", paddingLeft: 0 }}>
        {started.backupCodes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="field">
        <label htmlFor="tf-code">3. The six-digit code the app shows now</label>
        <input id="tf-code" className="input" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]{6,7}" required value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      {confirm.error ? (
        <p className="form-error" role="alert">
          That code is not right. Check the time on your phone, then try the newest code.
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={confirm.isPending}>
        {confirm.isPending ? "One moment" : "Turn on two-step sign-in"}
      </button>
    </form>
  );
}

/** Owners and platform owners turn two-step sign-in on before anything of an office, or the console, opens. */
export function TwoFactorGate({ me }: { me: Me }) {
  const out = useMutation({ mutationFn: account.signOut, onSettled: () => location.assign("/") });
  return (
    <main className="signin" id="main">
      <div className="signin-door">
        <BrandPlate />
        <h1>Turn on two-step sign-in</h1>
        <p className="muted">
          You own a business on {BRAND.name}, so signing in as {me.user.email} needs a code from your phone as well as your password. It takes a minute, once.
        </p>
        <TwoFactorSetup />
        <p className="signin-switch">
          <button type="button" className="link-button" onClick={() => out.mutate()} disabled={out.isPending}>
            Sign out
          </button>
        </p>
      </div>
      <LegalFooter />
    </main>
  );
}

/** In Settings, for everyone: whether two-step sign-in is on, new backup codes, and turning it off when it is not required. */
export function TwoFactorSettings() {
  const qc = useQueryClient();
  const me = useQuery({ ...q.me(), enabled: isLive });
  const [action, setAction] = useState<"codes" | "off" | null>(null);
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const run = useMutation({
    mutationFn: async () => {
      if (action === "codes") setCodes((await twoFactor.newBackupCodes(password)).backupCodes);
      else await twoFactor.disable(password);
    },
    onSuccess: async () => {
      setPassword("");
      if (action === "off") await qc.invalidateQueries({ queryKey: ["me"] });
      setAction(null);
    },
  });
  if (!isLive || !me.data) return null;
  const { enabled, required } = me.data.twoFactor;
  const submit = (e: FormEvent) => (e.preventDefault(), run.mutate());
  return (
    <Section title="Two-step sign-in">
      <p className="section-lede">
        {enabled
          ? "On. Signing in asks for a code from your authenticator app after your password."
          : required
            ? "Owners must have it on."
            : "Off. Turn it on to ask for a code from your phone after your password, so a leaked password alone does not open the books."}
      </p>
      {!enabled ? <TwoFactorSetup /> : null}
      {enabled && !action ? (
        <div className="approval-actions">
          <button type="button" className="btn" onClick={() => (setAction("codes"), setCodes(null))}>
            New backup codes
          </button>
          {required ? null : (
            <button type="button" className="btn btn-quiet" onClick={() => setAction("off")}>
              Turn it off
            </button>
          )}
        </div>
      ) : null}
      {enabled && required ? <p className="muted">As an owner you cannot turn it off. If you lose your phone, sign in with a backup code and set it up again.</p> : null}
      {action ? (
        <form onSubmit={submit} className="signin-form">
          <div className="field">
            <label htmlFor="tf-confirm">{action === "codes" ? "Your password, to make new backup codes (the old ones stop working)" : "Your password, to turn two-step sign-in off"}</label>
            <input id="tf-confirm" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {run.error ? (
            <p className="form-error" role="alert">
              {/password/i.test(run.error.message) ? "That password is not right." : /fresh|session/i.test(run.error.message) ? "Sign out and in again, then try once more." : run.error.message}
            </p>
          ) : null}
          <div className="approval-actions">
            <button type="submit" className="btn btn-primary" disabled={run.isPending}>
              {action === "codes" ? "Make new codes" : "Turn it off"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => (setAction(null), run.reset())}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {codes ? (
        <>
          <p role="status">Your new backup codes. Keep them somewhere safe; each works once.</p>
          <ul aria-label="Backup codes" style={{ fontFamily: "monospace", columns: 2, listStyle: "none", paddingLeft: 0 }}>
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}
