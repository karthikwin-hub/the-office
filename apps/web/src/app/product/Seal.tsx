import { BRAND } from "@office/contracts";
import { useId, useState } from "react";

export type SealVariant = "full" | "mark" | "approved";

type SealProps = {
  variant?: SealVariant;
  /** Shown in the approved seal's centre, as a dated stamp is. */
  date?: Date;
  /** Animate the press when it first appears; changing `pressKey` presses it again. */
  press?: boolean;
  pressKey?: number | string;
  className?: string;
  label?: string;
  /** Another business's seal: the ring's top and bottom lettering, and the dated word in its centre. */
  ring?: [string, string];
  word?: string;
  sign?: string;
};

const C = 100;
/** A point on the seal at a radius and an angle in degrees, 0 at three o'clock. */
const at = (r: number, deg: number) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)] as const;

function star(cx: number, cy: number, r: number) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.42 : r;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

const dayMonthYear = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }).toUpperCase();

/** The floor-plan glyph: four rooms, door gaps in the inner walls, and a tick drawn where the last door swings. */
function PlanGlyph({ side, stroke }: { side: number; stroke: number }) {
  const x = C - side / 2;
  const u = side / 22;
  const p = (v: number) => x + v * u;
  return (
    <g fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="square">
      <rect x={x} y={x} width={side} height={side} />
      <path d={`M${p(0)} ${p(11)}H${p(9)}M${p(13)} ${p(11)}H${p(22)}M${p(11)} ${p(0)}V${p(8)}M${p(11)} ${p(14)}V${p(22)}`} />
      <path d={`M${p(14.2)} ${p(16.4)}Q${p(15.4)} ${p(18.6)} ${p(16.9)} ${p(19.4)}L${p(20)} ${p(14)}`} strokeLinecap="round" strokeLinejoin="round" strokeWidth={stroke * 0.95} />
    </g>
  );
}

/**
 * The company seal every Indian bill carries, made the product's mark. The ink is seeded per visit,
 * so no two impressions match; the tilt is the hand that pressed it.
 */
export function Seal({ variant = "full", date, press = false, pressKey, className, label, ring = [BRAND.name, BRAND.maker], word = "Approved", sign = "Authorised signatory" }: SealProps) {
  const id = useId().replace(/:/g, "");
  const [hand] = useState(() => ({ seed: Math.floor(Math.random() * 997), tilt: Math.random() * 8 - 4 }));
  const presses = typeof pressKey === "number" ? pressKey : 0;
  const seed = hand.seed + presses * 53;
  const tilt = variant === "mark" ? 0 : Math.round((((hand.tilt + presses * 2.9 + 4) % 8) - 4) * 10) / 10;
  const top = `M${at(62, 180).join(" ")}A62 62 0 0 1 ${at(62, 0).join(" ")}`;
  const bottom = `M${at(75, 180).join(" ")}A75 75 0 0 0 ${at(75, 0).join(" ")}`;
  const name = label ?? (variant === "approved" ? `${word}${date ? `, ${dayMonthYear(date)}` : ""}` : `${BRAND.name} by ${BRAND.maker}`);
  const ringSize = (s: string, room: number) => Math.min(22, room / (s.length * 0.6));

  const art =
    variant === "mark" ? (
      <>
        <circle cx={C} cy={C} r={88} fill="none" stroke="currentColor" strokeWidth={14} />
        <PlanGlyph side={82} stroke={9} />
      </>
    ) : (
      <>
        <circle cx={C} cy={C} r={92} fill="none" stroke="currentColor" strokeWidth={6} />
        <circle cx={C} cy={C} r={83} fill="none" stroke="currentColor" strokeWidth={1.8} />
        <circle cx={C} cy={C} r={55} fill="none" stroke="currentColor" strokeWidth={1.8} />
        <text className="seal-ring-text" fill="currentColor" fontSize={ringSize(ring[0], 172)}>
          <textPath href={`#${id}-top`} startOffset="50%" textAnchor="middle">
            {ring[0].toUpperCase()}
          </textPath>
        </text>
        <text className="seal-ring-text" fill="currentColor" fontSize={ringSize(ring[1], 190)}>
          <textPath href={`#${id}-bottom`} startOffset="50%" textAnchor="middle">
            {ring[1].toUpperCase()}
          </textPath>
        </text>
        <path d={star(...at(69, 180), 6.5)} fill="currentColor" />
        <path d={star(...at(69, 0), 6.5)} fill="currentColor" />
        {variant === "approved" ? (
          <>
            <path d={`M${C - 53} 86H${C + 53}M${C - 53} 114H${C + 53}`} stroke="currentColor" strokeWidth={1.8} />
            <text x={C} y={108} textAnchor="middle" className="seal-approved" fill="currentColor">
              {word.toUpperCase()}
            </text>
            {date ? (
              <text x={C} y={78} textAnchor="middle" className="seal-date" fill="currentColor">
                {dayMonthYear(date)}
              </text>
            ) : null}
            <text x={C} y={130} textAnchor="middle" className="seal-sign" fill="currentColor">
              {sign}
            </text>
          </>
        ) : (
          <PlanGlyph side={50} stroke={3.4} />
        )}
      </>
    );

  return (
    <svg
      key={pressKey}
      viewBox="0 0 200 200"
      role="img"
      aria-label={name}
      className={`seal seal-${variant}${press ? " seal-press" : ""}${className ? ` ${className}` : ""}`}
      style={{ ["--tilt" as string]: `${tilt}deg` }}
    >
      <defs>
        <path id={`${id}-top`} d={top} />
        <path id={`${id}-bottom`} d={bottom} />
        <filter id={`${id}-ink`} x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={seed} result="grain" />
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  6 0 0 0 -1.4" result="holes" />
          <feTurbulence type="fractalNoise" baseFrequency="0.014" numOctaves="2" seed={seed + 31} result="pressure" />
          <feColorMatrix in="pressure" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.4 0 0 0 -0.05" result="even" />
          <feComposite in="SourceGraphic" in2="holes" operator="in" result="speckled" />
          <feComposite in="speckled" in2="even" operator="in" result="pressed" />
          <feTurbulence type="turbulence" baseFrequency="0.05" numOctaves="2" seed={seed + 7} result="warp" />
          <feDisplacementMap in="pressed" in2="warp" scale={variant === "mark" ? 1.5 : 2.6} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id={`${id}-bleed`} x="-8%" y="-8%" width="116%" height="116%">
          <feMorphology operator="dilate" radius="0.9" />
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
      </defs>
      <g className="seal-tilt">
        <g className="seal-bleed" filter={`url(#${id}-bleed)`}>
          {art}
        </g>
        <g filter={`url(#${id}-ink)`}>{art}</g>
      </g>
    </svg>
  );
}
