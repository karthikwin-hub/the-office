import type { Kpi, StagedChange } from "@office/contracts";
import { AGENT_BY_ID } from "@office/contracts";
import { useQuery } from "@tanstack/react-query";
import { q } from "../api/queries";
import { Figure } from "@office/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { viewingAs } from "../api/client";

/** Wraps a screen; `data-ready` tells screenshot runs that data has arrived. */
export function Page({ ready, error, children, wide }: { ready: boolean; error?: unknown; children: ReactNode; wide?: boolean }) {
  if (error) return <ErrorState error={error} />;
  return (
    <div className={`page${wide ? " page-wide" : ""}`} data-ready={ready ? "" : undefined} aria-busy={!ready}>
      {ready ? children : <p className="loading">Fetching the books</p>}
    </div>
  );
}

export function PageHead({ title, lede, aside, back }: { title: string; lede?: ReactNode; aside?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="page-head">
      <div>
        {back ? (
          <Link to={back.to} className="page-back">
            {back.label}
          </Link>
        ) : null}
        <h1>{title}</h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
      </div>
      {aside ? <div className="page-head-aside">{aside}</div> : null}
    </div>
  );
}

/** Key figures as one ruled line, the way a register is read across. */
export function Register({ items }: { items: Kpi[] }) {
  if (!items.length) return null;
  return (
    <dl className="register">
      {items.map((k) => (
        <div key={k.label}>
          <dt>{k.label}</dt>
          <dd>
            <Figure figureId={k.figureId} tone={k.tone} label={k.label}>
              {k.value}
            </Figure>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={id ?? title}>
      <div className="section-head">
        <h2 id={id ?? title}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const status = (error as { status?: number }).status;
  return (
    <div className="page" data-ready="">
      <h1>{status === 404 ? "Not found" : "The books could not be opened"}</h1>
      <p className="page-lede">
        {status === 404 ? "This page does not exist, or the record was removed." : `${(error as Error).message}. Reload the page; if it keeps happening, check that the office is running.`}
      </p>
      <p>
        <Link to="/">Back to the floor</Link>
      </p>
    </div>
  );
}

export function NotFound() {
  return <ErrorState error={{ status: 404, message: "Not found" }} />;
}

export const isOwner = () => viewingAs() === "owner";

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
export const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
export const time = (iso: string) => iso.slice(11, 16);
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

const UNITS: Record<string, [string, string]> = { NOS: ["", ""], PCS: ["piece", "pieces"], ROL: ["roll", "rolls"], BOX: ["box", "boxes"], PAC: ["pack", "packs"], MTR: ["m", "m"], SET: ["set", "sets"], KGS: ["kg", "kg"] };
/** Quantities with the GST unit code spelled out: "571 rolls", "2,600 m". */
export const quantity = (n: number, uqc: string) => {
  const u = UNITS[uqc.toUpperCase()];
  const word = u ? u[n === 1 ? 0 : 1] : uqc.toLowerCase();
  return `${n.toLocaleString("en-IN")}${word ? ` ${word}` : ""}`;
};

/** "the social media manager", for use mid-sentence. */
export const theAgent = (agentId: string) => (AGENT_BY_ID[agentId]?.title ?? agentId).replace(/^The /, "the ").toLowerCase();

/** Extra lines an approval needs to be judged, such as the message a reply answers. */
export function useApprovalContext() {
  const social = useQuery(q.social());
  return (i: StagedChange): Record<string, string> | undefined => {
    if (i.kind !== "social_reply") return undefined;
    const m = social.data?.inbox.find((x) => x.id === (i.payload as { messageId?: string }).messageId);
    return m ? { [`${m.author} wrote on ${m.platform}${m.rating ? `, ${m.rating} of 5` : ""}`]: m.text } : undefined;
  };
}
