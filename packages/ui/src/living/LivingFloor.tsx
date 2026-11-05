import { useEffect, useRef, useState } from "react";
import type { Door, PlacedRoom, Plan } from "../FloorPlan";
import { direct, type DirectorInputs, type Scene, seeded, type Spot, startState } from "./director";
import { personaFor } from "./personas";

type Pt = { x: number; y: number };
const WALK_SPEED = 45; // plan units a second: an unhurried walk

/** Where a seated person sits: the chair the floor plan already draws. */
function chair(room: PlacedRoom): Pt {
  const { x, y, w, h } = room.rect;
  if (room.agentId === "office-manager") return { x: x + w / 2, y: y + h - 92 - 14 };
  return { x: x + w - 34 - 12 + 17, y: y + h - 13 - 12 - 8 };
}
const doorMid = (d: Door): Pt => (d.orient === "h" ? { x: d.x + d.size / 2, y: d.y } : { x: d.x, y: d.y + d.size / 2 });
/** A step inside or outside a room's door; its leaf swings out into the corridor. */
const byDoor = (d: Door, inside: boolean, depth = 14): Pt => {
  const m = doorMid(d);
  const k = (inside ? -1 : 1) * d.into * depth;
  return d.orient === "h" ? { x: m.x, y: m.y + k } : { x: m.x + k, y: m.y };
};

function tea(plan: Plan): { table: Pt; spots: [Pt, Pt] } {
  const c = plan.corridor;
  if (plan.narrow) {
    const table = { x: c.x + c.w / 2, y: c.y + 30 };
    return { table, spots: [{ x: table.x, y: table.y - 13 }, { x: table.x, y: table.y + 13 }] };
  }
  const table = { x: c.x + 46, y: c.y + c.h / 2 };
  return { table, spots: [{ x: table.x - 14, y: table.y }, { x: table.x + 14, y: table.y }] };
}

type Where = { pt: Pt; room: PlacedRoom | null };

function locate(plan: Plan, agentId: string, spot: Spot, waiting: boolean): Where {
  const own = plan.rooms.find((r) => r.agentId === agentId)!;
  if (spot.kind === "coffee") return { pt: tea(plan).spots[spot.slot], room: null };
  if (spot.kind === "door") {
    const other = plan.rooms.find((r) => r.agentId === spot.agentId);
    return other ? { pt: byDoor(other.door, false), room: null } : { pt: chair(own), room: own };
  }
  return { pt: waiting ? atDoor(own) : chair(own), room: own };
}

/** Waiting for the owner: just inside the door, on the side away from the desk. */
function atDoor(room: PlacedRoom): Pt {
  const p = byDoor(room.door, true, 8);
  const { x, y, w, h } = room.rect;
  if (room.door.orient === "h") return { x: p.x + Math.sign(x + w / 2 - p.x || -1) * 26, y: p.y };
  return { x: p.x, y: p.y + Math.sign(y + h / 2 - p.y || -1) * 26 };
}

/** The way from one place to another: out of a room by its door, along the corridor, in by the other door. */
function route(plan: Plan, from: Where, to: Where): Pt[] {
  const pts: Pt[] = [from.pt];
  const out = from.room ? byDoor(from.room.door, false) : from.pt;
  const into = to.room ? byDoor(to.room.door, false) : to.pt;
  if (from.room && from.room === to.room) return [from.pt, to.pt];
  if (from.room) pts.push(byDoor(from.room.door, true), out);
  const c = plan.corridor;
  if (plan.narrow) {
    const mx = c.x + c.w / 2;
    pts.push({ x: mx, y: out.y }, { x: mx, y: into.y });
  } else {
    const my = c.y + c.h / 2;
    pts.push({ x: out.x, y: my }, { x: into.x, y: my });
  }
  if (to.room) pts.push(into, byDoor(to.room.door, true));
  pts.push(to.pt);
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}

const place = (p: Pt) => `translate(${p.x}px, ${p.y}px)`;
const length = (pts: Pt[]) => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);

