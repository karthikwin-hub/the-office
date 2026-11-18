import "@fontsource/kalam/400.css";
import "@fontsource/kalam/700.css";
import { AGENT_BY_ID, type AmbientView, type OfficeView, type PersonaNames, type Sky, type Weather } from "@office/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Vector3 } from "three";
import { planFor } from "../../plan";
import { direct, type Scene, seeded, startState } from "../director";
import { personaFor } from "../personas";
import { ClosedLedger, khataYear } from "../support";
import { layoutFrom } from "./navigate";
import { PopupOffice } from "./scene";
import { clockText, istParts, phaseName, moonPhase, sunAt, sunTimes, whereIs, IST_MINUTES } from "./sky";
import { startTrail, trail, type TrailState } from "./trail";

export type DioramaTarget = { kind: "room"; id: string } | { kind: "desk" } | { kind: "hiring" };

export type DioramaProps = {
  view: OfficeView;
  names?: PersonaNames;
  ambient?: AmbientView | null;
  weather?: Weather | null;
  /** A room's name plate, as a link through the app's router. */
  renderLink: (agentId: string, className: string, children: ReactNode, label: string) => ReactNode;
  renderDeskLink: (className: string, children: ReactNode, label: string) => ReactNode;
  /** A click on the scene itself: glide in, then open what was clicked. */
  onOpen: (target: DioramaTarget) => void;
  /** The 3D office cannot run here, or not fast enough: show the drawn floor instead. */
  onFallback: (reason: string) => void;
  /** Picture only, for demos and screenshots: minutes after midnight in India, and a temperature. */
  at?: number | null;
  tempC?: number | null;
};

/**
 * What the floor last showed, kept for the whole visit: leave for the Desk, approve three bills,
 * come back, and the seal comes down three times. Reset when the office changes.
 */
const memory: { office: string; trail: TrailState; desk: number | null } = { office: "", trail: startTrail(), desk: null };
function remembered(office: string) {
  if (memory.office !== office) Object.assign(memory, { office, trail: startTrail(), desk: null });
  return memory;
}

const COVER: Record<Sky, number> = { clear: 0.05, cloudy: 0.5, rain: 0.8, storm: 0.92, fog: 0.7, snow: 0.8 };
const SKY_WORDS: Record<Sky, string> = { clear: "clear", cloudy: "cloudy", rain: "rain", storm: "thunderstorm", fog: "fog", snow: "snow" };
const IDLE_FRAME = 1000 / 30 - 2;
const SLOW = 40;

type Bubble = { id: number; agentId: string; text: string; until: number };

/**
 * The Lived-in office as a pop-up book: the 3D scene, with the room plates and speech
 * bubbles in HTML on top so they stay real links and real text. Draws at 30 frames a
 * second when only small things move, every frame while something moves fast, and not
 * at all when the tab is hidden or the floor is scrolled away.
 */
