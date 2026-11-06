import type { DocumentView, Region, Trace, TraceRow } from "@office/contracts";
import { inr } from "@office/engine";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Stamp } from "./Figure";

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;
/** pdf.js and its worker, loaded on first use. */
export function loadPdfJs() {
  pdfjsPromise ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjsPromise;
}

/** One page of a PDF drawn to canvas, with the regions of interest boxed on top. */
export function PdfPage({ url, page = 1, highlight, regions = [], onRegion }: { url: string; page?: number; highlight?: Region | null; regions?: Region[]; onRegion?: (key: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    setState("loading");
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument(url).promise;
        const p = await doc.getPage(page);
        if (cancelled || !canvas.current) return;
        const base = p.getViewport({ scale: 1 });
        const width = canvas.current.parentElement!.clientWidth || 640;
        const scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2);
        const vp = p.getViewport({ scale });
        canvas.current.width = vp.width;
        canvas.current.height = vp.height;
        setRatio(vp.height / vp.width);
        const render = p.render({ canvasContext: canvas.current.getContext("2d")!, viewport: vp });
        task = render;
        await render.promise;
        if (!cancelled) setState("ready");
      } catch (e) {
        if (!cancelled && (e as { name?: string }).name !== "RenderingCancelledException") setState("error");
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [url, page]);

  useEffect(() => {
    if (state === "ready" && highlight) box.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [state, highlight]);

  const pos = (r: Region) => ({ left: `${r.box[0] * 100}%`, top: `${r.box[1] * 100}%`, width: `${r.box[2] * 100}%`, height: `${r.box[3] * 100}%` });

  return (
    <div className="pdf-page" style={{ aspectRatio: `1 / ${ratio}` }}>
      <canvas ref={canvas} aria-label="Scanned page" role="img" />
      {state === "loading" ? <p className="pdf-status">Opening the page</p> : null}
      {state === "error" ? <p className="pdf-status">This page could not be opened. Download the file to check it.</p> : null}
      {state === "ready"
        ? regions
            .filter((r) => r.page === page)
            .map((r) => (
              <button
                key={r.key}
                type="button"
                className={`pdf-region${highlight?.key === r.key ? " is-highlight" : ""}`}
                style={pos(r)}
                onClick={() => onRegion?.(r.key)}
                aria-label={r.label}
                tabIndex={-1}
                ref={highlight?.key === r.key ? (el) => void ((box as { current: HTMLElement | null }).current = el) : undefined}
              />
            ))
        : null}
    </div>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  trace?: Trace | null;
  traceLoading?: boolean;
  doc?: DocumentView | null;
  docLoading?: boolean;
  region?: string | null;
  onSelectRow?: (row: TraceRow) => void;
  onRegion?: (key: string) => void;
  selectedRow?: number;
  /** Rendered under the document details, e.g. a link to the customer. */
  docActions?: ReactNode;
  /** The books' date, for marking invoices overdue. */
  asOf?: string;
};

/**
 * The proof behind any figure: the rows that make it up on the left, the page
 * they were read from on the right, with the exact region boxed.
 */
export function SourceViewer({ open, onClose, trace, traceLoading, doc, docLoading, region, onSelectRow, onRegion, selectedRow, docActions, asOf }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const highlight = doc && region ? (doc.document.regions.find((r) => r.key === region) ?? null) : null;
  const inv = doc?.invoice;
  const bill = doc?.bill;
  const number = inv?.number ?? bill?.number;

  return (
    <dialog ref={dialog} className="source-viewer" onClose={onClose} onCancel={onClose} aria-label="Where this figure comes from">
      <div className="source-viewer-head">
        <h2>{trace ? trace.title : number ? `${inv ? "Invoice" : "Bill"} ${number}` : "Source document"}</h2>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <div className={`source-viewer-body${trace ? " has-trace" : ""}`}>
        {trace || traceLoading ? (
          <section className="source-trace" aria-label="What makes up this figure">
            {traceLoading || !trace ? (
              <p className="muted">Finding the records</p>
            ) : (
              <>
                <p className="source-trace-total">
                  <span>
                    {trace.rows.length} record{trace.rows.length === 1 ? "" : "s"}
                  </span>
                  <span className="num">{inr(trace.totalPaise)}</span>
                </p>
                <ol className="source-trace-rows">
                  {trace.rows.map((r, i) => (
                    <li key={i}>
                      <button type="button" className={`source-trace-row${selectedRow === i ? " is-selected" : ""}`} onClick={() => onSelectRow?.(r)} disabled={!r.docId} aria-current={selectedRow === i ? "true" : undefined}>
                        <span className="source-trace-label">{r.label}</span>
                        <span className="num">{inr(r.amountPaise)}</span>
                        <span className="source-trace-detail muted">{r.detail}</span>
                        <span className="source-trace-date muted num">{new Date(r.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        ) : null}
        <section className="source-doc" aria-label="Source document">
          {docLoading ? (
            <p className="muted">Opening the document</p>
          ) : doc ? (
            <>
              <div className="source-doc-meta">
                <div>
                  <p className="source-doc-party">{doc.party?.name ?? doc.document.from ?? "Unknown sender"}</p>
                  <p className="muted">
                    {doc.document.channel === "email"
                      ? `Arrived by email from ${doc.document.from}`
                      : doc.document.channel === "generated"
                        ? "Issued from your billing"
                        : doc.document.channel === "import"
                          ? `Brought in from ${doc.document.from}`
                          : `Received by ${doc.document.channel}`}
                    {", "}
                    {new Date(doc.document.receivedAt).toLocaleString("en-IN", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false })}
                  </p>
                </div>
                <div className="source-doc-status">
                  {inv && doc.outstandingPaise === 0 ? <Stamp kind="paid" /> : null}
                  {inv && doc.outstandingPaise && asOf && inv.dueDate < asOf ? <Stamp kind="overdue" /> : null}
                  {inv && doc.outstandingPaise ? <span className="num">{inr(doc.outstandingPaise)} outstanding</span> : null}
                  {doc.document.status === "staged" ? <span className="muted">Waiting for approval</span> : null}
                </div>
              </div>
              {highlight ? (
                <p className="source-doc-region">
                  Boxed on the page: <strong>{highlight.label}</strong>
                </p>
              ) : null}
              {doc.document.channel === "import" ? (
                <>
                  <p className="source-doc-import">{(inv ?? bill)?.lines[0]?.description}</p>
                  <p className="muted">Brought forward from before the books started, so it counts towards what is owed but not towards GST returns or sales.</p>
                  {doc.document.file ? (
                    <p className="source-doc-foot">
                      <a href={doc.document.file} target="_blank" rel="noreferrer">
                        Open the file it came from
                      </a>
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <PdfPage url={doc.document.file} page={highlight?.page ?? 1} regions={doc.document.regions} highlight={highlight} onRegion={onRegion} />
                  <p className="source-doc-foot">
                    <a href={doc.document.file} target="_blank" rel="noreferrer">
                      Open the PDF
                    </a>
                  </p>
                </>
              )}
              {docActions}
            </>
          ) : trace ? (
            <p className="muted source-doc-empty">Choose a record to see the page it came from.</p>
          ) : null}
        </section>
      </div>
    </dialog>
  );
}
