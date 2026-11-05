import { AGEING_BUCKETS } from "@office/contracts";
import { Amount } from "./Figure";

/**
 * The five ageing buckets as one ruled strip: width is share of what is owed,
 * ink deepens as money gets older. Every amount opens its invoices.
 */
export function AgeingBuckets({ totals, figurePrefix = "ageing:bucket:" }: { totals: number[]; figurePrefix?: string }) {
  const sum = totals.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="ageing">
      <div className="ageing-strip" aria-hidden="true">
        {totals.map((t, i) => (t > 0 ? <span key={i} className={`ageing-band ageing-band-${i}`} style={{ flexGrow: t / sum }} /> : null))}
      </div>
      <dl className="ageing-buckets">
        {AGEING_BUCKETS.map((label, i) => (
          <div key={label} className={`ageing-bucket ageing-bucket-${i}`}>
            <dt>
              <span className={`ageing-key ageing-band-${i}`} aria-hidden="true" />
              {label}
            </dt>
            <dd>
              <Amount paise={totals[i] ?? 0} figureId={`${figurePrefix}${i}`} short tone={i >= 3 && (totals[i] ?? 0) > 0 ? "red" : undefined} label={label} />
              <span className="ageing-share num">{Math.round(((totals[i] ?? 0) / sum) * 100)}%</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