export function Diorama({ view, names = {}, ambient = null, weather = null, renderLink, renderDeskLink, onOpen, onFallback, at = null, tempC = null }: DioramaProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const office = useRef<PopupOffice | null>(null);
  const pins = useRef(new Map<string, HTMLDivElement>());
  const bubbleEls = useRef(new Map<string, HTMLDivElement>());
  const [ready, setReady] = useState(false);
  const [opened, setOpened] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [still] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const layout = useMemo(() => layoutFrom(planFor(view.rooms, { wholeFloor: true, layout: "wide" })), [view.rooms.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const where = whereIs(weather, view.business.stateCode || undefined);
  const live = useRef({ view, names, ambient, weather, at, tempC, onOpen, onFallback });
  live.current = { view, names, ambient, weather, at, tempC, onOpen, onFallback };

  /* The scene: built once, opened when its shaders are ready. */
  useEffect(() => {
    const c = canvas.current, box = wrap.current;
    if (!c || !box) return;
    const before = remembered(view.business.name);
    let o: PopupOffice;
    try {
      o = new PopupOffice(c, {
        layout,
        businessName: view.business.name || view.business.legalName || "Your office",
        city: weather?.city ?? null,
        where,
        hired: before.trail.started ? before.trail.hired : view.rooms.filter((r) => r.hired).map((r) => r.agentId),
        names,
        deskCount: before.desk ?? view.deskCount,
        reduced: still,
        lite: false,
      });
    } catch {
      live.current.onFallback("WebGL could not start");
      return;
    }
    office.current = o;
    const lost = (e: Event) => { e.preventDefault(); live.current.onFallback("the graphics context was lost"); };
    c.addEventListener("webglcontextlost", lost);
    const size = () => o.resize(box.clientWidth, box.clientHeight);
    size();
    const ro = new ResizeObserver(size);
    ro.observe(box);
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = Boolean(e?.isIntersecting)));
    io.observe(box);
    void document.fonts?.load(`700 40px Kalam`).then(() => o.redrawText(), () => undefined);

    // The director: what the team says and where it walks, from the same view the Floor shows.
    let dstate = startState();
    const rng = seeded(Date.now());
    let scenes: Scene[] = [];
    const directTick = () => {
      if (document.hidden) return;
      const v = live.current;
      const r = direct(dstate, { rooms: v.view.rooms, log: v.view.log, arriving: v.view.arriving, names: v.names, ambient: v.ambient, weather: v.weather, reducedMotion: still }, Date.now(), rng);
      dstate = r.state;
      scenes = [...scenes, ...r.scenes].slice(-80);
    };
    const director = window.setInterval(directTick, 1000);

    let raf = 0, last = performance.now(), lastDraw = 0, started = false, shown = false, probe: number[] = [], probing = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.hidden || !visible || !started) return;
      const v = live.current;
      const wall = Date.now();
      const sceneNow = v.at == null ? wall : istParts(wall).day + (v.at - IST_MINUTES) * 60_000;
      // play the director's scenes as their moment comes
      const due = scenes.filter((s) => s.at <= wall);
      if (due.length) {
        scenes = scenes.filter((s) => s.at > wall);
        const said: Bubble[] = [];
        for (const s of due) {
          if (s.kind === "walk") o.setWanted(s.agentId, s.to);
          else said.push({ id: s.id, agentId: s.agentId, text: s.text, until: s.until });
        }
        if (said.length) setBubbles((b) => [...b.filter((x) => x.until > wall && !said.some((n) => n.agentId === x.agentId)), ...said]);
      }
      const active = o.step(dt, { now: sceneNow, tempC: v.tempC ?? v.weather?.tempC ?? 27, cover: v.weather ? COVER[v.weather.sky] : 0.05 });
      if (!active && now - lastDraw < IDLE_FRAME) return;
      // Watch the first seconds of motion: a machine that cannot keep up gets the simple picture.
      if (probing && active) {
        probe.push(now - lastDraw);
        if (probe.length >= 45) {
          const sorted = probe.slice().sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)]!;
          probe = [];
          if (median > SLOW) {
            if (probing === 1) { o.setLite(true); probing = 2; }
            else { probing = 0; live.current.onFallback("this device draws the 3D office too slowly"); }
          } else probing = 0;
        }
      }
      lastDraw = now;
      o.render();
      if (!shown && o.opened) { shown = true; setOpened(true); }
      // name plates and bubbles follow the scene
      const p = new Vector3();
      for (const [id, el] of pins.current) {
        const a = o.plateAnchor(id, p);
        const xy = a ? o.project(a) : null;
        if (!xy) continue;
        // Kept inside the picture, so the plate at the corridor's end is never cut off.
        const x = Math.max(4, Math.min(xy[0], box.clientWidth - el.offsetWidth - 6));
        el.style.transform = `translate(${x.toFixed(1)}px, ${Math.max(4, xy[1] - el.offsetHeight).toFixed(1)}px)`;
      }
      for (const [id, el] of bubbleEls.current) {
        const d = o.dolls.get(id);
        const xy = d ? o.project(d.head(p)) : null;
        if (xy) el.style.transform = `translate(${(xy[0] - 24).toFixed(1)}px, ${(xy[1] - el.offsetHeight - 8).toFixed(1)}px)`;
      }
    };
    raf = requestAnimationFrame(frame);
    if (import.meta.env.DEV) {
      // For checking the picture from a background tab, where the browser holds back animation frames.
      Object.assign(window, {
        __diorama: {
          office: o,
          step(seconds: number) {
            for (let i = 0; i < Math.round(seconds * 30); i++) {
              last = performance.now() - 1000 / 30;
              frame(performance.now());
              cancelAnimationFrame(raf);
            }
            lastDraw = 0;
            frame(performance.now());
          },
        },
      });
    }
    let cancelled = false;
    void o.compile().then(() => {
      if (cancelled) return;
      setReady(true);
      o.open();
      started = true;
      probing = 1;
      lastDraw = performance.now();
      directTick();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearInterval(director);
      ro.disconnect();
      io.disconnect();
      c.removeEventListener("webglcontextlost", lost);
      o.dispose();
      office.current = null;
    };
    // The scene is built once; later changes reach it through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  /* The paper trail: what changed since the last look, acted out in order. */

  useEffect(() => {
    const o = office.current;
    const mem = remembered(view.business.name);
    const r = trail(mem.trail, view);
    mem.trail = r.state;
    mem.desk = view.deskCount;
    if (import.meta.env.DEV && r.events.length) ((window as unknown as { __dioramaEvents?: unknown[] }).__dioramaEvents ??= []).push(...r.events);
    if (!o) return;
    for (const e of r.events) o.play(e);
    o.setDeskCount(view.deskCount);
  }, [view]);
  useEffect(() => office.current?.setNames(names), [names]);

  /* The weather usually arrives after the book is open: then the sun moves to the right city. */
  useEffect(() => office.current?.setPlace(weather?.city ?? null, where), [weather?.city, where[0], where[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The clock in the corner moves on. */
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  /* Bubbles leave when their time is up. */
  useEffect(() => {
    if (!bubbles.length) return;
    const next = Math.min(...bubbles.map((b) => b.until)) - Date.now();
    const t = window.setTimeout(() => setBubbles((b) => b.filter((x) => x.until > Date.now())), Math.max(200, next));
    return () => window.clearTimeout(t);
  }, [bubbles]);

  const hired = view.rooms.filter((r) => r.hired && layout.rooms[r.agentId]);
  const label = (id: string) => `${personaFor(id, names).name} · ${AGENT_BY_ID[id]?.short ?? id}`;
  const now = at == null ? Date.now() : istParts(Date.now()).day + (at - IST_MINUTES) * 60_000;
  const { day, minutes } = istParts(now);
  const times = sunTimes(day, where[0], where[1]);
  const night = sunAt(new Date(now), where[0], where[1]).el < -4;
  const temp = tempC ?? weather?.tempC ?? null;

  return (
    <div className={`diorama${opened ? " is-open" : ""}`} ref={wrap}>
      <canvas
        ref={canvas}
        className="diorama-canvas"
        aria-hidden="true"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          office.current?.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
        }}
        onPointerLeave={() => office.current?.setPointer(0, 0)}
        onClick={(e) => {
          const o = office.current;
          if (!o || !o.opened) return;
          const r = e.currentTarget.getBoundingClientRect();
          const hit = o.hit(e.clientX - r.left, e.clientY - r.top);
          if (!hit) return;
          if (hit.kind === "vacant") return onOpen({ kind: "hiring" });
          void o.glideTo(hit.kind === "desk" ? "desk" : hit.id).then(() => onOpen(hit.kind === "desk" ? { kind: "desk" } : { kind: "room", id: hit.id }));
        }}
      />
      <ClosedLedger name={view.business.name || "Your office"} year={khataYear(now)} gone={ready} />
      <div className="diorama-layer">
        {hired.map((r) => {
          const def = AGENT_BY_ID[r.agentId];
          const count = def ? `${r.todayCount} ${r.todayCount === 1 ? singular(def.countLabel) : def.countLabel}` : "";
          return (
            <div key={r.agentId} className="diorama-pin" ref={(el) => void (el ? pins.current.set(r.agentId, el) : pins.current.delete(r.agentId))}>
              {renderLink(
                r.agentId,
                `diorama-plate${r.status === "working" ? " is-working" : ""}`,
                <>
                  <b>{personaFor(r.agentId, names).name}</b>
                  <span className="diorama-plate-role">{def?.short}</span>
                  {r.waitingCount ? <em className="diorama-plate-count">{r.waitingCount}</em> : null}
                  {/* The day's detail opens on hover or keyboard focus, so a full office stays readable. */}
                  <span className="diorama-plate-more">
                    <span>{count}</span>
                    <span>{r.now}</span>
                    {r.waitingCount ? <span className="diorama-plate-waiting">{r.waitingCount} waiting for you</span> : null}
                    {r.headline ? (
                      <span className="diorama-plate-headline">
                        {r.headline.label} {r.headline.value}
                      </span>
                    ) : null}
                  </span>
                </>,
                `${label(r.agentId)}. ${count}. ${r.now}.${r.waitingCount ? ` ${r.waitingCount} waiting for you.` : ""}${r.headline ? ` ${r.headline.label} ${r.headline.value}.` : ""}`,
              )}
            </div>
          );
        })}
        <div className="diorama-pin" ref={(el) => void (el ? pins.current.set("desk", el) : pins.current.delete("desk"))}>
          {renderDeskLink(
            "diorama-plate is-desk",
            <>
              <b>Your desk</b>
              <span>{view.deskCount ? `${view.deskCount} waiting for you` : "Nothing waiting"}</span>
            </>,
            view.deskCount ? `Your desk: ${view.deskCount} waiting for you` : "Your desk: nothing waiting",
          )}
        </div>
        {bubbles.map((b) => (
          <div key={b.id} className="diorama-bubble" ref={(el) => void (el ? bubbleEls.current.set(b.agentId, el) : bubbleEls.current.delete(b.agentId))}>
            <i>{personaFor(b.agentId, names).name}</i>
            {b.text}
          </div>
        ))}
      </div>
      <p className="diorama-readout">
        <b>
          {weather?.city ?? "Your office"}
          {temp != null ? ` · ${temp}°` : ""}
          {weather ? ` · ${SKY_WORDS[weather.sky]}` : ""}
        </b>
        <span>
          {clockText(minutes)} · sunset {clockText(times.set + IST_MINUTES)}
          {night ? ` · ${phaseName(moonPhase(new Date(now)))}` : ""}
        </span>
        {weather ? <span className="diorama-credit">Weather: MET Norway</span> : null}
      </p>
    </div>
  );
}

function singular(label: string) {
  const [first, ...rest] = label.split(" ");
  const one = first!.endsWith("ies") ? `${first!.slice(0, -3)}y` : first!.endsWith("s") ? first!.slice(0, -1) : first!;
  return [one, ...rest].join(" ");
}