function Person({ plan, agentId, spot, waiting, working, still }: { plan: Plan; agentId: string; spot: Spot; waiting: boolean; working: boolean; still: boolean }) {
  const ref = useRef<SVGGElement>(null);
  const here = useRef<{ where: Where; plan: Plan } | null>(null);
  const target = locate(plan, agentId, spot, waiting);
  const key = `${target.pt.x},${target.pt.y}`;
  const [first] = useState(() => place(target.pt));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = here.current;
    here.current = { where: target, plan };
    const from = prev?.plan === plan ? prev.where : null;
    if (!from || still) {
      el.style.transform = place(target.pt);
      return;
    }
    const pts = route(plan, from, target);
    const total = length(pts) || 1;
    let run = 0;
    const frames = pts.map((p, i) => {
      if (i) run += Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y);
      return { transform: place(p), offset: run / total };
    });
    const anim = el.animate(frames, { duration: (total / WALK_SPEED) * 1000, easing: "linear", fill: "forwards" });
    anim.onfinish = () => {
      el.style.transform = place(target.pt);
      anim.cancel();
    };
    return () => anim.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, plan, still]);
  return (
    <g ref={ref} className={`person${working ? " person-working" : ""}`} style={{ transform: first }}>
      <ellipse rx={9.5} ry={5.2} cy={2} className="person-shoulders" />
      <circle r={5.2} className="person-head" />
      {waiting ? <rect x={8} y={-7} width={8} height={10.5} rx={0.8} className="person-sheet" /> : null}
      {working ? <circle r={1.6} cx={0} cy={-10.5} className="person-typing" /> : null}
    </g>
  );
}

/** Sized in screen pixels, whatever the plan's scale, so the words stay readable. */
function Bubble({ plan, at, name, text, scale }: { plan: Plan; at: Pt; name: string; text: string; scale: number }) {
  const w = 220 / scale, h = 110 / scale;
  const x = Math.max(4, Math.min(plan.width - w - 4, at.x - w / 2));
  const above = at.y - h - 10 > 0;
  return (
    <foreignObject x={x} y={above ? at.y - h - 10 : at.y + 10} width={w} height={h} className="bubble-box">
      <div className={`bubble${above ? "" : " bubble-below"}`} style={{ fontSize: `${13 / scale}px` }}>
        <p>
          <strong>{name}</strong> {text}
        </p>
      </div>
    </foreignObject>
  );
}

export type LivingFloorProps = {
  plan: Plan;
  inputs: Omit<DirectorInputs, "reducedMotion">;
  seed?: number;
  /** Stand still whatever the system setting says; for stories and screenshots. */
  reducedMotion?: boolean;
};

/**
 * The team drawn on top of the floor plan. It reads the same office view as the
 * Floor and changes nothing; it is hidden from screen readers and takes no clicks.
 */
export function LivingFloor({ plan, inputs, seed, reducedMotion }: LivingFloorProps) {
  const [system, setStill] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const still = reducedMotion ?? system;
  const [now, setNow] = useState(() => Date.now());
  const [scenes, setScenes] = useState<Scene[]>([]);
  const director = useRef(startState());
  const [rng] = useState(() => seeded(seed ?? Date.now()));
  const latest = useRef(inputs);
  latest.current = inputs;
  const root = useRef<SVGGElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const svg = root.current?.ownerSVGElement;
    if (!svg) return;
    const measure = () => setScale(Math.max(0.3, svg.getBoundingClientRect().width / plan.width || 1));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [plan.width]);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setStill(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      const t = Date.now();
      const r = direct(director.current, { ...latest.current, reducedMotion: still }, t, rng);
      director.current = r.state;
      setScenes((old) => [...old.filter((s) => (s.kind === "say" ? s.until > t : true)), ...r.scenes].slice(-60));
      setNow(t);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [rng, still]);

  const drawn = new Set(plan.rooms.map((r) => r.agentId));
  const people = inputs.rooms.filter((r) => r.hired && drawn.has(r.agentId));
  const spotOf = (agentId: string): Spot => {
    const walks = scenes.filter((s): s is Extract<Scene, { kind: "walk" }> => s.kind === "walk" && s.agentId === agentId && s.at <= now);
    return walks.length ? walks[walks.length - 1]!.to : { kind: "home" };
  };
  const bubbles = new Map<string, Extract<Scene, { kind: "say" }>>();
  for (const s of scenes) if (s.kind === "say" && s.at <= now && s.until > now && drawn.has(s.agentId)) bubbles.set(s.agentId, s);
  const t = tea(plan);

  return (
    <g className="living-floor" ref={root}>
      <g className="tea-point">
        <circle cx={t.table.x} cy={t.table.y} r={7} />
        <rect x={t.table.x - 3} y={t.table.y - 3} width={6} height={6} rx={1} />
      </g>
      {people.map((r) => (
        <Person key={r.agentId} plan={plan} agentId={r.agentId} spot={spotOf(r.agentId)} waiting={r.waitingCount > 0} working={r.status === "working"} still={still} />
      ))}
      {[...bubbles.values()].map((s) => {
        const r = people.find((p) => p.agentId === s.agentId);
        if (!r) return null;
        const at = locate(plan, s.agentId, spotOf(s.agentId), r.waitingCount > 0).pt;
        return <Bubble key={s.id} plan={plan} at={at} name={personaFor(s.agentId, inputs.names).name} text={s.text} scale={scale} />;
      })}
    </g>
  );
}
