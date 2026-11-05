import { useId } from "react";
import { skinStyle, type Skin } from "./skins";

/** A thumbnail of the floor in one skin: reception, three rooms, the corridor and the texture. Purely decorative. */
export function SkinPreview({ skin }: { skin: Skin }) {
  const id = `skin-tex-${useId().replace(/:/g, "")}`;
  const rooms = [0, 1, 2];
  return (
    <span className="skin-preview" style={skinStyle(skin) as React.CSSProperties} data-skin={skin.id} aria-hidden="true">
      <svg viewBox="0 0 160 96" className="skin-preview-svg">
        <defs>
          <pattern id={id} width={skin.texture.size} height={skin.texture.size} patternUnits="userSpaceOnUse" patternTransform="scale(0.5)">
            <path d={skin.texture.d} className="floor-texture-line" fill="none" />
          </pattern>
        </defs>
        <rect width="160" height="96" className="skin-preview-paper" />
        <rect x="6" y="8" width="148" height="80" className="building-floor" />
        <rect x="6" y="8" width="148" height="80" fill={`url(#${id})`} className="floor-texture" style={{ opacity: Math.min(1, skin.tokens.textureOpacity * 10) }} />
        <rect x="6" y="8" width="34" height="80" className="room-wall room-idle" />
        {rooms.map((i) => (
          <g key={i}>
            <rect x={40 + i * 38} y="8" width="38" height="32" className={`room-wall ${i === 0 ? "room-working" : "room-idle"}`} />
            <rect x={56 + i * 38} y="24" width="16" height="8" className="furniture-desk" />
            <circle cx={64 + i * 38} cy="36" r="2.5" className="furniture-chair" />
          </g>
        ))}
        <rect x="40" y="58" width="57" height="30" className="room-wall room-idle" />
        <rect x="97" y="58" width="57" height="30" className="room-wall room-not_hired" />
        <rect x="6" y="8" width="148" height="80" className="building-wall" style={{ strokeWidth: 2 }} />
        <rect x="44" y="12" width="20" height="4" rx="1" className="skin-preview-ink" />
        <rect x="10" y="12" width="18" height="4" rx="1" className="skin-preview-ink" />
        <circle cx="74" cy="44" r="4" className="skin-preview-accent" />
      </svg>
    </span>
  );
}
