import type { TrustLevel as Level } from "@office/contracts";
import { TRUST_LEVELS } from "@office/contracts";
import { useId } from "react";

/**
 * How much an agent may do without asking. Shown as a three-step scale,
 * because trust is earned in order.
 */
export function TrustLevel({ level, onChange, disabled, compact }: { level: Level; onChange?: (l: Level) => void; disabled?: boolean; compact?: boolean }) {
  const name = useId();
  const current = TRUST_LEVELS.findIndex((t) => t.id === level);
  if (compact || !onChange) {
    const t = TRUST_LEVELS[current]!;
    return (
      <span className="trust-compact" title={t.meaning}>
        <span className="trust-steps" aria-hidden="true">
          {TRUST_LEVELS.map((x, i) => (
            <span key={x.id} className={i <= current ? "on" : undefined} />
          ))}
        </span>
        {t.name}
      </span>
    );
  }
  return (
    <fieldset className="trust" disabled={disabled}>
      <legend>Trust level</legend>
      <div className="trust-options">
        {TRUST_LEVELS.map((t, i) => (
          <label key={t.id} className={`trust-option${t.id === level ? " is-current" : ""}${i < current ? " is-past" : ""}`}>
            <input type="radio" name={name} value={t.id} checked={t.id === level} onChange={() => onChange(t.id)} />
            <span className="trust-label">{t.name}</span>
            <span className="trust-desc">{t.meaning}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
