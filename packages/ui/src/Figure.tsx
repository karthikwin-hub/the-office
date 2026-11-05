import type { Note } from "@office/contracts";
import { inr, inrShort } from "@office/engine";
import { createContext, useContext, type ReactNode } from "react";

/** Opens the source viewer for a figure id. Provided once by the app shell. */
export const FigureContext = createContext<{ open: (figureId: string) => void; openDocument: (docId: string, region?: string | null) => void }>({
  open: () => {},
  openDocument: () => {},
});

export const useFigures = () => useContext(FigureContext);

type FigureProps = { figureId?: string; tone?: "red" | "green"; children: ReactNode; label?: string };

/** Any number that can be traced to paper. Renders as a link-button when it has a figure id. */
export function Figure({ figureId, tone, children, label }: FigureProps) {
  const { open } = useFigures();
  const cls = `figure${tone ? ` figure-${tone}` : ""}`;
  if (!figureId) return <span className={cls}>{children}</span>;
  return (
    <button type="button" className={`${cls} figure-link`} onClick={() => open(figureId)} aria-label={label ? `${label}: show where this comes from` : undefined}>
      {children}
    </button>
  );
}

type AmountProps = { paise: number; figureId?: string; tone?: "red" | "green"; short?: boolean; rupees?: boolean; label?: string };

/** Money in Indian grouping. `short` gives lakh and crore for prose. */
export function Amount({ paise, figureId, tone, short, rupees, label }: AmountProps) {
  return (
    <Figure figureId={figureId} tone={tone} label={label}>
      <span className="num">{short ? inrShort(paise) : inr(paise, { rupees })}</span>
    </Figure>
  );
}

/** A covering note: prose whose figures are links to their proof. */
export function CoveringNote({ note, title = "Covering note", from }: { note: Note; title?: string; from?: string }) {
  return (
    <section className="covering-note" aria-label={title}>
      {from ? <p className="covering-note-from">{from}</p> : null}
      <p className="covering-note-body">
        {note.map((s, i) =>
          "figureId" in s ? (
            <Figure key={i} figureId={s.figureId} tone={s.tone}>
              {s.text}
            </Figure>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </p>
    </section>
  );
}

export type StampKind = "overdue" | "mismatch" | "paid" | "matched";
const STAMP_TEXT: Record<StampKind, string> = { overdue: "Overdue", mismatch: "Mismatch", paid: "Paid", matched: "Matched" };

/** The only four stamps in the system. */
export function Stamp({ kind }: { kind: StampKind }) {
  return <span className={`stamp ${kind === "overdue" || kind === "mismatch" ? "stamp-red" : "stamp-green"}`}>{STAMP_TEXT[kind]}</span>;
}
