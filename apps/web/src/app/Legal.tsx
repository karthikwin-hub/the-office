import { BRAND, LEGAL_DOCUMENTS, LEGAL_PAGES, type LegalPage, type Me } from "@office/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import pages from "virtual:legal";
import { account } from "../api/client";

const TITLES: Record<LegalPage, string> = {
  terms: "Terms of service",
  privacy: "Privacy notice",
  subprocessors: "Subprocessors",
  "data-processing": "Data processing terms",
  "ai-notice": "Telling customers about the AI assistant",
};

/** Public: anyone can read these without an account, from the sign-in page or a link. */
export function LegalScreen() {
  const { page } = useParams({ from: "/legal/$page" });
  const known = (LEGAL_PAGES as readonly string[]).includes(page);
  return (
    <main className="legal" id="main">
      <BrandPlate home />
      {known ? <article dangerouslySetInnerHTML={{ __html: pages[page as LegalPage] }} /> : <h1>There is no page here</h1>}
      <LegalFooter />
    </main>
  );
}

/** The name on the door of every page outside an office. */
export function BrandPlate({ home = false }: { home?: boolean }) {
  const name = (
    <>
      {BRAND.name} <span className="signin-plate-by">by {BRAND.maker}</span>
    </>
  );
  return <p className="signin-plate">{home ? <a href="/">{name}</a> : name}</p>;
}

export function LegalFooter() {
  return (
    <nav className="footer-legal" aria-label="Legal">
      {LEGAL_PAGES.map((p) => (
        <a key={p} href={`/legal/${p}`}>
          {TITLES[p]}
        </a>
      ))}
    </nav>
  );
}

export const currentDocuments = () => (Object.keys(LEGAL_DOCUMENTS) as (keyof typeof LEGAL_DOCUMENTS)[]).map((document) => ({ document, version: LEGAL_DOCUMENTS[document].version }));

/** Shown once after sign-up, and again whenever the terms or the privacy notice get a new version. */
export function ConsentGate({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [agreed, setAgreed] = useState(false);
  const accept = useMutation({ mutationFn: () => account.consent(me.consentNeeded), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) });
  const changed = me.consentNeeded.map((c) => LEGAL_DOCUMENTS[c.document]);
  return (
    <main className="signin" id="main">
      <div className="signin-door consent-gate">
        <BrandPlate />
        <h1>{me.offices.length ? "We have updated our terms" : "Before you start"}</h1>
        <p className="muted">
          Please read {changed.map((d, i) => (
            <span key={d.path}>
              {i ? " and " : ""}
              <a href={d.path} target="_blank" rel="noreferrer">
                the {d.title.toLowerCase()}
              </a>
            </span>
          ))}
          . They say what {BRAND.name} does with your data and your business's, and what you agree to.
        </p>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I accept the terms of service and I have read the privacy notice.</span>
        </label>
        <button type="button" className="btn btn-primary" disabled={!agreed || accept.isPending} onClick={() => accept.mutate()}>
          Continue
        </button>
        {accept.error ? (
          <p className="form-error" role="alert">
            {accept.error.message}
          </p>
        ) : null}
        <LegalFooter />
      </div>
    </main>
  );
}
