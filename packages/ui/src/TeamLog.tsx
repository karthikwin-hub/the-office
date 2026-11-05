import type { LogEntry } from "@office/contracts";
import { AGENT_BY_ID } from "@office/contracts";
import type { ReactNode } from "react";
import { useFigures } from "./Figure";

const who = (agentId: string) => (agentId === "you" ? "You" : (AGENT_BY_ID[agentId]?.short ?? agentId));

/** What the team did, newest first, in the words the agents used. */
export function TeamLog({ entries, title = "Team log", heading = true, empty = "Nothing has happened yet today.", showAgent = true, footer }: { entries: LogEntry[]; title?: string; heading?: boolean; empty?: string; showAgent?: boolean; footer?: ReactNode }) {
  const { openDocument } = useFigures();
  return (
    <section className="team-log" aria-label={title}>
      {heading ? <h2 className="team-log-title">{title}</h2> : null}
      {entries.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ol className="team-log-list">
          {entries.map((e) => (
            <li key={e.id} className={e.agentId === "you" ? "team-log-you" : undefined}>
              <time dateTime={e.at} className="num">
                {e.at.slice(11, 16)}
              </time>
              <div>
                {showAgent ? <span className="team-log-who">{who(e.agentId)}</span> : null}
                <span className="team-log-text">
                  {e.text}
                  {e.ref?.kind === "document" && e.ref.id ? (
                    <>
                      {" "}
                      <button type="button" className="btn-link" onClick={() => openDocument(e.ref!.id!, e.ref!.region)}>
                        Open document
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {footer}
    </section>
  );
}
