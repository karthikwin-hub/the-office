import * as Plot from "@observablehq/plot";
import { useEffect, useRef } from "react";

/** Plot needs literal colours; these mirror the tokens in packages/ui/src/tokens.css. */
export const INK = { carbon: "#27408b", graphite: "#2a2d31", planLine: "#b4bcc6", red: "#b42318" };

/** Observable Plot drawn in the office's ink: graphite axes, carbon marks, no gridlines unless asked. */
export function Chart({ options, label }: { options: Plot.PlotOptions; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.clientWidth || 640;
    const chart = Plot.plot({
      width,
      height: 220,
      marginLeft: 56,
      style: { fontFamily: "var(--font)", fontSize: "12.8px", color: INK.graphite, background: "transparent", overflow: "visible" },
      ...options,
    });
    el.replaceChildren(chart);
    return () => chart.remove();
  }, [options]);
  return <div ref={ref} className="chart" role="img" aria-label={label} />;
}
