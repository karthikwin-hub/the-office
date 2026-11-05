import type { TraceRow } from "@office/contracts";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { PdfPage, SourceViewer } from "../SourceViewer";
import { office, sampleTrace } from "./data";

const meta: Meta = { title: "Proof/SourceViewer", parameters: { layout: "fullscreen" } };
export default meta;

const firstDoc = sampleTrace.rows.find((r) => r.docId)!;

function TraceDemo({ startWithDoc }: { startWithDoc: boolean }) {
  const [row, setRow] = useState<TraceRow | null>(startWithDoc ? firstDoc : null);
  const [region, setRegion] = useState<string | null>(row?.region ?? null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)} style={{ margin: 24 }}>
        Open source viewer
      </button>
      <SourceViewer
        open={open}
        onClose={() => setOpen(false)}
        trace={sampleTrace}
        doc={row?.docId ? office.documentView(row.docId) : null}
        region={region}
        selectedRow={row ? sampleTrace.rows.indexOf(row) : undefined}
        onSelectRow={(r) => (setRow(r), setRegion(r.region))}
        onRegion={setRegion}
        asOf={office.asOf}
      />
    </>
  );
}

export const FigureWithRecords: StoryObj = { render: () => <TraceDemo startWithDoc /> };
export const ChooseARecord: StoryObj = { render: () => <TraceDemo startWithDoc={false} /> };
export const SingleDocument: StoryObj = {
  render: () => <SourceViewer open onClose={() => {}} doc={office.documentView("doc-p0086")} region="totals.total" asOf={office.asOf} />,
};
export const Loading: StoryObj = { render: () => <SourceViewer open onClose={() => {}} traceLoading docLoading /> };
export const PageOnly: StoryObj = {
  render: () => {
    const d = office.documentView("doc-s0001").document;
    return (
      <div style={{ maxWidth: 700, padding: 24 }}>
        <PdfPage url={d.file} regions={d.regions} highlight={d.regions.find((r) => r.key === "totals.total")} />
      </div>
    );
  },
};
