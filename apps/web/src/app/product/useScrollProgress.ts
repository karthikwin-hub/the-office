import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const query = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * How far the page has scrolled through a tall section whose stage sticks to the viewport, from 0 when its top
 * meets the top of the viewport to 1 when its bottom meets the bottom. `onFrame` runs at most once per frame and
 * should write styles directly; React only re-renders when the whole-number `step` changes.
 */
export function useScrollProgress(ref: RefObject<HTMLElement | null>, steps: number, onFrame?: (p: number) => void, enabled = true) {
  const [step, setStep] = useState(0);
  const frame = useRef(onFrame);
  useLayoutEffect(() => {
    frame.current = onFrame;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      const p = travel > 0 ? Math.min(1, Math.max(0, -r.top / travel)) : 0;
      el.style.setProperty("--p", p.toFixed(4));
      frame.current?.(p);
      setStep(Math.min(steps - 1, Math.floor(p * steps)));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ref, steps, enabled]);
  return step;
}
