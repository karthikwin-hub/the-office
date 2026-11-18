/**
 * Whether this device should get the 3D Lived-in office, decided without loading it.
 * The 3D floor is skipped when the browser has no WebGL 2, when data saver is on, or on a
 * device that reports little memory; those see the drawn floor instead.
 */

type Nav = Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };

let cached: { ok: boolean; reason?: string } | null = null;

export function dioramaSupport(): { ok: boolean; reason?: string } {
  if (cached) return cached;
  if (typeof window === "undefined" || typeof document === "undefined") return { ok: false, reason: "no window" };
  const nav = navigator as Nav;
  if (nav.connection?.saveData) return (cached = { ok: false, reason: "data saver is on" });
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 4) return (cached = { ok: false, reason: "little memory" });
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return (cached = { ok: false, reason: "no WebGL 2" });
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    return (cached = { ok: false, reason: "no WebGL 2" });
  }
  return (cached = { ok: true });
}

/** The ledger, shut: drawn in HTML so it is on screen at once while the 3D office loads, then opens into it. */
export function ClosedLedger({ name, year, gone = false }: { name: string; year: string; gone?: boolean }) {
  return (
    <div className={`diorama-closed${gone ? " is-gone" : ""}`} aria-hidden="true">
      <b>{name}</b>
      <span>Khata {year}</span>
    </div>
  );
}

/** "2026–27": the financial year a moment falls in, by India's calendar. */
export function khataYear(t: number): string {
  const d = new Date(t + 330 * 60_000);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}–${String((y + 1) % 100).padStart(2, "0")}`;
}
